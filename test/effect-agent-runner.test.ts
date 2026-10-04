import { expect, test, vi } from "vite-plus/test";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { Deferred, Effect, Fiber } from "effect";
import ts from "typescript";
import {
  WorkflowAgentRunner,
  forwardActivity,
  forwardTelemetry,
  type AgentRunCall,
  type AgentSessionLike,
  type AgentTelemetryEvent,
  type ModelRuntimeLike,
  type WorkflowAgentRunnerOptions,
} from "../src/workflow/agent-runner.ts";
function controlFlowViolations(text: string, fileName: string, nativeBoundary = false): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) violations.push("CatchClause");
    if (ts.isYieldExpression(node)) violations.push("YieldExpression");
    if ("asteriskToken" in node && node.asteriskToken) violations.push("GeneratorFunction");
    if (ts.isAwaitExpression(node) || node.kind === ts.SyntaxKind.AsyncKeyword)
      violations.push("AsyncImplementation");
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Effect" &&
      node.name.text === "gen"
    )
      violations.push("Effect.gen");
    if (!nativeBoundary) {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Promise"
      )
        violations.push("new Promise");
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const receiver =
          ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
            ? callee.expression
            : undefined;
        const method = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression)
            ? callee.argumentExpression.text
            : undefined;
        if (receiver && ts.isIdentifier(receiver) && receiver.text === "Promise")
          violations.push("Promise static operation");
        if (
          method === "then" ||
          (method === "catch" &&
            receiver &&
            !(ts.isIdentifier(receiver) && receiver.text === "Effect"))
        )
          violations.push("Promise outcome wrapper");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

test("runner orchestration uses combinators without generators or async functions", () => {
  const file = new URL("../src/workflow/agent-runner.ts", import.meta.url);
  expect(controlFlowViolations(readFileSync(file, "utf8"), file.pathname, true)).toEqual([]);
});

for (const relativePath of ["./effect-agent-runner.test.ts", "./effect-jev.test.ts"]) {
  test(`${relativePath} uses scoped Effect composition without native Promise coordination`, () => {
    const file = new URL(relativePath, import.meta.url);
    expect(controlFlowViolations(readFileSync(file, "utf8"), file.pathname)).toEqual([]);
  });
}

test("test orchestration guard detects syntax rather than string literal mentions", () => {
  for (const text of [
    "async function run() {}",
    "async () => await operation()",
    "function* run() { yield operation(); }",
    "try { run(); } catch (error) { recover(error); }",
    "new Promise(resolve => resolve())",
    "Promise.all([])",
    "Promise.allSettled([])",
    "Promise.race([])",
    "Promise.any([])",
    "Promise.resolve(1)",
    "Promise.reject(undefined)",
    'Promise["all"]([])',
    "pending.then(onSuccess)",
    "pending.catch(onFailure)",
    "Effect.gen(function* () {})",
  ])
    expect(controlFlowViolations(text, "forbidden.ts").length).toBeGreaterThan(0);
  expect(
    controlFlowViolations(
      'const text = "async await function* yield try catch new Promise Promise.all([]) pending.then() pending.catch()";',
      "literal.ts",
    ),
  ).toEqual([]);
  expect(
    controlFlowViolations(
      "Effect.all([task]).pipe(Effect.catch(error => Effect.fail(error)))",
      "allowed.ts",
    ),
  ).toEqual([]);
});

