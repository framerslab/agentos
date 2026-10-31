/**
 * @file state-manager.test.ts
 * @description Unit tests for {@link StateManager}.
 *
 * Each test group exercises a distinct method or reducer strategy in isolation so
 * failures are easy to pin-point without reading the full state object.
 */

import { describe, it, expect } from 'vitest';
import { StateManager } from '../runtime/StateManager.js';
import type { GraphState, StateReducers } from '../ir/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a StateManager with the given reducers (defaults to none). */
function makeManager(reducers: StateReducers = {}): StateManager {
  return new StateManager(reducers);
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

describe('StateManager.initialize', () => {
  it('initializes state with input and empty partitions', () => {
    const manager = makeManager();
    const state = manager.initialize({ prompt: 'hello' });

    // Input is preserved.
    expect(state.input).toEqual({ prompt: 'hello' });

    // Input is frozen.
    expect(Object.isFrozen(state.input)).toBe(true);

    // Scratch and artifacts start empty.
    expect(state.scratch).toEqual({});
    expect(state.artifacts).toEqual({});

    // Memory starts with zero-values.
    expect(state.memory.traces).toEqual([]);
    expect(state.memory.pendingWrites).toEqual([]);
    expect(state.memory.totalTracesRead).toBe(0);
    expect(state.memory.readLatencyMs).toBe(0);

    // Diagnostics start at zero.
    expect(state.diagnostics.totalTokensUsed).toBe(0);
    expect(state.diagnostics.totalDurationMs).toBe(0);
    expect(state.diagnostics.checkpointsSaved).toBe(0);
    expect(state.diagnostics.memoryReads).toBe(0);
    expect(state.diagnostics.memoryWrites).toBe(0);

    // Navigation fields start at defaults.
    expect(state.currentNodeId).toBe('');
    expect(state.visitedNodes).toEqual([]);
    expect(state.iteration).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// updateScratch — simple set (no reducer)
// ---------------------------------------------------------------------------

describe('StateManager.updateScratch (no reducer)', () => {
  it('applies scratch update via simple set when no reducer is registered', () => {
    const manager = makeManager();
    const state = manager.initialize({});
    const next = manager.updateScratch(state, { answer: 42 });

    expect((next.scratch as any).answer).toBe(42);
    // Original state is not mutated.
    expect((state.scratch as any).answer).toBeUndefined();
  });

  it('overwrites an existing scratch key when no reducer is registered', () => {
    const manager = makeManager();
    let state = manager.initialize({});
    state = manager.updateScratch(state, { count: 1 });
    state = manager.updateScratch(state, { count: 99 });

    expect((state.scratch as any).count).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// updateScratch — builtin reducers
// ---------------------------------------------------------------------------

describe('StateManager.updateScratch — concat reducer', () => {
  it('applies concat reducer to array fields', () => {
    const manager = makeManager({ 'scratch.messages': 'concat' });
    let state = manager.initialize({});
    state = manager.updateScratch(state, { messages: ['a', 'b'] });
    state = manager.updateScratch(state, { messages: ['c'] });

    expect((state.scratch as any).messages).toEqual(['a', 'b', 'c']);
  });
});

describe('StateManager.updateScratch — max reducer', () => {
  it('applies max reducer keeping the larger numeric value', () => {
    const manager = makeManager({ 'scratch.score': 'max' });
    let state = manager.initialize({});
    state = manager.updateScratch(state, { score: 5 });
    state = manager.updateScratch(state, { score: 3 });
    expect((state.scratch as any).score).toBe(5);

    state = manager.updateScratch(state, { score: 10 });
    expect((state.scratch as any).score).toBe(10);
  });
});

describe('StateManager.updateScratch — min reducer', () => {
  it('applies min reducer keeping the smaller numeric value', () => {
    const manager = makeManager({ 'scratch.score': 'min' });
    let state = manager.initialize({});
    state = manager.updateScratch(state, { score: 5 });
    state = manager.updateScratch(state, { score: 3 });
    expect((state.scratch as any).score).toBe(3);

    state = manager.updateScratch(state, { score: 10 });
    expect((state.scratch as any).score).toBe(3);
  });
});

describe('StateManager.updateScratch — last reducer', () => {
  it('applies last reducer always taking the most recent value', () => {
    const manager = makeManager({ 'scratch.result': 'last' });
    let state = manager.initialize({});
    state = manager.updateScratch(state, { result: 'first' });
    state = manager.updateScratch(state, { result: 'second' });

    expect((state.scratch as any).result).toBe('second');
  });
});

describe('StateManager.updateScratch — first reducer', () => {
  it('applies first reducer keeping the initial value', () => {
    const manager = makeManager({ 'scratch.result': 'first' });
    let state = manager.initialize({});
    state = manager.updateScratch(state, { result: 'initial' });
    state = manager.updateScratch(state, { result: 'ignored' });

    expect((state.scratch as any).result).toBe('initial');
  });
});

describe('StateManager.updateScratch — sum reducer', () => {
  it('applies sum reducer accumulating numeric values', () => {
    const manager = makeManager({ 'scratch.total': 'sum' });
    let state = manager.initialize({});
    state = manager.updateScratch(state, { total: 10 });
    state = manager.updateScratch(state, { total: 5 });
    state = manager.updateScratch(state, { total: 3 });

    expect((state.scratch as any).total).toBe(18);
  });
});

describe('StateManager.updateScratch — avg reducer', () => {
  it('applies avg reducer computing running mean of two values', () => {
    const manager = makeManager({ 'scratch.confidence': 'avg' });
    let state = manager.initialize({});
    state = manager.updateScratch(state, { confidence: 0.6 });
    state = manager.updateScratch(state, { confidence: 1.0 });

    expect((state.scratch as any).confidence).toBeCloseTo(0.8);
  });
});

describe('StateManager.updateScratch — custom reducer function', () => {
  it('applies a custom ReducerFn', () => {
    const uppercaseConcat = (existing: unknown, incoming: unknown) =>
      `${existing},${String(incoming).toUpperCase()}`;

    const manager = makeManager({ 'scratch.tags': uppercaseConcat });
    let state = manager.initialize({});
    state = manager.updateScratch(state, { tags: 'alpha' });
    state = manager.updateScratch(state, { tags: 'beta' });

    expect((state.scratch as any).tags).toBe('alpha,BETA');
  });
});

// ---------------------------------------------------------------------------
// updateArtifacts
// ---------------------------------------------------------------------------

describe('StateManager.updateArtifacts', () => {
  it('updates artifacts partition with last-write-wins semantics', () => {
    const manager = makeManager();
    let state = manager.initialize({});
    state = manager.updateArtifacts(state, { summary: 'first pass' });
    state = manager.updateArtifacts(state, { summary: 'final pass', score: 0.9 });

    expect((state.artifacts as any).summary).toBe('final pass');
    expect((state.artifacts as any).score).toBe(0.9);
    // Original state is not mutated.
    expect((manager.initialize({}).artifacts as any).summary).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// recordNodeVisit
// ---------------------------------------------------------------------------

describe('StateManager.recordNodeVisit', () => {
  it('tracks visited nodes and increments iteration', () => {
    const manager = makeManager();
    let state = manager.initialize({});

    state = manager.recordNodeVisit(state, 'node-a');
    expect(state.currentNodeId).toBe('node-a');
    expect(state.visitedNodes).toEqual(['node-a']);
    expect(state.iteration).toBe(1);

    state = manager.recordNodeVisit(state, 'node-b');
    expect(state.currentNodeId).toBe('node-b');
    expect(state.visitedNodes).toEqual(['node-a', 'node-b']);
    expect(state.iteration).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// mergeParallelBranches
// ---------------------------------------------------------------------------

describe('StateManager.mergeParallelBranches', () => {
  it('merges parallel branch states using registered reducers', () => {
    const manager = makeManager({ 'scratch.results': 'concat' });
    const base = manager.initialize({});

    // Simulate two branches each producing their own results list.
    const branch1 = manager.updateScratch(base, { results: ['r1'] });
    const branch2 = manager.updateScratch(base, { results: ['r2', 'r3'] });

    const merged = manager.mergeParallelBranches(base, [branch1, branch2]);

    expect((merged.scratch as any).results).toEqual(['r1', 'r2', 'r3']);
  });

  it('uses last-write-wins when no reducer is registered for a branch key', () => {
    const manager = makeManager();
    const base = manager.initialize({});

    const branch1 = manager.updateScratch(base, { answer: 'from-branch-1' });
    const branch2 = manager.updateScratch(base, { answer: 'from-branch-2' });

    const merged = manager.mergeParallelBranches(base, [branch1, branch2]);

    // Branch 2 is processed last → its value wins.
    expect((merged.scratch as any).answer).toBe('from-branch-2');
  });

  it('preserves base state fields outside of scratch', () => {
    const manager = makeManager({ 'scratch.items': 'concat' });
    let base = manager.initialize({ query: 'test' });
    base = manager.updateArtifacts(base, { report: 'base-report' });

    const branch = manager.updateScratch(base, { items: ['x'] });
    const merged = manager.mergeParallelBranches(base, [branch]);

    // Artifacts from baseState are preserved.
    expect((merged.artifacts as any).report).toBe('base-report');
    // Input is preserved.
    expect((merged.input as any).query).toBe('test');
  });

  it('handles an empty branch list by returning scratch equal to base', () => {
    const manager = makeManager();
    const base = manager.updateScratch(manager.initialize({}), { x: 1 });
    const merged = manager.mergeParallelBranches(base, []);

    expect(merged.scratch).toEqual(base.scratch);
  });
});

// ---------------------------------------------------------------------------
// A key named __proto__
// ---------------------------------------------------------------------------
//
// A patch parsed from JSON can hold "__proto__" as an ordinary key. It has to
// stay a key of the partition, as the spread in updateArtifacts() keeps it,
// and never become the partition's prototype.

describe('StateManager: a key named __proto__', () => {
  const written = JSON.parse('{"__proto__": {"approved": true}}') as Record<string, unknown>;

  function expectOwnKey(partition: unknown): void {
    expect(Object.getPrototypeOf(partition)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(partition, '__proto__')?.value).toEqual({ approved: true });
    expect((partition as Record<string, unknown>).approved).toBeUndefined();
  }

  it('stays a key of scratch when a node writes it, with or without a reducer', () => {
    const reducerSets: StateReducers[] = [{}, { 'scratch.__proto__': 'merge' }];
    for (const reducers of reducerSets) {
      const manager = makeManager(reducers);
      const once = manager.updateScratch(manager.initialize({}), written);
      expectOwnKey(once.scratch);
      expectOwnKey(manager.updateScratch(once, written).scratch);
    }
  });

  it('stays a key of scratch and artifacts when the branches of a batch are merged', () => {
    const manager = makeManager();
    const base = manager.initialize({});
    const branch = { ...base, scratch: { ...written }, artifacts: { ...written } };

    const merged = manager.mergeParallelBranches(base, [branch], [{ scratch: written, artifacts: written }]);

    expectOwnKey(merged.scratch);
    expectOwnKey(merged.artifacts);
  });
});
