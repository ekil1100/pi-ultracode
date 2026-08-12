/**
 * Durable workflow run ledger.
 *
 * A run has one immutable script/args identity and one lifetime maxAgents cap.
 * Resume appends to the same ledger, may only raise that cap, and replays agent
 * results by a stable Worker-assigned callPath plus a cryptographic input hash.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "./agent-runner.ts";
import {
  DEFAULT_MAX_AGENTS,
  WorkflowPolicyError,
  normalizeMaxAgents,
} from "./admission.ts";
import {
  assertRegularArtifactFile,
  ensurePrivateArtifactDirectory,
  fsyncArtifactDirectory,
  readArtifactFile,
} from "./run-artifacts.ts";
import * as crypto from "node:crypto";
import { assertWorkflowArgsLimit, assertWorkflowOutputLimit } from "./value-limits.ts";

export const RUN_JOURNAL_VERSION = 4;
export const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export interface JournalRunMeta {
  type: "run";
  journalVersion?: 4;
  runId: string;
  name: string;
  scriptHash: string;
  args?: unknown;
  projectTrusted: boolean;
  targetIdentity: string;
  startedAt: number;
  maxAgents?: number;
}

export interface JournalResumeOptions {
  validateDelivery?: (record: JournalAgentRecord) => void;
}

export interface JournalResumeRecord {
  type: "resume";
  startedAt: number;
  maxAgents: number;
}

export interface JournalAdmissionRecord {
  type: "admit";
  callPath: string;
  inputHash: string;
  ordinal: number;
}

export interface JournalPanelOpenRecord {
  type: "panel-open";
  callPath: string;
  reserveAgents: number;
  branchCount: number;
}

export interface JournalPanelBranchRecord {
  type: "panel-branch";
  callPath: string;
  branchIndex: number;
  outcome: "success" | "failed";
  calls: Array<{ callPath: string; status: "success" | "failed" }>;
}

export interface JournalPanelRecord {
  type: "panel-complete";
  callPath: string;
  branchCount: number;
  branchOutcomes: Array<"success" | "failed">;
  calls: Array<{ callPath: string; status: "success" | "failed" }>;
}

export interface JournalNestedSourceRecord {
  type: "nested-source";
  callPath: string;
  sourceHash: string;
}

export interface JournalDeliveryStartRecord {
  type: "delivery-start";
  callPath: string;
  patchPath: string;
  patchHash: string;
}

export interface JournalAgentRecord {
  type: "agent";
  /** Stable structural identity assigned in the script Worker. */
  callPath: string;
  /** Display/observability sequence; never used for cache identity. */
  seq: number;
  key: string;
  label: string;
  value: unknown;
  outputTokens: number;
  inputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  turns?: number;
  toolUses?: number;
  retries?: number;
  compactions?: number;
  requestedModelId?: string;
  requestedEffort?: ThinkingLevel;
  modelId?: string;
  effort?: ThinkingLevel;
  agentType?: string;
  isolation?: string;
  structuredOutput?: boolean;
  /** Durable material retained to verify a completed worktree side effect on resume. */
  deliveryPatchPath?: string;
  deliveryPatchHash?: string;
  transcriptPath?: string;
  startedAt?: number;
  durationMs?: number;
}

export interface JournalResultRecord {
  type: "result";
  ok: boolean;
  result?: unknown;
  error?: string;
  agentCount: number;
  durationMs: number;
}

export type JournalRecord =
  | JournalRunMeta
  | JournalResumeRecord
  | JournalAdmissionRecord
  | JournalPanelOpenRecord
  | JournalPanelBranchRecord
  | JournalPanelRecord
  | JournalNestedSourceRecord
  | JournalDeliveryStartRecord
  | JournalAgentRecord
  | JournalResultRecord;

