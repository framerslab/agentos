/**
 * @module memory/io/forgetUserMemory
 *
 * One subject's memory deleted from a store for good: the tombstone first, then the traces, the pages and the vector
 * index, then a report that names every store reached and every store not reached.
 */
import { messageOf } from '../../../api/runtime/memoryObserveFailures.js';
import { memoryLog } from '../log.js';
import { CONVERSATION_SCOPE, conversationScopeKey, parseConversationScopeKey } from '../retrieval/store/conversationScopeKey.js';
import type { ForgottenLedger, SuppressionSubject } from '../suppression/ForgottenLedger.js';
import type { Memory } from './facade/Memory.js';
import { LEGACY_SCOPE } from './legacyMemory.js';

/** What a deletion did. It never holds the subject's id or any text of theirs. */
export interface ForgetMemoryReport {
  /** The tombstone's form, and whether this call wrote it (false when the ledger already held it). */
  tombstone: { form: 'keyed' | 'unkeyed'; written: boolean };
  /** Each store by name: reached with the number of rows deleted, or not reached with the reason. */
  stores: Array<{ store: string; reached: true; deleted: number } | { store: string; reached: false; reason: string }>;
  /** The compiled pages deleted, and each page that could not be. */
  pages: { deleted: number; failed: Array<{ id: string; reason: string }> };
  /** How many of the subject's pending writes and compiles the call waited for. */
  drained: number;
  /** How many of them were still running at the deadline. */
  pendingAtDeadline: number;
  /**
   * False when anything was still pending at the deadline, a store the call deletes from failed (the vector index and
   * the write-ahead log included), a page failed, or the store holds memory from before per-user scope that nobody
   * attributed. The stores the call never reaches by design are named and do not count. The next open, or the next
   * re-application of the tombstones, resumes an incomplete deletion.
   */
  complete: boolean;
}

/** What a deletion and a retention sweep need of one subject's page store. */
export interface SubjectPages {
  /** The subject's pages, each with the ids of the traces it was compiled from. */
  listPages(): Promise<Array<{ id: string; sources: string[] }>>;
  /** Deletes one page with its chunks, for good. */
  deletePage(id: string): Promise<unknown>;
}

export interface ForgetUserMemoryOptions {
  /** The store, opened with a forgotten-user ledger. */
  memory: Memory;
  /** Defaults to `memory.forgotten`. */
  ledger?: ForgottenLedger;
  /** The page store of one subject, by its conversation key. */
  wiki: { storeFor(scopeId: string): SubjectPages };
  /** A user, or an anonymous session. */
  subject: SuppressionSubject;
  /**
   * The agent whose store this is: its key for the subject is always deleted, with every other agent's key of the
   * subject the store's registry holds.
   */
  agentId: string;
  /** Waits for the subject's pending writes and compiles, up to the caller's deadline. Unset: nothing is pending. */
  drain?: () => Promise<{ drained: number; pendingAtDeadline: number }>;
  /** Runs the deletes in the subject's turn, after its writes and compiles. Unset: they run at once. */
  onChain?: <T>(work: () => Promise<T>) => Promise<T>;
  /** False when a tombstone that is already written is being applied again, at open or on demand. Default true. */
  writeTombstone?: boolean;
  /**
   * Entries the caller adds to the report: stores it reached itself, and stores it knows are not reached. They do not
   * change `complete`.
   */
  extraStores?: ForgetMemoryReport['stores'];
  /** The caller's own stores failed: the report is incomplete. */
  alsoIncomplete?: boolean;
  /**
   * Whether the store holds memory from before per-user scope that nobody attributed, read when the deletes are
   * done.
   */
  legacyUnattributed?: () => Promise<boolean>;
  /**
   * The memory from before per-user scope a single person's install attributed to one user (`legacyMemory`). When
   * `ownerKey` is the subject's key for this agent, the deletion also deletes the legacy traces under each of `forms`
   * and each legacy compiled page, and then, once every such page is gone, the attribution. Any other subject never
   * touches it.
   */
  legacy?: LegacyDeletion;
}

