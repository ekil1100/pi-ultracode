import { Deferred, Effect, Fiber } from "effect";
import { test, vi, type TestContext } from "vite-plus/test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { Type } from "typebox";
import {
  createWorkflowTool,
  workflowRunsDir,
  type WorkflowToolDeps,
} from "../src/workflow/tool.ts";
import { activeWorkflowCount } from "../src/workflow/leases.ts";
import { RunJournal } from "../src/workflow/journal.ts";
import { WorkflowRegistry } from "../src/workflow/registry.ts";
import { WorkflowRunDetails } from "../src/workflow/run-details.ts";
import { createSnapshot } from "../src/workflow/display.ts";
import type { WorkflowRunOptions, WorkflowRunResult } from "../src/workflow/runtime.ts";
import { openWorkflowOverlay, WorkflowOverlayComponent } from "../src/workflow/workflow-overlay.ts";
import { createStructuredOutputTool } from "../src/workflow/structured-output.ts";
import { WorkflowPolicyError } from "../src/workflow/admission.ts";
import { UltracodeMode } from "../src/mode.ts";
import { registerCommands } from "../src/commands.ts";

const script = `export const meta = { name: 'effect_host', description: 'Host lifecycle regression' }; return 1;`;
const result: WorkflowRunResult = {
  meta: { name: "effect_host", description: "Host lifecycle regression" },
  result: 1,
  logs: [],
  phases: [],
  agentCount: 0,
  agentsUsed: 0,
  cachedCount: 0,
  spentTokens: 0,
  newTokens: 0,
  replayedTokens: 0,
  durationMs: 1,
  maxAgents: 128,
};

function deferred<A = void>() {
  const value = Deferred.makeUnsafe<A, unknown>();
  return {
    wait: Deferred.await(value),
    resolve: (result: A) => Effect.runSync(Deferred.succeed(value, result)),
    reject: (error: unknown) => Effect.runSync(Deferred.fail(value, error)),
  };
}
// Native promises are confined to SDK and Vitest boundaries.
const external = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => error });
const expectFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, check: (error: E) => void) =>
  effect.pipe(
    Effect.match({ onFailure: check, onSuccess: () => assert.fail("Expected a failure") }),
  );

function fixture(t: TestContext) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "uc-effect-host-"));
  t.onTestFinished(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const controller = new AbortController();
  const registry = new WorkflowRegistry();
  const ctx: any = { cwd, sessionManager: { getSessionDir: () => cwd }, ui: { notify: () => {} } };
  return { cwd, ctx, registry, controller, runsDir: path.join(cwd, "ultracode-runs") };
}

function fakeTimers(t: TestContext) {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  t.onTestFinished(() => {
    vi.useRealTimers();
  });
}

function runtime(
  fn: (options: WorkflowRunOptions) => Promise<WorkflowRunResult>,
): WorkflowToolDeps["runWorkflowFn"] {
  return ((_script, options) => fn(options!)) as NonNullable<WorkflowToolDeps["runWorkflowFn"]>;
}

