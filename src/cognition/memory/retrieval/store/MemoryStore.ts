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
  RetrievedVectorDocument,
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
  deleteTraceRows,
  parseTraceMetadata,
  readPersistedDecayFields,
  traceNamesUser,
  withPersistedDecayState,
  type PersistedDecayState,
} from './tracePersistence.js';
import { fillScopeIds } from './migrations/v2-to-v3.js';
import { encodePlainScopeId, onBrainRefiled, refileBrainScopeIds, type RefiledTrace } from './scopeIdForm.js';
import { copyKey } from '../graph/knowledge/memoryCopies.js';

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
   * An access that finds the row's `decay` changed since the store took the
   * trace or last wrote it (the facade's recall or feedback, another store on
   * the same Brain) counts on top of the row's state.
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

/** How many documents of a scope's collection a store with no Brain reads at once while it deletes the scope. */
const SCOPE_DELETE_PAGE_SIZE = 500;

/** How many documents of moved traces one delete takes from the collection a Brain's re-file moved them out of. */
const MOVED_DOCUMENT_DELETE_PAGE_SIZE = 500;

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
 * Whether a trace this store holds is filed under another scope than the collection one of its documents sits in:
 * a document `refileScope` could not delete from the collection the trace moved out of. Such a document is not read
 * as the trace's.
 */
function filedElsewhere(trace: MemoryTrace, scope: MemoryScope, scopeId: string): boolean {
  return typeof trace.scope === 'string' && typeof trace.scopeId === 'string' && (trace.scope !== scope || trace.scopeId !== scopeId);
}

/**
 * The scope id a trace's Brain row is filed under: its `scope_id`, or, for a row that holds `''` there (a release
 * older than the column wrote it), its metadata's `scopeId`; `''` for a row that names none.
 */
function rowScopeId(row: Pick<MemoryTraceRow, 'scope_id' | 'metadata'>): string {
  if (row.scope_id) return row.scope_id;
  const { scopeId } = parseTraceMetadata(row.metadata);
  return typeof scopeId === 'string' ? scopeId : '';
}

/**
 * Whether a trace's Brain row is filed under another scope than the one a read reaches the trace under: a row a move
 * filed under another scope id (a Brain's re-file or `refileScope`, in this process or another) while this store holds
 * the trace, or its vector document sits, under the old one, or a trace stored again under another scope. The read
 * does not return the trace there. A row that names no scope id is read as filed where the read reaches it.
 */
function rowFiledElsewhere(
  row: Pick<MemoryTraceRow, 'scope' | 'scope_id' | 'metadata'>,
  scope: MemoryScope,
  scopeId: string,
): boolean {
  if (row.scope !== scope) return true;
  const filed = rowScopeId(row);
  return filed !== '' && filed !== scopeId;
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
    // With no Brain the index is the trace's only record, so `deleteScope` with `turnUserId` reads the user here.
    ...(trace.turnUserId ? { turnUserId: trace.turnUserId } : {}),
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
 * The decay state of a Brain row, as a store loads a trace from the row: each field the row's `decay` lacks from the
 * store's defaults (the stability the row's metadata names, else 0.5; no access; a one-hour interval).
 *
 * @param meta - The row's metadata object.
 * @param accessState - Whether the store persists access state (`persistAccessState`). Without it, the row's `decay`
 *   is not read.
 */
function rowDecayState(meta: Record<string, any>, accessState: boolean): PersistedDecayState {
  const decay: Partial<PersistedDecayState> = accessState ? readPersistedDecayFields(meta) : {};
  return {
    stability: decay.stability ?? (typeof meta.stability === 'number' ? meta.stability : 0.5),
    accessCount: decay.accessCount ?? 0,
    reinforcementInterval: decay.reinforcementInterval ?? DEFAULT_REINFORCEMENT_INTERVAL_MS,
    ...(decay.nextReinforcementAt !== undefined ? { nextReinforcementAt: decay.nextReinforcementAt } : {}),
  };
}

/** Whether two decay states hold the same stability, access count, interval and next reinforcement time. */
function sameDecayState(a: PersistedDecayState, b: PersistedDecayState): boolean {
  return (
    a.stability === b.stability &&
    a.accessCount === b.accessCount &&
    a.reinforcementInterval === b.reinforcementInterval &&
    a.nextReinforcementAt === b.nextReinforcementAt
  );
}

/**
 * For each trace object a store holds, the decay state its Brain row held when the store took the trace (from the
 * row, from the trace's vector document, or from a caller through `store()`) or last wrote the row. An access that
 * finds another decay state in the row, which another writer gave it in between (the `Memory` facade's recall or
 * feedback, another store on the same Brain, a consolidation merge), counts on top of the row's state.
 */
const syncedDecayStates = new WeakMap<MemoryTrace, PersistedDecayState>();

/** A Brain row's access columns, which an access counted on top of the row's state reads. */
interface AccessColumns {
  strength: number | null;
  retrieval_count: number | null;
  last_accessed: number | null;
  created_at: number | null;
}

/** The number, where it is a finite one; else the fallback. */
function finiteOr(value: unknown, fallback: number): number {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : fallback;
}

/**
 * The trace after `accesses` accesses at the time of its last access, counted on top of the state its Brain row
 * holds: the row's decay state and its `strength`, `retrieval_count` and `last_accessed` columns.
 */
function accessedOnTopOf(
  trace: MemoryTrace,
  decay: PersistedDecayState,
  columns: AccessColumns,
  accesses: number,
): MemoryTrace {
  let state: MemoryTrace = {
    ...trace,
    stability: decay.stability,
    accessCount: decay.accessCount,
    reinforcementInterval: decay.reinforcementInterval,
    nextReinforcementAt: decay.nextReinforcementAt,
    encodingStrength: finiteOr(columns.strength, trace.encodingStrength),
    retrievalCount: finiteOr(columns.retrieval_count, 0),
    lastAccessedAt: finiteOr(columns.last_accessed, finiteOr(columns.created_at, trace.lastAccessedAt)),
  };
  for (let made = 0; made < accesses; made += 1) {
    state = { ...state, ...updateOnRetrieval(state, trace.lastAccessedAt) };
  }
  return state;
}

/** Gives a cached trace the access state of `from`: its strength, stability, counts and reinforcement schedule. */
function takeAccessState(trace: MemoryTrace, from: MemoryTrace): void {
  trace.encodingStrength = from.encodingStrength;
  trace.stability = from.stability;
  trace.retrievalCount = from.retrievalCount;
  trace.lastAccessedAt = from.lastAccessedAt;
  trace.accessCount = from.accessCount;
  trace.reinforcementInterval = from.reinforcementInterval;
  trace.nextReinforcementAt = from.nextReinforcementAt;
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
    ...(typeof metadata.turnUserId === 'string' && metadata.turnUserId ? { turnUserId: metadata.turnUserId } : {}),
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
  /** Present only when a query selects it (the check of traces against their Brain rows). */
  scope_id?: string | null;
}

