import type { SqliteTestAdapter } from './sqlite-adapter.js';

export interface SeedRow {
  id: string;
  name: string;
  mode: 'sandbox' | 'compose';
  source: string;
  tier?: 'session' | 'agent' | 'shared';
  isActive?: 0 | 1;
  inputSchema?: Record<string, unknown>;
  /** The raw column text, so a test can write a schema column that does not read. */
  inputSchemaRaw?: string;
  outputSchema?: Record<string, unknown>;
}

/**
 * Inserts a tool row the way releases before the state table, and hosts' own
 * SQL, wrote them: every column of agentos_emergent_tools and no state row.
 */
export function seedToolRow(db: SqliteTestAdapter, row: SeedRow): void {
  db.raw
    .prepare(
      `INSERT INTO agentos_emergent_tools
         (id, name, description, input_schema, output_schema, implementation_mode,
          implementation_source, tier, created_by_agent, created_by_session,
          created_at, promoted_at, promoted_by, judge_verdicts, confidence_score,
          total_uses, success_count, failure_count, avg_execution_ms, last_used_at,
          is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.name,
      `Seeded tool ${row.name}.`,
      row.inputSchemaRaw ?? JSON.stringify(row.inputSchema ?? { type: 'object', properties: {} }),
      JSON.stringify(row.outputSchema ?? { type: 'object', properties: {} }),
      row.mode,
      row.source,
      row.tier ?? 'shared',
      'agent-seed',
      'sess-seed',
      1_700_000_000_000,
      null,
      null,
      '[]',
      0.9,
      0,
      0,
      0,
      0,
      null,
      row.isActive ?? 1,
    );
}

export interface SeedStateRow {
  toolId: string;
  state: 'active' | 'suspended' | 'demoted';
  reason?: string | null;
  /** Who set the state; a row written without the column reads as the host's. */
  setBy?: 'library' | 'host';
  /** The raw column text, so a test can write a request this release does not read. */
  requestJson: string | null;
}

/** Inserts a state row as another release or process would have written it. */
export function seedStateRow(db: SqliteTestAdapter, row: SeedStateRow): void {
  db.raw
    .prepare(
      `INSERT INTO agentos_emergent_tool_state
         (tool_id, state, state_reason, set_by, state_at, request_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.toolId,
      row.state,
      row.reason ?? null,
      row.setBy ?? 'host',
      1_700_000_000_000,
      row.requestJson,
      1_700_000_000_000,
    );
}

export const RAW_DOUBLE = 'function execute(input) { return { doubled: input.n * 2 }; }';
export const RAW_ID = 'function execute(input) { return { id: crypto.randomUUID() }; }';
export const NUMBER_IN = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] };
export const DOUBLED_OUT = {
  type: 'object',
  properties: { doubled: { type: 'number' } },
  required: ['doubled'],
};
export const ID_OUT = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
export const TEXT_IN = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
export const TEXT_OUT = { type: 'object', properties: { text: { type: 'string' } } };