for (const failure of [false, true]) {
  test(`host finalizers run once in ownership order after ${failure ? "failure" : "success"}`, (t) => {
    fakeTimers(t);
    const { ctx, registry, controller, runsDir } = fixture(t);
    const order: string[] = [];
    const leaseCounts: Array<[string, number]> = [];
    let lateObservation:
      | { before: unknown; after: unknown; updatesBefore: number; updatesAfter: number }
      | undefined;
    const primary = { reason: "original non-Error rejection" };
    let options!: WorkflowRunOptions;
    let updates = 0;
    const closeDetails = WorkflowRunDetails.prototype.close;
    vi.spyOn(WorkflowRunDetails.prototype, "close").mockImplementation(function (
      this: WorkflowRunDetails,
      snapshot,
    ) {
      order.push("details");
      leaseCounts.push(["details", activeWorkflowCount(runsDir)]);
      closeDetails.call(this, snapshot);
      throw new Error("secondary details close failure");
    });
    const clear = globalThis.clearInterval;
    vi.spyOn(globalThis, "clearInterval").mockImplementation((timer) => {
      order.push("heartbeat");
      clear(timer);
    });
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, "removeEventListener").mockImplementation((...args) => {
      order.push("listener");
      leaseCounts.push(["listener", activeWorkflowCount(runsDir)]);
      remove(...args);
      throw new Error("secondary listener removal failure");
    });
    const tool = createWorkflowTool({
      registry,
      runWorkflowFn: runtime((received) => {
        options = received;
        const journal = options.journal!;
        const close = journal.close.bind(journal);
        journal.close = () => {
          order.push("journal");
          leaseCounts.push(["journal", activeWorkflowCount(runsDir)]);
          const before = registry.list()[0]!.snapshot;
          const count = updates;
          options.onLog?.("late during cleanup");
          options.onPhase?.("late phase");
          options.onAgentStart?.({} as any);
          options.onAgentEnd?.({} as any);
          options.onAgentActivity?.({} as any);
          options.onAgentTelemetry?.({} as any);
          lateObservation = {
            before,
            after: registry.list()[0]!.snapshot,
            updatesBefore: count,
            updatesAfter: updates,
          };
          close();
          throw new Error("secondary journal close failure");
        };
        order.push("settled");
        return failure
          ? Effect.runPromise(Effect.fail(primary))
          : Effect.runPromise(Effect.succeed(result));
      }),
    });
    const execution = tool.execute(
      "host",
      { script },
      controller.signal,
      () => {
        updates++;
      },
      ctx,
    );
    return Effect.runPromise(
      Effect.scoped(
        (failure
          ? expectFailure(
              external(() => execution),
              (error) => {
                assert.equal((error as Error).cause, primary);
              },
            )
          : external(() => execution).pipe(
              Effect.map((completed) => {
                assert.equal(completed.details.status, "completed");
              }),
            )
        ).pipe(
          Effect.map(() => {
            assert.deepEqual(order, ["settled", "heartbeat", "details", "journal", "listener"]);
            assert.deepEqual(leaseCounts, [
              ["details", 1],
              ["journal", 1],
              ["listener", 0],
            ]);
            assert.ok(lateObservation, "late events return before closed resources are touched");
            assert.deepEqual(lateObservation.after, lateObservation.before);
            assert.equal(lateObservation.updatesAfter, lateObservation.updatesBefore);
            assert.equal(getEventListeners(controller.signal, "abort").length, 0);
            assert.equal(vi.getTimerCount(), 0);
            const before = registry.list()[0]!.snapshot;
            options.onLog?.("late after completion");
            assert.deepEqual(registry.list()[0]!.snapshot, before);
          }),
        ),
      ),
    );
  });
}

for (const primary of [undefined, Object.create(null)]) {
  test(`host preserves ${primary === undefined ? "undefined" : "unprintable"} rejections as the original cause`, (t) => {
    const { ctx, registry, controller, runsDir } = fixture(t);
    const tool = createWorkflowTool({
      registry,
      runWorkflowFn: runtime(() => Effect.runPromise(Effect.fail(primary))),
    });
    return Effect.runPromise(
      Effect.scoped(
        expectFailure(
          external(() => tool.execute("cause", { script }, controller.signal, undefined, ctx)),
          (error) => {
            assert.equal(Object.hasOwn(error as Error, "cause"), true);
            assert.equal((error as Error).cause, primary);
          },
        ).pipe(
          Effect.map(() => {
            assert.equal(registry.list()[0]!.snapshot.status, "failed");
            assert.equal(activeWorkflowCount(runsDir), 0);
            assert.equal(getEventListeners(controller.signal, "abort").length, 0);
          }),
        ),
      ),
    );
  });
}