/** What a deletion of the owner of attributed legacy memory reaches: see {@link ForgetUserMemoryOptions.legacy}. */
export interface LegacyDeletion {
  /** The conversation key the legacy memory is attributed to; undefined when it is attributed to nobody. */
  ownerKey: string | undefined;
  /** The written forms of the agent's plain scope id the legacy traces sit under. */
  forms: readonly string[];
  /** The legacy pages on disk: only the compiled ones (`parsed`) are the owner's. */
  pages: { list(): Promise<Array<{ id: string; parsed: boolean }>>; deletePage(id: string): Promise<unknown> };
  /** Removes the attribution. */
  clearOwner(): Promise<void>;
}

/** The stores a deletion never reaches, each with why. */
const NEVER_REACHED: ForgetMemoryReport['stores'] = [
  {
    store: "a conversation's own history",
    reached: false,
    reason: "the host's conversation store keeps a conversation's messages until the host deletes them",
  },
  { store: "documents ingested outside the subject's scope", reached: false, reason: 'they carry no subject to find them by' },
  { store: 'memory under the organization scope', reached: false, reason: "it is the organization's" },
];

/**
 * Deletes every trace of one scope for good, the document chunks its traces were filed from with their text: the
 * traces first, with their chunks, then whatever the scope still holds (a wiki page's chunks, the knowledge-graph
 * copies filed under it) and, for a conversation scope with no page left, its registry row.
 *
 * @returns How many trace rows it deleted.
 */
export async function deleteScopeWithDocuments(memory: Memory, scope: string, scopeId: string): Promise<number> {
  const ids = await memory.tracesStoredBefore(scope, scopeId, Number.MAX_SAFE_INTEGER);
  const { deleted } = await memory.deleteTraces(ids, { documentChunks: 'delete' });
  return deleted + (await memory.deleteScope(scope, scopeId)).deleted;
}

/**
 * Deletes one subject's memory from a store for good and keeps it deleted.
 *
 * In order: the subject's pending writes and compiles are waited for (`drain`); the tombstone is written to the
 * ledger's copy and then to the store, and from then on every new write of the subject is refused; the subject's
 * conversation traces are deleted under this agent's key and under every other agent's key of the subject, the
 * soft-deleted rows, the graph copies, the full-text entries and the document chunks with them; for a user, the
 * traces that name the user under other scopes; each compiled page with its chunks; the scope's registry row; for the
 * user older memory is attributed to (`legacy`), that memory and the attribution; then the
 * vector index is written again from what is left, and the write-ahead log is emptied. A store that throws is named as
 * not reached and the next one still runs. No model call is made, and `Memory.forget()` (a soft delete) is never used.
 *
 * @returns The report. One `memory.forget_done` line is logged with its counts.
 * @throws TypeError when the subject has another kind or no id, or an id no conversation key can be built from: a
 *   missing id never widens the deletion.
 * @throws Error when the store has no forgotten-user ledger.
 * @throws What the ledger throws when the tombstone cannot be written to both of its copies: nothing is deleted
 *   without it.
 */
