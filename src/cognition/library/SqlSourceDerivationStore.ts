/**
 * @fileoverview The durable store of results derived from private sources, on PostgreSQL through
 * `@framers/sql-storage-adapter`: one fence row per owner serializes result commits and deliveries with source
 * invalidation, removing a source removes every whole result that depends on it, and content-free deletion records
 * are kept for replay after a restore.
 * @module agentos/cognition/library/SqlSourceDerivationStore
 */

import { randomUUID } from 'node:crypto';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import {
  canDeliverSourceDerivation, createSourceDerivation,
  type SourceDependencyState, type SourceDerivation, type SourceDeliveryContext,
} from './SourceDerivations.js';
import { sourceDerivationTables } from './sourceDerivationSchema.js';

/** Authenticated personal ownership; never a display name or mailbox address. */
export interface SourceOwnerScope {
  readonly tenantId: string;
  readonly ownerId: string;
}

/**
 * Capture before external work; recheck before any resulting database write.
 * `epoch` is the owner's fence counter when the ticket was captured. An applied invalidation, a block,
 * a reactivation and a replayed deletion each advance it, which makes every earlier ticket stale.
 */
export interface SourceFenceTicket extends SourceOwnerScope {
  readonly epoch: number;
}

/** The entire owner, a connection, or one source whose dependent results must go. */
export type SourceInvalidation =
  | { readonly kind: 'owner' }
  | { readonly kind: 'connection'; readonly connectionId: string }
  | { readonly kind: 'source'; readonly connectionId: string; readonly sourceId: string };

/**
 * Recovery evidence contains opaque keys and counters, never derived content.
 * `sequence` orders the records in commit order, `epoch` is the owner's fence counter the deletion set,
 * `at` is when it was recorded (the store's clock, integer UTC epoch milliseconds) and `ownerDisabled`
 * says whether the deletion left the owner inactive.
 */
export interface SourceDeletionTombstone extends SourceOwnerScope {
  readonly sequence: number;
  readonly id: string;
  readonly epoch: number;
  readonly at: number;
  readonly affected: SourceInvalidation;
  readonly ownerDisabled: boolean;
}

/**
 * Host/table bindings must operate only on the supplied transaction adapter.
 * The store calls them inside its owner lock, in the transaction that commits, delivers or purges.
 * Never fetch from a provider, parse, embed, generate or revoke inside them.
 */
export interface SourceDerivationBindings {
  /**
   * Reads the current state of each of the derivation's sources from the host's own rows, in this transaction:
   * connection generation, source version, retained message ids, source expiry and the pause and use switches.
   * Leave out a source that is gone, and answer no source of an account the host is deleting. Never answer from
   * a cache.
   */
  readCurrent(tx: StorageAdapter, derivation: SourceDerivation): Promise<readonly SourceDependencyState[]>;
  /** Deletes every host row stored for these result ids (saved marks, summaries and the like), whole. */
  purgeResults(tx: StorageAdapter, scope: SourceOwnerScope, resultIds: readonly string[]): Promise<void>;
  /** Deletes the host's source content in the affected scope: text, metadata, passages and vectors. */
  purgeSources(tx: StorageAdapter, scope: SourceOwnerScope, affected: SourceInvalidation): Promise<void>;
}

/** The application owns schema creation, clock policy and concrete table bindings. */
export interface SourceDerivationStoreOptions {
  /** Prefix of the store's tables, the one given to `sourceDerivationSchema`; `agentos_source_derivation` unless given. */
  readonly tablePrefix?: string;
  /** Current time as integer UTC epoch milliseconds; `Date.now` unless given. */
  readonly clock?: () => number;
  /** The host's table bindings. */
  readonly bindings: SourceDerivationBindings;
}

/** Stale work has no side effects and cannot force a mutation through. */
export type SourceFencedResult<T> =
  | { readonly kind: 'applied'; readonly value: T; readonly ticket: SourceFenceTicket }
  | { readonly kind: 'stale' };

