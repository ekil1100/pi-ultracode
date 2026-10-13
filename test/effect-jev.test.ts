import { expect, test, vi } from "vite-plus/test";
import { getEventListeners } from "node:events";
import { Effect, Fiber } from "effect";
import type { ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import {
  createJevBatch,
  selectJevEfforts,
  type JevRuntime,
  type JevSelection,
} from "../src/jev.ts";

// Native promises are confined to the SDK and Vitest boundaries.
const external = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => error });
const nextTurn = Effect.callback<void>((resume) => {
  const handle = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(handle));
});
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => error,
      onSuccess: () => {
        throw new Error("Expected selection failure");
      },
    }),
  );

const model: ClassifierModel<"typesafe-system-one"> = {
  type: "classifier",
  provider: "typesafe",
  id: "jev-latest",
  api: "typesafe-system-one",
  name: "Jev",
  baseUrl: "https://example.invalid",
  input: ["text"],
  contextWindow: 1_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const choice = (value: string) => ({
  type: "choice" as const,
  choice: value,
  probabilities: { [value]: 1 },
  confidence: 1,
});
const response = (): ClassifierResult => ({
  api: "typesafe-system-one",
  provider: "typesafe",
  model: "jev-latest",
  timestamp: 0,
  stopReason: "stop",
  answers: { task_0: choice("low"), task_1: choice("high") },
});

function harness() {
  const available = vi.fn(() => Effect.runPromise(Effect.succeed([model])));
  const classify = vi.fn<JevRuntime["classify"]>(() => Effect.runPromise(Effect.sync(response)));
  const runtime: Partial<JevRuntime> = {
    getAvailableOfType: available as JevRuntime["getAvailableOfType"],
    classify,
  };
  const task = (name: string): JevSelection => ({
    runtime,
    task: name,
    model: { provider: "child", id: "actual" },
    supportedEfforts: ["low", "high"],
  });
  return { available, classify, runtime, task };
}

for (const stage of ["availability", "classification"] as const) {
  for (const synchronous of [false, true]) {
    test(`native ${stage} ${synchronous ? "throw" : "rejection"} falls back silently without retries`, () => {
      const h = harness();
      const logs = ["debug", "info", "warn", "error", "log"].map((method) =>
        vi.spyOn(console, method as "log").mockImplementation(() => {}),
      );
      const fail = () => {
        const error = { privateInput: "private provider response" };
        if (synchronous) throw error;
        return Effect.runPromise(Effect.fail(error));
      };
      if (stage === "availability") h.available.mockImplementation(fail);
      else h.classify.mockImplementation(fail);
      return Effect.runPromise(
        external(() =>
          selectJevEfforts({ runtime: h.runtime, tasks: [h.task("first"), h.task("second")] }),
        ).pipe(
          Effect.map((result) => {
            expect(result).toEqual([undefined, undefined]);
            expect(h.available).toHaveBeenCalledTimes(1);
            expect(h.classify).toHaveBeenCalledTimes(stage === "classification" ? 1 : 0);
            for (const log of logs) expect(log).not.toHaveBeenCalled();
          }),
        ),
      );
    });
  }
}

test("native classifier options, receiver, and per-answer fallback remain intact", () => {
  const h = harness();
  const controller = new AbortController();
  h.classify.mockImplementation(function (this: JevRuntime, selected, context, options) {
    return Effect.runPromise(
      Effect.sync(() => {
        expect(this).toBe(h.runtime);
        expect(selected).toBe(model);
        expect(Object.keys(context.questions)).toEqual(["task_0", "task_2"]);
        expect(options).toEqual({ signal: controller.signal, timeoutMs: 10_000, maxRetries: 0 });
        return {
          ...response(),
          answers: {
            task_0: choice("low"),
            task_2: choice("unsupported"),
            extra: choice("high"),
          },
        };
      }),
    );
  });
  return Effect.runPromise(
    external(() =>
      selectJevEfforts({
        runtime: h.runtime,
        signal: controller.signal,
        tasks: [h.task("first"), { ...h.task("fixed"), supportedEfforts: ["off"] }, h.task("last")],
      }),
    ).pipe(
      Effect.map((result) => {
        expect(result).toEqual(["low", undefined, undefined]);
        expect(h.classify).toHaveBeenCalledTimes(1);
      }),
    ),
  );
});

for (const stage of ["availability", "classification"] as const) {
  test(`abort racing successful ${stage} rejects rather than publishing fallback`, () => {
    const h = harness();
    const controller = new AbortController();
    if (stage === "availability")
      h.available.mockImplementation(() =>
        Effect.runPromise(
          Effect.sync(() => {
            controller.abort();
            return [model];
          }),
        ),
      );
    else
      h.classify.mockImplementation(() =>
        Effect.runPromise(
          Effect.sync(() => {
            controller.abort();
            return response();
          }),
        ),
      );
    return Effect.runPromise(
      failure(
        external(() =>
          selectJevEfforts({
            runtime: h.runtime,
            tasks: [h.task("task")],
            signal: controller.signal,
          }),
        ),
      ).pipe(
        Effect.map((error) => {
          expect(() => {
            throw error;
          }).toThrow("Subagent was aborted");
          expect(h.classify).toHaveBeenCalledTimes(stage === "classification" ? 1 : 0);
        }),
      ),
    );
  });
}

test("sealed batch waits for every member, ignores duplicate submissions and selects only once", () => {
  const h = harness();
  const controller = new AbortController();
  const members = createJevBatch(3, { goal: "shared" }, controller.signal);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
  return Effect.runPromise(
    Effect.all(
      [
        external(() => members[0].select(h.task("first"))).pipe(
          Effect.forkScoped({ startImmediately: true }),
        ),
        external(() => members[0].select(h.task("ignored"))).pipe(
          Effect.forkScoped({ startImmediately: true }),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          members[0].skip();
          members[1].skip();
        }),
      ),
      Effect.tap(() => nextTurn),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(h.available).not.toHaveBeenCalled();
          h.available.mockImplementation(() =>
            Effect.runPromise(
              Effect.sync(() => {
                expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
                return [model];
              }),
            ),
          );
        }),
      ),
      Effect.flatMap(([first, duplicate]) =>
        Effect.all(
          [
            Fiber.join(first),
            Fiber.join(duplicate),
            external(() => members[2].select(h.task("last"))),
          ],
          { concurrency: "unbounded" },
        ),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toEqual(["low", "low", "high"]);
          expect(h.classify).toHaveBeenCalledTimes(1);
          const context = h.classify.mock.calls[0][1];
          expect(context.state).toMatchObject({
            workflow: { goal: "shared" },
            tasks: { task_0: { prompt: "first" }, task_1: { prompt: "last" } },
          });
        }),
      ),
      Effect.andThen(external(() => members[1].select(h.task("too late")))),
      Effect.map((result) => {
        expect(result).toBeUndefined();
        expect(h.classify).toHaveBeenCalledTimes(1);
      }),
      Effect.scoped,
    ),
  );
});

