/**
 * pi-ultracode extension entrypoint.
 *
 * Wires together Ultracode's semantic analysis-depth modes, deterministic
 * workflow orchestration, and the `/ultracode` / `/workflows` commands.
 */

import { Effect } from "effect";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWorkflowTool, type WorkflowToolDeps } from "../src/workflow/tool.ts";
import { UltracodeMode, type ThinkingPreferenceStore } from "../src/mode.ts";
import { registerCommands } from "../src/commands.ts";
import { registerOneShot } from "../src/one-shot.ts";
import { registerOneShotEditor } from "../src/one-shot-editor.ts";
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
    getSelectorBackend: workflowDeps.getSelectorBackend ?? (() => preferences.getSelectorBackend()),
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
        reason:
          "The workflow tool is disabled. Run /ultracode or select an Ultracode depth before using it.",
      };
    }
  });

  const attempt = <A>(thunk: () => A) => Effect.try({ try: thunk, catch: (error) => error });
  const updateStatus = (ctx: ExtensionContext) =>
    attempt(() => {
      mode.syncWorkflowTool(pi);
      if (ctx.hasUI) {
        ctx.ui.setStatus(
          "ultracode",
          mode.isEnabled()
            ? mode.statusLine((text, color) => ctx.ui.theme.fg(color, text))
            : undefined,
        );
      }
    });

  pi.on("session_start", (_event, ctx) =>
    Effect.runPromise(
      // Mode entries are branch-local; restoration failure suppresses startup defaults.
      attempt(() => mode.restore(pi, ctx.sessionManager.getBranch() as any)).pipe(
        Effect.catch(() => Effect.succeed(true)),
        Effect.flatMap((hasSavedMode) =>
          attempt(() => pi.getFlag?.("ultracode") === true).pipe(
            Effect.flatMap((flagEnabled) => {
              if (!mode.isEnabled() && flagEnabled) return attempt(() => mode.enable(pi, "auto"));
              if (hasSavedMode || mode.isEnabled()) return Effect.void;
              return attempt(() => {
                if (preferences.getDefaultEnabled()) mode.enable(pi, "auto");
              }).pipe(
                Effect.catch((error) =>
                  attempt(() => {
                    ctx.ui.notify(`Failed to read Ultracode default: ${String(error)}`, "warning");
                  }),
                ),
              );
            }),
          ),
        ),
        Effect.andThen(updateStatus(ctx)),
      ),
    ),
  );

  pi.on("session_tree", (_event, ctx) =>
    Effect.runPromise(
      Effect.suspend(() =>
        mode.isSuspended()
          ? Effect.void
          : attempt(() => mode.restore(pi, ctx.sessionManager.getBranch() as any)).pipe(
              Effect.andThen(updateStatus(ctx)),
            ),
      ),
    ),
  );

  pi.on("session_shutdown", () =>
    Effect.runPromise(
      attempt(() => {
        // Persisted configuration survives reload/resume/fork replacements.
        mode.suspend(pi);
      }),
    ),
  );

  pi.on("before_agent_start", (event, ctx) => {
    // Reconcile tool availability and update our prompt section on every turn,
    // including removal when the mode is off or suspended.
    mode.syncWorkflowTool(pi);
    const signal = ctx.signal;
    mode.beforeAgentStart(event, signal);
    // Read fresh capabilities, not startup state: /model and registry updates
    // must be reflected before the parent chooses child effort suffixes.
    const { sections } = event.systemPromptOptions;
    if (mode.isEnforcing() && !signal?.aborted) {
      sections.ultracode_effort = workflowEffortContext(ctx, workflowDeps.modelRuntime);
    } else {
      delete sections.ultracode_effort;
    }
  });

  registerOneShot(pi, mode);
  registerOneShotEditor(pi);
}