export async function forgetUserMemory(options: ForgetUserMemoryOptions): Promise<ForgetMemoryReport> {
  const { memory, agentId } = options;
  const given = options.subject as { kind?: unknown; id?: unknown } | null | undefined;
  const kind = given?.kind;
  const id = given?.id;
  if ((kind !== 'user' && kind !== 'session') || typeof id !== 'string' || id === '') {
    throw new TypeError('forgetUserMemory: name the subject by a non-empty id');
  }
  const subject: SuppressionSubject = { kind, id };
  const ledger = options.ledger ?? memory.forgotten;
  if (!ledger) throw new Error('forgetUserMemory: the store has no forgotten-user ledger');
  const ownKey = conversationScopeKey(agentId, subject);

  const { drained, pendingAtDeadline } = (await options.drain?.()) ?? { drained: 0, pendingAtDeadline: 0 };

  const tombstone: ForgetMemoryReport['tombstone'] =
    options.writeTombstone === false
      ? { form: ledger.keyed ? 'keyed' : 'unkeyed', written: false }
      : await ledger.markForgotten(subject);

  const pages: ForgetMemoryReport['pages'] = { deleted: 0, failed: [] };
  const deletes = async (): Promise<ForgetMemoryReport['stores']> => {
    const stores: ForgetMemoryReport['stores'] = [];
    let traces = 0;

    // Conversation memory: this agent's key of the subject, and the subject's key under each other agent of the store.
    const keys = [ownKey];
    let conversation = 0;
    let conversationFailure: string | undefined;
    try {
      for (const row of await memory.listScopes({ scope: CONVERSATION_SCOPE, kind: subject.kind })) {
        const other = parseConversationScopeKey(row.scopeId)?.subject;
        if (!other || other.kind === 'operator') continue;
        if (other.kind === subject.kind && other.id === subject.id && !keys.includes(row.scopeId)) keys.push(row.scopeId);
      }
      for (const key of keys) conversation += await deleteScopeWithDocuments(memory, CONVERSATION_SCOPE, key);
    } catch (error) {
      conversationFailure = messageOf(error);
    }
    traces += conversation;

    // What the user said on someone else's session, filed under that session's scope.
    let naming: ForgetMemoryReport['stores'][number] | undefined;
    if (subject.kind === 'user') {
      const store = 'traces that name the user under other scopes';
      try {
        const { deleted } = await memory.deleteTracesNamingUser(subject.id);
        traces += deleted;
        naming = { store, reached: true, deleted };
      } catch (error) {
        naming = { store, reached: false, reason: messageOf(error) };
      }
    }

    // Pages, one by one, so each page that fails is named. A page is deleted whole, with its chunks.
    for (const key of keys) {
      let pageIds: string[];
      try {
        pageIds = (await memory.listPageRows(key)).map((row) => row.pageId);
      } catch (error) {
        pages.failed.push({ id: '(all pages)', reason: messageOf(error) });
        continue;
      }
      const store = pageIds.length > 0 ? options.wiki.storeFor(key) : undefined;
      let left = false;
      for (const pageId of pageIds) {
        try {
          await store?.deletePage(pageId);
          pages.deleted += 1;
        } catch (error) {
          left = true;
          pages.failed.push({ id: pageId, reason: messageOf(error) });
        }
      }
      // The scope's registry row goes once it holds no trace and no page: the delete made again removes it.
      if (!left && conversationFailure === undefined) {
        try {
          conversation += (await memory.deleteScope(CONVERSATION_SCOPE, key)).deleted;
        } catch (error) {
          conversationFailure = messageOf(error);
        }
      }
    }
    stores.push(
      conversationFailure === undefined
        ? { store: 'conversation memory', reached: true, deleted: conversation }
        : { store: 'conversation memory', reached: false, reason: conversationFailure },
    );
    if (naming) stores.push(naming);

    // The older memory attributed to this user: its traces, then its compiled pages, then the attribution, which stays
    // while a page is left so a later deletion still finds it. A page whose front matter cannot be read is nobody's.
    const legacy = options.legacy;
    if (legacy && legacy.ownerKey !== undefined && legacy.ownerKey === ownKey) {
      const store = 'legacy memory attributed to the user';
      let legacyTraces = 0;
      let legacyFailure: string | undefined;
      try {
        for (const form of legacy.forms) legacyTraces += await deleteScopeWithDocuments(memory, LEGACY_SCOPE, form);
        let left = false;
        for (const page of await legacy.pages.list()) {
          if (!page.parsed) continue;
          try {
            await legacy.pages.deletePage(page.id);
            pages.deleted += 1;
          } catch (error) {
            left = true;
            pages.failed.push({ id: page.id, reason: messageOf(error) });
          }
        }
        if (!left) await legacy.clearOwner();
      } catch (error) {
        legacyFailure = messageOf(error);
      }
      traces += legacyTraces;
      // One entry, whatever step failed: the traces deleted before a failure are still counted for the vector index.
      stores.push(
        legacyFailure === undefined ? { store, reached: true, deleted: legacyTraces } : { store, reached: false, reason: legacyFailure },
      );
    }

    // A delete only marks a vector in the index: the index is written again from the traces that are left.
    try {
      await memory.rebuildVectorIndex();
      stores.push({ store: 'vector index', reached: true, deleted: traces });
    } catch (error) {
      stores.push({ store: 'vector index', reached: false, reason: messageOf(error) });
    }

    // The log still holds the pages written before the deletes until it is moved into the store's file.
    try {
      const { log } = await memory.checkpointLog();
      if (log === 'emptied') stores.push({ store: 'write-ahead log', reached: true, deleted: 0 });
      if (log === 'busy') {
        stores.push({
          store: 'write-ahead log',
          reached: false,
          reason: 'another connection held the log; the deleted bytes stay in it until its next checkpoint',
        });
      }
    } catch (error) {
      stores.push({ store: 'write-ahead log', reached: false, reason: messageOf(error) });
    }
    return stores;
  };

  // A write stuck past the deadline holds the subject's turn: the deletes then run at once, and the guard takes that
  // write back when it lands.
  const deleted = options.onChain && pendingAtDeadline === 0 ? await options.onChain(deletes) : await deletes();
  const failed = deleted.some((entry) => !entry.reached);

  const stores: ForgetMemoryReport['stores'] = [...deleted, ...NEVER_REACHED.map((entry) => ({ ...entry })), ...(options.extraStores ?? [])];
  let legacy = false;
  if (options.legacyUnattributed) {
    try {
      legacy = await options.legacyUnattributed();
    } catch {
      // Unknown whether older memory is left: the report does not say the store holds none.
      legacy = true;
    }
  }
  if (legacy) stores.push({ store: 'legacy memory under the agent scope', reached: false, reason: 'unattributed' });

  const complete = pendingAtDeadline === 0 && pages.failed.length === 0 && !failed && options.alsoIncomplete !== true && !legacy;
  memoryLog.info('memory.forget_done', {
    stores: stores.filter((entry) => entry.reached).length,
    unreached: stores.filter((entry) => !entry.reached).length,
    pages: pages.deleted,
    pagesFailed: pages.failed.length,
    drained,
    pendingAtDeadline,
    complete: complete ? 'yes' : 'no',
  });
  return { tombstone, stores, pages, drained, pendingAtDeadline, complete };
}

