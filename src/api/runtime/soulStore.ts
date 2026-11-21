/**
 * @fileoverview What `souledAgent()` hands the `gmi()` it builds: the soul's store, read by the options object the
 * agent was built from, as the tombstone ledger is handed to the learning layer (`shareForgottenLedger`). And what
 * `gmi()` hands back for a deletion: each open session's evictor, by the session object, which the agent's mind side
 * ({@link SoulMind}) calls to empty the sessions of a person it deletes.
 *
 * Internal: exported from neither the package root nor the API index, and no host-facing option.
 *
 * @module agentos/api/runtime/soulStore
 * @internal
 */
import type { AgentSession, MemoryHookContext } from '../agent.js';
import type { ICognitiveMemoryManager } from '../../cognition/memory/CognitiveMemoryManager.js';
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
 * running. `'running'` when the turn outlasted the wait: the session is then emptied once that turn ends.
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

/** What a souled agent's deletion calls on the mind's side, on `runtime: 'gmi'`. */
export interface SoulMind {
  /**
   * Empties what the given open sessions hold of their person: each session's messages at once, and what its GMI
   * holds (its history, its sentiment trend, its working-memory slots) once no turn of the session runs. The sessions
   * are asked together, so the wait for their running turns is one deadline in all.
   *
   * @param sessions - The sessions the agent's handle holds open for the person.
   * @returns `evicted`: the sessions emptied. `running`: the sessions whose turn was still running at the deadline,
   *   each emptied once that turn ends. A session with no evictor keeps nothing between its turns and counts in
   *   neither.
   * @throws The first error a session's emptying failed with, once every session was asked.
   */
  evictSessions(sessions: Iterable<AgentSession>): Promise<{ evicted: number; running: number }>;
}

/**
 * The mind side of a souled agent on `runtime: 'gmi'`, cognitive memory on or off.
 *
 * @param input.managers - The cognitive memory managers the agent's sessions share in this process; `evictSessions`
 *   reads none of them.
 * @param input.deadlineMs - How long a deletion waits for the running turn of a session it empties; a negative
 *   number or `NaN` is 0, and a wait past the longest timer is held to it.
 * @internal
 */
export function createSoulMind(input: { managers(): Iterable<ICognitiveMemoryManager>; deadlineMs: number }): SoulMind {
  const deadlineMs = input.deadlineMs >= 0 ? Math.min(input.deadlineMs, LONGEST_TIMER_MS) : 0;
  return {
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
  };
}