test("host retains its lease, listener and journal until cancellation drain settles", (t) => {
  fakeTimers(t);
  const { ctx, registry, controller, runsDir } = fixture(t);
  const started = deferred();
  const drain = deferred<WorkflowRunResult>();
  let options!: WorkflowRunOptions;
  const close = vi.spyOn(RunJournal.prototype, "close");
  const tool = createWorkflowTool({
    registry,
    runWorkflowFn: runtime((received) => {
      options = received;
      started.resolve();
      return Effect.runPromise(drain.wait);
    }),
  });
  const execution = tool.execute("drain", { script }, controller.signal, undefined, ctx);
  return Effect.runPromise(
    Effect.scoped(
      expectFailure(
        external(() => execution),
        (error) => assert.match(String(error), /was aborted/),
      ).pipe(
        Effect.forkScoped({ startImmediately: true }),
        Effect.flatMap((rejected) =>
          started.wait.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                controller.abort();
                assert.equal(options.signal?.aborted, true);
                assert.equal(activeWorkflowCount(runsDir), 1);
                assert.equal(close.mock.calls.length, 0);
                assert.equal(vi.getTimerCount(), 1);
                drain.resolve(result);
              }),
            ),
            Effect.andThen(Fiber.join(rejected)),
            Effect.map(() => {
              assert.equal(activeWorkflowCount(runsDir), 0);
              assert.equal(close.mock.calls.length, 1);
              assert.equal(getEventListeners(controller.signal, "abort").length, 0);
              assert.equal(vi.getTimerCount(), 0);
            }),
          ),
        ),
      ),
    ),
  );
});

test("host keeps heartbeat failure as the cause while waiting for runtime drain", (t) => {
  fakeTimers(t);
  const { ctx, registry, controller, runsDir } = fixture(t);
  const started = deferred();
  const drain = deferred<WorkflowRunResult>();
  const primary = new Error("heartbeat observer failed");
  let options!: WorkflowRunOptions;
  const tool = createWorkflowTool({
    registry,
    runWorkflowFn: runtime((received) => {
      options = received;
      started.resolve();
      return Effect.runPromise(drain.wait);
    }),
  });
  const execution = tool.execute(
    "heartbeat",
    { script },
    controller.signal,
    () => {
      throw primary;
    },
    ctx,
  );
  return Effect.runPromise(
    Effect.scoped(
      expectFailure(
        external(() => execution),
        (error) => {
          assert.equal((error as Error).cause, primary);
        },
      ).pipe(
        Effect.forkScoped({ startImmediately: true }),
        Effect.flatMap((rejected) =>
          started.wait.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                vi.advanceTimersByTime(1000);
                assert.equal(options.signal?.aborted, true);
                assert.equal(activeWorkflowCount(runsDir), 1);
                drain.reject(new Error("runtime cancellation is secondary"));
              }),
            ),
            Effect.andThen(Fiber.join(rejected)),
            Effect.map(() => {
              assert.equal(registry.list()[0]!.snapshot.status, "failed");
              assert.equal(activeWorkflowCount(runsDir), 0);
              assert.equal(vi.getTimerCount(), 0);
            }),
          ),
        ),
      ),
    ),
  );
});

test("host closes partial setup resources and preserves the setup rejection", (t) => {
  fakeTimers(t);
  const { ctx, registry, controller, runsDir } = fixture(t);
  const primary = new Error("registry setup failed");
  vi.spyOn(registry, "register").mockImplementation(() => {
    throw primary;
  });
  const closeDetails = vi.spyOn(WorkflowRunDetails.prototype, "close");
  const closeJournal = vi.spyOn(RunJournal.prototype, "close");
  const run = vi.fn(() => Effect.runPromise(Effect.succeed(result)));
  const tool = createWorkflowTool({ registry, runWorkflowFn: runtime(run) });
  return Effect.runPromise(
    Effect.scoped(
      expectFailure(
        external(() => tool.execute("setup", { script }, controller.signal, undefined, ctx)),
        (error) => {
          assert.equal(error, primary);
        },
      ).pipe(
        Effect.map(() => {
          assert.equal(run.mock.calls.length, 0);
          assert.equal(closeDetails.mock.calls.length, 1);
          assert.equal(closeJournal.mock.calls.length, 1);
          assert.equal(activeWorkflowCount(runsDir), 0);
          assert.equal(getEventListeners(controller.signal, "abort").length, 0);
          assert.equal(vi.getTimerCount(), 0);
        }),
      ),
    ),
  );
});

