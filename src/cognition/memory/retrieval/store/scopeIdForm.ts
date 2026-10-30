/**
 * @module memory/retrieval/store/scopeIdForm
 *
 * The written form of a plain id in a `user` or `persona` scope id, and the record that says which form a Brain
 * holds. A Brain a learning layer serves holds the encoded form: an id that holds a `/`, a `%` or a `:` is
 * percent-encoded (`encodeURIComponent`, which escapes all three, with a lone surrogate written `%u` and four
 * uppercase hexadecimal digits, a sequence `encodeURIComponent` never writes), and every other id keeps its form.
 * The rule is one-to-one: an encoded id holds a `%` and an unchanged one holds none. The layer's namespaced and
 * session forms build on {@link encodeScopeIdPart}, so no plain form equals one of them.
 *
 * A Brain that no layer serves keeps the plain form its readers expect. The first time a layer opens a Brain, the
 * Brain's plain `user` and `persona` scope ids that hold one of the three characters are re-filed in the encoded
 * form, with the knowledge-graph memory nodes the Brain holds under them, in one transaction that writes the record
 * `brain_meta (brain_id, 'scope_id_form', 'encoded')`, which is written whatever the Brain holds. Every live
 * `MemoryStore` on the Brain in this process then moves what it holds of the traces the re-file moved
 * ({@link onBrainRefiled}). Once the record is written, a scope id that holds a `/` is a layer's namespaced id
 * (`team/ana`: user `ana` of namespace `team`), never a plain one.
 *
 * An import takes its source's form from the source's own record (a JSON export's `meta`, a SQLite file's
 * `brain_meta`, the mark on a note an encoded Brain's Markdown export wrote); a CSV file, and a source without the
 * record, is plain. Into a Brain that holds the record a plain source's ids are encoded as they are written, each
 * trace's knowledge-graph copy with them; a source with the record goes into a Brain without it only when that Brain
 * holds no plain id the record would read as another, and the record is written with it
 * ({@link importScopeIdFormDecision}, which reads the Brain's form in the transaction the import writes in). An export
 * reads its record and its rows in one form ({@link readInOneScopeIdForm}). The RAG migration copies rows as they are,
 * so it refuses where an import would encode ({@link scopeIdFormHandshake}).
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { Brain } from './Brain.js';
import { fillScopeIds } from './migrations/v2-to-v3.js';
import {
  ENCODED_SCOPE_ID_FORM,
  holdsEncodedScopeIdForm,
  parseTraceMetadata,
  SCOPE_ID_FORM_KEY,
  scopeIdOfMetadata,
  type TraceSnapshot,
} from './tracePersistence.js';

/** The `brain_meta` key of the record, and the record's value for a Brain that holds the encoded form. */
export { ENCODED_SCOPE_ID_FORM, SCOPE_ID_FORM_KEY };

const RESERVED = /[/%:]/;

/** Whether a plain id holds a `/`, a `%` or a `:`. */
export function holdsReservedCharacter(id: string): boolean {
  return RESERVED.test(id);
}

