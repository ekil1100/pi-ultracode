/**
 * pi-ultracode extension entrypoint.
 *
 * Wires together the three pillars of Claude-Code-style "ultracode":
 *   1. The ultracode effort mode (max thinking + standing workflow opt-in).
 *   2. The full `workflow` orchestration tool.
 *   3. The `/ultracode` and `/workflows` commands.
 */

import {
  getAgentDir,
  SettingsManager,
  VERSION as PI_VERSION,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createWorkflowTool, type WorkflowToolDeps } from "../src/workflow/tool.ts";
import { UltracodeMode, type ThinkingPreferenceStore } from "../src/mode.ts";
import { isThinkingLevel, piVersionSupportsMaxThinking } from "../src/thinking.ts";
import { registerCommands } from "../src/commands.ts";

export interface ThinkingPreferenceContext {
  cwd: string;
  projectTrusted: boolean;
}

export interface UltracodeExtensionDeps extends Partial<WorkflowToolDeps> {
  /** SDK-host seam when the active profile differs from Pi's ambient agent dir. */
  createThinkingPreferenceStore?: (
    context: ThinkingPreferenceContext,
  ) => ThinkingPreferenceStore | undefined;
}

export default function extension(pi: ExtensionAPI, extraDeps: UltracodeExtensionDeps = {}): void {
  const mode = new UltracodeMode("workflow");
  mode.setRuntimeSupportsMaxThinking(piVersionSupportsMaxThinking(PI_VERSION));
  const {
    createThinkingPreferenceStore = createPiThinkingPreferenceStore,
    ...workflowDeps
  } = extraDeps;

  const workflowTool = createWorkflowTool({
    getDefaultBudget: () => mode.getBudget(),
    getThinkingLevel: () => mode.getSubagentThinkingLevel(),
    ...workflowDeps,
  });
  pi.registerTool(workflowTool);

  registerCommands(pi, mode);

  // Opt-in via CLI flag: `pi --ultracode`.
  pi.registerFlag("ultracode", {
    type: "boolean",
    description: "Start the session in ultracode mode (max thinking + default workflow orchestration).",
  });

  pi.on("session_start", async (_event, ctx) => {
    await mode.flushThinkingPreference();
    mode.setCurrentModelSupportsThinking(ctx.model ? Boolean(ctx.model.reasoning) : undefined);
    try {
      mode.bindThinkingPreferenceStore(createThinkingPreferenceStore({
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
      }));
    } catch {
      mode.bindThinkingPreferenceStore(undefined);
    }
    // Restore persisted mode state across reload / resume / fork.
    try {
      // Mode entries are branch-local; discarded future branches must not win.
      mode.restore(pi, ctx.sessionManager.getBranch() as any);
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
    await mode.flushThinkingPreference();
    if (ctx.hasUI) {
      ctx.ui.setStatus("ultracode", mode.isEnabled() ? mode.statusLine() : undefined);
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    await mode.flushThinkingPreference();
    if (mode.isSuspended()) return;
    mode.setCurrentModelSupportsThinking(ctx.model ? Boolean(ctx.model.reasoning) : undefined);
    mode.restore(pi, ctx.sessionManager.getBranch() as any);
    await mode.flushThinkingPreference();
    if (ctx.hasUI) {
      ctx.ui.setStatus("ultracode", mode.isEnabled() ? mode.statusLine() : undefined);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    mode.setCurrentModelSupportsThinking(Boolean(event.model.reasoning));
    const refreshStatus = mode.handleModelSelect(pi);
    await mode.flushThinkingPreference();
    if (refreshStatus && ctx.hasUI) ctx.ui.setStatus("ultracode", mode.statusLine());
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (!mode.handleThinkingLevelSelect(pi, event.level)) return;
    await mode.flushThinkingPreference();
    if (ctx.hasUI) ctx.ui.setStatus("ultracode", mode.statusLine());
  });

  pi.on("session_shutdown", async () => {
    // Quiesce first so late model/effort events cannot undo restoration. The
    // persisted enabled state remains on for reload/resume/fork replacements.
    mode.suspend(pi);
    await mode.flushThinkingPreference();
  });

  pi.on("before_agent_start", async (event) => {
    // Final synchronous effort barrier before Pi starts the provider request.
    mode.reapplyMaximumThinking(pi);
    await mode.flushThinkingPreference();
    return mode.beforeAgentStart(event);
  });
}

function createPiThinkingPreferenceStore(
  context: ThinkingPreferenceContext,
): ThinkingPreferenceStore {
  const createSettings = () => SettingsManager.create(
    context.cwd,
    getAgentDir(),
    { projectTrusted: context.projectTrusted },
  );
  return {
    getThinkingPreference() {
      // Use a fresh manager so a selection made after session_start is visible;
      // SettingsManager instances intentionally keep their own cached snapshot.
      const settings = createSettings();
      const global = settings.getGlobalSettings().defaultThinkingLevel;
      const effective = settings.getDefaultThinkingLevel();
      return {
        global: isThinkingLevel(global) ? global : undefined,
        effective: isThinkingLevel(effective) ? effective : "medium",
      };
    },
    async setDefaultThinkingLevel(level) {
      // Use a fresh queue after the mode's macrotask barrier. This serializes
      // behind Pi's already-enqueued writes instead of racing a long-lived peer.
      const settings = createSettings();
      // An absent setting is semantically Pi's `medium` default. SettingsManager
      // has no unset operation, so restore that equivalent value explicitly.
      settings.setDefaultThinkingLevel((level ?? "medium") as any);
      await settings.flush();
    },
  };
}