function deferred<A = void>() {
  const gate = Deferred.makeUnsafe<A, unknown>();
  return {
    wait: Deferred.await(gate),
    resolve: (value: A) => Deferred.succeed(gate, value),
    reject: (error: unknown) => Deferred.fail(gate, error),
  };
}
// Native promises are confined to the SDK and Vitest boundaries.
const external = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => error });
const nextTurn = Effect.callback<void>((resume) => {
  const handle = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(handle));
});
function harness(
  overrides: Partial<AgentSessionLike> = {},
  options: Partial<WorkflowAgentRunnerOptions> = {},
) {
  const events: string[] = [];
  const session: AgentSessionLike = {
    thinkingLevel: "medium",
    model: { provider: "test", id: "child" },
    supportsThinking: () => true,
    getAvailableThinkingLevels: () => ["low", "medium", "high"],
    setThinkingLevel: (level) => {
      session.thinkingLevel = level;
    },
    prompt: vi.fn(() =>
      Effect.runPromise(
        Effect.sync(() => {
          events.push("prompt");
        }),
      ),
    ),
    abort: vi.fn(() =>
      Effect.runPromise(
        Effect.sync(() => {
          events.push("abort");
        }),
      ),
    ),
    subscribe: vi.fn(() => {
      events.push("subscribe");
      return () => {
        events.push("unsubscribe");
      };
    }),
    dispose: vi.fn(() => {
      events.push("dispose");
    }),
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    ...overrides,
  };
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    createSession: () => Effect.runPromise(Effect.sync(() => ({ session }))),
    ...options,
  });
  const run = (call: Partial<AgentRunCall> = {}) =>
    external(() =>
      runner.run({
        label: "lifecycle",
        prompt: "Assigned task",
        onActivity: () => {},
        ...call,
      }),
    );
  return { run, runner, session, events };
}
// Eager scoped forks enter native calls in the same turn, matching SDK call timing.
// Keep failure values, including undefined, distinct from successful completion.
function outcome<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.match({
      onSuccess: (value) => ({ ok: true as const, value }),
      onFailure: (error) => ({ ok: false as const, error }),
    }),
  );
}

test("scheduling hooks run once in order and observers share one scoped subscription", () =>
  Effect.runPromise(
    Effect.suspend(() => {
      const permit = deferred();
      const requested = deferred();
      const h = harness();
      const controller = new AbortController();
      const select = vi.fn((task) =>
        Effect.runPromise(
          Effect.sync(() => {
            expect(task.model).toBe(h.session.model);
            expect(task.task).toBe("Task label: lifecycle\n\nAssigned task");
            h.events.push("select");
            return "low" as const;
          }),
        ),
      );
      const acquire = vi.fn(() => {
        h.events.push("acquire");
        return Effect.runPromise(requested.resolve(undefined).pipe(Effect.andThen(permit.wait)));
      });
      return h
        .run({
          signal: controller.signal,
          selectEffort: select,
          acquireExecution: acquire,
          onTelemetry: () => {},
        })
        .pipe(
          Effect.forkScoped({ startImmediately: true }),
          Effect.flatMap((pending) =>
            requested.wait.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  expect(h.events).toEqual(["select", "acquire"]);
                  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
                }).pipe(Effect.andThen(permit.resolve(undefined))),
              ),
              Effect.andThen(Fiber.join(pending)),
              Effect.map((completed) => {
                expect(completed).toMatchObject({ value: "done", effort: "low" });
                expect(select).toHaveBeenCalledTimes(1);
                expect(acquire).toHaveBeenCalledTimes(1);
                expect(h.events).toEqual([
                  "select",
                  "acquire",
                  "subscribe",
                  "prompt",
                  "unsubscribe",
                  "dispose",
                ]);
                expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
              }),
            ),
          ),
        );
    }).pipe(Effect.scoped),
  ));

test("fixed-effort children still report an undefined selection before admission", () =>
  Effect.runPromise(
    Effect.suspend(() => {
      const h = harness({ getAvailableThinkingLevels: () => ["off"], thinkingLevel: "off" });
      const select = vi.fn(() => Effect.runPromise(Effect.sync(() => undefined)));
      return h
        .run({
          selectEffort: select,
          acquireExecution: () =>
            Effect.runPromise(
              Effect.sync(() => {
                expect(select).toHaveBeenCalledExactlyOnceWith(undefined);
              }),
            ),
        })
        .pipe(
          Effect.andThen(() =>
            Effect.sync(() => {
              expect(h.events).toEqual(["subscribe", "prompt", "unsubscribe", "dispose"]);
            }),
          ),
        );
    }).pipe(Effect.scoped),
  ));