/** `%u` and the code unit as four uppercase hexadecimal digits. */
const loneSurrogate = (code: number): string => `%u${code.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * `encodeURIComponent` of an id, with each lone surrogate written `%u` and four uppercase hexadecimal digits in
 * place of the `URIError` `encodeURIComponent` throws for it. Never throws.
 */
export function encodeScopeIdPart(id: string): string {
  let out = '';
  let run = '';
  for (let i = 0; i < id.length; i += 1) {
    const code = id.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = id.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        run += id.slice(i, i + 2);
        i += 1;
        continue;
      }
      out += encodeURIComponent(run) + loneSurrogate(code);
      run = '';
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += encodeURIComponent(run) + loneSurrogate(code);
      run = '';
      continue;
    }
    run += id[i];
  }
  return out + encodeURIComponent(run);
}

/** A plain id in the encoded form: percent-encoded when it holds a reserved character, else as it is. */
export function encodePlainId(id: string): string {
  return holdsReservedCharacter(id) ? encodeScopeIdPart(id) : id;
}

/**
 * The encoded form of a scope id a release before the layer filed. A `user` id is one plain id; a `persona` id is
 * `<userId>::<personaId>`, split at its last `::` (no shipped persona id holds `::`); every other scope keeps its id,
 * since a thread's or an organization's plain form is not re-filed.
 */
export function encodePlainScopeId(scope: string, scopeId: string): string {
  if (scope === 'user') return encodePlainId(scopeId);
  if (scope !== 'persona') return scopeId;
  const at = scopeId.lastIndexOf('::');
  if (at < 0) return encodePlainId(scopeId);
  return `${encodePlainId(scopeId.slice(0, at))}::${encodePlainId(scopeId.slice(at + 2))}`;
}

/**
 * A snapshot read from a Brain in the plain form (`TraceSnapshot.scopeIdForm`), as a Brain re-filed since holds its
 * row: the scope id in the encoded form, in the snapshot's column and in its metadata's `scopeId`, as the re-file
 * writes a row. A snapshot whose column holds `''` while its metadata names a scope id (a row a release older than
 * the column wrote, which the re-file files first) takes the metadata's id, encoded, in both, since the next fill
 * would file that id as it is. A scope id the rule keeps stays as it is.
 */
export function snapshotInEncodedForm(snapshot: TraceSnapshot): TraceSnapshot {
  const filed = snapshot.scopeId !== '' ? snapshot.scopeId : scopeIdOfMetadata(snapshot.metadata);
  const to = encodePlainScopeId(snapshot.scope, filed);
  if (to === filed) return { ...snapshot, scopeIdForm: ENCODED_SCOPE_ID_FORM };
  const metadata = parseTraceMetadata(snapshot.metadata);
  metadata.scopeId = to;
  return { ...snapshot, scopeId: to, metadata: JSON.stringify(metadata), scopeIdForm: ENCODED_SCOPE_ID_FORM };
}

/**
 * Takes the brain's scope-id form lock inside a Postgres transaction, the advisory lock a re-file takes first
 * ({@link refileBrainScopeIds}): a write that reads the record in the same transaction then sees the record of a
 * re-file another process commits meanwhile, or the re-file sees the write. It is released at COMMIT or ROLLBACK.
 */
export async function takeScopeIdFormLock(trx: Pick<StorageAdapter, 'run'>, brainId: string): Promise<void> {
  await trx.run('SELECT pg_advisory_xact_lock(hashtext($1))', [`agentos_brain_scope_id_form:${brainId}`]);
}

/** One scope id the re-file moved. */
export interface ScopeIdRefile {
  scope: string;
  from: string;
  to: string;
  /** The rows of the brain it moved under this pair. */
  traces: number;
}

/** What a re-file did: nothing, for a Brain that holds the record already; else the pairs it moved. */
export interface BrainRefileResult {
  alreadyEncoded: boolean;
  moved: ScopeIdRefile[];
}

/** One trace a re-file moved. */
export interface RefiledTrace {
  /** The trace's id. */
  id: string;
  /** The trace's scope: `user` or `persona`. */
  scope: string;
  /** The plain scope id it was filed under. */
  from: string;
  /** The encoded scope id it is filed under now. */
  to: string;
}

/**
 * Told, in this process, of each re-file that moved traces, once it has committed: the coordination token of the
 * Brain re-filed ({@link Brain.coordinationToken}, which every handle on that brain of that store shares in this
 * process) and the traces it moved. `MemoryStore` registers one, through which every live store on the Brain moves
 * what it holds of those traces.
 */
export type BrainRefileListener = (coordinationToken: object, traces: readonly RefiledTrace[]) => Promise<void>;

const refileListeners = new Set<BrainRefileListener>();

/**
 * Registers a {@link BrainRefileListener}.
 *
 * @returns A function that removes it.
 */
export function onBrainRefiled(listener: BrainRefileListener): () => void {
  refileListeners.add(listener);
  return () => {
    refileListeners.delete(listener);
  };
}

/** Rows read per page while a Brain is re-filed. */
const PAGE = 500;

/** How many times a re-file reads a row another writer keeps changing before it gives up. */
const ROW_READS = 3;

/**
 * The SQLite re-files of this process, one after another. Two handles on one file in one process are two
 * connections: the second's write would wait for the first's lock with the event loop stopped, the first could not
 * finish meanwhile, and the second would fail once the driver's busy timeout ran out. Taking turns, the second reads
 * the record the first wrote. Postgres takes the brain's advisory lock instead, which also orders two processes.
 */
let sqliteTurns: Promise<unknown> = Promise.resolve();

function inSqliteTurn<T>(run: () => Promise<T>): Promise<T> {
  const turn = sqliteTurns.then(run);
  sqliteTurns = turn.catch(() => undefined);
  return turn;
}

/**
 * Re-files one brain's plain `user` and `persona` scope ids that hold a `/`, a `%` or a `:` in the encoded form,
 * the column and the metadata JSON's `scopeId` together, with the knowledge-graph memory nodes the brain holds under
 * them (`knowledge_nodes`: the stored context's `scopeId` and the node's participants; a trace's copy is one, and so
 * is a copy whose trace is gone), and writes the record, all in one transaction. Soft-deleted rows move too, so a
 * later delete of the encoded id finds them. The rows a release older than the `scope_id` column filed since the
 * Brain opened, which hold `''` there, are filed first (`fillScopeIds`), so they move with the rest. Each row and node
 * is written with a compare against what the re-file read, so on Postgres a write another process commits meanwhile
 * is read again and kept. Other brains of the same store are not read.
 *
 * A brain that holds the record already (this process or another re-filed it) is left as it is. On Postgres the
 * transaction first takes an advisory lock on the brain, so two processes that first open one Brain together re-file
 * it one after the other and the second finds the record: at Read Committed each statement sees what committed before
 * it began, and without the lock the second would read the first's encoded ids, and the namespaced ids written since,
 * and encode them again. The SQLite re-files of one process take turns; a second process's transaction on the same
 * file fails instead, and a later call reads the record.
 *
 * Once it has committed, every {@link BrainRefileListener} of this process is told which traces it moved, and the
 * call returns after they have run: every live `MemoryStore` on the Brain has moved what it holds of them by then, or
 * reported the move it could not make.
 *
 * @returns The pairs it moved, sorted by scope and id.
 * @throws When a row or memory node changed under each of three reads, or a statement fails; the transaction rolls
 *   back, the record stays unwritten, and a later call re-files the Brain.
 */
export async function refileBrainScopeIds(
  brain: Pick<Brain, 'brainId' | 'transaction' | 'features' | 'getMeta' | 'adapter' | 'coordinationToken'>,
): Promise<BrainRefileResult> {
  if ((await brain.getMeta(SCOPE_ID_FORM_KEY)) === ENCODED_SCOPE_ID_FORM) return { alreadyEncoded: true, moved: [] };
  const refile = () => refileInTransaction(brain);
  const outcome = brain.adapter.kind.includes('postgres') ? await refile() : await inSqliteTurn(refile);
  if (outcome.alreadyEncoded) return { alreadyEncoded: true, moved: [] };
  if (outcome.traces.length > 0) await tellListeners(brain.coordinationToken, outcome.traces);
  return {
    alreadyEncoded: false,
    moved: [...outcome.moved.values()].sort((a, b) =>
      a.scope === b.scope ? (a.from < b.from ? -1 : 1) : a.scope < b.scope ? -1 : 1,
    ),
  };
}

async function tellListeners(coordinationToken: object, traces: readonly RefiledTrace[]): Promise<void> {
  for (const listener of [...refileListeners]) {
    try {
      await listener(coordinationToken, traces);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[scopeIdForm] a store could not follow a Brain's re-file of ${traces.length} traces: ${message}`);
    }
  }
}

