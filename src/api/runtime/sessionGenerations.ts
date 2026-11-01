/**
 * @file sessionGenerations.ts
 * The generation of a gmi() session id under `memory.store`, kept in the Brain that holds the id's traces.
 *
 * A session id's memory scope id is the id itself until a `session.close()` ends it; each close moves the id to its
 * next generation, whose memory scope id is `<id>:<suffix>` with a random suffix, so the id's next opening, in this
 * process, after a restart or in another process, files and recalls under a scope of its own, and what the closed
 * session filed stays in the store under the closed session's scope id. A generation is a row of the Brain's
 * `brain_meta`, keyed `session_generation:<the id's session form>` (`taggedScopeId`, so one id under two namespaces
 * keeps two), whose value is `{"generation":<n>,"suffix":"<uuid>"}`. It sits in the same database and under the same
 * brain id as the traces it scopes, beside the Brain's `scope_id_form` record, and a Brain's export and import carry it.
 * An id with no row is at generation 0, the plain form every file written before generations were recorded holds.
 *
 * Ending a generation writes the next one only over the record it was read from (an insert that a row already there
 * ignores at generation 0, a compare-and-set on the read value after), so two processes that close one opening at once
 * land on one next generation, and a close of an opening another process already ended changes nothing. Every
 * statement goes through the Brain's storage adapter in its dialect, SQLite and Postgres alike.
 */
import { randomUUID } from 'node:crypto';
import { taggedScopeId } from '../../cognition/learning/scopes.js';
import type { Brain } from '../../cognition/memory/retrieval/store/Brain.js';

/** The `brain_meta` key prefix of a session id's generation record. */
export const SESSION_GENERATION_KEY_PREFIX = 'session_generation:';

/** One generation of a session id, as read from the Brain. */
export interface SessionGeneration {
  /** 0 for an id no `session.close()` has ended; one more for each close. */
  readonly generation: number;
  /** The id the generation's memory files and recalls under: the session id at generation 0, `<id>:<suffix>` after. */
  readonly memoryScopeId: string;
  /** The record the generation was read from, which ending it compares against; undefined at generation 0. */
  readonly record: string | undefined;
}

/** The `brain_meta` key of a session id's generation under a namespace. */
export function sessionGenerationKey(sessionId: string, namespace: string): string {
  return `${SESSION_GENERATION_KEY_PREFIX}${taggedScopeId(sessionId, namespace)}`;
}

/** A record's generation and suffix; throws naming the key for a record in another shape, so no turn files under a guess. */
function parseRecord(record: string, key: string): { generation: number; suffix: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record);
  } catch {
    parsed = undefined;
  }
  const { generation, suffix } = (parsed && typeof parsed === 'object' ? parsed : {}) as { generation?: unknown; suffix?: unknown };
  if (typeof generation === 'number' && Number.isSafeInteger(generation) && generation > 0 && typeof suffix === 'string' && suffix !== '') {
    return { generation, suffix };
  }
  throw new Error(`gmi(): the brain_meta record '${key}' is not { generation, suffix }; the session's memory does not open until it is.`);
}

/**
 * Reads a session id's current generation.
 *
 * @throws {Error} Naming the record, when the id's record is in another shape.
 */
export async function readSessionGeneration(brain: Brain, sessionId: string, namespace: string): Promise<SessionGeneration> {
  const key = sessionGenerationKey(sessionId, namespace);
  const record = await brain.getMeta(key);
  if (record === undefined) return { generation: 0, memoryScopeId: sessionId, record: undefined };
  const { generation, suffix } = parseRecord(record, key);
  return { generation, memoryScopeId: `${sessionId}:${suffix}`, record };
}

/**
 * Ends `ended`, the generation a session opened: the id's next opening reads the next one. The write lands only on the
 * record `ended` was read from, so a generation another process ended first stays as that process left it.
 */
export async function endSessionGeneration(brain: Brain, sessionId: string, namespace: string, ended: SessionGeneration): Promise<void> {
  const key = sessionGenerationKey(sessionId, namespace);
  const next = JSON.stringify({ generation: ended.generation + 1, suffix: randomUUID() });
  if (ended.record === undefined) {
    await brain.run(brain.features.dialect.insertOrIgnore('brain_meta', ['brain_id', 'key', 'value'], ['?', '?', '?']), [brain.brainId, key, next]);
    return;
  }
  await brain.run('UPDATE brain_meta SET value = ? WHERE brain_id = ? AND key = ? AND value = ?', [next, brain.brainId, key, ended.record]);
}
