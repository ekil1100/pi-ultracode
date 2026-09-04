/**
 * pi-ultracode extension entrypoint.
 *
 * Wires together Ultracode's semantic analysis-depth modes, deterministic
 * workflow orchestration, and the `/ultracode` / `/workflows` commands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkflowTool, type WorkflowToolDeps } from "../src/workflow/tool.ts";
import { UltracodeMode, type ThinkingPreferenceStore } from "../src/mode.ts";
import { registerCommands } from "../src/commands.ts";
import { WorkflowRegistry } from "../src/workflow/registry.ts";

export interface ThinkingPreferenceContext {
  cwd: string;
  projectTrusted: boolean;
}

export interface UltracodeExtensionDeps extends Partial<WorkflowToolDeps> {
  /** @deprecated Parent effort is user-owned; retained for source compatibility. */
  createThinkingPreferenceStore?: (
    context: ThinkingPreferenceContext,
  ) => ThinkingPreferenceStore | undefined;
}

export default function extension(pi: ExtensionAPI, extraDeps: UltracodeExtensionDeps = {}): void {
  const mode = new UltracodeMode("workflow");
  const {
    createThinkingPreferenceStore: _unusedThinkingPreferenceStore,
    ...workflowDeps
  } = extraDeps;

  const registry = workflowDeps.registry ?? new WorkflowRegistry();
  const workflowTool = createWorkflowTool({
    ...workflowDeps,
    registry,
    isExecutionAllowed: () => mode.isEnforcing(),
  });
  pi.registerTool(workflowTool);

  registerCommands(pi, mode, registry);

  // Opt-in via CLI flag: `pi --ultracode`.
  pi.registerFlag("ultracode", {
    type: "boolean",
    description: "Start the session in adaptive Ultracode mode.",
  });

  // SDK-created sessions can prompt without emitting session_start. Sync during
  // input preflight so before_agent_start receives Pi's rebuilt base prompt.
  pi.on("input", () => {
    mode.syncWorkflowTool(pi);
  });

  // Fail closed if another active-tool writer re-exposes workflow while the
  // mode is off or quiescing.
  pi.on("tool_call", (event) => {
    if (event.toolName === workflowTool.name && !mode.isEnforcing()) {
      return {
        block: true,
        reason: "The workflow tool is disabled. Run /ultracode or select an Ultracode depth before using it.",
      };
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    // Restore persisted mode state across reload / resume / fork.
    try {
      // Mode entries are branch-local; discarded future branches must not win.
      mode.restore(pi, ctx.sessionManager.getBranch() as any);
    } catch {
      // ignore
    }
    if (!mode.isEnabled() && pi.getFlag?.("ultracode") === true) {
      mode.enable(pi, "auto");
    }
    // Registration makes extension tools discoverable; activation remains opt-in.
    mode.syncWorkflowTool(pi);
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        "ultracode",
        mode.isEnabled() ? mode.statusLine((label) => ctx.ui.theme.fg("accent", label)) : undefined,
      );
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (mode.isSuspended()) return;
    mode.restore(pi, ctx.sessionManager.getBranch() as any);
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        "ultracode",
        mode.isEnabled() ? mode.statusLine((label) => ctx.ui.theme.fg("accent", label)) : undefined,
      );
    }
  });

  pi.on("session_shutdown", async () => {
    // The persisted configured mode remains active for reload/resume/fork replacements.
    mode.suspend(pi);
  });

  pi.on("before_agent_start", async (event) => {
    // Reconcile tool availability and append the standing policy on every
    // enforcing turn, even when another active-tool writer caused drift.
    mode.syncWorkflowTool(pi);
    return mode.beforeAgentStart(event);
  });
}
