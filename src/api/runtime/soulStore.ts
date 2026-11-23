/**
 * @fileoverview What `souledAgent()` hands the `gmi()` it builds: the soul's store, read by the options object the
 * agent was built from, as the tombstone ledger is handed to the learning layer (`shareForgottenLedger`). And what
 * `gmi()` hands back for a deletion: each open session's evictor, by the session object, which the agent's mind side
 * ({@link SoulMind}) calls to empty the sessions of a person it deletes, and each open session's trace dropper, which it
 * calls to drop traces a correction or a retention sweep deleted; the mind side also deletes a person's rows through
 * the cognitive memory managers `gmi()` built on the soul's store.
 *
 * Internal: exported from neither the package root nor the API index, and no host-facing option.
 *
 * @module agentos/api/runtime/soulStore
 * @internal
 */
import type { AgentSession, MemoryHookContext } from '../agent.js';
import { memoryLog } from '../../cognition/memory/log.js';
import { errorFields } from '../../core/logging/events.js';
import type { IMemoryArchive } from '../../cognition/memory/archive/IMemoryArchive.js';
import type { ICognitiveMemoryManager } from '../../cognition/memory/CognitiveMemoryManager.js';
import type { CognitiveMechanismsConfig } from '../../cognition/memory/mechanisms/types.js';
import type { Brain } from '../../cognition/memory/retrieval/store/Brain.js';
import type { SoulTurnMemory } from '../../cognition/substrate/soulTurnMemory.js';

/** A souled agent's store, as `gmi()` reads it. */
export interface SoulStore {
  /** The soul's one id. */
  agentId: string;
  /** Whether a session turn sends the end user's id to the model provider (`SouledAgentOptions.sendUserIdToProvider`). */
  sendUserIdToProvider: boolean;
  /**
   * One session turn's view of the soul's memory rules, from the context its hooks are given; undefined for a turn
   * that names no subject. A subject whose id no memory key can be built from gets a view with no scope that allows
   * nothing.
   */
  forTurn(context: MemoryHookContext): SoulTurnMemory | undefined;
  /**
   * The soul's own store, where the agent's cognitive memory files and reads: the Brain of the agent's `Memory`.
   * Absent on the plain agent an inline soul or a soul that did not load builds, which keeps no store; its cognitive
   * memory stays its GMI's own.
   */
  brain?: Brain;
  /** The mechanisms the agent's cognitive memory runs on that store, in place of the ones its options resolve to. */
  mechanisms: CognitiveMechanismsConfig | undefined;
  /** Told of each cognitive memory manager `gmi()` built on {@link brain}, once it is built. */
  memoryBuilt(manager: ICognitiveMemoryManager): void;
  /** Told of each such manager once `gmi()` has shut it down. */
  memoryClosed(manager: ICognitiveMemoryManager): void;
  /**
   * Waits for the filings the agent's finished turns started and the mind has not stored yet, within what is left of
   * the agent's close deadline (`pendingWritesTimeoutMs`); `agent.close()` calls it before the manager shuts down, so
   * no write still running reaches a manager that is shut. Never rejects.
   */
  drainWrites(): Promise<void>;
}

/** The stores handed over by options object, each held for as long as its options object is. */
const sharedStores = new WeakMap<object, SoulStore>();

/**
 * Hands a souled agent's store to the `gmi()` built from the same options object. Held weakly.
 *
 * @internal
 */
export function shareSoulStore(options: object, store: SoulStore): void {
  sharedStores.set(options, store);
}

/**
 * The store shared for these options, if any.
 *
 * @internal
 */
export function sharedSoulStoreOf(options: object): SoulStore | undefined {
  return sharedStores.get(options);
}

/** The longest delay a timer takes; a longer deadline is held to it. */
const LONGEST_TIMER_MS = 2_147_483_647;

/** How a deletion left one open session: emptied, or still running a turn when the deadline passed. */
export type SessionEviction = 'evicted' | 'running';

/**
 * Empties one open session of what it holds of its person, waiting at most `deadlineMs` for a turn the session is
 * running, and not at all when it is called from that turn's own hook or tool. `'running'` when the turn outlasted
 * the wait: the session is then emptied once that turn ends.
 */