/**
 * On Postgres, takes the brain's scope-id form lock ({@link takeScopeIdFormLock}). A re-file takes it first, and so
 * does every import, so each reads the record another committed before it, and no import writes beside a re-file.
 */
async function lockScopeIdForm(trx: StorageAdapter, brain: Pick<Brain, 'brainId' | 'adapter'>): Promise<void> {
  if (brain.adapter.kind.includes('postgres')) await takeScopeIdFormLock(trx, brain.brainId);
}

/** The re-file's transaction ({@link refileBrainScopeIds}). */
async function refileInTransaction(
  brain: Pick<Brain, 'brainId' | 'transaction' | 'features' | 'adapter'>,
): Promise<{ alreadyEncoded: boolean; moved: Map<string, ScopeIdRefile>; traces: RefiledTrace[] }> {
  const moved = new Map<string, ScopeIdRefile>();
  const traces: RefiledTrace[] = [];
  let alreadyEncoded = false;
  await brain.transaction(async (trx) => {
    // The record is read after the lock, so a re-file another process committed is seen.
    await lockScopeIdForm(trx, brain);
    const record = await trx.get<{ value: string }>(
      'SELECT value FROM brain_meta WHERE brain_id = ? AND key = ?',
      [brain.brainId, SCOPE_ID_FORM_KEY],
    );
    if (record?.value === ENCODED_SCOPE_ID_FORM) {
      alreadyEncoded = true;
      return;
    }
    // A release older than the column writes '' there; the rows it filed since the open move with the rest.
    await fillScopeIds(trx, brain.brainId);
    await refileTraceRows(trx, brain.brainId, moved, traces);
    await refileTraceCopies(trx, brain.brainId);
    await writeScopeIdFormRecord(trx, brain);
  });
  return { alreadyEncoded, moved, traces };
}

