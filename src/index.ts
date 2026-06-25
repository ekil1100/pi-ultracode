/** Public API of pi-ultracode, for reuse and testing. */

export { default } from "../extensions/ultracode.ts";
export { UltracodeMode, parseBudget, MODE_ENTRY_TYPE } from "./mode.ts";
export { registerCommands } from "./commands.ts";
export {
  ULTRACODE_TAGLINE,
  ULTRACODE_ACTIVE_REMINDER,
  ultracodeSystemBlock,
  WORKFLOW_GUIDELINES,
  WORKFLOW_PROMPT_SNIPPET,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./prompts.ts";

export { createWorkflowTool, type WorkflowToolDeps } from "./workflow/tool.ts";
export { runWorkflow, type WorkflowRunOptions, type WorkflowRunResult } from "./workflow/runtime.ts";
export { parseWorkflowScript, normalizeScript, type WorkflowMeta, type WorkflowMetaPhase } from "./workflow/parser.ts";
export { jsonSchemaToTypeBox } from "./workflow/json-schema.ts";
export {
  WorkflowAgentRunner,
  type AgentRunCall,
  type AgentRunResult,
  type ThinkingLevel,
} from "./workflow/agent-runner.ts";
export { createStructuredOutputTool, type StructuredOutputCapture } from "./workflow/structured-output.ts";
export {
  discoverAgentTypes,
  resolveAgentType,
  parseFrontmatter,
  parseAgentTypeFile,
  type AgentTypeDef,
} from "./workflow/agent-types.ts";
export { RunJournal, agentCallKey, hashString, stableStringify } from "./workflow/journal.ts";
export { getRegistry, WorkflowRegistry } from "./workflow/registry.ts";
export {
  createSnapshot,
  recompute,
  renderWorkflowLines,
  renderWorkflowText,
  preview,
  type WorkflowSnapshot,
} from "./workflow/display.ts";
export {
  createWorktree,
  captureWorktreeDiff,
  removeWorktree,
  applyPatch,
  isGitRepo,
  type Worktree,
} from "./workflow/worktree.ts";