test("batch cancellation frees a ready member and keeps late members on the same failure", () => {
  const h = harness();
  const controller = new AbortController();
  const members = createJevBatch(2, {}, controller.signal);
  return Effect.runPromise(
    failure(external(() => members[0].select(h.task("ready")))).pipe(
      Effect.forkScoped({ startImmediately: true }),
      Effect.tap(() => Effect.sync(() => controller.abort(new Error("private abort reason")))),
      Effect.flatMap(Fiber.join),
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error).toEqual(new Error("Subagent was aborted"));
          expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        }),
      ),
      Effect.flatMap((error) =>
        failure(external(() => members[1].select(h.task("late")))).pipe(
          Effect.map((late) => {
            expect(late).toBe(error);
            expect(h.available).not.toHaveBeenCalled();
            expect(h.classify).not.toHaveBeenCalled();
          }),
        ),
      ),
      Effect.scoped,
    ),
  );
});

test("unobserved skipped, empty and pre-aborted batches release listeners without a request", () => {
  const h = harness();
  const skipped = new AbortController();
  const members = createJevBatch(2, {}, skipped.signal);
  members.forEach((member) => member.skip());
  const empty = new AbortController();
  expect(createJevBatch(0, {}, empty.signal)).toEqual([]);
  const aborted = AbortSignal.abort();
  createJevBatch(2, {}, aborted);
  return Effect.runPromise(
    nextTurn.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          for (const signal of [skipped.signal, empty.signal, aborted]) {
            expect(getEventListeners(signal, "abort")).toHaveLength(0);
          }
        }),
      ),
      Effect.andThen(external(() => members[0].select(h.task("late")))),
      Effect.map((result) => {
        expect(result).toBeUndefined();
        expect(h.available).not.toHaveBeenCalled();
      }),
    ),
  );
});

test("batch classification failure shares one silent fallback with every member", () => {
  const h = harness();
  h.classify.mockImplementation(() =>
    Effect.runPromise(Effect.fail(new Error("private request failure"))),
  );
  const signal = new AbortController().signal;
  const members = createJevBatch(2, {}, signal);
  return Effect.runPromise(
    Effect.all(
      members.map((member, index) => external(() => member.select(h.task(`task-${index}`)))),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((result) => {
        expect(result).toEqual([undefined, undefined]);
        expect(h.available).toHaveBeenCalledTimes(1);
        expect(h.classify).toHaveBeenCalledTimes(1);
        expect(getEventListeners(signal, "abort")).toHaveLength(0);
      }),
    ),
  );
});

test("same-turn abort after the last submission prevents native availability", () => {
  const h = harness();
  const controller = new AbortController();
  const [member] = createJevBatch(1, {}, controller.signal);
  return Effect.runPromise(
    failure(external(() => member.select(h.task("ready")))).pipe(
      // Eager fork enters the native select seam before abort, without yielding the turn.
      Effect.forkScoped({ startImmediately: true }),
      Effect.tap(() => Effect.sync(() => controller.abort())),
      Effect.flatMap(Fiber.join),
      Effect.map((error) => {
        expect(() => {
          throw error;
        }).toThrow("Subagent was aborted");
        expect(h.available).not.toHaveBeenCalled();
        expect(h.classify).not.toHaveBeenCalled();
      }),
      Effect.scoped,
    ),
  );
});