/** Pages through the brain's `user` and `persona` rows by id and moves each plain id that holds a reserved character. */
async function refileTraceRows(
  trx: StorageAdapter,
  brainId: string,
  moved: Map<string, ScopeIdRefile>,
  traces: RefiledTrace[],
): Promise<void> {
  // The first page starts at '' itself: an id can be the empty string (the JSON importer keeps a record's id "").
  let afterId: string | null = null;
  for (;;) {
    const rows: Array<{ id: string; scope: string; scope_id: string; metadata: string | null }> = await trx.all<{
      id: string;
      scope: string;
      scope_id: string;
      metadata: string | null;
    }>(
      `SELECT id, scope, scope_id, metadata FROM memory_traces
        WHERE brain_id = ? AND scope IN ('user', 'persona') AND scope_id <> '' AND id ${afterId === null ? '>=' : '>'} ?
        ORDER BY id LIMIT ${PAGE}`,
      [brainId, afterId ?? ''],
    );
    for (const row of rows) {
      const to = encodePlainScopeId(row.scope, row.scope_id);
      if (to === row.scope_id || !(await refileTraceRow(trx, brainId, row, to))) continue;
      const key = `${row.scope}\u0000${row.scope_id}`;
      const entry = moved.get(key) ?? { scope: row.scope, from: row.scope_id, to, traces: 0 };
      entry.traces += 1;
      moved.set(key, entry);
      traces.push({ id: row.id, scope: row.scope, from: row.scope_id, to });
    }
    if (rows.length < PAGE) return;
    afterId = rows[rows.length - 1]!.id;
  }
}

/**
 * Writes one row under its encoded scope id: the column and the metadata's `scopeId`. The update compares the scope
 * id and the metadata with what was read, so a write another process committed since (an access, feedback, an
 * update) is read again and kept.
 *
 * @returns Whether it wrote the row: a row deleted or filed under another id meanwhile is left as it is.
 * @throws When the row changed under each of {@link ROW_READS} reads.
 */
async function refileTraceRow(
  trx: StorageAdapter,
  brainId: string,
  row: { id: string; scope: string; scope_id: string; metadata: string | null },
  to: string,
): Promise<boolean> {
  let metadata = row.metadata;
  for (let read = 0; read < ROW_READS; read += 1) {
    const next = parseTraceMetadata(metadata);
    next.scopeId = to;
    const result = await trx.run(
      `UPDATE memory_traces SET scope_id = ?, metadata = ?
        WHERE brain_id = ? AND id = ? AND scope = ? AND scope_id = ? AND ${metadata === null ? 'metadata IS NULL' : 'metadata = ?'}`,
      [to, JSON.stringify(next), brainId, row.id, row.scope, row.scope_id, ...(metadata === null ? [] : [metadata])],
    );
    if (result.changes > 0) return true;
    const current = await trx.get<{ scope: string; scope_id: string; metadata: string | null }>(
      'SELECT scope, scope_id, metadata FROM memory_traces WHERE brain_id = ? AND id = ?',
      [brainId, row.id],
    );
    if (!current || current.scope !== row.scope || current.scope_id !== row.scope_id) return false;
    metadata = current.metadata;
  }
  throw new Error(`refileBrainScopeIds: trace ${row.id}'s row changed under each of ${ROW_READS} reads while it moved`);
}