/** Cryptographic identity hash for scripts, args, and agent requests. */
export function hashString(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function hashBytes(input: Uint8Array): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function agentCallKey(prompt: string, opts: unknown): string {
  return hashString(`${prompt}\u0000${stableStringify(opts)}`);
}

interface LoadedJournal {
  header: JournalRunMeta;
  bytes: number;
  effectiveMaxAgents: number;
  agentsUsed: number;
  agents: Map<string, JournalAgentRecord>;
  admittedPaths: Set<string>;
  admissionHashes: Map<string, string>;
  panelOpens: Map<string, JournalPanelOpenRecord>;
  completePanels: Map<string, JournalPanelRecord>;
  panelBranches: Map<string, Map<number, JournalPanelBranchRecord>>;
  nestedSources: Map<string, string>;
  pendingDeliveries: Map<string, JournalDeliveryStartRecord>;
}

export class RunJournal {
  readonly filePath: string;
  readonly effectiveMaxAgents: number;
  readonly projectTrusted: boolean;
  readonly targetIdentity: string;
  private readonly fd: number;
  private readonly priorAgents: Map<string, JournalAgentRecord>;
  private readonly admittedPaths: Set<string>;
  private readonly admissionHashes: Map<string, string>;
  private readonly panelOpens: Map<string, JournalPanelOpenRecord>;
  private readonly completePanels: Map<string, JournalPanelRecord>;
  private readonly panelBranches: Map<string, Map<number, JournalPanelBranchRecord>>;
  private readonly openPanelBranches = new Map<string, Map<number, JournalPanelBranchRecord>>();
  private readonly openPanelAdmissions = new Map<string, Set<string>>();
  private readonly nestedSources: Map<string, string>;
  private readonly pendingDeliveries: Map<string, JournalDeliveryStartRecord>;
  private _agentsUsed: number;
  private bytes: number;
  private fdClosed = false;
  private closed = false;
  private writeFailure?: WorkflowPolicyError;
  private closeFailure?: unknown;
  private resultRecorded = false;

  private constructor(filePath: string, fd: number, loaded: LoadedJournal) {
    this.filePath = filePath;
    this.fd = fd;
    this.effectiveMaxAgents = loaded.effectiveMaxAgents;
    this.projectTrusted = loaded.header.projectTrusted;
    this.targetIdentity = loaded.header.targetIdentity;
    this._agentsUsed = loaded.agentsUsed;
    this.bytes = loaded.bytes;
    this.priorAgents = loaded.agents;
    this.admittedPaths = loaded.admittedPaths;
    this.admissionHashes = loaded.admissionHashes;
    this.panelOpens = loaded.panelOpens;
    this.completePanels = loaded.completePanels;
    this.panelBranches = loaded.panelBranches;
    this.nestedSources = loaded.nestedSources;
    this.pendingDeliveries = loaded.pendingDeliveries;
  }

  get agentsUsed(): number {
    return this._agentsUsed;
  }

  /** Create a new ledger without truncating any pre-existing artifact. */
  static create(dir: string, meta: JournalRunMeta): RunJournal {
    assertWorkflowArgsLimit(meta.args);
    const effectiveMaxAgents = normalizeMaxAgents(meta.maxAgents);
    const header: JournalRunMeta = {
      ...meta,
      journalVersion: RUN_JOURNAL_VERSION,
      projectTrusted: meta.projectTrusted,
      maxAgents: effectiveMaxAgents,
    };
    validateRunRecord(header);
    ensurePrivateArtifactDirectory(dir);
    const filePath = path.join(dir, `${meta.runId}.jsonl`);
    const fd = fs.openSync(
      filePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_APPEND | NO_FOLLOW,
      0o600,
    );
    const journal = new RunJournal(filePath, fd, {
      header,
      bytes: 0,
      effectiveMaxAgents,
      agentsUsed: 0,
      agents: new Map(),
      admittedPaths: new Set(),
      admissionHashes: new Map(),
      panelOpens: new Map(),
      completePanels: new Map(),
      panelBranches: new Map(),
      nestedSources: new Map(),
      pendingDeliveries: new Map(),
    });
    try {
      journal.append(header);
      fsyncArtifactDirectory(dir);
      return journal;
    } catch (error) {
      journal.closeQuietly();
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // Preserve the original write failure.
      }
      throw error;
    }
  }

  /** Resume the same immutable run ledger, optionally raising its lifetime cap. */
  static resume(
    dir: string,
    runId: string,
    meta: JournalRunMeta,
    options: JournalResumeOptions = {},
  ): RunJournal {
    assertWorkflowArgsLimit(meta.args);
    validateRunRecord(meta);
    ensurePrivateArtifactDirectory(dir);
    const filePath = path.join(dir, `${runId}.jsonl`);
    let journal: RunJournal | undefined;
    try {
      const loaded = loadJournal(filePath);
      if (loaded.header.runId !== runId) {
        throw new WorkflowPolicyError(`workflow journal runId mismatch for ${runId}`);
      }
      if (loaded.header.scriptHash !== meta.scriptHash) {
        throw new WorkflowPolicyError(`workflow ${runId} has an immutable script; start a new run for changed source`);
      }
      if (JSON.stringify(loaded.header.args) !== JSON.stringify(meta.args)) {
        throw new WorkflowPolicyError(`workflow ${runId} has immutable args; start a new run for changed args`);
      }
      if (loaded.header.projectTrusted !== meta.projectTrusted) {
        throw new WorkflowPolicyError(`workflow ${runId} has an immutable project trust context; start a new run after trust changes`);
      }
      if (loaded.header.targetIdentity !== meta.targetIdentity) {
        throw new WorkflowPolicyError(`workflow ${runId} has an immutable repository/cwd target; start a new run after changing location`);
      }
      if (loaded.pendingDeliveries.size > 0) {
        const pending = [...loaded.pendingDeliveries.values()][0]!;
        throw new WorkflowPolicyError(
          `workflow delivery at ${pending.callPath} requires recovery before resume; patch: ${pending.patchPath}`,
        );
      }
      if (options.validateDelivery) {
        for (const agent of loaded.agents.values()) {
          if (agent.deliveryPatchPath) options.validateDelivery(agent);
        }
      }

      const requested = meta.maxAgents === undefined
        ? loaded.effectiveMaxAgents
        : normalizeMaxAgents(meta.maxAgents);
      if (requested < loaded.effectiveMaxAgents) {
        throw new WorkflowPolicyError(
          `workflow resume maxAgents cannot decrease from ${loaded.effectiveMaxAgents} to ${requested}`,
        );
      }
      loaded.effectiveMaxAgents = requested;
      const resumeRecord: JournalResumeRecord = {
        type: "resume",
        startedAt: meta.startedAt,
        maxAgents: requested,
      };
      validateResumeRecord(resumeRecord);
      const fd = openAppendRegular(filePath);
      journal = new RunJournal(filePath, fd, loaded);
      journal.append(resumeRecord);
      return journal;
    } catch (error) {
      journal?.closeQuietly();
      throw error;
    }
  }

  static readEffectiveMaxAgents(dir: string, runId: string): number | undefined {
    const filePath = path.join(dir, `${runId}.jsonl`);
    return loadJournal(filePath).effectiveMaxAgents;
  }

  static exists(dir: string, runId: string): boolean {
    const filePath = path.join(dir, `${runId}.jsonl`);
    try {
      assertRegularArtifactFile(filePath, "workflow journal");
      return true;
    } catch (error: any) {
      if (error?.cause?.code === "ENOENT") return false;
      throw error;
    }
  }

  lookup(callPath: string, key: string): JournalAgentRecord | undefined {
    const pending = this.pendingDeliveries.get(callPath);
    if (pending) {
      throw new WorkflowPolicyError(
        `workflow delivery at ${callPath} requires recovery before resume; patch: ${pending.patchPath}`,
      );
    }
    const prior = this.priorAgents.get(callPath);
    if (!prior) return undefined;
    if (prior.key !== key) {
      throw new WorkflowPolicyError(`workflow resume diverged at ${callPath}; immutable agent input changed`);
    }
    return prior;
  }

  /** Persist lifetime admission before any runner side effect. */
  recordAdmission(callPath: string, inputHash: string, ordinal: number): void {
    const priorHash = this.admissionHashes.get(callPath);
    if (priorHash !== undefined && priorHash !== inputHash) {
      throw new WorkflowPolicyError(`workflow resume diverged at ${callPath}; immutable agent input changed`);
    }
    if (this._agentsUsed >= this.effectiveMaxAgents) {
      throw new WorkflowPolicyError(`workflow exceeded maxAgents=${this.effectiveMaxAgents} (no agent slots remain)`);
    }
    this.append({ type: "admit", callPath, inputHash, ordinal });
    for (const [panelPath, admissions] of this.openPanelAdmissions) {
      if (callPath.startsWith(`${panelPath}/`)) admissions.add(callPath);
    }
    this._agentsUsed++;
    this.admittedPaths.add(callPath);
    this.admissionHashes.set(callPath, inputHash);
  }

  recordNestedSource(callPath: string, sourceHash: string): void {
    const prior = this.nestedSources.get(callPath);
    if (prior !== undefined) {
      if (prior !== sourceHash) {
        throw new WorkflowPolicyError(`immutable nested workflow source or args changed at ${callPath}`);
      }
      return;
    }
    this.append({ type: "nested-source", callPath, sourceHash });
    this.nestedSources.set(callPath, sourceHash);
  }

  recordPanelOpen(callPath: string, reserveAgents: number, branchCount: number): void {
    const record: JournalPanelOpenRecord = { type: "panel-open", callPath, reserveAgents, branchCount };
    const prior = this.panelOpens.get(callPath);
    if (prior && (prior.reserveAgents !== reserveAgents || prior.branchCount !== branchCount)) {
      throw new WorkflowPolicyError(`immutable panel definition changed at ${callPath}`);
    }
    this.append(record);
    this.panelOpens.set(callPath, record);
    this.completePanels.delete(callPath);
    this.panelBranches.set(callPath, new Map());
    this.openPanelBranches.set(callPath, new Map());
    this.openPanelAdmissions.set(callPath, new Set());
  }

  recordPanelBranch(
    callPath: string,
    branchIndex: number,
    outcome: "success" | "failed",
    calls: Array<{ callPath: string; status: "success" | "failed" }>,
  ): void {
    const record: JournalPanelBranchRecord = {
      type: "panel-branch",
      callPath,
      branchIndex,
      outcome,
      calls,
    };
    const current = this.openPanelBranches.get(callPath);
    if (!current || current.has(branchIndex)) {
      throw new WorkflowPolicyError(`invalid duplicate or unopened panel branch at ${callPath}/b:${branchIndex}`);
    }
    assertPanelBranchCoversDurableCalls(
      record,
      this.openPanelAdmissions.get(callPath),
      this.priorAgents,
    );
    const branches = this.panelBranches.get(callPath) ?? new Map<number, JournalPanelBranchRecord>();
    this.append(record);
    current.set(branchIndex, record);
    branches.set(branchIndex, record);
    this.panelBranches.set(callPath, branches);
  }

  recordPanelComplete(
    callPath: string,
    branchCount: number,
    branchOutcomes: Array<"success" | "failed">,
    calls: Array<{ callPath: string; status: "success" | "failed" }>,
  ): void {
    const record: JournalPanelRecord = {
      type: "panel-complete",
      callPath,
      branchCount,
      branchOutcomes,
      calls,
    };
    const currentBranches = this.openPanelBranches.get(callPath);
    for (const branch of currentBranches?.values() ?? []) {
      assertPanelBranchCoversDurableCalls(
        branch,
        this.openPanelAdmissions.get(callPath),
        this.priorAgents,
      );
    }
    assertPanelCompletionMatchesBranches(record, currentBranches);
    this.append(record);
    this.completePanels.set(callPath, record);
    this.openPanelBranches.delete(callPath);
    this.openPanelAdmissions.delete(callPath);
  }

  /**
   * Compute conservative replay admission for an immutable completed panel.
   * A fully replayable branch needs no live base slot; branches containing any
   * failed admission retain their full potential because retry success can
   * reveal later calls that did not run in the prior attempt.
   */
  panelReplayPlan(callPath: string, branchCount: number): {
    branchNeedsSlot: boolean[];
    slotCredit: number;
  } {
    const branchNeedsSlot = Array.from({ length: branchCount }, () => true);
    const completed = this.completePanels.get(callPath);
    const partial = this.panelBranches.get(callPath);
    let slotCredit = 0;
    for (let index = 0; index < branchCount; index++) {
      const prefix = `${callPath}/b:${index}/`;
      const completedCalls = completed?.branchCount === branchCount
        ? completed.calls.filter((call) => call.callPath.startsWith(prefix))
        : undefined;
      const branch = partial?.get(index);
      const calls = completedCalls ?? branch?.calls;
      const outcome = completed?.branchCount === branchCount
        ? completed.branchOutcomes[index]
        : branch?.outcome;
      if (calls && outcome) {
        const firstFailure = calls.findIndex((call) => call.status === "failed");
        if (firstFailure < 0 && outcome === "success") {
          branchNeedsSlot[index] = false;
          slotCredit += Math.max(1, calls.length);
        } else {
          const prefixEnd = firstFailure < 0 ? calls.length : firstFailure;
          const sequentialCredit = calls
            .slice(0, prefixEnd)
            .filter((call) => call.status === "success").length;
          slotCredit += Math.max(sequentialCredit, this.nestedPanelCredit(prefix, calls));
        }
        continue;
      }
      // Without a durable branch outcome, prior successes may belong to a
      // mutually exclusive path. Reserve the branch's full declared capacity.
    }
    if (completed?.branchCount === branchCount && branchNeedsSlot.every((needed) => !needed)) {
      slotCredit = Math.max(slotCredit, this.panelOpens.get(callPath)?.reserveAgents ?? 0);
    }
    return { branchNeedsSlot, slotCredit };
  }

  private nestedPanelCredit(
    branchPrefix: string,
    calls: Array<{ callPath: string; status: "success" | "failed" }>,
  ): number {
    if (calls.length === 0) return 0;
    let credit = 0;
    const nestedPanels = [...this.completePanels.entries()]
      .filter(([panelPath]) => panelPath.startsWith(branchPrefix))
      .sort(([left], [right]) => left.length - right.length);
    for (const [panelPath, panel] of nestedPanels) {
      const firstNested = calls.findIndex((call) => call.callPath.startsWith(`${panelPath}/`));
      if (firstNested < 0) continue;
      const before = calls.slice(0, firstNested);
      if (before.some((call) => call.status === "failed")) continue;
      const nestedCalls = calls.filter((call) => call.callPath.startsWith(`${panelPath}/`));
      if (nestedCalls.length === 0) continue;
      const beforeCredit = before.filter((call) => call.status === "success").length;
      const panelCredit = this.panelReplayPlan(panelPath, panel.branchCount).slotCredit;
      credit = Math.max(credit, beforeCredit + panelCredit);
    }
    return credit;
  }

  recordDeliveryStart(callPath: string, patchPath: string, patchHash: string): void {
    if (this.pendingDeliveries.has(callPath) || this.priorAgents.has(callPath)) {
      throw new WorkflowPolicyError(`workflow delivery already started at ${callPath}`);
    }
    const record: JournalDeliveryStartRecord = { type: "delivery-start", callPath, patchPath, patchHash };
    validateDeliveryStartRecord(record);
    this.append(record);
    this.pendingDeliveries.set(callPath, record);
  }

  recordAgent(record: Omit<JournalAgentRecord, "type">): void {
    const full: JournalAgentRecord = { type: "agent", ...record };
    assertWorkflowOutputLimit(full.value, "workflow agent output");
    validateAgentRecord(full);
    const pending = this.pendingDeliveries.get(full.callPath);
    assertDeliveryCompletionMatches(pending, full);
    this.append(full);
    this.priorAgents.set(full.callPath, full);
    this.pendingDeliveries.delete(full.callPath);
  }

  recordResult(record: Omit<JournalResultRecord, "type">): void {
    if (this.resultRecorded) {
      throw new WorkflowPolicyError("workflow journal generation already has a terminal result");
    }
    if (record.ok) assertWorkflowOutputLimit(record.result);
    const full: JournalResultRecord = { type: "result", ...record };
    validateResultRecord(full);
    this.append(full);
    this.resultRecorded = true;
  }

  close(): void {
    if (this.closeFailure) {
      if (!this.fdClosed) {
        try {
          fs.closeSync(this.fd);
          this.fdClosed = true;
          this.closed = true;
        } catch {
          // Preserve the first durability failure on every retry.
        }
      }
      throw this.closeFailure;
    }
    if (this.writeFailure) {
      if (!this.fdClosed) {
        try {
          fs.closeSync(this.fd);
          this.fdClosed = true;
        } catch {
          // Preserve the original write failure.
        }
      }
      this.closed = this.fdClosed;
      throw this.writeFailure;
    }
    if (this.closed) return;
    let failure: unknown;
    if (!this.fdClosed) {
      try {
        fs.fsyncSync(this.fd);
      } catch (error) {
        failure = error;
      }
      try {
        fs.closeSync(this.fd);
        this.fdClosed = true;
      } catch (error) {
        failure ??= error;
      }
    }
    this.closed = this.fdClosed;
    if (failure) {
      this.closeFailure = failure;
      throw failure;
    }
  }

  private closeQuietly(): void {
    if (this.closed) return;
    if (!this.fdClosed) {
      try {
        fs.closeSync(this.fd);
        this.fdClosed = true;
      } catch {
        // best-effort cleanup while preserving the primary error
      }
    }
    this.closed = this.fdClosed;
  }

  private append(record: JournalRecord): void {
    if (this.resultRecorded && record.type !== "resume") {
      throw new WorkflowPolicyError("workflow journal generation already has a terminal result");
    }
    if (record.type === "resume") this.resultRecorded = false;
    if (this.writeFailure) throw this.writeFailure;
    if (this.closeFailure) throw this.closeFailure;
    if (this.closed || this.fdClosed) throw new WorkflowPolicyError("workflow journal is already closed");
    validateJournalRecordForWrite(record);
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch (error) {
      throw new WorkflowPolicyError(`workflow journal serialization failed: ${errorMessage(error)}`);
    }
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (this.bytes + lineBytes > MAX_JOURNAL_BYTES) {
      throw new WorkflowPolicyError(
        `workflow journal full: append would exceed the ${MAX_JOURNAL_BYTES}-byte cap`,
      );
    }
    try {
      fs.writeFileSync(this.fd, line);
      fs.fsyncSync(this.fd);
      this.bytes += lineBytes;
    } catch (error) {
      const failure = new WorkflowPolicyError(`workflow journal write failed: ${errorMessage(error)}`);
      this.writeFailure = failure;
      try {
        fs.closeSync(this.fd);
        this.fdClosed = true;
        this.closed = true;
      } catch {
        // Keep the poisoned descriptor unreachable by future appends.
      }
      throw failure;
    }
  }
}

