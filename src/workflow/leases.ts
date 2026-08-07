import * as path from "node:path";
import { MAX_ACTIVE_WORKFLOWS_PER_SESSION, WorkflowPolicyError } from "./admission.ts";

interface ScopeState {
  activeRunIds: Set<string>;
}

const scopes = new Map<string, ScopeState>();

export interface WorkflowLease {
  readonly runsDir: string;
  readonly runId: string;
  release(): void;
}

export function acquireWorkflowLease(runsDir: string, runId: string): WorkflowLease {
  const key = normalizeScope(runsDir);
  let state = scopes.get(key);
  if (!state) {
    state = { activeRunIds: new Set() };
    scopes.set(key, state);
  }
  if (state.activeRunIds.has(runId)) {
    throw new WorkflowPolicyError(`workflow runId ${runId} is already active in this session`);
  }
  if (state.activeRunIds.size >= MAX_ACTIVE_WORKFLOWS_PER_SESSION) {
    throw new WorkflowPolicyError(
      `too many active workflows in this session (${state.activeRunIds.size}/${MAX_ACTIVE_WORKFLOWS_PER_SESSION}); wait for one to finish`,
    );
  }
  state.activeRunIds.add(runId);
  let released = false;
  return {
    runsDir: key,
    runId,
    release() {
      if (released) return;
      released = true;
      const current = scopes.get(key);
      current?.activeRunIds.delete(runId);
      if (current && current.activeRunIds.size === 0) scopes.delete(key);
    },
  };
}

export function activeWorkflowCount(runsDir: string): number {
  return scopes.get(normalizeScope(runsDir))?.activeRunIds.size ?? 0;
}

export function clearWorkflowLeasesForTests(): void {
  scopes.clear();
}

function normalizeScope(runsDir: string): string {
  try {
    return path.resolve(runsDir);
  } catch {
    return runsDir;
  }
}
