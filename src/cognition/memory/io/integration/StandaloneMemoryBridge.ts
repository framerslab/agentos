/**
 * @fileoverview Adapters that let the standalone SQLite-first `Memory`
 * facade participate in AgentOS long-term memory flows.
 *
 * These bridges intentionally use the public `Memory` API so the same memory
 * instance can power:
 * - agent-editable memory tools
 * - prompt-time long-term memory retrieval
 * - rolling-summary persistence
 *
 * Where a learning layer runs, the retriever's input and the sink's update carry the turn's scope ids (`turnScopes`):
 * both read and file the user, persona and conversation scopes under them, and the sink records each upsert through
 * the turn's recorder as one memory write, naming the traces it writes and forgets.
 *
 * @module agentos/memory/integration/StandaloneMemoryBridge
 */

import type {
  LongTermMemoryFeedbackInput,
  ILongTermMemoryRetriever,
  LongTermMemoryRetrievalInput,
  LongTermMemoryRetrievalResult,
} from '../../../../core/conversation/ILongTermMemoryRetriever.js';
import type {
  IRollingSummaryMemorySink,
  RollingSummaryMemoryUpdate,
} from '../../../../core/conversation/IRollingSummaryMemorySink.js';
import {
  DEFAULT_LONG_TERM_MEMORY_POLICY,
  type ResolvedLongTermMemoryPolicy,
  type RollingSummaryMemoryCategory,
} from '../../../../core/conversation/LongTermMemoryPolicy.js';
import type { Memory } from '../facade/Memory.js';
import type { ScoredTrace, RememberOptions, RecallOptions } from '../facade/index.js';
import type { MemoryTrace } from '../../core/types.js';
import { uuid } from '../../core/util/crossPlatformCrypto.js';
import type { TraceSnapshot } from '../../retrieval/store/tracePersistence.js';
import { taggedScopeId } from '../../../learning/scopes.js';
import type { TurnScopes } from '../../../learning/types.js';

type RuntimeStandaloneMemory = Pick<Memory, 'remember' | 'forget'> &
  Partial<Pick<Memory, 'close'>>;

type FeedbackCapableLongTermMemory = Pick<Memory, 'recall'> &
  Partial<Pick<Memory, 'feedbackFromResponse'>>;

type MemoryScopeTarget = {
  key: string;
  label: 'conversation' | 'persona' | 'user' | 'organization';
  memoryScope: 'thread' | 'persona' | 'user' | 'organization';
  scopeId: string;
};

type AtomicDoc = {
  key: string;
  content: string;
  tags: string[];
  entities: string[];
};

const DEFAULT_BASE_TAGS = ['agentos', 'long_term_memory'];
const CATEGORY_ORDER: RollingSummaryMemoryCategory[] = [
  'facts',
  'preferences',
  'people',
  'projects',
  'decisions',
  'open_loops',
  'todo',
  'tags',
];

export interface StandaloneMemoryLongTermRetrieverOptions {
  /**
   * Fallback result limit for scopes that do not have an explicit cap.
   * @default 4
   */
  defaultLimitPerScope?: number;

  /**
   * Conversation-scope cap. `topKByScope` only covers user/persona/org.
   * @default 4
   */
  conversationLimit?: number;

  /**
   * Include markdown headings for each scope block in the returned context.
   * @default true
   */
  includeScopeHeadings?: boolean;
}

export interface StandaloneMemoryRollingSummarySinkOptions {
  /**
   * Tags added to every persisted rolling-memory trace.
   * @default ['agentos', 'long_term_memory']
   */
  baseTags?: string[];

  /**
   * Importance assigned to summary snapshot traces.
   * @default 0.9
   */
  summaryImportance?: number;

