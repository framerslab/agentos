/**
 * @fileoverview The registry of conversation scopes and the wiki pages, as an import brings them in: the rules the
 * SQLite and the JSON importer share.
 *
 * - A scope the brain already registers keeps its own row and compile watermark; any other comes in with the
 *   source's.
 * - A page the brain already holds, by scope and page id, is kept: the source's page is skipped, and so are its
 *   chunks, which no row here would list. Any other page comes in with its chunks, which are written as traces of
 *   their own, never merged into a trace the brain holds, and the row lists the ids they were written under.
 * - A message the import stores under a scope the brain had compiled past its time moves that scope's watermark back
 *   to just before it.
 *
 * @module memory/io/importPages
 */
import type { Brain } from '../retrieval/store/Brain.js';
import { CONVERSATION_SCOPE, parseConversationScopeKey } from '../retrieval/store/conversationScopeKey.js';
import { reopenCompiledScopes } from '../retrieval/store/conversationScopes.js';

/** One row of a source's registry of conversation scopes. */
export interface ImportedScopeRow {
  scope: string;
  scope_id: string;
  created_at?: number | string | null;
  compiled_at?: number | string | null;
}

/** One wiki page row of a source. */
export interface ImportedPageRow {
  scope: string;
  scope_id: string;
  page_id: string;
  content: string;
  content_hash: string;
  chunk_ids: string;
  updated_at?: number | string | null;
}