/** What a check of traces against their Brain rows found (`reconcileDurableTraceStates`). */
interface DurableTraceStates {
  /** Whether the rows could be read: a read that fails recalls none of the traces. */
  ok: boolean;
  /** Each checked trace's row by trace id, as the check first read it: none for a trace with no row, or with no Brain. */
  rows: Map<string, MemoryTraceRow>;
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

/**
 * A trace deleted for good, as a store keeps it once its row is gone: where it was filed, so a later delete can evict
 * a document that stayed in the index, and none of what it said (its content, entities, tags, structured data and
 * linked traces). It stays inactive.
 */
function withoutWords(trace: MemoryTrace): MemoryTrace {
  return {
    ...trace,
    content: '',
    structuredData: undefined,
    entities: [],
    tags: [],
    associatedTraceIds: [],
    provenance: {
      sourceType: trace.provenance.sourceType,
      sourceTimestamp: trace.provenance.sourceTimestamp,
      confidence: trace.provenance.confidence,
      verificationCount: 0,
    },
    policy: undefined,
    isActive: false,
  };
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
  /** Drops the words of a trace deleted for good from the store's cache ({@link withoutWords}). */
  forgetDeleted: (traceId: string) => void;
  /** Moves what the store holds of the traces a Brain's re-file moved ({@link followBrainRefile}). */
  followRefile: (traces: readonly RefiledTrace[]) => Promise<void>;
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
  /**
   * Counts the moves of Brain rows (`refileScope`, a Brain's re-file), so a hydration reads a row again that a move
   * changed since its read.
   */
  refileEpoch: number;
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
      refileEpoch: 0,
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

/** Drops the words of a trace deleted for good from every live store on the backing resource, `source` included. */
function forgetDeletedTrace(namespace: object, traceId: string, source: StoreCoordinationTarget): void {
  const coordinator = getNamespaceCoordinator(namespace);
  const targets = new Set<StoreCoordinationTarget>([source]);
  for (const reference of coordinator.stores) {
    const target = reference.deref();
    if (target) targets.add(target);
    else coordinator.stores.delete(reference);
  }
  for (const target of targets) target.forgetDeleted(traceId);
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

/** The delete and refile counts of a namespace, taken when a hydration reads its rows. */
interface HydrationEpochs {
  deletes: number;
  refiles: number;
}

function hydrationEpochs(namespace: object): HydrationEpochs {
  const coordinator = getNamespaceCoordinator(namespace);
  return { deletes: coordinator.deleteEpoch, refiles: coordinator.refileEpoch };
}

/**
 * Tells every live store on a re-filed Brain in this process which traces the re-file moved, once it has committed
 * ({@link refileBrainScopeIds}): a hydration that read a row before the re-file reads it again before it loads it, and
 * each store moves what it holds of those traces. A store whose move fails is reported; a read of an old id does not
 * return a moved trace meanwhile, since its row is filed under the new id, and the store follows the Brain's rows
 * again when `ensureEncodedScopeIds` is called on it.
 */
async function followBrainRefile(coordinationToken: object, traces: readonly RefiledTrace[]): Promise<void> {
  const coordinator = namespaceCoordinators.get(coordinationToken);
  if (!coordinator) return;
  coordinator.refileEpoch += 1;
  const targets: StoreCoordinationTarget[] = [];
  for (const reference of coordinator.stores) {
    const target = reference.deref();
    if (target) targets.push(target);
    else coordinator.stores.delete(reference);
  }
  const outcomes = await Promise.allSettled(targets.map((target) => target.followRefile(traces)));
  const failed = outcomes.filter((outcome) => outcome.status === 'rejected').length;
  if (failed > 0) {
    console.warn(
      `[MemoryStore] ${failed} of ${targets.length} stores on a re-filed Brain could not move what they hold of the ` +
        `${traces.length} traces it moved; a read of an old scope id does not return them, and ensureEncodedScopeIds ` +
        'on such a store follows the Brain again',
    );
  }
}

onBrainRefiled(followBrainRefile);

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
  /** The per-scope hydrations under way ({@link hydrateScope}), which a Brain's re-file waits for before it follows. */
  private readonly scopeHydrations = new Set<Promise<number>>();
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
      forgetDeleted: (traceId) => this.forgetDeletedLocally(traceId),
      followRefile: (traces) => this.followRefileLocally(traces),
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

  /**
   * Keeps of a trace deleted for good only where it was filed ({@link withoutWords}). A trace revived since, which is
   * active again and no longer tombstoned, keeps what it holds.
   */
  private forgetDeletedLocally(traceId: string): void {
    if (!this.tombstonedTraceIds.has(traceId)) return;
    const trace = this.traceCache.get(traceId);
    if (trace?.isActive) return;
    this.embeddingCache.delete(traceId);
    if (trace) this.traceCache.set(traceId, withoutWords(trace));
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
      const synced = syncedDecayStates.get(trace);
      if (synced) syncedDecayStates.set(revivedTrace, synced);
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
                  last_accessed, retrieval_count, tags, emotions, metadata, deleted, scope_id
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

  /**
   * Checks traces against their Brain rows: a trace whose row is gone or deleted is fenced in every store on the
   * backing resource, and one whose row shows it revived is revived.
   *
   * @returns Whether the rows could be read, and the rows read, by trace id.
   */
  private async reconcileDurableTraceStates(
    traceIds: string[],
    namespace: object,
    brain: import('./Brain.js').Brain | null,
  ): Promise<DurableTraceStates> {
    if (!brain || traceIds.length === 0) return { ok: true, rows: new Map() };

    const initial = await this.getDurableTraceRows(traceIds, brain);
    if (!initial.ok) return { ok: false, rows: new Map() };

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
    return { ok: validationAvailable, rows: initial.rows };
  }

  /**
   * Return the subset of cached trace IDs that remain recallable after a
   * fail-closed durable-state check. Used by non-vector recall paths such as
   * graph association injection so a tombstone cannot bypass vector filters.
   * A trace whose Brain row a move filed under another scope id than the one
   * this store holds it under is not recallable until the store follows it.
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
    const durable = await this.reconcileDurableTraceStates(
      uniqueIds,
      this.coordinationNamespace,
      this.brain,
    );
    if (!durable.ok) return new Set();
    const readable = scopes?.length
      ? new Set(scopes.map(({ scope, scopeId }) => scopeKey(scope, scopeId)))
      : null;
    return new Set(
      uniqueIds.filter((traceId) => {
        const trace = this.traceCache.get(traceId);
        const row = durable.rows.get(traceId);
        return Boolean(
          trace?.isActive &&
          !this.tombstonedTraceIds.has(traceId) &&
          !isTraceDeletePending(this.coordinationNamespace, traceId) &&
          !(row && rowFiledElsewhere(row, trace.scope, trace.scopeId)) &&
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
    const epochs = hydrationEpochs(namespace);
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
      await this.hydrateRows(rows, brain, namespace, epochs);
    } catch {
      // Best-effort: durable hydration must never throw into recall.
    }
  }

  /**
   * Loads Brain rows into this store's cache and vector index, one trace operation per row, skipping a row a delete
   * blocks, a row already cached and a row with no usable embedding.
   *
   * @param epochs - The namespace's delete and refile counts when the rows were read: a row read before a delete or
   *   a move (`refileScope`) that has since run is read again before it loads, and loads as the Brain holds it then.
   * @returns How many rows it loaded.
   */
  private async hydrateRows(
    rows: MemoryTraceRow[],
    brain: import('./Brain.js').Brain,
    namespace: object,
    epochs: HydrationEpochs,
  ): Promise<number> {
    let loaded = 0;
    for (const bulkRow of rows) {
      const traceId = bulkRow.id;
      await withTraceOperation(
        namespace,
        traceId,
        'normal',
        async ({ blockedByDelete, isDeletePending }) => {
          if (
            blockedByDelete ||
            this.tombstonedTraceIds.has(traceId) ||
            this.traceCache.has(traceId)
          ) {
            return;
          }

          // A delete or a move may finish after the bulk SELECT but before this
          // row's operation slot. Read the row again only when one ran: a moved
          // row loads under the scope id it holds now.
          let row = bulkRow;
          const current = hydrationEpochs(namespace);
          if (current.deletes !== epochs.deletes || current.refiles !== epochs.refiles) {
            const fresh = await brain.get<MemoryTraceRow>(
              `SELECT id, type, scope, content, embedding, strength, created_at,
                      last_accessed, retrieval_count, tags, emotions, metadata
                 FROM memory_traces
                WHERE brain_id = ? AND id = ? AND deleted = 0`,
              [brain.brainId, traceId],
            );
            if (!fresh) return;
            row = fresh;
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

          if (isDeletePending() || this.tombstonedTraceIds.has(traceId)) {
            try {
              await this.config.vectorStore.delete(collection, [traceId]);
            } catch {
              // The queued delete retries after this operation releases.
            }
            return;
          }

          this.traceCache.set(trace.id, trace);
          this.embeddingCache.set(trace.id, embedding);
          this.registerScope(trace.scope, trace.scopeId);
          loaded += 1;
        },
      );
    }
    return loaded;
  }

  /**
   * Reconstruct a MemoryTrace from a durable Brain row (inverse of the store() write-through).
   * With `persistAccessState` on, the stability, access count, reinforcement interval and next
   * reinforcement time come from the row's `metadata.decay` (written by this store or by the
   * `Memory` facade), and any of them it lacks from the store's own defaults.
   */
  private rowToTrace(row: MemoryTraceRow): MemoryTrace {
    const meta = (row.metadata ? safeParseJson<Record<string, any>>(row.metadata) : undefined) ?? {};
    const decay = rowDecayState(meta, this.persistsAccessState);
    const emotions =
      (row.emotions ? safeParseJson<MemoryTrace['emotionalContext']>(row.emotions) : undefined) ?? {
        valence: 0,
        arousal: 0,
        dominance: 0,
        intensity: 0,
        gmiMood: '',
      };
    const tags = (row.tags ? safeParseJson<string[]>(row.tags) : undefined) ?? [];
    const trace = {
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
      stability: decay.stability,
      retrievalCount: row.retrieval_count ?? 0,
      lastAccessedAt: row.last_accessed ?? row.created_at,
      accessCount: decay.accessCount,
      reinforcementInterval: decay.reinforcementInterval,
      ...(decay.nextReinforcementAt !== undefined
        ? { nextReinforcementAt: decay.nextReinforcementAt }
        : {}),
      associatedTraceIds: Array.isArray(meta.associatedTraceIds) ? (meta.associatedTraceIds as string[]) : [],
      createdAt: row.created_at,
      updatedAt: row.created_at,
      isActive: true,
      importance: typeof meta.importance === 'number' ? meta.importance : undefined,
      structuredData: meta.structuredData,
      ...(typeof meta.turnUserId === 'string' && meta.turnUserId ? { turnUserId: meta.turnUserId } : {}),
    } as MemoryTrace;
    syncedDecayStates.set(trace, decay);
    return trace;
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
          turnUserId: trace.turnUserId,
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
        syncedDecayStates.set(trace, decayStateOf(trace));
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

    // Record in knowledge graph as episodic memory.
    await this.recordGraphCopy(trace, embedding);

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
      const localStateAvailable = (await this.reconcileDurableTraceStates(
        [...this.tombstonedTraceIds],
        namespace,
        brain,
      )).ok;
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

        const durable = await this.reconcileDurableTraceStates(
          results.documents.map((document) => document.id),
          namespace,
          brain,
        );
        if (!durable.ok) continue;

        const staleDocuments: string[] = [];
        for (const result of results.documents) {
          if (
            this.tombstonedTraceIds.has(result.id) ||
            isTraceDeletePending(namespace, result.id)
          ) {
            continue;
          }
          const tracePartial = metadataToTracePartial(result.metadata ?? {}, this.persistsAccessState);
          const cached = this.traceCache.get(result.id);
          // A document left in a collection its trace has moved out of (`refileScope`, whose delete of the old
          // document failed) is not the trace's: this store holds the trace under another scope.
          if (cached && filedElsewhere(cached, scope, scopeId)) {
            continue;
          }
          // Nor is one whose Brain row a move filed under another scope id, in this process or another: a store that
          // holds the trace has not followed the move yet, and the document of a trace it does not hold is stale.
          const row = durable.rows.get(result.id);
          if (row && rowFiledElsewhere(row, scope, scopeId)) {
            if (!cached) staleDocuments.push(result.id);
            continue;
          }

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
              // A document of this collection is a trace of its scope.
              scope,
              scopeId,
            } as MemoryTrace);

          // Treat the in-memory tombstone as authoritative. A best-effort
          // vector-store update can fail after softDelete(), leaving a stale
          // document whose metadata still says it is active.
          if (!trace.isActive) {
            continue;
          }

          if (!cached) {
            syncedDecayStates.set(trace, decayStateOf(trace));
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
        if (staleDocuments.length > 0) await this.deleteStaleDocuments(collection, staleDocuments);
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
    const before = decayStateOf(trace);
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
        await this.persistAccess(brain, trace, before);
      } catch {
        // Best-effort persistence
      }
    }

    if (!trace.isActive) return null;
    // An access counted on top of another writer's row state (persistAccess) leaves the trace's values, not the update's.
    return {
      encodingStrength: trace.encodingStrength,
      stability: trace.stability,
      retrievalCount: trace.retrievalCount,
      lastAccessedAt: trace.lastAccessedAt,
      accessCount: trace.accessCount,
      reinforcementInterval: trace.reinforcementInterval,
      nextReinforcementAt: trace.nextReinforcementAt ?? update.nextReinforcementAt,
    };
  }

  /**
   * Writes an accessed trace's state to its Brain row: `last_accessed`, `retrieval_count` and
   * `strength`, and, with `persistAccessState` on, its decay state merged into the row's own
   * metadata JSON under `decay`, every other key of the row kept. When the row's decay state is no
   * longer the one the store took the trace with or last wrote, another writer changed it in
   * between (the `Memory` facade's recall or feedback, another store on the same Brain, a
   * consolidation merge): the accesses the store made since then count on top of the row's decay
   * state and its three columns, and the cached trace takes the result. The merge is a
   * compare-and-set on the JSON text it read, tried twice, so a key another writer set in between
   * is not lost; after two lost races, and for a row whose metadata is not a JSON object, the
   * columns alone are written and the metadata is left as it is.
   *
   * @param before - The trace's decay state before this access, which the access counts from when
   *   the store holds no state it took the trace with.
   */
  private async persistAccess(
    brain: import('./Brain.js').Brain,
    trace: MemoryTrace,
    before: PersistedDecayState,
  ): Promise<void> {
    const writeColumns = () =>
      brain.run(
        'UPDATE memory_traces SET last_accessed = ?, retrieval_count = ?, strength = ? WHERE brain_id = ? AND id = ? AND deleted = 0',
        [trace.lastAccessedAt, trace.retrievalCount, trace.encodingStrength, brain.brainId, trace.id],
      );
    if (!this.persistsAccessState) {
      await writeColumns();
      return;
    }
    const synced = syncedDecayStates.get(trace) ?? before;
    const made = trace.accessCount - synced.accessCount;
    const accesses = Number.isFinite(made) && made > 1 ? made : 1;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const row = await brain.get<{ metadata: string | null }>(
        'SELECT metadata FROM memory_traces WHERE brain_id = ? AND id = ? AND deleted = 0',
        [brain.brainId, trace.id],
      );
      if (!row) return;
      const meta: unknown = row.metadata ? safeParseJson<unknown>(row.metadata) : {};
      if (!isJsonObject(meta)) break;
      let written = trace;
      const held = rowDecayState(meta, true);
      if (!sameDecayState(held, synced)) {
        const heldColumns = await brain.get<AccessColumns>(
          'SELECT strength, retrieval_count, last_accessed, created_at FROM memory_traces WHERE brain_id = ? AND id = ? AND deleted = 0',
          [brain.brainId, trace.id],
        );
        if (!heldColumns) return;
        written = accessedOnTopOf(trace, held, heldColumns, accesses);
      }
      const next = JSON.stringify(withPersistedDecayState(meta, decayStateOf(written)));
      const columns = [written.lastAccessedAt, written.retrievalCount, written.encodingStrength];
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
      if (result.changes > 0) {
        if (written !== trace) takeAccessState(trace, written);
        syncedDecayStates.set(trace, decayStateOf(trace));
        return;
      }
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
    const cachedState = await this.reconcileDurableTraceStates(
      [
        ...results.map((trace) => trace.id),
        ...this.tombstonedTraceIds,
      ],
      namespace,
      brain,
    );
    if (!cachedState.ok) return [];
    // Reconciliation can revive a trace while waiting behind an in-flight
    // store. Refresh the snapshot so that revival is visible in this call.
    // A trace whose Brain row a move filed under another scope id is not
    // listed under this one until the store follows the move.
    results = collectCachedResults().filter((trace) => {
      const row = cachedState.rows.get(trace.id);
      return !(row && rowFiledElsewhere(row, scope, scopeId));
    });

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
        const providerState = await this.reconcileDurableTraceStates(
          queryResult.documents.map((document) => document.id),
          namespace,
          brain,
        );
        if (!providerState.ok) return [];
        const staleDocuments: string[] = [];
        for (const doc of queryResult.documents) {
          if (
            this.tombstonedTraceIds.has(doc.id) ||
            isTraceDeletePending(namespace, doc.id)
          ) {
            continue;
          }
          if (!doc.metadata) continue;
          const cached = this.traceCache.get(doc.id);
          // A document whose Brain row a move filed under another scope id is not the scope's; one of a trace this
          // store does not hold is stale.
          const row = providerState.rows.get(doc.id);
          if (row && rowFiledElsewhere(row, scope, scopeId)) {
            if (!cached) staleDocuments.push(doc.id);
            continue;
          }
          if (cached) {
            // A document left behind in a collection its trace moved out of lists the trace under its own scope only.
            if (cached.isActive && !filedElsewhere(cached, scope, scopeId)) {
              results.push(cached);
            }
          } else {
            // A document of this collection is a trace of its scope.
            const trace: MemoryTrace = { ...this.traceFromVectorDocument(doc), scope, scopeId };
            if (!trace.isActive) continue;
            syncedDecayStates.set(trace, decayStateOf(trace));
            this.traceCache.set(trace.id, trace);
            results.push(trace);
          }
        }
        if (staleDocuments.length > 0) await this.deleteStaleDocuments(collection, staleDocuments);
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
   * Loads one scope's most recent traces from the Brain by the `scope_id` column, so a returning learner's
   * memories are recallable however many traces other scopes hold (the whole-brain hydration loads the
   * {@link MemoryStore.HYDRATION_LIMIT} most recent of the brain). A trace already loaded is skipped. A row a release
   * older than the column wrote since the Brain opened holds `''` there until the next open files it; the whole-brain
   * hydration loads it meanwhile while it is among the brain's most recent.
   *
   * @param limit - How many of the scope's most recent traces to read: a positive integer.
   * @returns How many traces it loaded.
   * @throws RangeError when `limit` is not a positive integer.
   */
  async hydrateScope(scope: MemoryScope, scopeId: string, limit: number = MemoryStore.HYDRATION_LIMIT): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`MemoryStore.hydrateScope: limit must be a positive integer, got ${limit}`);
    }
    this.beginOperation();
    const brain = this.brain;
    if (!brain) return 0;
    const hydration = this.hydrateScopeRows(brain, scope, scopeId, limit);
    this.scopeHydrations.add(hydration);
    try {
      return await hydration;
    } finally {
      this.scopeHydrations.delete(hydration);
    }
  }

