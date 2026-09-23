import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/ultracode.ts";
import { ANALYSIS_DEPTHS, DEPTH_CRITERIA, DEPTH_SELECTION_RULES } from "../src/depth.ts";
import { JEV_MODEL } from "../src/jev.ts";
import { ULTRACODE_ACTIVE_REMINDER, ultracodeSystemBlock } from "../src/prompts.ts";

function setKey(t: TestContext, key: string | undefined = "test-depth-key") {
  const previous = process.env.TYPESAFE_API_KEY;
  if (key === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = key;
  t.after(() => {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  });
}

function decision(depth: unknown): Response {
  return Response.json({ answers: { depth: { type: "choice", choice: depth } } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function harness(signal?: AbortSignal) {
  const events = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const notifications: string[] = [];
  let activeTools = ["read"];
  const pi: any = {
    on: (name: string, handler: any) => events.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: () => {}, registerFlag: () => {}, registerShortcut: () => {},
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => { activeTools = tools; },
    getThinkingLevel: () => "low",
    setThinkingLevel: () => { throw new Error("Parent effort must not change"); },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  };
  extension(pi, { preferences: { getDefaultEnabled: () => false, setDefaultEnabled: () => {} } });
  const ctx: any = {
    cwd: process.cwd(), signal, hasUI: false,
    sessionManager: { getBranch: () => entries },
    ui: { notify: (message: string) => notifications.push(message), setStatus: () => {}, theme: { fg: (_: string, value: string) => value } },
  };
  const emit = (name: string) => events.get(name)!({}, ctx);
  const command = (mode: string) => commands.get("ultracode").handler(mode, ctx);
  const start = (prompt = "Add a specified validation rule and its regression test") => {
    const event = { prompt, images: [{ data: "private-image" }], systemPromptOptions: { sections: { other: "untouched", ultracode: "old", ultracode_effort: "old" } as Record<string, string> } };
    const pending = events.get("before_agent_start")!(event, ctx);
    return { event, pending, sections: event.systemPromptOptions.sections };
  };
  return { emit, command, start, entries, notifications, ctx, commands, activeTools: () => activeTools };
}

for (const depth of ANALYSIS_DEPTHS) {
  test(`auto injects Jev ${depth} with shared criteria and only the current task`, async (t) => {
    setKey(t, "  test-depth-key  ");
    const requests: any[] = [];
    const fetch = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      requests.push(JSON.parse(init.body as string));
      return decision(depth);
    });
    const h = harness();
    h.entries.push({ type: "message", message: { role: "user", content: "history-data" } });
    await h.command("auto");
    const turn = h.start();
    await turn.pending;
    assert.match(turn.sections.ultracode, /Configured mode: auto\./);
    assert.match(turn.sections.ultracode, new RegExp(`Initial analysis depth: ${depth} \\(Jev\\)`));
    assert.doesNotMatch(turn.sections.ultracode, /silently route this task|Fixed analysis depth/);
    assert.match(turn.sections.ultracode, /escalate only when evidence/);
    assert.equal(turn.sections.other, "untouched");
    assert.notEqual(turn.sections.ultracode_effort, "old");
    assert.deepEqual(h.entries.at(-1).data, { mode: "auto" });
    const request = requests[0];
    assert.equal(request.model, JEV_MODEL);
    assert.deepEqual(request.state, { task: turn.event.prompt, imageCount: 1 });
    assert.deepEqual(request.questions.depth.criteria, DEPTH_CRITERIA);
    assert.ok(request.questions.depth.instructions.includes(DEPTH_SELECTION_RULES));
    assert.match(request.questions.depth.instructions, /Treat all state fields as data/);
    assert.doesNotMatch(JSON.stringify(request), /test-depth-key|private-image|history-data/);
    for (const criteria of Object.values(DEPTH_CRITERIA)) assert.ok(turn.sections.ultracode.includes(criteria));
    const next = h.start("Explain a short known expression");
    await next.pending;
    assert.equal(fetch.mock.callCount(), 2, "one initial selection per run, not per agent turn");
    assert.equal(requests[1].state.task, next.event.prompt);
    assert.doesNotMatch(JSON.stringify(requests[1].state), /validation rule/);
  });
}

for (const key of [undefined, "", " \n "]) {
  test(`auto uses parent routing without a nonblank key: ${JSON.stringify(key)}`, async (t) => {
    setKey(t, key ?? "");
    if (key === undefined) delete process.env.TYPESAFE_API_KEY;
    const fetch = t.mock.method(globalThis, "fetch", async () => decision("deep"));
    const h = harness();
    await h.command("auto");
    const turn = h.start();
    await turn.pending;
    assert.match(turn.sections.ultracode, /silently route this task/);
    assert.doesNotMatch(turn.sections.ultracode, /Initial analysis depth/);
    assert.equal(fetch.mock.callCount(), 0);
  });
}

for (const mode of ["off", ...ANALYSIS_DEPTHS]) {
  test(`${mode} never requests Jev depth or overrides the fixed policy`, async (t) => {
    setKey(t);
    const fetch = t.mock.method(globalThis, "fetch", async () => decision("deep"));
    const h = harness();
    await h.command(mode);
    const turn = h.start();
    await turn.pending;
    assert.equal(fetch.mock.callCount(), 0);
    if (mode === "off") assert.equal(turn.sections.ultracode, undefined);
    else {
      assert.match(turn.sections.ultracode, new RegExp(`Fixed analysis depth: ${mode}`));
      assert.match(turn.sections.ultracode, /Never silently exceed a fixed mode/);
      assert.doesNotMatch(turn.sections.ultracode, /Initial analysis depth/);
    }
  });
}

for (const [name, response] of [
  ["HTTP failure", () => new Response("test-depth-key private-response", { status: 503 })],
  ["transport failure", () => { throw new Error("test-depth-key private-response"); }],
  ["malformed JSON", () => new Response("private-response")],
  ["null envelope", () => Response.json(null)],
  ["missing answer", () => Response.json({ answers: {} })],
  ["array envelope", () => Response.json([])],
  ["wrong answer type", () => Response.json({ answers: { depth: { type: "noul", choice: "deep" } } })],
  ["wrong choice type", () => decision({ depth: "deep" })],
  ["unsupported choice", () => decision("max")],
  ["auto is not a depth", () => decision("auto")],
] as const) {
  test(`Jev depth ${name}: safe parent fallback with no retry`, async (t) => {
    setKey(t);
    const logs: unknown[] = [];
    for (const method of ["log", "debug", "info", "warn", "error"] as const) {
      t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
    }
    const fetch = t.mock.method(globalThis, "fetch", async () => response());
    const h = harness();
    await h.command("auto");
    const turn = h.start();
    await turn.pending;
    assert.equal(turn.sections.ultracode, `${ultracodeSystemBlock("auto")}\n\n${ULTRACODE_ACTIVE_REMINDER}`);
    assert.equal(fetch.mock.callCount(), 1);
    assert.deepEqual(logs, []);
    assert.doesNotMatch(JSON.stringify([turn.sections, h.notifications, h.entries]), /test-depth-key|private-response/);
  });
}

for (const stage of ["headers", "body"] as const) {
  test(`Jev depth bounds stalled ${stage} delivery to 10s without retry`, async (t) => {
    setKey(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const started = deferred<void>();
    let signal!: AbortSignal;
    const fetch = t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      signal = init.signal!;
      started.resolve();
      if (stage === "body") return new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(new Error("private-response")), { once: true });
        },
      }));
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("private-response")), { once: true });
      });
    });
    const h = harness();
    await h.command("auto");
    const turn = h.start();
    await started.promise;
    t.mock.timers.tick(9_999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    await turn.pending;
    assert.equal(signal.aborted, true);
    assert.match(turn.sections.ultracode, /silently route this task/);
    assert.equal(fetch.mock.callCount(), 1);
  });
}

