import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { getEventListeners, type EventEmitter } from "node:events";
import { execFile, type ExecFileException } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";

import { executeWorkflowScript, type ScriptExecutorHost } from "../src/workflow/script-executor.ts";
import {
  WorkflowAbortError,
  WorkflowPolicyError,
  WorkflowStallError,
} from "../src/workflow/admission.ts";

interface TestWorker extends EventEmitter {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  finishTermination(): void;
}

const workers = vi.hoisted(() => ({ instances: [] as TestWorker[] }));
vi.mock("node:worker_threads", () =>
  Effect.runPromise(
    Effect.tryPromise({ try: () => import("node:events"), catch: (error) => error }).pipe(
      Effect.map(({ EventEmitter }) => {
        return {
          Worker: class extends EventEmitter {
            postMessage = vi.fn();
            terminate: ReturnType<typeof vi.fn>;
            finishTermination: () => void;
            constructor() {
              super();
              const stopped = Deferred.makeUnsafe<number>();
              this.terminate = vi.fn(() => Effect.runPromise(Deferred.await(stopped)));
              this.finishTermination = () => {
                this.emit("exit", 1);
                Effect.runSync(Deferred.succeed(stopped, 1));
              };
              workers.instances.push(this);
            }
          },
        };
      }),
    ),
  ),
);

function deferred<A = void>() {
  const value = Deferred.makeUnsafe<A, unknown>();
  return {
    wait: Deferred.await(value),
    resolve: (result: A) => Effect.runSync(Deferred.succeed(value, result)),
    reject: (error: unknown) => Effect.runSync(Deferred.fail(value, error)),
  };
}
// Native promises are confined to SDK, Vitest and process boundaries.
const external = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => error });

function start(overrides: Partial<ScriptExecutorHost> = {}, options: Record<string, unknown> = {}) {
  const controller = new AbortController();
  const host: ScriptExecutorHost = {
    agent: vi.fn(() => Effect.runPromise(Effect.succeed("agent"))),
    reservePanel: () =>
      Effect.runPromise(Effect.succeed({ panelReservationId: "panel", branchReservationIds: [] })),
    completePanelBranch: () => Effect.runPromise(Effect.void),
    releasePanel: () => Effect.runPromise(Effect.void),
    loadWorkflow: () => Effect.runPromise(Effect.succeed({ meta: {}, body: "return 1" })),
    validateOutput: () => Effect.runPromise(Effect.void),
    log: vi.fn(),
    phase: vi.fn(),
    ...overrides,
  };
  const promise = executeWorkflowScript("return 1", host, {
    cwd: process.cwd(),
    name: "effect-test",
    signal: controller.signal,
    stallTimeoutMs: 100,
    fatalDrainTimeoutMs: 300,
    ...options,
  });
  // Observe every rejection immediately, including failures before a worker exists.
  const outcome = Effect.runSync(
    Effect.forkIn(
      external(() => promise).pipe(
        Effect.match({
          onSuccess: (value) => ({ ok: true as const, value }),
          onFailure: (error) => ({ ok: false as const, error }),
        }),
      ),
      testScope,
      { startImmediately: true },
    ),
  );
  const worker = workers.instances.at(-1)!;
  return { host, controller, outcome, worker };
}

const nextTurn = Effect.callback<void>((resume) => {
  const handle = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(handle));
});
function message(worker: TestWorker, value: unknown) {
  worker.emit("message", value);
}
function expectReleased(worker: TestWorker, signal: AbortSignal, terminationCalls = 1) {
  expect(worker.terminate).toHaveBeenCalledTimes(terminationCalls);
  for (const event of ["message", "error", "exit"]) expect(worker.listenerCount(event)).toBe(0);
  expect(getEventListeners(signal, "abort")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
}

let testScope: Scope.Closeable;
beforeEach(() => {
  testScope = Scope.makeUnsafe();
  workers.instances.length = 0;
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
  });
});
afterEach(() => {
  for (const worker of workers.instances) worker.finishTermination();
  return Effect.runPromise(
    Effect.scoped(
      nextTurn.pipe(
        Effect.andThen(Scope.close(testScope, Exit.void)),
        Effect.ensuring(Effect.sync(() => vi.useRealTimers())),
      ),
    ),
  );
});