  /** The read and the load of {@link hydrateScope}. */
  private async hydrateScopeRows(
    brain: import('./Brain.js').Brain,
    scope: MemoryScope,
    scopeId: string,
    limit: number,
  ): Promise<number> {
    const namespace = this.coordinationNamespace;
    const epochs = hydrationEpochs(namespace);
    const rows = await brain.all<MemoryTraceRow>(
      `SELECT id, type, scope, content, embedding, strength, created_at,
              last_accessed, retrieval_count, tags, emotions, metadata
         FROM memory_traces
        WHERE brain_id = ? AND scope = ? AND scope_id = ? AND deleted = 0
        ORDER BY created_at DESC
        LIMIT ?`,
      [brain.brainId, scope, scopeId, limit],
    );
    return this.hydrateRows(rows, brain, namespace, epochs);
  }

  /**
   * Moves one scope id's traces to another. Every Brain row filed under it moves, soft-deleted rows included
   * (`scope_id` and the metadata's `scopeId`), so a later delete of the new id finds them all. Each live trace this
   * store holds moves with its vector document, from the old collection into the new one; a trace it does not hold
   * leaves the old collection, and a store files it in the new one when it loads it ({@link hydrateScope}, or the
   * whole-brain hydration). A live trace's knowledge-graph copy, where the graph holds one, is recorded again under the
   * new id. With no Brain the vector index is the scope's record, so the old collection is walked from its start
   * ({@link walkScopeCollection}) and the documents another store filed into it before a restart move too; a stale
   * document there, of a trace this store holds under another scope, is deleted from it. A vector the
   * store holds no embedding for is read from the trace's Brain row or from the index, or embedded again. A document the
   * index fails to delete from the old collection stays, with a warning; recall under the old id does not return it,
   * since this store holds the trace under the new one. Another store open on the same Brain keeps what it holds under
   * the old id until it re-files the scope itself or loads it again. A trace this store holds under the old id whose
   * row another store or process moved to another scope or a third id, or deleted for good, before this move or while
   * it runs, stays as this store holds it, and is not counted: a deleted trace's words go into no collection.
   *
   * A host that starts passing an organization id re-files each user's earlier traces with it once, since a learner
   * under a namespace reads `user:<namespace>/<userId>` and not the plain form filed before.
   *
   * A Brain row's metadata is written with a compare against what the move read, so a write another writer makes to
   * the row meanwhile (a facade's recall, feedback or update) is read again and kept. A hydration of this store, or of
   * another store on the same Brain in this process, that read a row before the move reads it again before it loads
   * it, so the trace loads under the new id.
   *
   * @returns The number of traces moved: Brain rows, soft-deleted ones included, and the live traces the store held
   *   or the index listed under the old id with no row.
   * @throws TypeError when either scope id is empty, so a caller's missing id never moves the traces filed under no
   *   scope id or files a scope's traces under none.
   * @throws When a live trace's vector cannot be embedded or written into the new collection, or a Brain row cannot
   *   be read or written or kept changing through three reads; the traces moved before it stay moved, and a call made
   *   again moves the rest. A row moves before its trace's vector, so a store that reads the new id meanwhile finds no
   *   document there yet rather than one its row does not name: a trace whose vector could not be written has its row
   *   under the new id, this store reads it under neither id, and the call made again moves the vector.
   */
  async refileScope(scope: MemoryScope, fromScopeId: string, toScopeId: string): Promise<number> {
    for (const [name, value] of [['fromScopeId', fromScopeId], ['toScopeId', toScopeId]] as const) {
      if (typeof value !== 'string' || value === '') {
        throw new TypeError(`MemoryStore.refileScope: ${name} must be a non-empty string`);
      }
    }
    this.beginOperation();
    if (fromScopeId === toScopeId) return 0;
    const brain = this.brain;
    const namespace = this.coordinationNamespace;
    let moved = 0;
    const move = async (traceIds: readonly string[]): Promise<void> => {
      for (const traceId of traceIds) {
        await withTraceOperation(namespace, traceId, 'normal', async ({ blockedByDelete }) => {
          if (blockedByDelete) return;
          if (await this.refileTraceWithTraceLock(traceId, scope, fromScopeId, toScopeId, brain)) moved += 1;
        });
      }
    };
    await move(await this.scopeTraceIds(scope, fromScopeId, { heldWhereverFiled: true }));
    // A stale copy at the old collection's front, of a trace this store holds under another scope, goes, so the walk
    // reaches the scope's traces after it on an index that lists a collection from its start.
    if (!brain) await this.walkScopeCollection(scope, fromScopeId, move, { withEmbeddings: true, dropStale: () => true });
    const stillFiled = [...this.traceCache.values()].some(
      (trace) => trace.isActive && trace.scope === scope && trace.scopeId === fromScopeId,
    );
    if (!stillFiled) this.knownScopes.delete(scopeKey(scope, fromScopeId));
    return moved;
  }

