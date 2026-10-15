import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { VoiceStoreConflict, voiceInteger, type VoiceRow, type VoiceSlotLease, type VoiceStore, type VoiceTable, type VoiceTableValues, type VoiceTransaction } from './types.js';

const domains = ['calls', 'usage', 'events', 'idempotency', 'credentials', 'slots'] as const;
/** Tables owned by voicePlatformDdl; useful for isolated migration fixtures. */
export const VOICE_PLATFORM_TABLES = [...domains, 'scope_locks', 'host_locks'] as const;
function prefixOf(prefix = 'agentos_voice'): string {
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(prefix)) throw new Error('invalid voice table prefix');
  return prefix;
}
/** Portable DDL; production hosts apply it through their migration runner. */
export function voicePlatformDdl(prefix = 'agentos_voice'): string {
  const p = prefixOf(prefix);
  return domains.map((t) => `CREATE TABLE IF NOT EXISTS ${p}_${t} (
    scope_id TEXT NOT NULL, row_id TEXT NOT NULL, version BIGINT NOT NULL CHECK (version > 0),
    value_json TEXT NOT NULL${t === 'slots' ? ', host_id TEXT NOT NULL' : ''},
    PRIMARY KEY (scope_id, row_id)
  );`).join('\n') + `
CREATE INDEX IF NOT EXISTS idx_${p}_slots_host ON ${p}_slots (host_id);
CREATE TABLE IF NOT EXISTS ${p}_scope_locks (scope_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS ${p}_host_locks (host_id TEXT PRIMARY KEY);
`;
}
/** Adapter and migration options. Shared deployments require transactions, persistence and concurrency. */
export interface SqlVoiceStoreOptions {
  db: StorageAdapter; tablePrefix?: string; ensureSchema?: boolean; requireShared?: boolean;
}
type Raw = { scope_id: string; row_id: string; version: number | string; value_json: string };
function decode<T>(r: Raw): VoiceRow<T> {
  return { scopeId: r.scope_id, id: r.row_id, version: voiceInteger(Number(r.version), 1), value: JSON.parse(r.value_json) as T };
}
class SqlTransaction implements VoiceTransaction {
  live = true;
  private host: string | undefined;
  constructor(readonly scopeId: string, private readonly db: StorageAdapter, private readonly prefix: string) {}
  private check(): void { if (!this.live) throw new Error('transaction closed'); }
  private table(table: VoiceTable): string {
    if (!domains.includes(table)) throw new Error('invalid voice table');
    return `${this.prefix}_${table}`;
  }
  async get<K extends VoiceTable>(table: K, id: string): Promise<VoiceRow<VoiceTableValues[K]> | undefined> {
    this.check();
    const row = await this.db.get<Raw>(`SELECT * FROM ${this.table(table)} WHERE scope_id = ? AND row_id = ?`, [this.scopeId, id]);
    return row ? decode<VoiceTableValues[K]>(row) : undefined;
  }
  async list<K extends VoiceTable>(table: K): Promise<Array<VoiceRow<VoiceTableValues[K]>>> {
    this.check();
    return (await this.db.all<Raw>(`SELECT * FROM ${this.table(table)} WHERE scope_id = ? ORDER BY row_id`, [this.scopeId])).map((r) => decode<VoiceTableValues[K]>(r));
  }
  async put<K extends VoiceTable>(table: K, id: string, value: VoiceTableValues[K], expectedVersion: number): Promise<void> {
    this.check(); voiceInteger(expectedVersion); voiceInteger(expectedVersion + 1);
    if (table === 'events' && expectedVersion !== 0) throw new VoiceStoreConflict();
    let host: string | undefined;
    if (table === 'slots') {
      host = (value as VoiceSlotLease).hostId;
      const previous = await this.get('slots', id);
      if (host !== this.host || (previous && previous.value.hostId !== host)) throw new Error('host lock required');
    }
    const json = JSON.stringify(value);
    const result = expectedVersion === 0
      ? await this.db.run(`INSERT INTO ${this.table(table)} (scope_id, row_id, version, value_json${host === undefined ? '' : ', host_id'}) VALUES (?, ?, ?, ?${host === undefined ? '' : ', ?'}) ON CONFLICT DO NOTHING`,
        [this.scopeId, id, 1, json, ...(host === undefined ? [] : [host])])
      : await this.db.run(`UPDATE ${this.table(table)} SET version = ?, value_json = ? WHERE scope_id = ? AND row_id = ? AND version = ?`,
        [expectedVersion + 1, json, this.scopeId, id, expectedVersion]);
    if (result.changes !== 1) throw new VoiceStoreConflict();
  }
  async lockHost(hostId: string): Promise<Array<VoiceRow<VoiceSlotLease>>> {
    this.check();
    if (this.host !== undefined && this.host !== hostId) throw new Error('one host per transaction');
    await this.db.run(`INSERT INTO ${this.prefix}_host_locks (host_id) VALUES (?) ON CONFLICT (host_id) DO UPDATE SET host_id = excluded.host_id`, [hostId]);
    this.host = hostId;
    return (await this.db.all<Raw>(`SELECT * FROM ${this.prefix}_slots WHERE host_id = ? ORDER BY scope_id, row_id`, [hostId])).map((r) => decode<VoiceSlotLease>(r));
  }
}
/** SQL implementation; every operation uses the callback's transaction-bound adapter. */
export class SqlVoiceStore implements VoiceStore {
  private readonly prefix: string;
  private schema: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: SqlVoiceStoreOptions) {
    this.prefix = prefixOf(options.tablePrefix);
    const caps = options.db.capabilities;
    if (!caps.has('transactions')) throw new Error('voice store requires transactions');
    if (options.requireShared !== false && (!caps.has('persistence') || !caps.has('concurrent'))) throw new Error('voice store requires shared persistence');
  }
  /** Creates every table, including missing tables after a partially applied development schema. */
  ensureSchema(): Promise<void> {
    if (this.options.ensureSchema === false) return Promise.resolve();
    this.schema ??= this.options.db.exec(voicePlatformDdl(this.prefix)).then(() => undefined).catch((error) => { this.schema = undefined; throw error; });
    return this.schema;
  }
  withTransaction<T>(scopeId: string, fn: (tx: VoiceTransaction) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.ensureSchema();
      return this.options.db.transaction(async (db) => {
        await db.run(`INSERT INTO ${this.prefix}_scope_locks (scope_id) VALUES (?) ON CONFLICT (scope_id) DO UPDATE SET scope_id = excluded.scope_id`, [scopeId]);
        const tx = new SqlTransaction(scopeId, db, this.prefix);
        try { return await fn(tx); } finally { tx.live = false; }
      });
    };
    if (this.options.requireShared !== false) return run();
    const result = this.queue.then(run); this.queue = result.catch(() => undefined); return result;
  }
  /** Redacts the adapter and all constructor options. */
  toJSON(): string { return '[SqlVoiceStore]'; }
}