test("512 rejected agents preserve a handled workflow error under Node's default rejection policy", () => {
  vi.useRealTimers();
  return Effect.runPromise(
    Effect.callback<{ error: ExecFileException | null; stdout: string; stderr: string }>(
      (resume) => {
        const child = execFile(
          process.execPath,
          [
            "--experimental-transform-types",
            fileURLToPath(new URL("./fixtures/batch-rejection.ts", import.meta.url)),
          ],
          {
            cwd: process.cwd(),
            // Exercise Node's default fatal policy, independent of the test runner's flags.
            env: { ...process.env, NODE_OPTIONS: "" },
            timeout: 15_000,
            killSignal: "SIGKILL",
          },
          (error, stdout, stderr) => resume(Effect.succeed({ error, stdout, stderr })),
        );
        return Effect.sync(() => {
          child.kill("SIGKILL");
        });
      },
    ).pipe(
      Effect.tap(({ error, stdout, stderr }) =>
        Effect.sync(() => {
          expect(error, stderr).toBeNull();
          expect(JSON.parse(stdout)).toEqual({
            handled: true,
            runnerCalls: 0,
            code: "WORKFLOW_POLICY_ERROR",
          });
        }),
      ),
    ),
  );
});

test("worker success waits for termination, then removes every listener and timer", () => {
  const h = start();
  let published = false;
  Effect.runSync(
    Effect.forkIn(
      Fiber.join(h.outcome).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            published = true;
          }),
        ),
      ),
      testScope,
      { startImmediately: true },
    ),
  );
  message(h.worker, { type: "result", ok: true, value: { done: true } });
  return Effect.runPromise(
    Effect.scoped(
      nextTurn.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(h.worker.terminate).toHaveBeenCalledTimes(1);
            expect(published).toBe(false);
            expect(h.worker.listenerCount("error")).toBe(1);
            h.worker.finishTermination();
          }),
        ),
        Effect.andThen(Fiber.join(h.outcome)),
        Effect.map((completed) => {
          expect(completed).toEqual({ ok: true, value: { done: true } });
          expectReleased(h.worker, h.controller.signal);
          h.controller.abort();
          expect(h.worker.terminate).toHaveBeenCalledTimes(1);
        }),
      ),
    ),
  );
});

test("synchronous termination failure preserves the primary error and still awaits a retry", () => {
  const h = start();
  const primary = new Error("primary worker failure");
  h.worker.terminate.mockImplementationOnce(() => {
    throw new Error("synchronous termination failure");
  });
  let published = false;
  Effect.runSync(
    Effect.forkIn(
      Fiber.join(h.outcome).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            published = true;
          }),
        ),
      ),
      testScope,
      { startImmediately: true },
    ),
  );
  h.worker.emit("error", primary);
  return Effect.runPromise(
    Effect.scoped(
      nextTurn.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(h.worker.terminate).toHaveBeenCalledTimes(2);
            expect(published).toBe(false);
            h.worker.finishTermination();
          }),
        ),
        Effect.andThen(Fiber.join(h.outcome)),
        Effect.map((result) => {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error).toBe(primary);
          expectReleased(h.worker, h.controller.signal, 2);
        }),
      ),
    ),
  );
});

test("rejected termination is awaited without replacing the primary error", () => {
  const h = start();
  const stopped = deferred<number>();
  const primary = new Error("primary worker failure");
  h.worker.terminate.mockReturnValue(Effect.runPromise(stopped.wait));
  let published = false;
  Effect.runSync(
    Effect.forkIn(
      Fiber.join(h.outcome).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            published = true;
          }),
        ),
      ),
      testScope,
      { startImmediately: true },
    ),
  );
  h.worker.emit("error", primary);
  return Effect.runPromise(
    Effect.scoped(
      nextTurn.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(published).toBe(false);
            expect(h.worker.listenerCount("error")).toBe(1);
            stopped.reject(new Error("asynchronous termination failure"));
          }),
        ),
        Effect.andThen(Fiber.join(h.outcome)),
        Effect.map((result) => {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error).toBe(primary);
          expectReleased(h.worker, h.controller.signal);
        }),
      ),
    ),
  );
});

