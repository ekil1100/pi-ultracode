/**
 * Slash commands: `/ultracode` (mode toggle) and `/workflows` (run manager).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseBudget, type UltracodeMode } from "./mode.ts";
import { getRegistry } from "./workflow/registry.ts";
import { renderWorkflowLines } from "./workflow/display.ts";
import { truncateDisplay } from "./workflow/display-text.ts";

export function registerCommands(pi: ExtensionAPI, mode: UltracodeMode): void {
  pi.registerCommand("ultracode", {
    description: "Toggle ultracode mode (max thinking + default workflow orchestration). Bare /ultracode toggles; subcommands: on|off|status|budget <n>",
    getArgumentCompletions(prefix: string) {
      return ["on", "off", "status", "budget"]
        .filter((s) => s.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args: string, ctx) => {
      mode.setCurrentModelSupportsThinking(ctx.model ? Boolean(ctx.model.reasoning) : undefined);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "").toLowerCase();

      // Bare `/ultracode` is a toggle.
      if (sub === "") {
        const nowOn = mode.toggle(pi);
        await mode.flushThinkingPreference();
        ctx.ui.notify(
          nowOn ? `Ultracode on — ${mode.statusLine()}` : "Ultracode off — thinking restored and workflow tool disabled.",
          "info",
        );
        ctx.ui.setStatus("ultracode", nowOn ? mode.statusLine() : undefined);
        return;
      }

      if (sub === "status") {
        ctx.ui.notify(mode.statusLine(), "info");
        return;
      }

      if (sub === "off") {
        mode.disable(pi);
        await mode.flushThinkingPreference();
        ctx.ui.notify("Ultracode off — thinking restored and workflow tool disabled.", "info");
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
      await mode.flushThinkingPreference();
      ctx.ui.notify(
        `Ultracode on — ${mode.statusLine()}${budget ? ` (budget ~${budget} tokens)` : ""}`,
        "info",
      );
      ctx.ui.setStatus("ultracode", mode.statusLine());
    },
  });

  // Tracks whether the run panel is currently shown, so bare /workflows toggles it.
  let panelVisible = false;

  pi.registerCommand("workflows", {
    description: "Toggle the workflow-run panel. Usage: /workflows [runId | clear | abort]",
    getArgumentCompletions(prefix: string) {
      return ["clear", "abort"]
        .filter((s) => s.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args: string, ctx) => {
      const registry = getRegistry();
      const arg = args.trim();
      const sub = arg.toLowerCase();

      const hide = () => {
        ctx.ui.setWidget("ultracode-workflows", undefined);
        panelVisible = false;
      };
      const show = (lines: string[]) => {
        ctx.ui.setWidget("ultracode-workflows", lines);
        panelVisible = true;
      };

      if (sub === "clear" || sub === "hide" || sub === "off") {
        hide();
        ctx.ui.notify("Workflow panel hidden.", "info");
        return;
      }

      if (sub === "abort") {
        registry.abortAll();
        hide();
        ctx.ui.notify("Requested abort of all active workflow runs; panel hidden.", "info");
        return;
      }

      const runs = registry.list();

      // Explicit run id -> show that run's detail.
      if (arg) {
        const handle = registry.get(arg) ?? runs.find((r) => r.snapshot.runId?.startsWith(arg));
        if (!handle) {
          ctx.ui.notify(`No workflow run matching "${truncateDisplay(arg, 80)}". /workflows to list, /workflows clear to hide.`, "warning");
          return;
        }
        show(renderWorkflowLines(handle.snapshot, { maxAgents: 12, maxLogs: 6, showResultPreviews: true }));
        ctx.ui.notify(`Showing ${truncateDisplay(handle.snapshot.runId ?? "run", 128)}. /workflows clear to hide.`, "info");
        return;
      }

      // Bare /workflows toggles the panel off if it's already up.
      if (panelVisible) {
        hide();
        ctx.ui.notify("Workflow panel hidden.", "info");
        return;
      }

      if (runs.length === 0) {
        hide();
        ctx.ui.notify("No workflow runs in this session yet.", "info");
        return;
      }

      const summary = runs.map((handle) => {
        const s = handle.snapshot;
        return `${statusGlyph(s.status)} ${truncateDisplay(s.runId ?? "run", 128)}  ${truncateDisplay(s.name, 80)}  ${s.doneCount}/${s.agentCount}${
          s.runningCount ? ` (${s.runningCount} running)` : ""
        }`;
      });
      show(["◆ Ultracode workflow runs  ·  /workflows clear to hide", ...summary.map((l) => `  ${l}`)]);
      ctx.ui.notify(
        `${runs.length} run(s), ${registry.active().length} active. /workflows again (or /workflows clear) to hide.`,
        "info",
      );
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
