/**
 * Slash commands: `/ultracode` (mode toggle) and `/workflows` (run manager).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseBudget, type UltracodeMode } from "./mode.ts";
import { getRegistry } from "./workflow/registry.ts";
import { renderWorkflowLines } from "./workflow/display.ts";

export function registerCommands(pi: ExtensionAPI, mode: UltracodeMode): void {
  pi.registerCommand("ultracode", {
    description: "Toggle ultracode mode (xhigh thinking + default workflow orchestration). Bare /ultracode toggles; subcommands: on|off|status|budget <n>",
    getArgumentCompletions(prefix: string) {
      return ["on", "off", "status", "budget"]
        .filter((s) => s.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args: string, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "").toLowerCase();

      // Bare `/ultracode` is a toggle.
      if (sub === "") {
        const nowOn = mode.toggle(pi);
        ctx.ui.notify(nowOn ? `Ultracode on — ${mode.statusLine()}` : "Ultracode off — thinking restored.", "info");
        ctx.ui.setStatus("ultracode", nowOn ? mode.statusLine() : undefined);
        return;
      }

      if (sub === "status") {
        ctx.ui.notify(mode.statusLine(), "info");
        return;
      }

      if (sub === "off") {
        mode.disable(pi);
        ctx.ui.notify("Ultracode off — thinking restored, workflow orchestration is opt-in again.", "info");
        ctx.ui.setStatus("ultracode", undefined);
        return;
      }

      if (sub === "budget") {
        const budget = parts[1] ? parseBudget(parts[1]) : null;
        mode.setBudget(pi, budget);
        ctx.ui.notify(
          budget ? `Ultracode token budget set to ~${budget} output tokens.` : "Ultracode token budget cleared.",
          "info",
        );
        ctx.ui.setStatus("ultracode", mode.statusLine());
        return;
      }

      // "on", "on 500k", "500k", "+500k"
      let budget: number | null | undefined;
      const budgetToken = sub === "on" ? parts[1] : sub;
      if (budgetToken) {
        const parsed = parseBudget(budgetToken);
        if (parsed) budget = parsed;
      }
      mode.enable(pi, budget !== undefined ? { budget } : {});
      ctx.ui.notify(
        `Ultracode on — ${mode.statusLine()}${budget ? ` (budget ~${budget} tokens)` : ""}`,
        "info",
      );
      ctx.ui.setStatus("ultracode", mode.statusLine());
    },
  });

  pi.registerCommand("workflows", {
    description: "Show recent and in-flight workflow runs. Usage: /workflows [runId|abort]",
    handler: async (args: string, ctx) => {
      const registry = getRegistry();
      const arg = args.trim();

      if (arg === "abort") {
        registry.abortAll();
        ctx.ui.notify("Requested abort of all active workflow runs.", "info");
        return;
      }

      const runs = registry.list();
      if (runs.length === 0) {
        ctx.ui.notify("No workflow runs in this session yet.", "info");
        ctx.ui.setWidget("ultracode-workflows", undefined);
        return;
      }

      if (arg) {
        const handle = registry.get(arg) ?? runs.find((r) => r.snapshot.runId?.startsWith(arg));
        if (!handle) {
          ctx.ui.notify(`No workflow run matching "${arg}".`, "warn");
          return;
        }
        const lines = renderWorkflowLines(handle.snapshot, { maxAgents: 12, maxLogs: 6, showResultPreviews: true });
        ctx.ui.setWidget("ultracode-workflows", lines);
        ctx.ui.notify(lines[0] ?? "workflow", "info");
        return;
      }

      const summary = runs.map((handle) => {
        const s = handle.snapshot;
        return `${statusGlyph(s.status)} ${s.runId}  ${s.name}  ${s.doneCount}/${s.agentCount}${
          s.runningCount ? ` (${s.runningCount} running)` : ""
        }`;
      });
      ctx.ui.setWidget("ultracode-workflows", ["◆ Ultracode workflow runs", ...summary.map((l) => `  ${l}`)]);
      ctx.ui.notify(`${runs.length} workflow run(s). ${registry.active().length} active. See the widget above the editor.`, "info");
    },
  });
}

function statusGlyph(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "running":
      return "▶";
    case "aborted":
      return "■";
    case "failed":
      return "✗";
    default:
      return "·";
  }
}
