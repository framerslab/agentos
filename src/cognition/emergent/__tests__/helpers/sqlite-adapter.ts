import Database from 'better-sqlite3';
import type { IStorageAdapter } from '../../EmergentToolRegistry.js';

/** A real in-memory SQLite store behind the registry's storage interface. */
export type SqliteTestAdapter = IStorageAdapter & {
  raw: Database.Database;
  /** Makes the next statement whose SQL contains `fragment` reject once. */
  failNext(fragment: string): void;
};

export function createSqliteAdapter(): SqliteTestAdapter {
  const raw = new Database(':memory:');
  let failFragment: string | null = null;
  const guard = (sql: string): void => {
    if (failFragment && sql.includes(failFragment)) {
      failFragment = null;
      throw new Error('simulated storage failure');
    }
  };
  return {
    raw,
    failNext(fragment: string) {
      failFragment = fragment;
    },
    async run(sql: string, params: unknown[] = []) {
      guard(sql);
      return raw.prepare(sql).run(...params);
    },
    async get(sql: string, params: unknown[] = []) {
      guard(sql);
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