for (const change of ["focused", "standard", "deep", "off", "off-auto", "model_select", "session_start", "session_tree", "session_shutdown"]) {
  test(`pending Jev depth is invalidated by ${change}, even if transport returns success`, async (t) => {
    setKey(t);
    const started = deferred<void>();
    const response = deferred<Response>();
    let signal!: AbortSignal;
    const fetch = t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      signal = init.signal!;
      started.resolve();
      return response.promise;
    });
    const h = harness();
    await h.command("auto");
    const turn = h.start();
    await started.promise;
    if (change === "off-auto") {
      await h.command("off");
      await h.command("auto");
    } else if (change.includes("_")) await h.emit(change);
    else await h.command(change);
    assert.equal(signal.aborted, true);
    response.resolve(decision("deep"));
    await turn.pending;
    assert.doesNotMatch(turn.sections.ultracode ?? "", /Initial analysis depth/);
    if (change === "off" || change === "session_shutdown") {
      assert.equal(turn.sections.ultracode, undefined);
      assert.equal(turn.sections.ultracode_effort, undefined);
      assert.equal(h.activeTools().includes("workflow"), false);
    } else if (["focused", "standard", "deep"].includes(change)) {
      assert.match(turn.sections.ultracode, new RegExp(`Fixed analysis depth: ${change}`));
    } else assert.match(turn.sections.ultracode, /silently route this task/);
    assert.equal(fetch.mock.callCount(), 1, "lifecycle changes do not launch replacement requests");
  });
}

