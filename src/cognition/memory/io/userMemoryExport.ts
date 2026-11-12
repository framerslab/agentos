/**
 * @module memory/io/userMemoryExport
 *
 * One subject's memory as a document a host can hand to that person, and a correction of it: the wrong traces are
 * deleted for good and the corrected statement is filed in their place.
 */
import type { WikiPage } from '../../substrate/memory/wiki/types.js';
import { memoryLog } from '../log.js';
import { CONVERSATION_SCOPE, conversationScopeKey } from '../retrieval/store/conversationScopeKey.js';
import { parseTraceMetadata } from '../retrieval/store/tracePersistence.js';
import type { SuppressionSubject } from '../suppression/ForgottenLedger.js';
import { guardedWrite } from '../suppression/guardedWrite.js';
import type { Memory } from './facade/Memory.js';
import type { SubjectPages } from './forgetUserMemory.js';
import { LEGACY_SCOPE } from './legacyMemory.js';

/** One subject's memory: what they and the agent said, as the store holds it, and the pages compiled from it. */
export interface UserMemoryExport {
  /** When the export was made, ISO 8601. */
  exportedAt: string;
  agentId: string;
  /** The kind of subject the export is of. The id is the caller's own and is not repeated. */
  subject: { kind: 'user' | 'session' };
  /** The subject's conversation traces, oldest first; a page's chunks are left out. */
  traces: Array<{ id: string; createdAt: string; speaker?: 'user' | 'assistant'; text: string; tags: string[] }>;
  /** The pages compiled from the subject's traces. */
  pages: Array<{ id: string; summary: string; updated: string; sources: string[]; body: string }>;
}

/** How many traces one read of the export asks for. */
const EXPORT_BATCH = 500;

/** The key of the trace metadata that records who spoke a trace. */
const SPEAKER_KEY = 'speaker';

/** A subject checked: a kind of `user` or `session` and a non-empty id. */
function checkedSubject(subject: SuppressionSubject, call: string): SuppressionSubject {
  const given = subject as { kind?: unknown; id?: unknown } | null | undefined;
  const kind = given?.kind;
  const id = given?.id;
  if ((kind !== 'user' && kind !== 'session') || typeof id !== 'string' || id === '') {
    throw new TypeError(`${call}: name the subject by a non-empty id`);
  }
  return { kind, id };
}

/**
 * One subject's memory as JSON: every live conversation trace filed under the subject's own key, oldest first, with
 * who spoke it, and every page compiled from them. It reads that key alone, by equality: the operator's pages, other
 * subjects' memory and a session's own message history are not in it. A forgotten subject's export is empty.
 *
 * @throws TypeError when the subject has another kind or no id, or an id no conversation key can be built from.
 */
export async function exportSubjectMemory(options: {
  memory: Memory;
  wiki: { storeFor(scopeId: string): { listPages(): Promise<WikiPage[]> } };
  agentId: string;
  subject: SuppressionSubject;
  /**
   * The memory from before per-user scope attributed to this subject (`legacyMemory`), passed for its owner alone:
   * the written forms of the agent's plain scope id its traces sit under, and its compiled pages.
   */
  legacy?: { forms: readonly string[]; pages(): Promise<WikiPage[]> };
}): Promise<UserMemoryExport> {
  const { memory, agentId } = options;
  const subject = checkedSubject(options.subject, 'exportSubjectMemory');
  const key = conversationScopeKey(agentId, subject);
  const document: UserMemoryExport = {
    exportedAt: new Date().toISOString(),
    agentId,
    subject: { kind: subject.kind },
    traces: [],
    pages: [],
  };
  if (memory.forgotten && (await memory.isForgotten(subject))) return document;

  const seen = new Set<string>();
  /** Every live trace of one scope, oldest first, a page's chunks left out. */
  const readScope = async (scope: string, scopeId: string): Promise<void> => {
    let since = 0;
    let limit = EXPORT_BATCH;
    for (;;) {
      const batch = await memory.recentTraces(since, { scope, scopeId, limit, order: 'asc' });
      const fresh = batch.filter((trace) => !seen.has(trace.id));
      for (const trace of fresh) {
        seen.add(trace.id);
        if (trace.tags.includes('wiki')) continue;
        const speaker = parseTraceMetadata((await memory.readTrace(trace.id))?.metadata)[SPEAKER_KEY];
        document.traces.push({
          id: trace.id,
          createdAt: new Date(Number(trace.createdAt)).toISOString(),
          ...(speaker === 'user' || speaker === 'assistant' ? { speaker } : {}),
          text: trace.content,
          tags: [...trace.tags],
        });
      }
      if (batch.length < limit) break;
      // Re-read the last millisecond in case this batch cut it in two. If the window still ends in that same
      // millisecond, widen it: advancing the timestamp would skip records beyond the current limit.
      const newest = Number(batch[batch.length - 1].createdAt);
      if (newest - 1 <= since) {
        limit += EXPORT_BATCH;
      } else {
        since = newest - 1;
        limit = EXPORT_BATCH;
      }
    }
  };
  for (const form of options.legacy?.forms ?? []) await readScope(LEGACY_SCOPE, form);
  await readScope(CONVERSATION_SCOPE, key);

  const pages = [...(options.legacy ? await options.legacy.pages() : []), ...(await options.wiki.storeFor(key).listPages())];
  for (const page of pages) {
    document.pages.push({ id: page.id, summary: page.summary, updated: page.updated, sources: [...page.sources], body: page.body });
  }
  return document;
}