interface OwnerRow { epoch: string | number; active: boolean }
interface ResultRow { id: string; derivation: SourceDerivation; payload: string }
interface TombstoneRow {
  sequence: string | number; id: string; tenant_id: string; owner_id: string;
  epoch: string | number; at_ms: string | number;
  affected: SourceInvalidation; owner_disabled: boolean;
}

function integer(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function key(value: string): boolean { return typeof value === 'string' && value.length > 0 && value.length <= 512; }
function same(a: SourceOwnerScope, b: SourceOwnerScope): boolean {
  return a.tenantId === b.tenantId && a.ownerId === b.ownerId;
}
function checkedScope(scope: SourceOwnerScope): void {
  if (!key(scope.tenantId) || !key(scope.ownerId)) throw new Error('invalid_source_owner');
}
function checkedAffected(affected: SourceInvalidation): void {
  if (affected.kind === 'owner') return;
  if ((affected.kind !== 'connection' && affected.kind !== 'source') || !key(affected.connectionId)
    || (affected.kind === 'source' && !key(affected.sourceId))) throw new Error('invalid_source_invalidation');
}
/** The invalidation's kind and keys alone, so that no other property a caller passed reaches a deletion record. */
function plainAffected(affected: SourceInvalidation): SourceInvalidation {
  if (affected.kind === 'owner') return { kind: 'owner' };
  if (affected.kind === 'connection') return { kind: 'connection', connectionId: affected.connectionId };
  return { kind: 'source', connectionId: affected.connectionId, sourceId: affected.sourceId };
}
function count(value: string | number): number {
  const n = Number(value);
  if (!integer(n)) throw new Error('invalid_source_counter');
  return n;
}
function increment(value: number): number {
  const next = value + 1;
  if (!integer(next)) throw new Error('source_counter_exhausted');
  return next;
}

/**
 * Durable private provenance on PostgreSQL. All source writers use this owner fence;
 * model/provider work stays outside it. No method logs SQL, content or exceptions.
 *
 * Every method that reads or writes an owner's results runs in one transaction that first locks that owner's
 * fence row, so commits, deliveries, invalidations and expiry for one owner are serialized, while different
 * owners proceed independently. Writing a deletion record also locks one shared journal row, last, so the
 * records' sequence follows commit order.
 *
 * @example
 * ```typescript
 * const store = new SqlSourceDerivationStore(db, { bindings });
 * const ticket = await store.capture({ tenantId, ownerId });
 * // ...generate an answer outside the store...
 * if (ticket && await store.commit(ticket, answerId, derivation, answerText, context)) {
 *   await store.deliver(answerId, context, (text) => {
 *     queue.push(text);
 *     return true;
 *   });
 * }
 * ```
 */
export class SqlSourceDerivationStore {
  private readonly tables: ReturnType<typeof sourceDerivationTables>;
  private readonly clock: () => number;
  private readonly bindings: SourceDerivationBindings;

  /**
   * @param db - A PostgreSQL adapter with transactions. Each call that reads or writes an owner's state runs in a
   *   transaction of its own on it. On a transaction view (the adapter a `transaction` callback receives, whose own
   *   `transaction` runs a callback in that same transaction) each call runs inside the caller's transaction
   *   instead: it holds the owner's row, and after writing a deletion record the shared journal row, until the
   *   caller commits or rolls back, and the caller's rollback undoes it.
   * @param options - Table prefix, clock and the host's bindings.
   * @throws {Error} `derivations_require_postgres_transactions` for another kind of adapter or one without
   *   transactions, and `invalid_derivation_table_prefix` for a malformed prefix.
   */
  constructor(private readonly db: StorageAdapter, options: SourceDerivationStoreOptions) {
    if (db.kind !== 'postgres' || !db.capabilities.has('transactions')) {
      throw new Error('derivations_require_postgres_transactions');
    }
    this.tables = sourceDerivationTables(options.tablePrefix);
    this.clock = options.clock ?? Date.now;
    this.bindings = options.bindings;
  }

  private now(): number {
    const value = this.clock();
    if (!integer(value)) throw new Error('invalid_source_clock');
    return value;
  }

  private async locked<T>(
    scope: SourceOwnerScope,
    work: (tx: StorageAdapter, owner: { epoch: number; active: boolean }) => Promise<T>,
  ): Promise<T> {
    checkedScope(scope);
    return this.db.transaction(async (tx) => {
      await tx.run(`INSERT INTO ${this.tables.owners} (tenant_id,owner_id)
        VALUES ($1,$2) ON CONFLICT (tenant_id,owner_id) DO NOTHING`, [scope.tenantId, scope.ownerId]);
      const row = await tx.get<OwnerRow>(`SELECT epoch,active FROM ${this.tables.owners}
        WHERE tenant_id=$1 AND owner_id=$2 FOR UPDATE`, [scope.tenantId, scope.ownerId]);
      if (!row) throw new Error('source_owner_missing');
      return work(tx, { epoch: count(row.epoch), active: row.active === true });
    });
  }

  private ticket(scope: SourceOwnerScope, epoch: number): SourceFenceTicket {
    return Object.freeze({ tenantId: scope.tenantId, ownerId: scope.ownerId, epoch });
  }

  /**
   * Fresh authorization must also reject deleting/deleted host accounts.
   *
   * Runs `authorize` under the owner lock; when it answers true, an inactive owner becomes active with a new
   * epoch.
   *
   * @returns True when `authorize` answered true, the owner then being active; false when it answered false,
   *   which changes nothing.
   */
  async activateOwner(
    scope: SourceOwnerScope,
    authorize: (tx: StorageAdapter) => Promise<boolean>,
  ): Promise<boolean> {
    return this.locked(scope, async (tx, owner) => {
      if (!await authorize(tx)) return false;
      if (owner.active) return true;
      await tx.run(`UPDATE ${this.tables.owners} SET active=TRUE,epoch=$3
        WHERE tenant_id=$1 AND owner_id=$2`, [scope.tenantId, scope.ownerId, increment(owner.epoch)]);
      return true;
    });
  }

  /**
   * Commit an inactive fence before disconnect, exclusion, grant-loss or deletion purge.
   *
   * Marks the owner inactive with a new epoch, runs `mutate` in the same transaction and records an owner-wide
   * deletion. Nothing of the owner's is committed or delivered again until `activateOwner` succeeds.
   */
  async blockOwner(scope: SourceOwnerScope, mutate: (tx: StorageAdapter) => Promise<void>): Promise<void> {
    await this.locked(scope, async (tx, owner) => {
      const epoch = increment(owner.epoch);
      await tx.run(`UPDATE ${this.tables.owners} SET active=FALSE,epoch=$3 WHERE tenant_id=$1 AND owner_id=$2`, [scope.tenantId, scope.ownerId, epoch]);
      await mutate(tx);
      await this.record(tx, scope, epoch, { kind: 'owner' }, true);
    });
  }

  /**
   * Captures a ticket at the owner's current epoch, before work outside the store begins.
   *
   * @returns The ticket, or null while the owner is not active.
   */
  async capture(scope: SourceOwnerScope): Promise<SourceFenceTicket | null> {
    return this.locked(scope, async (_tx, owner) => owner.active ? this.ticket(scope, owner.epoch) : null);
  }

  /** Execute short trusted storage work after the epoch check. This is not a
   * content-delivery API. Source replacement uses invalidate with expected ticket.
   *
   * @returns `applied` with the work's value, or `stale`, without entering `work`, when the owner is inactive or
   *   its epoch has moved past the ticket's.
   */
  async apply<T>(
    ticket: SourceFenceTicket,
    work: (tx: StorageAdapter) => Promise<T>,
  ): Promise<SourceFencedResult<T>> {
    return this.locked<SourceFencedResult<T>>(ticket, async (tx, owner) => {
      if (!owner.active || !integer(ticket.epoch) || ticket.epoch !== owner.epoch) return { kind: 'stale' };
      const value = await work(tx);
      return { kind: 'applied', value, ticket: this.ticket(ticket, owner.epoch) };
    });
  }

  private async allowed(
    tx: StorageAdapter, derivation: SourceDerivation, context: SourceDeliveryContext,
  ): Promise<boolean> {
    const current = await this.bindings.readCurrent(tx, derivation);
    return canDeliverSourceDerivation(derivation, context, current, this.now());
  }

  /**
   * Persist one whole result only if every input remains current and permitted.
   *
   * The ticket must be current, `context` and `derivation` must name the ticket's tenant and owner, the record must
   * be personal with the earliest expiry of its dependencies, and `canDeliverSourceDerivation` must allow it for
   * `context` against the state `readCurrent` reads in this transaction. The payload is at most 1,048,576
   * UTF-16 code units long, and an id the owner already holds is not replaced.
   *
   * @returns Whether the result was stored.
   */
  async commit(
    ticket: SourceFenceTicket,
    id: string,
    derivation: SourceDerivation,
    payload: string,
    context: SourceDeliveryContext,
  ): Promise<boolean> {
    if (!key(id) || typeof payload !== 'string' || payload.length > 1_048_576
      || !same(ticket, context) || !same(ticket, derivation)) return false;
    let normalized: SourceDerivation;
    try {
      normalized = createSourceDerivation(derivation.dependencies);
    } catch {
      return false;
    }
    if (derivation.visibility !== 'personal' || normalized.expiresAt !== derivation.expiresAt) return false;
    const result = await this.apply(ticket, async (tx) => {
      if (!await this.allowed(tx, normalized, context)) return false;
      const inserted = await tx.run(`INSERT INTO ${this.tables.results}
        (tenant_id,owner_id,id,derivation,payload,expires_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6)
        ON CONFLICT (tenant_id,owner_id,id) DO NOTHING`,
      [ticket.tenantId, ticket.ownerId, id, JSON.stringify(normalized), payload, normalized.expiresAt]);
      if (inserted.changes !== 1) return false;
      for (const dep of normalized.dependencies) {
        await tx.run(`INSERT INTO ${this.tables.edges}
          (tenant_id,owner_id,result_id,connection_id,source_id) VALUES ($1,$2,$3,$4,$5)`,
        [ticket.tenantId, ticket.ownerId, id, dep.connectionId, dep.sourceId]);
      }
      return true;
    });
    return result.kind === 'applied' && result.value;
  }

  /**
   * Enqueue immediately under the lock; do not retain the argument or return a Promise.
   *
   * Reads the stored result and the current state of its sources under the owner lock and, when the owner is
   * active and `canDeliverSourceDerivation` allows `context`, passes the payload to `enqueue` before the lock is
   * released. The payload is never returned.
   *
   * @returns What `enqueue` answered, or false when delivery is refused.
   * @throws {Error} `source_delivery_must_be_synchronous` when `enqueue` answers anything but a boolean.
   */
  async deliver(
    id: string,
    context: SourceDeliveryContext,
    enqueue: (payload: string) => boolean,
  ): Promise<boolean> {
    if (!key(id)) return false;
    return this.locked(context, async (tx, owner) => {
      if (!owner.active) return false;
      const row = await tx.get<ResultRow>(`SELECT id,derivation,payload FROM ${this.tables.results}
        WHERE tenant_id=$1 AND owner_id=$2 AND id=$3`, [context.tenantId, context.ownerId, id]);
      if (!row || !await this.allowed(tx, row.derivation, context)) return false;
      const sent = enqueue(row.payload);
      if (typeof sent !== 'boolean') throw new Error('source_delivery_must_be_synchronous');
      return sent;
    });
  }

  private async resultIds(
    tx: StorageAdapter, scope: SourceOwnerScope, affected: SourceInvalidation,
  ): Promise<string[]> {
    const rows = affected.kind === 'owner'
      ? await tx.all<{ id: string }>(`SELECT id FROM ${this.tables.results}
          WHERE tenant_id=$1 AND owner_id=$2`, [scope.tenantId, scope.ownerId])
      : await tx.all<{ id: string }>(`SELECT DISTINCT result_id AS id FROM ${this.tables.edges}
          WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3
          AND ($4::text IS NULL OR source_id=$4)`,
        [scope.tenantId, scope.ownerId, affected.connectionId, affected.kind === 'source' ? affected.sourceId : null]);
    return rows.map((row) => row.id);
  }

  private async removeResults(tx: StorageAdapter, scope: SourceOwnerScope, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.bindings.purgeResults(tx, scope, ids);
    await tx.run(`DELETE FROM ${this.tables.results}
      WHERE tenant_id=$1 AND owner_id=$2 AND id=ANY($3::text[])`, [scope.tenantId, scope.ownerId, [...ids]]);
  }

  private async record(
    tx: StorageAdapter, scope: SourceOwnerScope, epoch: number,
    affected: SourceInvalidation, disabled: boolean, id: string = randomUUID(), at = this.now(),
  ): Promise<void> {
    await tx.run(`INSERT INTO ${this.tables.journal} (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    await tx.get(`SELECT id FROM ${this.tables.journal} WHERE id=1 FOR UPDATE`);
    // Rebuilt from its kind and keys: an invalidation or a replayed record can carry other properties, and the
    // record outlives the account.
    await tx.run(`INSERT INTO ${this.tables.tombstones}
      (id,tenant_id,owner_id,epoch,at_ms,affected,owner_disabled) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
      ON CONFLICT (id) DO NOTHING`,
    [id, scope.tenantId, scope.ownerId, epoch, at, JSON.stringify(plainAffected(affected)), disabled]);
  }

  /**
   * Advance the fence, purge affected sources and all whole dependent results, and
   * mutate host state in one transaction. A supplied expected ticket is a CAS.
   *
   * With `expected`, an inactive owner or an epoch past the ticket's answers `stale` without purging or entering
   * `mutate`. Without it, the invalidation always applies, also to an inactive owner, which stays inactive.
   * `disableOwner` leaves the owner inactive and needs an owner-wide invalidation. A thrown binding or `mutate`
   * rolls back the epoch, the purge and the deletion record together.
   *
   * @throws {Error} `invalid_source_invalidation` for a malformed `affected`, and
   *   `owner_disable_requires_owner_scope` for `disableOwner` with a connection or source.
   */
  async invalidate<T>(
    scope: SourceOwnerScope,
    affected: SourceInvalidation,
    mutate: (tx: StorageAdapter) => Promise<T>,
    options: { readonly expected?: SourceFenceTicket; readonly disableOwner?: boolean } = {},
  ): Promise<SourceFencedResult<T>> {
    checkedAffected(affected);
    if (options.disableOwner && affected.kind !== 'owner') throw new Error('owner_disable_requires_owner_scope');
    return this.locked<SourceFencedResult<T>>(scope, async (tx, owner) => {
      const expected = options.expected;
      if (expected && (!owner.active || !same(scope, expected) || !integer(expected.epoch)
        || owner.epoch !== expected.epoch)) return { kind: 'stale' };
      const epoch = increment(owner.epoch);
      const active = owner.active && options.disableOwner !== true;
      await tx.run(`UPDATE ${this.tables.owners} SET epoch=$3,active=$4
        WHERE tenant_id=$1 AND owner_id=$2`, [scope.tenantId, scope.ownerId, epoch, active]);
      // The owner lock precedes host table mutations; the journal lock is acquired last.
      await this.removeResults(tx, scope, await this.resultIds(tx, scope, affected));
      await this.bindings.purgeSources(tx, scope, affected);
      const value = await mutate(tx);
      await this.record(tx, scope, epoch, affected, !active);
      return { kind: 'applied', value, ticket: this.ticket(scope, epoch) };
    });
  }

  /**
   * Expiry is enforced at read regardless; this removes stored and host-bound copies.
   *
   * @param limit - At most this many results go in one call, earliest expiry first: an integer from 1 to 1,000.
   * @returns How many results were removed.
   * @throws {Error} `invalid_derivation_batch` for another limit.
   */
  async expireResults(scope: SourceOwnerScope, limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error('invalid_derivation_batch');
    return this.locked(scope, async (tx) => {
      const rows = await tx.all<{ id: string }>(`SELECT id FROM ${this.tables.results}
        WHERE tenant_id=$1 AND owner_id=$2 AND expires_at <= $3 ORDER BY expires_at,id LIMIT $4`,
      [scope.tenantId, scope.ownerId, this.now(), limit]);
      await this.removeResults(tx, scope, rows.map((row) => row.id));
      return rows.length;
    });
  }

  /**
   * Operator recovery export only; never expose this across account sessions.
   *
   * @param afterSequence - Answers the records after this sequence, in sequence order: 0 for the first page, then
   *   the last sequence of the page before.
   * @param limit - Page size, an integer from 1 to 1,000.
   * @throws {Error} `invalid_tombstone_page` for a negative or fractional sequence or another limit.
   */
  async readTombstones(afterSequence: number, limit = 100): Promise<readonly SourceDeletionTombstone[]> {
    if (!integer(afterSequence) || !Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('invalid_tombstone_page');
    }
    const rows = await this.db.all<TombstoneRow>(`SELECT sequence,id,tenant_id,owner_id,epoch,at_ms,affected,owner_disabled
      FROM ${this.tables.tombstones} WHERE sequence > $1 ORDER BY sequence LIMIT $2`, [afterSequence, limit]);
    return rows.map((row) => ({
      sequence: count(row.sequence), id: row.id, tenantId: row.tenant_id, ownerId: row.owner_id,
      epoch: count(row.epoch), at: count(row.at_ms), affected: row.affected, ownerDisabled: row.owner_disabled,
    }));
  }

  /**
   * Restore is conservative: any affected owner is disabled and all of that owner's
   * private sources/results are purged. Fresh authorized reconnect is required.
   *
   * Replaying the same records again is harmless: each deletion record is kept once, by its id, and the owner stays
   * inactive. Run it on a restored database before any read or job resumes, with every record newer than the
   * backup.
   *
   * @throws {Error} `invalid_source_tombstone`, `invalid_source_owner` or `invalid_source_invalidation` for a
   *   malformed record, before that record is applied.
   */
  async replayTombstones(records: readonly SourceDeletionTombstone[]): Promise<void> {
    for (const record of records) {
      checkedScope(record);
      checkedAffected(record.affected);
      if (!key(record.id) || !integer(record.epoch) || !integer(record.at)
        || !integer(record.sequence) || typeof record.ownerDisabled !== 'boolean') {
        throw new Error('invalid_source_tombstone');
      }
      await this.locked(record, async (tx, owner) => {
        const epoch = increment(Math.max(owner.epoch, record.epoch));
        await tx.run(`UPDATE ${this.tables.owners} SET epoch=$3,active=FALSE
          WHERE tenant_id=$1 AND owner_id=$2`, [record.tenantId, record.ownerId, epoch]);
        const affected: SourceInvalidation = { kind: 'owner' };
        await this.removeResults(tx, record, await this.resultIds(tx, record, affected));
        await this.bindings.purgeSources(tx, record, affected);
        await this.record(tx, record, record.epoch, record.affected, record.ownerDisabled, record.id, record.at);
      });
    }
  }
}
