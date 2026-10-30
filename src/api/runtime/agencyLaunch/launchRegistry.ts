/**
 * @file launchRegistry.ts
 * The launches in flight, process-wide (module scope). An entry holds its tree's limits, its budget, its
 * gate, its signal, its seats' tool names and the hooks its launch carried, so a nested launch from any seat of the
 * tree (a separate gmi() handle, a host's member, a runtime GMI) reads them from the frame its turn carries.
 * Admission is a synchronous check-and-insert. A root scope's turn draws all its launches on one pool.
 * @internal
 */
import { createContentSafeConsole } from '../../../core/logging/contentSafeConsole.js';
import type { ApprovalGateFn } from '../approval-gate.js';
import { SpendBudget } from '../spendBudget.js';
import type { LaunchLimits, ToolCallHook } from './types.js';

/** This module's fixed diagnostic origin (the launch's); no runtime name enters telemetry. */
const console = createContentSafeConsole('gmi_launch_tool');

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
  /**
   * The output tokens one call of this launch's seats is counted with; a launch nested under it counts this when its
   * host counts none of its own.
   */
  outputEstimateTokens: number;
  /**
   * 'closing': the run outlived the grace, or its seats, or those of a launch nested under it, are not released yet;
   * admits nothing under it and still counts.
   */
  state: 'running' | 'closing';
}

/**
 * The most root scopes whose launch pool the registry keeps by scope (a host that names no owner for its turns'
 * pools). Past it, the least recently used scope with no launch in flight loses its pool: a scope whose turn is still
 * launching keeps it, so all that turn's launches draw on one pool; a turn between two launches can lose it.
 */
export const MAX_POOL_SCOPES = 10_000;
const entries = new Map<string, LaunchEntry>();
const pools = new Map<string, { turnId: string | undefined; budget: SpendBudget }>();
/**
 * The pools of the turns whose host names an owner (on gmi(), the GMI that runs the turn), by that owner: a pool lasts
 * as long as its owner, so no bound drops it while its turn can still launch, and it goes with the owner.
 */
const ownedPools = new WeakMap<object, { scopeKey: string; turnId: string | undefined; budget: SpendBudget }>();

/** A root scope's new launch pool, under the tree's limits and the turn's budget when it has one. */
function newPool(limits: LaunchLimits, turnBudget: SpendBudget | undefined): SpendBudget {
  return new SpendBudget({
    maxCostUSD: limits.maxLaunchCostUSD ?? Number.POSITIVE_INFINITY,
    maxTotalTokens: limits.maxLaunchTokens,
    unpriced: 'allow',
    ...(turnBudget ? { parent: turnBudget } : {}),
  });
}
/** The pools dropped so far, for the warning about them: the first drop, then every thousandth. */
let droppedPools = 0;

/** Drops the least recently used pools past {@link MAX_POOL_SCOPES}, keeping `current` and every scope in flight. */
function dropIdlePools(current?: string): void {
  // The scopes with a launch in flight (their running and closing entries' scope keys).
  const busy = new Set<string>();
  for (const entry of entries.values()) busy.add(entry.scopeKey);
  for (const scope of pools.keys()) {
    if (pools.size <= MAX_POOL_SCOPES) return;
    if (scope === current || busy.has(scope)) continue;
    pools.delete(scope);
    droppedPools += 1;
    if (droppedPools === 1 || droppedPools % 1_000 === 0) {
      console.warn(
        `[agentos] launch_agency: ${droppedPools} launch pool(s) dropped so far, past ${MAX_POOL_SCOPES} root scopes; a scope that launches again starts a new pool.`,
      );
    }
  }
}
/** What waits for an entry's removal, by launch id. */
const removalWaiters = new Map<string, Array<() => void>>();

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
   * on it. With an `owner` (an object that lives as long as the GMI that runs the turn), the owner keeps the pool,
   * however many other scopes launch meanwhile. Without one, the registry keeps it by scope: past
   * {@link MAX_POOL_SCOPES} scopes, the least recently used scope with no launch in flight loses its pool, with a
   * warning.
   */
  rootPool(scopeKey: string, turnId: string | undefined, limits: LaunchLimits, turnBudget?: SpendBudget, owner?: object): SpendBudget {
    if (owner) {
      const held = ownedPools.get(owner);
      if (held && held.scopeKey === scopeKey && (turnId === undefined || held.turnId === turnId)) return held.budget;
      const budget = newPool(limits, turnBudget);
      ownedPools.set(owner, { scopeKey, turnId, budget });
      return budget;
    }
    const current = pools.get(scopeKey);
    pools.delete(scopeKey);
    if (current && (turnId === undefined || current.turnId === turnId)) {
      pools.set(scopeKey, current);
      return current.budget;
    }
    const budget = newPool(limits, turnBudget);
    pools.set(scopeKey, { turnId, budget });
    if (pools.size > MAX_POOL_SCOPES) dropIdlePools(scopeKey);
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

  /** The launches in flight that the seats of a launch started: the entries whose scope is that launch. */
  nestedUnder(launchId: string): LaunchEntry[] {
    return [...entries.values()].filter((entry) => entry.scopeKey === launchId);
  },

  /** Resolves once the launch's entry is removed; at once for an id that has no entry. */
  whenRemoved(launchId: string): Promise<void> {
    if (!entries.has(launchId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiting = removalWaiters.get(launchId);
      if (waiting) waiting.push(resolve);
      else removalWaiters.set(launchId, [resolve]);
    });
  },

  /**
   * Removes the launch's entry, which frees its place in its scope; an unknown id changes nothing. A registry past
   * {@link MAX_POOL_SCOPES} while busy scopes kept their pools is brought back to the bound as their launches end.
   */
  remove(launchId: string): void {
    entries.delete(launchId);
    if (pools.size > MAX_POOL_SCOPES) dropIdlePools();
    const waiting = removalWaiters.get(launchId);
    removalWaiters.delete(launchId);
    for (const resolve of waiting ?? []) resolve();
  },
};
