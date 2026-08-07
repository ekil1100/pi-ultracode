import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";
import { AsyncLocalStorage } from "node:async_hooks";

const POLICY = "WORKFLOW_POLICY_ERROR";
const ABORT = "WORKFLOW_ABORTED";
const STALL = "WORKFLOW_STALLED";
const CHECKPOINT = "__ultracodeCheckpoint";
const MAX_ITEMS_PER_CALL = 4096;
const MAX_RESERVE_AGENTS = 1024;

let aborted = false;
let finished = false;
let nextRpcId = 0;
let checkpointCount = 0;
let hostCallCount = 0;
let stickyFatalError;
const rpcWaiters = new Map();
const orchestrationPromises = new Set();
const executionContext = new AsyncLocalStorage();

const heartbeat = setInterval(() => sendHeartbeat(), 25);
heartbeat.unref?.();

parentPort.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "abort") {
    aborted = true;
    for (const waiter of rpcWaiters.values()) waiter.reject(makeAbortError());
    rpcWaiters.clear();
    return;
  }
  if (message.type === "rpcResult") {
    const waiter = rpcWaiters.get(message.id);
    if (!waiter) return;
    rpcWaiters.delete(message.id);
    if (message.ok) {
      waiter.resolve(message.value);
    } else {
      const error = reviveError(message.error);
      if (isPolicy(error)) markFatal(error);
      waiter.reject(error);
    }
  }
});

runRoot().catch((error) => finish(false, undefined, error));

async function runRoot() {
  const rootName = typeof workerData.name === "string" && workerData.name ? workerData.name : "workflow";
  const result = await executeBody(workerData.body, workerData.args, 0, rootName);
  if (stickyFatalError) throw stickyFatalError;
  const unobserved = [...orchestrationPromises].filter((record) => !record.observed);
  if (unobserved.length > 0) {
    throw makePolicyError(
      `workflow completed with ${unobserved.length} unawaited orchestration promise(s); await or return every agent(), parallel(), pipeline(), and workflow() call`,
    );
  }
  const pending = [...orchestrationPromises].filter((record) => !record.settled);
  if (pending.length > 0) {
    throw makePolicyError(
      `workflow completed with ${pending.length} pending orchestration promise(s); await or return the full promise chain`,
    );
  }
  finish(true, result);
}

async function executeBody(body, bodyArgs, depth, name, scopePath = "$") {
  throwIfAborted();
  const parent = executionContext.getStore();
  const context = createExecutionScope({
    workflowPath: [...(parent?.workflowPath ?? []), name || `workflow-${depth}`],
    depth,
    currentPhase: parent?.currentPhase,
    reservationIds: Array.isArray(parent?.reservationIds) ? [...parent.reservationIds] : [],
    scopePath,
  });
  return executionContext.run(context, async () => {
    const scriptContext = buildScriptContext(bodyArgs);
    const wrapped = `(async () => {\n${body}\n})()`;
    return await new vm.Script(wrapped, { filename: `${name || "workflow"}.js` }).runInContext(scriptContext);
  });
}

