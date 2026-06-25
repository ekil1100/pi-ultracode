/**
 * Process-local registry of workflow runs, so the `/workflows` command can list
 * recent and in-flight runs and show live progress. Snapshots are updated in place
 * by the workflow tool as a run progresses.
 */

import type { WorkflowSnapshot } from "./display.ts";

export interface RunHandle {
  snapshot: WorkflowSnapshot;
  abort: () => void;
  startedAt: number;
}

export class WorkflowRegistry {
  private readonly runs = new Map<string, RunHandle>();
  private order: string[] = [];

  register(runId: string, snapshot: WorkflowSnapshot, abort: () => void): RunHandle {
    const handle: RunHandle = { snapshot, abort, startedAt: Date.now() };
    this.runs.set(runId, handle);
    this.order = this.order.filter((id) => id !== runId);
    this.order.push(runId);
    // Keep at most the 50 most recent runs in memory.
    while (this.order.length > 50) {
      const evict = this.order.shift();
      if (evict) this.runs.delete(evict);
    }
    return handle;
  }

  get(runId: string): RunHandle | undefined {
    return this.runs.get(runId);
  }

  list(): RunHandle[] {
    return this.order
      .map((id) => this.runs.get(id))
      .filter((h): h is RunHandle => Boolean(h))
      .reverse();
  }

  active(): RunHandle[] {
    return this.list().filter((h) => h.snapshot.status === "running");
  }

  abortAll(): void {
    for (const handle of this.runs.values()) {
      if (handle.snapshot.status === "running") {
        try {
          handle.abort();
        } catch {
          // ignore
        }
      }
    }
  }
}

let singleton: WorkflowRegistry | undefined;

export function getRegistry(): WorkflowRegistry {
  if (!singleton) singleton = new WorkflowRegistry();
  return singleton;
}