export type SessionEvictor = (deadlineMs: number) => Promise<SessionEviction>;

/** The evictor of each open session that holds something between its turns, held for as long as the session object is. */
const sessionEvictors = new WeakMap<AgentSession, SessionEvictor>();

/**
 * Registers how a deletion empties one open session, by the session object `agent.session()` hands out. `gmi()` calls
 * it for each session of a souled agent that keeps history.
 *
 * @internal
 */
export function registerSessionEvictor(session: AgentSession, evict: SessionEvictor): void {
  sessionEvictors.set(session, evict);
}

/**
 * Drops named traces from what one open session holds of them between its turns: the working-memory slots of its
 * GMI's cognitive memory. It does not wait for a turn the session is running: a slot holds a trace's id and no words,
 * and the trace's row and cached copy are gone by then, so a turn recalls it no more. A turn that ranked one of them
 * before the delete can focus it again as its recall ends, so the slots go again once that turn has ended.
 */
export type SessionTraceDropper = (traceIds: ReadonlySet<string>) => Promise<void>;

/** The trace dropper of each open session that holds something between its turns, held for as long as the session object is. */
const sessionTraceDroppers = new WeakMap<AgentSession, SessionTraceDropper>();

/**
 * Registers how a correction or a retention sweep drops named traces from one open session, by the session object
 * `agent.session()` hands out. `gmi()` calls it beside {@link registerSessionEvictor}.
 *
 * @internal
 */
export function registerSessionTraceDropper(session: AgentSession, drop: SessionTraceDropper): void {
  sessionTraceDroppers.set(session, drop);
}

/** What a souled agent's deletion calls on the mind's side, on `runtime: 'gmi'`. */
export interface SoulMind {
  /**
   * Deletes for good every trace of one conversation key with what the mind keeps of each: each live manager's
   * `deleteScope('conversation', scopeId)`, which takes the key's rows whichever side filed them, with each trace's
   * cached copy, vector, memory-graph node and archived original. With no manager live, nothing of the key is cached
   * in this process: the rows are left to the store's own pass, and each trace's archived original is dropped by its
   * id. No manager is built for a deletion: its build needs the embedding provider.
   *
   * @param scopeId - The conversation key.
   * @returns `deleted`: the rows the managers deleted; 0 with none live.
   * @throws The first error a manager's delete failed with, once every manager was asked; the rows a failed manager
   *   found stay for a call made again.
   */
  deleteKey(scopeId: string): Promise<{ deleted: number }>;
  /**
   * The same as {@link deleteKey}, for named traces: each live manager's `deleteTraces(traceIds)`, and with none live
   * each trace's archived original.
   *
   * @returns `deleted`: the rows the managers deleted; 0 with none live.
   * @throws The first error a manager's delete failed with, once every manager was asked.
   */
  deleteTraces(traceIds: readonly string[]): Promise<{ deleted: number }>;
  /**
   * Empties what the given open sessions hold of their person: each session's messages at once, and its GMI's
   * history, reasoning trace, sentiment trend, working-memory slots and metaprompt imprints once no turn of the
   * session runs. The sessions are asked
   * together, so the wait for their running turns is one deadline in all.
   *
   * @param sessions - The sessions the agent's handle holds open for the person.
   * @returns `evicted`: the sessions emptied. `running`: the sessions whose turn was still running at the deadline,
   *   each emptied once that turn ends. A session with no evictor keeps nothing between its turns and counts in
   *   neither.
   * @throws The first error a session's emptying failed with, once every session was asked.
   */
  evictSessions(sessions: Iterable<AgentSession>): Promise<{ evicted: number; running: number }>;
  /**
   * Drops named traces from the given open sessions, after a correction, a retention sweep or a re-application of the
   * tombstones deleted them for good: each session's working-memory slots of them go at once, whether or not a turn of
   * the session runs, and again once a running turn has ended, since its recall can focus a trace it ranked before the
   * delete; every other slot stays. A session with no dropper keeps nothing between its turns and is skipped.
   *
   * @param traceIds - The traces deleted.
   * @param sessions - The sessions the agent's handle holds open for the person whose traces they were.
   * @returns Once every session was asked. Never rejects: a session whose drop failed writes one
   *   `memory.session_evict_failed` line.
   */
  evictTraces(traceIds: readonly string[], sessions: Iterable<AgentSession>): Promise<void>;
}