function buildScriptContext(bodyArgs) {
  const scriptContext = vm.createContext({}, {
    codeGeneration: { strings: false, wasm: false },
  });
  const install = new vm.Script(`
    (bridge, rawArgs, cwdValue) => {
      const localize = (value, seen = new WeakMap()) => {
        if (value === null || typeof value !== "object") return value
        if (seen.has(value)) return seen.get(value)
        if (Array.isArray(value)) {
          const output = []
          seen.set(value, output)
          for (const item of value) output.push(localize(item, seen))
          return output
        }
        const output = {}
        seen.set(value, output)
        for (const [key, child] of Object.entries(value)) {
          Object.defineProperty(output, key, {
            value: localize(child, seen),
            enumerable: true,
            writable: true,
            configurable: true,
          })
        }
        return output
      }
      const localError = (value) => {
        const error = new Error(value && typeof value.message === "string" ? value.message : String(value))
        if (value && typeof value.name === "string") error.name = value.name
        if (value && typeof value.code === "string") error.code = value.code
        return error
      }
      const orchestration = (name, callSite, values) => {
        let hostThenable
        try {
          hostThenable = bridge[name](callSite, ...values)
        } catch (error) {
          hostThenable = { then: (_resolve, reject) => reject(error) }
        }
        let localized
        const consume = () => {
          if (!localized) {
            localized = Promise.resolve(hostThenable).then(
              (value) => localize(value),
              (error) => { throw localError(error) },
            )
          }
          return localized
        }
        return Object.freeze({
          then: (resolve, reject) => consume().then(resolve, reject),
          catch: (reject) => consume().catch(reject),
          finally: (callback) => consume().finally(callback),
          get [Symbol.toStringTag]() { return "Promise" },
        })
      }
      const sync = (name, values) => {
        try {
          return localize(bridge[name](...values))
        } catch (error) {
          throw localError(error)
        }
      }
      const invoke = (callSite, fn, thisArg, values) => {
        try {
          return bridge.invoke(callSite, fn, thisArg, values)
        } catch (error) {
          throw localError(error)
        }
      }
      const sandboxLog = (value) => sync("log", [String(value)])
      Object.defineProperties(globalThis, {
        __ultracodeAgent: { value: (callSite, ...values) => orchestration("agent", callSite, values) },
        __ultracodeParallel: { value: (callSite, ...values) => orchestration("parallel", callSite, values) },
        __ultracodePipeline: { value: (callSite, ...values) => orchestration("pipeline", callSite, values) },
        __ultracodeWorkflow: { value: (callSite, ...values) => orchestration("workflow", callSite, values) },
        __ultracodeLoop: { value: (site) => sync("loop", [site]) },
        __ultracodeInvoke: { value: (callSite, fn, thisArg, ...values) => invoke(callSite, fn, thisArg, values) },
        phase: { value: (value) => sync("phase", [value]) },
        log: { value: sandboxLog },
        args: { value: localize(rawArgs), enumerable: true },
        cwd: { value: cwdValue, enumerable: true },
        process: { value: Object.freeze({ cwd: () => cwdValue }) },
        console: { value: Object.freeze({
          log: sandboxLog,
          info: sandboxLog,
          warn: (value) => sandboxLog("[warn] " + String(value)),
          error: (value) => sandboxLog("[error] " + String(value)),
        }) },
        structuredClone: { value: (value) => localize(value) },
        Date: { value: undefined },
        Function: { value: undefined },
        eval: { value: undefined },
        require: { value: undefined },
        performance: { value: undefined },
        crypto: { value: undefined },
        Intl: { value: undefined },
        Temporal: { value: undefined },
        WeakRef: { value: undefined },
        FinalizationRegistry: { value: undefined },
        WebAssembly: { value: undefined },
        ArrayBuffer: { value: undefined },
        SharedArrayBuffer: { value: undefined },
        DataView: { value: undefined },
        Atomics: { value: undefined },
        Int8Array: { value: undefined },
        Uint8Array: { value: undefined },
        Uint8ClampedArray: { value: undefined },
        Int16Array: { value: undefined },
        Uint16Array: { value: undefined },
        Int32Array: { value: undefined },
        Uint32Array: { value: undefined },
        Float32Array: { value: undefined },
        Float64Array: { value: undefined },
        BigInt64Array: { value: undefined },
        BigUint64Array: { value: undefined },
        ${JSON.stringify(CHECKPOINT)}: { value: () => sync("checkpoint", []) },
      })
      Object.defineProperties(Promise, {
        all: { value: undefined },
        allSettled: { value: undefined },
        race: { value: undefined },
        any: { value: undefined },
      })
      Object.defineProperties(Promise.prototype, {
        constructor: { value: undefined },
        catch: { value: undefined },
        finally: { value: undefined },
      })
      Object.freeze(Promise.prototype)
      Object.freeze(Promise)
      Object.defineProperty(Math, "random", {
        value: () => { throw new Error("Math.random() is non-deterministic and forbidden in workflow scripts; vary randomness by agent index instead.") },
        configurable: false,
        writable: false,
      })
      Object.freeze(Math)
    }
  `, { filename: "workflow-bootstrap.js" }).runInContext(scriptContext);
  install(Object.freeze({
    agent,
    parallel,
    pipeline,
    workflow,
    phase,
    log: logLine,
    checkpoint,
    loop: markLoopIteration,
    invoke: invokeHelper,
  }), bodyArgs, workerData.cwd);
  return scriptContext;
}

