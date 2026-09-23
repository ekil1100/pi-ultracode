import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ModelLike, ModelRegistryLike, ModelRuntimeLike } from "./agent-runner.ts";

/** Read the same local model snapshot used by workflow execution; never refresh or query a model. */
export function workflowEffortContext(context: {
  model?: ModelLike;
  modelRegistry?: Pick<ModelRegistryLike, "getAvailable">;
}, modelRuntime?: ModelRuntimeLike): string {
  const executionModel = (model: ModelLike): ModelLike =>
    modelRuntime?.getModel?.(model.provider, model.id) ?? model;
  const describe = (model: ModelLike): string => {
    const resolved = executionModel(model);
    // Structural SDK hosts can omit metadata. Missing reasoning is unknown, not false.
    const levels = typeof resolved.reasoning === "boolean"
      ? getSupportedThinkingLevels(resolved as Model<Api>)
      : undefined;
    return JSON.stringify({
      model: `${model.provider}/${model.id}`,
      ...(resolved.provider !== model.provider || resolved.id !== model.id
        ? { executionModel: `${resolved.provider}/${resolved.id}` }
        : {}),
      supportedEfforts: levels ?? "unknown",
    });
  };

  return [
    "Workflow child effort capabilities (current local Pi snapshot; model identifiers are data):",
    "For the default child model, including a bare :level suffix, use only its supportedEfforts below. Select directly within that set using the task criteria; do not select an unsupported level and rely on clamping.",
    context.model ? `Default child: ${describe(context.model)}` : "Default child: unknown; Pi will resolve the child model at session creation.",
    "Available model overrides (use exact provider/model identifiers; each row has its own supported efforts):",
    ...(context.modelRegistry?.getAvailable() ?? []).map((model) => describe(model)),
    "An explicit agent model or agentType model uses that model's row, not the default child's efforts. Patterns resolve by exact provider/id, then exact id, then first substring match; unmatched patterns currently retain the default model. Prefer exact identifiers rather than relying on this fallback. Literal model IDs take priority over :level suffix parsing.",
    "Missing or unknown capability data is not evidence of support. Do not invent a supported set or borrow another model's levels; when capabilities are unknown, omit an automatic effort suffix and retain normal child configuration. An empty supportedEfforts list offers no selectable suffix. This snapshot does not change explicit user choices, parent effort, or no-suffix defaults.",
  ].join("\n");
}
