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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MemoryStoreConfig {
  vectorStore: IVectorStore;
  embeddingManager: IEmbeddingManager;
  knowledgeGraph: IKnowledgeGraph;
  /** Collection name prefix. @default 'cogmem' */
  collectionPrefix: string;
  /** Embedding dimension (auto-detected if possible). */
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectionName(prefix: string, scope: MemoryScope, scopeId: string): string {
  return `${prefix}_${scope}_${scopeId}`;
}

function scopeKey(scope: MemoryScope, scopeId: string): string {
  return `${scope}:${scopeId}`;
}

function traceToMetadata(trace: MemoryTrace): Record<string, any> {
  return {
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

function metadataToTracePartial(metadata: Record<string, any>): Partial<MemoryTrace> {
  return {
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
  /** Whether {@link MemoryStore.ensureHydratedFromBrain} has already run for this instance. */
  private brainHydrated = false;
  /** Namespace shared by stores that address the same backing resource. */
  private coordinationNamespace: object;
  /** Lifecycle-registered callbacks used to invalidate sibling store caches. */
  private readonly coordinationTarget: StoreCoordinationTarget;
  private coordinationRegistration: StoreRegistration | null;
  private disposed = false;

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

  /**
   * Attach a Brain for durable write-through persistence.
   * Once attached, all store/softDelete/recordAccess operations also
   * write to the brain's `memory_traces` table.
   *
   * @param brain - Brain instance (already initialized with schema)
   */
  setBrain(brain: import('./Brain.js').Brain): void {
    this.assertNotDisposed();
    if (this.coordinationRegistration) {
      unregisterCoordinationTarget(this.coordinationRegistration);
    }
    this.brain = brain;
    this.coordinationNamespace = brain.coordinationToken;
    this.coordinationRegistration = registerCoordinationTarget(
      this.coordinationNamespace,
      this.coordinationTarget,
    );
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

  private markDeletedLocally(traceId: string, authoritative = true): void {
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
        metadata: traceToMetadata(trace),
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
   */
  async filterRecallableTraceIds(traceIds: string[]): Promise<Set<string>> {
    this.assertNotDisposed();
    const uniqueIds = [...new Set(traceIds)];
    const validated = await this.reconcileDurableTraceStates(
      uniqueIds,
      this.coordinationNamespace,
      this.brain,
    );
    if (!validated) return new Set();
    return new Set(
      uniqueIds.filter((traceId) => {
        const trace = this.traceCache.get(traceId);
        return Boolean(
          trace?.isActive &&
          !this.tombstonedTraceIds.has(traceId) &&
          !isTraceDeletePending(this.coordinationNamespace, traceId),
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
  private async ensureHydratedFromBrain(): Promise<void> {
    if (this.brainHydrated) return;
    const brain = this.brain;
    if (!brain) return;
    this.brainHydrated = true; // set first: a failure must not retry on every query
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
                metadata: traceToMetadata(trace),
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

  /** Reconstruct a MemoryTrace from a durable Brain row (inverse of the store() write-through). */
  private rowToTrace(row: MemoryTraceRow): MemoryTrace {
    const meta = (row.metadata ? safeParseJson<Record<string, any>>(row.metadata) : undefined) ?? {};
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
      stability: typeof meta.stability === 'number' ? meta.stability : 0.5,
      retrievalCount: row.retrieval_count ?? 0,
      lastAccessedAt: row.last_accessed ?? row.created_at,
      accessCount: 0,
      reinforcementInterval: 3_600_000,
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
    this.assertNotDisposed();
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
        const embedding = await this.storeWithTraceLock(trace, brain);
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
      metadata: traceToMetadata(activeTrace),
    };

    const upsertResult = await this.config.vectorStore.upsert(collection, [doc]);
    if ((upsertResult?.failedCount ?? 0) > 0) {
      throw new Error(
        `MemoryStore.store: vector provider rejected trace ${trace.id}; ` +
          `${upsertResult.failedCount} document write failed`,
      );
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
    // Write-through to Brain for durability.
    // The SQL row mirrors the in-memory cache so traces survive restart.
    if (brain) {
      try {
        const { dialect } = brain.features;
        await brain.run(
          dialect.insertOrReplace(
            'memory_traces',
            ['brain_id', 'id', 'type', 'scope', 'content', 'embedding', 'strength', 'created_at', 'last_accessed', 'retrieval_count', 'tags', 'emotions', 'metadata', 'deleted'],
            ['?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '0'],
            'brain_id, id',
          ),
          [
            brain.brainId,
            trace.id,
            trace.type,
            trace.scope,
            trace.content,
            embeddingToBlob(embedding), // durable so recall survives a fresh instance (see ensureHydratedFromBrain)
            trace.encodingStrength,
            trace.createdAt,
            trace.lastAccessedAt,
            trace.retrievalCount,
            JSON.stringify(trace.tags),
            JSON.stringify(trace.emotionalContext),
            JSON.stringify({
              scopeId: trace.scopeId,
              provenance: trace.provenance,
              entities: trace.entities,
              stability: trace.stability,
              importance: trace.importance,
              associatedTraceIds: trace.associatedTraceIds,
              structuredData: trace.structuredData,
            }),
          ]
        );
      } catch {
        // Write-through is best-effort — in-memory store is primary
      }
    }
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
    this.assertNotDisposed();
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

    for (const { scope, scopeId } of scopes) {
      const collection = collectionName(this.config.collectionPrefix, scope, scopeId);

      try {
        if (this.tombstonedTraceIds.size > 0) {
          const localStateAvailable = await this.reconcileDurableTraceStates(
            [...this.tombstonedTraceIds],
            namespace,
            brain,
          );
          if (!localStateAvailable) continue;
        }
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
          const tracePartial = metadataToTracePartial(result.metadata ?? {});
          const cached = this.traceCache.get(result.id);

          const trace: MemoryTrace =
            cached ??
            ({
              id: result.id,
              content: result.textContent ?? '',
              structuredData: undefined,
              associatedTraceIds: [],
              reinforcementInterval: 3_600_000,
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
    this.assertNotDisposed();
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
            metadata: traceToMetadata(trace),
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
        await brain.run(
          'UPDATE memory_traces SET last_accessed = ?, retrieval_count = ?, strength = ? WHERE brain_id = ? AND id = ? AND deleted = 0',
          [trace.lastAccessedAt, trace.retrievalCount, trace.encodingStrength, brain.brainId, traceId]
        );
      } catch {
        // Best-effort persistence
      }
    }

    return trace.isActive ? update : null;
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
   * zero-vector and metadata filter. The fallback is approximate (limited by
   * topK) and does not guarantee completeness.
   */
  async getByScope(scope: MemoryScope, scopeId: string, type?: MemoryType): Promise<MemoryTrace[]> {
    this.assertNotDisposed();
    const namespace = this.coordinationNamespace;
    const brain = this.brain;
    await this.ensureHydratedFromBrain();
    // Return from cache + filter
    const results: MemoryTrace[] = [];
    for (const trace of this.traceCache.values()) {
      if (
        !this.tombstonedTraceIds.has(trace.id) &&
        trace.isActive &&
        trace.scope === scope &&
        trace.scopeId === scopeId
      ) {
        if (!type || trace.type === type) {
          results.push(trace);
        }
      }
    }

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

    // Fallback: if cache is empty for this scope, query the vector store.
    if (results.every((trace) => !trace.isActive)) {
      try {
        const dim = this.config.embeddingDimension ?? 1536;
        const zeroVector = new Array(dim).fill(0);
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
            // Reconstruct trace from vector store metadata.
            const partial = metadataToTracePartial(doc.metadata as Record<string, any>);
            const trace: MemoryTrace = {
              id: doc.id,
              content: doc.textContent ?? '',
              associatedTraceIds: [],
              reinforcementInterval: 0,
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
    this.assertNotDisposed();
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
      metadata: traceToMetadata(trace),
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
    this.assertNotDisposed();
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
    if (durableDeleteError) {
      throw new Error('MemoryStore.softDelete: durable tombstone write failed');
    }
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