  /**
   * Puts this store's Brain in the encoded form a learning layer reads the first time a layer opens it
   * ({@link refileBrainScopeIds}). Once the re-file has committed, every live store on the Brain in this process, this
   * one included, moves what it holds of the traces the re-file moved, and of those alone: a row filed under an old id
   * after the re-file is a namespaced learner's, and stays where it is. Then, whoever re-filed the Brain (this call,
   * another handle or another process), this store follows the Brain's rows: each trace it holds under a `user` or
   * `persona` id that the encoded form would change moves to the scope id its row holds, and one whose row holds the
   * id as it is stays, since a namespaced id holds a `/` too. A hydration under way loads its rows as the Brain holds
   * them after the re-file. Until a store follows, a read of an old id does not return a trace whose row moved. A store
   * with no Brain has nothing to re-file.
   *
   * @returns How many Brain rows this call's re-file moved: none when the Brain held the record already.
   * @throws When the re-file fails (its transaction rolls back, and a later call re-files the Brain), or when this
   *   store cannot read the rows of the traces it holds or move one into its new collection.
   */
  async ensureEncodedScopeIds(): Promise<number> {
    this.beginOperation();
    const brain = this.brain;
    if (!brain) return 0;
    const result = await refileBrainScopeIds(brain);
    // The re-file's own move of this store's traces is reported, not thrown; this pass makes a move that failed there,
    // or one another handle or process made, and throws when it cannot.
    await this.followBrainRows(brain);
    return result.alreadyEncoded ? 0 : result.moved.reduce((sum, pair) => sum + pair.traces, 0);
  }

  /**
   * Follows the Brain's rows after a re-file, whoever made it ({@link ensureEncodedScopeIds}): once the hydrations
   * under way have loaded what they read, each trace this store holds under a `user` or `persona` id that the encoded
   * form would change is read against its Brain row, and one whose row is filed under another scope id moves there
   * ({@link followRefiledTraceWithTraceLock}). One whose row holds the id as it is stays: a namespaced id holds a `/`
   * too, and an id this store holds is never encoded again.
   *
   * @throws When the rows cannot be read, or a trace cannot move into its new collection.
   */
  private async followBrainRows(brain: import('./Brain.js').Brain): Promise<void> {
    const namespace = this.coordinationNamespace;
    // A hydration that read a row before the re-file reads it again before it loads it.
    getNamespaceCoordinator(namespace).refileEpoch += 1;
    await this.settleHydrations();
    const candidates = [...this.traceCache.values()].filter(
      (trace) =>
        (trace.scope === 'user' || trace.scope === 'persona') &&
        typeof trace.scopeId === 'string' &&
        trace.scopeId !== '' &&
        encodePlainScopeId(trace.scope, trace.scopeId) !== trace.scopeId,
    );
    if (candidates.length === 0) return;
    const { ok, rows } = await this.getDurableTraceRows(candidates.map((trace) => trace.id), brain);
    if (!ok) {
      throw new Error('MemoryStore.ensureEncodedScopeIds: could not read the Brain rows of the traces this store holds');
    }
    for (const trace of candidates) {
      const row = rows.get(trace.id);
      if (!row || row.scope !== trace.scope) continue;
      const to = rowScopeId(row);
      if (to === '' || to === trace.scopeId) continue;
      const moved: RefiledTrace = { id: trace.id, scope: trace.scope, from: trace.scopeId, to };
      await withTraceOperation(namespace, trace.id, 'normal', async ({ blockedByDelete }) => {
        if (blockedByDelete) return;
        await this.followRefiledTraceWithTraceLock(moved);
      });
    }
  }

