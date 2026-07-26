/**
 * @fileoverview Public-surface test for the Neo4j GraphRAG export
 * (spec batch-1 C5): the engine, its connection manager, and the
 * constructor/config/result types must all be importable from
 * `@framers/agentos/cognition/rag` and constructible without loading
 * `neo4j-driver` (the optional peer dep loads only inside
 * `manager.initialize(config)`).
 */
import { describe, it, expect } from 'vitest';
import {
  Neo4jGraphRAGEngine,
  Neo4jConnectionManager,
  type Neo4jGraphRAGEngineDeps,
  type Neo4jConnectionConfig,
  type ExtractionResult,
} from '../index.js';

describe('Neo4j GraphRAG public surface', () => {
  it('constructs the engine + manager from the public barrel without neo4j-driver', () => {
    const manager = new Neo4jConnectionManager();
    const deps: Neo4jGraphRAGEngineDeps = { connectionManager: manager };
    const engine = new Neo4jGraphRAGEngine(deps);
    expect(engine).toBeInstanceOf(Neo4jGraphRAGEngine);
  });

  it('exposes the config and extraction types', () => {
    const cfg: Partial<Neo4jConnectionConfig> = {};
    const extraction: Partial<ExtractionResult> = {};
    expect(cfg).toBeDefined();
    expect(extraction).toBeDefined();
  });
});
