/**
 * @module memory/io/userMemoryExport
 *
 * One subject's memory as a document a host can hand to that person, and a correction of it: the wrong traces are
 * deleted for good and the corrected statement is filed in their place, or nothing is, for a deletion of named traces.
 */
import type { MemoryRecipient } from '../../../api/runtime/memoryRecipients.js';
import type { LearnedStateDocument } from '../../learning/types.js';
import type { WikiPage } from '../../substrate/memory/wiki/types.js';
import { errorFields } from '../../../core/logging/events.js';
import type { AgentSession } from '../../../api/agent.js';
import type { SoulMind } from '../../../api/runtime/soulStore.js';
import type { IMemoryArchive } from '../archive/IMemoryArchive.js';
import { buildEmotionalContext } from '../core/encoding/EncodingModel.js';
import type { MemoryTrace } from '../core/types.js';
import { memoryLog } from '../log.js';
import { CONVERSATION_SCOPE, conversationScopeKey } from '../retrieval/store/conversationScopeKey.js';
import { memoryGraphEdgesAmong } from '../retrieval/store/SqlMemoryGraph.js';
import { parseTraceMetadata } from '../retrieval/store/tracePersistence.js';
import type { KeptCorrection, SuppressionSubject } from '../suppression/ForgottenLedger.js';
import { guardedWrite } from '../suppression/guardedWrite.js';
import { brainOf } from './facade/handedBrain.js';
import { readStoredTraceRefs, type Memory } from './facade/Memory.js';
import type { SubjectPages } from './forgetUserMemory.js';
import { LEGACY_GMI_STORE, legacyGmiTraceIdsOf, readLegacyGmiRowsOf, type LegacyGmiStore } from './legacyGmiStore.js';
import { LEGACY_SCOPE } from './legacyMemory.js';
import type { RetentionPeriod } from './retentionSweep.js';

/** One compiled page as the export holds it. */
export interface ExportedPage {
  id: string;
  summary: string;
  updated: string;
  sources: string[];
  body: string;
}

/** One trace as the export holds what the store keeps of it. */
export interface HeldTrace {
  id: string;
  /** When it was stored, ISO 8601. */
  createdAt: string;
  speaker?: 'user' | 'assistant';
  text: string;
  tags: string[];
  /** The entities the store recorded for it. */
  entities: string[];
  /** Which side filed it: the mind of a souled agent's GMI (`'mind'`), or the soul's own memory (`'soul'`). */
  filedBy: 'mind' | 'soul';
  /**
   * The emotional context stored with it: all zeros and a `neutral` mood where none was stored, and a neutral state
   * (no valence, dominance or intensity, an arousal of 0.5, the middle of its scale, and the mood `neutral`) where the
   * mind of a souled agent stored the trace neutral.
   */
  emotionalContext: { valence: number; arousal: number; dominance: number; intensity: number; gmiMood: string };
  encodingStrength: number;
  stability: number;
  retrievalCount: number;
  /** When it was last recalled, ISO 8601; its storing time when it never was. */
  lastAccessedAt: string;
}

/**
 * One subject's memory: what they and the agent said, as the store holds it, and the pages compiled from it; what the
 * subject provided and what is held about them; who receives a person's text; how long it is kept; and whether the
 * subject is profiled.
 */