  /**
   * Moves what this store holds of the traces a Brain's re-file moved ({@link followBrainRefile}): once the hydrations
   * under way have loaded what they read, each trace it holds under the old id moves with its vector document and its
   * knowledge-graph copy ({@link followRefiledTraceWithTraceLock}), and the old collection's documents of the other
   * moved traces go, since their rows are filed under the new id.
   *
   * @throws When a trace it holds cannot move into its new collection; the traces before it stay moved.
   */
  private async followRefileLocally(traces: readonly RefiledTrace[]): Promise<void> {
    await this.settleHydrations();
    const namespace = this.coordinationNamespace;
    const unheld = new Map<string, string[]>();
    for (const moved of traces) {
      const cached = this.traceCache.get(moved.id);
      if (cached && cached.scope === moved.scope && cached.scopeId === moved.from) {
        await withTraceOperation(namespace, moved.id, 'normal', async ({ blockedByDelete }) => {
          if (blockedByDelete) return;
          await this.followRefiledTraceWithTraceLock(moved);
        });
        continue;
      }
      const collection = collectionName(this.config.collectionPrefix, moved.scope as MemoryScope, moved.from);
      const ids = unheld.get(collection) ?? [];
      ids.push(moved.id);
      unheld.set(collection, ids);
    }
    for (const [collection, ids] of unheld) await this.deleteMovedDocuments(collection, ids);
  }

  /**
   * Moves one trace a Brain's re-file moved that this store holds under the old id, inside the trace's operation: a
   * live trace's vector document moves into the new collection, with the vector the store holds, its row's, or a new
   * embedding; then the store's copy takes the new id, and the trace's knowledge-graph copy is recorded again under it
   * where the graph holds one under another ({@link followGraphCopy}). A trace the store no longer holds under the old
   * id is left as it is, and so is one whose Brain row is gone, deleted for good by another store or process once the
   * re-file committed: its words go into no collection.
   *
   * @returns Whether it moved the trace.
   */
  private async followRefiledTraceWithTraceLock(moved: RefiledTrace): Promise<boolean> {
    const scope = moved.scope as MemoryScope;
    const held = this.traceCache.get(moved.id);
    if (!held || held.scope !== scope || held.scopeId !== moved.from) return false;
    let rowEmbedding: unknown;
    if (this.brain) {
      const durable = await this.getDurableTraceRows([moved.id]);
      // A trace whose row is gone was deleted for good once the re-file committed, by another store or process: none
      // of its words go into the new collection or the graph.
      if (durable.ok && !durable.rows.has(moved.id)) return false;
      rowEmbedding = durable.rows.get(moved.id)?.embedding;
    }
    const live = held.isActive && !this.tombstonedTraceIds.has(moved.id);
    const trace: MemoryTrace = { ...held, scope, scopeId: moved.to };
    let embedding: number[] | undefined;
    if (live) {
      embedding = await this.writeMovedDocument(trace, rowEmbedding, 'ensureEncodedScopeIds');
      await this.deleteMovedDocument(
        collectionName(this.config.collectionPrefix, scope, moved.from),
        moved.id,
        'ensureEncodedScopeIds',
      );
    }
    held.scopeId = moved.to;
    held.updatedAt = Date.now();
    if (embedding) this.embeddingCache.set(moved.id, embedding);
    if (held.isActive) this.registerScope(scope, moved.to);
    if (live) await this.followGraphCopy(trace, embedding);
    return true;
  }

  /**
   * Records a moved trace's knowledge-graph copy again under the scope id it moved to, where the graph holds a copy
   * filed under another: the Brain's own SQL graph had its copies moved with the rows by the re-file, and keeps them,
   * with the relations that name them, as they are. A trace with no copy gets none.
   */
  private async followGraphCopy(trace: MemoryTrace, embedding: number[] | undefined): Promise<void> {
    const graph = this.config.knowledgeGraph;
    if (typeof graph.deleteMemories !== 'function') return;
    try {
      const copy = await graph.getMemory(copyKey(trace.id));
      if ((copy?.context as { scopeId?: unknown } | undefined)?.scopeId === trace.scopeId) return;
      if ((await graph.deleteMemories({ traceIds: [trace.id] })) > 0) await this.recordGraphCopy(trace, embedding);
    } catch {
      // The copy stays under the old id, where a delete by the trace's id still finds it.
    }
  }

  /** Waits for the hydrations under way to load what they read: the whole-brain one and each per-scope one. */
  private async settleHydrations(): Promise<void> {
    await Promise.allSettled([...(this.brainHydration ? [this.brainHydration] : []), ...this.scopeHydrations]);
  }

  /**
   * Deletes from the collection a Brain's re-file moved them out of the documents of moved traces this store does not
   * hold there, a page at a time. A delete the index fails is reported, not thrown: a read of the old id skips and
   * deletes such a document, since its row is filed under the new id.
   */
  private async deleteMovedDocuments(collection: string, traceIds: readonly string[]): Promise<void> {
    const vectorStore = this.config.vectorStore;
    try {
      if (vectorStore.collectionExists && !(await vectorStore.collectionExists(collection))) return;
    } catch {
      // An index that cannot say whether it holds the collection: the delete finds out.
    }
    let failed = 0;
    for (let offset = 0; offset < traceIds.length; offset += MOVED_DOCUMENT_DELETE_PAGE_SIZE) {
      const page = traceIds.slice(offset, offset + MOVED_DOCUMENT_DELETE_PAGE_SIZE);
      try {
        failed += (await vectorStore.delete(collection, page))?.failedCount ?? 0;
      } catch {
        failed += page.length;
      }
    }
    if (failed > 0) {
      console.warn(
        `[MemoryStore] could not delete ${failed} documents of traces a Brain's re-file moved from the collection they ` +
          'moved out of; a read of the old scope id skips and deletes them, since their rows are filed under the new one',
      );
    }
  }

  /**
   * Moves one trace of {@link refileScope}, inside the trace's operation. A trace no longer filed under the old id, in
   * the Brain or in this store, is left as it is. A trace this store holds under the old id whose row is filed under
   * the new id already (a move of this scope that wrote the row and stopped before the vector) moves with its vector
   * document; one whose row is filed under another scope or a third id (a move another store or process made) stays as
   * this store holds it, and so does one whose row is gone, before the move or while it runs (a delete for good another
   * store or process made): its words go into no collection.
   *
   * @returns Whether it moved the trace.
   */
  private async refileTraceWithTraceLock(
    traceId: string,
    scope: MemoryScope,
    fromScopeId: string,
    toScopeId: string,
    brain: import('./Brain.js').Brain | null,
  ): Promise<boolean> {
    let read: (MemoryTraceRow & { scope_id: string | null }) | null | undefined;
    let row: (MemoryTraceRow & { scope_id: string | null }) | null = null;
    if (brain) {
      read = await brain.get<MemoryTraceRow & { scope_id: string | null }>(
        `SELECT id, type, scope, content, embedding, strength, created_at,
                last_accessed, retrieval_count, tags, emotions, metadata, deleted, scope_id
           FROM memory_traces
          WHERE brain_id = ? AND id = ?`,
        [brain.brainId, traceId],
      );
      // A trace with no row was deleted for good, by this store or another writer: none of its words go into the new
      // collection or the graph.
      if (!read) return false;
      const filed = read.scope === scope ? (read.scope_id ?? '') : undefined;
      if (filed !== fromScopeId && filed !== toScopeId) return false;
      if (filed === fromScopeId) row = read;
    }
    const cached = this.traceCache.get(traceId);
    const held = cached && cached.scope === scope && cached.scopeId === fromScopeId ? cached : undefined;
    if (!row && !held) return false;
    const live = !this.tombstonedTraceIds.has(traceId) && (read ? read.deleted !== 1 : held!.isActive);
    // A deleted trace with no row left under the old id to move stays as it is.
    if (!row && !live) return false;
    const trace: MemoryTrace = { ...(held ?? this.rowToTrace(row!)), scope, scopeId: toScopeId };
    const fromCollection = collectionName(this.config.collectionPrefix, scope, fromScopeId);

    // The row moves first, as a Brain's re-file moves its rows. A document in the new collection whose row still named
    // the old id would be stale to a store on the same Brain or index that reads the new id meanwhile, and such a store
    // deletes a stale document it reads ({@link query}, {@link getByScope}); with the row moved, it finds no document
    // there yet, and the old collection's document is stale.
    if (row && brain) {
      if (await this.refileRow(brain, row.metadata, traceId, scope, fromScopeId, toScopeId)) {
        // A hydration that read this row before the move reads it again before it loads it.
        getNamespaceCoordinator(this.coordinationNamespace).refileEpoch += 1;
      } else {
        // Another writer moved the row meanwhile: to the new id, a move of this scope, which this one finishes; to
        // another scope or a third id, a move this one leaves. A row deleted meanwhile was deleted for good.
        const moved = await brain.get<{ scope: string; scope_id: string | null }>(
          'SELECT scope, scope_id FROM memory_traces WHERE brain_id = ? AND id = ?',
          [brain.brainId, traceId],
        );
        if (!moved || moved.scope !== scope || (moved.scope_id ?? '') !== toScopeId) return false;
      }
    }

    // A live trace this store holds takes its document into the new collection. When that fails, its row is filed
    // under the new id already, this store reads the trace under neither id, and a call made again moves the document.
    let embedding: number[] | undefined;
    if (live && held) embedding = await this.writeMovedDocument(trace, read?.embedding, 'refileScope');

    if (live) await this.deleteMovedDocument(fromCollection, traceId);
    if (held) {
      held.scopeId = toScopeId;
      held.updatedAt = Date.now();
      if (embedding) this.embeddingCache.set(traceId, embedding);
      if (held.isActive) this.registerScope(scope, toScopeId);
    }

    // The copy follows its trace where the graph holds one; a trace with no copy gets none.
    if (live) {
      let copies = 0;
      try {
        copies = (await this.config.knowledgeGraph.deleteMemories?.({ traceIds: [traceId] })) ?? 0;
      } catch {
        // The copy stays under the old id, where a delete by the trace's id still finds it.
      }
      if (copies > 0) await this.recordGraphCopy(trace, embedding ?? blobToEmbedding(read?.embedding) ?? undefined);
    }
    return true;
  }

