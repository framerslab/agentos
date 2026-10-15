import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { CallRecord, ITelephonyCallStore, TelephonyCallTransaction, VoiceProviderName } from './types.js';
function identifier(value: string): void { if (!value || value.length > 512) throw new Error('invalid carrier identity'); }
function aliases(call: CallRecord): string[] { return [...new Set([call.providerCallId, call.providerRequestId ? `request:${call.providerRequestId}` : undefined].filter((v): v is string => Boolean(v)))]; }
function validate(call: CallRecord, provider: string): void {
  identifier(call.callId); identifier(provider); if (call.provider !== provider) throw new Error('carrier provider mismatch');
  for (const alias of aliases(call)) identifier(alias);
  if (!Array.isArray(call.processedEventIds) || call.processedEventIds.length > 10000 || new Set(call.processedEventIds).size !== call.processedEventIds.length) throw new Error('carrier event retention bound');
}
/** Reference store with rollback; a shared deployment uses the SQL or another conforming durable adapter. */
export class InMemoryTelephonyCallStore implements ITelephonyCallStore {
  private rows = new Map<string, CallRecord>();
  private index = new Map<string, string>();
  private tail: Promise<void> = Promise.resolve();
  /** Serializes the reference store and commits rows and aliases together. */
  async withProvider<T>(provider: VoiceProviderName, work: (tx: TelephonyCallTransaction) => Promise<T>): Promise<T> {
    identifier(provider); const previous = this.tail; let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; }); await previous;
    const rows = structuredClone(this.rows); const index = new Map(this.index); const key = (id: string) => JSON.stringify([provider, id]);
    const get = async (id: string): Promise<CallRecord | undefined> => { const row = rows.get(key(id)); return row ? structuredClone(row) : undefined; };
    const tx: TelephonyCallTransaction = { get, find: async (id) => { const local = index.get(key(id)); return local ? get(local) : undefined; }, put: async (input) => {
      const call = structuredClone(input); validate(call, provider);
      for (const alias of aliases(call)) { const bound = index.get(key(alias)); if (bound && bound !== call.callId) throw new Error('carrier alias conflict'); }
      rows.set(key(call.callId), call); for (const alias of aliases(call)) index.set(key(alias), call.callId);
    } };
    try { const result = await work(tx); this.rows = rows; this.index = index; return result; }
    finally { release(); }
  }
}
function tablePrefix(prefix: string): string { if (!/^[a-z][a-z0-9_]{0,39}$/.test(prefix)) throw new Error('invalid carrier table prefix'); return prefix; }
/** PostgreSQL DDL; an account uses its own configured namespace and never a browser-selected prefix. */
export function telephonyCallStoreDdl(prefix = 'telephony'): string {
  const p = tablePrefix(prefix);
  return `CREATE TABLE IF NOT EXISTS ${p}_anchors (provider TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS ${p}_calls (provider TEXT NOT NULL, call_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY (provider, call_id));
CREATE TABLE IF NOT EXISTS ${p}_aliases (provider TEXT NOT NULL, alias TEXT NOT NULL, call_id TEXT NOT NULL, PRIMARY KEY (provider, alias));`;
}
/** PostgreSQL state and alias store; transaction callbacks contain no external side effects. */
export class SqlTelephonyCallStore implements ITelephonyCallStore {
  private readonly prefix: string;
  /** Uses the host's existing PostgreSQL adapter and an already migrated account namespace. */
  constructor(private readonly db: StorageAdapter, prefix = 'telephony') { this.prefix = tablePrefix(prefix); }
  /** The anchor serializes first-row creation, alias binding, state and event-id commits across clients. */
  async withProvider<T>(provider: VoiceProviderName, work: (tx: TelephonyCallTransaction) => Promise<T>): Promise<T> {
    identifier(provider); const p = this.prefix;
    return this.db.transaction(async (db) => {
      await db.run(`INSERT INTO ${p}_anchors (provider) VALUES (?) ON CONFLICT (provider) DO NOTHING`, [provider]);
      await db.get(`SELECT provider FROM ${p}_anchors WHERE provider = ? FOR UPDATE`, [provider]);
      const get = async (id: string): Promise<CallRecord | undefined> => {
        const row = await db.get<{ record_json: string }>(`SELECT record_json FROM ${p}_calls WHERE provider = ? AND call_id = ?`, [provider, id]);
        if (!row) return undefined; const call = JSON.parse(row.record_json) as CallRecord; validate(call, provider); return call;
      };
      const tx: TelephonyCallTransaction = { get, find: async (id) => {
        const row = await db.get<{ call_id: string }>(`SELECT call_id FROM ${p}_aliases WHERE provider = ? AND alias = ?`, [provider, id]);
        return row ? get(row.call_id) : undefined;
      }, put: async (input) => {
        const call = structuredClone(input); validate(call, provider);
        for (const alias of aliases(call)) {
          const previous = await db.get<{ call_id: string }>(`SELECT call_id FROM ${p}_aliases WHERE provider = ? AND alias = ?`, [provider, alias]);
          if (previous && previous.call_id !== call.callId) throw new Error('carrier alias conflict');
          await db.run(`INSERT INTO ${p}_aliases (provider, alias, call_id) VALUES (?, ?, ?) ON CONFLICT (provider, alias) DO NOTHING`, [provider, alias, call.callId]);
        }
        await db.run(`INSERT INTO ${p}_calls (provider, call_id, record_json) VALUES (?, ?, ?) ON CONFLICT (provider, call_id) DO UPDATE SET record_json = EXCLUDED.record_json`, [provider, call.callId, JSON.stringify(call)]);
      } };
      return work(tx);
    });
  }
}
