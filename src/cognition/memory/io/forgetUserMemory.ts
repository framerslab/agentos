/**
 * @module memory/io/forgetUserMemory
 *
 * One subject's memory deleted from a store for good: the tombstone first, then the traces, the pages and the vector
 * index, then a report that names every store reached and every store not reached, and each of the deletion's four
 * parts.
 */
import { messageOf } from '../../../api/runtime/memoryObserveFailures.js';
import type { MemoryRecipient } from '../../../api/runtime/memoryRecipients.js';
import type { SoulMind } from '../../../api/runtime/soulStore.js';
import { errorFields } from '../../../core/logging/events.js';
import { agentosVersion } from '../../learning/ledger/canonical.js';
import { memoryLog } from '../log.js';
import { CONVERSATION_SCOPE, conversationScopeKey, parseConversationScopeKey } from '../retrieval/store/conversationScopeKey.js';
import type { ForgottenLedger, SuppressionSubject } from '../suppression/ForgottenLedger.js';
import { guardedWrite } from '../suppression/guardedWrite.js';
import type { Memory } from './facade/Memory.js';
import { LEGACY_SCOPE } from './legacyMemory.js';
import { RETENTION_DAY_MS } from './retentionSweep.js';

/** What one part of a deletion did: reached, with what it deleted, or missed, with why. */
export type PartOutcome = { reached: true; deleted: number } | { reached: false; reason: string };

/** One of a deletion's four parts, as its report lists it. */
type DeletionPart = ForgetMemoryReport['parts'][number];

/**
 * What a deletion did: the receipt a host keeps beside its own record of the request, which is what links the receipt
 * to the person. It never holds the subject's id, a hash of the id or any text of theirs.
 */
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
   * False when anything was still pending at the deadline, or a part of {@link parts} was not reached: a store the
   * call deletes from failed (the full-text index, the vector index and the write-ahead log included), a page failed,
   * the store holds memory from before per-user scope that nobody attributed, or open sessions kept what they hold of
   * the subject. The stores the call never reaches by design are named and do not count. The next open, or the next
   * re-application of the tombstones, resumes an incomplete deletion.
   */
  complete: boolean;
  /** When the deletion ended, as an ISO 8601 time in UTC. */
  completedAt: string;
  /** The agent whose store this is. */
  agentId: string;
  /** The version of `@framers/agentos` that ran the deletion; `'unknown'` where it has no file system to read it from. */
  libraryVersion: string;
  /**
   * The deletion's four parts, always in this order, each reached with a count or missed with the reason:
   *
   * - `tombstone`: reached once the ledger holds the subject's tombstone; it deletes nothing itself, so its count is 0.
   * - `mind`: what an agent's mind held of the subject, deleted through it (`mind`): reached with the number of rows it
   *   deleted, 0 where it holds none or none of its memory is open in this process, and missed with the reason when
   *   its delete failed, which leaves the keys it failed on as they were for the deletion made again.
   * - `store`: the store's own pass. Reached, with the number of traces deleted, when every store the call deletes
   *   from was reached (the caller's own included), every page was deleted and no memory from before per-user scope
   *   is left unattributed; missed with each of those that failed.
   * - `sessions`: what open sessions hold of the subject, as the caller's `sessions` option answered; reached with 0
   *   when the caller passed none.
   */
  parts: Array<{ part: 'tombstone' | 'mind' | 'store' | 'sessions' } & PartOutcome>;
  /**
   * Who receives a person's text, as the caller listed them (`recipients()` on a souled agent). No deletion reaches
   * them: telling each one is the host's.
   */
  recipients: MemoryRecipient[];
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
   * change `complete`. A function is called once the tombstone is written and the deletes are done, so what it
   * deletes stays while the tombstone cannot be written; one that throws or rejects is named as "the caller's own
   * stores" not reached, and the report's `store` part is missed.
   */
  extraStores?: ForgetMemoryReport['stores'] | (() => ForgetMemoryReport['stores'] | Promise<ForgetMemoryReport['stores']>);
  /**
   * Empties what open sessions hold of the subject. It is called once the tombstone is written and the deletes are
   * done, before `extraStores`, so the sessions keep what they hold while the tombstone cannot be written. Its answer
   * is the report's `sessions` part: reached with the number of sessions emptied, or missed with why, which leaves the
   * report incomplete. A call that throws is the part missed. Unset: the part is reached with 0.
   */
  sessions?: () => PartOutcome | Promise<PartOutcome>;
  /** Who receives a person's text (`recipients()` of a souled agent), copied into the report. Unset: none is listed. */
  recipients?: readonly MemoryRecipient[];
  /**
   * The mind of a souled agent on `runtime: 'gmi'` with cognitive memory on, which files into this store: each of the
   * subject's conversation keys, and each trace that names the user under another scope, is deleted through it first,
   * after the document chunks its rows were filed from and each trace's knowledge-graph copy and memory-graph node, and
   * then by the store's own pass, which reaches each row's vector and what the key still holds. A key the mind fails to
   * delete keeps what the mind did not delete of it, its traces, pages and registry row, so the deletion made again
   * finds it; the report's `mind` part is then missed.
   * The report's stores name it as `cognitive memory`. Unset: the part is reached with 0.
   *
   * @internal
   */
  mind?: Pick<SoulMind, 'deleteKey' | 'deleteTraces'>;
  /** The caller's own stores failed: the report's `store` part is missed, and the report is incomplete. */
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
 * What the store finds of each trace through its row alone, deleted before a mind deletes the rows: the document chunks
 * the traces were filed from, with their text, and each trace's knowledge-graph copy, with its text, and memory-graph
 * node. Once a row is gone, nothing finds them by the trace again.
 */