function loadJournal(filePath: string): LoadedJournal {
  const content = readAndRepairJournal(filePath);
  const records: JournalRecord[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as JournalRecord);
    } catch (error) {
      throw new WorkflowPolicyError(`workflow journal contains invalid JSON on line ${index + 1}: ${errorMessage(error)}`);
    }
  }
  const header = records[0];
  if (header?.type !== "run" || header.journalVersion !== RUN_JOURNAL_VERSION) {
    throw new WorkflowPolicyError(`unsupported workflow journal version; expected ${RUN_JOURNAL_VERSION}`);
  }
  validateRunRecord(header);

  let effectiveMaxAgents = normalizeMaxAgents(header.maxAgents);
  let agentsUsed = 0;
  const agents = new Map<string, JournalAgentRecord>();
  const admittedPaths = new Set<string>();
  const admissionHashes = new Map<string, string>();
  const panelOpens = new Map<string, JournalPanelOpenRecord>();
  const openPanelBranches = new Map<string, Map<number, JournalPanelBranchRecord>>();
  const openPanelAdmissions = new Map<string, Set<string>>();
  const completePanels = new Map<string, JournalPanelRecord>();
  const panelBranches = new Map<string, Map<number, JournalPanelBranchRecord>>();
  const nestedSources = new Map<string, string>();
  const pendingDeliveries = new Map<string, JournalDeliveryStartRecord>();
  let generationTerminated = false;
  for (const record of records.slice(1)) {
    if (generationTerminated && record.type !== "resume") {
      throw new WorkflowPolicyError("workflow journal contains a record after a generation terminal result");
    }
    if (record.type === "resume") generationTerminated = false;
    switch (record.type) {
      case "resume": {
        if (!isNonNegativeFinite(record.startedAt)) invalidJournalRecord("resume");
        const next = normalizeMaxAgents(record.maxAgents);
        if (next < effectiveMaxAgents) {
          throw new WorkflowPolicyError("workflow journal contains a decreasing maxAgents resume record");
        }
        effectiveMaxAgents = next;
        break;
      }
      case "admit":
        if (
          !isNonEmptyString(record.callPath)
          || !isNonEmptyString(record.inputHash)
          || !Number.isInteger(record.ordinal)
          || record.ordinal < 1
        ) invalidJournalRecord("admission");
        if (
          admissionHashes.has(record.callPath)
          && admissionHashes.get(record.callPath) !== record.inputHash
        ) {
          throw new WorkflowPolicyError(`workflow journal has conflicting admissions for ${record.callPath}`);
        }
        for (const [panelPath, admissions] of openPanelAdmissions) {
          if (record.callPath.startsWith(`${panelPath}/`)) admissions.add(record.callPath);
        }
        agentsUsed++;
        admittedPaths.add(record.callPath);
        admissionHashes.set(record.callPath, record.inputHash);
        break;
      case "delivery-start":
        validateDeliveryStartRecord(record);
        if (pendingDeliveries.has(record.callPath) || agents.has(record.callPath)) {
          throw new WorkflowPolicyError(`workflow journal contains duplicate delivery start: ${record.callPath}`);
        }
        pendingDeliveries.set(record.callPath, record);
        break;
      case "agent":
        validateAgentRecord(record);
        if (agents.has(record.callPath)) {
          throw new WorkflowPolicyError(`workflow journal contains duplicate agent result: ${record.callPath}`);
        }
        assertDeliveryCompletionMatches(pendingDeliveries.get(record.callPath), record);
        agents.set(record.callPath, record);
        pendingDeliveries.delete(record.callPath);
        break;
      case "panel-open":
        if (
          !isNonEmptyString(record.callPath)
          || !isBoundedNonNegativeInteger(record.reserveAgents, 1024)
          || !isBoundedNonNegativeInteger(record.branchCount, 1024)
          || record.reserveAgents < record.branchCount
        ) {
          throw new WorkflowPolicyError("workflow journal contains an invalid panel-open record");
        }
        const prior = panelOpens.get(record.callPath);
        if (
          prior
          && (prior.reserveAgents !== record.reserveAgents || prior.branchCount !== record.branchCount)
        ) {
          throw new WorkflowPolicyError(`workflow journal has conflicting panel-open records at ${record.callPath}`);
        }
        panelOpens.set(record.callPath, record);
        completePanels.delete(record.callPath);
        panelBranches.set(record.callPath, new Map());
        openPanelBranches.set(record.callPath, new Map());
        openPanelAdmissions.set(record.callPath, new Set());
        break;
      case "panel-branch": {
        if (
          !isNonEmptyString(record.callPath)
          || !isBoundedNonNegativeInteger(record.branchIndex, 1023)
          || (record.outcome !== "success" && record.outcome !== "failed")
          || !validPanelCalls(record.calls)
        ) invalidJournalRecord("panel-branch");
        const panelOpen = panelOpens.get(record.callPath);
        if (!panelOpen || record.branchIndex >= panelOpen.branchCount) invalidJournalRecord("panel-branch");
        const branchPrefix = `${record.callPath}/b:${record.branchIndex}/`;
        if (
          record.calls.some((call) =>
            !call.callPath.startsWith(branchPrefix)
            || (call.status === "success" ? !agents.has(call.callPath) : !admittedPaths.has(call.callPath))
          )
        ) invalidJournalRecord("panel-branch");
        assertPanelBranchCoversDurableCalls(
          record,
          openPanelAdmissions.get(record.callPath),
          agents,
        );
        const current = openPanelBranches.get(record.callPath);
        if (!current || current.has(record.branchIndex)) invalidJournalRecord("panel-branch");
        current.set(record.branchIndex, record);
        const branches = panelBranches.get(record.callPath) ?? new Map<number, JournalPanelBranchRecord>();
        branches.set(record.branchIndex, record);
        panelBranches.set(record.callPath, branches);
        break;
      }
      case "panel-complete":
        if (
          !isNonEmptyString(record.callPath)
          || !isBoundedNonNegativeInteger(record.branchCount, 1024)
          || !Array.isArray(record.branchOutcomes)
          || record.branchOutcomes.length !== record.branchCount
          || record.branchOutcomes.some((outcome) => outcome !== "success" && outcome !== "failed")
          || !validPanelCalls(record.calls)
        ) {
          throw new WorkflowPolicyError("workflow journal contains an invalid panel record");
        }
        const panelOpen = panelOpens.get(record.callPath);
        if (!panelOpen || panelOpen.branchCount !== record.branchCount) invalidJournalRecord("panel");
        if (record.calls.some((call) => {
          let inBranch = false;
          for (let index = 0; index < record.branchCount; index++) {
            if (call.callPath.startsWith(`${record.callPath}/b:${index}/`)) {
              inBranch = true;
              break;
            }
          }
          return !inBranch
            || (call.status === "success" ? !agents.has(call.callPath) : !admittedPaths.has(call.callPath));
        })) invalidJournalRecord("panel");
        const currentBranches = openPanelBranches.get(record.callPath);
        for (const branch of currentBranches?.values() ?? []) {
          assertPanelBranchCoversDurableCalls(
            branch,
            openPanelAdmissions.get(record.callPath),
            agents,
          );
        }
        assertPanelCompletionMatchesBranches(record, currentBranches);
        openPanelBranches.delete(record.callPath);
        openPanelAdmissions.delete(record.callPath);
        completePanels.set(record.callPath, record);
        break;
      case "nested-source": {
        if (!isNonEmptyString(record.callPath) || !isNonEmptyString(record.sourceHash)) {
          throw new WorkflowPolicyError("workflow journal contains an invalid nested-source record");
        }
        const prior = nestedSources.get(record.callPath);
        if (prior !== undefined && prior !== record.sourceHash) {
          throw new WorkflowPolicyError(`workflow journal has conflicting nested source at ${record.callPath}`);
        }
        nestedSources.set(record.callPath, record.sourceHash);
        break;
      }
      case "result":
        validateResultRecord(record);
        generationTerminated = true;
        break;
      case "run":
        throw new WorkflowPolicyError("workflow journal contains more than one run header");
      default:
        throw new WorkflowPolicyError("workflow journal contains an unknown record type");
    }
  }
  for (const [panelPath, branches] of openPanelBranches) {
    for (const branch of branches.values()) {
      assertPanelBranchCoversDurableCalls(branch, openPanelAdmissions.get(panelPath), agents);
    }
  }
  if (agentsUsed > effectiveMaxAgents) {
    throw new WorkflowPolicyError(
      `workflow journal used ${agentsUsed} agents, exceeding maxAgents=${effectiveMaxAgents}`,
    );
  }
  for (const [callPath, agent] of agents) {
    if (!admittedPaths.has(callPath)) {
      throw new WorkflowPolicyError(`workflow journal contains an agent result without admission: ${callPath}`);
    }
    if (admissionHashes.get(callPath) !== agent.key) {
      throw new WorkflowPolicyError(`workflow journal agent input does not match admission: ${callPath}`);
    }
  }
  return {
    header,
    bytes: Buffer.byteLength(content, "utf8"),
    effectiveMaxAgents,
    agentsUsed,
    agents,
    admittedPaths,
    admissionHashes,
    panelOpens,
    completePanels,
    panelBranches,
    nestedSources,
    pendingDeliveries,
  };
}

