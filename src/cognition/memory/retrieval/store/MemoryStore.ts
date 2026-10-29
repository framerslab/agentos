/**
 * @fileoverview Unified memory store wrapping IVectorStore + IKnowledgeGraph.
 *
 * Handles:
 * - Embedding and storing memory traces in vector store
 * - Recording as episodic memories in knowledge graph
 * - Querying with decay-aware scoring
 * - Access tracking for spaced repetition
 *
 * @module agentos/memory/store/MemoryStore
 */

import type {
  IVectorStore,
  VectorDocument,
  QueryOptions,
  MetadataFilter,
} from '../../../../core/vector-store/IVectorStore.js';
import type { IEmbeddingManager } from '../../../../core/embeddings/IEmbeddingManager.js';
import type { IKnowledgeGraph } from '../graph/knowledge/IKnowledgeGraph.js';
import type {
  MemoryTrace,
  MemoryType,
  MemoryScope,
  CognitiveRetrievalOptions,
  ScoredMemoryTrace,
  PartiallyRetrievedTrace,
} from '../../core/types.js';
import type { PADState, DecayConfig } from '../../core/config.js';
import { DEFAULT_DECAY_CONFIG } from '../../core/config.js';
import {
  computeCurrentStrength,
  updateOnRetrieval,
  type RetrievalUpdateResult,
} from '../../core/decay/DecayModel.js';
import {
  scoreAndRankTraces,
  detectPartiallyRetrieved,
  DEFAULT_SCORING_WEIGHTS,
  type CandidateTrace,
  type ScoringContext,
  type ScoringWeights,
} from '../../core/decay/RetrievalPriorityScorer.js';
import {
  extractEntities,
  slugifyEntityId,
} from '../graph/extraction/index.js';
import { spreadActivation } from '../graph/SpreadingActivation.js';
import {
  readPersistedDecayFields,
  withPersistedDecayState,
  type PersistedDecayState,
} from './tracePersistence.js';

// ---------------------------------------------------------------------------
// Embedding guard (CR4)
// ---------------------------------------------------------------------------

/**
 * A usable embedding is a non-empty numeric vector.
 *
 * The embedding manager returns `[]` for any text it fails to embed (a
 * per-text fallback rather than a thrown error). Persisting or querying with
 * such a zero-length vector silently corrupts recall: the vector-store
 * collection dimension collapses to 0, and cosine similarity against an empty
 * vector degenerates to meaningless scores. MemoryStore therefore refuses an
 * unusable embedding everywhere it touches the vector store instead of writing
 * or searching with garbage.
 */
export function isUsableEmbedding(embedding: number[] | undefined): embedding is number[] {
  return Array.isArray(embedding) && embedding.length > 0;
}

/** Whether a value can be the size of a vector: a positive integer. */
function isVectorSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MemoryStoreConfig {
  vectorStore: IVectorStore;
  embeddingManager: IEmbeddingManager;
  knowledgeGraph: IKnowledgeGraph;
  /** Collection name prefix. @default 'cogmem' */
  collectionPrefix: string;
  /**
   * The size of the vectors in this store's collections. Unset, a collection is created with the size of the first
   * embedding filed into it, and a read that matches no text (`getByScope()` with no trace of the scope cached)
   * queries with the embedding model's size: the embedding manager's `getEmbeddingDimension()`, else the length of
   * one probe embedding.
   */
  embeddingDimension?: number;
  decayConfig?: DecayConfig;
  /** Optional cognitive mechanisms engine for retrieval-time hooks. */
  mechanismsEngine?: import('../../mechanisms/CognitiveMechanismsEngine.js').CognitiveMechanismsEngine;
  /** Optional mood provider for reconsolidation drift during recordAccess. */
  moodProvider?: () => PADState;
  /**
   * Step 13: enable graph activation. When true, `store` upserts entity
   * nodes and `co_occurs` edges at ingest (from `trace.entities`), and
   * `query` seeds Anderson spreading activation from query-extracted
   * entities to compute the per-candidate `graphActivation` score
   * (weight 0.10 in `RetrievalPriorityScorer`). Default: false, which
   * preserves the legacy `graphActivation: 0` behavior for all
   * candidates.
   */
  enableGraphActivation?: boolean;
  /**
   * Keeps a trace's stability, access count, reinforcement interval and next
   * reinforcement time across a restart. With a Brain attached, `store()` and
   * every access write them into the row's metadata JSON under `decay` (the
   * object the `Memory` facade, its consolidation and the memory tools read
   * and write; the row's other keys are kept), and a load reads them back.
   * The vector metadata carries the interval and the next reinforcement time
   * as well, so a store with no Brain restores them with a trace; a document
   * that holds no interval restores with one hour. Default `true`.
   * `false` writes and loads as before, for one release of before-and-after
   * measurement: an access writes the row's `last_accessed`,
   * `retrieval_count` and `strength` alone, and a load gives the access count
   * 0, the interval one hour and the stability as stored; with no Brain, a
   * trace restored from the vector store has no next reinforcement time and
   * the interval 0 through `getByScope()` or one hour through `query()`.
   */
  persistAccessState?: boolean;
}

/** The reinforcement interval a trace loads with when none was persisted: one hour. */
const DEFAULT_REINFORCEMENT_INTERVAL_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectionName(prefix: string, scope: MemoryScope, scopeId: string): string {
  return `${prefix}_${scope}_${scopeId}`;
}

function scopeKey(scope: MemoryScope, scopeId: string): string {
  return `${scope}:${scopeId}`;
}

/**
 * A trace's metadata in the vector store.
 *
 * @param trace - The trace.
 * @param accessState - Whether the store persists access state (`persistAccessState`). With it,
 *   the metadata also carries the reinforcement interval and the next reinforcement time, so a
 *   store with no Brain restores the trace's schedule with the trace.
 */
function traceToMetadata(trace: MemoryTrace, accessState: boolean): Record<string, any> {
  return {
    ...(accessState ? reinforcementSchedule(trace) : {}),
    type: trace.type,
    scope: trace.scope,
    scopeId: trace.scopeId,
    encodingStrength: trace.encodingStrength,
    stability: trace.stability,
    retrievalCount: trace.retrievalCount,
    lastAccessedAt: trace.lastAccessedAt,
    accessCount: trace.accessCount,
    emotionalValence: trace.emotionalContext.valence,
    emotionalArousal: trace.emotionalContext.arousal,
    emotionalIntensity: trace.emotionalContext.intensity,
    confidence: trace.provenance.confidence,
    sourceType: trace.provenance.sourceType,
    importance: trace.provenance.confidence, // use confidence as proxy
    // Provenance audit fields. Persisted into the vector store metadata so
    // verification events and contradiction records survive process restarts;
    // without these, every reload of a trace would reset the audit trail.
    verificationCount: trace.provenance.verificationCount ?? 0,
    lastVerifiedAt: trace.provenance.lastVerifiedAt,
    contradictedBy: trace.provenance.contradictedBy,
    // Trust policy. Persisted as a JSON-serialised string because the
    // vector-store metadata layer cannot represent nested objects with
    // mixed types portably across backends (Pinecone, Qdrant, Postgres).
    // Read back via metadataToTracePartial.
    policyJson: trace.policy ? JSON.stringify(trace.policy) : undefined,
    createdAt: trace.createdAt,
    isActive: trace.isActive ? 1 : 0,
    tags: trace.tags.join(','),
    entities: trace.entities.join(','),
  };
}

/** Parse a JSON string and return `undefined` on any failure. */
function safeParseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Whether a parsed JSON value is an object whose keys a merge can keep. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The reinforcement schedule of a trace or of a vector document's metadata: the interval and the
 * next reinforcement time, each only where it is a finite number.
 */
function reinforcementSchedule(
  source: { reinforcementInterval?: unknown; nextReinforcementAt?: unknown },
): Partial<Pick<MemoryTrace, 'reinforcementInterval' | 'nextReinforcementAt'>> {
  const { reinforcementInterval, nextReinforcementAt } = source;
  return {
    ...(typeof reinforcementInterval === 'number' && Number.isFinite(reinforcementInterval)
      ? { reinforcementInterval }
      : {}),
    ...(typeof nextReinforcementAt === 'number' && Number.isFinite(nextReinforcementAt)
      ? { nextReinforcementAt }
      : {}),
  };
}

/** A trace's decay state, as a Brain row's `metadata.decay` holds it. */
function decayStateOf(trace: MemoryTrace): PersistedDecayState {
  return {
    stability: trace.stability,
    accessCount: trace.accessCount,
    reinforcementInterval: trace.reinforcementInterval,
    ...(typeof trace.nextReinforcementAt === 'number'
      ? { nextReinforcementAt: trace.nextReinforcementAt }
      : {}),
  };
}

/**
 * The part of a trace a vector document's metadata holds.
 *
 * @param metadata - The document's metadata.
 * @param accessState - Whether the store persists access state (`persistAccessState`). With it,
 *   the reinforcement interval and the next reinforcement time come back too, where the metadata
 *   holds them.
 */
function metadataToTracePartial(metadata: Record<string, any>, accessState: boolean): Partial<MemoryTrace> {
  return {
    ...(accessState ? reinforcementSchedule(metadata) : {}),
    type: metadata.type as MemoryType,
    scope: metadata.scope as MemoryScope,
    scopeId: metadata.scopeId as string,
    encodingStrength: metadata.encodingStrength as number,
    stability: metadata.stability as number,
    retrievalCount: metadata.retrievalCount as number,
    lastAccessedAt: metadata.lastAccessedAt as number,
    accessCount: metadata.accessCount as number,
    emotionalContext: {
      valence: metadata.emotionalValence as number,
      arousal: metadata.emotionalArousal as number,
      dominance: 0,
      intensity: metadata.emotionalIntensity as number,
      gmiMood: '',
    },
    provenance: {
      sourceType: metadata.sourceType as any,
      confidence: metadata.confidence as number,
      verificationCount:
        typeof metadata.verificationCount === 'number' ? metadata.verificationCount : 0,
      lastVerifiedAt:
        typeof metadata.lastVerifiedAt === 'number' ? metadata.lastVerifiedAt : undefined,
      contradictedBy: Array.isArray(metadata.contradictedBy)
        ? (metadata.contradictedBy as string[])
        : undefined,
      sourceTimestamp: metadata.createdAt as number,
    },
    policy: typeof metadata.policyJson === 'string'
      ? safeParseJson<import('../../core/types.js').MemoryTrustPolicy>(metadata.policyJson)
      : undefined,
    createdAt: metadata.createdAt as number,
    isActive: metadata.isActive === 1,
    tags: typeof metadata.tags === 'string' ? metadata.tags.split(',').filter(Boolean) : [],
    entities:
      typeof metadata.entities === 'string' ? metadata.entities.split(',').filter(Boolean) : [],
  };
}

/** A row of the Brain's durable `memory_traces` table. */
interface MemoryTraceRow {
  id: string;
  type: string;
  scope: string;
  content: string;
  /** BLOB (little-endian Float32 bytes), or null for legacy rows. */
  embedding: unknown;
  strength: number;
  created_at: number;
  last_accessed: number;
  retrieval_count: number;
  tags: string | null;
  emotions: string | null;
  metadata: string | null;
  /** Present only when a query selects it (softDelete's cleanup lookup). */
  deleted?: number;
}

