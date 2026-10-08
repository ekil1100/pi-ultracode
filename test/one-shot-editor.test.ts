import { describe, expect, test } from "vite-plus/test";
import {
  highlightOneShot,
  highlightingEditor,
  registerOneShotEditor,
} from "../src/one-shot-editor.ts";

const C = (s: string) => `\x1b[38;2;175;135;255m${s}\x1b[39m`;
const hl = (text: string) => highlightOneShot(text.split("\n"), text);

describe("one-shot editor highlight", () => {
  test("colors every marker that counts, with its selector", () => {
    expect(hl(":ult: review")).toEqual([`${C(":ult:")} review`]);
    expect(hl(":ult with luna , :ult: with luna, x")).toEqual([
      `${C(":ult with luna")} , ${C(":ult: with luna")}, x`,
    ]);
    expect(hl(":ult review with luna")).toEqual([`${C(":ult")} review with luna`]);
    expect(hl(":ult a\n:ult b")).toEqual([`${C(":ult")} a`, `${C(":ult")} b`]);
  });

  test("skips quoted markers and text that does not trigger", () => {
    expect(hl("the `:ult` form, then :ult go")).toEqual([
      `the \`:ult\` form, then ${C(":ult")} go`,
    ]);
    for (const text of [
      "mention `:ult:` later",
      "/ult review",
      ":ultra review",
      ":ultracode x",
      "a:ult x",
    ])
      expect(hl(text)).toEqual([text]);
  });

  test("keeps the editor cursor and border lines intact", () => {
    const cursor = "\x1b_pi:c\x07\x1b[7m \x1b[0m";
    expect(highlightOneShot(["────", `go :ult${cursor}`, "────"], "go :ult")).toEqual([
      "────",
      `go ${C(":ult")}${cursor}`,
      "────",
    ]);
  });

  test("is idempotent when two highlighters wrap the same editor", () => {
    const once = hl("fix :ult with luna");
    expect(highlightOneShot(once, "fix :ult with luna")).toEqual(once);
  });

  test("wraps an existing editor factory instead of replacing it", () => {
    const inner = () => ({ render: () => [":ult go"], getText: () => ":ult go" }) as any;
    const editor = highlightingEditor(inner)({} as any, {} as any, {} as any);
    expect(editor.render(80)).toEqual([`${C(":ult")} go`]);
  });

  test("installs once, only in the TUI", async () => {
    const handlers: Function[] = [];
    let factory: any;
    const ctx: any = {
      mode: "tui",
      ui: {
        getEditorComponent: () => factory,
        setEditorComponent: (f: any) => {
          factory = f;
        },
      },
    };
    registerOneShotEditor({
      on: (_name: string, handler: Function) => handlers.push(handler),
    } as any);
    await handlers[0]({}, { ...ctx, mode: "print" });
    expect(factory).toBeUndefined();
    await handlers[0]({}, ctx);
    const first = factory;
    expect(first).toBeTypeOf("function");
    await handlers[0]({}, ctx);
    expect(factory).toBe(first);
  });
});
