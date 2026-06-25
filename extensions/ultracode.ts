/**
 * pi-ultracode extension entrypoint.
 *
 * Wires together the three pillars of Claude-Code-style "ultracode":
 *   1. The ultracode effort mode (xhigh thinking + standing workflow opt-in).
 *   2. The full `workflow` orchestration tool.
 *   3. The `/ultracode` and `/workflows` commands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkflowTool } from "../src/workflow/tool.ts";
import { UltracodeMode } from "../src/mode.ts";
import { registerCommands } from "../src/commands.ts";

export default function extension(pi: ExtensionAPI): void {
  const mode = new UltracodeMode("workflow");

  const workflowTool = createWorkflowTool({
    getDefaultBudget: () => mode.getBudget(),
  });
  pi.registerTool(workflowTool);

  registerCommands(pi, mode);

  // Opt-in via CLI flag: `pi --ultracode`.
  pi.registerFlag("ultracode", {
    type: "boolean",
    description: "Start the session in ultracode mode (xhigh thinking + default workflow orchestration).",
  });

  pi.on("session_start", (_event, ctx) => {
    // Restore persisted mode state across reload / resume / fork.
    try {
      mode.restore(pi, ctx.sessionManager.getEntries() as any);
    } catch {
      // ignore
    }
    if (!mode.isEnabled() && pi.getFlag?.("ultracode") === true) {
      mode.enable(pi);
    }
    // Always keep the workflow tool available so the model can use it on request.
    try {
      const active = pi.getActiveTools();
      if (!active.includes(workflowTool.name)) pi.setActiveTools([...active, workflowTool.name]);
    } catch {
      // ignore
    }
    if (ctx.hasUI && mode.isEnabled()) ctx.ui.setStatus("ultracode", mode.statusLine());
  });

  pi.on("before_agent_start", (event) => {
    return mode.beforeAgentStart(event);
  });
}
