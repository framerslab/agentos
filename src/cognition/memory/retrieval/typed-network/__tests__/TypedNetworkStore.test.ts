/**
 * @file TypedNetworkStore.test.ts
 * @description Contract tests for the 4-bank in-memory store.
 *
 * Spec anchor:
 * `packages/agentos-bench/docs/specs/2026-04-26-hindsight-4network-observer-design.md`
 * §4.1.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TypedNetworkStore } from '../TypedNetworkStore.js';
import type { TypedFact } from '../types.js';

const baseFact: TypedFact = {
  id: 'f1',
  bank: 'WORLD',
  text: 'Berlin is in Germany',
  embedding: [0.1, 0.2, 0.3],
  temporal: { mention: '2026-04-26T10:00:00Z' },
  participants: [],
  reasoningMarkers: [],
  entities: ['Berlin', 'Germany'],
  confidence: 1.0,
};

describe('TypedNetworkStore', () => {
  let store: TypedNetworkStore;

  beforeEach(() => {
    store = new TypedNetworkStore();
  });

  it('starts with 0 facts in every bank', () => {
    expect(store.getBank('WORLD').size).toBe(0);
    expect(store.getBank('EXPERIENCE').size).toBe(0);
    expect(store.getBank('OPINION').size).toBe(0);
    expect(store.getBank('OBSERVATION').size).toBe(0);
    expect(store.size()).toBe(0);
  });

  it('addFact routes to the correct bank', () => {
    store.addFact(baseFact);
    expect(store.getBank('WORLD').size).toBe(1);
    expect(store.getBank('EXPERIENCE').size).toBe(0);
    expect(store.getBank('OPINION').size).toBe(0);
    expect(store.getBank('OBSERVATION').size).toBe(0);
    expect(store.size()).toBe(1);
  });

  it('addFact across all banks routes correctly', () => {
    store.addFact({ ...baseFact, id: 'f1', bank: 'WORLD' });
    store.addFact({ ...baseFact, id: 'f2', bank: 'EXPERIENCE' });
    store.addFact({ ...baseFact, id: 'f3', bank: 'OPINION', confidence: 0.7 });
    store.addFact({ ...baseFact, id: 'f4', bank: 'OBSERVATION' });
    expect(store.getBank('WORLD').size).toBe(1);
    expect(store.getBank('EXPERIENCE').size).toBe(1);
    expect(store.getBank('OPINION').size).toBe(1);
    expect(store.getBank('OBSERVATION').size).toBe(1);
    expect(store.size()).toBe(4);
  });

  it('getFact retrieves by id', () => {
    store.addFact(baseFact);
    const got = store.getFact('f1');
    expect(got?.text).toBe('Berlin is in Germany');
    expect(got?.entities).toContain('Berlin');
  });

  it('getFact returns undefined for unknown id', () => {
    expect(store.getFact('does-not-exist')).toBeUndefined();
  });

  it('re-adding the same id overwrites the fact', () => {
    store.addFact(baseFact);
    store.addFact({ ...baseFact, text: 'Berlin is the capital of Germany' });
    expect(store.size()).toBe(1);
    expect(store.getFact('f1')?.text).toBe('Berlin is the capital of Germany');
  });

  it('addEdge stores bidirectional edges for entity link', () => {
    store.addFact(baseFact);
    store.addFact({ ...baseFact, id: 'f2', text: 'Germany is in Europe' });
    store.addEdge({ fromFactId: 'f1', toFactId: 'f2', kind: 'entity', weight: 1.0 });

    expect(store.getEdges('f1')).toHaveLength(1);
    expect(store.getEdges('f1')[0].toFactId).toBe('f2');

    // Bidirectional: f2 also sees an edge to f1
    expect(store.getEdges('f2')).toHaveLength(1);
    expect(store.getEdges('f2')[0].toFactId).toBe('f1');
  });

  it('addEdge preserves edge kind on both directions', () => {
    store.addFact(baseFact);
    store.addFact({ ...baseFact, id: 'f2' });
    store.addEdge({ fromFactId: 'f1', toFactId: 'f2', kind: 'temporal', weight: 0.5 });

    expect(store.getEdges('f1')[0].kind).toBe('temporal');
    expect(store.getEdges('f1')[0].weight).toBe(0.5);
    expect(store.getEdges('f2')[0].kind).toBe('temporal');
    expect(store.getEdges('f2')[0].weight).toBe(0.5);
  });

  it('multiple edges from one fact accumulate', () => {
    store.addFact(baseFact);
    store.addFact({ ...baseFact, id: 'f2' });
    store.addFact({ ...baseFact, id: 'f3' });
    store.addEdge({ fromFactId: 'f1', toFactId: 'f2', kind: 'entity', weight: 1.0 });
    store.addEdge({ fromFactId: 'f1', toFactId: 'f3', kind: 'semantic', weight: 0.8 });
    expect(store.getEdges('f1')).toHaveLength(2);
  });

  it('iterateFacts yields every inserted fact', () => {
    store.addFact({ ...baseFact, id: 'f1' });
    store.addFact({ ...baseFact, id: 'f2', bank: 'EXPERIENCE' });
    store.addFact({ ...baseFact, id: 'f3', bank: 'OPINION', confidence: 0.6 });
    const ids = [...store.iterateFacts()].map((f) => f.id);
    expect(ids).toEqual(['f1', 'f2', 'f3']);
  });

  it('getEdges returns empty array for unknown fact', () => {
    expect(store.getEdges('not-here')).toEqual([]);
  });

  it('deleteFacts takes a fact out of every bank it is filed in, with its edges both ways', () => {
    store.addFact({ ...baseFact, id: 'f1', bank: 'WORLD' });
    // Added again under another bank, the fact is filed in both: addFact keeps the bank it had.
    store.addFact({ ...baseFact, id: 'f1', bank: 'OPINION', confidence: 0.6 });
    store.addFact({ ...baseFact, id: 'f2', bank: 'WORLD' });
    store.addEdge({ fromFactId: 'f1', toFactId: 'f2', kind: 'entity', weight: 1.0 });

    expect(store.deleteFacts(['f1', 'not-here'])).toBe(1);

    expect([...store.getBank('WORLD')]).toEqual(['f2']);
    expect(store.getBank('OPINION').size).toBe(0);
    expect(store.getFact('f1')).toBeUndefined();
    expect(store.getEdges('f1')).toEqual([]);
    expect(store.getEdges('f2')).toEqual([]);
  });
});