for (const failure of [
  new Error("host failure"),
  { reason: "non-error host failure" },
  undefined,
]) {
  test(`event failure preserves exact rejection identity: ${String(failure)}`, () => {
    const h = start({
      log: () => {
        throw failure;
      },
    });
    message(h.worker, { type: "event", op: "log", payload: { message: "fail" } });
    return Effect.runPromise(
      Effect.scoped(
        nextTurn.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              h.worker.finishTermination();
            }),
          ),
          Effect.andThen(Fiber.join(h.outcome)),
          Effect.map((result) => {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toBe(failure);
            expectReleased(h.worker, h.controller.signal);
          }),
        ),
      ),
    );
  });
}

test("pre-abort and invalid resource limits fail before worker acquisition", () => {
  const aborted = start({}, { signal: AbortSignal.abort() });
  const invalid = start({}, { workerMemoryLimitMb: 1 });
  return Effect.runPromise(
    Effect.all([Fiber.join(aborted.outcome), Fiber.join(invalid.outcome)], {
      concurrency: "unbounded",
    }).pipe(
      Effect.map(([abortedResult, invalidResult]) => {
        expect(abortedResult).toMatchObject({ ok: false, error: expect.any(WorkflowAbortError) });
        expect(invalidResult).toMatchObject({ ok: false, error: expect.any(WorkflowPolicyError) });
        expect(workers.instances).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
      }),
    ),
  );
});

test("abort inside host batch synchronously starts termination before host replies", () => {
  const pending = deferred<unknown>();
  const h = start({
    agentBatch: () => {
      h.controller.abort();
      expect(h.worker.terminate).toHaveBeenCalledTimes(1);
      return [Effect.runPromise(pending.wait)];
    },
  });
  message(h.worker, { type: "agentBatch", calls: [{ id: 1, op: "agent", payload: {} }] });
  h.worker.finishTermination();
  return Effect.runPromise(
    Effect.scoped(
      Fiber.join(h.outcome).pipe(
        Effect.tap((completed) =>
          Effect.sync(() => {
            expect(completed).toMatchObject({ ok: false, error: expect.any(WorkflowAbortError) });
            pending.reject(new Error("late host failure"));
          }),
        ),
        Effect.andThen(nextTurn),
        Effect.map(() => {
          expect(h.worker.postMessage).not.toHaveBeenCalled();
          expectReleased(h.worker, h.controller.signal);
        }),
      ),
    ),
  );
});

test("ordered host events and batch starts preserve independent RPC completion", () => {
  const slow = deferred<unknown>();
  const fast = deferred<unknown>();
  const order: string[] = [];
  const h = start({
    phase: () => {
      order.push("phase");
    },
    log: () => {
      order.push("log");
    },
    agentBatch: (calls) => {
      order.push(`batch:${calls.join(",")}`);
      return [Effect.runPromise(slow.wait), Effect.runPromise(fast.wait)];
    },
  });
  message(h.worker, { type: "event", op: "phase", payload: { title: "phase" } });
  message(h.worker, {
    type: "agentBatch",
    calls: [
      { id: 1, op: "agent", payload: "slow" },
      { id: 2, op: "agent", payload: "fast" },
    ],
  });
  message(h.worker, { type: "event", op: "log", payload: { message: "log" } });
  fast.resolve("fast-result");
  return Effect.runPromise(
    Effect.scoped(
      nextTurn.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(order).toEqual(["phase", "batch:slow,fast", "log"]);
            expect(h.host.agent).not.toHaveBeenCalled();
            expect(h.worker.postMessage.mock.calls).toEqual([
              [{ type: "rpcResult", id: 2, ok: true, value: "fast-result" }],
            ]);
            slow.resolve("slow-result");
          }),
        ),
        Effect.andThen(nextTurn),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(h.worker.postMessage.mock.calls[1][0]).toEqual({
              type: "rpcResult",
              id: 1,
              ok: true,
              value: "slow-result",
            });
            message(h.worker, { type: "result", ok: true, value: "done" });
            h.worker.finishTermination();
          }),
        ),
        Effect.andThen(Fiber.join(h.outcome)),
        Effect.map((completed) => {
          expect(completed).toEqual({ ok: true, value: "done" });
          expectReleased(h.worker, h.controller.signal);
        }),
      ),
    ),
  );
});