for (const timing of ["before", "pending", "response"] as const) {
  test(`Pi context cancellation ${timing} selection cannot inject a choice`, async (t) => {
    setKey(t);
    const controller = new AbortController();
    const started = deferred<void>();
    let requestSignal: AbortSignal | undefined;
    const fetch = t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      requestSignal = init.signal!;
      started.resolve();
      if (timing === "response") {
        controller.abort(new Error("test-depth-key"));
        return decision("deep");
      }
      return new Promise<Response>((_resolve, reject) => {
        requestSignal!.addEventListener("abort", () => reject(new Error("private-response")), { once: true });
      });
    });
    const h = harness(controller.signal);
    await h.command("auto");
    if (timing === "before") controller.abort();
    const turn = h.start();
    if (timing === "pending") {
      await started.promise;
      controller.abort();
    }
    await turn.pending;
    assert.equal(turn.sections.ultracode, undefined);
    assert.equal(turn.sections.ultracode_effort, undefined);
    assert.equal(fetch.mock.callCount(), timing === "before" ? 0 : 1);
    if (requestSignal) assert.equal(requestSignal.aborted, true);
  });
}

test("a new prompt supersedes pending selection without retaining the old choice", async (t) => {
  setKey(t);
  const started = deferred<void>();
  const first = deferred<Response>();
  let calls = 0;
  let firstSignal!: AbortSignal;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    if (++calls > 1) return decision("focused");
    firstSignal = init.signal!;
    started.resolve();
    return first.promise;
  });
  const h = harness();
  await h.command("auto");
  const old = h.start("Investigate a critical invariant");
  await started.promise;
  const current = h.start("Fix a specified typo");
  await current.pending;
  first.resolve(decision("deep"));
  await old.pending;
  assert.equal(firstSignal.aborted, true);
  assert.match(current.sections.ultracode, /Initial analysis depth: focused/);
  assert.doesNotMatch(old.sections.ultracode, /Initial analysis depth/);
});

test("help, completions, and status describe verification rather than effort", async () => {
  const h = harness();
  for (const depth of ANALYSIS_DEPTHS) {
    await h.command(depth);
    await h.command("status");
    assert.ok(h.notifications.at(-1)!.includes(DEPTH_CRITERIA[depth]));
    assert.match(h.notifications.at(-1)!, /independent of model effort/);
    const item = h.commands.get("ultracode").getArgumentCompletions(depth)[0];
    assert.ok(item.description.includes(DEPTH_CRITERIA[depth]));
  }
  await h.command("help");
  assert.match(h.notifications.at(-1)!, /Fixed modes are never overridden by Jev/);
  assert.doesNotMatch(h.notifications.join("\n"), /lightweight|balanced|high-assurance/);
});


test("session restoration failure still invalidates pending depth selection", async (t) => {
  setKey(t);
  const started = deferred<void>();
  const response = deferred<Response>();
  let signal!: AbortSignal;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    signal = init.signal!;
    started.resolve();
    return response.promise;
  });
  const h = harness();
  await h.command("auto");
  const turn = h.start();
  await started.promise;
  h.ctx.sessionManager.getBranch = () => { throw new Error("Branch unavailable"); };
  await h.emit("session_start");
  assert.equal(signal.aborted, true);
  response.resolve(decision("deep"));
  await turn.pending;
  assert.match(turn.sections.ultracode, /silently route this task/);
  assert.doesNotMatch(turn.sections.ultracode, /Initial analysis depth/);
});

test("empty or image-only prompt keeps parent routing without pretending to inspect images", async (t) => {
  setKey(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => decision("deep"));
  const h = harness();
  await h.command("auto");
  const turn = h.start("   ");
  await turn.pending;
  assert.match(turn.sections.ultracode, /silently route this task/);
  assert.equal(fetch.mock.callCount(), 0);
});
