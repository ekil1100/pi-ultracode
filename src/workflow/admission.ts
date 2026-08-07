export const DEFAULT_MAX_AGENTS = 128;
export const ABSOLUTE_MAX_AGENTS = 1024;
export const MAX_ACTIVE_WORKFLOWS_PER_SESSION = 4;

export const WORKFLOW_POLICY_ERROR_CODE = "WORKFLOW_POLICY_ERROR";
export const WORKFLOW_ABORT_ERROR_CODE = "WORKFLOW_ABORTED";
export const WORKFLOW_STALL_ERROR_CODE = "WORKFLOW_STALLED";
export const WORKFLOW_CLEANUP_TIMEOUT_ERROR_CODE = "WORKFLOW_CLEANUP_TIMEOUT";

export class WorkflowPolicyError extends Error {
  readonly code = WORKFLOW_POLICY_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "WorkflowPolicyError";
  }
}

export class WorkflowAbortError extends Error {
  readonly code = WORKFLOW_ABORT_ERROR_CODE;

  constructor(message = "workflow aborted") {
    super(message);
    this.name = "WorkflowAbortError";
  }
}

export class WorkflowStallError extends Error {
  readonly code = WORKFLOW_STALL_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "WorkflowStallError";
  }
}

export class WorkflowCleanupTimeoutError extends Error {
  readonly code = WORKFLOW_CLEANUP_TIMEOUT_ERROR_CODE;

  constructor(timeoutMs: number) {
    super(`workflow cleanup did not drain within ${timeoutMs}ms`);
    this.name = "WorkflowCleanupTimeoutError";
  }
}

export function isWorkflowPolicyError(error: unknown): error is WorkflowPolicyError {
  return !!error && typeof error === "object" && (error as any).code === WORKFLOW_POLICY_ERROR_CODE;
}

export function isWorkflowAbortError(error: unknown): error is WorkflowAbortError {
  return !!error && typeof error === "object" && (error as any).code === WORKFLOW_ABORT_ERROR_CODE;
}

export function isWorkflowStallError(error: unknown): error is WorkflowStallError {
  return !!error && typeof error === "object" && (error as any).code === WORKFLOW_STALL_ERROR_CODE;
}

export function isWorkflowCleanupTimeoutError(error: unknown): error is WorkflowCleanupTimeoutError {
  return !!error && typeof error === "object" && (error as any).code === WORKFLOW_CLEANUP_TIMEOUT_ERROR_CODE;
}

export function normalizeMaxAgents(value: unknown, name = "maxAgents"): number {
  if (value === undefined || value === null) return DEFAULT_MAX_AGENTS;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new WorkflowPolicyError(`workflow ${name} must be an integer between 1 and ${ABSOLUTE_MAX_AGENTS}`);
  }
  if (value < 1 || value > ABSOLUTE_MAX_AGENTS) {
    throw new WorkflowPolicyError(`workflow ${name} must be between 1 and ${ABSOLUTE_MAX_AGENTS} (got ${value})`);
  }
  return value;
}

export function normalizeReservationSize(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > ABSOLUTE_MAX_AGENTS) {
    throw new WorkflowPolicyError(`parallel reserveAgents must be an integer between 0 and ${ABSOLUTE_MAX_AGENTS}`);
  }
  return value;
}

interface SlotEntry {
  /**
   * Return path for an unused slot. The first live reservation in this stack gets
   * the slot back; if none remain, the slot returns to root capacity. This lets a
   * nested panel transfer a sibling's branch slot without permanently stealing it
   * from its immediate parent, while still preserving the parent's own upstream
   * return path when that parent is released later.
   */
  returnStack: string[];
}

interface Reservation {
  id: string;
  slots: SlotEntry[];
  contingentSlots: number;
  contingentParentIds: string[];
  released: boolean;
}

export interface PanelReservation {
  panelReservationId: string;
  branchReservationIds: string[];
}

export class AgentAdmission {
  readonly maxAgents: number;
  private rootFree: number;
  private consumed = 0;
  private nextReservation = 0;
  private readonly reservations = new Map<string, Reservation>();

  constructor(maxAgents: number, usedAgents = 0) {
    this.maxAgents = normalizeMaxAgents(maxAgents);
    if (!Number.isInteger(usedAgents) || usedAgents < 0 || usedAgents > this.maxAgents) {
      throw new WorkflowPolicyError(
        `workflow usedAgents must be an integer between 0 and maxAgents=${this.maxAgents}`,
      );
    }
    this.consumed = usedAgents;
    this.rootFree = this.maxAgents - usedAgents;
  }

  get usedAgents(): number {
    return this.consumed;
  }

  get availableAgents(): number {
    return this.rootFree;
  }

  reservePanel(requestedSlots: number, parentReservationIds: string[] = []): string {
    const slots = normalizeReservationSize(requestedSlots, requestedSlots);
    const parents = this.uniqueReservations(parentReservationIds);
    const parentFree = parents.reduce((sum, reservation) => sum + reservation.slots.length, 0);
    const totalFree = parentFree + this.rootFree;
    if (totalFree < slots) {
      throw new WorkflowPolicyError(
        `parallel() needs ${slots} agent slot(s), but only ${totalFree} remain under maxAgents=${this.maxAgents}`,
      );
    }

    const entries: SlotEntry[] = [];
    let remaining = slots;
    for (const parent of parents) {
      while (remaining > 0 && parent.slots.length > 0) {
        const slot = parent.slots.shift()!;
        entries.push({ returnStack: [parent.id, ...slot.returnStack] });
        remaining--;
      }
      if (remaining === 0) break;
    }
    if (remaining > 0) {
      this.rootFree -= remaining;
      for (let i = 0; i < remaining; i++) entries.push({ returnStack: [] });
    }

    return this.createReservation(entries).id;
  }