test("large batches preserve each RPC outcome without waiting for a slow sibling", () => {
  const slow = deferred<unknown>();
  const failures = Array.from({ length: 512 }, (_, index) =>
    Object.assign(new Error(`failure:${index}`), { code: `RPC_${index}` }),
  );
  const h = start(
    {
      agentBatch: () =>
        failures.map((error, index) =>
          index === 0
            ? Effect.runPromise(slow.wait)
            : index % 2 === 0
              ? Effect.runPromise(Effect.succeed({ index }))
              : Effect.runPromise(Effect.fail(error)),
        ),
    },
    { stallTimeoutMs: 5_000 },
  );
  message(h.worker, {
    type: "agentBatch",
    calls: failures.map((_, id) => ({ id, op: "agent", payload: { id } })),
  });
  return Effect.runPromise(
    Effect.scoped(
      external(() =>
        vi.waitFor(() => expect(h.worker.postMessage).toHaveBeenCalledTimes(511)),
      ).pipe(
        Effect.flatMap(() =>
          Effect.suspend(() => {
            const responses = new Map(
              h.worker.postMessage.mock.calls.map(([response]) => [response.id, response]),
            );
            expect(responses.has(0)).toBe(false);
            for (let id = 1; id < failures.length; id++) {
              expect(responses.get(id)).toEqual(
                id % 2 === 0
                  ? { type: "rpcResult", id, ok: true, value: { index: id } }
                  : {
                      type: "rpcResult",
                      id,
                      ok: false,
                      error: {
                        name: failures[id].name,
                        message: failures[id].message,
                        code: failures[id].code,
                        stack: failures[id].stack,
                      },
                    },
              );
            }
            expect(h.host.agent).not.toHaveBeenCalled();
            slow.reject(undefined);
            return external(() =>
              vi.waitFor(() => expect(h.worker.postMessage).toHaveBeenCalledTimes(512)),
            ).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  expect(h.worker.postMessage).toHaveBeenLastCalledWith({
                    type: "rpcResult",
                    id: 0,
                    ok: false,
                    error: {
                      name: "Error",
                      message: "undefined",
                      code: undefined,
                      stack: undefined,
                    },
                  });
                  message(h.worker, { type: "result", ok: true, value: "done" });
                  h.worker.finishTermination();
                }),
              ),
              Effect.andThen(Fiber.join(h.outcome)),
              Effect.map((completed) => {
                expect(completed).toEqual({ ok: true, value: "done" });
                expectReleased(h.worker, h.controller.signal);
              }),
            );
          }),
        ),
      ),
    ),
  );
});

test("uncloneable RPC results become failures and failed posts leave the executor usable", () => {
  const h = start({ agent: () => Effect.runPromise(Effect.succeed(() => "uncloneable")) });
  message(h.worker, { type: "rpc", id: 1, op: "agent", payload: {} });
  return Effect.runPromise(
    Effect.scoped(
      nextTurn.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(h.worker.postMessage).toHaveBeenCalledWith({
              type: "rpcResult",
              id: 1,
              ok: false,
              error: expect.objectContaining({
                name: "Error",
                message: expect.stringContaining(
                  "workflow host RPC result must be structured-cloneable.",
                ),
              }),
            });
            h.worker.postMessage.mockImplementationOnce(() => {
              throw new Error("worker already exited");
            });
            message(h.worker, { type: "rpc", id: 2, op: "agent", payload: {} });
          }),
        ),
        Effect.andThen(nextTurn),
        Effect.tap(() =>
          Effect.sync(() => {
            message(h.worker, { type: "result", ok: true, value: "done" });
            h.worker.finishTermination();
          }),
        ),
        Effect.andThen(Fiber.join(h.outcome)),
        Effect.map((completed) => {
          expect(completed).toEqual({ ok: true, value: "done" });
          expectReleased(h.worker, h.controller.signal);
        }),
      ),
    ),
  );
});