function validateJournalRecordForWrite(record: JournalRecord): void {
  switch (record.type) {
    case "run":
      validateRunRecord(record);
      return;
    case "resume":
      validateResumeRecord(record);
      return;
    case "admit":
      if (
        !isNonEmptyString(record.callPath)
        || !isNonEmptyString(record.inputHash)
        || !Number.isSafeInteger(record.ordinal)
        || record.ordinal < 1
      ) invalidJournalRecord("admission");
      return;
    case "panel-open":
      if (
        !isNonEmptyString(record.callPath)
        || !isBoundedNonNegativeInteger(record.reserveAgents, 1024)
        || !isBoundedNonNegativeInteger(record.branchCount, 1024)
        || record.reserveAgents < record.branchCount
      ) invalidJournalRecord("panel-open");
      return;
    case "panel-branch":
      if (
        !isNonEmptyString(record.callPath)
        || !isBoundedNonNegativeInteger(record.branchIndex, 1023)
        || (record.outcome !== "success" && record.outcome !== "failed")
        || !validPanelCalls(record.calls)
      ) invalidJournalRecord("panel-branch");
      return;
    case "panel-complete":
      if (
        !isNonEmptyString(record.callPath)
        || !isBoundedNonNegativeInteger(record.branchCount, 1024)
        || !Array.isArray(record.branchOutcomes)
        || record.branchOutcomes.length !== record.branchCount
        || record.branchOutcomes.some((outcome) => outcome !== "success" && outcome !== "failed")
        || !validPanelCalls(record.calls)
      ) invalidJournalRecord("panel");
      return;
    case "nested-source":
      if (!isNonEmptyString(record.callPath) || !isNonEmptyString(record.sourceHash)) {
        invalidJournalRecord("nested-source");
      }
      return;
    case "delivery-start":
      validateDeliveryStartRecord(record);
      return;
    case "agent":
      validateAgentRecord(record);
      return;
    case "result":
      validateResultRecord(record);
      return;
  }
}

