/**
 * @file ICheckpointStore.ts
 * @description Checkpoint persistence interface and related types for the AgentOS
 * Unified Orchestration Layer. Checkpoints capture a full snapshot of graph execution
 * state so that interrupted runs can be resumed or forked from any saved point.
 */

import type { CheckpointMetadata, DiagnosticsView, EffectClass, GraphState } from '../ir/types.js';

// Re-export CheckpointMetadata from ir/types for consumers who import from this module.
export type { CheckpointMetadata } from '../ir/types.js';

// ---------------------------------------------------------------------------
// Checkpoint — full serialisable snapshot of a graph run at a node boundary
// ---------------------------------------------------------------------------

/**
 * A complete, serialisable snapshot of a graph run captured at a node boundary.
 *
 * The store persists one `Checkpoint` per `save()` call and makes them queryable
 * by `runId` (latest or by `nodeId`) so the runtime can restore execution state
 * after a crash or perform time-travel debugging.
 */
export interface Checkpoint {
  /** Unique checkpoint identifier (UUIDv4 assigned by the runtime). */
  id: string;
  /** Id of the `CompiledExecutionGraph` being executed. */
  graphId: string;
  /** Id of the graph run that produced this checkpoint. */
  runId: string;
  /** Id of the node at whose boundary this checkpoint was captured. */
  nodeId: string;
  /** Unix epoch milliseconds when the checkpoint was persisted. */
  timestamp: number;

  /**
   * Serialised `GraphState` partitions captured at the checkpoint boundary.
   * `memory` is excluded because it is always rehydrated fresh on resume.
   */
  state: {
    /** The original user-provided input frozen at graph start. */
    input: unknown;
    /** Node-to-node communication bag value at the checkpoint boundary. */
    scratch: unknown;
    /** Accumulated external outputs at the checkpoint boundary. */
    artifacts: unknown;
    /** Accumulated diagnostic telemetry up to this checkpoint. */
    diagnostics: DiagnosticsView;
  };

  /**
   * Optional snapshot of the memory subsystem state at this checkpoint.
   * When present the runtime can restore memory context without re-reading from the store.
   */
  memorySnapshot?: {
    /** Memory traces that were read before or during the checkpointed node. */
    reads: Array<{
      /** Trace identifier in the memory store. */
      traceId: string;
      /** Textual content of the trace. */
      content: string;
      /** Consolidation strength in range 0–1. */
      strength: number;
    }>;
    /** Writes that were staged but not yet committed when the checkpoint was taken. */
    pendingWrites: Array<{
      /** Memory trace category (matches `MemoryTraceType`). */
      type: string;
      /** Textual content to be written. */
      content: string;
      /** Visibility scope (matches `MemoryScope`). */
      scope: string;
    }>;
  };

  /**
   * Results from every node that completed execution before this checkpoint was taken.
   * Keyed by node id.
   */
  nodeResults: Record<string, {
    /** The node's declared effect class. */
    effectClass: EffectClass;
    /** The output value produced by the node. */
    output: unknown;
    /** Wall-clock execution time in milliseconds. */
    durationMs: number;
  }>;

  /** Ordered list of node ids that had completed execution when this checkpoint was taken. */
  visitedNodes: string[];

  /**
   * Ordered list of node ids that were explicitly bypassed by routing decisions
   * (for example, the non-selected arm of a conditional branch).
   *
   * Persisting this list is required for correct resume semantics on branched
   * graphs: otherwise a resumed run cannot distinguish "not run yet" from
   * "intentionally skipped" and may stall on dead branches.
   */
  skippedNodes?: string[];

  /** Ids of edges that had been emitted but whose target nodes had not yet started. */
  pendingEdges: string[];
}

// ---------------------------------------------------------------------------
// ICheckpointStore
// ---------------------------------------------------------------------------

/**
 * Persistence contract for checkpoint snapshots.
 *
 * Implementations may back this with in-memory maps (for testing / ephemeral runs),
 * SQLite / Postgres rows, object storage blobs, or any other durable medium.
 *
 * All methods are async to accommodate I/O-bound backends without interface changes.
 */
export interface ICheckpointStore {
  /**
   * Persist a checkpoint snapshot.
   *
   * If a checkpoint with the same `id` already exists it is overwritten.
   *
   * @param checkpoint - The snapshot to persist.
   */
  save(checkpoint: Checkpoint): Promise<void>;

  /**
   * Load a checkpoint by its unique checkpoint identifier.
   *
   * @param checkpointId - The exact checkpoint id assigned at save-time.
   * @returns The matching checkpoint, or `null` when none exists.
   */
  get(checkpointId: string): Promise<Checkpoint | null>;

  /**
   * Load a checkpoint for the given `runId`.
   *
   * When `nodeId` is supplied, returns the most recent checkpoint for that specific
   * node within the run. When `nodeId` is omitted, returns the most recent checkpoint
   * for the run regardless of node (equivalent to `latest(runId)`). The most recent
   * checkpoint has the latest `timestamp` and, of checkpoints with the same
   * `timestamp`, was saved last: the runtime can save several in one millisecond.
   *
   * @param runId  - The graph run identifier.
   * @param nodeId - Optional node filter.
   * @returns The matching checkpoint, or `null` when none exists.
   */
  load(runId: string, nodeId?: string): Promise<Checkpoint | null>;

  /**
   * Return the most recently persisted checkpoint for a run, or `null` when the run
   * has no checkpoints. Of checkpoints with the same `timestamp`, the one saved last
   * is the most recent.
   *
   * @param runId - The graph run identifier.
   */
  latest(runId: string): Promise<Checkpoint | null>;

  /**
   * List lightweight metadata descriptors for all checkpoints belonging to a graph.
   *
   * @param graphId - The compiled graph identifier.
   * @param options.runId  - Optional filter to a single run within the graph.
   * @param options.limit  - Maximum number of entries to return (most-recent-first).
   * @returns Array of `CheckpointMetadata`, sorted by `timestamp` descending.
   */
  list(
    graphId: string,
    options?: { limit?: number; runId?: string },
  ): Promise<CheckpointMetadata[]>;

  /**
   * Permanently remove a checkpoint from the store.
   *
   * Silently succeeds when `checkpointId` does not exist.
   *
   * @param checkpointId - The checkpoint to remove.
   */
  delete(checkpointId: string): Promise<void>;

  /**
   * Create a new run branching from an existing checkpoint.
   *
   * The operation deep-clones the source checkpoint, assigns a fresh `runId` and
   * checkpoint `id`, applies any `patchState` overrides, persists the new checkpoint,
   * and returns the new `runId`.
   *
   * @param checkpointId - The checkpoint to fork from.
   * @param patchState   - Optional partial `GraphState` overrides applied after cloning.
   * @returns The new `runId` for the forked run.
   * @throws When `checkpointId` does not exist.
   */
  fork(checkpointId: string, patchState?: Partial<GraphState>): Promise<string>;
}