test("fatal drain retains its first error and awaits pending cleanup RPCs past watchdog", () => {
  const cleanup = deferred<void>();
  const abortChildren = vi.fn((_error: Error) => {
    throw new Error("notification failure");
  });
  const h = start({ releasePanel: () => Effect.runPromise(cleanup.wait), abortChildren });
  message(h.worker, {
    type: "rpc",
    id: 1,
    op: "releasePanel",
    payload: { reservationId: "panel" },
  });
  message(h.worker, {
    type: "fatal",
    error: { code: "WORKFLOW_POLICY_ERROR", message: "first" },
  });
  message(h.worker, {
    type: "fatal",
    error: { code: "WORKFLOW_POLICY_ERROR", message: "second" },
  });
  message(h.worker, { type: "result", ok: false, error: { message: "last" } });
  return Effect.runPromise(
    Effect.scoped(
      external(() => vi.advanceTimersByTimeAsync(200)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(h.worker.terminate).not.toHaveBeenCalled();
            cleanup.resolve();
          }),
        ),
        Effect.andThen(nextTurn),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(h.worker.postMessage).toHaveBeenCalledWith({
              type: "rpcResult",
              id: 1,
              ok: true,
              value: undefined,
            });
            h.worker.finishTermination();
          }),
        ),
        Effect.andThen(Fiber.join(h.outcome)),
        Effect.map((result) => {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error).toBe(abortChildren.mock.calls[0][0]);
          expectReleased(h.worker, h.controller.signal);
        }),
      ),
    ),
  );
});

test("fatal deadline interrupts RPC adapters without waiting on an uncooperative host", () => {
  const ignored = deferred<unknown>();
  const h = start({ agent: () => Effect.runPromise(ignored.wait) });
  message(h.worker, { type: "rpc", id: 1, op: "agent", payload: {} });
  message(h.worker, {
    type: "fatal",
    error: { code: "WORKFLOW_POLICY_ERROR", message: "deadline" },
  });
  message(h.worker, { type: "result", ok: false });
  return Effect.runPromise(
    Effect.scoped(
      external(() => vi.advanceTimersByTimeAsync(300)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(h.worker.terminate).toHaveBeenCalledTimes(1);
            h.worker.finishTermination();
          }),
        ),
        Effect.andThen(Fiber.join(h.outcome)),
        Effect.tap((completed) =>
          Effect.sync(() => {
            expect(completed).toMatchObject({ ok: false, error: { message: "deadline" } });
            ignored.reject(new Error("late rejection is observed"));
          }),
        ),
        Effect.andThen(nextTurn),
        Effect.map(() => {
          expect(h.worker.postMessage).not.toHaveBeenCalled();
          expectReleased(h.worker, h.controller.signal);
        }),
      ),
    ),
  );
});

test.each([false, true])(
  "heartbeats protect a pending host RPC with delayed consumer=%s",
  (delayedConsumer) => {
    const pending = deferred<unknown>();
    const agent = vi.fn(() => Effect.runPromise(pending.wait));
    const h = start({ agent }, { stallTimeoutMs: 80 });
    message(h.worker, { type: "rpc", id: 1, op: "agent", payload: {} });
    message(h.worker, { type: "heartbeat", checkpoints: 0 });
    return Effect.runPromise(
      nextTurn.pipe(
        Effect.andThen(() => external(() => vi.advanceTimersByTimeAsync(25))),
        Effect.tap(() =>
          Effect.sync(() => message(h.worker, { type: "heartbeat", checkpoints: 0 })),
        ),
        Effect.andThen(nextTurn),
        // The tick at 40ms precedes the next heartbeat at 50ms. Delay only
        // consumption through 150ms; startup and heartbeat delivery stay timely.
        Effect.andThen(
          Effect.forEach(
            Array.from({ length: 5 }),
            () =>
              (delayedConsumer
                ? Effect.sync(() => vi.advanceTimersByTime(25))
                : external(() => vi.advanceTimersByTimeAsync(25))
              ).pipe(
                Effect.tap(() =>
                  Effect.sync(() => message(h.worker, { type: "heartbeat", checkpoints: 0 })),
                ),
              ),
            { discard: true },
          ),
        ),
        Effect.andThen(nextTurn),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(agent).toHaveBeenCalledTimes(1);
            expect(h.worker.terminate).not.toHaveBeenCalled();
            pending.resolve("ok");
          }),
        ),
        Effect.andThen(nextTurn),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(h.worker.postMessage).toHaveBeenCalledWith({
              type: "rpcResult",
              id: 1,
              ok: true,
              value: "ok",
            });
            message(h.worker, { type: "result", ok: true, value: "ok" });
            h.worker.finishTermination();
          }),
        ),
        Effect.andThen(Fiber.join(h.outcome)),
        Effect.map((completed) => {
          expect(completed).toEqual({ ok: true, value: "ok" });
          expectReleased(h.worker, h.controller.signal);
        }),
      ),
    );
  },
);

