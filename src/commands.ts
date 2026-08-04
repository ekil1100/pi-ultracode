/**
 * Slash commands: `/ultracode` (mode toggle) and `/workflows` (run manager).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { UltracodeMode } from "./mode.ts";
import { getRegistry } from "./workflow/registry.ts";
import { workflowRunsDir } from "./workflow/tool.ts";
import { openWorkflowOverlay } from "./workflow/workflow-overlay.ts";

export function registerCommands(pi: ExtensionAPI, mode: UltracodeMode): void {
  pi.registerCommand("ultracode", {
    description: "Toggle ultracode mode (max thinking + default workflow orchestration). Bare /ultracode toggles; subcommands: on|off|status",
    getArgumentCompletions(prefix: string) {
      return ["on", "off", "status"]
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
        if (parts.length > 1) {
          ctx.ui.notify(ultracodeUsage(), "error");
          return;
        }
        ctx.ui.notify(mode.statusLine(), "info");
        return;
      }

      if (sub === "off") {
        if (parts.length > 1) {
          ctx.ui.notify(ultracodeUsage(), "error");
          return;
        }
        mode.disable(pi);
        await mode.flushThinkingPreference();
        ctx.ui.notify("Ultracode off — thinking restored and workflow tool disabled.", "info");
        ctx.ui.setStatus("ultracode", undefined);
        return;
      }

      if (sub !== "on" || parts.length > 1) {
        ctx.ui.notify(ultracodeUsage(), "error");
        return;
      }

      mode.enable(pi);
      await mode.flushThinkingPreference();
      ctx.ui.notify(`Ultracode on — ${mode.statusLine()}`, "info");
      ctx.ui.setStatus("ultracode", mode.statusLine());
    },
  });

  const openWorkflows = async (ctx: any, runId?: string) => {
    const registry = getRegistry();
    registry.restoreRuns(workflowRunsDir(ctx));
    await openWorkflowOverlay(ctx, registry, runId);
  };

  pi.registerCommand("workflows", {
    description: "Open the interactive workflow/task detail overlay. Usage: /workflows [runId | abort]",
    getArgumentCompletions(prefix: string) {
      const values = [
        "abort",
        ...getRegistry().list().map((handle) => handle.snapshot.runId).filter((runId): runId is string => Boolean(runId)),
      ];
      return [...new Set(values)]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args: string, ctx) => {
      const arg = args.trim();
      if (arg.toLowerCase() === "abort") {
        getRegistry().abortAll();
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
  return "Usage: /ultracode [on|off|status]";
}