function checkpoint() {
  throwIfAborted();
  checkpointCount++;
  const limit = Number.isInteger(workerData.checkpointLimit) ? workerData.checkpointLimit : 1_000_000;
  if (checkpointCount > limit) {
    throw makePolicyError(`workflow exceeded the ${limit}-operation script checkpoint limit (runaway loop?)`);
  }
  if ((checkpointCount & 1023) === 0) sendHeartbeat();
}

function agent(callSite, prompt, options = {}) {
  return startOrchestration(() => agentImpl(callSite, prompt, options));
}

async function agentImpl(callSite, prompt, options = {}) {
  throwIfAborted();
  if (typeof prompt !== "string") throw new TypeError("agent prompt must be a string");
  if (options == null) options = {};
  if (typeof options !== "object") throw new TypeError("agent options must be an object");
  const execution = executionContext.getStore() ?? createExecutionScope({ scopePath: "$" });
  const callPath = allocateCallPath(execution, "agent", "a", callSite);
  const opts = { ...options };
  const assignedPhase = typeof opts.phase === "string" ? opts.phase : execution.currentPhase;
  return await rpc("agent", {
    callPath,
    prompt,
    options: opts,
    assignedPhase,
    workflowPath: execution.workflowPath ?? [],
    reservationIds: Array.isArray(execution.reservationIds) ? execution.reservationIds : [],
  });
}

function parallel(callSite, thunks, options = {}) {
  return startOrchestration(() => parallelImpl(callSite, thunks, options));
}

async function parallelImpl(callSite, thunks, options = {}) {
  throwIfAborted();
  if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
  if (thunks.length > MAX_ITEMS_PER_CALL) {
    throw makePolicyError(`parallel() accepts at most ${MAX_ITEMS_PER_CALL} items (got ${thunks.length})`);
  }
  if (thunks.some((thunk) => typeof thunk !== "function")) {
    throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
  }
  const execution = executionContext.getStore() ?? createExecutionScope({ scopePath: "$" });
  const reserveAgents = normalizeReserveAgents(options, thunks.length);
  const rawPanelSite = typeof callSite === "string" && callSite ? callSite : "parallel:dynamic";
  const [panelSource, panelLoops = ""] = rawPanelSite.split("@", 2);
  const panelSite = `${panelSource}#${thunks.length}:${reserveAgents}${panelLoops ? `@${panelLoops}` : ""}`;
  const panelCallPath = allocateCallPath(execution, "parallel", "p", panelSite);
  if (reserveAgents < thunks.length) {
    throw makePolicyError(`parallel reserveAgents must be at least the number of thunks (${thunks.length}); got ${reserveAgents}`);
  }
  const parentReservationIds = Array.isArray(execution.reservationIds) ? execution.reservationIds : [];
  const panel = await rpc("reservePanel", {
    callPath: panelCallPath,
    reserveAgents,
    branchCount: thunks.length,
    parentReservationIds,
  });
  const panelReservationId = requireString(panel?.panelReservationId, "panelReservationId");
  const branchReservationIds = Array.isArray(panel?.branchReservationIds) ? panel.branchReservationIds : [];
  if (branchReservationIds.length !== thunks.length || branchReservationIds.some((id) => typeof id !== "string")) {
    throw makePolicyError("workflow host returned an invalid parallel reservation panel");
  }

  let completed = false;
  const branchOutcomes = Array.from({ length: thunks.length }, () => "pending");
  try {
    const results = await Promise.all(thunks.map(async (thunk, index) => {
      const branchReservationId = branchReservationIds[index];
      const childContext = createExecutionScope({
        workflowPath: [...(execution.workflowPath ?? [])],
        depth: execution.depth,
        currentPhase: execution.currentPhase,
        reservationIds: [branchReservationId, panelReservationId].filter(Boolean),
        scopePath: `${panelCallPath}/b:${index}`,
        loopIterations: execution.loopIterations,
      });
      return executionContext.run(childContext, async () => {
        try {
          throwIfAborted();
          const value = await thunk();
          branchOutcomes[index] = "success";
          await rpc("completePanelBranch", {
            callPath: panelCallPath,
            branchIndex: index,
            outcome: "success",
          });
          return value;
        } catch (error) {
          if (isFatal(error)) throw error;
          branchOutcomes[index] = "failed";
          await rpc("completePanelBranch", {
            callPath: panelCallPath,
            branchIndex: index,
            outcome: "failed",
          });
          logLine(`parallel[${index}] failed: ${messageOf(error)}`);
          return null;
        } finally {
          await rpc("releasePanel", { reservationId: branchReservationId }).catch(() => undefined);
        }
      });
    }));
    completed = true;
    return results;
  } finally {
    const release = rpc("releasePanel", {
      reservationId: panelReservationId,
      callPath: panelCallPath,
      completed,
      branchOutcomes,
    });
    if (completed) await release;
    else await release.catch(() => undefined);
  }
}

