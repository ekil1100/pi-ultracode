/**
 * Slash commands: `/ultracode` (mode toggle) and `/workflows` (run manager).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ACTIVE_ULTRACODE_MODES, isActiveUltracodeMode } from "./depth.ts";
import type { UltracodeMode } from "./mode.ts";
import type { WorkflowRegistry } from "./workflow/registry.ts";
import { workflowRunsDir } from "./workflow/tool.ts";
import { openWorkflowOverlay } from "./workflow/workflow-overlay.ts";

export function registerCommands(pi: ExtensionAPI, mode: UltracodeMode, registry: WorkflowRegistry): void {
  pi.registerCommand("ultracode", {
    description: "Toggle adaptive Ultracode, or select a fixed semantic depth: auto|focused|standard|deep|off|status",
    getArgumentCompletions(prefix: string) {
      return [...ACTIVE_ULTRACODE_MODES, "off", "status"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args: string, ctx) => {
      mode.setCurrentModelSupportsThinking(ctx.model ? Boolean(ctx.model.reasoning) : undefined);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "").toLowerCase();

      // Bare `/ultracode` enables auto from off and disables any active mode.
      if (sub === "") {
        const nowOn = mode.toggle(pi);
        await mode.flushThinkingPreference();
        ctx.ui.notify(
          nowOn
            ? `Ultracode auto — ${mode.statusLine()}`
            : "Ultracode off — thinking restored and workflow tool disabled.",
          "info",
        );
        ctx.ui.setStatus("ultracode", nowOn ? mode.statusLine() : undefined);
        return;
      }

      if (parts.length > 1) {
        ctx.ui.notify(ultracodeUsage(), "error");
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

      if (!isActiveUltracodeMode(sub)) {
        ctx.ui.notify(ultracodeUsage(), "error");
        return;
      }

      mode.enable(pi, sub);
      await mode.flushThinkingPreference();
      ctx.ui.notify(`Ultracode ${sub} — ${mode.statusLine()}`, "info");
      ctx.ui.setStatus("ultracode", mode.statusLine());
    },
  });

  const openWorkflows = async (ctx: any, runId?: string) => {
    registry.restoreRuns(workflowRunsDir(ctx));
    await openWorkflowOverlay(ctx, registry, runId);
  };

  pi.registerCommand("workflows", {
    description: "Open the interactive workflow/task detail overlay. Usage: /workflows [runId | abort]",
    getArgumentCompletions(prefix: string) {
      const values = [
        "abort",
        ...registry.list().map((handle) => handle.snapshot.runId).filter((runId): runId is string => Boolean(runId)),
      ];
      return [...new Set(values)]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args: string, ctx) => {
      const arg = args.trim();
      if (arg.toLowerCase() === "abort") {
        registry.abortAll();
        ctx.ui.notify("Requested abort of all active workflow runs.", "warning");
        return;
      }
      await openWorkflows(ctx, arg || undefined);
    },
  });

  pi.registerShortcut("f6", {
    description: "Open workflow task details",
    handler: async (ctx) => openWorkflows(ctx),
  });
}

function ultracodeUsage(): string {
  return "Usage: /ultracode [auto|focused|standard|deep|off|status]";
}