  /**
   * Importance assigned to atomic `memory_json` item traces.
   * @default 1.0
   */
  atomicDocImportance?: number;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeText(value: unknown): string | null {
  return nonEmptyString(value);
}

function formatPeopleEntry(person: unknown): { content: string; entities: string[] } | null {
  if (typeof person !== 'object' || person === null) return null;
  const name = nonEmptyString((person as any).name);
  const notes = nonEmptyString((person as any).notes);
  if (!name) return null;
  return {
    content: notes ? `Person: ${name}. ${notes}` : `Person: ${name}.`,
    entities: [name],
  };
}

function formatProjectEntry(project: unknown): { content: string; entities: string[] } | null {
  if (typeof project !== 'object' || project === null) return null;
  const name = nonEmptyString((project as any).name);
  const status = nonEmptyString((project as any).status);
  const notes = nonEmptyString((project as any).notes);
  if (!name) return null;

  const parts = [`Project: ${name}.`];
  if (status) parts.push(`Status: ${status}.`);
  if (notes) parts.push(notes);

  return {
    content: parts.join(' ').trim(),
    entities: [name],
  };
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function buildStandaloneMemoryPersonaScopeId(userId: string, personaId: string): string {
  return `${userId}::${personaId}`;
}

function resolveScopeTargets(args: {
  userId: string;
  organizationId?: string;
  conversationId: string;
  personaId: string;
  policy: ResolvedLongTermMemoryPolicy;
  /** With a learning layer: the turn's scope ids, which the user, persona and conversation targets take. */
  turnScopes?: TurnScopes;
}): MemoryScopeTarget[] {
  const targets: MemoryScopeTarget[] = [];
  const { userId, organizationId, conversationId, personaId, policy, turnScopes } = args;

  if (policy.scopes.conversation && conversationId) {
    // With a learning layer a turn's own thread is written in its session's form, as the memory tools write it.
    const scopeId = turnScopes ? taggedScopeId(conversationId, turnScopes.namespace) : conversationId;
    targets.push({
      key: `thread:${scopeId}`,
      label: 'conversation',
      memoryScope: 'thread',
      scopeId,
    });
  }

  if (policy.scopes.persona && (turnScopes || (userId && personaId))) {
    const scopeId = turnScopes ? turnScopes.personaScopeId : buildStandaloneMemoryPersonaScopeId(userId, personaId);
    targets.push({
      key: `persona:${scopeId}`,
      label: 'persona',
      memoryScope: 'persona',
      scopeId,
    });
  }

  if (policy.scopes.user && (turnScopes || userId)) {
    const scopeId = turnScopes ? turnScopes.userScopeId : userId;
    targets.push({
      key: `user:${scopeId}`,
      label: 'user',
      memoryScope: 'user',
      scopeId,
    });
  }

  if (
    policy.scopes.organization &&
    policy.shareWithOrganization &&
    organizationId
  ) {
    // An organization's shared scope is the host's choice, filed under the organization's own id with or without a
    // layer; forgetUser names it as a store it does not reach.
    targets.push({
      key: `organization:${organizationId}`,
      label: 'organization',
      memoryScope: 'organization',
      scopeId: organizationId,
    });
  }

  return targets;
}

/** What the sink needs of its facade to record an upsert in a learning layer's ledger. */
type RecordableStandaloneMemory = Pick<Memory, 'remember' | 'forget' | 'brainId' | 'readTrace' | 'deleteTraces' | 'restoreTrace'>;

/** The facade as one the sink records an upsert through, when it has every member a recorded write needs. */
function recordableOf(memory: RuntimeStandaloneMemory): RecordableStandaloneMemory | undefined {
  const candidate = memory as Partial<RecordableStandaloneMemory>;
  return typeof candidate.brainId === 'string' &&
    candidate.brainId !== '' &&
    typeof candidate.readTrace === 'function' &&
    typeof candidate.deleteTraces === 'function' &&
    typeof candidate.restoreTrace === 'function'
    ? (memory as RecordableStandaloneMemory)
    : undefined;
}

/**
 * What a target's last recorded upsert left: its summary's trace and text, each atomic document's trace by key, and
 * the traces a forget left.
 */
interface RecordedTargetState {
  summary?: { id: string; content: string };
  docs: Map<string, string>;
  stale: Set<string>;
}

/** One target's part of a recorded upsert: what it keeps, what it inserts under ids named first, and what it forgets. */
interface PlannedTarget {
  target: MemoryScopeTarget;
  summary: { content: string; id: string; insert: boolean };
  docs: Array<{ doc: AtomicDoc; id: string; insert: boolean }>;
  forget: string[];
}

/** What a recorded upsert did. */
interface RecordedUpsert {
  /** The traces it inserted; a text its scope already held resolved to that trace and is not among them. */
  created: string[];
  /** The traces it forgot. */
  forgotten: string[];
  /** The traces it meant to forget and could not: the next upsert of their target forgets them. */
  unforgotten: string[];
  /** Per target key: the trace each summary and atomic document resolved to. */
  resolved: Map<string, { summary: string; docs: Map<string, string> }>;
}

/** A trace id named before its write, in the facade's form (`mt_<uuid>`). */
const plannedTraceId = (): string => `mt_${uuid()}`;

function getScopeLimit(
  target: MemoryScopeTarget,
  input: LongTermMemoryRetrievalInput,
  options: Required<StandaloneMemoryLongTermRetrieverOptions>,
): number {
  if (target.label === 'conversation') {
    return options.conversationLimit;
  }

  if (target.label === 'user') {
    return input.topKByScope?.user ?? options.defaultLimitPerScope;
  }
  if (target.label === 'persona') {
    return input.topKByScope?.persona ?? options.defaultLimitPerScope;
  }
  if (target.label === 'organization') {
    return input.topKByScope?.organization ?? options.defaultLimitPerScope;
  }

  return options.defaultLimitPerScope;
}

function trimContextText(text: string, maxContextChars?: number): {
  contextText: string;
  truncated: boolean;
} {
  if (!maxContextChars || maxContextChars <= 0 || text.length <= maxContextChars) {
    return { contextText: text, truncated: false };
  }

  const trimmed = text.slice(0, Math.max(0, maxContextChars - 1)).trimEnd();
  return {
    contextText: `${trimmed}…`,
    truncated: true,
  };
}

function renderScopeHeading(label: MemoryScopeTarget['label']): string {
  if (label === 'conversation') return 'Conversation Memory';
  if (label === 'persona') return 'Persona Memory';
  if (label === 'user') return 'User Memory';
  return 'Organization Memory';
}

export function createStandaloneMemoryLongTermRetriever(
  memory: FeedbackCapableLongTermMemory,
  options?: StandaloneMemoryLongTermRetrieverOptions,
): ILongTermMemoryRetriever {
  const resolvedOptions: Required<StandaloneMemoryLongTermRetrieverOptions> = {
    defaultLimitPerScope: options?.defaultLimitPerScope ?? 4,
    conversationLimit: options?.conversationLimit ?? 4,
    includeScopeHeadings: options?.includeScopeHeadings ?? true,
  };

  return {
    async retrieveLongTermMemory(
      input: LongTermMemoryRetrievalInput,
    ): Promise<LongTermMemoryRetrievalResult | null> {
      const policy = input.memoryPolicy ?? DEFAULT_LONG_TERM_MEMORY_POLICY;
      const targets = resolveScopeTargets({
        userId: input.userId,
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        personaId: input.personaId,
        policy,
        turnScopes: input.turnScopes,
      });

      if (targets.length === 0) {
        return null;
      }

      const scopeResults: Array<{
        target: MemoryScopeTarget;
        hits: ScoredTrace[];
      }> = [];

      for (const target of targets) {
        const recallPolicy = input.retrievalPolicy ?? policy.retrieval ?? undefined;
        const recallOptions: RecallOptions = {
          limit: getScopeLimit(target, input, resolvedOptions),
          scope: target.memoryScope,
          scopeId: target.scopeId,
          policy: recallPolicy,
        };
        const hits = await memory.recall(input.queryText, recallOptions);
        if (hits.length > 0) {
          scopeResults.push({ target, hits });
        }
      }

      if (scopeResults.length === 0) {
        return null;
      }

      const seenContent = new Set<string>();
      const seenTraceIds = new Set<string>();
      const sections: string[] = [];
      const selectedTraces: MemoryTrace[] = [];
      const diagnostics: Record<string, unknown> = {
        totalHits: 0,
        queryText: input.queryText,
        scopes: {} as Record<string, number>,
      };

      for (const { target, hits } of scopeResults) {
        const lines: string[] = [];
        for (const hit of hits) {
          const content = normalizeText(hit.trace.content);
          if (!content) continue;
          if (seenContent.has(content)) continue;
          seenContent.add(content);
          if (!seenTraceIds.has(hit.trace.id)) {
            seenTraceIds.add(hit.trace.id);
            selectedTraces.push(hit.trace);
          }
          lines.push(`- ${content}`);
        }

        if (lines.length === 0) {
          continue;
        }

        (diagnostics.scopes as Record<string, number>)[target.label] = lines.length;
        diagnostics.totalHits = Number(diagnostics.totalHits) + lines.length;

        if (resolvedOptions.includeScopeHeadings) {
          sections.push(`### ${renderScopeHeading(target.label)}`);
        }
        sections.push(...lines);
      }

      if (sections.length === 0) {
        return null;
      }

      const rendered = sections.join('\n');
      const { contextText, truncated } = trimContextText(rendered, input.maxContextChars);
      diagnostics.truncated = truncated;

      return {
        contextText,
        diagnostics,
        feedbackPayload: selectedTraces.length > 0
          ? { traces: selectedTraces }
          : undefined,
      };
    },

    async recordRetrievalFeedback(
      input: LongTermMemoryFeedbackInput,
    ): Promise<void> {
      if (typeof memory.feedbackFromResponse !== 'function') {
        return;
      }

      const traces = Array.isArray((input.feedbackPayload as any)?.traces)
        ? ((input.feedbackPayload as any).traces as MemoryTrace[])
        : [];

      if (!input.responseText.trim() || traces.length === 0) {
        return;
      }

      await memory.feedbackFromResponse(traces, input.responseText, input.queryText);
    },
  };
}

function categoryAllowed(
  category: RollingSummaryMemoryCategory,
  allowedCategories: RollingSummaryMemoryCategory[] | null,
): boolean {
  if (allowedCategories === null) return true;
  return allowedCategories.includes(category);
}

function buildSummaryContent(update: RollingSummaryMemoryUpdate): string {
  return [
    `Rolling summary for conversation ${update.conversationId} (persona ${update.personaId}).`,
    update.summaryText.trim(),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function collectSummaryEntities(summaryJson: any): string[] {
  const entities: string[] = [];
  if (!summaryJson || typeof summaryJson !== 'object') {
    return entities;
  }

  if (Array.isArray(summaryJson.people)) {
    for (const person of summaryJson.people) {
      const name = nonEmptyString(person?.name);
      if (name) entities.push(name);
    }
  }

  if (Array.isArray(summaryJson.projects)) {
    for (const project of summaryJson.projects) {
      const name = nonEmptyString(project?.name);
      if (name) entities.push(name);
    }
  }

  return unique(entities);
}

function extractAtomicDocs(
  summaryJson: any,
  allowedCategories: RollingSummaryMemoryCategory[] | null,
  baseTags: string[],
): AtomicDoc[] {
  if (!summaryJson || typeof summaryJson !== 'object') {
    return [];
  }

  const docs: AtomicDoc[] = [];

  const pushDoc = (
    category: RollingSummaryMemoryCategory,
    key: string,
    content: string | null,
    entities: string[] = [],
  ): void => {
    const normalized = normalizeText(content);
    if (!normalized || !categoryAllowed(category, allowedCategories)) {
      return;
    }
    docs.push({
      key: `${category}:${key}`,
      content: normalized,
      tags: [...baseTags, 'rolling_memory_item', `category:${category}`],
      entities: unique(entities),
    });
  };

  if (Array.isArray(summaryJson.facts)) {
    for (const item of summaryJson.facts) {
      const text = normalizeText(item?.text);
      pushDoc('facts', text ?? '', text ? `Fact: ${text}` : null);
    }
  }

  if (Array.isArray(summaryJson.preferences)) {
    for (const item of summaryJson.preferences) {
      const text = normalizeText(item?.text);
      pushDoc('preferences', text ?? '', text ? `Preference: ${text}` : null);
    }
  }

  if (Array.isArray(summaryJson.people)) {
    for (const person of summaryJson.people) {
      const formatted = formatPeopleEntry(person);
      pushDoc(
        'people',
        formatted?.content ?? '',
        formatted?.content ?? null,
        formatted?.entities ?? [],
      );
    }
  }

  if (Array.isArray(summaryJson.projects)) {
    for (const project of summaryJson.projects) {
      const formatted = formatProjectEntry(project);
      pushDoc(
        'projects',
        formatted?.content ?? '',
        formatted?.content ?? null,
        formatted?.entities ?? [],
      );
    }
  }

  if (Array.isArray(summaryJson.decisions)) {
    for (const item of summaryJson.decisions) {
      const text = normalizeText(item?.text);
      pushDoc('decisions', text ?? '', text ? `Decision: ${text}` : null);
    }
  }

  if (Array.isArray(summaryJson.open_loops)) {
    for (const item of summaryJson.open_loops) {
      const text = normalizeText(item?.text);
      pushDoc('open_loops', text ?? '', text ? `Open loop: ${text}` : null);
    }
  }

  if (Array.isArray(summaryJson.todo)) {
    for (const item of summaryJson.todo) {
      const text = normalizeText(item?.text);
      pushDoc('todo', text ?? '', text ? `Todo: ${text}` : null);
    }
  }

  if (Array.isArray(summaryJson.tags) && categoryAllowed('tags', allowedCategories)) {
    for (const tag of summaryJson.tags) {
      const normalized = normalizeText(tag);
      pushDoc('tags', normalized ?? '', normalized ? `Tag: ${normalized}` : null);
    }
  }

  return docs;
}

/**
 * A rolling-summary sink over a standalone `Memory`: each compaction's summary, and its atomic documents where the
 * policy keeps them, filed per target scope, replacing the ones the target's last upsert filed.
 *
 * Where a learning layer runs (an update with `turnScopes`), the targets take the turn's scope ids and each upsert is
 * one memory write recorded through the turn's recorder: its candidate names the traces it will insert (their ids
 * named before the write) and forget (with their snapshots); every new trace is written before any old one is
 * forgotten; a failure before the forgets takes back what the upsert wrote, a failure among them keeps the upsert with
 * what it did forget, and its kept verdict names what it inserted and forgot. A text that did not change keeps its
 * trace while that trace is live (one deleted since is filed again), an upsert that changes nothing writes nothing and
 * no row, and one sink's recorded upserts run one at a time. A freeze and a forgotten user resolve with nothing
 * written; an upsert the layer refuses for any other reason, or one the sink cannot record (no recorder, or a facade it
 * cannot read back, delete and restore by trace id), rejects having written nothing.
 *
 * What a target's last upsert filed is kept in the process, so after a restart the first upsert of a target replaces
 * nothing it did not file itself; the same holds for a summary a `revert` brought back, which stays beside the next
 * upsert's.
 */
export function createStandaloneMemoryRollingSummarySink(
  memory: RuntimeStandaloneMemory,
  options?: StandaloneMemoryRollingSummarySinkOptions,
): IRollingSummaryMemorySink {
  const baseTags = unique(options?.baseTags ?? DEFAULT_BASE_TAGS);
  const summaryImportance = options?.summaryImportance ?? 0.9;
  const atomicDocImportance = options?.atomicDocImportance ?? 1.0;
  const summaryTraceIds = new Map<string, string>();
  const atomicTraceIds = new Map<string, Map<string, string>>();
  // Where a learning layer records the upserts: what each target's last recorded upsert left, and the chain that runs
  // them one at a time, so each plans from the one before.
  const recordedTargets = new Map<string, RecordedTargetState>();
  let recordedQueue: Promise<unknown> = Promise.resolve();

  const upsertDocsForScope = async (
    target: MemoryScopeTarget,
    docs: AtomicDoc[],
  ): Promise<void> => {
    const next = new Map<string, string>();

    for (const doc of docs) {
      const trace = await memory.remember(doc.content, {
        type: 'semantic',
        scope: target.memoryScope,
        scopeId: target.scopeId,
        tags: doc.tags,
        entities: doc.entities,
        importance: atomicDocImportance,
      } satisfies RememberOptions);
      next.set(doc.key, trace.id);
    }

    const previous = atomicTraceIds.get(target.key);
    if (previous) {
      for (const [key, traceId] of previous.entries()) {
        if (next.get(key) !== traceId) {
          await memory.forget(traceId);
        }
      }
    }

    atomicTraceIds.set(target.key, next);
  };

  /** One target's part: a text it kept keeps its trace, a new one gets an id before it is written, an old one is forgotten. */
  const planTarget = (target: MemoryScopeTarget, summaryContent: string, atomicDocs: AtomicDoc[]): PlannedTarget => {
    const state = recordedTargets.get(target.key);
    const summary =
      state?.summary && state.summary.content === summaryContent
        ? { content: summaryContent, id: state.summary.id, insert: false }
        : { content: summaryContent, id: plannedTraceId(), insert: true };
    const docs = atomicDocs.map((doc) => {
      const kept = state?.docs.get(doc.key);
      return kept ? { doc, id: kept, insert: false } : { doc, id: plannedTraceId(), insert: true };
    });
    const nextKeys = new Set(atomicDocs.map((doc) => doc.key));
    const forget = new Set<string>(state?.stale ?? []);
    if (state?.summary && summary.insert) forget.add(state.summary.id);
    for (const [key, id] of state?.docs ?? new Map<string, string>()) {
      if (!nextKeys.has(key)) forget.add(id);
    }
    return { target, summary, docs, forget: [...forget] };
  };

  /**
   * A text a plan keeps is filed again when its trace is gone or deleted since the last upsert (a revert took it back,
   * or the host forgot it), as an upsert with no layer files it again.
   */
  const refileGone = async (facade: RecordableStandaloneMemory, plans: readonly PlannedTarget[]): Promise<void> => {
    const live = async (id: string): Promise<boolean> => (await facade.readTrace(id))?.deleted === 0;
    for (const plan of plans) {
      if (!plan.summary.insert && !(await live(plan.summary.id))) plan.summary = { ...plan.summary, id: plannedTraceId(), insert: true };
      for (const [index, step] of plan.docs.entries()) {
        if (!step.insert && !(await live(step.id))) plan.docs[index] = { ...step, id: plannedTraceId(), insert: true };
      }
    }
  };

  /** Writes every new trace first and forgets the old ones last; a failure among the writes takes back what they wrote. */
  const applyPlan = async (
    facade: RecordableStandaloneMemory,
    plans: readonly PlannedTarget[],
    forgettable: ReadonlySet<string>,
    write: { summaryTags: string[]; summaryEntities: string[]; metadata: Record<string, unknown> | undefined },
  ): Promise<RecordedUpsert> => {
    const created: string[] = [];
    const resolved = new Map<string, { summary: string; docs: Map<string, string> }>();
    const insert = async (id: string, content: string, rest: RememberOptions): Promise<string> => {
      const trace = await facade.remember(content, { ...rest, id, ...(write.metadata ? { metadata: write.metadata } : {}) });
      if (trace.id === id) created.push(id);
      return trace.id;
    };
    try {
      for (const plan of plans) {
        const where = { type: 'semantic' as const, scope: plan.target.memoryScope, scopeId: plan.target.scopeId };
        const summary = plan.summary.insert
          ? await insert(plan.summary.id, plan.summary.content, {
              ...where,
              tags: write.summaryTags,
              entities: write.summaryEntities,
              importance: summaryImportance,
            })
          : plan.summary.id;
        const docs = new Map<string, string>();
        for (const step of plan.docs) {
          docs.set(
            step.doc.key,
            step.insert
              ? await insert(step.id, step.doc.content, {
                  ...where,
                  tags: step.doc.tags,
                  entities: step.doc.entities,
                  importance: atomicDocImportance,
                })
              : step.id,
          );
        }
        resolved.set(plan.target.key, { summary, docs });
      }
    } catch (error) {
      // Nothing of an upsert that failed before its forgets stays: what it inserted is deleted.
      if (created.length > 0) {
        await facade.deleteTraces(created).catch((cleanupError: unknown) => {
          const why = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          console.warn(
            `[agentos] memory: a rolling-summary upsert that failed did not delete the ${created.length} trace(s) it wrote (${why}); forgetUser deletes them with their scope.`,
          );
        });
      }
      throw error;
    }
    // A trace the upsert resolved to stays, whatever the plan said of it.
    const keep = new Set([...resolved.values()].flatMap((entry) => [entry.summary, ...entry.docs.values()]));
    const forgotten: string[] = [];
    const unforgotten: string[] = [];
    for (const id of forgettable) {
      if (keep.has(id)) continue;
      try {
        await facade.forget(id);
        forgotten.push(id);
      } catch {
        unforgotten.push(id);
      }
    }
    if (unforgotten.length > 0) {
      console.warn(
        `[agentos] memory: a rolling-summary upsert did not forget ${unforgotten.length} older trace(s); the next upsert of their scope forgets them.`,
      );
    }
    return { created, forgotten, unforgotten, resolved };
  };

  /**
   * Takes a recorded upsert back. `forgotten`: its user was forgotten once it committed, so what it inserted and what
   * it forgot are deleted for good. `unrecorded`: what it inserted is deleted, and what it forgot comes back from the
   * snapshots its candidate holds.
   */
  const undoUpsert = async (
    facade: RecordableStandaloneMemory,
    result: RecordedUpsert,
    snapshots: readonly TraceSnapshot[],
    reason: 'forgotten' | 'unrecorded',
  ): Promise<void> => {
    if (result.created.length > 0) await facade.deleteTraces(result.created);
    if (reason === 'forgotten') {
      if (result.forgotten.length > 0) await facade.deleteTraces(result.forgotten);
      return;
    }
    const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    for (const id of result.forgotten) {
      const snapshot = byId.get(id);
      if (snapshot) await facade.restoreTrace(id, snapshot);
    }
  };

  /** An upsert a learning layer records: one memory write, between a pending row and its verdict. */
  const upsertRecorded = async (args: {
    update: RollingSummaryMemoryUpdate;
    targets: MemoryScopeTarget[];
    summaryContent: string;
    summaryTags: string[];
    summaryEntities: string[];
    atomicDocs: AtomicDoc[];
  }): Promise<void> => {
    const { update } = args;
    const record = update.recordSelfChange;
    if (typeof record !== 'function') {
      throw new Error("rolling-summary sink: the turn carries a learning layer's scope ids and no recorder, so nothing was filed.");
    }
    const facade = recordableOf(memory);
    if (!facade) {
      throw new Error(
        'rolling-summary sink: a learning layer records each upsert, and this memory cannot be read back, deleted and restored by trace id (brainId, readTrace, deleteTraces, restoreTrace), so nothing was filed.',
      );
    }
    const plans = args.targets.map((target) => planTarget(target, args.summaryContent, args.atomicDocs));
    await refileGone(facade, plans);
    const inserts = plans.flatMap((plan) => [
      ...(plan.summary.insert ? [plan.summary.id] : []),
      ...plan.docs.filter((step) => step.insert).map((step) => step.id),
    ]);
    // A trace already gone needs no forget; one still live is read first, so a revert can bring it back.
    const snapshots: TraceSnapshot[] = [];
    for (const id of new Set(plans.flatMap((plan) => plan.forget))) {
      const snapshot = await facade.readTrace(id);
      if (snapshot && snapshot.deleted === 0) snapshots.push(snapshot);
    }
    const forgettable = new Set(snapshots.map((snapshot) => snapshot.id));
    if (inserts.length === 0 && forgettable.size === 0) {
      // Nothing changes: no write and no row. A trace a forget left that is gone since is done with.
      for (const plan of plans) recordedTargets.get(plan.target.key)?.stale.clear();
      return;
    }
    const contributorIds = [...new Set(update.contributorIds ?? [])].filter((id) => typeof id === 'string' && id !== '').sort();
    const metadata = contributorIds.length > 0 ? { contributorIds } : undefined;
    const outcome = await record<RecordedUpsert>({
      kind: 'memory_write',
      actor: 'memory:rolling_summary',
      subject: `rolling_summary:${update.conversationId}`,
      before: snapshots.length > 0 ? { traces: snapshots } : null,
      after: { created: inserts, changed: [], deleted: [...forgettable] },
      brainId: facade.brainId,
      apply: () =>
        applyPlan(facade, plans, forgettable, { summaryTags: args.summaryTags, summaryEntities: args.summaryEntities, metadata }),
      undo: (result, reason) => undoUpsert(facade, result, snapshots, reason),
      keptAfter: (result) => ({ created: result.created, changed: [], deleted: result.forgotten }),
    });
    if (outcome.status === 'kept' || outcome.status === 'written') {
      for (const plan of plans) {
        const resolved = outcome.result.resolved.get(plan.target.key);
        if (!resolved) continue;
        recordedTargets.set(plan.target.key, {
          summary: { id: resolved.summary, content: plan.summary.content },
          docs: resolved.docs,
          stale: new Set(outcome.result.unforgotten.filter((id) => plan.forget.includes(id))),
        });
      }
      return;
    }
    // A freeze stops memory's derivations, and a forgotten user's summary is not filed: neither is a failure.
    if (outcome.reason === 'frozen') return;
    if (outcome.reason === 'forgotten') {
      for (const plan of plans) recordedTargets.delete(plan.target.key);
      return;
    }
    throw new Error(`rolling-summary sink: the upsert was not written (${outcome.reason}).`);
  };

  return {
    async upsertRollingSummaryMemory(update: RollingSummaryMemoryUpdate): Promise<void> {
      const policy = update.memoryPolicy ?? DEFAULT_LONG_TERM_MEMORY_POLICY;
      if (!policy.enabled) {
        return;
      }

      const targets = resolveScopeTargets({
        userId: update.userId,
        organizationId: update.organizationId,
        conversationId: update.conversationId,
        personaId: update.personaId,
        policy,
        turnScopes: update.turnScopes,
      });

      if (targets.length === 0) {
        return;
      }

      const summaryTags = unique([
        ...baseTags,
        'rolling_summary',
        ...(Array.isArray(update.summaryJson?.tags)
          ? (update.summaryJson.tags as unknown[])
              .map((tag: unknown): string | null => normalizeText(tag))
              .filter((tag): tag is string => Boolean(tag))
          : []),
      ]);
      const summaryEntities = collectSummaryEntities(update.summaryJson);
      const summaryContent = buildSummaryContent(update);
      const atomicDocs =
        policy.storeAtomicDocs === true
          ? extractAtomicDocs(update.summaryJson, policy.allowedCategories, baseTags)
          : [];

      if (update.turnScopes) {
        const run = recordedQueue.then(() =>
          upsertRecorded({ update, targets, summaryContent, summaryTags, summaryEntities, atomicDocs }),
        );
        recordedQueue = run.catch(() => undefined);
        return run;
      }

      for (const target of targets) {
        const summaryTrace = await memory.remember(summaryContent, {
          type: 'semantic',
          scope: target.memoryScope,
          scopeId: target.scopeId,
          tags: summaryTags,
          entities: summaryEntities,
          importance: summaryImportance,
        } satisfies RememberOptions);

        const previousSummaryTraceId = summaryTraceIds.get(target.key);
        if (
          previousSummaryTraceId &&
          previousSummaryTraceId !== summaryTrace.id
        ) {
          await memory.forget(previousSummaryTraceId);
        }
        summaryTraceIds.set(target.key, summaryTrace.id);

        await upsertDocsForScope(target, atomicDocs);
      }
    },
  };
}
