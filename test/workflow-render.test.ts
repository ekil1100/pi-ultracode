import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createSnapshot } from "../src/workflow/display.ts";

initTheme("dark", false);
import { createWorkflowTool } from "../src/workflow/tool.ts";
import { DISPLAY_INPUT_LIMIT } from "../src/workflow/display-text.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const tool = createWorkflowTool();
function render(args: Parameters<NonNullable<typeof tool.renderCall>>[0], argsComplete = false): string {
  const context = { args, argsComplete, expanded: false } as Parameters<NonNullable<typeof tool.renderCall>>[2];
  return tool.renderCall!(args, theme, context).render(120).map((line) => stripAnsi(line).trimEnd()).join("\n");
}

test("workflow renders script arguments as they stream, including incomplete JavaScript", () => {
  assert.equal(render({}), "workflow");
  for (const script of ["export const meta = {", "export const meta = { name: 'demo' };\nawait agent('Check"]) {
    const text = render({ script });
    assert.ok(text.includes(script), `Missing streamed script: ${text}`);
  }
});

test("workflow renders completed source and file or saved workflow references", () => {
  const script = "export const meta = { name: 'demo', description: 'Demo' };\nawait agent('Check');";
  assert.ok(render({ script }, true).includes(script));
  assert.match(render({ scriptPath: "examples/demo.js" }), /examples\/demo\.js/);
  assert.match(render({ name: "saved_demo" }), /saved_demo/);
});

test("workflow separates highlighted source from partial and final status", () => {
  const script = "export const meta = { name: 'demo', description: 'Demo' };\nawait agent('Check');";
  const args = { script };
  const context = { args, argsComplete: true, expanded: false } as Parameters<NonNullable<typeof tool.renderCall>>[2];
  const call = tool.renderCall!(args, theme, context);
  assert.match(render(args, true), /^workflow\n\nScript · JavaScript\n/);
  assert.match(call.render(120).join("\n"), /\u001b\[/);
  const snapshot = createSnapshot({ name: "demo", description: "Demo" }, "test-run");
  for (const isPartial of [true, false]) {
    const result = tool.renderResult!(
      { content: [], details: snapshot }, { isPartial, expanded: false }, theme,
      {} as Parameters<NonNullable<typeof tool.renderResult>>[3],
    );
    assert.match(result.render(120).map(stripAnsi).join("\n"), /^\s*\nStatus\s*\n/);
    for (const width of [24, 80, 120]) {
      for (const line of [...call.render(width), ...result.render(width)]) {
        assert.ok(visibleWidth(line) <= width);
      }
    }
  }
});

test("workflow source display redacts complete and streaming credentials", () => {
  for (const prefix of [
    'await agent(`curl -H "Authorization: Bearer ',
    'await agent(`API_KEY=',
    'await agent(`curl https://example.com/?token=',
  ]) {
    const secret = "demo-private-token";
    for (let length = 1; length <= secret.length; length++) {
      const fragment = secret.slice(0, length);
      assert.equal(render({ script: prefix + fragment }), render({ script: prefix + "***" }));
    }
    assert.ok(!render({ script: prefix + secret + '"`);' }, true).includes(secret));
  }
});

test("workflow source display strips terminal controls and bounds oversized input", () => {
  assert.equal(render({ script: "\u001b[2Jawait agent('Check');" }), "workflow\n\nScript · JavaScript\nawait agent('Check');");
  const text = render({ script: "x".repeat(DISPLAY_INPUT_LIMIT + 1000) });
  assert.ok(text.endsWith("…"));
  assert.ok(text.length < DISPLAY_INPUT_LIMIT + 500);
});