export interface UserMemoryExport {
  /** When the export was made, ISO 8601. */
  exportedAt: string;
  agentId: string;
  /** The kind of subject the export is of. The id is the caller's own and is not repeated. */
  subject: { kind: 'user' | 'session' };
  /** The subject's conversation traces, oldest first; a page's chunks are left out. */
  traces: Array<{ id: string; createdAt: string; speaker?: 'user' | 'assistant'; text: string; tags: string[] }>;
  /** The pages compiled from the subject's traces. */
  pages: ExportedPage[];
  /** What the subject provided: their own messages, oldest first, and none of the agent's replies. */
  provided: { messages: Array<{ id: string; createdAt: string; text: string }> };
  /** What is held about the subject. */
  held: {
    /** Each of the subject's traces, oldest first, with what the store keeps of it. */
    traces: HeldTrace[];
    /** The verbatim text an archive keeps of a held trace, where one does. */
    archivedOriginals: Array<{ traceId: string; text: string }>;
    /** Typed facts extracted from the subject's traces: none, as no souled agent extracts them. */
    typedFacts: [];
    /** Links between two held traces from the store's graph and the live cognitive memory graph. */
    graphLinks: Array<{ from: string; to: string; type: string; weight: number }>;
    /** The pages compiled from the subject's traces, as {@link UserMemoryExport.pages}. */
    pages: ExportedPage[];
    /** The subject's learned state, when the agent runs a learning layer. */
    learner?: LearnedStateDocument;
    /**
     * Live traces of the subject in a passed GMI store, oldest first: those under their user and persona scopes, under
     * the scopes of their sessions that store's learning tables index, and a turn's rows filed for them as a second
     * user. A deletion removes the same rows.
     */
    legacyGmiStore?: Array<{ id: string; createdAt: string; speaker?: 'user' | 'assistant'; text: string }>;
    /**
     * The corrections of the subject whose text the tombstones' second copy also keeps. `text` is given for one the
     * export holds no trace of: a restore of the store took it, and filing it again has not succeeded yet, so the copy
     * is the one place that holds those words.
     */
    restoreCopies: Array<{ traceId: string; text?: string }>;
  };
  /** Who receives a person's text from the agent: agent-wide, the same list for every person. */
  recipients: MemoryRecipient[];
  /**
   * How long the subject's traces are kept: the agent's period for the subject's kind (`'none'` with no retention
   * set), and the shortest number of days the host's memory policy answered for the subject in this process.
   */
  retention: { period: RetentionPeriod | 'none'; policyDays?: number };
  /**
   * Whether the subject's messages are scored for sentiment (`'on'` or `'off'`), and how many held traces carry an
   * emotional context other than a neutral one: a trace stored with no emotional context, or with a neutral state, is
   * not counted.
   */
  profiling: { sentiment: 'on' | 'off'; moodStamps: number };
  /**
   * Each store the export could not read, with the kind of error and never the error's text. The part of the export
   * that store fills is left empty, not filled with what was read before the failure.
   */
  unread: Array<{ store: ExportStore; reason: string }>;
}

/** The stores an export reads, each named in {@link UserMemoryExport.unread} when its read fails. */
export const EXPORT_STORES = [
  'recipients',
  'tombstone ledger',
  'tombstone copy',
  'older traces',
  'conversation traces',
  'memory graph',
  'archived originals',
  'older compiled pages',
  'compiled pages',
  'learning store',
  LEGACY_GMI_STORE,
] as const;
/** One store an export reads. */
export type ExportStore = (typeof EXPORT_STORES)[number];

/** How many traces one read of the export asks for. */
const EXPORT_BATCH = 500;

/** The key of the trace metadata that records who spoke a trace. */
const SPEAKER_KEY = 'speaker';

/** The metadata key, and the value, that mark a trace the mind of a souled agent's GMI filed. */
const FILED_BY_KEY = 'filedBy';
const FILED_BY_MIND = 'mind';

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

/** A finite number, else 0. */
const finiteOr0 = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** The emotional context of a trace, its four numbers and its mood, with what the row lacks filled as neutral. */
function emotionalContextOf(trace: MemoryTrace): HeldTrace['emotionalContext'] {
  const stored: unknown = trace.emotionalContext;
  const given = (stored !== null && typeof stored === 'object' ? stored : {}) as Partial<
    Record<keyof HeldTrace['emotionalContext'], unknown>
  >;
  return {
    valence: finiteOr0(given.valence),
    arousal: finiteOr0(given.arousal),
    dominance: finiteOr0(given.dominance),
    intensity: finiteOr0(given.intensity),
    gmiMood: typeof given.gmiMood === 'string' && given.gmiMood !== '' ? given.gmiMood : 'neutral',
  };
}

/**
 * The arousal a neutral state is stored with. A trace keeps its arousal on a scale from 0 to 1, so a state with no
 * arousal either way is stored at the middle of it.
 */
const NEUTRAL_STORED_AROUSAL = buildEmotionalContext({ valence: 0, arousal: 0, dominance: 0 }, 'neutral').arousal;

/**
 * Whether an emotional context is other than a neutral one. Neutral is no valence, no dominance, no intensity and the
 * mood `neutral`, with an arousal of 0 (a trace stored with no emotional context) or of the middle of its scale (a
 * trace stored with a neutral state, as the mind of a souled agent stores each turn unless the host opts in to its
 * mood).
 */