export interface ReapplyTombstonesOptions
  extends Pick<ForgetUserMemoryOptions, 'memory' | 'ledger' | 'wiki' | 'agentId' | 'legacyUnattributed'> {
  /** The per-subject parts of one deletion: the subject's drain and chain, and what the caller reached itself. */
  forSubject?: (
    subject: SuppressionSubject,
  ) => Promise<Pick<ForgetUserMemoryOptions, 'drain' | 'onChain' | 'extraStores' | 'alsoIncomplete' | 'legacy'>>;
}

/**
 * Brings the store's ledger up to date from its copy, then runs the deletion again, with no second tombstone, for
 * every forgotten subject the store still holds: after a restore from a backup taken before a deletion, after a
 * deletion that did not finish, and for what another process wrote after a tombstone. It deletes nothing of a subject
 * the ledger does not hold, and never touches memory from before per-user scope that nobody attributed.
 *
 * One `memory.tombstone_reapplied` line is logged when a subject was re-applied or a tombstone came back from the copy.
 *
 * @returns One report a subject re-applied; none for a store that holds nothing of a forgotten subject.
 * @throws Error when the store has no forgotten-user ledger.
 * @throws What the ledger throws when its copy cannot be read: nothing is deleted.
 */
export async function reapplyTombstones(options: ReapplyTombstonesOptions): Promise<ForgetMemoryReport[]> {
  const { memory, agentId, forSubject } = options;
  const ledger = options.ledger ?? memory.forgotten;
  if (!ledger) throw new Error('reapplyTombstones: the store has no forgotten-user ledger');
  const { added } = await ledger.reconcile();
  const reports: ForgetMemoryReport[] = [];
  // A store that has forgotten nobody holds nothing to delete again, and its rows are not listed.
  if ((await ledger.size()) > 0) {
    for (const subject of await memory.listHeldSubjects()) {
      try {
        conversationScopeKey(agentId, subject);
      } catch {
        // An id no conversation key can be built from was never filed under one.
        continue;
      }
      if (!(await ledger.isForgotten(subject))) continue;
      reports.push(
        await forgetUserMemory({
          memory,
          ledger,
          wiki: options.wiki,
          agentId,
          ...(options.legacyUnattributed ? { legacyUnattributed: options.legacyUnattributed } : {}),
          ...((await forSubject?.(subject)) ?? {}),
          subject,
          writeTombstone: false,
        }),
      );
    }
  }
  if (reports.length > 0 || added.length > 0) {
    memoryLog.info('memory.tombstone_reapplied', { subjects: reports.length, reconciled: added.length });
  }
  return reports;
}
