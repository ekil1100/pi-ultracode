/** Colors one-shot markers in the prompt editor as the user types. */
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { findOneShotMarkers, ONE_SHOT_SELECTOR, ONE_SHOT_TOKEN } from "./one-shot.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

// A light purple (#af87ff) that stands apart from the default editor text.
const paint = (text: string) => `\x1b[38;2;175;135;255m${text}\x1b[39m`;
const HIGHLIGHTS = Symbol.for("pi-ultracode.one-shot-highlight");

/**
 * Colors every marker that counts, with its `with <model>` selector, in the
 * editor's rendered lines. Markers are matched by their index among all marker
 * tokens, so quoted ones stay plain; a cursor inside a marker leaves it plain
 * until the cursor moves past. Already colored markers are not matched again.
 */
export function highlightOneShot(lines: string[], text: string): string[] {
  const live = new Map(findOneShotMarkers(text).map((m) => [m.nth, !!m.model]));
  if (!live.size) return lines;
  let seen = 0;
  return lines.map((line) => {
    const { out, at } = [...line.matchAll(ONE_SHOT_TOKEN)].reduce(
      (acc, m) => {
        const hasModel = live.get(seen++);
        if (hasModel === undefined || m.index < acc.at) return acc;
        const sel = hasModel ? ONE_SHOT_SELECTOR.exec(line.slice(m.index + m[0].length)) : null;
        const span = m[0] + (sel?.[0] ?? "");
        return {
          out: acc.out + line.slice(acc.at, m.index) + paint(span),
          at: m.index + span.length,
        };
      },
      { out: "", at: 0 },
    );
    return out + line.slice(at);
  });
}

/** Wraps the current editor, or Pi's default one, so other editor extensions keep working. */
export function highlightingEditor(inner: EditorFactory | undefined): EditorFactory {
  const factory: EditorFactory = (tui, theme, keybindings) => {
    // Pi's own default editor embeds the working status; keep that when we create it.
    const editor = inner
      ? inner(tui, theme, keybindings)
      : new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
    const render = editor.render.bind(editor);
    editor.render = (width) => highlightOneShot(render(width), editor.getText());
    return editor;
  };
  return Object.assign(factory, { [HIGHLIGHTS]: true });
}

export function registerOneShotEditor(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const current = ctx.ui.getEditorComponent();
    if (current && HIGHLIGHTS in current) return;
    ctx.ui.setEditorComponent(highlightingEditor(current));
  });
}