function validateResumeRecord(record: JournalResumeRecord): void {
  if (!isNonNegativeFinite(record.startedAt)) invalidJournalRecord("resume");
  normalizeMaxAgents(record.maxAgents);
}

function validateRunRecord(record: JournalRunMeta): void {
  if (
    !isNonEmptyString(record.runId)
    || !isNonEmptyString(record.name)
    || !isNonEmptyString(record.scriptHash)
    || !isNonNegativeFinite(record.startedAt)
    || typeof record.projectTrusted !== "boolean"
    || !isNonEmptyString(record.targetIdentity)
  ) invalidJournalRecord("run header");
  if (record.journalVersion !== undefined && record.journalVersion !== RUN_JOURNAL_VERSION) {
    invalidJournalRecord("run header");
  }
  try {
    normalizeMaxAgents(record.maxAgents);
    assertWorkflowArgsLimit(record.args);
  } catch {
    invalidJournalRecord("run header");
  }
}

function validateDeliveryStartRecord(record: JournalDeliveryStartRecord): void {
  if (
    !isNonEmptyString(record.callPath)
    || !isNonEmptyString(record.patchPath)
    || !isNonEmptyString(record.patchHash)
  ) invalidJournalRecord("delivery-start");
}

function assertDeliveryCompletionMatches(
  pending: JournalDeliveryStartRecord | undefined,
  agent: JournalAgentRecord,
): void {
  const hasPath = agent.deliveryPatchPath !== undefined;
  const hasHash = agent.deliveryPatchHash !== undefined;
  if (hasPath !== hasHash) invalidJournalRecord("agent delivery completion");
  if (!pending) {
    if (hasPath) invalidJournalRecord("agent delivery completion");
    return;
  }
  if (
    agent.deliveryPatchPath !== pending.patchPath
    || agent.deliveryPatchHash !== pending.patchHash
  ) {
    throw new WorkflowPolicyError(`workflow journal agent delivery does not match intent: ${agent.callPath}`);
  }
}

