/**
 * @module memory/suppression/learnerTombstones
 *
 * The learning layer's route to the forgotten-user ledger.
 *
 * The layer keeps a tombstone row of its own in its learning store, in the form it has always written: SHA-256 over
 * the canonical JSON `[namespace, userId]`. Its store transactions read that row. Every tombstone read the layer makes
 * outside a transaction, and its one tombstone write, go through the route here, which also asks and writes a shared
 * {@link ForgottenLedger} when the agent has one. So a user the memory store forgot is refused by the learning layer,
 * and a user the learning layer forgot is forgotten for the memory store.
 *
 * With no shared ledger the route makes exactly the store calls the layer made without it.
 */
import { canonicalJson, sha256Hex } from '../../learning/ledger/canonical.js';
import type { ForgottenLedger } from './ForgottenLedger.js';

/** A user in one namespace of a learning store. */
export interface NamespacedUser {
  namespace: string;
  userId: string;
}

/** The learning layer's route to the forgotten-user ledger. */
export interface LearnerTombstones {
  /** The hash of the layer's own row: SHA-256 over the canonical JSON `[namespace, userId]`. */
  hashOf(user: NamespacedUser): Promise<string>;
  /** The layer's own row first, then the shared ledger where one is attached and reads the user's namespace. */
  has(rows: { isForgotten(hash: string): Promise<boolean> }, user: NamespacedUser): Promise<boolean>;
  /**
   * The shared ledger alone; false with none attached. For a read made beside a store transaction that reads the
   * layer's own row itself.
   */
  sharedHas(user: NamespacedUser): Promise<boolean>;
  /**
   * The shared ledger first (its copy, then its primary), then the layer's own row; with a keyed shared ledger the
   * layer's own unkeyed row is not written. Rejects when the shared ledger's write fails, with nothing written to the
   * layer's own store.
   */
  mark(rows: { insertForgotten(hash: string, forgottenAt: string): Promise<void> }, user: NamespacedUser, forgottenAt: string): Promise<void>;
}

/**
 * The route for one learning layer.
 *
 * @param shared - The ledger the agent's memory store uses, when the agent has one. It is asked and written for a
 *   user only when it reads the user's namespace (`shared.namespaces`).
 */
export function learnerTombstones(shared?: ForgottenLedger): LearnerTombstones {
  /** The shared ledger, when it reads the user's namespace. */
  const sharedFor = (user: NamespacedUser): ForgottenLedger | undefined =>
    shared !== undefined && shared.namespaces.includes(user.namespace) ? shared : undefined;
  const hashOf = (user: NamespacedUser): Promise<string> => sha256Hex(canonicalJson([user.namespace, user.userId]));
  const sharedHas = async (user: NamespacedUser): Promise<boolean> => {
    const ledger = sharedFor(user);
    return ledger === undefined ? false : await ledger.isForgotten({ kind: 'user', id: user.userId });
  };
  return {
    hashOf,
    async has(rows, user) {
      if (await rows.isForgotten(await hashOf(user))) return true;
      const ledger = sharedFor(user);
      return ledger === undefined ? false : await ledger.isForgotten({ kind: 'user', id: user.userId });
    },
    sharedHas,
    async mark(rows, user, forgottenAt) {
      const ledger = sharedFor(user);
      // A throw here stops the caller before it deletes anything.
      if (ledger !== undefined) await ledger.markForgotten({ kind: 'user', id: user.userId });
      // A keyed store holds keyed tombstones alone: the layer's own row is an unkeyed hash of the id.
      if (ledger?.keyed) return;
      await rows.insertForgotten(await hashOf(user), forgottenAt);
    },
  };
}

/** The ledgers handed over by options object, each held for as long as its options object is. */
const sharedLedgers = new WeakMap<object, ForgottenLedger>();

/**
 * Hands a souled agent's ledger to the learning layer `gmi()` builds from the same options object. Held weakly.
 *
 * @internal
 */
export function shareForgottenLedger(agentOptions: object, ledger: ForgottenLedger): void {
  sharedLedgers.set(agentOptions, ledger);
}

/**
 * The ledger shared for these options, if any.
 *
 * @internal
 */
export function sharedForgottenLedgerOf(agentOptions: object): ForgottenLedger | undefined {
  return sharedLedgers.get(agentOptions);
}
