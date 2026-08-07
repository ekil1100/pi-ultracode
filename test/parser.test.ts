import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflowScript, normalizeScript } from "../src/workflow/parser.ts";

test("parses a minimal valid workflow", () => {
  const { meta, body } = parseWorkflowScript(
    `export const meta = { name: 'demo', description: 'a demo' }\nawait agent('hi')`,
  );
  assert.equal(meta.name, "demo");
  assert.equal(meta.description, "a demo");
  assert.match(body, /__ultracodeAgent\("agent:[a-z0-9]+",'hi'\)/);
  assert.doesNotMatch(body, /export const meta/);
});

test("parses meta.phases array of literals", () => {
  const { meta } = parseWorkflowScript(
    `export const meta = { name: 'd', description: 'x', phases: [{ title: 'Scan' }, { title: 'Verify' }] }\nagent('a')`,
  );
  assert.deepEqual(meta.phases?.map((p) => p.title), ["Scan", "Verify"]);
});

test("strips a markdown fence", () => {
  const fenced = "```js\nexport const meta = { name: 'd', description: 'x' }\nagent('a')\n```";
  assert.match(normalizeScript(fenced), /^export const meta/);
  const { meta } = parseWorkflowScript(fenced);
  assert.equal(meta.name, "d");
});

test("rejects when meta is not the first statement", () => {
  assert.throws(
    () => parseWorkflowScript(`const x = 1\nexport const meta = { name: 'd', description: 'x' }`),
    /must be the first statement/,
  );
});

test("rejects Date.now()", () => {
  assert.throws(
    () => parseWorkflowScript(`export const meta = { name: 'd', description: 'x' }\nconst t = Date.now()`),
    /deterministic/,
  );
});

test("rejects Math.random()", () => {
  assert.throws(
    () => parseWorkflowScript(`export const meta = { name: 'd', description: 'x' }\nMath.random()`),
    /deterministic/,
  );
});

test("rejects new Date()", () => {
  assert.throws(
    () => parseWorkflowScript(`export const meta = { name: 'd', description: 'x' }\nnew Date()`),
    /deterministic/,
  );
});

test("rejects computed/function-call values in meta", () => {
  assert.throws(
    () => parseWorkflowScript(`export const meta = { name: 'd', description: foo() }\nagent('a')`),
    /non-literal/,
  );
});

test("rejects spread in meta", () => {
  assert.throws(
    () => parseWorkflowScript(`export const meta = { ...base, name: 'd', description: 'x' }\nagent('a')`),
    /spread/,
  );
});

test("rejects native promise chains and combinators", () => {
  for (const body of [
    "agent('x').then(() => 1)",
    "agent('x')['catch'](() => null)",
    "agent('x').finally(() => {})",
    "Promise.all([agent('x')])",
    "Promise['allSettled']([])",
    "globalThis['Promise'].race([])",
    "const P = Promise; P.any([])",
  ]) {
    assert.throws(
      () => parseWorkflowScript(`export const meta = { name: 'promise_policy', description: 'x' }\n${body}`),
      /promise|await|parallel|pipeline/i,
      body,
    );
  }
});

test("rejects dynamic and aliased promise method access", () => {
  for (const body of [
    "const key = 'then'; return agent('x')[key]((value) => value)",
    "const method = agent('x').then; return method((value) => value)",
    "const { catch: recover } = agent('x'); return recover(() => null)",
    "const key = 'then'; const pending = agent('x'); return Reflect.apply(pending[key], pending, [(value) => value])",
    "const key = 'then'; const box = [agent('x')]; const pending = box[0]; return Reflect.apply(pending[key], pending, [(value) => value])",
    "const identity = (value) => value; const pending = identity(agent('x')); const key = 'then'; return Reflect.apply(pending[key], pending, [(value) => value])",
    "const hide = (value) => ({ value }); const box = hide(agent('x')); const key = 'then'; return Reflect.apply(box.value[key], box.value, [(value) => value])",
    "class Box { constructor(value) { this.value = value } }; const box = new Box(agent('x')); const key = args.key; return Reflect.apply(box.value[key], box.value, [(value) => value])",
    "const box = [...[agent('x')]]; const key = args.key; return Reflect.apply(box[0][key], box[0], [(value) => value])",
    "const box = {}; box.value = agent('x'); const key = args.key; return Reflect.apply(box.value[key], box.value, [(value) => value])",
    "const spawn = agent; return await spawn('x')",
    "const make = () => agent('x'); const pending = make(); const key = 'then'; return Reflect.apply(pending[key], pending, [(value) => value])",
    "function make() { return agent('x') }; const pending = make(); const key = 'then'; return Reflect.apply(pending[key], pending, [(value) => value])",
    "const box = { make() { return agent('x') } }; const pending = box.make(); const key = 'then'; return Reflect.apply(pending[key], pending, [(value) => value])",
    "const box = { nested: { make() { return agent('x') } } }; const pending = box.nested.make(); const key = 'then'; return Reflect.apply(pending[key], pending, [(value) => value])",
    "const nested = { make() { return agent('x') } }; const box = { nested }; const pending = box.nested.make(); const key = 'then'; return Reflect.apply(pending[key], pending, [(value) => value])",
    "const box = { make() { return agent('x') } }; const invoke = box.make; const pending = invoke(); const key = 'then'; return Reflect.apply(pending[key], pending, [(value) => value])",
    "class Box { make() { return agent('x') } }; const pending = new Box().make(); const key = 'then'; return Reflect.apply(pending[key], pending, [(value) => value])",
    "const makeFactory = () => () => agent('x'); const pending = makeFactory()(); const key = 'then'; return Reflect.apply(pending[key], pending, [(value) => value])",
    "return await globalThis.agent('x')",
    "function unwrap(_strings, pending) { const key = 'then'; return Reflect.apply(pending[key], pending, [(value) => value]) }; return await unwrap`${agent('x')}`",
  ]) {
    assert.throws(
      () => parseWorkflowScript(`export const meta = { name: 'dynamic_chain', description: 'x' }\n${body}`),
      /promise|dynamic method|await|globalThis|call sites|helper|declared identifier/i,
      body,
    );
  }
  assert.doesNotThrow(() => parseWorkflowScript(
    `export const meta = { name: 'dynamic_data', description: 'x' }
     const key = 'value'
     return args[key]`,
  ));
});