function pipeline(callSite, items, ...stages) {
  return startOrchestration(() => pipelineImpl(callSite, items, ...stages));
}

async function pipelineImpl(callSite, items, ...stages) {
  throwIfAborted();
  if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
  if (items.length > MAX_ITEMS_PER_CALL) {
    throw makePolicyError(`pipeline() accepts at most ${MAX_ITEMS_PER_CALL} items (got ${items.length})`);
  }
  if (stages.some((stage) => typeof stage !== "function")) {
    throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
  }
  const execution = executionContext.getStore() ?? createExecutionScope({ scopePath: "$" });
  const pipelineCallPath = allocateCallPath(execution, "pipeline", "l", callSite);
  return await Promise.all(items.map(async (item, index) => {
    let value = item;
    for (const [stageIndex, stage] of stages.entries()) {
      try {
        throwIfAborted();
        const stageContext = createExecutionScope({
          workflowPath: [...(execution.workflowPath ?? [])],
          depth: execution.depth,
          currentPhase: execution.currentPhase,
          reservationIds: Array.isArray(execution.reservationIds) ? [...execution.reservationIds] : [],
          scopePath: `${pipelineCallPath}/i:${index}/s:${stageIndex}`,
          loopIterations: execution.loopIterations,
        });
        value = await executionContext.run(stageContext, () => stage(value, item, index));
        throwIfAborted();
      } catch (error) {
        if (isFatal(error)) throw error;
        logLine(`pipeline[${index}] failed: ${messageOf(error)}`);
        return null;
      }
    }
    return value;
  }));
}

function workflow(callSite, nameOrRef, nestedArgs) {
  return startOrchestration(() => workflowImpl(callSite, nameOrRef, nestedArgs));
}

async function workflowImpl(callSite, nameOrRef, nestedArgs) {
  throwIfAborted();
  const execution = executionContext.getStore() ?? createExecutionScope({ scopePath: "$" });
  const workflowCallPath = allocateCallPath(execution, "workflow", "w", callSite);
  if ((execution.depth ?? 0) >= 1) {
    throw new Error("workflow() nesting is one level deep only; cannot call workflow() inside a child workflow");
  }
  let argsSnapshot;
  try {
    argsSnapshot = structuredClone(nestedArgs);
  } catch (error) {
    throw new TypeError(`workflow() args must be structured-cloneable: ${messageOf(error)}`);
  }
  const loaded = await rpc("loadWorkflow", {
    nameOrRef,
    callPath: workflowCallPath,
    args: argsSnapshot,
  });
  logLine(`▸ nested workflow: ${loaded.meta.name}`);
  const childResult = await executeBody(
    loaded.body,
    argsSnapshot,
    (execution.depth ?? 0) + 1,
    loaded.meta.name,
    requireString(loaded.callPath, "nested workflow durable callPath"),
  );
  let outputSnapshot;
  try {
    outputSnapshot = structuredClone(childResult);
  } catch (error) {
    throw makePolicyError(`nested workflow output must be structured-cloneable: ${messageOf(error)}`);
  }
  await rpc("validateOutput", { value: outputSnapshot });
  return outputSnapshot;
}