function validateAgentRecord(record: JournalAgentRecord): void {
  const integerFields: Array<keyof JournalAgentRecord> = [
    "seq",
    "outputTokens",
    "inputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "turns",
    "toolUses",
    "retries",
    "compactions",
    "startedAt",
    "durationMs",
  ];
  if (
    !isNonEmptyString(record.callPath)
    || !isNonEmptyString(record.key)
    || typeof record.label !== "string"
    || !Object.hasOwn(record, "value")
    || !Number.isSafeInteger(record.seq)
    || record.seq < 1
    || !Number.isSafeInteger(record.outputTokens)
    || record.outputTokens < 0
  ) invalidJournalRecord("agent");
  for (const field of integerFields) {
    const value = record[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
      invalidJournalRecord("agent");
    }
  }
  if (record.cost !== undefined && !isNonNegativeFinite(record.cost)) invalidJournalRecord("agent");
  for (const field of [
    "requestedModelId",
    "requestedEffort",
    "modelId",
    "effort",
    "agentType",
    "isolation",
    "deliveryPatchPath",
    "deliveryPatchHash",
    "transcriptPath",
  ] as const) {
    if (record[field] !== undefined && typeof record[field] !== "string") invalidJournalRecord("agent");
  }
  if (record.structuredOutput !== undefined && typeof record.structuredOutput !== "boolean") {
    invalidJournalRecord("agent");
  }
  try {
    assertWorkflowOutputLimit(record.value, "workflow agent output");
  } catch {
    invalidJournalRecord("agent");
  }
}

