/**
 * @module core/providers/KeyPoolStateStore
 *
 * Persisted state of an {@link ApiKeyPool}: per key, its standing (ok,
 * resting, failed), the kind of its last failure and the times that govern
 * its return. Keys themselves are never stored, only a fingerprint that the
 * pool computes from the key, so a database holding this state holds no
 * secret. Two implementations: an in-memory one for tests and hosts without a
 * database, and one over `@framers/sql-storage-adapter` with its own table,
 * the pattern `SqlContentKeyStore` set for library state.
 */

import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { KeyFailureKind } from './quotaErrors.js';

/** One key's standing in a pool. `fingerprint` and `label` identify the key without holding it. */
export interface KeyState {
  /** A short non-reversible digest of the key, the row's identity in a store. */
  fingerprint: string;
  /** `k<index>` plus the key's last four characters, for log lines. */
  label: string;
  /** `ok`: hand out freely. `resting`: a quota rest until `until`. `failed`: out until a probe passes or a recheck re-admits it. */
  status: 'ok' | 'resting' | 'failed';
  /** The kind of the last failure, set while `resting` or `failed`. */
  kind?: KeyFailureKind;
  /** When a quota rest ends (epoch ms). */
  until?: number;
  /** Consecutive auth or billing failures since the last success; sets the recheck delay. */
  failures: number;
  /** The start time of the last request that succeeded with this key. */
  lastOkAt?: number;
  /** The start time of the last request that failed with this key. */
  lastFailAt?: number;
  /** When the next probe of a failed key may run (epoch ms). */
  nextRecheckAt?: number;
  /** When this state was last changed (epoch ms); a store keeps the newest. */
  updatedAt: number;
  /** The record's shape version; a store ignores other versions. */
  version: 1;
}

/** Where a pool keeps its state across restarts. Both calls may reject; the pool logs and carries on. */
export interface KeyPoolStateStore {
  /** The states saved under this pool id, or null when none were. */
  load(poolId: string): Promise<KeyState[] | null>;
  /** Saves one key's state; an older `updatedAt` never overwrites a newer row. */
  save(poolId: string, state: KeyState): Promise<void>;
}

/** Holds state for the process only. Tests and hosts without a database use it. */
export class InMemoryKeyPoolStateStore implements KeyPoolStateStore {
  private readonly pools = new Map<string, Map<string, KeyState>>();

  async load(poolId: string): Promise<KeyState[] | null> {
    const rows = this.pools.get(poolId);
    return rows ? Array.from(rows.values()).map((row) => ({ ...row })) : null;
  }

  async save(poolId: string, state: KeyState): Promise<void> {
    let rows = this.pools.get(poolId);
    if (!rows) {
      rows = new Map();
      this.pools.set(poolId, rows);
    }
    const current = rows.get(state.fingerprint);
    if (current && current.updatedAt > state.updatedAt) return;
    rows.set(state.fingerprint, { ...state });
  }
}

const prefixPattern = /^[a-z][a-z0-9_]{0,37}$/;

function prefixOf(value = 'agentos'): string {
  if (!prefixPattern.test(value)) throw new Error(`KeyPoolStateStore: invalid table prefix "${value}"`);
  return value;
}

/** Portable DDL for the pool state table; hosts may copy it into their own migrations. */
export function keyPoolStateDdl(tablePrefix?: string): string {
  const p = prefixOf(tablePrefix);
  return `
CREATE TABLE IF NOT EXISTS ${p}_key_pool_state (
  pool_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (pool_id, fingerprint)
);
`;
}

/** Default DDL under the `agentos` prefix. */
export const KEY_POOL_STATE_DDL = keyPoolStateDdl();

/** Options of {@link SqlKeyPoolStateStore}. */
export interface SqlKeyPoolStateStoreOptions {
  /** The adapter the pool state lives in; the product's own, or a separate one. */
  db: StorageAdapter;
  /** The table prefix, `agentos` by default. */
  tablePrefix?: string;
  /** Create the table on first use (default) or leave it to host migrations. */
  ensureSchema?: boolean;
}

function parseState(raw: unknown): KeyState | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<KeyState>;
    if (
      parsed.version !== 1 ||
      typeof parsed.fingerprint !== 'string' ||
      typeof parsed.label !== 'string' ||
      (parsed.status !== 'ok' && parsed.status !== 'resting' && parsed.status !== 'failed') ||
      typeof parsed.failures !== 'number' ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return null;
    }
    return parsed as KeyState;
  } catch {
    return null;
  }
}

/**
 * Pool state over `@framers/sql-storage-adapter`: one row per pool and key,
 * written with "newest wins", so two instances sharing a pool id merge by key
 * instead of overwriting each other's snapshot.
 */
export class SqlKeyPoolStateStore implements KeyPoolStateStore {
  private readonly prefix: string;
  private schema?: Promise<void>;

  constructor(private readonly options: SqlKeyPoolStateStoreOptions) {
    this.prefix = prefixOf(options.tablePrefix);
  }

  /** Creates the table once, or leaves the schema to host migrations when disabled. */
  ensureSchema(): Promise<void> {
    if (this.options.ensureSchema === false) return Promise.resolve();
    this.schema ??= this.options.db
      .exec(keyPoolStateDdl(this.prefix))
      .then(() => undefined)
      .catch((error: unknown) => {
        this.schema = undefined;
        throw error;
      });
    return this.schema;
  }

  async load(poolId: string): Promise<KeyState[] | null> {
    await this.ensureSchema();
    const rows = await this.options.db.all<{ state: unknown; version: unknown }>(
      `SELECT state, version FROM ${this.prefix}_key_pool_state WHERE pool_id = ?`,
      [poolId],
    );
    if (rows.length === 0) return null;
    const states: KeyState[] = [];
    for (const row of rows) {
      if (Number(row.version) !== 1) continue;
      const state = parseState(row.state);
      if (state) states.push(state);
    }
    return states;
  }

  async save(poolId: string, state: KeyState): Promise<void> {
    await this.ensureSchema();
    const t = `${this.prefix}_key_pool_state`;
    await this.options.db.run(
      `INSERT INTO ${t} (pool_id, fingerprint, state, version, updated_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (pool_id, fingerprint) DO UPDATE SET state = excluded.state, version = excluded.version, updated_at = excluded.updated_at
       WHERE excluded.updated_at >= ${t}.updated_at`,
      [poolId, state.fingerprint, JSON.stringify(state), state.updatedAt],
    );
  }

  /** Redacts the adapter and connection details. */
  toJSON(): string {
    return '[SqlKeyPoolStateStore]';
  }
}