function isMoodStamp(context: HeldTrace['emotionalContext']): boolean {
  const neutralArousal = context.arousal === 0 || context.arousal === NEUTRAL_STORED_AROUSAL;
  return (
    context.valence !== 0 ||
    !neutralArousal ||
    context.dominance !== 0 ||
    context.intensity !== 0 ||
    context.gmiMood.toLowerCase() !== 'neutral'
  );
}

/** A time in epoch milliseconds as ISO 8601. */
const isoOf = (ms: unknown): string => new Date(Number(ms)).toISOString();

/** Why a read failed, for {@link UserMemoryExport.unread}: the error's listed type and code, never its text. */
function readFailure(error: unknown): string {
  const { type, code } = errorFields(error);
  return code === 'unknown' ? `the read failed (${type})` : `the read failed (${type}, ${code})`;
}

/**
 * One subject's memory as JSON: every live conversation trace filed under the subject's own key, oldest first, with
 * who spoke it, and every page compiled from them; the subject's own messages (`provided`); what the store holds about
 * them (`held`); who receives a person's text; how long it is kept; and whether the subject is profiled. It reads that
 * key alone, by equality: the operator's pages, other subjects' memory and a session's own message history are not
 * in it. A forgotten subject's export holds nothing of them, and its `profiling.sentiment` is `'off'`. A read that
 * fails leaves its part empty and is named in `unread`, and the export still returns; a tombstone ledger that cannot
 * be read leaves every part of the subject empty.
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
  /** A passed GMI store whose learner rows are exported separately from the soul's store. @internal */
  legacyGmiStore?: LegacyGmiStore;
  /** Who receives a person's text from the agent. Unset: none is named. A read that fails is named in `unread`. */
  recipients?: () => Promise<MemoryRecipient[]>;
  /** How long the subject's traces are kept. Unset: `{ period: 'none' }`. */
  retention?: { period: RetentionPeriod | 'none'; policyDays?: number };
  /** Whether the subject's messages are scored for sentiment, by the subject's key. Unset: `'off'`. */
  profilingOf?: (scopeId: string) => 'on' | 'off';
  /** The subject's learned state, when the agent runs a learning layer. A read that fails is named in `unread`. */
  learner?: () => Promise<LearnedStateDocument>;
  /** The opened store's archive. Only held trace ids are rehydrated, with the `user_export` access context. */
  archive?: Pick<IMemoryArchive, 'rehydrate'>;
  /** A memory graph held in this process beside the store's: its links between the subject's traces are added. */
  liveGraph?: { getEdges(memoryId: string): Array<{ sourceId: string; targetId: string; type: string; weight: number }> };
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
    provided: { messages: [] },
    held: {
      traces: [],
      archivedOriginals: [],
      typedFacts: [],
      graphLinks: [],
      pages: [],
      restoreCopies: [],
      ...(options.legacyGmiStore ? { legacyGmiStore: [] } : {}),
    },
    recipients: [],
    // What the host answered for this subject (policyDays, the sentiment its answer leaves) is added once the ledger
    // says the subject is not forgotten.
    retention: options.retention
      ? { period: typeof options.retention.period === 'object' ? { ...options.retention.period } : options.retention.period }
      : { period: 'none' },
    profiling: { sentiment: 'off', moodStamps: 0 },
    unread: [],
  };
  /**
   * Runs one read of `store` and, once it has read everything, hands what it read to `keep`. A read that fails keeps
   * nothing of that store, is named in `unread`, and writes one `memory.export_unread` line; the export goes on.
   */
  const unreadOf = (store: ExportStore, error: unknown): void => {
    document.unread.push({ store, reason: readFailure(error) });
    memoryLog.warn('memory.export_unread', { store, ...errorFields(error) });
  };
  const reading = async <T>(store: ExportStore, read: () => Promise<T>, keep: (value: T) => void): Promise<void> => {
    let value: T;
    try {
      value = await read();
    } catch (error) {
      unreadOf(store, error);
      return;
    }
    keep(value);
  };
  if (options.recipients) {
    const listed = options.recipients;
    await reading('recipients', listed, (recipients) => {
      document.recipients = [...recipients];
    });
  }
  if (memory.forgotten) {
    // A ledger that cannot be read leaves the export holding nothing of the subject: it cannot tell whether the
    // subject was forgotten.
    let gone: boolean;
    try {
      gone = await memory.isForgotten(subject);
    } catch (error) {
      unreadOf('tombstone ledger', error);
      return document;
    }
    // A forgotten subject's messages are filed and scored for nothing.
    if (gone) return document;
  }
  if (options.retention?.policyDays !== undefined) document.retention.policyDays = options.retention.policyDays;
  document.profiling.sentiment = options.profilingOf?.(key) ?? 'off';

  const seen = new Set<string>();
  /** What one read of traces found, kept in the export only once the read has finished. */
  interface TraceSection {
    traces: UserMemoryExport['traces'];
    messages: UserMemoryExport['provided']['messages'];
    held: HeldTrace[];
  }
  /** Every live trace of one scope, oldest first, a page's chunks left out, into `section`. */
  const readScope = async (scope: string, scopeId: string, section: TraceSection): Promise<void> => {
    let since = 0;
    let limit = EXPORT_BATCH;
    for (;;) {
      const batch = await memory.recentTraces(since, { scope, scopeId, limit, order: 'asc' });
      const fresh = batch.filter((trace) => !seen.has(trace.id));
      for (const trace of fresh) {
        seen.add(trace.id);
        if (trace.tags.includes('wiki')) continue;
        const metadata = parseTraceMetadata((await memory.readTrace(trace.id))?.metadata);
        const said = metadata[SPEAKER_KEY];
        const speaker = said === 'user' || said === 'assistant' ? said : undefined;
        const createdAt = isoOf(trace.createdAt);
        section.traces.push({ id: trace.id, createdAt, ...(speaker ? { speaker } : {}), text: trace.content, tags: [...trace.tags] });
        if (speaker === 'user') section.messages.push({ id: trace.id, createdAt, text: trace.content });
        section.held.push({
          id: trace.id,
          createdAt,
          ...(speaker ? { speaker } : {}),
          text: trace.content,
          tags: [...trace.tags],
          entities: Array.isArray(trace.entities) ? trace.entities.filter((entity) => typeof entity === 'string') : [],
          filedBy: metadata[FILED_BY_KEY] === FILED_BY_MIND ? 'mind' : 'soul',
          emotionalContext: emotionalContextOf(trace),
          encodingStrength: finiteOr0(trace.encodingStrength),
          stability: finiteOr0(trace.stability),
          retrievalCount: finiteOr0(trace.retrievalCount),
          lastAccessedAt: isoOf(trace.lastAccessedAt),
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
  /** Reads traces into a section of their own, and keeps the section in the export once the read has finished. */
  const readTraces = (store: ExportStore, scopes: ReadonlyArray<readonly [string, string]>): Promise<void> =>
    reading(
      store,
      async () => {
        const section: TraceSection = { traces: [], messages: [], held: [] };
        for (const [scope, scopeId] of scopes) await readScope(scope, scopeId, section);
        return section;
      },
      (section) => {
        // One push a trace: a history of any length, never one call's arguments.
        for (const trace of section.traces) document.traces.push(trace);
        for (const message of section.messages) document.provided.messages.push(message);
        for (const trace of section.held) document.held.traces.push(trace);
      },
    );
  if (options.legacy?.forms.length) {
    await readTraces('older traces', options.legacy.forms.map((form) => [LEGACY_SCOPE, form] as const));
  }
  await readTraces('conversation traces', [[CONVERSATION_SCOPE, key]]);
  document.profiling.moodStamps = document.held.traces.filter((trace) => isMoodStamp(trace.emotionalContext)).length;
  const heldIds = document.held.traces.map((trace) => trace.id);

  const legacyGmiStore = options.legacyGmiStore;
  if (legacyGmiStore && subject.kind === 'user') {
    await reading(LEGACY_GMI_STORE, async () => {
      const held: NonNullable<UserMemoryExport['held']['legacyGmiStore']> = [];
      for (const row of await readLegacyGmiRowsOf(legacyGmiStore, subject.id)) {
        let tags: unknown;
        try {
          tags = JSON.parse(row.tags);
        } catch {
          // A trace with unreadable tags still has text to export.
        }
        if (Array.isArray(tags) && tags.includes('wiki')) continue;
        const role = Array.isArray(tags) ? tags[0] : undefined;
        const speaker = role === 'user' || role === 'role:user' ? 'user' : role === 'assistant' || role === 'role:assistant' ? 'assistant' : undefined;
        held.push({ id: row.id, text: row.content, createdAt: isoOf(row.created_at), ...(speaker ? { speaker } : {}) });
      }
      return held;
    }, (rows) => {
      document.held.legacyGmiStore = rows;
      // The person's own messages there are what they provided too, each once: a row an interrupted move left in both
      // stores is already listed from the soul's.
      const listed = new Set(document.provided.messages.map((message) => message.id));
      const theirs = rows
        .filter((row) => row.speaker === 'user' && !listed.has(row.id))
        .map(({ id, createdAt, text }) => ({ id, createdAt, text }));
      if (theirs.length > 0) {
        document.provided.messages = [...document.provided.messages, ...theirs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      }
    });
  }

  if (heldIds.length > 0) {
    await reading('memory graph', async () => {
      // One record a link, by its two ends and its type: a live link of another type between the same two traces is a
      // link of its own, and a link both graphs hold is listed once, as the store records it.
      const links = new Map<string, UserMemoryExport['held']['graphLinks'][number]>();
      const linkKeyOf = (edge: { sourceId: string; targetId: string; type: string }) =>
        `${edge.sourceId}\u0000${edge.targetId}\u0000${edge.type}`;
      for (const edge of await memoryGraphEdgesAmong(brainOf(memory), heldIds)) {
        links.set(linkKeyOf(edge), { from: edge.sourceId, to: edge.targetId, type: edge.type, weight: edge.weight });
      }
      const live = options.liveGraph;
      if (live) {
        const held = new Set(heldIds);
        for (const id of heldIds) {
          for (const edge of live.getEdges(id)) {
            if (edge.sourceId !== id || !held.has(edge.targetId)) continue;
            const linkKey = linkKeyOf(edge);
            if (!links.has(linkKey)) links.set(linkKey, { from: edge.sourceId, to: edge.targetId, type: edge.type, weight: edge.weight });
          }
        }
      }
      return [...links.values()];
    }, (links) => {
      document.held.graphLinks = links;
    });
  }
  const archive = options.archive;
  if (archive && heldIds.length > 0) {
    await reading('archived originals', async () => {
      const originals: UserMemoryExport['held']['archivedOriginals'] = [];
      for (const id of heldIds) {
        const original = await archive.rehydrate(id, 'user_export');
        if (original) originals.push({ traceId: id, text: original.verbatimContent });
      }
      return originals;
    }, (originals) => {
      document.held.archivedOriginals = originals;
    });
  }

  const pages: WikiPage[] = [];
  const legacyPages = options.legacy?.pages;
  if (legacyPages) {
    await reading('older compiled pages', legacyPages, (read) => {
      pages.push(...read);
    });
  }
  await reading('compiled pages', () => options.wiki.storeFor(key).listPages(), (read) => {
    pages.push(...read);
  });
  for (const page of pages) {
    document.pages.push({ id: page.id, summary: page.summary, updated: page.updated, sources: [...page.sources], body: page.body });
  }
  document.held.pages = document.pages.map((page) => ({ ...page, sources: [...page.sources] }));

  const learner = options.learner;
  if (learner) {
    await reading('learning store', learner, (state) => {
      document.held.learner = state;
    });
  }
  // The corrections whose text the tombstones' second copy keeps, so a restore of the store does not lose them.
  const ledger = memory.forgotten;
  if (ledger) {
    await reading(
      'tombstone copy',
      async () => {
        const kept = await ledger.correctionsOf(key);
        // A correction the export holds no trace of is held in the copy alone: its words are given here.
        const exported = new Set(document.traces.map((trace) => trace.id));
        const alone = kept.some((row) => !exported.has(row.traceId))
          ? new Map((await ledger.keptCorrections(key)).map((row) => [row.traceId, row.text]))
          : new Map<string, string>();
        return kept.map((row) => {
          const text = exported.has(row.traceId) ? undefined : alone.get(row.traceId);
          return text === undefined ? { traceId: row.traceId } : { traceId: row.traceId, text };
        });
      },
      (copies) => {
        document.held.restoreCopies = copies;
      },
    );
  }
  return document;
}

/** What {@link correctSubjectMemory} is handed beside the change itself. */
export interface SubjectCorrectionOptions {
  memory: Memory;
  /** A passed GMI store that can also hold the named user's traces. @internal */
  legacyGmiStore?: LegacyGmiStore;
  wiki: { storeFor(scopeId: string): SubjectPages };
  agentId: string;
  subject: SuppressionSubject;
  /**
   * Who receives a person's text from the agent, for the result. Unset: none is named. It is read in the subject's
   * turn before anything is changed, so a read that rejects rejects the call and changes nothing.
   */
  recipients?: () => Promise<MemoryRecipient[]>;
  /**
   * Called once, in the subject's turn, when every named id has passed the ownership check and before anything is
   * changed. A souled agent counts the change there: the reply of a turn that recalled the subject's memory before
   * it is not filed.
   *
   * @internal
   */
  beforeChange?: () => void;
  /** Runs the change in the subject's turn, after its writes and compiles. Unset: at once. */
  onChain?: <T>(work: () => Promise<T>) => Promise<T>;
  /**
   * The mind of a souled agent on `runtime: 'gmi'` with cognitive memory on, which files into this store: the named
   * traces are deleted through it before the store's own delete, with what it keeps of each (its cached copy, vector,
   * memory-graph node and archived original), and dropped from the subject's open sessions once they are gone. A
   * delete of the mind that fails rejects the call, and the same call made again finishes it.
   *
   * @internal
   */
  mind?: Pick<SoulMind, 'deleteTraces' | 'evictTraces'>;
  /**
   * The sessions open for the subject, read once the named traces are deleted, whose working memory `mind` drops them
   * from. Unset: none.
   *
   * @internal
   */
  sessions?: () => Iterable<AgentSession>;
}

/** What a deletion of named traces resolves with; a correction adds the id of the trace it filed. */
export interface SubjectCorrectionResult {
  /** How many of the named traces were deleted. */
  deleted: number;
  /** How many pages built from a named trace were deleted; the subject's next compile builds each again. */
  pagesDeleted: number;
  /** Who receives a person's text from the agent, as the call was handed the list. The call sends them nothing. */
  recipients: MemoryRecipient[];
}

/**
 * Corrects one subject's memory, or deletes named traces of it with no replacement.
 *
 * Each page compiled from a named trace is deleted and built again by the subject's next compile, from the traces of
 * it that are left and the correction. With `text`, the corrected statement is filed as a trace tagged `correction`
 * (words the subject's key already holds are that trace, marked as the correction and kept, even when it is a named
 * one); with no `text`, nothing is filed. The named traces are then deleted for good, and the vector index and the
 * store's write-ahead log are written out ({@link Memory.finishErasure}). A deleted trace cannot come back in a later
 * compile, which is why a correction deletes instead of editing a page.
 *
 * On a store with a forgotten-user ledger, the correction's text is kept in the ledger's second copy under the id of
 * its trace, and each named trace is recorded there as deleted, before any of them is deleted: every open and every
 * re-application of the tombstones deletes a recorded trace a restore brought back and files a kept correction a
 * restore took away. A write to the copy that fails rejects the call before any named trace is recorded or deleted;
 * the pages built from them may be deleted by then, and the next compile builds them again.
 *
 * The named traces go last, so a call that failed partway is finished by the same call made again: it still finds
 * them. With a souled agent's mind (`mind`), each trace's graph records go first, then the mind deletes the traces with
 * what it keeps of each, then the store's own delete runs, and last the traces leave the working memory of the
 * subject's open sessions (`sessions`). An index rewrite or a log checkpoint that fails does not fail the call; one
 * `memory.erasure_unfinished` line says so, and the next deletion, sweep or re-application of the tombstones runs it.
 *
 * Every named id must be one of the subject's own traces (a page's chunk is not one): live, or recorded as deleted by
 * an earlier call that failed partway while its row still sits under the subject's key. When any is another
 * subject's, unknown or already deleted for good, the call rejects with a count and nothing is changed.
 *
 * @returns How many traces and pages it deleted, who receives a person's text, and, for a correction, the id of the
 *   correction's trace; a deletion with no `text` has no `correctionTraceId`.
 * @throws TypeError when the subject or the trace ids are missing, or when `text` is given and is not a non-empty
 *   string: a deletion leaves `text` out.
 * @throws Error when a named id is not one of the subject's live traces (one `memory.write_refused` line, reason
 *   `foreign_trace`), or when a correction's subject is forgotten (reason `forgotten`): nothing is written for them
 *   again.
 */
export function correctSubjectMemory(
  options: SubjectCorrectionOptions & { correction: { traceIds: readonly string[]; text: string } },
): Promise<SubjectCorrectionResult & { correctionTraceId: string }>;
export function correctSubjectMemory(
  options: SubjectCorrectionOptions & { correction: { traceIds: readonly string[]; text?: undefined } },
): Promise<SubjectCorrectionResult>;
export function correctSubjectMemory(
  options: SubjectCorrectionOptions & { correction: { traceIds: readonly string[]; text?: string } },
): Promise<SubjectCorrectionResult & { correctionTraceId?: string }>;
export async function correctSubjectMemory(
  options: SubjectCorrectionOptions & { correction: { traceIds: readonly string[]; text?: string } },
): Promise<SubjectCorrectionResult & { correctionTraceId?: string }> {
  const { memory, agentId } = options;
  const subject = checkedSubject(options.subject, 'correctSubjectMemory');
  const given = options.correction as { traceIds?: unknown; text?: unknown } | null | undefined;
  const named: unknown = given?.traceIds;
  const text: unknown = given?.text;
  if (!Array.isArray(named) || named.length === 0 || named.some((id) => typeof id !== 'string' || id === '')) {
    throw new TypeError('correctUserMemory: name at least one trace id');
  }
  // No text deletes with no replacement. A text that is empty, or no string, is neither a correction nor that.
  if (text !== undefined && (typeof text !== 'string' || text === '')) {
    throw new TypeError(
      'correctUserMemory: the corrected text is a non-empty string; leave it out to delete the traces with no replacement',
    );
  }
  const replacement = text as string | undefined;
  const ids = [...new Set(named as string[])];
  const key = conversationScopeKey(agentId, subject);

  const correct = async (): Promise<SubjectCorrectionResult & { correctionTraceId?: string }> => {
    // The ownership check, before any change, read in the subject's turn so no write of theirs runs between it and
    // the delete.
    const own = new Set(await memory.liveTraceIdsOf(CONVERSATION_SCOPE, key, ids));
    const ledger = memory.forgotten;
    const notLive = ids.filter((id) => !own.has(id));
    const recorded = new Set(ledger && notLive.length > 0 ? await ledger.deletedTraceIds(notLive) : []);
    if (recorded.size > 0) {
      // A call that failed partway recorded these ids as deleted; a delete that soft-deleted a row and then failed left
      // it under the subject's key. The call made again owns such a row, whatever its deleted flag, and finishes it.
      for (const row of await memory.storedTracesAmong(notLive.filter((id) => recorded.has(id)))) {
        if (row.scope === CONVERSATION_SCOPE && row.scopeId === key && !row.chunk) own.add(row.id);
      }
    }
    const legacy = options.legacyGmiStore;
    const ownLegacy = new Set<string>();
    const outsideSoul = ids.filter((id) => !own.has(id));
    if (legacy && subject.kind === 'user') {
      let rows: Awaited<ReturnType<typeof readStoredTraceRefs>> = [];
      /** The subject's rows there, whatever their deleted flag: those the export lists and a deletion removes. */
      let theirs = new Set<string>();
      try {
        rows = await readStoredTraceRefs(legacy.brain, ids);
        theirs = new Set(await legacyGmiTraceIdsOf(legacy, subject.id));
      } catch (error) {
        // A passed store that cannot be read leaves a call that names the soul's traces alone to the soul's store: the
        // ledger's marks delete any copy there at the next open.
        if (outsideSoul.length > 0) throw error;
        rows = [];
      }
      for (const row of rows) {
        if (!theirs.has(row.id) || row.chunk) continue;
        // A move that filed a trace and stopped before its source row was deleted leaves the id in both stores: that
        // row, marked or not, is the same trace and goes with the soul's.
        if (own.has(row.id) || !row.deleted || recorded.has(row.id)) ownLegacy.add(row.id);
      }
    }
    const missing = outsideSoul.filter((id) => !ownLegacy.has(id)).length;
    if (missing > 0) {
      memoryLog.warn('memory.write_refused', { reason: 'foreign_trace' });
      throw new Error(`correctUserMemory: ${missing} of ${ids.length} trace ids are not this user's live traces`);
    }
    // Who received the text, read before any change: a list that cannot be read leaves the memory as it was.
    const recipients = options.recipients ? [...(await options.recipients())] : [];
    options.beforeChange?.();

    // A page built from a named trace still says what the trace said: it goes whole, and the next compile builds it
    // again from the traces of it that are left, read by id, beside the correction. Those are named before the page
    // goes, so a page deleted is always rebuilt.
    const gone = new Set(ids);
    const store = options.wiki.storeFor(key);
    let pagesDeleted = 0;
    for (const page of await store.listPages()) {
      if (!page.sources.some((id) => gone.has(id))) continue;
      await memory.addRebuildSources(
        key,
        page.sources.filter((id) => !gone.has(id)),
      );
      await store.deletePage(page.id);
      pagesDeleted += 1;
    }

    let correctionTraceId: string | undefined;
    /** The correction's text, for the tombstones' second copy. */
    let kept: KeptCorrection | undefined;
    if (replacement !== undefined) {
      const filed = await guardedWrite(
        { isForgotten: (who) => (memory.forgotten ? memory.isForgotten(who) : Promise.resolve(false)) },
        subject,
        () =>
          memory.remember(replacement, {
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

      // The store keeps one trace for words the subject's key already holds: `remember` may have returned that
      // trace, one of the named ones or an earlier correction. Whichever it is, it is the correction: the next compile
      // reads it by id, beside the traces after its watermark; it is marked as one, with these ids among those it
      // corrects (both steps leave a trace filed by this call as it is); and it is not deleted with the others.
      correctionTraceId = filed.result.id;
      await memory.addRebuildSources(key, [correctionTraceId]);
      // A retention sweep that runs past the subject's chain at close() can delete it first: this call deletes nothing
      // named then. Made again, it files the correction anew when every named trace is still live; the sweep may have
      // deleted the reused one, and the ownership check then rejects the call.
      if (!(await memory.markCorrection(correctionTraceId, ids))) {
        throw new Error('correctUserMemory: the correction is no longer stored; no named trace was deleted');
      }
      kept = { traceId: correctionTraceId, scopeId: key, text: replacement, createdAt: Number(filed.result.createdAt) };
    }

    // The traces that go are recorded as deleted in both copies of the ledger, and the correction's text is kept in the
    // tombstones' second copy in the same write to it, before any named trace is deleted: a restore from before this
    // call has them deleted again and the correction filed again at the next open, and a call that fails from here is
    // finished by the same call made again.
    const removed = ids.filter((id) => id !== correctionTraceId);
    await ledger?.markTracesDeleted(removed, kept ? { keep: kept } : {});
    const going = removed.filter((id) => own.has(id));
    let deleted = 0;
    const mind = options.mind;
    if (mind) {
      // What the store finds of each trace by its id while its row is still there (its knowledge-graph copy, with its
      // text, and its memory-graph node) goes first: the mind's delete takes the rows, with what the mind keeps of
      // each, and a call made again after a failure further on finds the traces by their rows.
      await memory.deleteGraphRecordsOf(going);
      try {
        deleted += (await mind.deleteTraces(going)).deleted;
      } catch (error) {
        // A delete that failed part way may have deleted rows: their words leave the indexes with the call made again.
        memory.markErasureOwed();
        throw error;
      }
      if (deleted > 0) memory.markErasureOwed();
    }
    // The store's own delete reaches each trace's vector, and any row the mind left.
    try {
      deleted += (await memory.deleteTraces(going)).deleted;
    } catch (error) {
      // Once the mind has taken every named row, the store owes them its indexes alone, which the rewrite below makes;
      // a call made again would find no row to own. With a row left, the call made again finishes it.
      if (!mind || (await memory.storedTracesAmong(going)).length > 0) throw error;
      memory.markErasureOwed();
    }
    // A slot of an open session holds a trace's id and no words: it goes once the traces are gone.
    if (mind) await mind.evictTraces(going, options.sessions?.() ?? []);
    try {
      // A delete only marks a vector in the index, and the log still holds the pages written before the delete.
      await memory.finishErasure();
    } catch (error) {
      memoryLog.warn('memory.erasure_unfinished', errorFields(error));
    }
    // Every named id's row there goes, the correction's own included: a correction whose text is a moved copy's keeps
    // that copy as the correction, and the source row it was copied from goes all the same.
    const legacyIds = ids.filter((id) => ownLegacy.has(id));
    if (legacy && legacyIds.length > 0) {
      // A copy of a trace the soul's store held is counted once, with the soul's.
      const legacyOnly = legacyIds.filter((id) => !own.has(id));
      const copies = legacyIds.filter((id) => own.has(id));
      if (legacyOnly.length > 0) deleted += (await legacy.deleteTraces(legacyOnly)).deleted;
      if (copies.length > 0) await legacy.deleteTraces(copies);
    }
    return { deleted, pagesDeleted, ...(correctionTraceId !== undefined ? { correctionTraceId } : {}), recipients };
  };
  return options.onChain ? options.onChain(correct) : correct();
}