function validateResultRecord(record: JournalResultRecord): void {
  if (
    typeof record.ok !== "boolean"
    || !Number.isInteger(record.agentCount)
    || record.agentCount < 0
    || !isNonNegativeFinite(record.durationMs)
  ) invalidJournalRecord("result");
  if (record.ok) {
    if (!Object.hasOwn(record, "result")) invalidJournalRecord("result");
    try {
      assertWorkflowOutputLimit(record.result);
    } catch {
      invalidJournalRecord("result");
    }
  } else if (typeof record.error !== "string") {
    invalidJournalRecord("result");
  }
}

function assertPanelBranchCoversDurableCalls(
  record: JournalPanelBranchRecord,
  generationAdmissions: Set<string> | undefined,
  agents: Map<string, JournalAgentRecord>,
): void {
  if (!generationAdmissions) invalidJournalRecord("panel-branch");
  const prefix = `${record.callPath}/b:${record.branchIndex}/`;
  const calls = new Map(record.calls.map((call) => [call.callPath, call.status]));
  if (calls.size !== record.calls.length) invalidJournalRecord("panel-branch");
  for (const callPath of generationAdmissions) {
    if (!callPath.startsWith(prefix)) continue;
    const expected = agents.has(callPath) ? "success" : "failed";
    if (calls.get(callPath) !== expected) invalidJournalRecord("panel-branch");
  }
}

