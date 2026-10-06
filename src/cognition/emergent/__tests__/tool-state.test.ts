import { describe, it, expect, beforeEach } from 'vitest';
import { EmergentToolRegistry } from '../EmergentToolRegistry.js';
import { DEFAULT_EMERGENT_CONFIG } from '../types.js';
import type { EmergentTool } from '../types.js';
import { createSqliteAdapter, readStateRow, readToolRow, type SqliteTestAdapter } from './helpers/sqlite-adapter.js';

function makeTool(overrides: Partial<EmergentTool> = {}): EmergentTool {
  return {
    id: 'emergent_test_1',
    name: 'double_it',
    description: 'Doubles a number.',
    inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
    outputSchema: { type: 'object', properties: { doubled: { type: 'number' } } },
    implementation: {
      mode: 'sandbox',
      code: 'function execute(input) { return { doubled: input.n * 2 }; }',
      allowlist: [],
    },
    tier: 'agent',
    createdBy: 'agent-1',
    createdAt: new Date(0).toISOString(),
    judgeVerdicts: [],
    usageStats: {
      totalUses: 0,
      successCount: 0,
      failureCount: 0,
      avgExecutionTimeMs: 0,
      lastUsedAt: null,
      confidenceScore: 1,
    },
    source: 'forged by agent agent-1 during session sess-1',
    ...overrides,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('EmergentToolRegistry state', () => {
  let db: SqliteTestAdapter;
  let registry: EmergentToolRegistry;

  beforeEach(async () => {
    db = createSqliteAdapter();
    registry = new EmergentToolRegistry(
      { ...DEFAULT_EMERGENT_CONFIG, enabled: true, persistSandboxSource: true },
      db,
    );
    await registry.ensureSchema();
  });

  it('stores the request with the tool and keeps is_active in step with the state', async () => {
    const tool = makeTool();
    registry.register(tool, 'agent');
    await settle();
    await registry.setState(tool.id, 'active', null, { kind: 'sandbox', capabilities: [] });

    expect(readStateRow(db, tool.id)).toMatchObject({
      state: 'active',
      state_reason: null,
      request: { kind: 'sandbox', capabilities: [] },
    });
    expect(readToolRow(db, tool.id)?.is_active).toBe(1);

    await registry.suspend(tool.id, 'operator_hold');

    expect(registry.getState(tool.id)).toMatchObject({ state: 'suspended', reason: 'operator_hold' });
    expect(readStateRow(db, tool.id)).toMatchObject({
      state: 'suspended',
      state_reason: 'operator_hold',
      // The request survives a state change that does not name one.
      request: { kind: 'sandbox', capabilities: [] },
    });
    expect(readToolRow(db, tool.id)?.is_active).toBe(0);
  });

  it('leaves a stored request it holds nothing for alone when the state changes', async () => {
    // A row a newer release wrote: this release's parser reads nothing from it,
    // and the registry holds no record for the tool. The state change must not
    // replace the column with what this process holds.
    db.raw
      .prepare(
        `INSERT INTO agentos_emergent_tool_state (tool_id, state, state_reason, state_at, request_json, updated_at)
         VALUES (?, 'active', NULL, ?, ?, ?)`,
      )
      .run('emergent_unloaded', 1, '{"kind":"sandbox","capabilities":["fs.read","fs.write"]}', 1);

    await registry.setState('emergent_unloaded', 'suspended', 'operator_hold');

    expect(readStateRow(db, 'emergent_unloaded')).toMatchObject({
      state: 'suspended',
      state_reason: 'operator_hold',
      request: { kind: 'sandbox', capabilities: ['fs.read', 'fs.write'] },
    });
    // Naming a request writes it; null clears it.
    await registry.setState('emergent_unloaded', 'suspended', 'operator_hold', null);
    expect(readStateRow(db, 'emergent_unloaded')?.request).toBeNull();
  });

  it('refuses to record a use of a tool that is not active', async () => {
    const tool = makeTool();
    registry.register(tool, 'agent');
    await settle();
    await registry.suspend(tool.id, 'operator_hold');

    expect(registry.recordUse(tool.id, {}, {}, true, 5)).toBe(false);
    expect(registry.get(tool.id)?.usageStats.totalUses).toBe(0);
  });

  it('a later persist never writes a suspended tool back as active', async () => {
    const tool = makeTool({ tier: 'session', id: 'emergent_test_2' });
    registry.register(tool, 'session');
    await settle();
    await registry.suspend(tool.id, 'operator_hold');

    // promote() rewrites the whole row; it must carry the held state.
    await registry.promote(tool.id, 'agent', 'admin');

    expect(readToolRow(db, tool.id)?.is_active).toBe(0);
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'suspended' });
  });

  it('a failed state write rejects, so a caller knows the suspension did not land', async () => {
    const tool = makeTool();
    registry.register(tool, 'agent');
    await settle();
    db.failNext('agentos_emergent_tool_state');

    await expect(registry.suspend(tool.id, 'operator_hold')).rejects.toThrow('simulated storage failure');
  });

  it('demote writes the demoted state and removing a tool removes its state row', async () => {
    const tool = makeTool();
    registry.register(tool, 'agent');
    await settle();

    await registry.demote(tool.id, 'bad output');
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'demoted', state_reason: 'bad output' });
    expect(registry.get(tool.id)?.usageStats.confidenceScore).toBe(0);

    registry.remove(tool.id);
    await settle();
    expect(readStateRow(db, tool.id)).toBeUndefined();
  });
});