test("host removes an abort listener when attachment throws after registration", (t) => {
  const { ctx, controller, runsDir } = fixture(t);
  const primary = new Error("attachment failed");
  const add = controller.signal.addEventListener.bind(controller.signal);
  vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
    add(...args);
    throw primary;
  });
  const tool = createWorkflowTool();
  return Effect.runPromise(
    Effect.scoped(
      expectFailure(
        external(() => tool.execute("attach", { script }, controller.signal, undefined, ctx)),
        (error) => {
          assert.equal(error, primary);
        },
      ).pipe(
        Effect.map(() => {
          assert.equal(getEventListeners(controller.signal, "abort").length, 0);
          assert.equal(activeWorkflowCount(runsDir), 0);
          assert.equal(fs.existsSync(runsDir), false);
        }),
      ),
    ),
  );
});

function overlayFixture(t: TestContext) {
  const { cwd, registry } = fixture(t);
  const details = new WorkflowRunDetails({ runId: "wf_overlay", name: "overlay", runsDir: cwd });
  details.startTask({ id: 1, label: "task", prompt: "prompt", workflowPath: ["overlay"] });
  const snapshot = createSnapshot({ name: "overlay", description: "x" }, "wf_overlay");
  snapshot.status = "completed";
  registry.register("wf_overlay", snapshot, () => {}, details);
  const tui: any = { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() };
  const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  return { cwd, registry, details, tui, theme };
}

test("overlay scope releases every resource despite throwing unsubscribers and rejects late input", (t) => {
  fakeTimers(t);
  const { registry, details, tui, theme } = overlayFixture(t);
  const callbacks: Array<() => void> = [];
  const unsubscribed: string[] = [];
  vi.spyOn(registry, "subscribe").mockImplementation((callback) => {
    callbacks.push(callback);
    return () => {
      unsubscribed.push("registry");
      throw new Error("registry unsubscribe failed");
    };
  });
  vi.spyOn(details, "subscribe").mockImplementation((callback) => {
    callbacks.push(callback);
    return () => {
      unsubscribed.push("details");
      throw new Error("details unsubscribe failed");
    };
  });
  const viewed = vi.spyOn(details, "setViewedTask");
  const close = vi.fn();
  const component = new WorkflowOverlayComponent({ tui, theme, registry, onClose: close });
  component.render(120);
  callbacks.forEach((callback) => callback());
  assert.equal(vi.getTimerCount(), 2, "heartbeat and coalesced render timer are live");
  component.dispose();
  component.dispose();
  const renders = tui.requestRender.mock.calls.length;
  callbacks.forEach((callback) => callback());
  component.handleInput("\u001b");
  vi.advanceTimersByTime(2000);
  assert.deepEqual(unsubscribed, ["registry", "details"]);
  assert.equal(viewed.mock.calls.at(-1)?.[0], undefined);
  assert.equal(tui.requestRender.mock.calls.length, renders);
  assert.equal(close.mock.calls.length, 0);
  assert.equal(vi.getTimerCount(), 0);
});

test("overlay constructor unwinds subscriptions and timers when heartbeat setup fails", (t) => {
  fakeTimers(t);
  const { registry, details, tui, theme } = overlayFixture(t);
  const primary = new Error("timer unref failed");
  const detached: string[] = [];
  vi.spyOn(registry, "subscribe").mockReturnValue(() => {
    detached.push("registry");
  });
  vi.spyOn(details, "subscribe").mockReturnValue(() => {
    detached.push("details");
  });
  const viewed = vi.spyOn(details, "setViewedTask");
  const interval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((
    ...args: Parameters<typeof setInterval>
  ) => {
    const timer = interval(...args);
    timer.unref = () => {
      throw primary;
    };
    return timer;
  }) as typeof setInterval);
  assert.throws(
    () => new WorkflowOverlayComponent({ tui, theme, registry, onClose: () => {} }),
    (error) => error === primary,
  );
  assert.deepEqual(detached, ["registry", "details"]);
  assert.equal(viewed.mock.calls.at(-1)?.[0], undefined);
  assert.equal(vi.getTimerCount(), 0);
});