/** The ids of the chunk traces a page row lists; none when its list cannot be read. */
export function chunkIdsOfPage(row: Pick<ImportedPageRow, 'chunk_ids'>): string[] {
  try {
    const ids: unknown = JSON.parse(row.chunk_ids);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** The rows of a source that are pages of a conversation scope under a key the key builder wrote. */
export function conversationPagesOf(rows: readonly unknown[]): ImportedPageRow[] {
  return rows.filter((row): row is ImportedPageRow => {
    if (row === null || typeof row !== 'object') return false;
    const page = row as Partial<ImportedPageRow>;
    return (
      page.scope === CONVERSATION_SCOPE &&
      typeof page.scope_id === 'string' &&
      parseConversationScopeKey(page.scope_id) !== undefined &&
      typeof page.page_id === 'string' &&
      typeof page.content === 'string' &&
      typeof page.content_hash === 'string' &&
      typeof page.chunk_ids === 'string'
    );
  });
}

/** A time column of a source row as a number, or `fallback` when it holds none. */
function timeOf(value: unknown, fallback: number): number {
  const at = typeof value === 'string' && value !== '' ? Number(value) : value;
  return typeof at === 'number' && Number.isFinite(at) ? at : fallback;
}

/**
 * Sorts the source's pages by whether the brain already holds a page of their scope and id.
 *
 * @returns The pages that come in; the ids of their chunks, which are written as traces of their own; and the ids of
 *   the chunks of the pages the brain keeps, which stay out with their page.
 */
export async function splitImportedPages(
  trx: { get: Brain['get'] },
  brainId: string,
  pages: readonly ImportedPageRow[],
): Promise<{ pagesIn: ImportedPageRow[]; chunksIn: Set<string>; chunksLeftOut: Set<string>; kept: number }> {
  const pagesIn: ImportedPageRow[] = [];
  const chunksIn = new Set<string>();
  const chunksLeftOut = new Set<string>();
  let kept = 0;
  for (const page of pages) {
    const held = await trx.get<{ page_id: string }>(
      'SELECT page_id FROM memory_pages WHERE brain_id = ? AND scope = ? AND scope_id = ? AND page_id = ?',
      [brainId, page.scope, page.scope_id, page.page_id],
    );
    for (const id of chunkIdsOfPage(page)) (held ? chunksLeftOut : chunksIn).add(id);
    if (held) kept += 1;
    else pagesIn.push(page);
  }
  return { pagesIn, chunksIn, chunksLeftOut, kept };
}

/**
 * The scopes this brain registers before an import writes: a message the import stores under one of them older than
 * its compile is read by its next compile. Read before the import's traces are written.
 */
export async function registeredConversationScopes(trx: { all: Brain['all'] }, brainId: string): Promise<Set<string>> {
  return new Set(
    (
      await trx.all<{ scope_id: string }>('SELECT scope_id FROM memory_scopes WHERE brain_id = ? AND scope = ?', [
        brainId,
        CONVERSATION_SCOPE,
      ])
    ).map((row) => String(row.scope_id)),
  );
}

/**
 * Writes the source's registry rows and the pages that come in. A scope this brain already registers keeps its row; a
 * page row lists its chunks under the ids this import wrote them under.
 *
 * @param held - The conversation scopes the brain registered before the import wrote anything.
 * @param scopes - The source's registry rows.
 * @param pages - The source's pages this brain does not hold.
 * @param written - For each source trace this import wrote, the id it was written under.
 * @param stored - The source's traces this import wrote; they move back the watermark of a scope in `held` this brain
 *   had compiled past their time.
 * @param errors - Where a row that cannot be written is reported.
 * @returns How many pages it wrote.
 */
export async function mergeImportedScopesAndPages(
  trx: { run: Brain['run'] },
  brainId: string,
  input: {
    held: ReadonlySet<string>;
    scopes: readonly ImportedScopeRow[];
    pages: readonly ImportedPageRow[];
    written: ReadonlyMap<string, string>;
    stored: Iterable<{ scope?: unknown; scope_id?: unknown; created_at?: unknown; tags?: unknown }>;
  },
  errors: string[],
): Promise<number> {
  await reopenCompiledScopes(trx, brainId, input.held, input.stored);
  for (const row of input.scopes) {
    // Only a key the key builder wrote names a scope; any other row is left out.
    const parsed =
      row !== null && typeof row === 'object' && row.scope === CONVERSATION_SCOPE && typeof row.scope_id === 'string'
        ? parseConversationScopeKey(row.scope_id)
        : undefined;
    if (!parsed) continue;
    const compiledAt = row.compiled_at === null || row.compiled_at === undefined ? null : timeOf(row.compiled_at, 0);
    try {
      await trx.run(
        `INSERT INTO memory_scopes (brain_id, scope, scope_id, kind, agent_id, created_at, compiled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (brain_id, scope, scope_id) DO NOTHING`,
        [brainId, CONVERSATION_SCOPE, row.scope_id, parsed.subject.kind, parsed.agentId, timeOf(row.created_at, Date.now()), compiledAt],
      );
    } catch (err) {
      errors.push(`Scope merge error: ${String(err)}`);
    }
  }
  let imported = 0;
  for (const page of input.pages) {
    const parsed = parseConversationScopeKey(page.scope_id);
    if (!parsed) continue;
    const updatedAt = timeOf(page.updated_at, Date.now());
    try {
      // The page's scope is registered even when the source's registry does not name it.
      await trx.run(
        `INSERT INTO memory_scopes (brain_id, scope, scope_id, kind, agent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (brain_id, scope, scope_id) DO NOTHING`,
        [brainId, CONVERSATION_SCOPE, page.scope_id, parsed.subject.kind, parsed.agentId, updatedAt],
      );
      const chunkIds = chunkIdsOfPage(page)
        .map((id) => input.written.get(id))
        .filter((id): id is string => id !== undefined);
      await trx.run(
        `INSERT INTO memory_pages (brain_id, scope, scope_id, page_id, content, content_hash, chunk_ids, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [brainId, CONVERSATION_SCOPE, page.scope_id, page.page_id, page.content, page.content_hash, JSON.stringify(chunkIds), updatedAt],
      );
      imported += 1;
    } catch (err) {
      errors.push(`Page merge error: ${String(err)}`);
    }
  }
  return imported;
}