/** The text the stored JSON of a memory node holds when its context names a scope id, as `JSON.stringify` writes it. */
const SCOPE_ID_MARKER = '%"scopeId":%';

/**
 * Pages through the brain's knowledge-graph memory nodes (`knowledge_nodes` rows of type `memory`) whose stored
 * context names a scope, which a delete by scope (`deleteMemories`) matches, and re-files each one filed under a
 * plain `user` or `persona` id that holds a reserved character, the copy of a trace that is gone included: a delete by
 * scope of the encoded id then takes it, and one of the namespaced id the plain form now reads as takes none.
 */
async function refileTraceCopies(trx: StorageAdapter, brainId: string): Promise<void> {
  let afterId: string | null = null;
  for (;;) {
    const rows: Array<{ id: string; properties: string }> = await trx.all<{ id: string; properties: string }>(
      `SELECT id, properties FROM knowledge_nodes
        WHERE brain_id = ? AND type = 'memory' AND properties LIKE ? AND id ${afterId === null ? '>=' : '>'} ?
        ORDER BY id LIMIT ${PAGE}`,
      [brainId, SCOPE_ID_MARKER, afterId ?? ''],
    );
    for (const row of rows) await refileTraceCopy(trx, brainId, row);
    if (rows.length < PAGE) return;
    afterId = rows[rows.length - 1]!.id;
  }
}

/**
 * Writes one memory node's stored properties with its plain scope id re-filed, compared with what was read, as
 * {@link refileTraceRow} writes a row. A node deleted meanwhile is left as it is.
 *
 * @throws When the node changed under each of {@link ROW_READS} reads.
 */
async function refileTraceCopy(trx: StorageAdapter, brainId: string, row: { id: string; properties: string }): Promise<void> {
  let properties = row.properties;
  for (let read = 0; read < ROW_READS; read += 1) {
    const next = refiledCopyProperties(properties);
    if (next === undefined) return;
    const result = await trx.run(
      'UPDATE knowledge_nodes SET properties = ? WHERE brain_id = ? AND id = ? AND properties = ?',
      [next, brainId, row.id, properties],
    );
    if (result.changes > 0) return;
    const current = await trx.get<{ properties: string }>(
      'SELECT properties FROM knowledge_nodes WHERE brain_id = ? AND id = ?',
      [brainId, row.id],
    );
    if (!current) return;
    properties = current.properties;
  }
  throw new Error(`refileBrainScopeIds: knowledge-graph node ${row.id} changed under each of ${ROW_READS} reads while it moved`);
}

/**
 * A memory node's stored properties with its scope id in the encoded form: the stored context's `scopeId` and each of
 * the node's participants that names it. `undefined` for properties that do not parse, a node of another scope, and a
 * scope id the rule keeps.
 */
function refiledCopyProperties(properties: string): string | undefined {
  let stored: unknown;
  try {
    stored = JSON.parse(properties);
  } catch {
    return undefined;
  }
  if (!stored || typeof stored !== 'object') return undefined;
  const fields = stored as { _context?: unknown; _participants?: unknown };
  const context = fields._context;
  if (!context || typeof context !== 'object') return undefined;
  const { scope, scopeId } = context as Record<string, unknown>;
  if (typeof scope !== 'string' || typeof scopeId !== 'string' || scopeId === '') return undefined;
  const to = encodePlainScopeId(scope, scopeId);
  if (to === scopeId) return undefined;
  (context as Record<string, unknown>).scopeId = to;
  if (Array.isArray(fields._participants)) {
    fields._participants = fields._participants.map((participant) => (participant === scopeId ? to : participant));
  }
  return JSON.stringify(stored);
}

// ---------------------------------------------------------------------------
// The form of a source: imports, exports and the RAG migration
// ---------------------------------------------------------------------------

export { scopeIdOfMetadata };

/** What one side of an import or a migration holds for one brain. */
export interface BrainScopeIdForm {
  /** The brain holds the record (`scope_id_form` = `encoded`). */
  encoded: boolean;
  /** The brain holds at least one trace or knowledge-graph memory node. */
  rows: boolean;
  /**
   * The brain holds a plain `user` or `persona` scope id that the encoded form changes, in a trace or in a
   * knowledge-graph memory node: an id that, once the record is written, reads as another.
   */
  reserved: boolean;
}

