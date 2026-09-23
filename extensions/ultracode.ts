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
import { UltracodePreferences, type UltracodePreferenceStore } from "../src/preferences.ts";
import { WorkflowRegistry } from "../src/workflow/registry.ts";
import { workflowEffortContext } from "../src/workflow/effort-context.ts";

export interface ThinkingPreferenceContext {
  cwd: string;
  projectTrusted: boolean;
}

export interface UltracodeExtensionDeps extends Partial<WorkflowToolDeps> {
  preferences?: UltracodePreferenceStore;
  /** @deprecated Parent effort is user-owned; retained for source compatibility. */
  createThinkingPreferenceStore?: (
    context: ThinkingPreferenceContext,
  ) => ThinkingPreferenceStore | undefined;
}

export default function extension(pi: ExtensionAPI, extraDeps: UltracodeExtensionDeps = {}): void {
  const mode = new UltracodeMode("workflow");
  const {
    createThinkingPreferenceStore: _unusedThinkingPreferenceStore,
    preferences = new UltracodePreferences(),
    ...workflowDeps
  } = extraDeps;

  const registry = workflowDeps.registry ?? new WorkflowRegistry();
  const workflowTool = createWorkflowTool({
    ...workflowDeps,
    registry,
    isExecutionAllowed: () => mode.isEnforcing(),
  });
  pi.registerTool(workflowTool);

  registerCommands(pi, mode, registry, preferences);

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
    mode.cancelDepthRouting();
    // Restore persisted mode state across reload / resume / fork.
    let hasSavedMode = true;
    try {
      // Mode entries are branch-local; discarded future branches must not win.
      hasSavedMode = mode.restore(pi, ctx.sessionManager.getBranch() as any);
    } catch {
      // Do not apply a startup default when branch restoration failed.
    }
    if (!mode.isEnabled() && pi.getFlag?.("ultracode") === true) {
      mode.enable(pi, "auto");
    } else if (!hasSavedMode && !mode.isEnabled()) {
      try {
        if (preferences.getDefaultEnabled()) mode.enable(pi, "auto");
      } catch (error) {
        ctx.ui.notify(`Failed to read Ultracode default: ${String(error)}`, "warning");
      }
    }
    // Registration makes tools discoverable; activation follows the chosen mode.
    mode.syncWorkflowTool(pi);
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        "ultracode",
        mode.isEnabled() ? mode.statusLine((label) => ctx.ui.theme.fg("accent", label)) : undefined,
      );
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    mode.cancelDepthRouting();
    if (mode.isSuspended()) return;
    mode.restore(pi, ctx.sessionManager.getBranch() as any);
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        "ultracode",
        mode.isEnabled() ? mode.statusLine((label) => ctx.ui.theme.fg("accent", label)) : undefined,
      );
    }
  });

  pi.on("model_select", () => {
    // A result selected before a model/lifecycle change must not reach a later run.
    // This does not change the configured mode or the parent's effort.
    mode.cancelDepthRouting();
  });

  pi.on("session_shutdown", async () => {
    // The persisted configured mode remains active for reload/resume/fork replacements.
    mode.suspend(pi);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Reconcile tool availability and update our prompt section on every turn,
    // including removal when the mode is off or suspended.
    mode.syncWorkflowTool(pi);
    // Pi may have no operation signal during preflight. Forward it when present;
    // the SDK timeout and mode-owned lifecycle controller also bound the request.
    const signal = ctx.signal;
    await mode.beforeAgentStart(event, signal);
    // Read fresh capabilities, not startup state: /model and registry updates
    // must be reflected before the parent chooses child effort suffixes.
    const { sections } = event.systemPromptOptions;
    if (mode.isEnforcing() && !signal?.aborted) {
      sections.ultracode_effort = workflowEffortContext(ctx, workflowDeps.modelRuntime);
    } else {
      delete sections.ultracode_effort;
    }
  });
}
