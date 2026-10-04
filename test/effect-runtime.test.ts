import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Deferred, Effect, Fiber, Scope } from "effect";
import * as ts from "typescript";
import * as agentRunnerModule from "../src/workflow/agent-runner.ts";
import {
  AgentAdmission,
  WorkflowAbortError,
  WorkflowCleanupTimeoutError,
  WorkflowPolicyError,
} from "../src/workflow/admission.ts";
import type { AgentRunResult, AgentRunner } from "../src/workflow/agent-runner.ts";
import { RunJournal } from "../src/workflow/journal.ts";
import * as repositoryModule from "../src/workflow/repository-context.ts";
import * as worktreeModule from "../src/workflow/worktree.ts";
import { resolveRepositoryContext } from "../src/workflow/repository-context.ts";
import { runWorkflow } from "../src/workflow/runtime.ts";

const header = `export const meta = { name: 'effect_runtime', description: 'Effect runtime lifecycle regression' };`;
const panel = (labels: string[]) => `${header}
  return await parallel(${JSON.stringify(labels)}.map(label => () => agent(label, { label })));`;

// Promises belong only to the public workflow/runner and test-runner boundaries.
const external = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => error });
const nextTurn = Effect.callback<void>((resume) => {
  const handle = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(handle));
});

function gate() {
  const ready = Deferred.makeUnsafe<void>();
  return { wait: Deferred.await(ready), open: Deferred.succeed(ready, undefined) };
}

function result(value: unknown): AgentRunResult {
  return { value, cwd: process.cwd(), usage: { outputTokens: 1, totalTokens: 1, cost: 0 } };
}

const fixture = Effect.scope.pipe(
  Effect.flatMap((scope) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "uc-effect-runtime-"));
        const controller = new AbortController();
        return { cwd, controller, signal: controller.signal, scope };
      }),
      ({ cwd, controller }) =>
        Effect.sync(() => {
          controller.abort();
          fs.rmSync(cwd, { recursive: true, force: true });
        }),
    ),
  ),
);

const runFixture = <A, E>(
  use: (env: Effect.Success<typeof fixture>) => Effect.Effect<A, E, Scope.Scope>,
) => Effect.runPromise(fixture.pipe(Effect.flatMap(use), Effect.scoped));

const journalFor = (cwd: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      RunJournal.create(path.join(cwd, "journal"), {
        type: "run",
        runId: "effect-runtime",
        name: "effect_runtime",
        scriptHash: "unchanged",
        startedAt: 0,
        projectTrusted: false,
        targetIdentity: resolveRepositoryContext(cwd).identity,
      }),
    ),
    (journal) => Effect.sync(() => journal.close()),
  );

const expectFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, check: (error: E) => void) =>
  effect.pipe(
    Effect.match({ onFailure: check, onSuccess: () => assert.fail("Expected a failure") }),
  );

