/**
 * @file StateManager.ts
 * @description Manages the mutable {@link GraphState} partitions for an active graph run.
 *
 * Responsibilities:
 *  - Creating a clean initial state from caller-supplied input.
 *  - Applying node output patches to the `scratch` partition, honoring per-field
 *    {@link StateReducers} for deterministic conflict resolution.
 *  - Applying node output patches to the `artifacts` partition (last-write-wins by default).
 *  - Merging states produced by parallel branches using the same reducer logic.
 *  - Tracking the ordered list of visited node ids and the global iteration counter.
 *
 * `StateManager` is intentionally stateless between calls — it receives the current
 * {@link GraphState} as an argument and returns a *new* object; it never mutates in place.
 * This makes it straightforward to unit-test and safe to use in concurrent contexts.
 */

import type {
  StateReducers,
  BuiltinReducer,
  ReducerFn,
  GraphState,
  DiagnosticsView,
  MemoryView,
} from '../ir/types.js';

/**
 * What one branch of a parallel batch wrote: the patches its node applied to
 * `scratch` and `artifacts`. {@link StateManager.mergeParallelBranches} reads
 * only their keys.
 */
export interface ParallelBranchWrites {
  /** The patch the branch applied to `scratch`. */
  scratch?: Readonly<Record<string, unknown>>;
  /** The patch the branch applied to `artifacts`. */
  artifacts?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// StateManager
// ---------------------------------------------------------------------------

/**
 * Manages the {@link GraphState} partitions (`input`, `scratch`, `artifacts`,
 * `memory`, `diagnostics`) for a single graph run.
 *
 * All methods return a *new* `GraphState` object; the original is never mutated.
 *
 * @example
 * ```ts
 * const manager = new StateManager({ 'scratch.messages': 'concat' });
 * let state = manager.initialize({ prompt: 'Hello' });
 * state = manager.updateScratch(state, { messages: ['first'] });
 * state = manager.updateScratch(state, { messages: ['second'] });
 * // state.scratch.messages === ['first', 'second']
 * ```
 */
export class StateManager {
  /**
   * @param reducers - Field-level reducer configuration keyed by dot-notation paths
   *                   (e.g. `'scratch.messages'`).  Determines how conflicting values
   *                   are merged during `updateScratch()` and `mergeParallelBranches()`.
   */
  constructor(private readonly reducers: StateReducers) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create a clean initial {@link GraphState} from the caller-supplied `input` value.
   *
   * The `input` partition is frozen with `Object.freeze()` so that no node can
   * accidentally mutate it.  All other partitions start empty.
   *
   * @param input - Arbitrary value provided by the graph caller; becomes `state.input`.
   * @returns A fully initialised `GraphState` ready for the first node execution.
   */
  initialize(input: unknown): GraphState {
    return {
      input: Object.freeze(input) as any,
      scratch: {} as any,
      memory: this.emptyMemoryView(),
      artifacts: {} as any,
      diagnostics: this.emptyDiagnostics(),
      currentNodeId: '',
      visitedNodes: [],
      iteration: 0,
    };
  }

  /**
   * Apply a `patch` to the `scratch` partition, honoring any registered reducers.
   *
   * For each key in `patch`:
   *  - If a reducer is registered at `scratch.<key>` **and** the key already exists
   *    in the current scratch, the reducer is called to merge the existing and incoming
   *    values.
   *  - Otherwise the incoming value simply overwrites (last-write-wins semantics).
   *
   * @param state - Current graph state (not mutated).
   * @param patch - Partial scratch update emitted by a completed node.
   * @returns New `GraphState` with the merged scratch partition.
   */
  updateScratch(state: GraphState, patch: Record<string, unknown>): GraphState {
    const newScratch = { ...(state.scratch as any) };

    for (const [key, value] of Object.entries(patch)) {
      const reducerKey = `scratch.${key}`;
      const reducer = this.reducers[reducerKey];

      if (reducer !== undefined && newScratch[key] !== undefined) {
        // A reducer is configured and a prior value exists — merge them.
        newScratch[key] = this.applyReducer(reducer, newScratch[key], value);
      } else {
        // No reducer or no prior value — overwrite.
        newScratch[key] = value;
      }
    }

    return { ...state, scratch: newScratch };
  }