/** A brain one side does not hold. */
export const ABSENT_BRAIN: BrainScopeIdForm = { encoded: false, rows: false, reserved: false };

/**
 * What an import or a migration does with one brain: `take` it as it is; `encode` the source's plain ids as they are
 * written (an import into a Brain with the record); `record`: take it and give the target the record; `clear`: take
 * it and remove the target's record (a migration into a brain that holds the record and no trace or memory node, from
 * a source without it); `refuse`, naming the record.
 */
export type ScopeIdFormDecision =
  | { action: 'take' }
  | { action: 'encode' }
  | { action: 'record' }
  | { action: 'clear' }
  | { action: 'refuse'; reason: string };

/** What a refusal says the side without the record holds. */
const PLAIN_IDS_THE_FORM_CHANGES =
  "plain user or persona scope ids that the encoded form changes (an id with '/', '%' or ':'), in a trace or a " +
  'knowledge-graph memory node';

/**
 * The scope-id form handshake for one brain. An import encodes a plain source's ids as it writes them
 * (`encodeOnWrite: true`); the RAG migration copies rows as they are and so refuses instead.
 */
export function scopeIdFormHandshake(
  brainId: string,
  source: BrainScopeIdForm,
  target: BrainScopeIdForm,
  options: { encodeOnWrite: boolean },
): ScopeIdFormDecision {
  if (source.encoded === target.encoded) return { action: 'take' };
  if (target.encoded) {
    if (options.encodeOnWrite) return { action: 'encode' };
    if (!target.rows) return { action: 'clear' };
    if (!source.reserved) return { action: 'take' };
    return {
      action: 'refuse',
      reason:
        `brain '${brainId}': the target holds the encoded scope-id form ('${SCOPE_ID_FORM_KEY}' = '${ENCODED_SCOPE_ID_FORM}' ` +
        `in brain_meta) and the source holds ${PLAIN_IDS_THE_FORM_CHANGES}. Open the source under a learning layer, ` +
        `which re-files it, then copy again.`,
    };
  }
  if (!target.reserved) return { action: 'record' };
  return {
    action: 'refuse',
    reason:
      `brain '${brainId}': the source holds the encoded scope-id form ('${SCOPE_ID_FORM_KEY}' = '${ENCODED_SCOPE_ID_FORM}' ` +
      `in brain_meta) and the target holds ${PLAIN_IDS_THE_FORM_CHANGES}. Open the target under a learning layer, ` +
      `which re-files it, then import or copy again.`,
  };
}

