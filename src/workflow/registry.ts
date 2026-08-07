/**
 * Process-local registry of workflow runs, so the `/workflows` command can list
 * recent and in-flight runs and show live progress. Snapshots are updated in place
 * by the workflow tool as a run progresses.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { recompute, type WorkflowSnapshot } from "./display.ts";
import { WorkflowRunDetails } from "./run-details.ts";

export interface RunHandle {
  snapshot: WorkflowSnapshot;
  abort: () => void;
  startedAt: number;
  details?: WorkflowRunDetails;
}

interface RegistryScope {
  runs: Map<string, RunHandle>;
  order: string[];
}

export class WorkflowRegistry {
  private readonly scopes = new Map<string, RegistryScope>();
  private readonly listeners = new Set<() => void>();
  private scopeDir?: string;

  register(
    runId: string,
    snapshot: WorkflowSnapshot,
    abort: () => void,
    details?: WorkflowRunDetails,
  ): RunHandle {
    const scope = this.currentScope();
    const handle: RunHandle = { snapshot, abort, startedAt: Date.now(), details };
    scope.runs.set(runId, handle);
    scope.order = scope.order.filter((id) => id !== runId);
    scope.order.push(runId);
    // Keep at most the 50 most recent runs per session without evicting active work.
    this.trimRuns(scope);
    this.notify();
    return handle;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // UI observers must not affect workflow execution.
      }
    }
  }

  /** Restore the newest task-detail manifests for the current Pi session. */
  restoreRuns(runsDir: string): number {
    this.setScope(runsDir);
    const scope = this.currentScope();
    let files: string[];
    try {
      files = fs.readdirSync(runsDir)
        .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.details\.json$/.test(name))
        .map((name) => path.join(runsDir, name))
        .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
        .slice(-50);
    } catch {
      return 0;
    }
    let restored = 0;
    for (const file of files) {
      const loaded = WorkflowRunDetails.restore(file);
      if (!loaded || scope.runs.has(loaded.snapshot.runId ?? loaded.details.runId)) continue;
      const runId = loaded.snapshot.runId ?? loaded.details.runId;
      if (loaded.snapshot.status === "running") {
        loaded.snapshot.status = "aborted";
        for (const agent of loaded.snapshot.agents) {
          if (agent.status !== "running") continue;
          agent.status = "cancelled";
          agent.currentTurn = undefined;
          loaded.details.finishTask(agent.id, { status: "cancelled", error: "Session ended before the task completed." });
        }
        loaded.snapshot = recompute(loaded.snapshot);
        loaded.details.persist(loaded.snapshot);
      }
      let startedAt = Date.now();
      try {
        startedAt = fs.statSync(file).mtimeMs;
      } catch {
        // Keep a deterministic in-memory fallback if the manifest disappears.
      }
      const handle: RunHandle = {
        snapshot: loaded.snapshot,
        abort: () => {},
        startedAt,
        details: loaded.details,
      };
      scope.runs.set(runId, handle);
      scope.order.push(runId);
      restored++;
    }
    this.trimRuns(scope);
    if (restored) this.notify();
    return restored;
  }

  /** Select a session without discarding live handles from other sessions. */
  setScope(runsDir: string): void {
    const resolved = path.resolve(runsDir);
    if (this.scopeDir === resolved) return;
    this.scopeDir = resolved;
    this.currentScope();
    this.notify();
  }

  get(runId: string): RunHandle | undefined {
    return this.currentScope().runs.get(runId);
  }

  list(): RunHandle[] {
    const scope = this.currentScope();
    return scope.order
      .map((id) => scope.runs.get(id))
      .filter((handle): handle is RunHandle => Boolean(handle))
      .sort((left, right) => right.startedAt - left.startedAt);
  }

  active(): RunHandle[] {
    return this.list().filter((h) => h.snapshot.status === "running");
  }

  abortAll(): void {
    for (const handle of this.currentScope().runs.values()) {
      if (handle.snapshot.status === "running") {
        try {
          handle.abort();
        } catch {
          // ignore
        }
      }
    }
  }

  private currentScope(): RegistryScope {
    const key = this.scopeDir ?? "<default>";
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = { runs: new Map(), order: [] };
      this.scopes.set(key, scope);
    }
    return scope;
  }

  private trimRuns(scope: RegistryScope): void {
    while (scope.runs.size > 50) {
      const candidate = [...scope.runs.entries()].sort((left, right) => {
        const leftActive = left[1].snapshot.status === "running" ? 1 : 0;
        const rightActive = right[1].snapshot.status === "running" ? 1 : 0;
        return leftActive - rightActive || left[1].startedAt - right[1].startedAt;
      })[0];
      if (!candidate) break;
      scope.runs.delete(candidate[0]);
      scope.order = scope.order.filter((id) => id !== candidate[0]);
    }
  }
}

let singleton: WorkflowRegistry | undefined;

export function getRegistry(): WorkflowRegistry {
  if (!singleton) singleton = new WorkflowRegistry();
  return singleton;
}