async function deleteWhatRowsName(memory: Memory, ids: readonly string[]): Promise<void> {
  await memory.deleteDocumentChunksOf(ids);
  await memory.deleteGraphRecordsOf(ids);
}

/** What a deletion's mind part did: the rows the mind deleted, and the first failure of its deletes. */
interface MindTally {
  deleted: number;
  failure?: string;
}

/**
 * Deletes named traces for good: with a mind, first what the store finds by each row (the document chunks the rows
 * were filed from, and each trace's knowledge-graph copy and memory-graph node), while the rows still name them; then
 * the mind's delete, which takes the rows with what the mind keeps of each; then the store's own delete, which reaches
 * the trace's vector and any row the mind left. A mind whose delete fails leaves the traces it did not delete, for the
 * deletion made again, and its failure is counted.
 *
 * @returns How many rows the store's own delete took.
 * @throws When the store's graph cannot delete the copies: before the mind is asked, so every row stays.
 */
async function deleteTracesThroughMind(
  memory: Memory,
  mind: ForgetUserMemoryOptions['mind'],
  ids: readonly string[],
  tally: MindTally,
): Promise<number> {
  if (ids.length === 0) return 0;
  if (mind) {
    await deleteWhatRowsName(memory, ids);
    try {
      const { deleted } = await mind.deleteTraces(ids);
      tally.deleted += deleted;
      if (deleted > 0) memory.markErasureOwed();
    } catch (error) {
      tally.failure ??= messageOf(error);
      // A delete that failed part way may have deleted rows: their words leave the indexes with this deletion's rebuild.
      memory.markErasureOwed();
      return 0;
    }
  }
  return (await memory.deleteTraces(ids, { documentChunks: 'delete' })).deleted;
}

/**
 * Deletes for good what a user said under scopes that are not theirs (the traces whose metadata names them as
 * `turnUserId`), with the document chunks those traces were filed from, and each page of another user's or session's
 * conversation compiled from such a trace. With a mind, each batch is deleted through it first
 * ({@link deleteTracesThroughMind}). A trace under a key of the user's that the mind failed to delete (`kept`) is left.
 *
 * Under each such conversation scope the pages go first, each whole, after the scope's registry row names the page's
 * other sources for the next compile to build the page again from. While a page is left, the scope's traces of the
 * user stay too, so the deletion made again finds the page by them. Once the traces are deleted, the call waits for a
 * compile of the scope that is running, which may have read them first, and deletes the page that compile wrote.
 * The user's own conversation keys (`ownKeys`) are left to the caller.
 */