test("overlay releases the previous selected details scope when switching runs", (t) => {
  fakeTimers(t);
  const { cwd, registry, details, tui, theme } = overlayFixture(t);
  const second = new WorkflowRunDetails({ runId: "wf_second", name: "second", runsDir: cwd });
  const snapshot = createSnapshot({ name: "second", description: "x" }, "wf_second");
  snapshot.status = "completed";
  registry.register("wf_second", snapshot, () => {}, second);
  const releases = vi.fn();
  vi.spyOn(details, "subscribe").mockReturnValue(releases);
  const viewed = vi.spyOn(details, "setViewedTask");
  const component = new WorkflowOverlayComponent({
    tui,
    theme,
    registry,
    preferredRunId: "wf_overlay",
    onClose: () => {},
  });
  component.handleInput("\u001b");
  const index = registry.list().findIndex((handle) => handle.snapshot.runId === "wf_second");
  for (let i = 0; i < index; i++) component.handleInput("\u001b[B");
  component.handleInput("\r");
  assert.equal(releases.mock.calls.length, 1);
  assert.equal(viewed.mock.calls.at(-1)?.[0], undefined);
  component.dispose();
  assert.equal(releases.mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 0);
});

for (const failure of [false, true]) {
  test(`overlay adapter releases its component and open lock when the host ${failure ? "rejects" : "resolves"}`, (t) => {
    fakeTimers(t);
    const { registry, tui, theme } = overlayFixture(t);
    const primary = new Error("custom UI failed");
    let opens = 0;
    const ctx: any = {
      mode: "tui",
      ui: {
        notify: () => {},
        custom: (factory: any) => {
          opens++;
          factory(tui, theme, {}, () => {});
          return failure ? Effect.runPromise(Effect.fail(primary)) : Effect.runPromise(Effect.void);
        },
      },
    };
    return Effect.runPromise(
      Effect.scoped(
        Effect.forEach(
          Array.from({ length: 2 }, (_, i) => i),
          (i) =>
            Effect.suspend(() => {
              const opening = openWorkflowOverlay(ctx, registry);
              return (
                failure
                  ? expectFailure(
                      external(() => opening),
                      (error) => {
                        assert.equal(error, primary);
                      },
                    )
                  : external(() => opening)
              ).pipe(
                Effect.map(() => {
                  assert.equal(vi.getTimerCount(), 0);
                }),
              );
            }),
          { discard: true },
        ).pipe(
          Effect.map(() => {
            assert.equal(opens, 2);
          }),
        ),
      ),
    );
  });
}

test("structured output validates before mutating capture and retains the terminating result contract", () => {
  const capture = { value: undefined as unknown, called: false };
  const tool = createStructuredOutputTool({ schema: Type.Any(), capture });
  return Effect.runPromise(
    Effect.scoped(
      expectFailure(
        external(() => tool.execute("invalid", { bad: Infinity }, undefined, undefined, {} as any)),
        (error) => assert.ok(error instanceof WorkflowPolicyError),
      ).pipe(
        Effect.flatMap(() =>
          Effect.suspend(() => {
            assert.deepEqual(capture, { value: undefined, called: false });
            const value = { ok: true };
            return external(() =>
              tool.execute("valid", value, undefined, undefined, {} as any),
            ).pipe(
              Effect.map((output) => {
                assert.equal(output.terminate, true);
                assert.equal(output.details, value);
                assert.deepEqual(capture, { value, called: true });
              }),
            );
          }),
        ),
      ),
    ),
  );
});