function assertPanelCompletionMatchesBranches(
  record: JournalPanelRecord,
  branches: Map<number, JournalPanelBranchRecord> | undefined,
): void {
  if (!branches || branches.size !== record.branchCount) invalidJournalRecord("panel");
  const expectedCalls = new Map<string, "success" | "failed">();
  for (let index = 0; index < record.branchCount; index++) {
    const branch = branches.get(index);
    if (!branch || branch.outcome !== record.branchOutcomes[index]) invalidJournalRecord("panel");
    for (const call of branch.calls) {
      if (expectedCalls.has(call.callPath)) invalidJournalRecord("panel");
      expectedCalls.set(call.callPath, call.status);
    }
  }
  if (record.calls.length !== expectedCalls.size) invalidJournalRecord("panel");
  const seen = new Set<string>();
  for (const call of record.calls) {
    if (seen.has(call.callPath) || expectedCalls.get(call.callPath) !== call.status) {
      invalidJournalRecord("panel");
    }
    seen.add(call.callPath);
  }
}

function validPanelCalls(
  value: unknown,
): value is Array<{ callPath: string; status: "success" | "failed" }> {
  return Array.isArray(value) && value.every((call) =>
    !!call
    && isNonEmptyString(call.callPath)
    && (call.status === "success" || call.status === "failed")
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBoundedNonNegativeInteger(value: unknown, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

function invalidJournalRecord(kind: string): never {
  throw new WorkflowPolicyError(`workflow journal contains an invalid ${kind} record`);
}

function readAndRepairJournal(filePath: string): string {
  let content = readArtifactFile(filePath, "workflow journal", MAX_JOURNAL_BYTES);
  if (!content || content.endsWith("\n")) return content;
  const lastNewline = content.lastIndexOf("\n");
  const tail = content.slice(lastNewline + 1);
  if (!tail.trim()) {
    truncateRegularFile(filePath, Buffer.byteLength(content.slice(0, lastNewline + 1), "utf8"));
    return content.slice(0, lastNewline + 1);
  }
  try {
    JSON.parse(tail);
  } catch (error) {
    if (lastNewline < 0) {
      throw new WorkflowPolicyError(`workflow journal contains invalid JSON on line 1: ${errorMessage(error)}`);
    }
    const repaired = content.slice(0, lastNewline + 1);
    truncateRegularFile(filePath, Buffer.byteLength(repaired, "utf8"));
    return repaired;
  }
  if (Buffer.byteLength(content, "utf8") + 1 > MAX_JOURNAL_BYTES) {
    throw new WorkflowPolicyError(
      `workflow journal full: terminating the final record would exceed the ${MAX_JOURNAL_BYTES}-byte cap`,
    );
  }
  appendRegularFile(filePath, "\n");
  content += "\n";
  return content;
}

function truncateRegularFile(filePath: string, bytes: number): void {
  assertRegularArtifactFile(filePath, "workflow journal");
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | NO_FOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new WorkflowPolicyError("workflow journal must be a regular file");
    fs.ftruncateSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function appendRegularFile(filePath: string, value: string): void {
  const fd = openAppendRegular(filePath);
  try {
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function openAppendRegular(filePath: string): number {
  assertRegularArtifactFile(filePath, "workflow journal");
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND | NO_FOLLOW);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) {
    fs.closeSync(fd);
    throw new WorkflowPolicyError("workflow journal must be a regular file");
  }
  return fd;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Deterministic JSON stringify (sorted keys) for stable hashing and immutable args. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