/**
 * Serialise an embedding to the Brain's documented BLOB format (raw
 * little-endian Float32 bytes). Symmetric with {@link blobToEmbedding}.
 */
function embeddingToBlob(embedding: number[]): Buffer {
  const f32 = Float32Array.from(embedding);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * Decode a Brain `embedding` BLOB back into a number[]. Returns null for an
 * absent/empty/malformed blob (e.g. a legacy row persisted before durable
 * embeddings, which stored null). Accepts the Buffer/Uint8Array shape every
 * SQL backend returns for a BLOB/bytea column.
 */
function blobToEmbedding(blob: unknown): number[] | null {
  if (blob == null) return null;
  let bytes: Uint8Array | null = null;
  if (blob instanceof Uint8Array) bytes = blob; // Buffer extends Uint8Array
  else if (blob instanceof ArrayBuffer) bytes = new Uint8Array(blob);
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null;
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
}

type TraceOperationKind = 'normal' | 'delete';

interface TraceOperationState {
  tail: Promise<void>;
  pending: number;
  pendingDeletes: number;
}

interface TraceOperationContext {
  blockedByDelete: boolean;
  isDeletePending: () => boolean;
}

interface StoreCoordinationTarget {
  isDeleted: (traceId: string) => boolean;
  isDeleteAuthoritative: (traceId: string) => boolean;
  markDeleted: (traceId: string, authoritative: boolean) => void;
  releaseDeleteAuthority: (traceId: string) => void;
  evictDeleted: (traceId: string, fallback?: MemoryTrace) => Promise<boolean>;
  revive: (trace: MemoryTrace, embedding: number[], source: boolean) => Promise<boolean>;
}

interface ReferenceLike<T extends object> {
  deref(): T | undefined;
}

interface FinalizerLike<T> {
  register(target: object, heldValue: T, unregisterToken?: object): void;
  unregister(unregisterToken: object): boolean;
}

interface StoreRegistration {
  namespace: object;
  reference: ReferenceLike<StoreCoordinationTarget>;
}

interface NamespaceCoordinator {
  deleteEpoch: number;
  pendingOperations: number;
  operations: Map<string, TraceOperationState>;
  stores: Set<ReferenceLike<StoreCoordinationTarget>>;
}

const WeakRefImplementation =
  typeof WeakRef === 'function' ? WeakRef : undefined;
const FinalizationRegistryImplementation =
  typeof FinalizationRegistry === 'function' ? FinalizationRegistry : undefined;

function createReference<T extends object>(target: T): ReferenceLike<T> {
  if (WeakRefImplementation) return new WeakRefImplementation(target);
  // Compatibility fallback for runtimes without WeakRef. MemoryStore.dispose
  // deterministically removes the strong registration.
  return { deref: () => target };
}

const namespaceCoordinators = new WeakMap<object, NamespaceCoordinator>();
const vectorStoreNamespaces = new WeakMap<object, Map<string, object>>();

function getNamespaceCoordinator(namespace: object): NamespaceCoordinator {
  let coordinator = namespaceCoordinators.get(namespace);
  if (!coordinator) {
    coordinator = {
      deleteEpoch: 0,
      pendingOperations: 0,
      operations: new Map(),
      stores: new Set(),
    };
    namespaceCoordinators.set(namespace, coordinator);
  }
  return coordinator;
}

function compactNamespaceCoordinator(
  namespace: object,
  coordinator: NamespaceCoordinator,
): void {
  for (const reference of coordinator.stores) {
    if (!reference.deref()) coordinator.stores.delete(reference);
  }
  if (
    coordinator.stores.size === 0 &&
    coordinator.pendingOperations === 0 &&
    coordinator.operations.size === 0 &&
    namespaceCoordinators.get(namespace) === coordinator
  ) {
    namespaceCoordinators.delete(namespace);
  }
}

const storeFinalizer: FinalizerLike<StoreRegistration> | null =
  FinalizationRegistryImplementation
    ? new FinalizationRegistryImplementation<StoreRegistration>((registration) => {
        const coordinator = namespaceCoordinators.get(registration.namespace);
        if (!coordinator) return;
        coordinator.stores.delete(registration.reference);
        compactNamespaceCoordinator(registration.namespace, coordinator);
      })
    : null;

function registerCoordinationTarget(
  namespace: object,
  target: StoreCoordinationTarget,
): StoreRegistration {
  const coordinator = getNamespaceCoordinator(namespace);
  const reference = createReference(target);
  const registration = { namespace, reference };
  coordinator.stores.add(reference);
  storeFinalizer?.register(target, registration, reference);
  return registration;
}

function unregisterCoordinationTarget(registration: StoreRegistration): void {
  storeFinalizer?.unregister(registration.reference);
  const coordinator = namespaceCoordinators.get(registration.namespace);
  if (!coordinator) return;
  coordinator.stores.delete(registration.reference);
  compactNamespaceCoordinator(registration.namespace, coordinator);
}

function vectorStoreNamespace(vectorStore: IVectorStore, collectionPrefix: string): object {
  let namespaces = vectorStoreNamespaces.get(vectorStore as object);
  if (!namespaces) {
    namespaces = new Map();
    vectorStoreNamespaces.set(vectorStore as object, namespaces);
  }
  let namespace = namespaces.get(collectionPrefix);
  if (!namespace) {
    namespace = {};
    namespaces.set(collectionPrefix, namespace);
  }
  return namespace;
}

function markTraceDeleted(
  namespace: object,
  traceId: string,
  authoritative = true,
): void {
  const coordinator = getNamespaceCoordinator(namespace);
  for (const reference of coordinator.stores) {
    const target = reference.deref();
    if (target) target.markDeleted(traceId, authoritative);
    else coordinator.stores.delete(reference);
  }
}

function releaseDeleteAuthority(namespace: object, traceId: string): void {
  const coordinator = getNamespaceCoordinator(namespace);
  for (const reference of coordinator.stores) {
    const target = reference.deref();
    if (target) target.releaseDeleteAuthority(traceId);
    else coordinator.stores.delete(reference);
  }
}

async function evictDeletedTrace(
  namespace: object,
  traceId: string,
  fallback?: MemoryTrace,
  requiredTarget?: StoreCoordinationTarget,
): Promise<boolean> {
  const coordinator = getNamespaceCoordinator(namespace);
  const targets = new Set<StoreCoordinationTarget>();
  for (const reference of coordinator.stores) {
    const target = reference.deref();
    if (target) targets.add(target);
    else coordinator.stores.delete(reference);
  }
  if (requiredTarget) targets.add(requiredTarget);
  const outcomes = await Promise.all(
    [...targets].map((target) => target.evictDeleted(traceId, fallback)),
  );
  return outcomes.every(Boolean);
}

function hasDeletedTrace(namespace: object, traceId: string): boolean {
  const coordinator = getNamespaceCoordinator(namespace);
  for (const reference of coordinator.stores) {
    const target = reference.deref();
    if (target?.isDeleted(traceId)) return true;
    if (!target) coordinator.stores.delete(reference);
  }
  return false;
}

function hasAuthoritativeDelete(namespace: object, traceId: string): boolean {
  const coordinator = getNamespaceCoordinator(namespace);
  for (const reference of coordinator.stores) {
    const target = reference.deref();
    if (target?.isDeleteAuthoritative(traceId)) return true;
    if (!target) coordinator.stores.delete(reference);
  }
  return false;
}

async function reviveTrace(
  namespace: object,
  trace: MemoryTrace,
  embedding: number[],
  source: StoreCoordinationTarget,
  sourceAlreadyWritten = true,
): Promise<boolean> {
  const coordinator = getNamespaceCoordinator(namespace);
  const targets: StoreCoordinationTarget[] = [];
  for (const reference of coordinator.stores) {
    const target = reference.deref();
    if (target) targets.push(target);
    else coordinator.stores.delete(reference);
  }
  // Fan-out is intentionally limited to deletion-to-active transitions.
  // General active-update cache coherence has different latency and provider
  // cost semantics and remains outside this deletion-safety coordinator.
  if (!targets.some((target) => target.isDeleted(trace.id))) {
    return source.revive(trace, embedding, sourceAlreadyWritten);
  }
  const outcomes = await Promise.all(
    targets.map((target) =>
      target.revive(
        trace,
        embedding,
        sourceAlreadyWritten && target === source,
      ),
    ),
  );
  return outcomes.every(Boolean);
}

function getDeleteEpoch(namespace: object): number {
  return getNamespaceCoordinator(namespace).deleteEpoch;
}

function isTraceDeletePending(namespace: object, traceId: string): boolean {
  const coordinator = namespaceCoordinators.get(namespace);
  return (coordinator?.operations.get(traceId)?.pendingDeletes ?? 0) > 0;
}

async function withTraceOperation<T>(
  namespace: object,
  traceId: string,
  kind: TraceOperationKind,
  operation: (context: TraceOperationContext) => Promise<T>,
): Promise<T> {
  const coordinator = getNamespaceCoordinator(namespace);
  let state = coordinator.operations.get(traceId);
  if (!state) {
    state = { tail: Promise.resolve(), pending: 0, pendingDeletes: 0 };
    coordinator.operations.set(traceId, state);
  }
  const operationState = state;
  const blockedByDelete = kind === 'normal' && operationState.pendingDeletes > 0;

  if (kind === 'delete') {
    operationState.pendingDeletes += 1;
    coordinator.deleteEpoch += 1;
    markTraceDeleted(namespace, traceId);
  }

  const previous = operationState.tail;
  let release: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    release = resolve;
  });
  operationState.tail = previous.then(() => completion, () => completion);
  operationState.pending += 1;
  coordinator.pendingOperations += 1;

  await previous.catch(() => undefined);
  try {
    return await operation({
      blockedByDelete,
      isDeletePending: () => kind === 'normal' && operationState.pendingDeletes > 0,
    });
  } finally {
    if (kind === 'delete') operationState.pendingDeletes -= 1;
    operationState.pending -= 1;
    coordinator.pendingOperations -= 1;
    release?.();
    if (
      operationState.pending === 0 &&
      coordinator.operations.get(traceId) === operationState
    ) {
      coordinator.operations.delete(traceId);
    }
    compactNamespaceCoordinator(namespace, coordinator);
  }
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

/**
 * Sync one durable trace row into the Brain's full-text index.
 *
 * On SQLite, `memory_traces_fts` is an external-content index with no
 * triggers, so it only covers rows a writer syncs explicitly (the Memory
 * facade and MemoryAddTool do). Without this, every trace written through
 * `MemoryStore.store()` (the whole cognitive pipeline) was invisible to
 * lexical recall and MemorySearchTool. The rowid lookup is scoped by
 * `(brain_id, id)`: several brains may share one database, and a trace id
 * alone can match another brain's row.
 *
 * On Postgres the index is the row's own `_tsv` column, which the upsert in
 * `store()` writes as null. The sync fills it from the content and tags the
 * row holds, through the brain's rebuild statement narrowed to this brain's
 * row: the adapter's `syncInsert` there can only target `WHERE id = $1`,
 * which is not brain-scoped on the table every brain shares.
 *
 * The index is secondary: a sync failure never fails the durable write. On
 * SQLite, any row the index misses, and the stale entry a revival leaves
 * behind under its old rowid (see `moveTraceToFreshRowid`), is repaired the
 * next time the Brain opens (see `Brain._repairFullTextIndex`); on Postgres,
 * every open fills a `_tsv` left null. The read, the write, the move and the
 * sync are separate statements, so two processes storing the SAME trace id
 * at once could in principle leave one revision's tokens under the other's
 * row; that race needs same-id writes across processes and is not caught by
 * the open-time check, which compares row sets rather than content.
 */