/**
 * The mind side of a souled agent on `runtime: 'gmi'`, cognitive memory on or off.
 *
 * @param input.managers - The cognitive memory managers the agent's sessions share in this process, read at each
 *   delete; `evictSessions` reads none of them.
 * @param input.archive - Where the mind keeps the originals of its traces in the soul's store, its tables made at the
 *   open, with how to list one key's trace ids there: what the deletes reach with no manager live. Unset (cognitive
 *   memory off): nothing is dropped there.
 * @param input.deadlineMs - How long a deletion waits for the running turn of a session it empties; a negative
 *   number or `NaN` is 0, and a wait past the longest timer is held to it. `evictTraces` waits for no turn.
 * @internal
 */
export function createSoulMind(input: {
  managers(): Iterable<ICognitiveMemoryManager>;
  archive?: { originals: IMemoryArchive; traceIdsOf(scopeId: string): Promise<readonly string[]> };
  deadlineMs: number;
}): SoulMind {
  const deadlineMs = input.deadlineMs >= 0 ? Math.min(input.deadlineMs, LONGEST_TIMER_MS) : 0;
  /**
   * Runs one delete on every live manager, one after another, and sums the rows they deleted; with none live, drops
   * the originals of the traces `orphans()` names instead. A manager that cannot delete is a failure: every manager is
   * still asked, and the first failure is thrown.
   */
  const onEveryManager = async (
    remove: (manager: ICognitiveMemoryManager) => Promise<{ deleted: number }> | undefined,
    orphans: () => Promise<readonly string[]>,
  ): Promise<{ deleted: number }> => {
    const live = [...input.managers()];
    if (live.length === 0) {
      const archive = input.archive;
      if (archive) for (const traceId of await orphans()) await archive.originals.drop(traceId);
      return { deleted: 0 };
    }
    let deleted = 0;
    let failed: { error: unknown } | undefined;
    for (const manager of live) {
      try {
        const done = remove(manager);
        if (!done) throw new Error("the mind's memory cannot delete a person's traces");
        deleted += (await done).deleted;
      } catch (error) {
        failed ??= { error };
      }
    }
    if (failed) throw failed.error;
    return { deleted };
  };
  return {
    deleteKey: (scopeId) =>
      onEveryManager(
        (manager) => manager.deleteScope?.('conversation', scopeId),
        async () => (input.archive ? input.archive.traceIdsOf(scopeId) : []),
      ),
    deleteTraces: async (traceIds) => {
      const ids = [...new Set(traceIds)];
      if (ids.length === 0) return { deleted: 0 };
      return onEveryManager(
        (manager) => manager.deleteTraces?.(ids),
        async () => ids,
      );
    },
    async evictSessions(sessions) {
      const asked: Array<Promise<SessionEviction>> = [];
      for (const session of sessions) {
        const evict = sessionEvictors.get(session);
        if (evict) asked.push(evict(deadlineMs));
      }
      let evicted = 0;
      let running = 0;
      let failed: { error: unknown } | undefined;
      for (const outcome of await Promise.allSettled(asked)) {
        if (outcome.status === 'rejected') failed ??= { error: outcome.reason };
        else if (outcome.value === 'evicted') evicted += 1;
        else running += 1;
      }
      if (failed) throw failed.error;
      return { evicted, running };
    },
    async evictTraces(traceIds, sessions) {
      const ids = new Set(traceIds);
      if (ids.size === 0) return;
      const asked: Array<Promise<void>> = [];
      for (const session of sessions) {
        const drop = sessionTraceDroppers.get(session);
        if (drop) asked.push(Promise.resolve().then(() => drop(ids)));
      }
      for (const outcome of await Promise.allSettled(asked)) {
        if (outcome.status === 'rejected') memoryLog.warn('memory.session_evict_failed', errorFields(outcome.reason));
      }
    },
  };
}