  reservePanelWithBranchNeeds(
    requestedSlots: number,
    branchNeedsSlot: boolean[],
    parentReservationIds: string[] = [],
    contingentSlots = 0,
  ): PanelReservation {
    const branchCount = branchNeedsSlot.length;
    const requiredBranches = branchNeedsSlot.filter(Boolean).length;
    const slots = normalizeReservationSize(requestedSlots, requestedSlots);
    if (branchCount > ABSOLUTE_MAX_AGENTS) {
      throw new WorkflowPolicyError(`parallel branch count must be at most ${ABSOLUTE_MAX_AGENTS}`);
    }
    if (slots < requiredBranches) {
      throw new WorkflowPolicyError(
        `parallel replay needs at least ${requiredBranches} live branch slot(s); got ${slots}`,
      );
    }
    const contingent = normalizeReservationSize(contingentSlots, contingentSlots);
    const panelReservationId = this.reservePanel(slots, parentReservationIds);
    const panelReservation = this.requireReservation(panelReservationId);
    panelReservation.contingentSlots = contingent;
    panelReservation.contingentParentIds = [...parentReservationIds];
    const branchReservationIds: string[] = [];
    try {
      for (const needsSlot of branchNeedsSlot) {
        branchReservationIds.push(this.reservePanel(needsSlot ? 1 : 0, [panelReservationId]));
      }
      return { panelReservationId, branchReservationIds };
    } catch (error) {
      for (const id of branchReservationIds) this.releasePanel(id);
      this.releasePanel(panelReservationId);
      throw error;
    }
  }

  reservePanelWithBranches(
    requestedSlots: number,
    branchCount: number,
    parentReservationIds: string[] = [],
  ): PanelReservation {
    const slots = normalizeReservationSize(requestedSlots, requestedSlots);
    if (!Number.isInteger(branchCount) || branchCount < 0 || branchCount > ABSOLUTE_MAX_AGENTS) {
      throw new WorkflowPolicyError(`parallel branch count must be an integer between 0 and ${ABSOLUTE_MAX_AGENTS}`);
    }
    if (slots < branchCount) {
      throw new WorkflowPolicyError(
        `parallel reserveAgents must be at least the number of thunks (${branchCount}); got ${slots}`,
      );
    }

    const panelReservationId = this.reservePanel(slots, parentReservationIds);
    const branchReservationIds: string[] = [];
    try {
      for (let i = 0; i < branchCount; i++) {
        branchReservationIds.push(this.reservePanel(1, [panelReservationId]));
      }
      return { panelReservationId, branchReservationIds };
    } catch (error) {
      for (const id of branchReservationIds) this.releasePanel(id);
      this.releasePanel(panelReservationId);
      throw error;
    }
  }

  releasePanel(id: string): void {
    const reservation = this.reservations.get(id);
    if (!reservation || reservation.released) return;
    reservation.released = true;
    for (const slot of reservation.slots) this.returnSlot(slot);
    reservation.slots = [];
    this.reservations.delete(id);
  }

  consumeAgent(reservationIds: string[] = []): number {
    const reservations = this.uniqueReservations(reservationIds);
    for (const reservation of reservations) {
      if (reservation.slots.length > 0) {
        reservation.slots.shift();
        this.consumed++;
        return this.consumed;
      }
    }
    for (const reservation of reservations) {
      if (reservation.contingentSlots > 0 && this.acquireContingentSlot(reservation)) {
        reservation.contingentSlots--;
        this.consumed++;
        return this.consumed;
      }
    }
    if (reservationIds.length > 0) {
      throw new WorkflowPolicyError(
        "parallel() reservation has no agent slots left; increase reserveAgents for this panel or lower fan-out",
      );
    }
    if (this.rootFree < 1) {
      throw new WorkflowPolicyError(`workflow exceeded maxAgents=${this.maxAgents} (no agent slots remain)`);
    }
    this.rootFree--;
    this.consumed++;
    return this.consumed;
  }

  private createReservation(slots: SlotEntry[]): Reservation {
    const id = `res_${++this.nextReservation}`;
    const reservation: Reservation = {
      id,
      slots,
      contingentSlots: 0,
      contingentParentIds: [],
      released: false,
    };
    this.reservations.set(id, reservation);
    return reservation;
  }

  private uniqueReservations(ids: string[]): Reservation[] {
    const out: Reservation[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(this.requireReservation(id));
    }
    return out;
  }

  private requireReservation(id: string): Reservation {
    const reservation = this.reservations.get(id);
    if (!reservation || reservation.released) {
      throw new WorkflowPolicyError(`unknown or expired parallel reservation: ${id}`);
    }
    return reservation;
  }

  private acquireContingentSlot(reservation: Reservation): boolean {
    for (const parent of this.uniqueReservations(reservation.contingentParentIds)) {
      if (parent.slots.length === 0) continue;
      parent.slots.shift();
      return true;
    }
    if (this.rootFree < 1) return false;
    this.rootFree--;
    return true;
  }

  private returnSlot(slot: SlotEntry): void {
    const [targetId, ...rest] = slot.returnStack;
    if (!targetId) {
      this.rootFree++;
      return;
    }
    const target = this.reservations.get(targetId);
    if (target && !target.released) {
      target.slots.push({ returnStack: rest });
      return;
    }
    this.returnSlot({ returnStack: rest });
  }
}