/** The `get` and `all` of a Brain, a transaction, a storage adapter, or a driver wrapped to look like one. */
export interface ScopeIdFormReader {
  get<T>(sql: string, params?: unknown[]): Promise<T | null | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** A `memory_traces` row a scan reads; a table from before the `scope_id` column has none. */
interface ScannedTrace {
  id: string;
  scope: string;
  scope_id?: string | null;
  metadata?: unknown;
}

/**
 * Whether one brain's traces hold a plain `user` or `persona` scope id that the encoded form changes
 * ({@link encodePlainScopeId}, the rule a re-file moves ids by): its `scope_id`, or its metadata's `scopeId` where the
 * column holds `''` or a table from before the column has none. A persona id is read part by part, so the `::`
 * between its user id and its persona id is none of the three characters. Pages by id from the empty id on, so a
 * trace whose id is `''` is read too, and stops at the first.
 */
async function tracesHoldReservedScopeIds(db: ScopeIdFormReader, brainId: string): Promise<boolean> {
  let columns = 'id, scope, scope_id, metadata';
  let afterId: string | null = null;
  for (;;) {
    let rows: ScannedTrace[];
    try {
      rows = await db.all<ScannedTrace>(
        `SELECT ${columns} FROM memory_traces
          WHERE brain_id = ? AND scope IN ('user', 'persona') AND id ${afterId === null ? '>=' : '>'} ?
          ORDER BY id LIMIT ${PAGE}`,
        [brainId, afterId ?? ''],
      );
    } catch (error) {
      // A table from before the scope_id column: the ids are read from the metadata.
      if (columns === 'id, scope, metadata') throw error;
      columns = 'id, scope, metadata';
      continue;
    }
    for (const row of rows) {
      const scopeId = typeof row.scope_id === 'string' && row.scope_id !== '' ? row.scope_id : scopeIdOfMetadata(row.metadata);
      if (scopeId !== '' && encodePlainScopeId(row.scope, scopeId) !== scopeId) return true;
    }
    if (rows.length < PAGE) return false;
    afterId = rows[rows.length - 1]!.id;
  }
}

/**
 * Whether one brain's knowledge-graph memory nodes hold a plain `user` or `persona` scope id that the encoded form
 * changes in their stored context: the nodes a re-file moves, a trace's copy and a copy whose trace is gone alike.
 * Pages by id from the empty id on, and stops at the first.
 */
async function copiesHoldReservedScopeIds(db: ScopeIdFormReader, brainId: string): Promise<boolean> {
  let afterId: string | null = null;
  for (;;) {
    const rows: Array<{ id: string; properties: unknown }> = await db.all<{ id: string; properties: unknown }>(
      `SELECT id, properties FROM knowledge_nodes
        WHERE brain_id = ? AND type = 'memory' AND properties LIKE ? AND id ${afterId === null ? '>=' : '>'} ?
        ORDER BY id LIMIT ${PAGE}`,
      [brainId, SCOPE_ID_MARKER, afterId ?? ''],
    );
    for (const row of rows) {
      if (typeof row.properties === 'string' && refiledCopyProperties(row.properties) !== undefined) return true;
    }
    if (rows.length < PAGE) return false;
    afterId = rows[rows.length - 1]!.id;
  }
}

/** Whether a statement that reads one row of a brain finds one. A store without the table holds none. */
async function holdsRow(db: ScopeIdFormReader, sql: string, brainId: string): Promise<boolean> {
  try {
    return Boolean(await db.get<{ id: string }>(sql, [brainId]));
  } catch {
    return false;
  }
}

/**
 * Whether one brain holds the record, read by a reader outside a transaction. A store without `brain_meta`, or one
 * from before brain ids, holds none.
 */
export async function readScopeIdFormRecord(db: ScopeIdFormReader, brainId: string): Promise<boolean> {
  try {
    return await holdsEncodedScopeIdForm(db, brainId);
  } catch {
    return false;
  }
}

/**
 * One brain's form as a store holds it, read by a reader outside a transaction (the RAG migration's). A store whose
 * tables lack a brain id reads as not holding the brain.
 */
export async function readBrainScopeIdForm(db: ScopeIdFormReader, brainId: string): Promise<BrainScopeIdForm> {
  const encoded = await readScopeIdFormRecord(db, brainId);
  const traces = await holdsRow(db, 'SELECT id FROM memory_traces WHERE brain_id = ? LIMIT 1', brainId);
  const copies = await holdsRow(db, "SELECT id FROM knowledge_nodes WHERE brain_id = ? AND type = 'memory' LIMIT 1", brainId);
  const reserved =
    (traces && (await tracesHoldReservedScopeIds(db, brainId))) || (copies && (await copiesHoldReservedScopeIds(db, brainId)));
  return { encoded, rows: traces || copies, reserved };
}

/**
 * Every brain a store holds (in `brain_meta` or `memory_traces`), with its form; or, given brain ids, those brains
 * alone, whether or not the store holds them.
 */
export async function readScopeIdForms(
  db: ScopeIdFormReader,
  brainIds?: readonly string[],
): Promise<Map<string, BrainScopeIdForm>> {
  const ids = new Set<string>(brainIds ?? []);
  if (!brainIds) {
    for (const sql of ['SELECT DISTINCT brain_id FROM brain_meta', 'SELECT DISTINCT brain_id FROM memory_traces']) {
      try {
        for (const row of await db.all<{ brain_id: string | null }>(sql)) {
          if (typeof row.brain_id === 'string') ids.add(row.brain_id);
        }
      } catch {
        // A store without the table, or one from before brain ids, holds no brain this handshake can name.
      }
    }
  }
  const forms = new Map<string, BrainScopeIdForm>();
  for (const id of [...ids].sort()) forms.set(id, await readBrainScopeIdForm(db, id));
  return forms;
}

/**
 * The scope-id form handshake of an import, made first in the transaction the import writes in. On Postgres it takes
 * the brain's form lock, which a re-file takes too, then it reads the record, so an import follows a re-file or
 * another import of the brain that commits first, and none writes beside a re-file. A source holds the encoded form
 * when its own record says so (a JSON export's `meta`, a SQLite file's `brain_meta`, the mark on a note an encoded
 * Brain's Markdown export wrote). A plain source is encoded as it is written into a Brain that holds the record
 * (`encode`), so its ids are not read. A source with the record goes into a Brain without it, which gets the record
 * (`record`, the caller's to write), unless the Brain holds a plain id the record would read as another (`refuse`).
 *
 * @param options.replacing - The import empties the brain first, so the ids the brain holds do not count.
 * @param options.reserved - Shared by the parts of one import (a Markdown folder's notes): once a scan has found such
 *   an id it is not made again.
 */
export async function importScopeIdFormDecision(
  trx: StorageAdapter,
  brain: Pick<Brain, 'brainId' | 'adapter'>,
  source: { encoded: boolean },
  options: { replacing?: boolean; reserved?: { found?: boolean } } = {},
): Promise<ScopeIdFormDecision> {
  await lockScopeIdForm(trx, brain);
  const encoded = await holdsEncodedScopeIdForm(trx, brain.brainId);
  let reserved = false;
  if (source.encoded && !encoded && !options.replacing) {
    reserved =
      options.reserved?.found === true ||
      (await tracesHoldReservedScopeIds(trx, brain.brainId)) ||
      (await copiesHoldReservedScopeIds(trx, brain.brainId));
    if (reserved && options.reserved) options.reserved.found = true;
  }
  return scopeIdFormHandshake(
    brain.brainId,
    { ...ABSENT_BRAIN, encoded: source.encoded },
    { encoded, rows: true, reserved },
    { encodeOnWrite: true },
  );
}

/** Writes the record that one brain holds the encoded form, through the transaction a re-file or an import writes in. */
export async function writeScopeIdFormRecord(
  trx: StorageAdapter,
  brain: Pick<Brain, 'brainId' | 'features'>,
): Promise<void> {
  await trx.run(
    brain.features.dialect.insertOrReplace('brain_meta', ['brain_id', 'key', 'value'], ['?', '?', '?'], 'brain_id, key'),
    [brain.brainId, SCOPE_ID_FORM_KEY, ENCODED_SCOPE_ID_FORM],
  );
}

/**
 * Reads a source so that the record it reports and the rows it reads hold one form: it reads whether the source holds
 * the record, then `read`, then the record again, and reads once more when the record changed in between. A re-file
 * moves the rows and writes the record in one transaction, so a pass whose record held still read the rows in the
 * form the record names. An export reads its Brain so, and the SQLite importer its source file.
 *
 * @param holdsRecord - Reads whether the source holds the record.
 * @param read - Reads the rows; told whether the source held the record when the pass began.
 * @returns What `read` returned on the pass whose record held still, and whether the source held the record.
 * @throws When the record changed under each of three passes.
 */
export async function readInOneScopeIdForm<T>(
  holdsRecord: () => Promise<boolean>,
  read: (encoded: boolean) => Promise<T>,
): Promise<{ value: T; encoded: boolean }> {
  for (let pass = 0; pass < ROW_READS; pass += 1) {
    const encoded = await holdsRecord();
    const value = await read(encoded);
    if ((await holdsRecord()) === encoded) return { value, encoded };
  }
  throw new Error(`a source's scope-id form record changed under each of ${ROW_READS} reads`);
}

/** Whether a Brain holds the record, read outside a transaction. */
export async function brainHoldsScopeIdFormRecord(brain: Pick<Brain, 'getMeta'>): Promise<boolean> {
  return (await brain.getMeta(SCOPE_ID_FORM_KEY)) === ENCODED_SCOPE_ID_FORM;
}

/**
 * A memory node's stored properties with its plain `user` or `persona` scope id in the encoded form, as a re-file
 * writes them (the stored context's `scopeId` and each participant that names it); any other properties as they are.
 * An import that encodes a plain source's traces as it writes them writes their copies so.
 */
export function encodedCopyProperties(properties: string): string {
  return refiledCopyProperties(properties) ?? properties;
}