/**
 * Corrects one subject's memory: the named traces are deleted for good, the corrected statement is filed as a trace
 * tagged `correction`, and each page compiled from a deleted trace is deleted and built again by the subject's next
 * compile, from the traces of it that are left and the correction. A deleted trace cannot come back in a later
 * compile, which is why a correction deletes instead of editing a page.
 *
 * Every named id must be one of the subject's own live traces (a page's chunk is not one): when any is another
 * subject's, unknown or already deleted, the call rejects with a count and nothing is changed.
 *
 * @returns How many traces and pages it deleted, and the id of the correction's trace.
 * @throws TypeError when the subject, the trace ids or the text is missing.
 * @throws Error when a named id is not one of the subject's live traces (one `memory.write_refused` line, reason
 *   `foreign_trace`), or when the subject is forgotten (reason `forgotten`): nothing is written for them again.
 */
export async function correctSubjectMemory(options: {
  memory: Memory;
  wiki: { storeFor(scopeId: string): SubjectPages };
  agentId: string;
  subject: SuppressionSubject;
  correction: { traceIds: readonly string[]; text: string };
  /** Runs the change in the subject's turn, after its writes and compiles. Unset: at once. */
  onChain?: <T>(work: () => Promise<T>) => Promise<T>;
}): Promise<{ deleted: number; pagesDeleted: number; correctionTraceId: string }> {
  const { memory, agentId } = options;
  const subject = checkedSubject(options.subject, 'correctSubjectMemory');
  const given = options.correction as { traceIds?: unknown; text?: unknown } | null | undefined;
  const named: unknown = given?.traceIds;
  const text: unknown = given?.text;
  if (
    !Array.isArray(named) ||
    named.length === 0 ||
    named.some((id) => typeof id !== 'string' || id === '') ||
    typeof text !== 'string' ||
    text === ''
  ) {
    throw new TypeError('correctUserMemory: name at least one trace id and the corrected text');
  }
  const ids = [...new Set(named as string[])];
  const key = conversationScopeKey(agentId, subject);

  const correct = async (): Promise<{ deleted: number; pagesDeleted: number; correctionTraceId: string }> => {
    // The ownership check, before any change, read in the subject's turn so no write of theirs runs between it and
    // the delete.
    const own = new Set(await memory.liveTraceIdsOf(CONVERSATION_SCOPE, key, ids));
    const missing = ids.filter((id) => !own.has(id)).length;
    if (missing > 0) {
      memoryLog.warn('memory.write_refused', { reason: 'foreign_trace' });
      throw new Error(`correctUserMemory: ${missing} of ${ids.length} trace ids are not this user's live traces`);
    }

    const { deleted } = await memory.deleteTraces(ids);
    const filed = await guardedWrite(
      { isForgotten: (who) => (memory.forgotten ? memory.isForgotten(who) : Promise.resolve(false)) },
      subject,
      () =>
        memory.remember(text, {
          type: 'episodic',
          scope: CONVERSATION_SCOPE,
          scopeId: key,
          tags: ['correction'],
          metadata: {
            subject: { kind: subject.kind, id: subject.id },
            corrects: ids,
            ...(subject.kind === 'user' ? { turnUserId: subject.id } : {}),
          },
        }),
      async (trace) => {
        await memory.deleteTraces([trace.id]);
      },
    );
    if (filed.status === 'refused') {
      memoryLog.warn('memory.write_refused', { reason: 'forgotten' });
      throw new Error('correctUserMemory: the subject is forgotten; nothing is written for them again');
    }

    // A page built from a deleted trace still says what the trace said: it goes whole, and the next compile builds it
    // again from the traces of it that are left, read by id, beside the correction.
    const gone = new Set(ids);
    const store = options.wiki.storeFor(key);
    const survivors: string[] = [];
    let pagesDeleted = 0;
    for (const page of await store.listPages()) {
      if (!page.sources.some((id) => gone.has(id))) continue;
      await store.deletePage(page.id);
      pagesDeleted += 1;
      survivors.push(...page.sources.filter((id) => !gone.has(id)));
    }
    await memory.addRebuildSources(key, survivors);
    return { deleted, pagesDeleted, correctionTraceId: filed.result.id };
  };
  return options.onChain ? options.onChain(correct) : correct();
}