test.each([false, true])(
  "missing heartbeats terminate a pending host RPC with delayed consumer=%s",
  (delayedConsumer) => {
    const pending = deferred<unknown>();
    const agent = vi.fn(() => Effect.runPromise(pending.wait));
    const h = start({ agent }, { stallTimeoutMs: 80 });
    message(h.worker, { type: "rpc", id: 1, op: "agent", payload: {} });
    message(h.worker, { type: "heartbeat", checkpoints: 0 });
    return Effect.runPromise(
      nextTurn.pipe(
        Effect.andThen(
          delayedConsumer
            ? Effect.sync(() => vi.advanceTimersByTime(120))
            : external(() => vi.advanceTimersByTimeAsync(120)),
        ),
        Effect.andThen(nextTurn),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(agent).toHaveBeenCalledTimes(1);
            expect(h.worker.terminate).toHaveBeenCalledTimes(1);
            expect(h.worker.postMessage).not.toHaveBeenCalled();
            h.worker.finishTermination();
          }),
        ),
        Effect.andThen(Fiber.join(h.outcome)),
        Effect.map((completed) => {
          expect(completed).toMatchObject({
            ok: false,
            error: expect.any(WorkflowStallError),
          });
          if (!completed.ok)
            expect((completed.error as Error).message).toBe(
              "workflow script worker became unresponsive for 80ms",
            );
          expectReleased(h.worker, h.controller.signal);
          pending.resolve("late");
        }),
        Effect.andThen(nextTurn),
        Effect.tap(() => Effect.sync(() => expect(h.worker.postMessage).not.toHaveBeenCalled())),
      ),
    );
  },
);

for (const responsive of [false, true]) {
  test(`watchdog releases resources for ${responsive ? "no progress" : "no heartbeat"}`, () => {
    const h = start();
    return Effect.runPromise(
      Effect.scoped(
        Effect.forEach(
          Array.from({ length: 6 }, (_, i) => i),
          (i) =>
            Effect.suspend(() => {
              if (responsive) message(h.worker, { type: "heartbeat", checkpoints: 0 });
              return external(() => vi.advanceTimersByTimeAsync(25)).pipe(Effect.map(() => {}));
            }),
          { discard: true },
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              h.worker.finishTermination();
            }),
          ),
          Effect.andThen(Fiber.join(h.outcome)),
          Effect.map((result) => {
            expect(result).toMatchObject({
              ok: false,
              error: expect.any(WorkflowStallError),
            });
            if (!result.ok)
              expect((result.error as Error).message).toContain(
                responsive ? "no script progress" : "unresponsive",
              );
            expectReleased(h.worker, h.controller.signal);
          }),
        ),
      ),
    );
  });
}

test("worker error identity survives cleanup and OOM maps to a fatal policy", () => {
  const error = new Error("native worker failure");
  const h = start();
  h.worker.emit("error", error);
  h.worker.finishTermination();
  return Effect.runPromise(
    Effect.scoped(
      Fiber.join(h.outcome).pipe(
        Effect.flatMap((completed) =>
          Effect.suspend(() => {
            const result = completed;
            if (result.ok) throw new Error("Expected failure");
            expect(result.error).toBe(error);
            expectReleased(h.worker, h.controller.signal);
            const oom = start();
            oom.worker.emit(
              "error",
              Object.assign(new Error("OOM"), { code: "ERR_WORKER_OUT_OF_MEMORY" }),
            );
            oom.worker.finishTermination();
            return Fiber.join(oom.outcome).pipe(
              Effect.map((value30) => {
                expect(value30).toMatchObject({
                  ok: false,
                  error: expect.any(WorkflowPolicyError),
                });
                expectReleased(oom.worker, oom.controller.signal);
              }),
            );
          }),
        ),
      ),
    ),
  );
});
