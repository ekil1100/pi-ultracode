/**
 * Process-local registry for one Pi extension session.
 *
 * A registry instance is permanently scoped by ownership: callers create one per
 * extension/session and inject that same instance into the workflow tool and
 * commands. No mutable process-global "current session" exists.
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

export class WorkflowRegistry {
  private readonly runs = new Map<string, RunHandle>();
  private order: string[] = [];
  private readonly listeners = new Set<() => void>();

  register(
    runId: string,
    snapshot: WorkflowSnapshot,
    abort: () => void,
    details?: WorkflowRunDetails,
  ): RunHandle {
    const handle: RunHandle = { snapshot, abort, startedAt: Date.now(), details };
    this.runs.set(runId, handle);
    this.order = this.order.filter((id) => id !== runId);
    this.order.push(runId);
    this.trimRuns();
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

  /** Restore the newest task-detail manifests owned by this registry session. */
  restoreRuns(runsDir: string): number {
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
      if (!loaded || this.runs.has(loaded.snapshot.runId ?? loaded.details.runId)) continue;
      const runId = loaded.snapshot.runId ?? loaded.details.runId;
      if (loaded.snapshot.status === "running") {
        loaded.snapshot.status = "aborted";
        for (const agent of loaded.snapshot.agents) {
          if (agent.status !== "running") continue;
          agent.status = "cancelled";
          agent.currentTurn = undefined;
          loaded.details.finishTask(agent.id, {
            status: "cancelled",
            error: "Session ended before the task completed.",
          });
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
      this.runs.set(runId, {
        snapshot: loaded.snapshot,
        abort: () => {},
        startedAt,
        details: loaded.details,
      });
      this.order.push(runId);
      restored++;
    }
    this.trimRuns();
    if (restored) this.notify();
    return restored;
  }

  get(runId: string): RunHandle | undefined {
    const handle = this.runs.get(runId);
    return handle ? publicHandle(handle) : undefined;
  }

  list(): RunHandle[] {
    return this.order
      .map((id) => this.runs.get(id))
      .filter((handle): handle is RunHandle => Boolean(handle))
      .map(publicHandle)
      .sort((left, right) => right.startedAt - left.startedAt);
  }

  active(): RunHandle[] {
    return this.list().filter((handle) => handle.snapshot.status === "running");
  }

  abortAll(): void {
    for (const handle of this.runs.values()) {
      if (handle.snapshot.status !== "running") continue;
      try {
        handle.abort();
      } catch {
        // A failing callback must not prevent cancellation of sibling runs.
      }
    }
  }

  private trimRuns(): void {
    while (this.runs.size > 50) {
      const candidate = [...this.runs.entries()].sort((left, right) => {
        const leftActive = left[1].snapshot.status === "running" ? 1 : 0;
        const rightActive = right[1].snapshot.status === "running" ? 1 : 0;
        return leftActive - rightActive || left[1].startedAt - right[1].startedAt;
      })[0];
      if (!candidate) break;
      this.runs.delete(candidate[0]);
      this.order = this.order.filter((id) => id !== candidate[0]);
    }
  }
}

function publicHandle(handle: RunHandle): RunHandle {
  return {
    ...handle,
    snapshot: structuredClone(handle.snapshot),
  };
}