test("unsupported orchestration helper receivers and aliases fail closed", () => {
  const scripts = [
    "function make() { return { run() { return agent('x') } } }; return await make().run()",
    "class Helpers { run() { return agent('x') } }; return await new Helpers().run()",
    "function run() { return agent('x') }; const alias = run; return await alias()",
    "const helpers = { spawn() { return agent('x') }, forward() { return this.spawn() } }; return await helpers.forward()",
    "const helpers = { nested: {} }; helpers.nested.run = async () => await agent('x'); return await helpers.nested.run()",
    "let run; run = () => agent('x'); return await run()",
    "const helper = args.pick ? { run() { return agent('x') } } : { run() { return agent('x') } }; return await helper.run()",
    "const Helper = args.pick ? class { run() { return agent('x') } } : class { run() { return agent('x') } }; return await new Helper().run()",
    "const inner = { run() { return agent('x') } }; const identity = (value) => value; const alias = identity(inner); return await alias.run()",
    "const inner = { run() { return agent('x') } }; const aliases = [inner]; return await aliases[0].run()",
    "const inner = { run() { return agent('x') } }; const helpers = { get nested() { return inner } }; return await helpers.nested.run()",
    "async function make() { return { run() { return agent('x') } } }; return await (await make()).run()",
    "const helpers = { _inner: { run() { return agent('x') } }, get inner() { return this._inner } }; return await helpers.inner.run()",
    "const key = args.key; const helpers = { [key]() { return agent('x') } }; return await helpers.run()",
    "for (let index = 0; index < 1; index++, await agent('x')) {} return null",
    "while (await agent('x')) { break } return null",
    "class Helper { constructor() { agent('x') } }; const helper = new Helper(); return null",
    "class Helper { pending = agent('x') }; const helper = new Helper(); return null",
  ];
  for (const body of scripts) {
    assert.throws(
      () => parseWorkflowScript(`export const meta = { name: 'unsupported_helper', description: 'x' }\n${body}`),
      /helper|orchestration|loop|classes|dynamic method|promise checks|declared identifier|assigned/i,
    );
  }
});

test("factory objects retain ordinary data-property access", () => {
  const parsed = parseWorkflowScript(`export const meta = { name: 'factory_data', description: 'x' }
    const helpers = { spawn() { return agent('unused') }, value: 1 }
    log(helpers.value)
    return helpers.value`);
  assert.match(parsed.body, /helpers\.value/);
});

test("large alias chains are rejected without a quadratic taint scan", () => {
  const aliases = ["const value0 = agent"];
  for (let index = 1; index < 4_000; index++) aliases.push(`const value${index} = value${index - 1}`);
  const started = performance.now();
  assert.throws(
    () => parseWorkflowScript(
      `export const meta = { name: 'alias_chain', description: 'x' }\n${aliases.join("\n")}\nreturn null`,
    ),
    /dynamic method|called directly|promise checks/i,
  );
  assert.ok(performance.now() - started < 2_000, "taint propagation should stay bounded on long alias chains");
});

test("allows directly awaited local promise construction and resolution", () => {
  assert.doesNotThrow(() => parseWorkflowScript(
    `export const meta = { name: 'local_promise', description: 'x' }
     await Promise.resolve(1)
     await new Promise(() => {})`,
  ));
});

test("rejects excessive workflow AST nesting", () => {
  const nested = `${"[".repeat(160)}0${"]".repeat(160)}`;
  assert.throws(
    () => parseWorkflowScript(`export const meta = { name: 'deep', description: 'x' }\nreturn ${nested}`),
    /nesting depth|too deeply nested/i,
  );
});

test("rejects empty meta.name", () => {
  assert.throws(
    () => parseWorkflowScript(`export const meta = { name: '', description: 'x' }\nagent('a')`),
    /meta.name/,
  );
});