test("cancellation joins a pending session acquisition before disposing it exactly once", () =>
  Effect.runPromise(
    Effect.suspend(() => {
      const controller = new AbortController();
      const entered = deferred();
      const created = deferred<{
        session: AgentSessionLike;
      }>();
      const h = harness(
        {},
        {
          createSession: () => {
            return Effect.runPromise(entered.resolve(undefined).pipe(Effect.andThen(created.wait)));
          },
        },
      );
      let finished = false;
      return outcome(h.run({ signal: controller.signal })).pipe(
        Effect.map((result) => {
          finished = true;
          return result;
        }),
        Effect.forkScoped({ startImmediately: true }),
        Effect.flatMap((pending) =>
          entered.wait.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                controller.abort();
              }),
            ),
            Effect.andThen(nextTurn),
            Effect.tap(() =>
              Effect.sync(() => {
                expect(finished).toBe(false);
              }).pipe(Effect.andThen(created.resolve({ session: h.session }))),
            ),
            Effect.andThen(Fiber.join(pending)),
            Effect.map((completed) => {
              expect(completed).toMatchObject({
                ok: false,
                error: { message: "Subagent was aborted" },
              });
              expect(h.events).toEqual(["dispose"]);
              expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  ));

for (const property of [
  "model",
  "thinkingLevel",
  "supportsThinking",
  "getAvailableThinkingLevels",
] as const) {
  test(`session ownership precedes failing setup access: ${property}`, () =>
    Effect.runPromise(
      Effect.suspend(() => {
        const primary = Object.assign(new Error("Setup failed"), {
          code: "SETUP",
          retryable: false,
        });
        const controller = new AbortController();
        const h = harness(
          {},
          property === "supportsThinking"
            ? { thinkingLevel: "max", supportsMaxThinking: false }
            : {},
        );
        if (property === "model" || property === "thinkingLevel") {
          Object.defineProperty(h.session, property, {
            get: () => {
              throw primary;
            },
          });
        } else {
          h.session[property] = () => {
            throw primary;
          };
        }
        return outcome(h.run({ signal: controller.signal })).pipe(
          Effect.map((result) => {
            expect(result).toEqual({ ok: false, error: primary });
            if (!result.ok) expect(result.error).toBe(primary);
            expect(h.session.dispose).toHaveBeenCalledTimes(1);
            expect(h.session.prompt).not.toHaveBeenCalled();
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
          }),
        );
      }).pipe(Effect.scoped),
    ));
}

test("a failed compatibility replacement follows provisional disposal, even when disposal fails", () =>
  Effect.runPromise(
    Effect.suspend(() => {
      const primary = Object.assign(new Error("Replacement failed"), { code: "CREATE" });
      const order: string[] = [];
      let creates = 0;
      const h = harness(
        {
          dispose: () => {
            order.push("dispose");
            throw new Error("Ignored provisional cleanup");
          },
        },
        {
          thinkingLevel: "max",
          supportsMaxThinking: false,
          createSession: (options) =>
            Effect.runPromise(
              Effect.suspend(() => {
                order.push(`create:${options.thinkingLevel}`);
                return ++creates === 2
                  ? Effect.fail(primary)
                  : Effect.succeed({ session: h.session });
              }),
            ),
        },
      );
      return outcome(h.run()).pipe(
        Effect.map((result) => {
          expect(result).toEqual({ ok: false, error: primary });
          if (!result.ok) expect(result.error).toBe(primary);
          expect(order).toEqual(["create:max", "dispose", "create:xhigh"]);
        }),
      );
    }).pipe(Effect.scoped),
  ));

for (const stage of ["select", "set-effort", "permit", "subscribe"] as const) {
  test(`setup failure at ${stage} releases the abort listener and session`, () =>
    Effect.runPromise(
      Effect.suspend(() => {
        const primary = Object.assign(new Error(stage), { code: "SETUP", details: { stage } });
        const controller = new AbortController();
        const h = harness({
          dispose: vi.fn(() => {
            throw new Error("Secondary disposal failure");
          }),
        });
        const call: Partial<AgentRunCall> = {
          signal: controller.signal,
          selectEffort: () =>
            Effect.runPromise(stage === "select" ? Effect.fail(primary) : Effect.succeed("low")),
          acquireExecution: () =>
            Effect.runPromise(stage === "permit" ? Effect.fail(primary) : Effect.void),
        };
        if (stage === "set-effort")
          h.session.setThinkingLevel = () => {
            throw primary;
          };
        if (stage === "subscribe")
          h.session.subscribe = () => {
            throw primary;
          };
        return outcome(h.run(call)).pipe(
          Effect.map((result) => {
            if (result.ok) throw new Error("Expected setup failure");
            expect(result.error).toBe(primary);
            expect(h.session.dispose).toHaveBeenCalledTimes(1);
            expect(h.session.prompt).not.toHaveBeenCalled();
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
          }),
        );
      }).pipe(Effect.scoped),
    ));
}

for (const primary of [
  undefined,
  null,
  "foreign failure",
  { code: "FOREIGN" },
  Object.assign(new Error("Prompt failed"), {
    code: "PROMPT",
    cause: new Error("Provider failed"),
  }),
]) {
  test(`SDK rejection identity survives failing finalizers: ${String(primary)}`, () =>
    Effect.runPromise(
      Effect.suspend(() => {
        const unsub = vi.fn(() => {
          throw new Error("Unsubscribe failed");
        });
        const dispose = vi.fn(() => {
          throw new Error("Dispose failed");
        });
        const telemetry: AgentTelemetryEvent[] = [];
        const h = harness({
          prompt: () => Effect.runPromise(Effect.fail(primary)),
          subscribe: () => unsub,
          dispose,
        });
        return outcome(
          h.run({
            onTelemetry: (event) => {
              telemetry.push(event);
              throw new Error("Observer failed");
            },
          }),
        ).pipe(
          Effect.map((result) => {
            if (result.ok) throw new Error("Expected prompt failure");
            expect(result.error).toBe(primary);
            expect(unsub).toHaveBeenCalledTimes(1);
            expect(dispose).toHaveBeenCalledTimes(1);
            expect(telemetry.filter((event) => event.kind === "run_error")).toHaveLength(1);
          }),
        );
      }).pipe(Effect.scoped),
    ));
}

for (const first of [
  undefined,
  Object.assign(new Error("First cleanup failure"), { code: "REMOVE_LISTENER" }),
]) {
  test(`successful runs expose the first cleanup failure without skipping finalizers: ${String(first)}`, () =>
    Effect.runPromise(
      Effect.suspend(() => {
        const controller = new AbortController();
        const h = harness();
        const remove = controller.signal.removeEventListener.bind(controller.signal);
        const spy = vi
          .spyOn(controller.signal, "removeEventListener")
          .mockImplementation((...args) => {
            remove(...args);
            h.events.push("remove-abort");
            throw first;
          });
        h.session.subscribe = () => () => {
          h.events.push("unsubscribe");
          throw new Error("Second cleanup failure");
        };
        h.session.dispose = () => {
          h.events.push("dispose");
          throw new Error("Third cleanup failure");
        };
        return outcome(h.run({ signal: controller.signal })).pipe(
          Effect.map((result) => {
            if (result.ok) throw new Error("Expected cleanup failure");
            expect(result.error).toBe(first);
            expect(spy).toHaveBeenCalledTimes(1);
            expect(h.events).toEqual(["prompt", "remove-abort", "unsubscribe", "dispose"]);
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
          }),
        );
      }).pipe(Effect.scoped),
    ));
}

for (const first of ["prompt", "abort"] as const) {
  test(`cancellation drains both external operations when ${first} settles first`, () =>
    Effect.runPromise(
      Effect.suspend(() => {
        const controller = new AbortController();
        const promptEntered = deferred();
        const prompt = deferred();
        const abortEntered = deferred();
        const abort = deferred();
        const h = harness({
          prompt: () => {
            return Effect.runPromise(
              promptEntered.resolve(undefined).pipe(Effect.andThen(prompt.wait)),
            );
          },
          abort: vi.fn(() => {
            return Effect.runPromise(
              abortEntered.resolve(undefined).pipe(Effect.andThen(abort.wait)),
            );
          }),
        });
        let finished = false;
        return outcome(h.run({ signal: controller.signal })).pipe(
          Effect.map((result) => {
            finished = true;
            return result;
          }),
          Effect.forkScoped({ startImmediately: true }),
          Effect.flatMap((pending) =>
            promptEntered.wait.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  controller.abort();
                }),
              ),
              Effect.andThen(abortEntered.wait),
              Effect.tap(() => (first === "prompt" ? prompt : abort).resolve(undefined)),
              Effect.andThen(nextTurn),
              Effect.tap(() =>
                Effect.sync(() => {
                  expect(finished).toBe(false);
                  expect(h.events).toEqual(["subscribe"]);
                }).pipe(Effect.andThen((first === "prompt" ? abort : prompt).resolve(undefined))),
              ),
              Effect.andThen(Fiber.join(pending)),
              Effect.map((completed) => {
                expect(completed).toMatchObject({
                  ok: false,
                  error: { message: "Subagent was aborted" },
                });
                expect(h.session.abort).toHaveBeenCalledTimes(1);
                expect(h.events).toEqual(["subscribe", "unsubscribe", "dispose"]);
                expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
              }),
            ),
          ),
        );
      }).pipe(Effect.scoped),
    ));
}