function createExecutionScope(input) {
  const phaseState = input.phaseState ?? { value: input.currentPhase };
  const scope = {
    workflowPath: Array.isArray(input.workflowPath) ? input.workflowPath : [],
    depth: Number.isInteger(input.depth) ? input.depth : 0,
    phaseState,
    reservationIds: Array.isArray(input.reservationIds) ? input.reservationIds : [],
    scopePath: typeof input.scopePath === "string" ? input.scopePath : "$",
    counters: Object.create(null),
    loopIterations: { ...(input.loopIterations ?? {}) },
    orchestrationState: input.orchestrationState ?? { active: 0 },
  };
  Object.defineProperty(scope, "currentPhase", {
    get: () => phaseState.value,
    set: (value) => { phaseState.value = value },
  });
  return scope;
}

function allocateCallPath(execution, counter, segment, callSite) {
  const rawSite = typeof callSite === "string" && callSite ? callSite : `${counter}:dynamic`;
  const [site, loopSuffix = ""] = rawSite.split("@", 2);
  const loopIdentity = loopSuffix
    ? `@${loopSuffix.split(",").map((loopSite) => `${loopSite}=${execution.loopIterations[loopSite] ?? -1}`).join(",")}`
    : "";
  const identifiedSite = `${site}${loopIdentity}`;
  const key = `${segment}:${identifiedSite}`;
  const occurrence = execution.counters[key] ?? 0;
  execution.counters[key] = occurrence + 1;
  return `${execution.scopePath}/${segment}:${identifiedSite}:${occurrence}`;
}

function invokeHelper(callSite, fn, thisArg, values) {
  if (typeof fn !== "function") throw new TypeError("workflow helper must be a function");
  if (!Array.isArray(values)) throw new TypeError("workflow helper args must be an array");
  const execution = executionContext.getStore() ?? createExecutionScope({ scopePath: "$" });
  const invocationPath = allocateCallPath(execution, "invoke", "h", callSite);
  const childContext = createExecutionScope({
    workflowPath: [...(execution.workflowPath ?? [])],
    depth: execution.depth,
    phaseState: execution.phaseState,
    reservationIds: [...(execution.reservationIds ?? [])],
    scopePath: invocationPath,
    loopIterations: execution.loopIterations,
    orchestrationState: execution.orchestrationState,
  });
  return executionContext.run(childContext, () => Reflect.apply(fn, thisArg, values));
}

function markLoopIteration(site) {
  if (typeof site !== "string" || !site) throw new TypeError("workflow loop site must be a string");
  const execution = executionContext.getStore();
  if (!execution) throw makePolicyError("workflow loop executed without an execution scope");
  execution.loopIterations[site] = (execution.loopIterations[site] ?? -1) + 1;
}

function phase(title) {
  if (typeof title !== "string") throw new TypeError("phase title must be a string");
  consumeHostCall();
  const execution = executionContext.getStore();
  if (execution) execution.currentPhase = title;
  parentPort.postMessage({ type: "event", op: "phase", payload: { title } });
}

function logLine(message) {
  consumeHostCall();
  parentPort.postMessage({ type: "event", op: "log", payload: { message: String(message) } });
}

function normalizeReserveAgents(options, fallback) {
  if (options == null) return fallback;
  if (typeof options !== "object") throw new TypeError("parallel() options must be an object");
  const value = options.reserveAgents;
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_RESERVE_AGENTS) {
    throw makePolicyError(`parallel reserveAgents must be an integer between 0 and ${MAX_RESERVE_AGENTS}`);
  }
  return value;
}

function rpc(op, payload) {
  throwIfAborted();
  consumeHostCall();
  const id = ++nextRpcId;
  return new Promise((resolve, reject) => {
    rpcWaiters.set(id, { resolve, reject });
    parentPort.postMessage({ type: "rpc", id, op, payload });
  });
}