async function deleteWhatTheUserSaidElsewhere(input: {
  memory: Memory;
  wiki: { storeFor(scopeId: string): SubjectPages };
  userId: string;
  ownKeys: readonly string[];
  kept: ReadonlySet<string>;
  pages: ForgetMemoryReport['pages'];
  tally: { deleted: number };
  mind: ForgetUserMemoryOptions['mind'];
  mindTally: MindTally;
}): Promise<void> {
  const { memory, wiki, pages, tally, mind, mindTally } = input;
  const named = (await memory.tracesNamingUser(input.userId)).filter(
    (trace) => !(trace.scope === CONVERSATION_SCOPE && input.kept.has(trace.scopeId)),
  );
  const namedIds = new Set(named.map((trace) => trace.id));
  const byScope = new Map<string, string[]>();
  const elsewhere: string[] = [];
  for (const trace of named) {
    const owner = trace.scope === CONVERSATION_SCOPE ? parseConversationScopeKey(trace.scopeId)?.subject : undefined;
    if (owner && owner.kind !== 'operator' && !input.ownKeys.includes(trace.scopeId)) {
      byScope.set(trace.scopeId, [...(byScope.get(trace.scopeId) ?? []), trace.id]);
    } else {
      elsewhere.push(trace.id);
    }
  }

  /** Deletes the scope's pages compiled from what the user said; true when one of them is left. */
  const deletePagesBuiltFrom = async (scopeId: string): Promise<boolean> => {
    const store = wiki.storeFor(scopeId);
    let left = false;
    for (const page of await store.listPages()) {
      if (!page.sources.some((id) => namedIds.has(id))) continue;
      try {
        await memory.addRebuildSources(
          scopeId,
          page.sources.filter((id) => !namedIds.has(id)),
        );
        await store.deletePage(page.id);
        pages.deleted += 1;
      } catch (error) {
        left = true;
        pages.failed.push({ id: page.id, reason: messageOf(error) });
      }
    }
    return left;
  };

  tally.deleted += await deleteTracesThroughMind(memory, mind, elsewhere, mindTally);
  for (const [scopeId, ids] of byScope) {
    if (await deletePagesBuiltFrom(scopeId)) continue;
    tally.deleted += await deleteTracesThroughMind(memory, mind, ids, mindTally);
    // A compile of the scope that read them before they went writes its page when it ends: that page goes too. A
    // compile that starts after the delete no longer finds them.
    await memory.waitForScopeChanges(scopeId);
    await deletePagesBuiltFrom(scopeId);
  }
}