async function syncTraceFullTextIndex(
  brain: import('./Brain.js').Brain,
  trace: MemoryTrace,
): Promise<void> {
  try {
    if (brain.features.dialect.name === 'postgres') {
      const rebuild = brain.fullTextRebuild();
      await brain.run(`${rebuild.sql} AND id = ?`, [...rebuild.params, trace.id]);
      return;
    }
    await brain.run(
      brain.features.fts.syncInsert(
        'memory_traces_fts',
        '(SELECT rowid FROM memory_traces WHERE brain_id = ? AND id = ?)',
        ['content', 'tags'],
      ),
      [brain.brainId, trace.id, trace.content, JSON.stringify(trace.tags)],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A database the index was never created in has nothing to sync.
    if (fullTextIndexMissing(message)) {
      return;
    }
    console.warn(`[MemoryStore] full-text index sync failed for trace ${trace.id}: ${message}`);
  }
}

/**
 * Whether a full-text statement failed because the database has no index.
 * sql.js and the IndexedDB adapter get an FTS4 index (sql-storage-adapter
 * 0.7.5 and later), every other SQLite adapter FTS5; a SQLite build without
 * the module has none.
 */
function fullTextIndexMissing(message: string): boolean {
  return message.includes('no such module: fts5') || message.includes('no such table: memory_traces_fts');
}

/**
 * Whether the brain holds a row for `traceId`, read before `store()` writes
 * it. Only a row the brain held is rewritten in place, under the rowid its
 * index entry names, and has to move (see `moveTraceToFreshRowid`); a new row
 * gets a fresh rowid from its insert. A read takes no write lock, so a new
 * trace's store writes nothing it does not need. A failed read counts as
 * held: moving a new row is harmless, and leaving a revived one in place
 * would keep its old words in the index.
 */
async function traceRowHeld(
  brain: import('./Brain.js').Brain,
  traceId: string,
): Promise<boolean> {
  try {
    const row = await brain.get<{ held: number }>(
      'SELECT 1 AS held FROM memory_traces WHERE brain_id = ? AND id = ?',
      [brain.brainId, traceId],
    );
    return row !== null && row !== undefined;
  } catch {
    return true;
  }
}

/**
 * Move a revived trace's row to a fresh rowid once its rewrite has committed.
 *
 * A revival stores new content under a trace id the brain already holds. The
 * dialect's upsert rewrites that row in place and keeps its rowid, so the
 * entry the full-text index holds under the rowid would go on matching the
 * old words: the external-content index holds no text of its own. Moved, the
 * row leaves that entry pointing at no row, which a search's join drops, and
 * the next open's repair finds the row sets apart and rebuilds; the sync after
 * the move indexes the row under its new rowid. Nothing else keys on a
 * trace's rowid: the HNSW sidecar maps its labels to trace ids.
 *
 * After the write, not before it: a failed write then leaves the row and its
 * index entry as they were, and the trace stays found by the words it holds.
 *
 * A move, not a delete from the index: an index delete reads the text to
 * forget from the content row, and a row rewritten in place without a rebuild
 * would hand it the wrong text.
 *
 * SQLite only, and only for a row the brain held before the write (see
 * `traceRowHeld`). Throws when the move fails; `indexStoredTrace` then
 * rebuilds the index instead of syncing the row.
 */
async function moveTraceToFreshRowid(
  brain: import('./Brain.js').Brain,
  traceId: string,
): Promise<void> {
  await brain.run(
    `UPDATE memory_traces SET rowid = (SELECT max(rowid) + 1 FROM memory_traces)
      WHERE brain_id = ? AND id = ?`,
    [brain.brainId, traceId],
  );
}

/**
 * Bring the full-text index in step with the row `store()` has just written:
 * a revived row moves to a fresh rowid (see `moveTraceToFreshRowid`), then
 * the row is synced (see `syncTraceFullTextIndex`).
 *
 * When the move fails (another writer holds the database: SQLITE_BUSY), the
 * row was rewritten in place under the rowid whose entry holds its old words,
 * and a sync would add the new words beside them. The open-time check
 * compares row sets, not content, so no open would clear the old ones. The
 * sync is skipped and the index rebuilt from the content table instead
 * (`Brain.fullTextRebuild`), and one line names the path taken. When the
 * rebuild fails as well, the line says so: the old words then match until a
 * later rebuild.
 *
 * @param revived - Whether the brain held the row before the write (see `traceRowHeld`).
 */
async function indexStoredTrace(
  brain: import('./Brain.js').Brain,
  trace: MemoryTrace,
  revived: boolean,
): Promise<void> {
  if (revived) {
    try {
      await moveTraceToFreshRowid(brain, trace.id);
    } catch (moveError) {
      const reason = moveError instanceof Error ? moveError.message : String(moveError);
      let outcome = 'rebuilt the full-text index from the traces instead of syncing the row';
      try {
        const rebuild = brain.fullTextRebuild();
        await brain.run(rebuild.sql, rebuild.params);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcome = fullTextIndexMissing(message)
          ? 'the database has no full-text index to rebuild'
          : `the full-text index rebuild failed too, so its old words match until a later rebuild: ${message}`;
      }
      console.warn(`[MemoryStore] trace ${trace.id} kept its rowid through its rewrite (${reason}); ${outcome}`);
      return;
    }
  }
  await syncTraceFullTextIndex(brain, trace);
}

export class MemoryStore {
  /** Max traces hydrated from the Brain per instance (most-recent first); bounds the per-request load. */
  private static readonly HYDRATION_LIMIT = 1000;
  private config: MemoryStoreConfig;
  private decay: DecayConfig;
  /** Cache of full MemoryTrace objects by ID. */
  private traceCache: Map<string, MemoryTrace> = new Map();
  /** Cache embeddings by trace ID to avoid re-generating on metadata-only updates. */
  private embeddingCache: Map<string, number[]> = new Map();
  /** Process-local deletion barrier for asynchronous vector refreshes and hydration. */
  private tombstonedTraceIds: Set<string> = new Set();
  /** Tombstones whose local delete has not been durably confirmed. */
  private authoritativeTombstoneIds: Set<string> = new Set();
  /** Track concrete scopes we have seen, so retrieval never falls back to a fake wildcard scope. */
  private knownScopes: Map<string, { scope: MemoryScope; scopeId: string }> = new Map();
  /** Optional cognitive mechanisms engine for retrieval-time hooks. */
  private mechanismsEngine?: import('../../mechanisms/CognitiveMechanismsEngine.js').CognitiveMechanismsEngine;
  /**
   * Optional Brain for durable write-through persistence.
   * When set, store/softDelete/recordAccess also write to the brain's SQL tables.
   * The in-memory vector index remains the hot read path (fast); the brain is
   * the durable backing store that survives process restarts.
   */
  private brain: import('./Brain.js').Brain | null = null;
  /**
   * Single-flight hydration from the attached Brain: null until the first
   * reader arrives, then the one shared load every later (and concurrent)
   * reader awaits. See {@link MemoryStore.ensureHydratedFromBrain}.
   */
  private brainHydration: Promise<void> | null = null;
  /** Namespace shared by stores that address the same backing resource. */
  private coordinationNamespace: object;
  /** Lifecycle-registered callbacks used to invalidate sibling store caches. */
  private readonly coordinationTarget: StoreCoordinationTarget;
  private coordinationRegistration: StoreRegistration | null;
  private disposed = false;
  /** Brain attachment is immutable once any memory operation has started. */
  private brainAttachmentLocked = false;
  /**
   * The embedding model's vector size, once {@link resolveVectorSize} has measured it; unset until then, and again
   * after a measurement that failed.
   */
  private measuredVectorSize: Promise<number | undefined> | undefined;

  constructor(config: MemoryStoreConfig) {
    this.config = config;
    this.decay = config.decayConfig ?? DEFAULT_DECAY_CONFIG;
    this.mechanismsEngine = config.mechanismsEngine;
    this.coordinationTarget = {
      isDeleted: (traceId) => this.tombstonedTraceIds.has(traceId),
      isDeleteAuthoritative: (traceId) => this.authoritativeTombstoneIds.has(traceId),
      markDeleted: (traceId, authoritative) =>
        this.markDeletedLocally(traceId, authoritative),
      releaseDeleteAuthority: (traceId) => this.authoritativeTombstoneIds.delete(traceId),
      evictDeleted: (traceId, fallback) => this.evictDeletedLocally(traceId, fallback),
      revive: (trace, embedding, source) => this.reviveLocally(trace, embedding, source),
    };
    this.coordinationNamespace = vectorStoreNamespace(
      config.vectorStore,
      config.collectionPrefix,
    );
    this.coordinationRegistration = registerCoordinationTarget(
      this.coordinationNamespace,
      this.coordinationTarget,
    );
  }

  /** Whether access state is kept across restarts ({@link MemoryStoreConfig.persistAccessState}). */
  private get persistsAccessState(): boolean {
    return this.config.persistAccessState !== false;
  }

  /**
   * Attach a Brain for durable write-through persistence.
   * Once attached, all store/softDelete/recordAccess operations also
   * write to the brain's `memory_traces` table. Initial attachment must happen
   * before any memory operation; after that, only another handle with the same
   * coordination token can be supplied.
   *
   * @param brain - Brain instance (already initialized with schema)
   * @throws When attachment is late or would switch backing resources.
   */
  setBrain(brain: import('./Brain.js').Brain): void {
    this.assertNotDisposed();
    if (this.brain) {
      if (this.brain.coordinationToken !== brain.coordinationToken) {
        throw new Error(
          'MemoryStore.setBrain: cannot switch to a different backing resource',
        );
      }
      this.brain = brain;
      return;
    }
    if (this.brainAttachmentLocked) {
      throw new Error(
        'MemoryStore.setBrain: attach a Brain before starting memory operations',
      );
    }

    const previousRegistration = this.coordinationRegistration;
    this.brain = brain;
    this.coordinationNamespace = brain.coordinationToken;
    this.coordinationRegistration = registerCoordinationTarget(
      this.coordinationNamespace,
      this.coordinationTarget,
    );
    if (previousRegistration) {
      unregisterCoordinationTarget(previousRegistration);
    }
  }

  /**
   * Access the attached Brain for export/import operations.
   * Returns null when no brain is attached (in-memory only mode).
   */
  getBrain(): import('./Brain.js').Brain | null {
    return this.brain;
  }

  /**
   * Remove this store from sibling coordination. Recall and mutation methods
   * reject after disposal; diagnostic cache accessors remain available.
   */
  dispose(): void {
    if (this.disposed) return;
    if (this.coordinationRegistration) {
      unregisterCoordinationTarget(this.coordinationRegistration);
      this.coordinationRegistration = null;
    }
    this.disposed = true;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('MemoryStore: operation attempted after dispose');
    }
  }

  private beginOperation(): void {
    this.assertNotDisposed();
    this.brainAttachmentLocked = true;
  }

  private markDeletedLocally(traceId: string, authoritative = true): void {
    // Passive sibling coordination is still resource-specific state. Once it
    // arrives, this store cannot safely migrate that state to another Brain.
    this.brainAttachmentLocked = true;
    this.tombstonedTraceIds.add(traceId);
    if (authoritative) this.authoritativeTombstoneIds.add(traceId);
    this.embeddingCache.delete(traceId);
    const trace = this.traceCache.get(traceId);
    if (trace) {
      trace.isActive = false;
      trace.updatedAt = Date.now();
    }
  }

  private async evictDeletedLocally(
    traceId: string,
    fallback?: MemoryTrace,
  ): Promise<boolean> {
    this.markDeletedLocally(traceId, false);
    const trace = this.traceCache.get(traceId) ?? fallback;
    this.embeddingCache.delete(traceId);
    if (!trace) return true;

    const collection = collectionName(
      this.config.collectionPrefix,
      trace.scope,
      trace.scopeId,
    );
    try {
      const result = await this.config.vectorStore.delete(collection, [traceId]);
      return (result.failedCount ?? 0) === 0;
    } catch {
      return false;
    }
  }

  private async reviveLocally(
    trace: MemoryTrace,
    embedding: number[],
    source: boolean,
  ): Promise<boolean> {
    this.brainAttachmentLocked = true;
    if (source) {
      const cached = this.traceCache.get(trace.id);
      if (cached) cached.isActive = true;
      this.tombstonedTraceIds.delete(trace.id);
      this.authoritativeTombstoneIds.delete(trace.id);
      return true;
    }

    const collection = collectionName(
      this.config.collectionPrefix,
      trace.scope,
      trace.scopeId,
    );
    try {
      const result = await this.config.vectorStore.upsert(collection, [{
        id: trace.id,
        textContent: trace.content,
        embedding,
        metadata: traceToMetadata(trace, this.persistsAccessState),
      }]);
      if ((result?.failedCount ?? 0) > 0) return false;
      const revivedTrace: MemoryTrace = {
        ...trace,
        entities: [...trace.entities],
        tags: [...trace.tags],
        provenance: { ...trace.provenance },
        emotionalContext: { ...trace.emotionalContext },
        associatedTraceIds: [...trace.associatedTraceIds],
      };
      this.traceCache.set(trace.id, revivedTrace);
      this.embeddingCache.set(trace.id, [...embedding]);
      this.registerScope(trace.scope, trace.scopeId);
      this.tombstonedTraceIds.delete(trace.id);
      this.authoritativeTombstoneIds.delete(trace.id);
      return true;
    } catch {
      // Keep the sibling tombstone when its vector index cannot be revived.
      return false;
    }
  }

  private async getDurableTraceRows(
    traceIds: string[],
    brain: import('./Brain.js').Brain | null = this.brain,
  ): Promise<{ ok: boolean; rows: Map<string, MemoryTraceRow> }> {
    const rowsById = new Map<string, MemoryTraceRow>();
    if (!brain || traceIds.length === 0) return { ok: true, rows: rowsById };

    try {
      const uniqueIds = [...new Set(traceIds)];
      for (let offset = 0; offset < uniqueIds.length; offset += 400) {
        const chunk = uniqueIds.slice(offset, offset + 400);
        const placeholders = chunk.map(() => '?').join(', ');
        const rows = await brain.all<MemoryTraceRow>(
          `SELECT id, type, scope, content, embedding, strength, created_at,
                  last_accessed, retrieval_count, tags, emotions, metadata, deleted
             FROM memory_traces
            WHERE brain_id = ? AND id IN (${placeholders})`,
          [brain.brainId, ...chunk],
        );
        for (const row of rows) rowsById.set(row.id, row);
      }
      return { ok: true, rows: rowsById };
    } catch {
      return { ok: false, rows: new Map() };
    }
  }

  private async reconcileDurableTraceStates(
    traceIds: string[],
    namespace: object,
    brain: import('./Brain.js').Brain | null,
  ): Promise<boolean> {
    if (!brain || traceIds.length === 0) return true;

    const initial = await this.getDurableTraceRows(traceIds, brain);
    if (!initial.ok) return false;

    let validationAvailable = true;
    const stateChanges = new Set<string>();
    for (const traceId of new Set(traceIds)) {
      const row = initial.rows.get(traceId);
      if (!row || row.deleted === 1 || hasDeletedTrace(namespace, traceId)) {
        stateChanges.add(traceId);
      }
    }
    await Promise.all(
      [...stateChanges].map((traceId) =>
        withTraceOperation(
          namespace,
          traceId,
          'normal',
          async ({ blockedByDelete }) => {
            if (blockedByDelete) return;
            const confirmed = await this.getDurableTraceRows([traceId], brain);
            if (!confirmed.ok) {
              validationAvailable = false;
              return;
            }
            const row = confirmed.rows.get(traceId);
            if (!row) {
              // Once a Brain is attached, provider-only documents are
              // unvalidated. Re-read while holding the per-trace queue before
              // fencing so a concurrent store cannot publish its durable row
              // between validation and this local tombstone.
              markTraceDeleted(namespace, traceId, false);
              return;
            }

            const trace = this.rowToTrace(row);
            if (row.deleted === 1) {
              markTraceDeleted(namespace, row.id, false);
              releaseDeleteAuthority(namespace, row.id);
              // Cross-process validation is deliberately non-destructive.
              // A concurrent revival can write its new vector before its
              // active SQL row; deleting here based on the older tombstone
              // would erase that fresh vector. Explicit softDelete/retry owns
              // provider cleanup, while this durable fence blocks recall.
              return;
            }

            if (
              !hasDeletedTrace(namespace, row.id) ||
              hasAuthoritativeDelete(namespace, row.id)
            ) {
              return;
            }
            const embedding = blobToEmbedding(row.embedding);
            if (!embedding || !isUsableEmbedding(embedding)) return;
            await reviveTrace(
              namespace,
              trace,
              embedding,
              this.coordinationTarget,
              false,
            );
          },
        ),
      ),
    );
    return validationAvailable;
  }

  /**
   * Return the subset of cached trace IDs that remain recallable after a
   * fail-closed durable-state check. Used by non-vector recall paths such as
   * graph association injection so a tombstone cannot bypass vector filters.
   *
   * @param traceIds - The candidate trace IDs.
   * @param scopes - When given and non-empty, only traces filed under one of
   *   these scopes are recallable, as in {@link query}: a graph association
   *   never brings in a trace of a scope the caller does not read.
   */
  async filterRecallableTraceIds(
    traceIds: string[],
    scopes?: ReadonlyArray<{ scope: MemoryScope; scopeId: string }>,
  ): Promise<Set<string>> {
    this.beginOperation();
    const uniqueIds = [...new Set(traceIds)];
    const validated = await this.reconcileDurableTraceStates(
      uniqueIds,
      this.coordinationNamespace,
      this.brain,
    );
    if (!validated) return new Set();
    const readable = scopes?.length
      ? new Set(scopes.map(({ scope, scopeId }) => scopeKey(scope, scopeId)))
      : null;
    return new Set(
      uniqueIds.filter((traceId) => {
        const trace = this.traceCache.get(traceId);
        return Boolean(
          trace?.isActive &&
          !this.tombstonedTraceIds.has(traceId) &&
          !isTraceDeletePending(this.coordinationNamespace, traceId) &&
          (!readable || readable.has(scopeKey(trace.scope, trace.scopeId))),
        );
      }),
    );
  }

  /**
   * Hydrate the in-memory vector store + scope registry from the attached
   * Brain on first use. The Brain is the durable backing store, but the vector
   * index is per-instance and starts cold — without this, a host that opens a
   * fresh MemoryStore per request (e.g. wilds' per-request companion facade)
   * queries an empty index and recall returns nothing even though the Brain
   * holds the user's full history. Runs at most once per instance and is
   * best-effort: a SQL/schema error must never break the query path.
   */
  private ensureHydratedFromBrain(): Promise<void> {
    if (!this.brain) return Promise.resolve();
    // Single-flight, not a boolean latch. The old flag was set before the
    // first await, so a second query arriving while the first was still
    // loading rows skipped this guard, searched a still-empty index, and
    // silently recalled nothing (on a host that reuses one store across
    // concurrent readers, that surfaced as a companion "forgetting"
    // everything on the first turn after its facade was rebuilt). Every
    // caller now awaits the SAME load. The promise stays settled after a
    // failure on purpose: hydration is best-effort and must not retry on
    // every query.
    if (!this.brainHydration) {
      this.brainHydration = this.hydrateFromBrain();
    }
    return this.brainHydration;
  }

  /** The one hydration pass behind {@link MemoryStore.ensureHydratedFromBrain}. */
  private async hydrateFromBrain(): Promise<void> {
    const brain = this.brain;
    if (!brain) return;
    const namespace = this.coordinationNamespace;
    const hydrationDeleteEpoch = getDeleteEpoch(namespace);
    try {
      // Bound the per-instance load: a fresh facade (and on request-scoped
      // hosts, every request) hydrates, so we cap at the most-recent traces to
      // keep the SQL read + vector upserts bounded for very long-lived scopes.
      // A process-level facade cache (so hydration runs once, not per request)
      // is the follow-up optimisation; the cap keeps the un-cached path safe.
      const rows = await brain.all<MemoryTraceRow>(
        `SELECT id, type, scope, content, embedding, strength, created_at,
                last_accessed, retrieval_count, tags, emotions, metadata
           FROM memory_traces
          WHERE brain_id = ? AND deleted = 0
          ORDER BY created_at DESC
          LIMIT ?`,
        [brain.brainId, MemoryStore.HYDRATION_LIMIT],
      );
      for (const row of rows) {
        await withTraceOperation(
          namespace,
          row.id,
          'normal',
          async ({ blockedByDelete, isDeletePending }) => {
            if (
              blockedByDelete ||
              this.tombstonedTraceIds.has(row.id) ||
              this.traceCache.has(row.id)
            ) {
              return;
            }

            // A delete may finish after the bulk SELECT but before this row's
            // operation slot. Recheck only when deletion activity occurred.
            if (getDeleteEpoch(namespace) !== hydrationDeleteEpoch) {
              const stillActive = await brain.get<{ id: string }>(
                'SELECT id FROM memory_traces WHERE brain_id = ? AND id = ? AND deleted = 0',
                [brain.brainId, row.id],
              );
              if (!stillActive) return;
            }

            const embedding = blobToEmbedding(row.embedding);
            // Legacy rows persisted without embeddings become recallable once
            // they are mentioned and stored again.
            if (embedding == null || !isUsableEmbedding(embedding)) return;
            const trace = this.rowToTrace(row);
            const collection = collectionName(
              this.config.collectionPrefix,
              trace.scope,
              trace.scopeId,
            );
            try {
              const exists = this.config.vectorStore.collectionExists
                ? await this.config.vectorStore.collectionExists(collection)
                : true;
              if (!exists) {
                await this.config.vectorStore.createCollection?.(
                  collection,
                  this.config.embeddingDimension ?? embedding.length,
                  { overwriteIfExists: false },
                );
              }
            } catch {
              // Provider auto-creates the collection or omits existence checks.
            }
            const upsertResult = await this.config.vectorStore.upsert(collection, [
              {
                id: trace.id,
                textContent: trace.content,
                embedding,
                metadata: traceToMetadata(trace, this.persistsAccessState),
              },
            ]);
            if ((upsertResult?.failedCount ?? 0) > 0) return;

            if (isDeletePending() || this.tombstonedTraceIds.has(row.id)) {
              try {
                await this.config.vectorStore.delete(collection, [row.id]);
              } catch {
                // The queued delete retries after this operation releases.
              }
              return;
            }

            this.traceCache.set(trace.id, trace);
            this.embeddingCache.set(trace.id, embedding);
            this.registerScope(trace.scope, trace.scopeId);
          },
        );
      }
    } catch {
      // Best-effort: durable hydration must never throw into recall.
    }
  }

  /**
   * Reconstruct a MemoryTrace from a durable Brain row (inverse of the store() write-through).
   * With `persistAccessState` on, the stability, access count, reinforcement interval and next
   * reinforcement time come from the row's `metadata.decay` (written by this store or by the
   * `Memory` facade), and any of them it lacks from the store's own defaults.
   */
  private rowToTrace(row: MemoryTraceRow): MemoryTrace {
    const meta = (row.metadata ? safeParseJson<Record<string, any>>(row.metadata) : undefined) ?? {};
    const decay: Partial<PersistedDecayState> = this.persistsAccessState
      ? readPersistedDecayFields(meta)
      : {};
    const emotions =
      (row.emotions ? safeParseJson<MemoryTrace['emotionalContext']>(row.emotions) : undefined) ?? {
        valence: 0,
        arousal: 0,
        dominance: 0,
        intensity: 0,
        gmiMood: '',
      };
    const tags = (row.tags ? safeParseJson<string[]>(row.tags) : undefined) ?? [];
    return {
      id: row.id,
      type: row.type as MemoryType,
      scope: row.scope as MemoryScope,
      scopeId: typeof meta.scopeId === 'string' ? meta.scopeId : '',
      content: row.content,
      entities: Array.isArray(meta.entities) ? (meta.entities as string[]) : [],
      tags,
      provenance: meta.provenance ?? {
        sourceType: 'system',
        sourceTimestamp: row.created_at,
        confidence: 0.5,
        verificationCount: 0,
      },
      emotionalContext: emotions,
      encodingStrength: row.strength,
      stability: decay.stability ?? (typeof meta.stability === 'number' ? meta.stability : 0.5),
      retrievalCount: row.retrieval_count ?? 0,
      lastAccessedAt: row.last_accessed ?? row.created_at,
      accessCount: decay.accessCount ?? 0,
      reinforcementInterval: decay.reinforcementInterval ?? DEFAULT_REINFORCEMENT_INTERVAL_MS,
      ...(decay.nextReinforcementAt !== undefined
        ? { nextReinforcementAt: decay.nextReinforcementAt }
        : {}),
      associatedTraceIds: Array.isArray(meta.associatedTraceIds) ? (meta.associatedTraceIds as string[]) : [],
      createdAt: row.created_at,
      updatedAt: row.created_at,
      isActive: true,
      importance: typeof meta.importance === 'number' ? meta.importance : undefined,
      structuredData: meta.structuredData,
    } as MemoryTrace;
  }

  // =========================================================================
  // Store
  // =========================================================================

  /**
   * Store a new memory trace: embed content, upsert into vector store,
   * and record as episodic memory in the knowledge graph.
   */
  async store(trace: MemoryTrace): Promise<void> {
    this.beginOperation();
    const namespace = this.coordinationNamespace;
    const brain = this.brain;
    await withTraceOperation(
      namespace,
      trace.id,
      'normal',
      async ({ blockedByDelete, isDeletePending }) => {
        if (blockedByDelete) {
          throw new Error('MemoryStore.store: trace deletion is already in progress');
        }
        const embedding = await this.storeWithTraceLock(trace, brain, namespace);
        if (!isDeletePending()) {
          await reviveTrace(
            namespace,
            trace,
            embedding,
            this.coordinationTarget,
          );
        }
      },
    );
  }

  private async storeWithTraceLock(
    trace: MemoryTrace,
    brain: import('./Brain.js').Brain | null,
    namespace: object,
  ): Promise<number[]> {
    // Calling store with an existing ID is the explicit revival operation.
    // Build active metadata without mutating a caller-provided cached
    // tombstone until the vector provider has accepted the write.
    const activeUpdatedAt = Date.now();
    const activeTrace: MemoryTrace = {
      ...trace,
      isActive: true,
      updatedAt: activeUpdatedAt,
    };
    const collection = collectionName(this.config.collectionPrefix, trace.scope, trace.scopeId);

    // Generate embedding
    const embeddingResponse = await this.config.embeddingManager.generateEmbeddings({
      texts: trace.content,
    });
    const embedding = embeddingResponse.embeddings[0];
    if (!isUsableEmbedding(embedding)) {
      // CR4: the embedding manager failed to embed this content (returned []).
      // Refuse rather than persisting a zero-vector that silently corrupts recall.
      throw new Error(
        `MemoryStore.store: refusing to persist an empty embedding vector for trace ${trace.id} ` +
          `(the embedding manager returned no vector for its content); a zero-vector would corrupt recall.`,
      );
    }

    try {
      const exists = this.config.vectorStore.collectionExists
        ? await this.config.vectorStore.collectionExists(collection)
        : true;
      if (!exists) {
        await this.config.vectorStore.createCollection?.(
          collection,
          this.config.embeddingDimension ?? embedding.length,
          { overwriteIfExists: false },
        );
      }
    } catch {
      // Some providers auto-create collections or do not expose existence checks reliably.
    }

    // Upsert into vector store
    const doc: VectorDocument = {
      id: trace.id,
      textContent: trace.content,
      embedding,
      metadata: traceToMetadata(activeTrace, this.persistsAccessState),
    };

    const upsertResult = await this.config.vectorStore.upsert(collection, [doc]);
    if ((upsertResult?.failedCount ?? 0) > 0) {
      throw new Error(
        `MemoryStore.store: vector provider rejected trace ${trace.id}; ` +
          `${upsertResult.failedCount} document write failed`,
      );
    }

    // The Brain is authoritative whenever attached. Persist before publishing
    // the active trace to caches or secondary graph indexes; otherwise a
    // failed write would look successful locally and then be fenced as a
    // provider-only document on the next durable recall.
    if (brain) {
      // The upsert rewrites a revived row in place, under the rowid its old
      // full-text entry names. Read first whether the row exists, so that a
      // held row alone moves, once its rewrite has committed.
      const revived = brain.features.dialect.name !== 'postgres' && (await traceRowHeld(brain, trace.id));
      try {
        const { dialect } = brain.features;
        // On Postgres the full-text index is the row's `_tsv` column, and the
        // upsert's SET list names only the columns given: without `_tsv`, a
        // revived row would keep its old words. It is written null here and
        // filled by the sync below; an open fills one the sync left null.
        const tsv = dialect.name === 'postgres';
        const insertSql = dialect.insertOrReplace(
          'memory_traces',
          ['brain_id', 'id', 'type', 'scope', 'content', 'embedding', 'strength', 'created_at', 'last_accessed', 'retrieval_count', 'tags', 'emotions', 'metadata', 'deleted', 'scope_id', ...(tsv ? ['_tsv'] : [])],
          ['?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '0', '?', ...(tsv ? ['NULL'] : [])],
          'brain_id, id',
        );
        const storedMetadata: Record<string, unknown> = {
          scopeId: trace.scopeId,
          provenance: trace.provenance,
          entities: trace.entities,
          stability: trace.stability,
          importance: trace.importance,
          associatedTraceIds: trace.associatedTraceIds,
          structuredData: trace.structuredData,
        };
        const insertParams = [
          brain.brainId,
          trace.id,
          trace.type,
          trace.scope,
          trace.content,
          embeddingToBlob(embedding),
          trace.encodingStrength,
          trace.createdAt,
          trace.lastAccessedAt,
          trace.retrievalCount,
          JSON.stringify(trace.tags),
          JSON.stringify(trace.emotionalContext),
          JSON.stringify(
            this.persistsAccessState
              ? withPersistedDecayState(storedMetadata, decayStateOf(trace))
              : storedMetadata,
          ),
          trace.scopeId ?? '',
        ];
        const result = await brain.run(insertSql, insertParams);
        if (result.changes === 0) {
          throw new Error('durable write affected no rows');
        }
      } catch {
        trace.isActive = false;
        // The SQL error is ambiguous: another process may already have
        // committed a successful store for the same trace. Fence this
        // process non-authoritatively, but do not erase a shared provider
        // vector that could belong to that successful writer.
        markTraceDeleted(namespace, trace.id, false);
        throw new Error('MemoryStore.store: durable trace write failed');
      }
      // The durable row is committed; bring the full-text index with it.
      // Deliberately NOT a nested brain.transaction(): store() may itself run
      // inside a caller's transaction, and the adapter's transaction queue
      // would deadlock on a second owner. A missed sync is repaired on the
      // next open: by the exact check in Brain on SQLite, by the fill of a
      // null `_tsv` on Postgres.
      await indexStoredTrace(brain, trace, revived);
    }

    trace.isActive = true;
    trace.updatedAt = activeUpdatedAt;

    // Record in knowledge graph as episodic memory. Step 13: thread
    // `trace.entities` through as `entityIds` (slugified for deterministic
    // lookup). Previously hardcoded to `[]`, which silenced the sixth
    // signal in the composite scoring formula.
    const entityIds = (trace.entities ?? [])
      .map(slugifyEntityId)
      .filter((id) => id.length > 0);
    try {
      await this.config.knowledgeGraph.recordMemory({
        type: trace.type === 'episodic' ? 'conversation' : 'discovery',
        summary: trace.content.substring(0, 200),
        description: trace.content,
        participants: [trace.scopeId],
        valence: trace.emotionalContext.valence,
        importance: trace.encodingStrength,
        entityIds,
        embedding,
        occurredAt: new Date(trace.createdAt).toISOString(),
        outcome: 'unknown',
        context: {
          memoryTraceId: trace.id,
          scope: trace.scope,
          scopeId: trace.scopeId,
          type: trace.type,
        },
      });
    } catch {
      // Knowledge graph may not be available; non-critical
    }

    // Step 13: upsert entity nodes and co-occurrence edges when the
    // feature flag is on. Non-critical; swallows errors so an unavailable
    // KG backend does not block encoding.
    if (this.config.enableGraphActivation) {
      await this.ingestEntityGraph(trace);
    }

    // Cache trace and its embedding (avoids re-generation on recordAccess)
    this.traceCache.set(trace.id, trace);
    this.embeddingCache.set(trace.id, embedding);
    this.registerScope(trace.scope, trace.scopeId);
    return embedding;
  }

  // =========================================================================
  // Query
  // =========================================================================

  /**
   * Query memory traces with cognitive scoring.
   */
  async query(
    queryText: string,
    currentMood: PADState,
    options: CognitiveRetrievalOptions = {}
  ): Promise<{
    scored: ScoredMemoryTrace[];
    partial: PartiallyRetrievedTrace[];
    /**
     * Per-stage wall-clock timings. Surfaced so
     * {@link CognitiveMemoryManager} can populate its diagnostics
     * with real numbers instead of the former 0-placeholder.
     */
    timings: {
      vectorSearchMs: number;
      scoringMs: number;
    };
  }> {
    this.beginOperation();
    const now = Date.now();
    const topK = options.topK ?? 20;
    const namespace = this.coordinationNamespace;
    const brain = this.brain;

    // Cold-start durability: load durable traces from the attached Brain into
    // the in-memory index (+ scope registry) before the first query, so recall
    // survives a fresh MemoryStore instance (e.g. a new request-scoped facade).
    await this.ensureHydratedFromBrain();

    // Determine which collections to search
    const scopes = options.scopes?.length ? options.scopes : this.getKnownScopes();
    if (scopes.length === 0) {
      return { scored: [], partial: [], timings: { vectorSearchMs: 0, scoringMs: 0 } };
    }

    // Generate query embedding
    const embeddingResponse = await this.config.embeddingManager.generateEmbeddings({
      texts: queryText,
    });
    const queryEmbedding = embeddingResponse.embeddings[0];
    if (!isUsableEmbedding(queryEmbedding)) {
      // CR4: the embedding manager failed to embed the query (returned []).
      // Degrade to no results rather than issuing a corrupt similarity search —
      // an empty query vector yields meaningless scores or dimension errors,
      // and some vector backends return arbitrary neighbours instead of failing.
      console.warn(
        'MemoryStore.query: embedding manager returned an empty query vector; ' +
          'returning no results rather than issuing a corrupt similarity search.',
      );
      return { scored: [], partial: [], timings: { vectorSearchMs: 0, scoringMs: 0 } };
    }

    // Build metadata filter
    const metadataFilter: Record<string, any> = { isActive: { $eq: 1 } };
    if (options.types?.length) {
      metadataFilter.type = { $in: options.types };
    }
    if (options.minConfidence != null) {
      metadataFilter.confidence = { $gte: options.minConfidence };
    }
    if (options.timeRange?.after) {
      metadataFilter.createdAt = { $gte: options.timeRange.after };
    }

    // Step 13: compute graph activation for this query. Extract query
    // entities, seed spreading activation from their entity nodes, build
    // a per-entity-ID activation map. Per-candidate activation is computed
    // inside the candidate loop as max over the trace's entity IDs. When
    // the flag is off or no query entities are extracted, the map stays
    // empty and all candidates get graphActivation = 0 (legacy).
    const activationByEntityId: Map<string, number> = new Map();
    if (this.config.enableGraphActivation) {
      const queryEntities = extractEntities(queryText);
      const seedIds = queryEntities
        .map(slugifyEntityId)
        .filter((id) => id.length > 0);
      if (seedIds.length > 0) {
        try {
          const activated = await spreadActivation({
            seedIds,
            getNeighbors: async (nodeId) => {
              const rels = await this.config.knowledgeGraph.getRelations(
                nodeId,
                { direction: 'both' },
              );
              return rels
                .filter((r) => r.type === 'related_to' && r.label === 'co_occurs')
                .map((r) => ({
                  id: r.sourceId === nodeId ? r.targetId : r.sourceId,
                  weight: r.weight ?? 1,
                }));
            },
          });
          for (const node of activated) {
            activationByEntityId.set(node.memoryId, node.activation);
          }
          // Seeds themselves always count as fully-activated self-matches.
          for (const id of seedIds) {
            if (!activationByEntityId.has(id)) {
              activationByEntityId.set(id, 1);
            }
          }
        } catch {
          // Non-critical: activation failure falls back to legacy behavior.
        }
      }
    }

    // Search across scopes
    const allCandidates: CandidateTrace[] = [];
    const vectorSearchStart = Date.now();

    if (this.tombstonedTraceIds.size > 0) {
      const localStateAvailable = await this.reconcileDurableTraceStates(
        [...this.tombstonedTraceIds],
        namespace,
        brain,
      );
      if (!localStateAvailable) {
        return {
          scored: [],
          partial: [],
          timings: {
            vectorSearchMs: Date.now() - vectorSearchStart,
            scoringMs: 0,
          },
        };
      }
    }

    for (const { scope, scopeId } of scopes) {
      const collection = collectionName(this.config.collectionPrefix, scope, scopeId);

      try {
        const results = await this.config.vectorStore.query(collection, queryEmbedding, {
          topK: topK * 2, // over-fetch for re-ranking
          filter: metadataFilter as MetadataFilter,
          includeMetadata: true,
        });

        const durableStateAvailable = await this.reconcileDurableTraceStates(
          results.documents.map((document) => document.id),
          namespace,
          brain,
        );
        if (!durableStateAvailable) continue;

        for (const result of results.documents) {
          if (
            this.tombstonedTraceIds.has(result.id) ||
            isTraceDeletePending(namespace, result.id)
          ) {
            continue;
          }
          const tracePartial = metadataToTracePartial(result.metadata ?? {}, this.persistsAccessState);
          const cached = this.traceCache.get(result.id);

          const trace: MemoryTrace =
            cached ??
            ({
              id: result.id,
              content: result.textContent ?? '',
              structuredData: undefined,
              associatedTraceIds: [],
              reinforcementInterval: DEFAULT_REINFORCEMENT_INTERVAL_MS,
              updatedAt: Date.now(),
              ...tracePartial,
            } as MemoryTrace);

          // Treat the in-memory tombstone as authoritative. A best-effort
          // vector-store update can fail after softDelete(), leaving a stale
          // document whose metadata still says it is active.
          if (!trace.isActive) {
            continue;
          }

          if (!cached) {
            this.traceCache.set(trace.id, trace);
          }
          if (trace.scope && trace.scopeId) {
            this.registerScope(trace.scope, trace.scopeId);
          }

          // Step 13: per-candidate activation score. Max over the
          // trace's entity IDs (slugified) against the query-seeded
          // activation map. Zero when the feature flag is off, no
          // query entities matched, or the trace has no entities.
          let graphActivation = 0;
          if (this.config.enableGraphActivation && activationByEntityId.size > 0) {
            const ids = (trace.entities ?? [])
              .map(slugifyEntityId)
              .filter((id) => id.length > 0);
            for (const id of ids) {
              const a = activationByEntityId.get(id);
              if (a !== undefined && a > graphActivation) graphActivation = a;
            }
          }
          allCandidates.push({
            trace,
            vectorSimilarity: result.similarityScore ?? 0,
            graphActivation,
          });
        }
      } catch {
        // Collection may not exist yet; skip
      }
    }

    const vectorSearchMs = Date.now() - vectorSearchStart;

    // Score and rank — optional per-call scoringWeights override
    // enables ablation studies (zero one signal at a time).
    const effectiveWeights: ScoringWeights | undefined = options.scoringWeights
      ? { ...DEFAULT_SCORING_WEIGHTS, ...options.scoringWeights }
      : undefined;
    const scoringContext: ScoringContext = {
      currentMood,
      now,
      neutralMood: options.neutralMood,
      decayConfig: this.decay,
      weights: effectiveWeights,
    };

    const scoringStart = Date.now();
    const activeCandidates = allCandidates.filter(
      (candidate) =>
        candidate.trace.isActive &&
        !this.tombstonedTraceIds.has(candidate.trace.id) &&
        !isTraceDeletePending(namespace, candidate.trace.id),
    );
    const scored = scoreAndRankTraces(activeCandidates, scoringContext).slice(0, topK);
    const partial = detectPartiallyRetrieved(activeCandidates, now, scoringContext);
    const scoringMs = Date.now() - scoringStart;

    // Cognitive mechanisms: RIF + FOK
    if (this.mechanismsEngine && scored.length > 0) {
      const cutoff = scored[scored.length - 1].retrievalScore;
      this.mechanismsEngine.onRetrieval(scored, activeCandidates, cutoff, []);
    }

    return { scored, partial, timings: { vectorSearchMs, scoringMs } };
  }

  // =========================================================================
  // Access tracking
  // =========================================================================

  /**
   * Record that a memory was accessed (retrieved).
   * Updates decay parameters via spaced repetition.
   */
  async recordAccess(traceId: string): Promise<RetrievalUpdateResult | null> {
    this.beginOperation();
    const namespace = this.coordinationNamespace;
    const brain = this.brain;
    return withTraceOperation(
      namespace,
      traceId,
      'normal',
      async ({ blockedByDelete, isDeletePending }) => {
        if (blockedByDelete) return null;
        return this.recordAccessWithTraceLock(traceId, isDeletePending, brain);
      },
    );
  }

  private async recordAccessWithTraceLock(
    traceId: string,
    isDeletePending: () => boolean,
    brain: import('./Brain.js').Brain | null,
  ): Promise<RetrievalUpdateResult | null> {
    const trace = this.traceCache.get(traceId);
    if (this.tombstonedTraceIds.has(traceId) || !trace?.isActive) return null;

    const now = Date.now();
    const update = updateOnRetrieval(trace, now);

    // Apply updates to cached trace
    trace.encodingStrength = update.encodingStrength;
    trace.stability = update.stability;
    trace.retrievalCount = update.retrievalCount;
    trace.lastAccessedAt = update.lastAccessedAt;
    trace.accessCount = update.accessCount;
    trace.reinforcementInterval = update.reinforcementInterval;
    trace.nextReinforcementAt = update.nextReinforcementAt;
    trace.updatedAt = now;

    // Cognitive mechanisms: reconsolidation drift on access
    if (this.mechanismsEngine && this.config.moodProvider) {
      const mood = this.config.moodProvider();
      this.mechanismsEngine.onAccess(trace, mood);
    }

    // Update vector store metadata, reusing cached embedding to avoid
    // wasteful re-embedding on every access.
    const collection = collectionName(this.config.collectionPrefix, trace.scope, trace.scopeId);
    try {
      let embedding = this.embeddingCache.get(trace.id);
      if (!embedding) {
        // Embedding not cached (e.g. loaded from a prior process). Generate once and cache.
        const embeddingResponse = await this.config.embeddingManager.generateEmbeddings({
          texts: trace.content,
        });
        if (!trace.isActive) return null;
        embedding = embeddingResponse.embeddings[0];
        // CR4: only cache a usable vector — caching [] would poison every future
        // access (a cache hit skips re-embedding, so the empty vector would stick).
        if (isUsableEmbedding(embedding)) {
          this.embeddingCache.set(trace.id, embedding);
        }
      }
      // CR4: skip this best-effort metadata refresh rather than upserting a
      // zero-vector that would corrupt the stored trace's recall.
      if (trace.isActive && isUsableEmbedding(embedding)) {
        await this.config.vectorStore.upsert(collection, [
          {
            id: trace.id,
            textContent: trace.content,
            embedding,
            metadata: traceToMetadata(trace, this.persistsAccessState),
          },
        ]);
      }
    } catch {
      // Non-critical update
    }

    // Deletion can race the asynchronous embedding or vector refresh above.
    // If it won, remove any document the late refresh may have restored.
    if (isDeletePending() || !trace.isActive) {
      try {
        await this.config.vectorStore.delete(collection, [traceId]);
      } catch {
        // Query and getByScope still reject the cached tombstone.
      }
      this.embeddingCache.delete(traceId);
      return null;
    }

    // Write-through: update access metadata in the durable SQL store
    if (brain) {
      try {
        await this.persistAccess(brain, trace);
      } catch {
        // Best-effort persistence
      }
    }

    return trace.isActive ? update : null;
  }

  /**
   * Writes an accessed trace's state to its Brain row: `last_accessed`, `retrieval_count` and
   * `strength`, and, with `persistAccessState` on, its decay state merged into the row's own
   * metadata JSON under `decay`, every other key of the row kept. The merge is a compare-and-set
   * on the JSON text it read, tried twice, so a key another writer set in between is not lost;
   * after two lost races, and for a row whose metadata is not a JSON object, the columns alone
   * are written and the metadata is left as it is.
   */
  private async persistAccess(brain: import('./Brain.js').Brain, trace: MemoryTrace): Promise<void> {
    const columns = [trace.lastAccessedAt, trace.retrievalCount, trace.encodingStrength];
    const writeColumns = () =>
      brain.run(
        'UPDATE memory_traces SET last_accessed = ?, retrieval_count = ?, strength = ? WHERE brain_id = ? AND id = ? AND deleted = 0',
        [...columns, brain.brainId, trace.id],
      );
    if (!this.persistsAccessState) {
      await writeColumns();
      return;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const row = await brain.get<{ metadata: string | null }>(
        'SELECT metadata FROM memory_traces WHERE brain_id = ? AND id = ? AND deleted = 0',
        [brain.brainId, trace.id],
      );
      if (!row) return;
      const meta: unknown = row.metadata ? safeParseJson<unknown>(row.metadata) : {};
      if (!isJsonObject(meta)) break;
      const next = JSON.stringify(withPersistedDecayState(meta, decayStateOf(trace)));
      const result = row.metadata === null
        ? await brain.run(
            `UPDATE memory_traces SET last_accessed = ?, retrieval_count = ?, strength = ?, metadata = ?
              WHERE brain_id = ? AND id = ? AND deleted = 0 AND metadata IS NULL`,
            [...columns, next, brain.brainId, trace.id],
          )
        : await brain.run(
            `UPDATE memory_traces SET last_accessed = ?, retrieval_count = ?, strength = ?, metadata = ?
              WHERE brain_id = ? AND id = ? AND deleted = 0 AND metadata = ?`,
            [...columns, next, brain.brainId, trace.id, row.metadata],
          );
      if (result.changes > 0) return;
    }
    await writeColumns();
  }

  // =========================================================================
  // Batch operations
  // =========================================================================

  /**
   * Get all traces for a scope (for consolidation pipeline).
   *
   * **Limitation**: This primarily returns traces from the in-process cache.
   * Traces that were persisted to the vector store in a prior process lifetime
   * (or by another process) will only be returned if the cache is empty for this
   * scope, in which case we fall back to querying the vector store with a
   * zero vector of the collection's size ({@link zeroQueryVector}) and a metadata
   * filter. The fallback is approximate (limited by topK) and does not guarantee
   * completeness.
   */
  async getByScope(scope: MemoryScope, scopeId: string, type?: MemoryType): Promise<MemoryTrace[]> {
    this.beginOperation();
    const namespace = this.coordinationNamespace;
    const brain = this.brain;
    await this.ensureHydratedFromBrain();
    const collectCachedResults = (): MemoryTrace[] =>
      [...this.traceCache.values()].filter(
        (trace) =>
          !this.tombstonedTraceIds.has(trace.id) &&
          trace.isActive &&
          trace.scope === scope &&
          trace.scopeId === scopeId &&
          (!type || trace.type === type),
      );
    let results = collectCachedResults();

    const collection = collectionName(this.config.collectionPrefix, scope, scopeId);
    const cachedStateAvailable = await this.reconcileDurableTraceStates(
      [
        ...results.map((trace) => trace.id),
        ...this.tombstonedTraceIds,
      ],
      namespace,
      brain,
    );
    if (!cachedStateAvailable) return [];
    // Reconciliation can revive a trace while waiting behind an in-flight
    // store. Refresh the snapshot so that revival is visible in this call.
    results = collectCachedResults();

    // Fallback: if cache is empty for this scope, query the vector store.
    if (results.length === 0) {
      try {
        const zeroVector = await this.zeroQueryVector();
        const filter: MetadataFilter = { isActive: 1 };
        if (type) {
          filter.type = type;
        }
        const queryResult = await this.config.vectorStore.query(collection, zeroVector, {
          topK: 500,
          filter,
          includeMetadata: true,
          includeTextContent: true,
        });
        const providerStateAvailable = await this.reconcileDurableTraceStates(
          queryResult.documents.map((document) => document.id),
          namespace,
          brain,
        );
        if (!providerStateAvailable) return [];
        for (const doc of queryResult.documents) {
          if (
            this.tombstonedTraceIds.has(doc.id) ||
            isTraceDeletePending(namespace, doc.id)
          ) {
            continue;
          }
          if (!doc.metadata) continue;
          const cached = this.traceCache.get(doc.id);
          if (cached) {
            if (cached.isActive) {
              results.push(cached);
            }
          } else {
            // Reconstruct trace from vector store metadata. A document that holds no
            // interval loads with the store's one hour; with persistAccessState off, as
            // before, with 0.
            const partial = metadataToTracePartial(
              doc.metadata as Record<string, any>,
              this.persistsAccessState,
            );
            const trace: MemoryTrace = {
              id: doc.id,
              content: doc.textContent ?? '',
              associatedTraceIds: [],
              reinforcementInterval: this.persistsAccessState ? DEFAULT_REINFORCEMENT_INTERVAL_MS : 0,
              updatedAt: (partial.createdAt as number) ?? Date.now(),
              ...partial,
            } as MemoryTrace;
            if (!trace.isActive) continue;
            this.traceCache.set(trace.id, trace);
            results.push(trace);
          }
        }
      } catch {
        // Vector store query may fail (collection not found, etc.); return empty.
      }
    }

    return results.filter(
      (trace) =>
        trace.isActive &&
        !this.tombstonedTraceIds.has(trace.id) &&
        !isTraceDeletePending(namespace, trace.id),
    );
  }

  /**
   * A zero vector of the size of the vectors in this store's collections ({@link resolveVectorSize}), for a read of
   * a collection that matches no text. An index refuses a query vector of another size, and the read finds nothing.
   */
  private async zeroQueryVector(): Promise<number[]> {
    return new Array<number>(await this.resolveVectorSize()).fill(0);
  }

  /**
   * The size of the vectors in this store's collections: the configured `embeddingDimension`; else the embedding
   * model's, as the embedding manager reports it (`getEmbeddingDimension()`); else the length of one probe embedding;
   * else 1536. A measured size is kept for the store's life; a measurement that failed is tried again by the next
   * read.
   */
  private async resolveVectorSize(): Promise<number> {
    const configured = this.config.embeddingDimension;
    if (isVectorSize(configured)) return configured;
    this.measuredVectorSize ??= this.measureVectorSize();
    const measuring = this.measuredVectorSize;
    const measured = await measuring;
    if (measured !== undefined) return measured;
    if (this.measuredVectorSize === measuring) this.measuredVectorSize = undefined;
    return 1536;
  }

  /** The embedding model's vector size, as its manager reports it or as one probe embedding measures it. */
  private async measureVectorSize(): Promise<number | undefined> {
    const embeddingManager = this.config.embeddingManager;
    try {
      const reported = await embeddingManager.getEmbeddingDimension();
      if (isVectorSize(reported)) return reported;
    } catch {
      // A manager that cannot report its model's size; one embedding measures it.
    }
    try {
      const probe = await embeddingManager.generateEmbeddings({ texts: 'dimension probe' });
      const embedding = probe.embeddings[0];
      if (isUsableEmbedding(embedding)) return embedding.length;
    } catch {
      // The embedding model cannot be reached; the next read measures again.
    }
    return undefined;
  }

  /**
   * Re-upsert a trace's metadata to the vector store using the cached
   * embedding. Used by consolidation when a mutation to the in-memory
   * trace (e.g. `provenance.contradictedBy`, `provenance.lastVerifiedAt`)
   * needs to survive a process restart without paying for re-embedding.
   *
   * No-ops silently when the trace or its embedding is not cached; the
   * caller should `getTrace` first or accept that an uncached trace will
   * not be durably updated.
   */
  async persistTraceMetadata(traceId: string): Promise<void> {
    this.beginOperation();
    const namespace = this.coordinationNamespace;
    await withTraceOperation(
      namespace,
      traceId,
      'normal',
      async ({ blockedByDelete, isDeletePending }) => {
        if (blockedByDelete) return;
        await this.persistTraceMetadataWithTraceLock(traceId, isDeletePending);
      },
    );
  }

  private async persistTraceMetadataWithTraceLock(
    traceId: string,
    isDeletePending: () => boolean,
  ): Promise<void> {
    const trace = this.traceCache.get(traceId);
    const embedding = this.embeddingCache.get(traceId);
    if (
      this.tombstonedTraceIds.has(traceId) ||
      !trace?.isActive ||
      !embedding
    ) {
      return;
    }

    const collection = collectionName(this.config.collectionPrefix, trace.scope, trace.scopeId);
    const doc: VectorDocument = {
      id: trace.id,
      textContent: trace.content,
      embedding,
      metadata: traceToMetadata(trace, this.persistsAccessState),
    };
    try {
      await this.config.vectorStore.upsert(collection, [doc]);
      if (isDeletePending() || !trace.isActive) {
        await this.config.vectorStore.delete(collection, [traceId]);
      }
    } catch {
      // Best-effort persistence — the in-memory mutation already
      // happened, so a vector-store failure should not kill the caller.
    }
  }

  /**
   * Soft-delete a trace and preserve the local barrier if durable persistence
   * cannot confirm the tombstone.
   *
   * @throws When an attached Brain cannot persist the tombstone or the trace
   *   has no durable row to update.
   */
  async softDelete(traceId: string): Promise<void> {
    this.beginOperation();
    const namespace = this.coordinationNamespace;
    const brain = this.brain;
    await withTraceOperation(
      namespace,
      traceId,
      'delete',
      async () => this.softDeleteWithTraceLock(traceId, namespace, brain),
    );
  }

  private async softDeleteWithTraceLock(
    traceId: string,
    namespace: object,
    brain: import('./Brain.js').Brain | null,
  ): Promise<void> {
    let trace = this.traceCache.get(traceId);

    // A caller may delete before the first recall hydrates this process-local
    // cache. Load just the requested row so we can invalidate the correct
    // vector collection without paying the full hydration cost. Tombstoned
    // rows are included deliberately: a prior delete whose vector eviction
    // failed (see below) must still be able to re-derive the collection and
    // retry — filtering them out made that failure permanent, because a
    // fresh instance found no row, skipped the vector delete entirely, and
    // the stale document stayed recallable forever.
    if (!trace && brain) {
      try {
        const row = await brain.get<MemoryTraceRow>(
          `SELECT id, type, scope, content, embedding, strength, created_at,
                  last_accessed, retrieval_count, tags, emotions, metadata, deleted
             FROM memory_traces
            WHERE brain_id = ? AND id = ?`,
          [brain.brainId, traceId],
        );
        if (row) {
          trace = this.rowToTrace(row);
          // A tombstoned row is loaded solely to name the collection for
          // (re-)eviction — never recached, so it cannot re-enter recall.
          if (row.deleted !== 1) {
            this.traceCache.set(trace.id, trace);
            const embedding = blobToEmbedding(row.embedding);
            if (embedding && isUsableEmbedding(embedding)) {
              this.embeddingCache.set(trace.id, embedding);
            }
            this.registerScope(trace.scope, trace.scopeId);
          }
        }
      } catch {
        // Best-effort lookup. The SQL tombstone below can still succeed.
      }
    }

    if (trace) {
      trace.isActive = false;
      trace.updatedAt = Date.now();
    }

    // Write-through: mark trace as deleted in the durable SQL store. Keep the
    // local delete authoritative until this succeeds so a transient SQL error
    // cannot be misread as an external revival on the next recall.
    let durableDeleteError = false;
    if (brain) {
      try {
        const result = await brain.run(
          'UPDATE memory_traces SET deleted = 1 WHERE brain_id = ? AND id = ?',
          [brain.brainId, traceId],
        );
        if (result.changes > 0) {
          releaseDeleteAuthority(namespace, traceId);
        } else {
          durableDeleteError = true;
        }
      } catch {
        durableDeleteError = true;
      }
    }

    // Every live store attached to this backing resource owns an independent
    // hot vector index. Evict all of them before the delete operation resolves.
    const evicted = await evictDeletedTrace(
      namespace,
      traceId,
      trace,
      this.coordinationTarget,
    );
    if (!evicted) {
      const location = trace
        ? collectionName(this.config.collectionPrefix, trace.scope, trace.scopeId)
        : 'an unresolved collection';
      console.warn(
        `[MemoryStore] vector eviction incomplete for trace ${traceId} in ${location}; ` +
          'the soft-deleted document may persist in a shared index until softDelete is retried',
      );
    }
    // Every stored trace has an episodic copy in the knowledge graph, holding its full text; the delete takes it.
    try {
      await this.config.knowledgeGraph.deleteMemories?.({ traceIds: [traceId] });
    } catch {
      // Non-critical, as recording the copy is (store()).
    }
    if (durableDeleteError) {
      throw new Error('MemoryStore.softDelete: durable tombstone write failed');
    }
  }

  /**
   * Deletes the given traces for good: each is soft-deleted in this process (cache, vector index, sibling stores
   * and its knowledge-graph copy), then its Brain row is deleted, so no reload, in this process or another, brings
   * it back (a store that finds a row gone reads it as deleted). The rows that name a trace go first, as the Brain's
   * foreign keys require: its retrieval feedback (with the query that recalled it) is deleted, and the document chunk
   * it was filed from lets go of it and keeps its text, which belongs to the document. On SQLite the full-text index
   * is rebuilt from the rows that remain, as every hard delete must; a rebuild that fails is repaired when the Brain
   * next opens.
   *
   * @param traceIds - Trace ids; unknown ids are skipped.
   * @returns How many of them had a Brain row or a live cached trace, so a second call for the same ids counts none.
   * @throws When the Brain cannot be read or a row cannot be deleted.
   */
  async deleteTraces(traceIds: readonly string[]): Promise<number> {
    this.beginOperation();
    const ids = [...new Set(traceIds)];
    if (ids.length === 0) return 0;
    const brain = this.brain;
    // A trace an earlier delete ended stays cached, inactive: it is evicted again, so a call made again retries an
    // eviction that failed, and it counts only when it still has a row.
    const counted = new Set(ids.filter((id) => this.traceCache.get(id)?.isActive === true));
    const known = new Set(ids.filter((id) => this.traceCache.has(id)));
    let rowIds: string[] = [];
    if (brain) {
      const durable = await this.getDurableTraceRows(ids, brain);
      if (!durable.ok) throw new Error('MemoryStore.deleteTraces: the Brain could not be read');
      rowIds = [...durable.rows.keys()];
      for (const id of rowIds) {
        counted.add(id);
        known.add(id);
      }
    }
    for (const id of known) {
      try {
        await this.softDelete(id);
      } catch {
        // The row delete below removes what the tombstone could not mark.
      }
    }
    if (brain && rowIds.length > 0) {
      for (let offset = 0; offset < rowIds.length; offset += 400) {
        const chunk = rowIds.slice(offset, offset + 400);
        const placeholders = chunk.map(() => '?').join(', ');
        const params = [brain.brainId, ...chunk];
        await brain.run(`DELETE FROM retrieval_feedback WHERE brain_id = ? AND trace_id IN (${placeholders})`, params);
        await brain.run(`UPDATE document_chunks SET trace_id = NULL WHERE brain_id = ? AND trace_id IN (${placeholders})`, params);
        await brain.run(`DELETE FROM memory_traces WHERE brain_id = ? AND id IN (${placeholders})`, params);
      }
      if (brain.features.dialect.name !== 'postgres') {
        try {
          await brain.exec(brain.features.fts.rebuildCommand('memory_traces_fts'));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // A database the index was never created in has nothing to rebuild.
          if (!fullTextIndexMissing(message)) {
            console.warn(
              `[MemoryStore] full-text index rebuild after deleting ${rowIds.length} traces failed; ` +
                `their words stay in the index until the Brain next opens and repairs it: ${message}`,
            );
          }
        }
      }
    }
    return counted.size;
  }

  /**
   * The ids of every trace of one scope: the traces this store holds and every Brain row filed under the scope
   * (`memory_traces.scope_id`), soft-deleted rows and another process's included.
   */
  async scopeTraceIds(scope: MemoryScope, scopeId: string): Promise<string[]> {
    this.beginOperation();
    const ids = new Set<string>();
    for (const trace of this.traceCache.values()) {
      if (trace.scope === scope && trace.scopeId === scopeId) ids.add(trace.id);
    }
    const brain = this.brain;
    if (brain) {
      const rows = await brain.all<{ id: string }>(
        'SELECT id FROM memory_traces WHERE brain_id = ? AND scope = ? AND scope_id = ?',
        [brain.brainId, scope, scopeId],
      );
      for (const row of rows) ids.add(row.id);
    }
    return [...ids];
  }

  /**
   * Deletes every trace of one scope for good ({@link deleteTraces}): the traces this store holds and every Brain row
   * filed under the scope ({@link scopeTraceIds}), then any knowledge-graph copy filed under it whose trace row was
   * already gone.
   *
   * @returns The number of traces deleted.
   */
  async deleteScope(scope: MemoryScope, scopeId: string): Promise<number> {
    this.beginOperation();
    const deleted = await this.deleteTraces(await this.scopeTraceIds(scope, scopeId));
    try {
      await this.config.knowledgeGraph.deleteMemories?.({ scopes: [{ scope, scopeId }] });
    } catch {
      // Each trace's own copy went with it above.
    }
    return deleted;
  }

  /** Whether the knowledge graph can delete a trace's episodic copy (`IKnowledgeGraph.deleteMemories`). */
  reachesGraphCopies(): boolean {
    return typeof this.config.knowledgeGraph.deleteMemories === 'function';
  }

  /**
   * Get a trace by ID.
   */
  getTrace(traceId: string): MemoryTrace | undefined {
    return this.traceCache.get(traceId);
  }

  /**
   * Whether this store has soft-deleted the trace in this process. Lifecycle
   * hooks that re-activate traces leaving working memory MUST consult this so
   * a tombstone's `isActive` flag is never resurrected — a resurrected flag
   * let the spaced-repetition sweep re-embed and re-upsert deleted memories
   * back into shared vector recall.
   */
  isDeleted(traceId: string): boolean {
    return this.tombstonedTraceIds.has(traceId);
  }

  /**
   * Get trace count.
   */
  getTraceCount(): number {
    return this.traceCache.size;
  }

  /**
   * Get active trace count.
   */
  getActiveTraceCount(): number {
    let count = 0;
    for (const trace of this.traceCache.values()) {
      if (trace.isActive) count++;
    }
    return count;
  }

  /**
   * List cached traces for diagnostics and tooling.
   */
  listTraces(options?: {
    activeOnly?: boolean;
    type?: MemoryType;
    scope?: MemoryScope;
    scopeId?: string;
  }): MemoryTrace[] {
    const traces: MemoryTrace[] = [];
    for (const trace of this.traceCache.values()) {
      if (options?.activeOnly && !trace.isActive) {
        continue;
      }
      if (options?.type && trace.type !== options.type) {
        continue;
      }
      if (options?.scope && trace.scope !== options.scope) {
        continue;
      }
      if (options?.scopeId && trace.scopeId !== options.scopeId) {
        continue;
      }
      traces.push({ ...trace });
    }
    return traces.sort((a, b) => b.createdAt - a.createdAt);
  }

  private registerScope(scope: MemoryScope, scopeId: string): void {
    if (!scopeId) return;
    this.knownScopes.set(scopeKey(scope, scopeId), { scope, scopeId });
  }

  private getKnownScopes(): Array<{ scope: MemoryScope; scopeId: string }> {
    return [...this.knownScopes.values()];
  }

  /**
   * Step 13: upsert entity nodes for every label in `trace.entities` and
   * create bidirectional `co_occurs` relations between every pair. Uses
   * deterministic slug IDs via {@link slugifyEntityId}. Idempotent.
   *
   * Called from `store(trace)` only when `config.enableGraphActivation`
   * is true. Non-critical: errors are caught and swallowed so an
   * unavailable KG backend never blocks encoding.
   *
   * @param trace - The memory trace just persisted via `store`.
   */
  private async ingestEntityGraph(trace: MemoryTrace): Promise<void> {
    const labels = trace.entities ?? [];
    if (labels.length === 0) return;

    const kg = this.config.knowledgeGraph;
    const now = new Date().toISOString();

    const ids: string[] = [];
    for (const label of labels) {
      const id = slugifyEntityId(label);
      if (!id) continue;
      try {
        await kg.upsertEntity({
          id,
          type: 'concept',
          label,
          confidence: 1,
          source: { type: 'conversation', timestamp: now },
          properties: {},
        });
        ids.push(id);
      } catch {
        // Non-critical.
      }
    }

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        try {
          await kg.upsertRelation({
            sourceId: ids[i],
            targetId: ids[j],
            type: 'related_to',
            label: 'co_occurs',
            weight: 1,
            bidirectional: true,
            confidence: 1,
            source: { type: 'conversation', timestamp: now },
            properties: { traceId: trace.id, timestamp: now },
          });
        } catch {
          // Non-critical.
        }
      }
    }
  }
}