  /**
   * Apply a `patch` to the `artifacts` partition using last-write-wins semantics.
   *
   * Artifact fields are intended for caller-facing outputs and are not subject to
   * reducer logic in this method.  If you need reducer-aware artifact merging, use
   * `mergeParallelBranches()` instead.
   *
   * @param state - Current graph state (not mutated).
   * @param patch - Partial artifacts update emitted by a completed node.
   * @returns New `GraphState` with the updated artifacts partition.
   */
  updateArtifacts(state: GraphState, patch: Record<string, unknown>): GraphState {
    return {
      ...state,
      artifacts: { ...(state.artifacts as any), ...patch },
    };
  }

  /**
   * Record that execution has entered `nodeId`.
   *
   * Updates `currentNodeId`, appends to `visitedNodes`, and increments `iteration`.
   *
   * @param state  - Current graph state (not mutated).
   * @param nodeId - Id of the node that is about to execute.
   * @returns New `GraphState` reflecting the visit.
   */
  recordNodeVisit(state: GraphState, nodeId: string): GraphState {
    return {
      ...state,
      currentNodeId: nodeId,
      visitedNodes: [...state.visitedNodes, nodeId],
      iteration: state.iteration + 1,
    };
  }

  /**
   * Merge the `scratch` and `artifacts` partitions of one or more parallel branch
   * states back into a single `GraphState`.
   *
   * Each branch started from `baseState`, so its state also holds every key it did
   * not write. A branch contributes only the keys it wrote, so a value it carried
   * from `baseState` never replaces another branch's write. The branches are merged
   * in the order given: for each key a branch wrote, the reducer registered at
   * `scratch.<key>` or `artifacts.<key>` (if any) combines the branch's value with
   * the value merged so far, when there is one; otherwise the branch's value
   * replaces it, so the last branch to write a key wins.
   *
   * The merged value starts from `baseState`'s, so a branch's value for a key with
   * a reducer has to be the value the branch wrote: a value the reducer already
   * combined with `baseState`'s, as `updateScratch()` leaves it, counts
   * `baseState`'s value again. `GraphRuntime` passes each branch's state with the
   * scratch values its node wrote.
   *
   * The `memory`, `diagnostics`, `visitedNodes`, and `iteration` fields of
   * `baseState` are preserved unchanged — the caller is responsible for merging
   * those separately if needed.
   *
   * @param baseState    - State prior to the parallel fan-out (provides the baseline
   *                       scratch and artifacts).
   * @param branchStates - States produced by each parallel branch.
   * @param writes       - What each branch wrote, at the index of its state in
   *                       `branchStates`: the `scratch` and `artifacts` patches its
   *                       node applied. Only their keys are read; the values come from
   *                       the branch states. A branch with no entry wrote nothing.
   *                       Without `writes`, a branch's writes are the keys
   *                       whose value differs from `baseState`'s (compared with
   *                       `Object.is`), so a branch that writes the value a key held
   *                       before the fan-out is taken as leaving the key alone.
   * @returns New `GraphState` with the merged scratch and artifacts partitions.
   */
  mergeParallelBranches(
    baseState: GraphState,
    branchStates: GraphState[],
    writes?: ReadonlyArray<ParallelBranchWrites | undefined>,
  ): GraphState {
    return {
      ...baseState,
      scratch: this.mergePartition('scratch', baseState, branchStates, writes),
      artifacts: this.mergePartition('artifacts', baseState, branchStates, writes),
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Merge one partition of the branch states onto `baseState`'s, as described on
   * {@link mergeParallelBranches}.
   */
  private mergePartition(
    partition: 'scratch' | 'artifacts',
    baseState: GraphState,
    branchStates: GraphState[],
    writes: ReadonlyArray<ParallelBranchWrites | undefined> | undefined,
  ): Record<string, unknown> {
    const base = (baseState[partition] ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...base };

    branchStates.forEach((branch, index) => {
      const values = (branch[partition] ?? {}) as Record<string, unknown>;
      const written = writes
        ? Object.keys(writes[index]?.[partition] ?? {})
        : Object.keys(values).filter((key) => !Object.is(values[key], base[key]));

      for (const key of written) {
        const reducer = this.reducers[`${partition}.${key}`];

        if (reducer !== undefined && merged[key] !== undefined) {
          merged[key] = this.applyReducer(reducer, merged[key], values[key]);
        } else {
          merged[key] = values[key];
        }
      }
    });

    return merged;
  }

  /**
   * Dispatch to a {@link BuiltinReducer} strategy or call a custom {@link ReducerFn}.
   *
   * @param reducer  - The reducer to apply.
   * @param existing - Value currently stored in `GraphState`.
   * @param incoming - New value emitted by the most recently completed node.
   * @returns The merged value.
   */
  private applyReducer(
    reducer: ReducerFn | BuiltinReducer,
    existing: unknown,
    incoming: unknown
  ): unknown {
    if (typeof reducer === 'function') {
      return reducer(existing, incoming);
    }

    switch (reducer) {
      case 'concat':
        // Concatenate arrays; fall back to empty array for non-array operands.
        return [
          ...(Array.isArray(existing) ? existing : []),
          ...(Array.isArray(incoming) ? incoming : []),
        ];

      case 'merge':
        // Shallow-merge objects; right (incoming) wins on key collision.
        return {
          ...(typeof existing === 'object' && existing !== null ? (existing as object) : {}),
          ...(typeof incoming === 'object' && incoming !== null ? (incoming as object) : {}),
        };

      case 'max':
        return Math.max(existing as number, incoming as number);

      case 'min':
        return Math.min(existing as number, incoming as number);

      case 'avg':
        return ((existing as number) + (incoming as number)) / 2;

      case 'sum':
        return (existing as number) + (incoming as number);

      case 'last':
        // Always overwrite — this is the default `scratch` field semantics.
        return incoming;

      case 'first':
        // Preserve the first value ever written; ignore subsequent writes.
        return existing;

      case 'longest': {
        // Keep whichever operand has the greater length.
        // Arrays use .length, strings use .length, objects use Object.keys().length,
        // and primitives fall back to String(val).length.
        const lengthOf = (val: unknown): number => {
          if (Array.isArray(val)) return val.length;
          if (typeof val === 'string') return val.length;
          if (typeof val === 'object' && val !== null) return Object.keys(val).length;
          return String(val).length;
        };
        return lengthOf(existing) >= lengthOf(incoming) ? existing : incoming;
      }

      default: {
        // Exhaustiveness guard — should be unreachable at runtime if types are respected.
        const _exhaustive: never = reducer;
        return incoming;
      }
    }
  }

  /**
   * Construct an empty {@link MemoryView} used during state initialisation.
   */
  private emptyMemoryView(): MemoryView {
    return {
      traces: [],
      pendingWrites: [],
      totalTracesRead: 0,
      readLatencyMs: 0,
    };
  }

  /**
   * Construct a zeroed {@link DiagnosticsView} used during state initialisation.
   */
  private emptyDiagnostics(): DiagnosticsView {
    return {
      totalTokensUsed: 0,
      totalDurationMs: 0,
      nodeTimings: {},
      discoveryResults: {},
      guardrailResults: {},
      checkpointsSaved: 0,
      memoryReads: 0,
      memoryWrites: 0,
    };
  }
}