/**
 * Deletes one subject's memory from a store for good and keeps it deleted.
 *
 * In order: the subject's pending writes and compiles are waited for (`drain`); the tombstone is written to the
 * ledger's copy and then to the store, and from then on every new write of the subject is refused; the subject's
 * conversation traces are deleted under this agent's key and under every other agent's key of the subject, the
 * soft-deleted rows, the graph copies, the full-text entries and the document chunks with them, through the agent's
 * mind first when the caller passes one (`mind`), which takes what the mind keeps of each; for a user, the
 * traces that name the user under other scopes, after each page of another user or session compiled from one of
 * them, which the next compile builds again from that subject's own traces; each compiled page of the subject with
 * its chunks; the scope's registry row; for the user older memory is attributed to (`legacy`), that memory and the
 * attribution; then the full-text index is rebuilt where a delete's own rebuild failed, the vector index is written
 * again from what is left, and the write-ahead log is emptied. A
 * page left keeps the traces it was found by, so the deletion made again finds it. A store that throws is named as
 * not reached and the next one still runs. No model call is made, and `Memory.forget()` (a soft delete) is never used.
 *
 * @returns The report. One `memory.forget_done` line is logged with its counts; when the report is not complete, one
 *   `memory.forget_incomplete` warn line follows it, with each part reached or missed.
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

  /**
   * The tombstone, with the corrections the ledger's copy keeps under each of the subject's keys deleted in its own
   * write to the copy: a tombstone the copy refuses deletes none of them, and nothing else.
   */
  const writeTombstone = async (): Promise<ForgetMemoryReport['tombstone']> => {
    const keys = new Set([ownKey]);
    let kept: Awaited<ReturnType<ForgottenLedger['keptCorrections']>> = [];
    try {
      kept = await ledger.keptCorrections();
    } catch {
      // A copy that cannot be read refuses the tombstone below with the ledger's own error; the agent's own key is named.
    }
    for (const row of kept) {
      const owner = parseConversationScopeKey(row.scopeId)?.subject;
      if (owner !== undefined && owner.kind !== 'operator' && owner.kind === subject.kind && owner.id === subject.id) keys.add(row.scopeId);
    }
    const { form, written } = await ledger.markForgotten(subject, { dropCorrectionsOf: [...keys] });
    return { form, written };
  };
  const tombstone: ForgetMemoryReport['tombstone'] =
    options.writeTombstone === false ? { form: ledger.keyed ? 'keyed' : 'unkeyed', written: false } : await writeTombstone();

  const pages: ForgetMemoryReport['pages'] = { deleted: 0, failed: [] };
  const mind = options.mind;
  /** What the mind deleted, and why its delete failed, when it did. */
  const mindTally: MindTally = { deleted: 0 };
  const deletes = async (): Promise<{ stores: ForgetMemoryReport['stores']; rows: number }> => {
    const stores: ForgetMemoryReport['stores'] = [];
    let traces = 0;
    /** The traces deleted with a scope's registry row, after the vector index's count was taken. */
    let withRegistryRows = 0;

    // Conversation memory: this agent's key of the subject, and the subject's key under each other agent of the store.
    const keys = [ownKey];
    /** The keys the mind failed to delete: the store's pass leaves their traces, pages and registry row as they are. */
    const kept = new Set<string>();
    let conversation = 0;
    let conversationFailure: string | undefined;
    try {
      for (const row of await memory.listScopes({ scope: CONVERSATION_SCOPE, kind: subject.kind })) {
        const other = parseConversationScopeKey(row.scopeId)?.subject;
        if (!other || other.kind === 'operator') continue;
        if (other.kind === subject.kind && other.id === subject.id && !keys.includes(row.scopeId)) keys.push(row.scopeId);
      }
      for (const key of keys) {
        if (!mind) {
          conversation += await deleteScopeWithDocuments(memory, CONVERSATION_SCOPE, key);
          continue;
        }
        // The key's rows, read before the mind deletes them: the document chunks they were filed from and their graph
        // records go first, while the rows still name them, and the store's own pass then reaches what it keeps of
        // each row by its id.
        const ids = await memory.tracesStoredBefore(CONVERSATION_SCOPE, key, Number.MAX_SAFE_INTEGER);
        await deleteWhatRowsName(memory, ids);
        try {
          const { deleted } = await mind.deleteKey(key);
          mindTally.deleted += deleted;
          if (deleted > 0) memory.markErasureOwed();
        } catch (error) {
          mindTally.failure ??= messageOf(error);
          // A delete that failed part way may have deleted rows: their words leave the indexes with this deletion's
          // rebuild.
          memory.markErasureOwed();
          kept.add(key);
          continue;
        }
        conversation += (await memory.deleteTraces(ids, { documentChunks: 'delete' })).deleted;
        conversation += (await memory.deleteScope(CONVERSATION_SCOPE, key)).deleted;
      }
    } catch (error) {
      conversationFailure = messageOf(error);
    }
    traces += conversation;

    // What the user said on someone else's session, filed under that session's scope, with each page of that scope
    // compiled from it.
    let naming: ForgetMemoryReport['stores'][number] | undefined;
    if (subject.kind === 'user') {
      const store = 'traces that name the user under other scopes';
      // Counted as they go, so the traces deleted before a failure still count for the vector index.
      const tally = { deleted: 0 };
      try {
        await deleteWhatTheUserSaidElsewhere({
          memory,
          wiki: options.wiki,
          userId: subject.id,
          ownKeys: keys,
          kept,
          pages,
          tally,
          mind,
          mindTally,
        });
        naming = { store, reached: true, deleted: tally.deleted };
      } catch (error) {
        naming = { store, reached: false, reason: messageOf(error) };
      }
      traces += tally.deleted;
    }

    // Pages, one by one, so each page that fails is named. A page is deleted whole, with its chunks. A key the mind
    // failed to delete keeps its pages with its traces.
    for (const key of keys) {
      if (kept.has(key)) continue;
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
          const more = (await memory.deleteScope(CONVERSATION_SCOPE, key)).deleted;
          conversation += more;
          withRegistryRows += more;
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

    // Each delete rebuilt the full-text index; one whose rebuild failed left the deleted words in it, tried again here.
    try {
      await memory.finishFullTextIndex();
    } catch (error) {
      stores.push({ store: 'full-text index', reached: false, reason: messageOf(error) });
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
    return { stores, rows: traces + withRegistryRows };
  };

  // A write stuck past the deadline holds the subject's turn: the deletes then run at once, and the guard takes that
  // write back when it lands.
  const ran = options.onChain && pendingAtDeadline === 0 ? await options.onChain(deletes) : await deletes();

  // What open sessions hold of the subject goes once the tombstone is written and the deletes are done.
  let sessions: PartOutcome = { reached: true, deleted: 0 };
  if (options.sessions) {
    try {
      const answer = await options.sessions();
      sessions = answer.reached ? { reached: true, deleted: answer.deleted } : { reached: false, reason: answer.reason };
    } catch (error) {
      sessions = { reached: false, reason: messageOf(error) };
    }
  }
  let extra: ForgetMemoryReport['stores'];
  /** Why the caller's own callback failed, after the deletes ran: the report still comes back. */
  let extraFailure: string | undefined;
  try {
    extra = typeof options.extraStores === 'function' ? await options.extraStores() : (options.extraStores ?? []);
  } catch (error) {
    extraFailure = messageOf(error);
    extra = [{ store: "the caller's own stores", reached: false, reason: extraFailure }];
  }
  const stores: ForgetMemoryReport['stores'] = [...ran.stores, ...NEVER_REACHED.map((entry) => ({ ...entry })), ...extra];
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

  // The store's own pass: each store the call deletes from that failed, the pages left, the caller's own stores that
  // failed, and older memory nobody attributed. Any of them leaves the part missed.
  const missed = ran.stores.flatMap((entry) => (entry.reached ? [] : [`${entry.store}: ${entry.reason}`]));
  if (pages.failed.length > 0) missed.push(pages.failed.length === 1 ? '1 page not deleted' : `${pages.failed.length} pages not deleted`);
  if (options.alsoIncomplete === true) missed.push("a store of the caller's own was not reached");
  if (extraFailure !== undefined) missed.push(`the caller's own stores: ${extraFailure}`);
  if (legacy) missed.push('legacy memory under the agent scope: unattributed');
  // Reached by here: a tombstone that cannot be written throws before anything is deleted.
  const tombstonePart: DeletionPart = { part: 'tombstone', reached: true, deleted: 0 };
  // What an agent's mind held: none without one.
  const mindPart: DeletionPart =
    mindTally.failure === undefined
      ? { part: 'mind', reached: true, deleted: mindTally.deleted }
      : { part: 'mind', reached: false, reason: mindTally.failure };
  // The mind is named among the stores first, as its part comes before the store's own.
  if (mind) {
    stores.unshift(
      mindPart.reached
        ? { store: 'cognitive memory', reached: true, deleted: mindPart.deleted }
        : { store: 'cognitive memory', reached: false, reason: mindPart.reason },
    );
  }
  const storePart: DeletionPart =
    missed.length === 0 ? { part: 'store', reached: true, deleted: ran.rows } : { part: 'store', reached: false, reason: missed.join('; ') };
  const sessionsPart: DeletionPart = { part: 'sessions', ...sessions };
  const parts = [tombstonePart, mindPart, storePart, sessionsPart];

  const complete = pendingAtDeadline === 0 && parts.every((part) => part.reached);
  const completedAt = new Date().toISOString();
  memoryLog.info('memory.forget_done', {
    stores: stores.filter((entry) => entry.reached).length,
    unreached: stores.filter((entry) => !entry.reached).length,
    pages: pages.deleted,
    pagesFailed: pages.failed.length,
    drained,
    pendingAtDeadline,
    complete: complete ? 'yes' : 'no',
  });
  if (!complete) {
    const state = (part: DeletionPart) => (part.reached ? 'reached' : 'missed');
    memoryLog.warn('memory.forget_incomplete', {
      tombstone: state(tombstonePart),
      mind: state(mindPart),
      store: state(storePart),
      sessions: state(sessionsPart),
      pendingAtDeadline,
      pagesFailed: pages.failed.length,
    });
  }
  return {
    tombstone,
    stores,
    pages,
    drained,
    pendingAtDeadline,
    complete,
    completedAt,
    agentId,
    libraryVersion: await agentosVersion(),
    parts,
    recipients: [...(options.recipients ?? [])],
  };
}

export interface ReapplyTombstonesOptions
  extends Pick<ForgetUserMemoryOptions, 'memory' | 'ledger' | 'wiki' | 'agentId' | 'legacyUnattributed'> {
  /**
   * The per-subject parts of one deletion: the subject's drain and chain, what the caller reached itself, what open
   * sessions hold of the subject, who receives a person's text, and the mind the deletion runs through.
   */
  forSubject?: (
    subject: SuppressionSubject,
  ) => Promise<
    Pick<ForgetUserMemoryOptions, 'drain' | 'onChain' | 'extraStores' | 'alsoIncomplete' | 'legacy' | 'sessions' | 'recipients' | 'mind'>
  >;
  /**
   * Runs the work on one conversation key in that subject's turn, after its writes and compiles: the deleted traces a
   * restore brought back under the key, and the corrections filed again under it. Unset: at once.
   */
  onKey?: <T>(scopeId: string, work: () => Promise<T>) => Promise<T>;
  /**
   * How many days a key's traces are kept (none: until deletion). A kept correction stored longer ago than that is not
   * filed again and goes from the ledger's copy. Unset: no period ends a kept correction.
   */
  retentionDaysOf?: (scopeId: string, kind: 'user' | 'session') => number | undefined;
  /** The clock, in Unix ms. Default `Date.now`. */
  now?: () => number;
  /**
   * Called with a conversation key just before the traces a restore brought back under it are deleted again, and once
   * more when that has settled, as a correction's own deletion is announced: a running turn of that subject that
   * recalled one of them does not file a reply restating it. Unset: nothing is called.
   */
  changing?: (scopeId: string) => void;
}

/** What the re-application did with the traces the ledger records as deleted. */
interface DeletedTracesReapplied {
  /** The rows deleted again. */
  traces: number;
  /** The rows still stored because a page built from one, or the delete, failed: the next re-application tries again. */
  missed: number;
}

/**
 * Deletes again each trace the ledger records as deleted ({@link ForgottenLedger.markTracesDeleted}) that the store
 * still holds, live or soft-deleted, as after a restore from a backup taken before a correction or a single deletion.
 * Under a conversation key, each page built from one goes first and is named for the next compile to build again from
 * the traces of it that are left, as in a correction; a key whose page cannot be deleted keeps its traces, so the next
 * re-application finds the page by them.
 */
async function reapplyDeletedTraces(
  options: Pick<ReapplyTombstonesOptions, 'memory' | 'wiki' | 'onKey' | 'changing'>,
  ledger: ForgottenLedger,
): Promise<DeletedTracesReapplied> {
  const { memory } = options;
  const done: DeletedTracesReapplied = { traces: 0, missed: 0 };
  const marked = await ledger.deletedTraceIds();
  if (marked.length === 0) return done;
  const byKey = new Map<string, string[]>();
  const elsewhere: string[] = [];
  for (const row of await memory.storedTracesAmong(marked)) {
    if (row.scope === CONVERSATION_SCOPE && row.scopeId !== '') byKey.set(row.scopeId, [...(byKey.get(row.scopeId) ?? []), row.id]);
    else elsewhere.push(row.id);
  }
  const remove = async (ids: readonly string[]): Promise<void> => {
    try {
      done.traces += (await memory.deleteTraces(ids)).deleted;
    } catch {
      done.missed += ids.length;
    }
  };
  for (const [key, ids] of byKey) {
    const work = async (): Promise<void> => {
      const gone = new Set(ids);
      options.changing?.(key);
      try {
        try {
          const store = options.wiki.storeFor(key);
          for (const page of await store.listPages()) {
            if (!page.sources.some((id) => gone.has(id))) continue;
            // Named before the page goes, so a page deleted is always rebuilt.
            await memory.addRebuildSources(
              key,
              page.sources.filter((id) => !gone.has(id)),
            );
            await store.deletePage(page.id);
          }
        } catch {
          done.missed += ids.length;
          return;
        }
        await remove(ids);
      } finally {
        options.changing?.(key);
      }
    };
    await (options.onKey ? options.onKey(key, work) : work());
  }
  if (elsewhere.length > 0) await remove(elsewhere);
  return done;
}

/** Whether a stored tags column holds a tag. */
function holdsTag(tags: string, tag: string): boolean {
  try {
    const parsed: unknown = JSON.parse(tags);
    return Array.isArray(parsed) && parsed.includes(tag);
  } catch {
    return false;
  }
}

/**
 * Files again each correction the ledger's copy keeps ({@link ForgottenLedger.keepCorrection}) that the store lacks,
 * as after a restore from a backup taken before the correction: under its id, key and time, tagged `correction`, as
 * a trace of the soul's own memory, and named for the next compile to read by id. Where the store holds the same
 * words under the key with another id, that trace is the correction and the kept row names it from then on, and the
 * id the correction had is recorded as deleted; where it holds the kept trace without its `correction` tag, the tag
 * is put back and the trace is named for the next compile. A kept row whose subject is forgotten, whose
 * trace the ledger records as deleted, or that is older than its key's retention period goes from the copy instead.
 * Another agent's kept rows are left to that agent.
 *
 * A kept row the store refuses to file again (a write or an embedding that fails) stays kept, is counted, and is tried
 * again at the next re-application: an open does not fail on it. Each filing is read against the tombstones before and
 * after it lands, as a turn's write is: one that lands after its person was forgotten is taken back, and its kept row
 * goes.
 *
 * @returns How many corrections were filed again, and how many could not be.
 */
async function refileKeptCorrections(
  options: Pick<ReapplyTombstonesOptions, 'memory' | 'agentId' | 'onKey' | 'retentionDaysOf' | 'now'>,
  ledger: ForgottenLedger,
): Promise<{ refiled: number; missed: number }> {
  const { memory, agentId } = options;
  const now = options.now ?? Date.now;
  const kept = await ledger.keptCorrections();
  if (kept.length === 0) return { refiled: 0, missed: 0 };
  const byKey = new Map<string, typeof kept>();
  const drop: string[] = [];
  for (const row of kept) {
    const owner = parseConversationScopeKey(row.scopeId);
    if (owner === undefined || owner.subject.kind === 'operator') {
      drop.push(row.traceId);
      continue;
    }
    if (owner.agentId !== agentId) continue;
    byKey.set(row.scopeId, [...(byKey.get(row.scopeId) ?? []), row]);
  }
  let refiled = 0;
  let missed = 0;
  for (const [key, rows] of byKey) {
    const subject = parseConversationScopeKey(key)!.subject as SuppressionSubject;
    const work = async (): Promise<void> => {
      // Read again in the subject's turn: a correction or a deletion that ran before it changed what is kept.
      const still = new Set((await ledger.correctionsOf(key)).map((row) => row.traceId));
      const live = rows.filter((row) => still.has(row.traceId));
      if (live.length === 0) return;
      if (await ledger.isForgotten(subject)) {
        drop.push(...live.map((row) => row.traceId));
        return;
      }
      const marked = new Set(await ledger.deletedTraceIds(live.map((row) => row.traceId)));
      const days = options.retentionDaysOf?.(key, subject.kind);
      const present = new Map((await memory.storedTracesAmong(live.map((row) => row.traceId))).map((row) => [row.id, row]));
      for (const row of live) {
        if (marked.has(row.traceId) || (days !== undefined && row.createdAt < now() - days * RETENTION_DAY_MS)) {
          drop.push(row.traceId);
          continue;
        }
        const there = present.get(row.traceId);
        try {
          if (there) {
            // The store holds it; a restore from before the trace was marked a correction took the tag. As the
            // correction did, it is named for the next compile to read by id: the restored watermark can be past it.
            if (!there.deleted) {
              const snapshot = await memory.readTrace(row.traceId);
              if (snapshot && !holdsTag(snapshot.tags, 'correction')) {
                // Named before the tag goes back: a note that fails leaves the tag off, so the next re-application
                // finds the trace again and tries both.
                await memory.addRebuildSources(key, [row.traceId]);
                await memory.markCorrection(row.traceId, []);
              }
            }
            continue;
          }
          // The next compile reads it by id: its time can be below the compile's watermark. Named before the trace is
          // filed, so a note that fails leaves the correction unfiled and the next re-application tries both again.
          await memory.addRebuildSources(key, [row.traceId]);
          // Checked against the tombstones again once it lands: a deletion of the person that stopped waiting for
          // this filing at its deadline does not find it, so a filing that lands after the tombstone is taken back.
          let landed = false;
          const filed = await guardedWrite(
            ledger,
            subject,
            async () => {
              const stored = await memory.remember(row.text, {
                type: 'episodic',
                scope: CONVERSATION_SCOPE,
                scopeId: key,
                id: row.traceId,
                createdAt: row.createdAt,
                tags: ['correction'],
                metadata: { subject: { kind: subject.kind, id: subject.id }, ...(subject.kind === 'user' ? { turnUserId: subject.id } : {}) },
              });
              landed = true;
              return stored;
            },
            async (trace) => {
              // Only a trace this filing made is taken back: words the key already held under another id stay, so a
              // tombstone read that fails loses none of them.
              if (trace.id === row.traceId) await memory.deleteTraces([trace.id]);
            },
          );
          if (filed.status === 'refused') {
            // The person is forgotten: nothing of the filing stays, nor the registry row it made again after their
            // deletion had run, and the kept row goes.
            if (landed) await memory.deleteScope(CONVERSATION_SCOPE, key).catch(() => undefined);
            drop.push(row.traceId);
            continue;
          }
          const trace = filed.result;
          if (trace.id === row.traceId) {
            refiled += 1;
            continue;
          }
          // The store held the words under another id: that trace is the one the next compile reads.
          await memory.addRebuildSources(key, [trace.id]);
          // The store holds the same words under another id: that trace is the correction, and the kept row names it.
          // The id the correction had is recorded as deleted in the same write to the copy, which drops its kept row: a
          // later restore that brings that trace back deletes it again, so deleting the trace that now holds the words
          // leaves no copy of them behind.
          await memory.markCorrection(trace.id, []);
          await ledger.markTracesDeleted([row.traceId], {
            keep: { traceId: trace.id, scopeId: key, text: row.text, createdAt: Number(trace.createdAt) },
          });
        } catch {
          // Kept for the next re-application, which tries it again.
          missed += 1;
        }
      }
    };
    await (options.onKey ? options.onKey(key, work) : work());
  }
  if (drop.length > 0) await ledger.dropCorrections(drop);
  return { refiled, missed };
}

/**
 * Brings the store's ledger up to date from its copy, then runs the deletion again, with no second tombstone, for
 * every forgotten subject the store still holds: after a restore from a backup taken before a deletion, after a
 * deletion that did not finish, and for what another process wrote after a tombstone. It deletes nothing of a subject
 * the ledger does not hold, and never touches memory from before per-user scope that nobody attributed.
 *
 * Then each trace the ledger records as deleted by a correction or a single deletion, which the store holds again, is
 * deleted again with each page built from it, and each correction the ledger's copy keeps, which the store lacks, is
 * filed again under its id, key and time; a kept correction of a forgotten subject, of a trace recorded as deleted or
 * past its key's retention period goes from the copy instead.
 *
 * Then it runs what earlier deletes left owed in the store's files ({@link Memory.finishErasure}): a vector index
 * rewrite or a log checkpoint a deletion could not finish, which no held subject would lead it back to; a failure
 * there writes one `memory.erasure_unfinished` line and stays owed.
 *
 * One `memory.tombstone_reapplied` line is logged when a subject was re-applied, a tombstone came back from the copy,
 * a recorded trace was deleted again or could not be, or a kept correction was filed again or could not be.
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
  // What a correction or a single deletion recorded: its deleted traces, and the correction's text.
  const traces = await reapplyDeletedTraces(options, ledger);
  const corrections = await refileKeptCorrections(options, ledger);
  try {
    // A rewrite of the vector index or a checkpoint of the log that a deletion could not finish runs again, though
    // the store may hold nothing more of the subject to find it by.
    await memory.finishErasure();
  } catch (error) {
    memoryLog.warn('memory.erasure_unfinished', errorFields(error));
  }
  if (reports.length > 0 || added.length > 0 || traces.traces > 0 || traces.missed > 0 || corrections.refiled > 0 || corrections.missed > 0) {
    memoryLog.info('memory.tombstone_reapplied', {
      subjects: reports.length,
      reconciled: added.length,
      traces: traces.traces,
      tracesMissed: traces.missed,
      correctionsRefiled: corrections.refiled,
      correctionsMissed: corrections.missed,
    });
  }
  return reports;
}