function controlFlowViolations(text: string, fileName: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: string[] = [];
  function visit(node: ts.Node): void {
    const report = (message: string) => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${fileName}:${line + 1}: ${message}`);
    };
    if (ts.isTryStatement(node) && node.catchClause) {
      report(
        "TryStatement with catch is forbidden; use Effect or Result error combinators (finally-only is allowed)",
      );
    }
    if (ts.isCatchClause(node)) {
      report("CatchClause is forbidden; preserve errors in the typed failure channel");
    }
    const generator = "asteriskToken" in node && node.asteriskToken;
    const effectGen =
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "Effect" &&
      node.expression.name.text === "gen";
    if (
      generator ||
      effectGen ||
      ts.isYieldExpression(node) ||
      ts.isAwaitExpression(node) ||
      node.kind === ts.SyntaxKind.AsyncKeyword
    ) {
      report(`${ts.SyntaxKind[node.kind]} is forbidden; use functional Effect composition`);
    }
    if (
      (ts.isNewExpression(node) && node.expression.getText(source) === "Promise") ||
      (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(source) === "Promise")
    ) {
      report("Native Promise coordination is forbidden; use Effect.all, races and Deferred gates");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}

for (const relativePath of ["../src/workflow/runtime.ts", "./effect-runtime.test.ts"]) {
  test(`${relativePath} uses Effect error flow without try-catch`, () => {
    const file = new URL(relativePath, import.meta.url);
    assert.deepEqual(
      controlFlowViolations(fs.readFileSync(file, "utf8"), relativePath),
      [],
      "Use functional Effect composition in runtime and its fixtures",
    );
  });
}

test("control-flow guard distinguishes finally-only syntax from try-catch", () => {
  assert.deepEqual(
    controlFlowViolations("try { cleanup(); } finally { release(); }", "allowed.ts"),
    [],
  );
  const violations = controlFlowViolations(
    "try { run(); } catch (error) { recover(error); }",
    "forbidden.ts",
  );
  assert.equal(violations.length, 2);
  assert.match(violations[0], /TryStatement with catch is forbidden/);
  assert.match(violations[1], /CatchClause is forbidden/);
});

test("runner creation stays lazy and live publication precedes completion and replay", () =>
  runFixture(({ cwd, signal }) =>
    journalFor(cwd).pipe(
      Effect.flatMap((journal) => {
        const trace: string[] = [];
        const identities: Array<{ id: number; callPath: string }> = [];
        const run = vi.fn<AgentRunner["run"]>((call) =>
          Effect.runPromise(
            external(() => call.selectEffort!()).pipe(
              Effect.andThen(external(() => call.acquireExecution!())),
              Effect.andThen(
                Effect.sync(() => {
                  trace.push(`run:${call.label}`);
                  return result(call.label);
                }),
              ),
            ),
          ),
        );
        const constructor = vi.spyOn(agentRunnerModule, "WorkflowAgentRunner").mockImplementation(
          class {
            readonly supportsSchedulingHooks = true;
            readonly run = run;
            constructor() {
              trace.push("construct");
            }
          },
        );
        const recordAdmission = journal.recordAdmission.bind(journal);
        vi.spyOn(journal, "recordAdmission").mockImplementation((callPath, key, ordinal) => {
          trace.push(`admit:${ordinal}`);
          recordAdmission(callPath, key, ordinal);
        });
        const recordAgent = journal.recordAgent.bind(journal);
        vi.spyOn(journal, "recordAgent").mockImplementation((record) => {
          trace.push(`commit:${record.label}`);
          recordAgent(record);
        });
        const script = `${header}
      return [await agent('one', {label: 'one'}), await agent('two', {label: 'two'})];`;
        const options = {
          cwd,
          signal,
          journal,
          projectTrusted: false,
          maxAgents: 2,
          onAgentStart: (event: {
            id: number;
            callPath: string;
            label: string;
            cached: boolean;
          }) => {
            trace.push(`${event.cached ? "replay" : "start"}:${event.label}`);
            identities.push({ id: event.id, callPath: event.callPath });
          },
          onAgentEnd: (event: { label: string }) => {
            trace.push(`end:${event.label}`);
          },
        };
        return external(() => runWorkflow(`${header} return 7`, { cwd, signal })).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              assert.equal(constructor.mock.calls.length, 0);
              assert.equal(trace.length, 0);
            }),
          ),
          Effect.andThen(external(() => runWorkflow(script, options))),
          Effect.tap((live) =>
            Effect.sync(() => {
              assert.deepEqual(live.result, ["one", "two"]);
              assert.equal(live.agentsUsed, 2);
              assert.equal(constructor.mock.calls.length, 1);
              assert.deepEqual(trace, [
                "admit:1",
                "start:one",
                "construct",
                "run:one",
                "commit:one",
                "end:one",
                "admit:2",
                "start:two",
                "run:two",
                "commit:two",
                "end:two",
              ]);
              trace.length = 0;
            }),
          ),
          Effect.flatMap((live) =>
            external(() => runWorkflow(script, options)).pipe(
              Effect.tap((replay) =>
                Effect.sync(() => {
                  assert.deepEqual(replay.result, live.result);
                  assert.equal(replay.cachedCount, 2);
                  assert.equal(replay.agentsUsed, 2);
                  assert.equal(replay.newTokens, 0);
                  assert.equal(replay.replayedTokens, live.newTokens);
                  assert.equal(constructor.mock.calls.length, 1);
                  assert.equal(run.mock.calls.length, 2);
                  assert.deepEqual(identities.slice(2), identities.slice(0, 2));
                  assert.deepEqual(trace, ["replay:one", "end:one", "replay:two", "end:two"]);
                  assert.equal(getEventListeners(signal, "abort").length, 0);
                }),
              ),
            ),
          ),
        );
      }),
    ),
  ));

for (const failure of [false, true]) {
  test(`workflow scope removes its abort listener after ${failure ? "failure" : "success"}`, () =>
    runFixture(({ cwd, signal }) => {
      const baseline = getEventListeners(signal, "abort").length;
      const running = external(() =>
        runWorkflow(`${header} ${failure ? "throw new Error('script failed')" : "return 7"}`, {
          cwd,
          signal,
        }),
      );
      return (
        failure
          ? expectFailure(running, (error) => assert.match(String(error), /script failed/))
          : running.pipe(
              Effect.tap((completed) => Effect.sync(() => assert.equal(completed.result, 7))),
              Effect.asVoid,
            )
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => assert.equal(getEventListeners(signal, "abort").length, baseline)),
        ),
      );
    }));
}

test("typed Effect failures preserve the original policy error, cause and custom properties", () =>
  runFixture(({ cwd, signal }) =>
    journalFor(cwd).pipe(
      Effect.flatMap((journal) => {
        const cause = new Error("storage unavailable");
        const policy = Object.assign(new WorkflowPolicyError("admission failed"), {
          cause,
          detail: { ordinal: 1 },
        });
        vi.spyOn(journal, "recordAdmission").mockImplementation(() => {
          throw policy;
        });
        const run = vi.fn<AgentRunner["run"]>(() =>
          Effect.runPromise(Effect.succeed(result("unexpected"))),
        );
        return expectFailure(
          external(() =>
            runWorkflow(`${header} return await agent('one')`, {
              cwd,
              signal,
              journal,
              projectTrusted: false,
              runner: { run },
            }),
          ),
          (error) => {
            assert.equal(error, policy);
            assert.equal(policy.cause, cause);
            assert.deepEqual(policy.detail, { ordinal: 1 });
            assert.equal(policy.code, "WORKFLOW_POLICY_ERROR");
          },
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              assert.equal(run.mock.calls.length, 0);
              assert.equal(getEventListeners(signal, "abort").length, 0);
            }),
          ),
        );
      }),
    ),
  ));

test(
  "FIFO execution hands queued calls permits before later pipeline stages",
  { timeout: 5_000 },
  () =>
    runFixture(({ cwd, signal }) => {
      const first = gate();
      const ready = gate();
      const execution: string[] = [];
      let prepared = 0;
      let active = 0;
      let maximum = 0;
      const running = external(() =>
        runWorkflow(
          `${header}
      return await pipeline(['a', 'b', 'c'],
        item => agent(item, {label: item}),
        (previous, item) => agent(item + '-next', {label: item + '-next'}));`,
          {
            cwd,
            signal,
            concurrency: 1,
            runner: {
              supportsSchedulingHooks: true,
              run: (call) =>
                Effect.runPromise(
                  external(() => call.selectEffort!()).pipe(
                    Effect.andThen(() => (++prepared === 3 ? ready.open : Effect.void)),
                    Effect.andThen(
                      Effect.all(
                        [
                          external(() => call.acquireExecution!()),
                          external(() => call.acquireExecution!()),
                        ],
                        { concurrency: "unbounded" },
                      ),
                    ),
                    Effect.andThen(external(() => call.acquireExecution!())),
                    Effect.andThen(
                      Effect.acquireRelease(
                        Effect.sync(() => {
                          execution.push(call.label);
                          maximum = Math.max(maximum, ++active);
                        }),
                        () =>
                          Effect.sync(() => {
                            active--;
                          }),
                      ),
                    ),
                    Effect.andThen(call.label === "a" ? first.wait : Effect.void),
                    Effect.andThen(nextTurn),
                    Effect.as(result(call.label)),
                    Effect.scoped,
                  ),
                ),
            },
          },
        ),
      );
      return running.pipe(
        Effect.forkScoped,
        Effect.flatMap((fiber) =>
          Effect.raceFirst(ready.wait, Fiber.join(fiber)).pipe(
            Effect.andThen(nextTurn),
            Effect.tap(() => Effect.sync(() => assert.deepEqual(execution, ["a"]))),
            Effect.ensuring(first.open),
            Effect.andThen(Fiber.join(fiber)),
            Effect.tap((completed) =>
              Effect.sync(() => {
                assert.deepEqual(execution.slice(0, 3), ["a", "b", "c"]);
                assert.deepEqual(completed.result, ["a-next", "b-next", "c-next"]);
                assert.equal(maximum, 1);
                assert.equal(active, 0);
              }),
            ),
          ),
        ),
      );
    }),
);

test(
  "scheduling failures before and after acquisition release the batch and permit",
  { timeout: 5_000 },
  () =>
    runFixture(({ cwd, signal }) => {
      const execution: string[] = [];
      return external(() =>
        runWorkflow(panel(["prepare-fails", "execute-fails", "succeeds"]), {
          cwd,
          signal,
          concurrency: 1,
          runner: {
            supportsSchedulingHooks: true,
            run(call) {
              // A synchronous throw at the native runner boundary must share the rejection channel.
              if (call.label === "prepare-fails") throw new Error("preparation failed");
              return Effect.runPromise(
                external(() => call.selectEffort!()).pipe(
                  Effect.andThen(external(() => call.acquireExecution!())),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      execution.push(call.label);
                    }),
                  ),
                  Effect.andThen(
                    call.label === "execute-fails"
                      ? Effect.fail(new Error("execution failed"))
                      : Effect.succeed(result(call.label)),
                  ),
                ),
              );
            },
          },
        }),
      ).pipe(
        Effect.tap((completed) =>
          Effect.sync(() => {
            assert.deepEqual(completed.result, [null, null, "succeeds"]);
            assert.deepEqual(execution, ["execute-fails", "succeeds"]);
            assert.equal(completed.agentsUsed, 3);
            assert.match(completed.logs.join("\n"), /preparation failed/);
            assert.match(completed.logs.join("\n"), /execution failed/);
          }),
        ),
      );
    }),
);

test(
  "agent scope cancels an abandoned queued acquisition without leaking capacity",
  { timeout: 5_000 },
  () =>
    runFixture(({ cwd, signal, scope }) => {
      const held = gate();
      const firstStarted = gate();
      const failed = gate();
      const abandoned = Deferred.makeUnsafe<unknown>();
      const execution: string[] = [];
      const running = external(() =>
        runWorkflow(panel(["held", "abandons", "last"]), {
          cwd,
          signal,
          concurrency: 1,
          onAgentEnd: (event) => {
            if (event.label === "abandons") Effect.runSync(failed.open);
          },
          runner: {
            supportsSchedulingHooks: true,
            run: (call) =>
              Effect.runPromise(
                external(() => call.selectEffort!()).pipe(
                  Effect.andThen(() => {
                    if (call.label === "abandons") {
                      return firstStarted.wait.pipe(
                        Effect.andThen(
                          Effect.sync(() => {
                            // Start a native hook and intentionally leave it outstanding when this runner fails.
                            Effect.runSync(
                              Effect.forkIn(
                                external(() => call.acquireExecution!()).pipe(
                                  Effect.match({
                                    onSuccess: () => "unexpected acquisition",
                                    onFailure: (error) => error,
                                  }),
                                  Effect.flatMap((error) => Deferred.succeed(abandoned, error)),
                                ),
                                scope,
                              ),
                            );
                          }),
                        ),
                        Effect.andThen(Effect.fail(new Error("failed while waiting"))),
                      );
                    }
                    return external(() => call.acquireExecution!()).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          execution.push(call.label);
                        }),
                      ),
                      Effect.andThen(
                        call.label === "held"
                          ? firstStarted.open.pipe(Effect.andThen(held.wait))
                          : Effect.void,
                      ),
                      Effect.as(result(call.label)),
                    );
                  }),
                ),
              ),
          },
        }),
      );
      return running.pipe(
        Effect.forkScoped,
        Effect.flatMap((fiber) =>
          Effect.raceFirst(failed.wait, Fiber.join(fiber)).pipe(
            Effect.andThen(Deferred.await(abandoned)),
            Effect.tap((error) =>
              Effect.sync(() => {
                assert.ok(error instanceof WorkflowAbortError);
                assert.deepEqual(execution, ["held"]);
              }),
            ),
            Effect.ensuring(held.open),
            Effect.andThen(Fiber.join(fiber)),
            Effect.tap((completed) =>
              Effect.sync(() => {
                assert.deepEqual(completed.result, ["held", null, "last"]);
                assert.deepEqual(execution, ["held", "last"]);
              }),
            ),
          ),
        ),
      );
    }),
);

test("a completed agent rejects late execution-hook calls even after cached admission", () =>
  runFixture(({ cwd, signal }) => {
    let acquire: (() => Promise<void>) | undefined;
    return external(() =>
      runWorkflow(`${header} return await agent('one')`, {
        cwd,
        signal,
        runner: {
          supportsSchedulingHooks: true,
          run(call) {
            acquire = call.acquireExecution;
            return Effect.runPromise(
              external(() => call.selectEffort!()).pipe(
                Effect.andThen(external(() => acquire!())),
                Effect.as(result("done")),
              ),
            );
          },
        },
      }),
    ).pipe(
      Effect.andThen(
        expectFailure(
          external(() => acquire!()),
          (error) => assert.ok(error instanceof WorkflowAbortError),
        ),
      ),
    );
  }));

test(
  "cancellation drains an active runner and rejects every queued scheduling hook",
  { timeout: 5_000 },
  () =>
    runFixture(({ cwd, signal, controller }) => {
      const allPrepared = gate();
      const activeStarted = gate();
      const finish = gate();
      let prepared = 0;
      let cleaned = 0;
      const executed: string[] = [];
      const queuedErrors: unknown[] = [];
      const running = external(() =>
        runWorkflow(panel(["active", "queued-a", "queued-b"]), {
          cwd,
          signal,
          concurrency: 1,
          runner: {
            supportsSchedulingHooks: true,
            run: (call) =>
              Effect.runPromise(
                external(() => call.selectEffort!()).pipe(
                  Effect.andThen(() => (++prepared === 3 ? allPrepared.open : Effect.void)),
                  Effect.andThen(
                    external(() => call.acquireExecution!()).pipe(
                      Effect.tapError((error) =>
                        Effect.sync(() => {
                          queuedErrors.push(error);
                        }),
                      ),
                    ),
                  ),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      executed.push(call.label);
                    }),
                  ),
                  Effect.andThen(activeStarted.open),
                  Effect.andThen(finish.wait),
                  Effect.as(result(call.label)),
                  Effect.ensuring(
                    Effect.sync(() => {
                      cleaned++;
                    }),
                  ),
                ),
              ),
          },
        }),
      );
      return running.pipe(
        Effect.forkScoped,
        Effect.flatMap((fiber) =>
          Effect.raceFirst(
            Effect.all([allPrepared.wait, activeStarted.wait], { concurrency: "unbounded" }),
            Fiber.join(fiber),
          ).pipe(
            Effect.tap(() => Effect.sync(() => controller.abort())),
            Effect.ensuring(finish.open),
            Effect.andThen(
              expectFailure(Fiber.join(fiber), (error) =>
                assert.ok(error instanceof WorkflowAbortError),
              ),
            ),
            Effect.tap(() =>
              Effect.sync(() => {
                assert.deepEqual(executed, ["active"]);
                assert.equal(cleaned, 3);
                assert.equal(queuedErrors.length, 2);
                assert.ok(queuedErrors.every((error) => error instanceof WorkflowAbortError));
                assert.equal(getEventListeners(signal, "abort").length, 0);
              }),
            ),
          ),
        ),
      );
    }),
);

test(
  "bounded policy drain retains error identity and attaches cleanupError without late publication",
  { timeout: 5_000 },
  () =>
    runFixture(({ cwd, signal }) =>
      journalFor(cwd).pipe(
        Effect.flatMap((journal) => {
          const slowStarted = gate();
          const slowFinish = gate();
          const slowReturned = gate();
          const policy = Object.assign(new WorkflowPolicyError("durable publication failed"), {
            cause: new Error("disk failure"),
          });
          const ends: string[] = [];
          const recordAgent = vi.spyOn(journal, "recordAgent").mockImplementation(() => {
            throw policy;
          });
          const startedAt = Date.now();
          const running = external(() =>
            runWorkflow(panel(["slow", "fatal"]), {
              cwd,
              signal,
              journal,
              projectTrusted: false,
              cleanupTimeoutMs: 40,
              concurrency: 2,
              onAgentEnd: (event) => ends.push(event.label),
              runner: {
                run: (call) =>
                  Effect.runPromise(
                    call.label === "slow"
                      ? slowStarted.open.pipe(
                          Effect.andThen(slowFinish.wait),
                          Effect.andThen(slowReturned.open),
                          Effect.as(result("late")),
                        )
                      : slowStarted.wait.pipe(Effect.as(result("fatal"))),
                  ),
              },
            }),
          );
          return expectFailure(running, (error) => {
            assert.equal(error, policy);
            const cleanup = (error as WorkflowPolicyError & { cleanupError?: unknown })
              .cleanupError;
            assert.ok(cleanup instanceof WorkflowCleanupTimeoutError);
            assert.equal(cleanup.code, "WORKFLOW_CLEANUP_TIMEOUT");
            assert.match(cleanup.message, /40ms/);
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                assert.ok(Date.now() - startedAt < 1_500);
                assert.equal(getEventListeners(signal, "abort").length, 0);
              }),
            ),
            Effect.ensuring(slowFinish.open),
            Effect.andThen(slowReturned.wait),
            Effect.andThen(nextTurn),
            Effect.tap(() =>
              Effect.sync(() => {
                assert.deepEqual(ends, []);
                assert.equal(recordAgent.mock.calls.length, 1);
                assert.equal(
                  fs.readFileSync(journal.filePath, "utf8").includes('"type":"agent"'),
                  false,
                );
              }),
            ),
          );
        }),
      ),
    ),
);

for (const method of [
  "panelReplayPlan",
  "recordPanelOpen",
  "recordPanelBranch",
  "recordPanelComplete",
  "lookup",
  "recordNestedSource",
  "recordAgent",
] as const) {
  for (const isPolicy of [false, true]) {
    test(`${method} retains ${isPolicy ? "policy identity" : "storage cause"} and releases panel capacity`, () =>
      runFixture(({ cwd, signal }) =>
        journalFor(cwd).pipe(
          Effect.flatMap((journal) => {
            const original = isPolicy
              ? new WorkflowPolicyError(`${method} failed`)
              : new Error(`${method} failed`);
            const operation = vi.spyOn(journal, method).mockImplementation(() => {
              throw original;
            });
            const reserve = vi.spyOn(AgentAdmission.prototype, "reservePanelWithBranchNeeds");
            const run = vi.fn<AgentRunner["run"]>(() =>
              Effect.runPromise(Effect.succeed(result("done"))),
            );
            const body =
              method === "recordNestedSource"
                ? "return await workflow('child');"
                : method === "lookup" || method === "recordAgent"
                  ? "return await agent('one');"
                  : "return await parallel([() => 1, () => 2]);";
            return expectFailure(
              external(() =>
                runWorkflow(`${header} ${body}`, {
                  cwd,
                  signal,
                  journal,
                  projectTrusted: false,
                  maxAgents: 2,
                  runner: { run },
                  loadSavedWorkflow: () => ({
                    meta: { name: "child", description: "child fixture" },
                    body: "return 7;",
                  }),
                }),
              ),
              (error) => {
                assert.ok(error instanceof WorkflowPolicyError);
                if (isPolicy) assert.equal(error, original);
                else assert.equal(error.cause, original);
              },
            ).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  assert.ok(operation.mock.calls.length > 0);
                  if (method.startsWith("recordPanel")) {
                    assert.equal(reserve.mock.calls.length, 1);
                    const admission = reserve.mock.contexts[0] as AgentAdmission;
                    assert.equal(
                      admission.availableAgents,
                      2,
                      "All unused branch and panel slots return to root capacity",
                    );
                    assert.equal(admission.usedAgents, 0);
                  } else if (method === "panelReplayPlan")
                    assert.equal(reserve.mock.calls.length, 0);
                  assert.equal(run.mock.calls.length, method === "recordAgent" ? 1 : 0);
                  assert.equal(getEventListeners(signal, "abort").length, 0);
                }),
              ),
            );
          }),
        ),
      ));
  }
}

function stubWorktree(cwd: string) {
  const worktree: worktreeModule.Worktree = {
    repoRoot: cwd,
    path: path.join(cwd, "isolated"),
    agentCwd: path.join(cwd, "isolated"),
    baseCommit: "base",
    gitDir: path.join(cwd, "git"),
    gitDirDevice: 1,
    gitDirInode: 1,
    gitCommonDir: path.join(cwd, "git"),
    device: 1,
    inode: 1,
    rawObjectDirectory: path.join(cwd, "objects"),
    rawObjectDevice: 1,
    rawObjectInode: 1,
    rawObjectToken: "fixture",
    repositoryObjectDirectory: path.join(cwd, "objects"),
    rawBaseTree: "base",
    rawBaselineExtras: [],
  };
  const create = vi.spyOn(worktreeModule, "createWorktree").mockReturnValue(worktree);
  const remove = vi.spyOn(worktreeModule, "removeWorktree").mockImplementation(() => {});
  const capture = vi.spyOn(worktreeModule, "captureWorktreeDiff").mockReturnValue({
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
    diffStat: "fixture",
    patch: Buffer.from("patch"),
    paths: [],
  });
  return { worktree, create, remove, capture };
}

for (const cleanup of ["success", "ordinary failure", "policy failure"] as const) {
  test(`worktree setup rollback preserves error precedence after ${cleanup}`, () =>
    runFixture(({ cwd, signal }) => {
      const { worktree, create, remove } = stubWorktree(cwd);
      const primary = new WorkflowPolicyError("post-create identity check failed");
      const secondary =
        cleanup === "policy failure"
          ? new WorkflowPolicyError("remove failed")
          : new Error("remove failed");
      const context = resolveRepositoryContext(cwd);
      vi.spyOn(repositoryModule, "resolveRepositoryContext").mockImplementation(() => {
        if (create.mock.calls.length > 0) throw primary;
        return context;
      });
      if (cleanup !== "success")
        remove.mockImplementation(() => {
          throw secondary;
        });
      const run = vi.fn<AgentRunner["run"]>(() =>
        Effect.runPromise(Effect.succeed(result("unexpected"))),
      );
      const running = external(() =>
        runWorkflow(`${header} return await agent('one', { isolation: 'worktree' });`, {
          cwd,
          signal,
          runner: { run },
        }),
      );
      const checked =
        cleanup === "ordinary failure"
          ? running.pipe(
              Effect.tap((completed) =>
                Effect.sync(() => {
                  assert.equal(completed.result, null);
                  assert.match(completed.logs.join("\n"), /worktree setup failed: remove failed/);
                }),
              ),
              Effect.asVoid,
            )
          : expectFailure(running, (error) =>
              assert.equal(error, cleanup === "success" ? primary : secondary),
            );
      return checked.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            assert.deepEqual(remove.mock.calls, [[worktree]]);
            assert.equal(run.mock.calls.length, 0);
          }),
        ),
      );
    }));
}

for (const stage of ["capture", "rescue"] as const) {
  test(`worktree ${stage} failure and log failure preserve the primary policy identity`, () =>
    runFixture(({ cwd, signal }) => {
      const { worktree, remove, capture } = stubWorktree(cwd);
      const primary = new WorkflowPolicyError("runner policy failure");
      const cleanup = new Error(`${stage} failed`);
      const logs: string[] = [];
      if (stage === "capture")
        capture.mockImplementation(() => {
          throw cleanup;
        });
      const rescue = vi.spyOn(worktreeModule, "writeRescuePatch").mockImplementation(() => {
        throw cleanup;
      });
      return expectFailure(
        external(() =>
          runWorkflow(`${header} return await agent('one', { isolation: 'worktree' });`, {
            cwd,
            signal,
            runner: { run: () => Effect.runPromise(Effect.fail(primary)) },
            onLog: (line) => {
              logs.push(line);
              throw new Error("display failed");
            },
          }),
        ),
        (error) => assert.equal(error, primary),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            assert.equal(capture.mock.calls.length, 1);
            assert.equal(rescue.mock.calls.length, stage === "rescue" ? 1 : 0);
            assert.equal(
              remove.mock.calls.length,
              0,
              "Recovery failure preserves the isolated edits",
            );
            assert.match(logs.join("\n"), new RegExp(`${stage}.*failed`));
            assert.ok(logs.some((line) => line.includes(worktree.path)));
          }),
        ),
      );
    }));
}

test("worktree removal and completion observer failures preserve a committed result", () =>
  runFixture(({ cwd, signal }) =>
    journalFor(cwd).pipe(
      Effect.flatMap((journal) => {
        const { remove, capture } = stubWorktree(cwd);
        capture.mockReturnValue({
          filesChanged: 0,
          insertions: 0,
          deletions: 0,
          diffStat: "",
          patch: Buffer.alloc(0),
          paths: [],
        });
        remove.mockImplementation(() => {
          throw new Error("remove failed");
        });
        const order: string[] = [];
        return external(() =>
          runWorkflow(`${header} return await agent('one', { isolation: 'worktree' });`, {
            cwd,
            signal,
            journal,
            projectTrusted: false,
            runner: {
              run: () => {
                order.push("run");
                return Effect.runPromise(Effect.succeed(result("committed")));
              },
            },
            onAgentStart: () => {
              order.push("start");
            },
            onAgentEnd: () => {
              assert.ok(fs.readFileSync(journal.filePath, "utf8").includes('"type":"agent"'));
              order.push("end");
              throw new Error("completion failed");
            },
            onLog: () => {
              throw new Error("display failed");
            },
          }),
        ).pipe(
          Effect.tap((completed) =>
            Effect.sync(() => {
              assert.equal(completed.result, "committed");
              assert.deepEqual(order, ["start", "run", "end"]);
              assert.equal(remove.mock.calls.length, 1);
              assert.match(
                completed.logs.join("\n"),
                /completion observer failed: completion failed/,
              );
            }),
          ),
        );
      }),
    ),
  ));

test("synchronous start-observer failure retains its exact cause and prevents runner creation", () =>
  runFixture(({ cwd, signal }) => {
    const original = Object.assign(new Error("start failed"), { detail: "observer" });
    const constructor = vi.spyOn(agentRunnerModule, "WorkflowAgentRunner");
    return expectFailure(
      external(() =>
        runWorkflow(`${header} return await agent('one');`, {
          cwd,
          signal,
          onAgentStart: () => {
            throw original;
          },
        }),
      ),
      (error) => {
        assert.ok(error instanceof WorkflowPolicyError);
        assert.equal(error.cause, original);
        assert.match(error.message, /workflow observer failed: start failed/);
      },
    ).pipe(Effect.tap(() => Effect.sync(() => assert.equal(constructor.mock.calls.length, 0))));
  }));
