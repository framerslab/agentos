/**
 * @fileoverview The scope-id forms of the brains a Qdrant sidecar names, for the migration engine's handshake.
 * @module rag/migration/adapters/sidecarScopeIdForms
 *
 * A Qdrant deployment keeps a Brain's traces in Qdrant collections and its other tables, `brain_meta` among them, in
 * a SQLite sidecar. The handshake reads a brain's record (`brain_meta.scope_id_form`) from the sidecar. The traces'
 * scope ids are in Qdrant, where it reads none, so a brain the sidecar holds counts as holding traces whose scope ids
 * the two forms read apart: a copy that would mix the forms is refused rather than weighed on what the sidecar shows.
 */
import type Database from 'better-sqlite3';
import {
  ABSENT_BRAIN,
  readScopeIdForms,
  type BrainScopeIdForm,
} from '../../../memory/retrieval/store/scopeIdForm.js';
import { isMissingTableError } from '../../../memory/retrieval/store/missingTable.js';

/**
 * The forms of the brains a sidecar names, or of the brains given.
 *
 * @param sidecar - The sidecar SQLite file, open.
 * @param brainIds - The brains to read; unset, every brain the sidecar's `brain_meta` names.
 * @returns Each brain's form: its record as the sidecar holds it, with traces whose scope ids the forms read apart,
 *   for a brain the sidecar holds; a brain it does not hold reads as holding nothing.
 */
export async function sidecarScopeIdForms(
  sidecar: Database.Database,
  brainIds?: readonly string[],
): Promise<Map<string, BrainScopeIdForm>> {
  const read = await readScopeIdForms(
    {
      get: async <T>(sql: string, params: unknown[] = []) => sidecar.prepare(sql).get(...params) as T | undefined,
      all: async <T>(sql: string, params: unknown[] = []) => sidecar.prepare(sql).all(...params) as T[],
    },
    brainIds,
  );
  const forms = new Map<string, BrainScopeIdForm>();
  for (const [brainId, form] of read) {
    forms.set(
      brainId,
      form.rows || holdsBrain(sidecar, brainId) ? { encoded: form.encoded, rows: true, reserved: true } : ABSENT_BRAIN,
    );
  }
  return forms;
}

/**
 * Whether the sidecar's `brain_meta` holds a row of the brain; a sidecar without the table, or one from before brain
 * ids, holds none.
 *
 * @throws What the read threw for any other reason (a locked file): the migration stops before it copies a table.
 */
function holdsBrain(sidecar: Database.Database, brainId: string): boolean {
  try {
    return Boolean(sidecar.prepare('SELECT 1 AS held FROM brain_meta WHERE brain_id = ? LIMIT 1').get(brainId));
  } catch (error) {
    if (isMissingTableError(error)) return false;
    throw error;
  }
}