test("mode constructor exposes closure-backed methods without changing parent effort", () => {
  const mode = new UltracodeMode("workflow");
  let tools = ["read"];
  const pi: any = {
    getActiveTools: () => tools,
    setActiveTools: (next: string[]) => {
      tools = next;
    },
    appendEntry: () => {
      throw new Error("persistence is best effort");
    },
    setThinkingLevel: () => {
      throw new Error("parent effort must remain unchanged");
    },
  };
  const { enable, suspend, restore, getMode } = mode;
  enable(pi, "standard");
  assert.deepEqual(tools, ["read", "workflow"]);
  suspend(pi);
  assert.deepEqual(tools, ["read"]);
  assert.equal(getMode(), "standard");
  restore(pi, [{ type: "custom", customType: "ultracode-mode", data: { mode: "auto" } }]);
  assert.equal(getMode(), "auto");
  assert.deepEqual(tools, ["read", "workflow"]);
});

test("rewritten implementation uses combinators without catch clauses", () => {
  const files = [
    "src/workflow/runtime.ts",
    "src/workflow/script-executor.ts",
    "src/jev.ts",
    "src/workflow/agent-runner.ts",
    "src/workflow/tool.ts",
    "src/workflow/workflow-overlay.ts",
    "src/workflow/structured-output.ts",
    "src/commands.ts",
    "src/mode.ts",
    "extensions/ultracode.ts",
  ];
  const findings: Array<{ file: string; violations: string[] }> = [];
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const violations: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCatchClause(node)) violations.push("catch clause");
      if (ts.isYieldExpression(node)) violations.push("suspension expression");
      if (ts.isFunctionLike(node) && "asteriskToken" in node && node.asteriskToken)
        violations.push("generator function");
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(source) === "Effect" &&
        node.expression.name.text === "gen"
      ) {
        violations.push("generator orchestration");
      }
      if (
        ts.isFunctionLike(node) &&
        ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        violations.push("async implementation");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (violations.length > 0) findings.push({ file, violations });
  }
  assert.deepEqual(findings, []);
});

for (const primary of [undefined, { reason: "observer failure" }]) {
  test(`synchronous update failure preserves identity and disables later updates: ${String(primary)}`, (t) => {
    const { ctx, registry, controller } = fixture(t);
    const update = vi.fn(() => {
      throw primary;
    });
    const tool = createWorkflowTool({
      registry,
      runWorkflowFn: runtime((options) => {
        assert.throws(
          () => options.onLog?.("first update"),
          (error) => Object.is(error, primary),
        );
        assert.doesNotThrow(() => options.onLog?.("second update"));
        return Effect.runPromise(Effect.succeed(result));
      }),
    });
    return Effect.runPromise(
      Effect.scoped(
        external(() => tool.execute("observer", { script }, controller.signal, update, ctx)).pipe(
          Effect.map((completed) => {
            assert.equal(completed.details.status, "completed");
            assert.equal(update.mock.calls.length, 1);
            assert.deepEqual(registry.list()[0]!.snapshot.logs, ["first update", "second update"]);
          }),
        ),
      ),
    );
  });
}

test("artifact directory retains the session directory when session ID lookup fails", (t) => {
  const { cwd } = fixture(t);
  const getSessionId = vi.fn(() => {
    throw undefined;
  });
  assert.equal(
    workflowRunsDir({
      cwd,
      sessionManager: { getSessionDir: () => cwd, getSessionId },
    }),
    path.join(cwd, "ultracode-runs"),
  );
  assert.equal(getSessionId.mock.calls.length, 1);
  const skipped = vi.fn(() => "unused");
  workflowRunsDir({
    cwd,
    sessionManager: {
      getSessionDir: () => {
        throw new Error("unavailable");
      },
      getSessionId: skipped,
    },
  });
  assert.equal(skipped.mock.calls.length, 0);
});