  /**
   * Writes a moved trace's Brain row under its new scope id: the column and the metadata's `scopeId`. The update
   * compares the metadata with what was read, so a write another writer made to the row since is read again and kept,
   * three reads at most. A row gone or filed elsewhere meanwhile is left as it is.
   *
   * @returns Whether it wrote the row.
   * @throws When the row changed under each of three reads.
   */
  private async refileRow(
    brain: import('./Brain.js').Brain,
    metadata: string | null,
    traceId: string,
    scope: MemoryScope,
    fromScopeId: string,
    toScopeId: string,
  ): Promise<boolean> {
    let current = metadata;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = parseTraceMetadata(current);
      next.scopeId = toScopeId;
      const result = await brain.run(
        `UPDATE memory_traces SET scope_id = ?, metadata = ?
          WHERE brain_id = ? AND id = ? AND scope = ? AND scope_id = ? AND ${current === null ? 'metadata IS NULL' : 'metadata = ?'}`,
        [toScopeId, JSON.stringify(next), brain.brainId, traceId, scope, fromScopeId, ...(current === null ? [] : [current])],
      );
      if (result.changes > 0) return true;
      const reread = await brain.get<{ scope: string; scope_id: string | null; metadata: string | null }>(
        'SELECT scope, scope_id, metadata FROM memory_traces WHERE brain_id = ? AND id = ?',
        [brain.brainId, traceId],
      );
      if (!reread || reread.scope !== scope || (reread.scope_id ?? '') !== fromScopeId) return false;
      current = reread.metadata;
    }
    throw new Error(`MemoryStore.refileScope: trace ${traceId}'s row changed under each of three reads while it moved`);
  }

  /**
   * Writes a moved trace's vector document into the collection of the scope id it moved to (`trace.scopeId`), with the
   * vector the store holds, the one its Brain row holds, or a new embedding of its text.
   *
   * @param operation - The public call the move serves, named in an error.
   * @returns The vector it wrote.
   * @throws When no vector can be had, or the vector index refuses the document.
   */
  private async writeMovedDocument(trace: MemoryTrace, rowEmbedding: unknown, operation: string): Promise<number[]> {
    const embedding =
      this.embeddingCache.get(trace.id) ?? blobToEmbedding(rowEmbedding) ?? (await this.embedText(trace.content));
    if (!embedding) {
      throw new Error(`MemoryStore.${operation}: the embedding manager returned no vector for trace ${trace.id}`);
    }
    const toCollection = collectionName(this.config.collectionPrefix, trace.scope, trace.scopeId);
    try {
      const exists = this.config.vectorStore.collectionExists
        ? await this.config.vectorStore.collectionExists(toCollection)
        : true;
      if (!exists) {
        await this.config.vectorStore.createCollection?.(
          toCollection,
          this.config.embeddingDimension ?? embedding.length,
          { overwriteIfExists: false },
        );
      }
    } catch {
      // Some providers auto-create collections.
    }
    const result = await this.config.vectorStore.upsert(toCollection, [
      { id: trace.id, textContent: trace.content, embedding, metadata: traceToMetadata(trace, this.persistsAccessState) },
    ]);
    if ((result?.failedCount ?? 0) > 0) {
      throw new Error(`MemoryStore.${operation}: the vector index refused trace ${trace.id} in its new collection`);
    }
    return embedding;
  }

  /**
   * Deletes a moved trace's document from the collection it left; a delete the index fails is reported, not thrown.
   *
   * @param operation - The public call the move serves, named in the report.
   */
  private async deleteMovedDocument(collection: string, traceId: string, operation = 'refileScope'): Promise<void> {
    const vectorStore = this.config.vectorStore;
    try {
      if (vectorStore.collectionExists && !(await vectorStore.collectionExists(collection))) return;
      const result = await vectorStore.delete(collection, [traceId]);
      if ((result?.failedCount ?? 0) === 0) return;
    } catch {
      // Reported below.
    }
    console.warn(
      `[MemoryStore] ${operation} could not delete trace ${traceId}'s document from the collection it moved out of; ` +
        'recall under the old scope id skips it, since the store holds the trace under the new one',
    );
  }

  /** The embedding of a text, or `undefined` when the embedding manager returns no usable vector. */
  private async embedText(text: string): Promise<number[] | undefined> {
    const response = await this.config.embeddingManager.generateEmbeddings({ texts: text });
    const embedding = response.embeddings[0];
    return isUsableEmbedding(embedding) ? embedding : undefined;
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
   * next opens. Last, every store on the backing resource in this process, this one included, keeps of each trace
   * only where it was filed, none of its words ({@link withoutWords}).
   *
   * A trace this store holds under another scope than its Brain row names (a move another process made, which this
   * store has not followed) also leaves the collection its row names, where that process filed its document.
   *
   * With no Brain, the traces this store holds are the ones it reaches: an id the vector index holds of a trace this
   * store never loaded names no collection, and `deleteScope` is what finds such a trace.
   *
   * @param traceIds - Trace ids; unknown ids are skipped.
   * @param options.beforeDelete - Runs with the ids of the traces found (a Brain row or a trace this store holds)
   *   before any of them is deleted, and not at all when none is found. The memory manager removes what it keeps of
   *   each trace there, so a call that fails part way finds the same traces again.
   * @returns How many of them had a Brain row or a live cached trace, so a second call for the same ids counts none.
   * @throws When the Brain cannot be read or a row cannot be deleted, or what `beforeDelete` throws.
   */
  async deleteTraces(
    traceIds: readonly string[],
    options: { beforeDelete?: (traceIds: readonly string[]) => Promise<void> } = {},
  ): Promise<number> {
    this.beginOperation();
    const ids = [...new Set(traceIds)];
    if (ids.length === 0) return 0;
    const brain = this.brain;
    // A trace an earlier delete ended stays cached, inactive: it is evicted again, so a call made again retries an
    // eviction that failed, and it counts only when it still has a row.
    const counted = new Set(ids.filter((id) => this.traceCache.get(id)?.isActive === true));
    const known = new Set(ids.filter((id) => this.traceCache.has(id)));
    const rowIds: string[] = [];
    const rows = new Map<string, Pick<MemoryTraceRow, 'scope' | 'scope_id' | 'metadata'>>();
    if (brain) {
      try {
        for (let offset = 0; offset < ids.length; offset += 400) {
          const chunk = ids.slice(offset, offset + 400);
          const found = await brain.all<Pick<MemoryTraceRow, 'id' | 'scope' | 'scope_id' | 'metadata'>>(
            `SELECT id, scope, scope_id, metadata FROM memory_traces WHERE brain_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`,
            [brain.brainId, ...chunk],
          );
          for (const row of found) {
            rowIds.push(row.id);
            rows.set(row.id, row);
          }
        }
      } catch {
        throw new Error('MemoryStore.deleteTraces: the Brain could not be read');
      }
      for (const id of rowIds) {
        counted.add(id);
        known.add(id);
      }
    }
    if (known.size === 0) return 0;
    await options.beforeDelete?.([...known]);
    for (const id of known) {
      try {
        await this.softDelete(id);
      } catch {
        // The row delete below removes what the tombstone could not mark.
      }
    }
    // A trace this store holds under another scope than its row's (a move another process made, which this store has
    // not followed) has a document in the collection its row names too, which the eviction above did not reach.
    for (const [id, row] of rows) {
      const held = this.traceCache.get(id);
      const filed = rowScopeId(row);
      if (!held || filed === '' || (held.scope === row.scope && held.scopeId === filed)) continue;
      await this.deleteRowDocument(collectionName(this.config.collectionPrefix, row.scope as MemoryScope, filed), id);
    }
    if (brain && rowIds.length > 0) {
      await deleteTraceRows(brain, brain.brainId, rowIds);
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
    for (const id of known) forgetDeletedTrace(this.coordinationNamespace, id, this.coordinationTarget);
    return counted.size;
  }

  /**
   * Deletes every trace of one scope for good ({@link deleteTraces}). The traces this store holds and every Brain row
   * filed under the scope (`memory_traces.scope_id`), soft-deleted rows and another process's included, go in one
   * batch; the brain's rows a release older than the column wrote are filed first ({@link scopeTraceIds}). A trace this
   * store holds under the scope whose row a move filed under another scope id (`refileScope` in another store or
   * process, a Brain's re-file this store has not followed) stays: it is that scope id's, and after a Brain's re-file
   * the old id names another user. With no
   * Brain the vector index is the scope's durable record, holding what another store filed before a restart, so the
   * scope's collection is then walked from its start a page at a time ({@link readScopeCollection}), following the
   * cursor the index returns, and each page is deleted. The walk runs again while it finds a document this call has
   * not read, since a delete moves the documents after it past a cursor that counts positions. A document whose
   * eviction fails stays in the index, as `softDelete` warns, and a later call reads it again; a document of a trace
   * this store holds under another scope is removed from the collection and its trace kept. Last, every
   * knowledge-graph copy filed under the scope whose trace was already gone.
   *
   * @param options.turnUserId - Deletes only the scope's traces that name this user: a trace a second user filed on
   *   another user's session ({@link MemoryTrace.turnUserId}), or a summary of their words, whose Brain row names them
   *   among its contributors (`traceNamesUser`); the scope's other traces and copies stay. A trace this store holds
   *   with no Brain row is read by its `turnUserId`, since a cached trace carries no contributors.
   * @param options.beforeDelete - Runs with the ids of each batch's traces before the batch is deleted (`deleteTraces`
   *   runs it). The memory manager removes what it keeps of each trace there, so a call that fails part way finds the
   *   same traces again.
   * @returns The number of traces deleted.
   * @throws TypeError when `scopeId` is empty, so a caller's missing id never deletes every trace filed under no scope
   *   id, or when `turnUserId` is given and is not a non-empty string.
   * @throws When the Brain cannot be read or a row cannot be deleted, or, with no Brain, when the vector index
   *   cannot say whether it holds the scope's collection or cannot read the collection it holds.
   */
  async deleteScope(
    scope: MemoryScope,
    scopeId: string,
    options: { turnUserId?: string; beforeDelete?: (traceIds: readonly string[]) => Promise<void> } = {},
  ): Promise<number> {
    if (typeof scopeId !== 'string' || scopeId === '') {
      throw new TypeError('MemoryStore.deleteScope: scopeId must be a non-empty string');
    }
    const only = options.turnUserId;
    if (only !== undefined && (typeof only !== 'string' || only === '')) {
      throw new TypeError('MemoryStore.deleteScope: turnUserId must be a non-empty string');
    }
    this.beginOperation();
    const deleteBatch = async (traceIds: string[]): Promise<number> =>
      traceIds.length === 0 ? 0 : this.deleteTraces(traceIds, { beforeDelete: options.beforeDelete });
    const filedByThem = (traceId: string): boolean =>
      only === undefined || this.traceCache.get(traceId)?.turnUserId === only;
    let deleted = await deleteBatch(await this.scopeTraceIds(scope, scopeId, { turnUserId: only }));
    if (!this.brain) {
      await this.walkScopeCollection(
        scope,
        scopeId,
        async (traceIds) => {
          deleted += await deleteBatch(traceIds.filter(filedByThem));
        },
        // A stale copy of a trace's words goes with the scope; with a user named, only that user's.
        { dropStale: filedByThem },
      );
    }
    // With a user named, each deleted trace took its own copy, and the scope's other copies are the session's.
    if (only === undefined) {
      try {
        await this.config.knowledgeGraph.deleteMemories?.({ scopes: [{ scope, scopeId }] });
      } catch {
        // Each trace's own copy went with it above.
      }
    }
    return deleted;
  }

  /**
   * The ids of every trace of one scope this store holds, and of every Brain row filed under the scope
   * (`memory_traces.scope_id`), soft-deleted rows and another process's included; with `turnUserId`, only those
   * that name that user (`traceNamesUser` on a Brain row, `turnUserId` on a trace this store holds). The rows of the brain that hold `scope_id` `''` while their metadata names a
   * scope id are filed first (`fillScopeIds`): a release older than the column writes them to a brain this process
   * holds open, and the read by `scope_id` would miss them.
   *
   * With a Brain, a trace this store holds under the scope whose row a move filed under another scope id
   * (`refileScope` in another store or process, a Brain's re-file this store has not followed) belongs to that scope id
   * and is left out, as every read of the scope leaves it out: after a Brain's re-file the old id names another user.
   *
   * @param options.heldWhereverFiled - List every trace this store holds under the scope, whatever its row says: a move
   *   of the scope ({@link refileScope}) takes the trace this store holds after a row that moved first.
   * @throws When the rows of the traces this store holds cannot be read.
   */
  private async scopeTraceIds(
    scope: MemoryScope,
    scopeId: string,
    options: { turnUserId?: string; heldWhereverFiled?: boolean } = {},
  ): Promise<string[]> {
    const { turnUserId } = options;
    const ids = new Set<string>();
    for (const trace of this.traceCache.values()) {
      if (trace.scope === scope && trace.scopeId === scopeId && (turnUserId === undefined || trace.turnUserId === turnUserId)) {
        ids.add(trace.id);
      }
    }
    const brain = this.brain;
    if (brain) {
      await fillScopeIds(brain.adapter, brain.brainId);
      const rows = await brain.all<{ id: string; metadata?: string | null }>(
        `SELECT id${turnUserId === undefined ? '' : ', metadata'} FROM memory_traces WHERE brain_id = ? AND scope = ? AND scope_id = ?`,
        [brain.brainId, scope, scopeId],
      );
      if (!options.heldWhereverFiled) {
        const filedHere = new Set(rows.map((row) => row.id));
        const heldOnly = [...ids].filter((traceId) => !filedHere.has(traceId));
        if (heldOnly.length > 0) {
          const durable = await this.getDurableTraceRows(heldOnly, brain);
          if (!durable.ok) throw new Error('MemoryStore.deleteScope: the Brain could not be read');
          for (const traceId of heldOnly) {
            const row = durable.rows.get(traceId);
            if (row && rowFiledElsewhere(row, scope, scopeId)) ids.delete(traceId);
          }
        }
      }
      for (const row of rows) {
        if (turnUserId === undefined || traceNamesUser(row.metadata, turnUserId)) ids.add(row.id);
      }
    }
    return [...ids];
  }

  /**
   * Walks a scope's collection in the vector index from its start, a page at a time ({@link readScopeCollection}),
   * following the cursor the index returns, and hands `onPage` each page's documents this walk has not read before;
   * `onPage` may delete or move them. An empty page or a cursor the walk already followed ends a pass, and the walk
   * makes another pass while a pass finds a document it had not read: a delete or a move takes documents out of the
   * collection, which carries the ones after them past a cursor that counts positions. A document of a trace this
   * store holds under another scope is not handed to `onPage` ({@link readScopeCollection}).
   *
   * @param options.withEmbeddings - Also cache each document's vector, where the index returns it.
   * @param options.dropStale - Delete from the collection, once a walk, each document of a trace this store holds
   *   under another scope for which it returns true: a stale copy of the trace's words, which a delete of the scope
   *   removes and the trace keeps. A pass that deletes one makes another, since it moves the documents after it too.
   */
  private async walkScopeCollection(
    scope: MemoryScope,
    scopeId: string,
    onPage: (traceIds: string[]) => Promise<void>,
    options: { withEmbeddings?: boolean; dropStale?: (traceId: string) => boolean } = {},
  ): Promise<void> {
    const read = new Set<string>();
    let found = true;
    while (found) {
      found = false;
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await this.readScopeCollection(scope, scopeId, cursor, options);
        const fresh = [...new Set(page.traceIds)].filter((id) => !read.has(id));
        const stale = [...new Set(page.staleIds)].filter((id) => !read.has(id));
        for (const id of [...fresh, ...stale]) read.add(id);
        if (fresh.length > 0) found = true;
        await onPage(fresh);
        const dropped = options.dropStale ? stale.filter(options.dropStale) : [];
        if (dropped.length > 0) {
          await this.deleteStaleDocuments(collectionName(this.config.collectionPrefix, scope, scopeId), dropped);
          found = true;
        }
        // An empty page or a cursor this walk already followed ends the pass.
        const next = page.read > 0 ? page.nextCursor : undefined;
        cursor = next !== undefined && !cursors.has(next) ? next : undefined;
        if (cursor !== undefined) cursors.add(cursor);
      } while (cursor !== undefined);
    }
  }

  /**
   * One page of a scope's collection in the vector index, for a store with no Brain: up to
   * {@link SCOPE_DELETE_PAGE_SIZE} documents, listed by metadata where the index can (`scanByMetadata`), else found by
   * a query with a zero vector of the index's size. Each document this store does not hold is cached as a trace of
   * the scope ({@link traceFromVectorDocument}), so its delete evicts it from this collection. A document whose trace
   * this store holds under another scope is left out, its id in `staleIds`: it stayed behind when the trace moved, or
   * was stored again under another scope id, and the trace is not the scope's. An index that says the collection does
   * not exist (`collectionExists`) gives no page; one that cannot say, and fails the read, is read as holding nothing,
   * with a warning, since a scope never filed has no collection.
   *
   * @returns The scope's trace ids on the page, the ids of the page's stale documents, how many documents the page
   *   held, and the index's cursor.
   *
   * @param cursor - Where the previous page ended, for an index whose scan pages.
   * @param options.withEmbeddings - Asks the index for each document's vector too, and caches it for a trace whose
   *   vector this store does not hold, so a move need not embed the text again.
   * @throws When the index fails to say whether it holds the collection (`collectionExists` throws), or fails the
   *   read of a collection it holds.
   */
  private async readScopeCollection(
    scope: MemoryScope,
    scopeId: string,
    cursor?: string,
    options: { withEmbeddings?: boolean } = {},
  ): Promise<{ traceIds: string[]; staleIds: string[]; read: number; nextCursor?: string }> {
    const vectorStore = this.config.vectorStore;
    const collection = collectionName(this.config.collectionPrefix, scope, scopeId);
    const exists =
      typeof vectorStore.collectionExists === 'function'
        ? await vectorStore.collectionExists(collection)
        : undefined;
    if (exists === false) return { traceIds: [], staleIds: [], read: 0 };
    let documents: RetrievedVectorDocument[];
    let nextCursor: string | undefined;
    try {
      const includeEmbedding = options.withEmbeddings === true;
      if (typeof vectorStore.scanByMetadata === 'function') {
        const scanned = await vectorStore.scanByMetadata(collection, {
          limit: SCOPE_DELETE_PAGE_SIZE,
          includeMetadata: true,
          includeTextContent: true,
          ...(includeEmbedding ? { includeEmbedding } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        documents = scanned.documents;
        nextCursor = scanned.nextCursor;
      } else {
        const queried = await vectorStore.query(collection, await this.zeroQueryVector(), {
          topK: SCOPE_DELETE_PAGE_SIZE,
          includeMetadata: true,
          includeTextContent: true,
          ...(includeEmbedding ? { includeEmbedding } : {}),
        });
        documents = queried.documents;
      }
    } catch (error) {
      if (exists === true) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[MemoryStore] a scope's delete or move read the vector index as holding nothing: the index cannot say whether ` +
          `the collection exists, and its read failed: ${message}`,
      );
      return { traceIds: [], staleIds: [], read: 0 };
    }
    const traceIds: string[] = [];
    const staleIds: string[] = [];
    for (const document of documents) {
      const held = this.traceCache.get(document.id);
      // A document left in a collection its trace moved out of is not the scope's: the trace is filed elsewhere.
      if (held && filedElsewhere(held, scope, scopeId)) {
        staleIds.push(document.id);
        continue;
      }
      traceIds.push(document.id);
      if (
        options.withEmbeddings &&
        isUsableEmbedding(document.embedding) &&
        !this.embeddingCache.has(document.id) &&
        !this.tombstonedTraceIds.has(document.id)
      ) {
        this.embeddingCache.set(document.id, [...document.embedding]);
      }
      if (held) continue;
      const trace = this.traceFromVectorDocument(document);
      // A trace this store deleted before, whose eviction failed, counts once: it is cached as deleted.
      const isActive = trace.isActive && !this.tombstonedTraceIds.has(document.id);
      const filed: MemoryTrace = { ...trace, scope, scopeId, isActive };
      syncedDecayStates.set(filed, decayStateOf(filed));
      this.traceCache.set(document.id, filed);
    }
    return { traceIds, staleIds, read: documents.length, nextCursor };
  }

  /**
   * Deletes from a scope's collection the stale documents of traces filed under another scope: traces this store
   * holds under another scope ({@link walkScopeCollection}), and traces whose Brain rows a move filed under another
   * scope id ({@link query}, {@link getByScope}). A delete the index fails is reported, with no scope id, and a later
   * read that reaches such a document, or the next delete or refile of the scope, tries again.
   */
  private async deleteStaleDocuments(collection: string, traceIds: string[]): Promise<void> {
    try {
      const result = await this.config.vectorStore.delete(collection, traceIds);
      if ((result?.failedCount ?? 0) === 0) return;
    } catch {
      // Reported below.
    }
    console.warn(
      `[MemoryStore] could not delete ${traceIds.length} stale documents of traces filed under another scope from a ` +
        `scope's collection; a later read that reaches them, or the next delete or refile of the scope, tries again`,
    );
  }

  /**
   * Deletes a trace's document from the collection its Brain row names, for a trace being deleted for good that this
   * store holds under another scope ({@link deleteTraces}). A delete the index fails is reported, not thrown, as a soft
   * delete's eviction is.
   */
  private async deleteRowDocument(collection: string, traceId: string): Promise<void> {
    const vectorStore = this.config.vectorStore;
    try {
      if (vectorStore.collectionExists && !(await vectorStore.collectionExists(collection))) return;
      const result = await vectorStore.delete(collection, [traceId]);
      if ((result?.failedCount ?? 0) === 0) return;
    } catch {
      // Reported below.
    }
    console.warn(
      `[MemoryStore] deleteTraces could not delete trace ${traceId}'s document from the collection its Brain row names, ` +
        'which another store moved it into; the document may persist in a shared index',
    );
  }

  /**
   * A trace rebuilt from its vector document, for a store that has no Brain row of it: the document's text and
   * metadata ({@link metadataToTracePartial}). A document that holds no interval loads with the store's one hour;
   * with `persistAccessState` off, as before, with 0.
   */
  private traceFromVectorDocument(
    document: Pick<RetrievedVectorDocument, 'id' | 'textContent' | 'metadata'>,
  ): MemoryTrace {
    const partial = metadataToTracePartial(
      (document.metadata ?? {}) as Record<string, any>,
      this.persistsAccessState,
    );
    return {
      id: document.id,
      content: document.textContent ?? '',
      associatedTraceIds: [],
      reinforcementInterval: this.persistsAccessState ? DEFAULT_REINFORCEMENT_INTERVAL_MS : 0,
      updatedAt: (partial.createdAt as number) ?? Date.now(),
      ...partial,
    } as MemoryTrace;
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

  /** Records a trace's episodic copy in the knowledge graph. Non-critical: a graph error never fails a write. */
  private async recordGraphCopy(trace: MemoryTrace, embedding: number[] | undefined): Promise<void> {
    // The trace's entities, slugified as `ingestEntityGraph` writes their nodes, feed the graph-activation signal.
    const entityIds = (trace.entities ?? []).map(slugifyEntityId).filter((id) => id.length > 0);
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
        context: { memoryTraceId: trace.id, scope: trace.scope, scopeId: trace.scopeId, type: trace.type },
      });
    } catch {
      // Knowledge graph may not be available; non-critical.
    }
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
