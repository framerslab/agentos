/**
 * @fileoverview What `souledAgent()` hands the `gmi()` it builds: the soul's store, read by the options object the
 * agent was built from, as the tombstone ledger is handed to the learning layer (`shareForgottenLedger`).
 *
 * Internal: exported from neither the package root nor the API index, and no host-facing option.
 *
 * @module agentos/api/runtime/soulStore
 * @internal
 */
import type { MemoryHookContext } from '../agent.js';
import type { SoulTurnMemory } from '../../cognition/substrate/soulTurnMemory.js';

/** A souled agent's store, as `gmi()` reads it. */
export interface SoulStore {
  /** The soul's one id. */
  agentId: string;
  /** Whether a session turn sends the end user's id to the model provider (`SouledAgentOptions.sendUserIdToProvider`). */
  sendUserIdToProvider: boolean;
  /**
   * One session turn's view of the soul's memory rules, from the context its hooks are given; undefined for a turn
   * that names no subject, and for a subject whose id no memory key can be built from.
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