for (const stage of ["read", "save", "status"] as const) {
  test(`default preference failure at ${stage} preserves prior state changes`, () => {
    let handler!: (args: string, ctx: any) => Promise<unknown>;
    let enabled = false;
    let tools = ["read"];
    const mode = new UltracodeMode("workflow");
    const pi: any = {
      registerCommand: (name: string, command: any) => {
        if (name === "ultracode") handler = command.handler;
      },
      registerShortcut: () => {},
      getActiveTools: () => tools,
      setActiveTools: (next: string[]) => {
        tools = next;
      },
      appendEntry: () => {},
    };
    registerCommands(pi, mode, new WorkflowRegistry(), {
      getDefaultEnabled: () => {
        if (stage === "read") throw new Error("read failed");
        return enabled;
      },
      setDefaultEnabled: (value) => {
        enabled = value;
        if (stage === "save") throw new Error("save failed");
      },
    });
    const notify = vi.fn();
    assert.equal(enabled, false);
    return Effect.runPromise(
      Effect.scoped(
        external(() =>
          handler(stage === "read" ? "default" : "default on", {
            ui: {
              notify,
              theme: { fg: (_color: string, text: string) => text },
              setStatus: () => {
                throw new Error("status failed");
              },
            },
          }),
        ).pipe(
          Effect.map(() => {
            assert.equal(enabled, stage !== "read");
            assert.equal(mode.getMode(), stage === "status" ? "auto" : "off");
            assert.deepEqual(tools, stage === "status" ? ["read", "workflow"] : ["read"]);
            assert.equal(notify.mock.calls.length, 1);
            assert.match(notify.mock.calls[0]![0], /Failed to (read|save) Ultracode default/);
            assert.equal(notify.mock.calls[0]![1], "error");
          }),
        ),
      ),
    );
  });
}

test("new Effect regression tests contain no catch clauses", () => {
  for (const file of [
    "test/effect-host.test.ts",
    "test/effect-executor.test.ts",
    "test/effect-agent-runner.test.ts",
  ]) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      assert.equal(ts.isCatchClause(node), false, file);
      if (file !== "test/effect-agent-runner.test.ts") {
        assert.deepEqual(
          testControlFlowViolations(node, source),
          [],
          `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

function testControlFlowViolations(node: ts.Node, source: ts.SourceFile): string[] {
  const violations: string[] = [];
  if (ts.isTryStatement(node)) violations.push("try statement");
  if (ts.isCatchClause(node)) violations.push("catch clause");
  if (ts.isAwaitExpression(node)) violations.push("await expression");
  if (ts.isYieldExpression(node)) violations.push("yield expression");
  if (node.kind === ts.SyntaxKind.AsyncKeyword) violations.push("async modifier");
  if (ts.isFunctionLike(node) && "asteriskToken" in node && node.asteriskToken)
    violations.push("generator function");
  if (ts.isNewExpression(node) && node.expression.getText(source) === "Promise")
    violations.push("native Promise constructor");
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const owner = node.expression.expression.getText(source);
    const method = node.expression.name.text;
    if (owner === "Promise" || ["then", "catch", "finally"].includes(method))
      violations.push("native Promise coordination");
    if (owner === "Effect" && method === "gen") violations.push("generator orchestration");
  }
  return violations;
}

test("owned test control-flow guard rejects native coordination and accepts Effect composition", () => {
  const scan = (text: string) => {
    const source = ts.createSourceFile("guard.ts", text, ts.ScriptTarget.Latest, true);
    const violations: string[] = [];
    const visit = (node: ts.Node): void => {
      violations.push(...testControlFlowViolations(node, source));
      ts.forEachChild(node, visit);
    };
    visit(source);
    return violations;
  };
  for (const syntax of [
    "async () => 1",
    "await run()",
    "function* run() { yield 1; }",
    "try { run(); } catch (error) {}",
    "new Promise(done => done())",
    "Promise.all([])",
    "Promise.race([])",
    "task.then(done)",
    "task.catch(fail)",
    "Effect.gen(run)",
  ])
    assert.ok(scan(syntax).length > 0, syntax);
  assert.deepEqual(
    scan(
      "Effect.all([Deferred.await(gate), Fiber.join(fiber)]).pipe(Effect.flatMap(run), Effect.match(handlers), Effect.scoped)",
    ),
    [],
  );
});
