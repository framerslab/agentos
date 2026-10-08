import Database from 'better-sqlite3';
import type { IStorageAdapter } from '../../EmergentToolRegistry.js';

/** A real in-memory SQLite store behind the registry's storage interface. */
export type SqliteTestAdapter = IStorageAdapter & {
  raw: Database.Database;
  /** Makes the next statement whose SQL contains `fragment` reject once. */
  failNext(fragment: string): void;
  /**
   * Holds the next statement whose SQL contains `fragment` until `release` is
   * called; `entered` resolves when that statement has started. For
   * interleaving one write with another.
   */
  gateNext(fragment: string): { entered: Promise<void>; release: () => void };
};

export function createSqliteAdapter(): SqliteTestAdapter {
  const raw = new Database(':memory:');
  let failFragment: string | null = null;
  let gate: { fragment: string; entered: () => void; released: Promise<void> } | null = null;
  const guard = (sql: string): void => {
    if (failFragment && sql.includes(failFragment)) {
      failFragment = null;
      throw new Error('simulated storage failure');
    }
  };
  const waitAtGate = async (sql: string): Promise<void> => {
    if (gate && sql.includes(gate.fragment)) {
      const g = gate;
      gate = null;
      g.entered();
      await g.released;
    }
  };
  return {
    raw,
    failNext(fragment: string) {
      failFragment = fragment;
    },
    gateNext(fragment: string) {
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate = { fragment, entered, released };
      return { entered: enteredPromise, release };
    },
    async run(sql: string, params: unknown[] = []) {
      guard(sql);
      await waitAtGate(sql);
      return raw.prepare(sql).run(...params);
    },
    async get(sql: string, params: unknown[] = []) {
      guard(sql);
      await waitAtGate(sql);
      return raw.prepare(sql).get(...params);
    },
    async all(sql: string, params: unknown[] = []) {
      guard(sql);
      return raw.prepare(sql).all(...params);
    },
    async exec(sql: string) {
      guard(sql);
      raw.exec(sql);
    },
  };
}

/** Reads one row of the state table, with `request_json` parsed. */
export function readStateRow(db: SqliteTestAdapter, toolId: string): Record<string, unknown> | undefined {
  const row = db.raw
    .prepare('SELECT * FROM agentos_emergent_tool_state WHERE tool_id = ?')
    .get(toolId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    ...row,
    request: typeof row.request_json === 'string' ? JSON.parse(row.request_json) : null,
  };
}

/** Reads one row of the tools table. */
export function readToolRow(db: SqliteTestAdapter, toolId: string): Record<string, unknown> | undefined {
  return db.raw.prepare('SELECT * FROM agentos_emergent_tools WHERE id = ?').get(toolId) as
    | Record<string, unknown>
    | undefined;
}
