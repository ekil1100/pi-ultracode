import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflowScript, normalizeScript } from "../src/workflow/parser.ts";

test("parses a minimal valid workflow", () => {
  const { meta, body } = parseWorkflowScript(
    `export const meta = { name: 'demo', description: 'a demo' }\nawait agent('hi')`,
  );
  assert.equal(meta.name, "demo");
  assert.equal(meta.description, "a demo");
  assert.match(body, /agent\('hi'\)/);
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

test("rejects empty meta.name", () => {
  assert.throws(
    () => parseWorkflowScript(`export const meta = { name: '', description: 'x' }\nagent('a')`),
    /meta.name/,
  );
});
