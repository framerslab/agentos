/**
 * @file launchRegistry.ts
 * The launches in flight, process-wide (module scope). An entry holds its tree's limits, its budget, its
 * gate, its signal, its seats' tool names and the hooks its launch carried, so a nested launch from any seat of the
 * tree (a separate gmi() handle, a host's member, a runtime GMI) reads them from the frame its turn carries.
 * Admission is a synchronous check-and-insert. A root scope's turn draws all its launches on one pool.
 * @internal
 */
import type { ApprovalGateFn } from '../approval-gate.js';
import { SpendBudget } from '../spendBudget.js';
import type { LaunchLimits, ToolCallHook } from './types.js';

/** One launch in flight. */
export interface LaunchEntry {
  /** The launch's id, which is the team's agencyId. */
  launchId: string;
  /** The team's level. */
  depth: number;
  /** The root launch's limits. */
  limits: LaunchLimits;
  /**
   * The parent launch's id for a nested launch; at the root, the surface and the launching session as its host names
   * it (`${surface}:${scopeId}`), never the calling GMI.
   */
  scopeKey: string;
  /** This launch's budget. */
  budget: SpendBudget;
  /** The gate the launching turn carried. */
  approvalGate?: ApprovalGateFn;
  /** Aborts at the deadline or the parent's stop. */
  signal: AbortSignal;
  /** The user id the tree's root turn named; unset when it named none. */
  providerUserId?: string;
  /**
   * The tree's namespace: the root agent's learning namespace on gmi(), the root turn's organization on the full
   * runtime; '' for none.
   */
  namespace: string;
  /** The hooks the launching turn ran under. */
  toolHooks: readonly ToolCallHook[];
  /** Each seat's tool names, by role: a nested launch's parent tool names. */
  seatTools: Map<string, ReadonlySet<string>>;
  /** The output tokens one call of the tree's route is counted with. */
  outputEstimateTokens: number;
  /** 'closing': the run outlived the grace, or its seats are not released yet; admits nothing under it and still counts. */
  state: 'running' | 'closing';
}

/** The most root scopes whose launch pool is kept; the least recently used goes first. */
const MAX_POOL_SCOPES = 10_000;
const entries = new Map<string, LaunchEntry>();
const pools = new Map<string, { turnId: string | undefined; budget: SpendBudget }>();

/** The launches in flight, by launch id, and each root scope's launch pool. */
export const launchRegistry = {
  /** Inserts the entry unless its scope has `limits.maxConcurrent` running or closing entries already. Synchronous. */
  admit(entry: LaunchEntry): { ok: true } | { ok: false; inFlight: number } {
    let inFlight = 0;
    for (const other of entries.values()) if (other.scopeKey === entry.scopeKey) inFlight += 1;
    if (inFlight >= entry.limits.maxConcurrent) return { ok: false, inFlight };
    entries.set(entry.launchId, entry);
    return { ok: true };
  },

  /**
   * The launch pool of a root scope's current turn: made at the turn's first root launch with the tree's
   * `maxLaunchTokens` and `maxLaunchCostUSD` (no dollar cap: Infinity), `unpriced: 'allow'` and the turn's budget, when
   * it has one, as its parent, and replaced when a launch comes from a later turn id; a call with no turn id shares the
   * scope's current pool. A session runs one turn at a time, so a root scope's current turn is the only one that draws
   * on it.
   */
  rootPool(scopeKey: string, turnId: string | undefined, limits: LaunchLimits, turnBudget?: SpendBudget): SpendBudget {
    const current = pools.get(scopeKey);
    pools.delete(scopeKey);
    if (current && (turnId === undefined || current.turnId === turnId)) {
      pools.set(scopeKey, current);
      return current.budget;
    }
    const budget = new SpendBudget({
      maxCostUSD: limits.maxLaunchCostUSD ?? Number.POSITIVE_INFINITY,
      maxTotalTokens: limits.maxLaunchTokens,
      unpriced: 'allow',
      ...(turnBudget ? { parent: turnBudget } : {}),
    });
    pools.set(scopeKey, { turnId, budget });
    while (pools.size > MAX_POOL_SCOPES) {
      const oldest = pools.keys().next().value;
      if (oldest === undefined) break;
      pools.delete(oldest);
    }
    return budget;
  },

  /** The launch's entry while it is in flight. */
  get(launchId: string): LaunchEntry | undefined {
    return entries.get(launchId);
  },

  /** Marks the launch's entry closing; an unknown id changes nothing. */
  markClosing(launchId: string): void {
    const entry = entries.get(launchId);
    if (entry) entry.state = 'closing';
  },

  /** Removes the launch's entry, which frees its place in its scope; an unknown id changes nothing. */
  remove(launchId: string): void {
    entries.delete(launchId);
  },
};