test("an abort during async preflight keeps the session alive and blocks streaming", () =>
  Effect.runPromise(
    Effect.suspend(() => {
      const controller = new AbortController();
      const entered = deferred();
      const gate = deferred();
      const stream = vi.fn();
      const h = harness({
        prompt: (_prompt, options) =>
          Effect.runPromise(
            entered.resolve(undefined).pipe(
              Effect.andThen(
                gate.wait.pipe(
                  Effect.andThen(() =>
                    Effect.sync(() => {
                      options?.preflightResult?.(true);
                      stream();
                    }),
                  ),
                ),
              ),
            ),
          ),
      });
      return outcome(h.run({ signal: controller.signal })).pipe(
        Effect.forkScoped({ startImmediately: true }),
        Effect.flatMap((pending) =>
          entered.wait.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                controller.abort();
              }),
            ),
            Effect.andThen(nextTurn),
            Effect.tap(() =>
              Effect.sync(() => {
                expect(h.session.dispose).not.toHaveBeenCalled();
              }).pipe(Effect.andThen(gate.resolve(undefined))),
            ),
            Effect.andThen(Fiber.join(pending)),
            Effect.map((completed) => {
              expect(completed).toMatchObject({
                ok: false,
                error: { message: "Subagent was aborted" },
              });
              expect(stream).not.toHaveBeenCalled();
              expect(h.session.dispose).toHaveBeenCalledTimes(1);
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  ));

for (const mode of ["throw", "reject"] as const) {
  test(`abort ${mode} is contained while the prompt retains its original failure`, () =>
    Effect.runPromise(
      Effect.suspend(() => {
        const controller = new AbortController();
        const primary = Object.assign(new Error("Prompt failure"), { code: "PROMPT" });
        const h = harness({
          abort: () => {
            if (mode === "throw") throw new Error("Abort failure");
            return Effect.runPromise(Effect.fail(undefined));
          },
          prompt: () =>
            Effect.runPromise(
              Effect.sync(() => controller.abort()).pipe(Effect.andThen(Effect.fail(primary))),
            ),
        });
        return outcome(h.run({ signal: controller.signal })).pipe(
          Effect.map((result) => {
            if (result.ok) throw new Error("Expected prompt failure");
            expect(result.error).toBe(primary);
            expect(h.events).toEqual(["subscribe", "unsubscribe", "dispose"]);
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
          }),
        );
      }).pipe(Effect.scoped),
    ));
}

for (const stage of ["selection", "permit", "model-resolved", "subscription"] as const) {
  test(`synchronous cancellation at ${stage} prevents prompt entry`, () =>
    Effect.runPromise(
      Effect.suspend(() => {
        const controller = new AbortController();
        const h = harness();
        if (stage === "subscription")
          h.session.subscribe = () => {
            controller.abort();
            return () => h.events.push("unsubscribe");
          };
        return outcome(
          h.run({
            signal: controller.signal,
            selectEffort: () =>
              Effect.runPromise(
                Effect.sync(() => {
                  if (stage === "selection") controller.abort();
                  return undefined;
                }),
              ),
            acquireExecution: () =>
              Effect.runPromise(
                Effect.sync(() => {
                  if (stage === "permit") controller.abort();
                }),
              ),
            onTelemetry: (event) => {
              if (stage === "model-resolved" && event.kind === "model_resolved") controller.abort();
            },
          }),
        ).pipe(
          Effect.map((result) => {
            expect(result).toMatchObject({ ok: false, error: { message: "Subagent was aborted" } });
            expect(h.session.prompt).not.toHaveBeenCalled();
            expect(h.session.abort).toHaveBeenCalledTimes(1);
            expect(h.session.dispose).toHaveBeenCalledTimes(1);
            expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
          }),
        );
      }).pipe(Effect.scoped),
    ));
}

test("cancellation joins in-flight admission without executing or releasing the runtime-owned permit", () =>
  Effect.runPromise(
    Effect.suspend(() => {
      const controller = new AbortController();
      const entered = deferred();
      const permit = deferred();
      const h = harness();
      let settled = false;
      return outcome(
        h.run({
          signal: controller.signal,
          acquireExecution: () => {
            return Effect.runPromise(entered.resolve(undefined).pipe(Effect.andThen(permit.wait)));
          },
        }),
      ).pipe(
        Effect.map((result) => {
          settled = true;
          return result;
        }),
        Effect.forkScoped({ startImmediately: true }),
        Effect.flatMap((pending) =>
          entered.wait.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                controller.abort();
              }),
            ),
            Effect.andThen(nextTurn),
            Effect.tap(() =>
              Effect.sync(() => {
                expect(settled).toBe(false);
                expect(h.events).toEqual(["abort"]);
              }).pipe(Effect.andThen(permit.resolve(undefined))),
            ),
            Effect.andThen(Fiber.join(pending)),
            Effect.map((completed) => {
              expect(completed).toMatchObject({
                ok: false,
                error: { message: "Subagent was aborted" },
              });
              expect(h.events).toEqual(["abort", "dispose"]);
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  ));

test("a cancelled initialization waiter detaches while another joins the shared runtime", () =>
  Effect.runPromise(
    Effect.suspend(() => {
      const controller = new AbortController();
      const entered = deferred();
      const runtime = deferred<ModelRuntimeLike>();
      const create = vi.fn(() => {
        return Effect.runPromise(entered.resolve(undefined).pipe(Effect.andThen(runtime.wait)));
      });
      const h = harness({}, { createModelRuntime: create });
      return Effect.all(
        [
          outcome(h.run({ signal: controller.signal })).pipe(
            Effect.forkScoped({ startImmediately: true }),
          ),
          h.run().pipe(Effect.forkScoped({ startImmediately: true })),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.flatMap(([cancelled, survivor]) =>
          entered.wait.pipe(
            Effect.tap(() => Effect.sync(() => controller.abort())),
            Effect.andThen(Fiber.join(cancelled)),
            Effect.tap((completed) =>
              Effect.sync(() => {
                expect(completed).toMatchObject({
                  ok: false,
                  error: { message: "Subagent was aborted" },
                });
                expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
                expect(h.events).toEqual([]);
              }),
            ),
            Effect.andThen(runtime.resolve({})),
            Effect.andThen(Fiber.join(survivor)),
            Effect.map((survived) => {
              expect(survived).toMatchObject({ value: "done" });
              expect(create).toHaveBeenCalledTimes(1);
              expect(h.session.dispose).toHaveBeenCalledTimes(1);
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  ));

test("shared initialization preserves error identity for all waiters and retries after failure", () =>
  Effect.runPromise(
    Effect.suspend(() => {
      const primary = Object.assign(new Error("Auth replay failed"), {
        code: "AUTH_REPLAY",
        cause: new Error("Key lookup"),
      });
      const gate = deferred<ModelRuntimeLike>();
      const entered = deferred();
      let creates = 0;
      const h = harness(
        {},
        {
          createModelRuntime: () =>
            Effect.runPromise(
              entered
                .resolve(undefined)
                .pipe(Effect.andThen(() => (++creates === 1 ? gate.wait : Effect.succeed({})))),
            ),
        },
      );
      return Effect.all(
        [
          outcome(h.run()).pipe(Effect.forkScoped({ startImmediately: true })),
          outcome(h.run()).pipe(Effect.forkScoped({ startImmediately: true })),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.flatMap(([first, second]) =>
          entered.wait.pipe(
            Effect.andThen(gate.reject(primary)),
            Effect.andThen(
              Effect.all([Fiber.join(first), Fiber.join(second)], { concurrency: "unbounded" }),
            ),
          ),
        ),
        Effect.tap((completed) =>
          Effect.sync(() => {
            for (const result of completed) {
              if (result.ok) throw new Error("Expected initialization failure");
              expect(result.error).toBe(primary);
            }
            expect(creates).toBe(1);
            expect(h.events).toEqual([]);
          }),
        ),
        Effect.andThen(h.run()),
        Effect.map(() => {
          expect(creates).toBe(2);
          expect(h.session.dispose).toHaveBeenCalledTimes(1);
        }),
      );
    }).pipe(Effect.scoped),
  ));

test("a shared initialization failure after its only waiter cancels does not poison the runner", () =>
  Effect.runPromise(
    Effect.suspend(() => {
      const controller = new AbortController();
      const entered = deferred();
      const first = deferred<ModelRuntimeLike>();
      let creates = 0;
      const h = harness(
        {},
        {
          createModelRuntime: () =>
            Effect.runPromise(
              entered
                .resolve(undefined)
                .pipe(Effect.andThen(() => (++creates === 1 ? first.wait : Effect.succeed({})))),
            ),
        },
      );
      return outcome(h.run({ signal: controller.signal })).pipe(
        Effect.forkScoped({ startImmediately: true }),
        Effect.flatMap((cancelled) =>
          entered.wait.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                controller.abort();
              }),
            ),
            Effect.andThen(Fiber.join(cancelled)),
            Effect.tap(() => first.reject(undefined)),
            Effect.andThen(nextTurn),
            Effect.andThen(h.run()),
            Effect.andThen(() =>
              Effect.sync(() => {
                expect(creates).toBe(2);
                expect(h.session.dispose).toHaveBeenCalledTimes(1);
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  ));

test("partially failed abort-listener registration still removes the listener and disposes the session", () =>
  Effect.runPromise(
    Effect.suspend(() => {
      const controller = new AbortController();
      const primary = new Error("Listener registration failed");
      const add = controller.signal.addEventListener.bind(controller.signal);
      vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
        add(...args);
        throw primary;
      });
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const h = harness();
      return outcome(h.run({ signal: controller.signal })).pipe(
        Effect.map((result) => {
          if (result.ok) throw new Error("Expected registration failure");
          expect(result.error).toBe(primary);
          expect(remove).toHaveBeenCalledTimes(1);
          expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
          expect(h.events).toEqual(["dispose"]);
        }),
      );
    }).pipe(Effect.scoped),
  ));

test("cancellation telemetry includes final usage emitted during abort teardown", () =>
  Effect.runPromise(
    Effect.suspend(() => {
      const controller = new AbortController();
      const gate = deferred();
      const entered = deferred();
      let listener: ((event: unknown) => void) | undefined;
      const telemetry: AgentTelemetryEvent[] = [];
      const h = harness({
        subscribe: (next) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        prompt: () =>
          Effect.runPromise(
            Effect.sync(() => {
              controller.abort();
            }),
          ),
        abort: () =>
          Effect.runPromise(
            entered.resolve(undefined).pipe(
              Effect.andThen(
                gate.wait.pipe(
                  Effect.andThen(() =>
                    Effect.sync(() => {
                      const message = {
                        role: "assistant",
                        content: [{ type: "text", text: "partial" }],
                        usage: { input: 7, output: 3, cost: { total: 0.5 } },
                      };
                      h.session.messages.push(message);
                      listener?.({ type: "message_end", message });
                    }),
                  ),
                ),
              ),
            ),
          ),
      });
      return outcome(
        h.run({ signal: controller.signal, onTelemetry: (event) => telemetry.push(event) }),
      ).pipe(
        Effect.forkScoped({ startImmediately: true }),
        Effect.flatMap((pending) =>
          entered.wait.pipe(
            Effect.andThen(nextTurn),
            Effect.tap(() =>
              Effect.sync(() => {
                expect(telemetry.some((event) => event.kind === "run_error")).toBe(false);
              }).pipe(Effect.andThen(gate.resolve(undefined))),
            ),
            Effect.andThen(Fiber.join(pending)),
            Effect.map((completed) => {
              expect(completed).toMatchObject({
                ok: false,
                error: { message: "Subagent was aborted" },
              });
              expect(telemetry.find((event) => event.kind === "run_error")).toMatchObject({
                usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, cost: 0.5, turns: 1 },
              });
              expect(listener).toBeUndefined();
              expect(h.session.dispose).toHaveBeenCalledTimes(1);
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  ));

test("concurrent calls share even a synchronous runtime factory failure and can retry", () =>
  Effect.runPromise(
    Effect.suspend(() => {
      const primary = new Error("Synchronous factory failure");
      let creates = 0;
      const h = harness(
        {},
        {
          createModelRuntime: () => {
            if (++creates === 1) throw primary;
            return Effect.runPromise(Effect.succeed({}));
          },
        },
      );
      return Effect.all([outcome(h.run()), outcome(h.run())], { concurrency: "unbounded" }).pipe(
        Effect.tap((results) =>
          Effect.sync(() => {
            expect(creates).toBe(1);
            for (const result of results) {
              if (result.ok) throw new Error("Expected shared initialization failure");
              expect(result.error).toBe(primary);
            }
          }),
        ),
        Effect.andThen(h.run()),
        Effect.andThen(() =>
          Effect.sync(() => {
            expect(creates).toBe(2);
          }),
        ),
      );
    }).pipe(Effect.scoped),
  ));

for (const forward of [forwardActivity, forwardTelemetry]) {
  test(`${forward.name} contains malformed events and throwing observers synchronously`, () => {
    const malformed = Object.defineProperty({}, "type", {
      get: () => {
        throw undefined;
      },
    });
    const observer = vi.fn(() => {
      throw new Error("observer failed");
    });
    expect(() => forward(malformed, observer)).not.toThrow();
    expect(observer).not.toHaveBeenCalled();
    expect(() => forward({ type: "turn_start" }, observer)).not.toThrow();
    expect(observer).toHaveBeenCalledTimes(1);
  });
}

for (const malformed of [false, true]) {
  test(`usage falls back to messages after ${malformed ? "malformed stats" : "stats lookup failure"}`, () =>
    Effect.runPromise(
      Effect.suspend(() => {
        const h = harness({
          getSessionStats: () => {
            if (!malformed) throw undefined;
            return {
              tokens: Object.defineProperty({}, "input", {
                get: () => {
                  throw new Error("invalid stats");
                },
              }),
            };
          },
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              usage: { input: 7, output: 3, cost: { total: 0.5 } },
            },
          ],
        });
        return h.run({ onActivity: undefined }).pipe(
          Effect.map((completed) => {
            expect(completed).toMatchObject({
              value: "done",
              usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, cost: 0.5, turns: 1 },
            });
            expect(h.session.dispose).toHaveBeenCalledTimes(1);
          }),
        );
      }).pipe(Effect.scoped),
    ));
}
