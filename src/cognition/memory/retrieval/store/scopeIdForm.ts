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
 * form, in one transaction that writes the record `brain_meta (brain_id, 'scope_id_form', 'encoded')`, which is
 * written whatever the Brain holds.
 */
import type { Brain } from './Brain.js';
import { parseTraceMetadata } from './tracePersistence.js';

/** The `brain_meta` key of the record. */
export const SCOPE_ID_FORM_KEY = 'scope_id_form';

/** The record's value for a Brain that holds the encoded form. */
export const ENCODED_SCOPE_ID_FORM = 'encoded';

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

/** Rows read per page while a Brain is re-filed. */
const PAGE = 500;

/**
 * Re-files one brain's plain `user` and `persona` scope ids that hold a `/`, a `%` or a `:` in the encoded form,
 * the column and the metadata JSON's `scopeId` together, and writes the record, all in one transaction. A brain that
 * holds the record already (this process or another re-filed it) is left as it is. On Postgres the transaction first
 * takes an advisory lock on the brain, so two processes that first open one Brain together re-file it one after the
 * other and the second finds the record: at Read Committed each statement sees what committed before it began, and
 * without the lock the second would read the first's encoded ids, and the namespaced ids written since, and encode
 * them again. On SQLite a second writer's transaction fails instead, and the next open reads the record. Other
 * brains of the same store are not read. The knowledge graph's copies keep the id they were recorded under; a delete
 * of a trace takes its copy by the trace's id (`MemoryStore.deleteTraces`).
 *
 * @returns The pairs it moved, sorted by scope and id.
 */
export async function refileBrainScopeIds(
  brain: Pick<Brain, 'brainId' | 'transaction' | 'features' | 'getMeta' | 'adapter'>,
): Promise<BrainRefileResult> {
  if ((await brain.getMeta(SCOPE_ID_FORM_KEY)) === ENCODED_SCOPE_ID_FORM) return { alreadyEncoded: true, moved: [] };
  const moved = new Map<string, ScopeIdRefile>();
  let alreadyEncoded = false;
  await brain.transaction(async (trx) => {
    if (brain.adapter.kind.includes('postgres')) {
      // Released at COMMIT or ROLLBACK; the record is read after it, so a re-file another process committed is seen.
      await trx.run('SELECT pg_advisory_xact_lock(hashtext($1))', [`agentos_brain_scope_id_form:${brain.brainId}`]);
    }
    const record = await trx.get<{ value: string }>(
      'SELECT value FROM brain_meta WHERE brain_id = ? AND key = ?',
      [brain.brainId, SCOPE_ID_FORM_KEY],
    );
    if (record?.value === ENCODED_SCOPE_ID_FORM) {
      alreadyEncoded = true;
      return;
    }
    let afterId = '';
    for (;;) {
      const rows = await trx.all<{ id: string; scope: string; scope_id: string; metadata: string | null }>(
        `SELECT id, scope, scope_id, metadata FROM memory_traces
          WHERE brain_id = ? AND scope IN ('user', 'persona') AND scope_id <> '' AND id > ?
          ORDER BY id LIMIT ${PAGE}`,
        [brain.brainId, afterId],
      );
      for (const row of rows) {
        const to = encodePlainScopeId(row.scope, row.scope_id);
        if (to === row.scope_id) continue;
        const metadata = parseTraceMetadata(row.metadata);
        metadata.scopeId = to;
        await trx.run('UPDATE memory_traces SET scope_id = ?, metadata = ? WHERE brain_id = ? AND id = ?', [
          to,
          JSON.stringify(metadata),
          brain.brainId,
          row.id,
        ]);
        const key = `${row.scope}\u0000${row.scope_id}`;
        const entry = moved.get(key) ?? { scope: row.scope, from: row.scope_id, to, traces: 0 };
        entry.traces += 1;
        moved.set(key, entry);
      }
      if (rows.length < PAGE) break;
      afterId = rows[rows.length - 1]!.id;
    }
    await trx.run(
      brain.features.dialect.insertOrReplace('brain_meta', ['brain_id', 'key', 'value'], ['?', '?', '?'], 'brain_id, key'),
      [brain.brainId, SCOPE_ID_FORM_KEY, ENCODED_SCOPE_ID_FORM],
    );
  });
  if (alreadyEncoded) return { alreadyEncoded: true, moved: [] };
  return {
    alreadyEncoded: false,
    moved: [...moved.values()].sort((a, b) => (a.scope === b.scope ? (a.from < b.from ? -1 : 1) : a.scope < b.scope ? -1 : 1)),
  };
}