function consumeHostCall() {
  hostCallCount++;
  const limit = Number.isInteger(workerData.hostCallLimit) ? workerData.hostCallLimit : 10_000;
  if (hostCallCount > limit) {
    throw makePolicyError(`workflow exceeded the ${limit} host-call limit`);
  }
}

function startOrchestration(factory) {
  const execution = executionContext.getStore() ?? createExecutionScope({ scopePath: "$" });
  if (execution.orchestrationState.active > 0) {
    return trackOrchestration(Promise.reject(makePolicyError(
      "native concurrent orchestration in one scope is non-deterministic; use parallel() or pipeline()",
    )));
  }
  execution.orchestrationState.active++;
  let promise;
  try {
    promise = Promise.resolve(factory());
  } catch (error) {
    promise = Promise.reject(error);
  }
  promise.then(
    () => { execution.orchestrationState.active--; },
    () => { execution.orchestrationState.active--; },
  );
  return trackOrchestration(promise);
}

function trackOrchestration(promise) {
  const record = { observed: false, settled: false, promise };
  orchestrationPromises.add(record);
  // Observe settlement immediately so fast failures are contained and root
  // completion can reject detached chains that still have live host work.
  promise.then(
    () => { record.settled = true; },
    () => { record.settled = true; },
  );
  const observe = () => {
    record.observed = true;
  };
  return Object.freeze({
    then(onFulfilled, onRejected) {
      observe();
      return promise.then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      observe();
      return trackOrchestration(promise.catch(onRejected));
    },
    finally(onFinally) {
      observe();
      return trackOrchestration(promise.finally(onFinally));
    },
    get [Symbol.toStringTag]() {
      return "Promise";
    },
  });
}

function throwIfAborted() {
  if (stickyFatalError) throw stickyFatalError;
  if (aborted) throw makeAbortError();
}

function makePolicyError(message) {
  const error = new Error(message);
  error.name = "WorkflowPolicyError";
  error.code = POLICY;
  markFatal(error);
  return error;
}

function markFatal(error) {
  if (!isPolicy(error)) return;
  stickyFatalError ??= error;
  aborted = true;
  for (const waiter of rpcWaiters.values()) waiter.reject(stickyFatalError);
  rpcWaiters.clear();
  try {
    parentPort.postMessage({ type: "fatal", error: serializeError(stickyFatalError) });
  } catch {
    // Parent is already gone; exit/result handling will still carry the error.
  }
}

function makeAbortError(message = "workflow aborted") {
  const error = new Error(message);
  error.name = "WorkflowAbortError";
  error.code = ABORT;
  return error;
}

function reviveError(value) {
  const error = new Error(value?.message ?? String(value ?? "unknown error"));
  error.name = value?.name ?? "Error";
  if (value?.code) error.code = value.code;
  if (value?.stack) error.stack = value.stack;
  return error;
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: messageOf(error),
    code: error?.code,
    stack: error?.stack,
  };
}

function isFatal(error) {
  return error?.code === POLICY || error?.code === ABORT || error?.code === STALL;
}

function isPolicy(error) {
  return error?.code === POLICY;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function requireString(value, name) {
  if (typeof value !== "string") throw makePolicyError(`workflow host returned invalid ${name}`);
  return value;
}

function sendHeartbeat() {
  if (!finished) parentPort.postMessage({ type: "heartbeat", at: Date.now(), checkpoints: checkpointCount });
}

function finish(ok, value, error) {
  if (finished) return;
  finished = true;
  clearInterval(heartbeat);
  if (stickyFatalError) {
    parentPort.postMessage({ type: "result", ok: false, error: serializeError(stickyFatalError) });
    return;
  }
  if (ok) {
    try {
      parentPort.postMessage({ type: "result", ok: true, value: structuredClone(value) });
    } catch (cloneError) {
      parentPort.postMessage({ type: "result", ok: false, error: serializeError(cloneError) });
    }
  } else {
    parentPort.postMessage({ type: "result", ok: false, error: serializeError(error) });
  }
}
