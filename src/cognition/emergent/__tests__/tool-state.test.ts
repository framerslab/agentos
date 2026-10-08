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

  it('stores the request with the tool and keeps is_active and the convention property in step with the state', async () => {
    const tool = makeTool();
    registry.register(tool, 'agent');
    await settle();
    const held = registry.get(tool.id) as EmergentTool & { isActive?: boolean };
    await registry.setState(tool.id, 'active', null, {
      request: { kind: 'sandbox', capabilities: [] },
      setBy: 'library',
    });

    expect(readStateRow(db, tool.id)).toMatchObject({
      state: 'active',
      state_reason: null,
      set_by: 'library',
      request: { kind: 'sandbox', capabilities: [] },
    });
    expect(readToolRow(db, tool.id)?.is_active).toBe(1);
    expect(held.isActive).toBe(true);

    await registry.suspend(tool.id, 'operator_hold');

    expect(registry.getState(tool.id)).toMatchObject({
      state: 'suspended',
      reason: 'operator_hold',
      setBy: 'host',
    });
    expect(readStateRow(db, tool.id)).toMatchObject({
      state: 'suspended',
      state_reason: 'operator_hold',
      // The host's word, whatever the reason says.
      set_by: 'host',
      // The request survives a state change that does not name one.
      request: { kind: 'sandbox', capabilities: [] },
    });
    expect(readToolRow(db, tool.id)?.is_active).toBe(0);
    expect(held.isActive).toBe(false);

    // A whole-row replacement from an object that says nothing, or the wrong
    // thing, about state: the property follows the held state.
    registry.upsert({ ...tool, description: 'Doubles a number, edited.' });
    expect((registry.get(tool.id) as EmergentTool & { isActive?: boolean }).isActive).toBe(false);
    registry.upsert({ ...tool, isActive: true } as EmergentTool);
    expect((registry.get(tool.id) as EmergentTool & { isActive?: boolean }).isActive).toBe(false);
    await settle();

    // Reactivated: the property follows, and the row says who did it.
    await registry.setState(tool.id, 'active', null, { setBy: 'host' });
    expect((registry.get(tool.id) as EmergentTool & { isActive?: boolean }).isActive).toBe(true);
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'active', set_by: 'host' });
    expect(readToolRow(db, tool.id)?.is_active).toBe(1);
  });

  it('a conditional write is refused when the row changed under it, and the flag follows the state row', async () => {
    const tool = makeTool({ id: 'emergent_test_7' });
    registry.register(tool, 'agent');
    await settle();
    await registry.suspend(tool.id, 'operator_hold');
    const at = Number(readStateRow(db, tool.id)?.state_at);

    // "No row yet" was the condition, and a row exists: refused; the row's word holds.
    const refused = await registry.setState(tool.id, 'active', null, { setBy: 'library', ifRow: 'absent' });
    expect(refused).toMatchObject({ state: 'suspended', reason: 'operator_hold', setBy: 'host' });
    expect(registry.isActive(tool.id)).toBe(false);
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'suspended' });
    expect(readToolRow(db, tool.id)?.is_active).toBe(0);

    // The row as it was read: applied.
    const applied = await registry.setState(tool.id, 'active', null, {
      setBy: 'library',
      ifRow: { at, state: 'suspended', setBy: 'host' },
    });
    expect(applied.state).toBe('active');
    expect(registry.isActive(tool.id)).toBe(true);
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'active' });
    expect(readToolRow(db, tool.id)?.is_active).toBe(1);
  });

  it('a whole-row write takes is_active at write time, so a state change another process makes during its reads is kept', async () => {
    const tool = makeTool({ id: 'emergent_test_6' });
    registry.register(tool, 'agent');
    await settle();
    await registry.suspend(tool.id, 'operator_hold');
    // A state write of this process waits for the row write in the tool's
    // queue; another process's lands during its reads.
    const other = new EmergentToolRegistry(
      { ...DEFAULT_EMERGENT_CONFIG, enabled: true, persistSandboxSource: true },
      db,
    );
    await other.ensureSchema();

    // The promotion's row read is held open; the reactivation lands meanwhile.
    const gate = db.gateNext('SELECT promoted_at');
    const promotion = registry.promote(tool.id, 'shared', 'admin');
    await gate.entered;
    await other.setState(tool.id, 'active', null, { setBy: 'host' });
    gate.release();
    await promotion;

    expect(readToolRow(db, tool.id)?.is_active).toBe(1);
    expect(readToolRow(db, tool.id)?.tier).toBe('shared');
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'active' });

    // The other direction: a suspension during the reads is kept too.
    const gate2 = db.gateNext('SELECT promoted_at');
    registry.upsert({ ...registry.get(tool.id)!, description: 'Doubles a number, again.' });
    await gate2.entered;
    await other.setState(tool.id, 'suspended', 'operator_hold', { setBy: 'host' });
    gate2.release();
    await registry.settled(tool.id);

    expect(readToolRow(db, tool.id)?.is_active).toBe(0);
    expect(readToolRow(db, tool.id)?.description).toBe('Doubles a number, again.');
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'suspended' });
  });

  it('a promotion runs in the tool write queue: a removal made during it is not undone, and an earlier read is not adopted', async () => {
    const tool = makeTool({ id: 'emergent_test_15', tier: 'session' });
    registry.register(tool, 'session');
    await settle();
    const readAt = registry.beginRead();

    // The promotion's row read is held open; the tool is removed meanwhile.
    const gate = db.gateNext('SELECT promoted_at');
    const promotion = registry.promote(tool.id, 'agent');
    await gate.entered;
    // A row read before the promotion is not adopted while it is under way.
    expect(registry.adopt({ ...tool }, { toolId: tool.id, state: 'active', reason: null, setBy: 'library', at: 1, request: null }, readAt)).toBe(false);
    registry.remove(tool.id);
    gate.release();
    await promotion;
    await registry.settled(tool.id);
    registry.endRead();

    expect(registry.get(tool.id)).toBeUndefined();
    expect(readToolRow(db, tool.id)).toBeUndefined();
    expect(readStateRow(db, tool.id)).toBeUndefined();
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
    await registry.setState('emergent_unloaded', 'suspended', 'operator_hold', { request: null });
    expect(readStateRow(db, 'emergent_unloaded')?.request).toBeNull();

    // A first write that names no request stores none, whatever this process
    // holds: the registry holds a request for the tool, its state row is gone,
    // and the write that recreates the row leaves request_json empty.
    const tool = makeTool({ id: 'emergent_first' });
    registry.register(tool, 'agent');
    await settle();
    await registry.setState(tool.id, 'active', null, {
      request: { kind: 'sandbox', capabilities: ['fetch'] },
      setBy: 'library',
    });
    db.raw.prepare('DELETE FROM agentos_emergent_tool_state WHERE tool_id = ?').run(tool.id);
    expect(registry.getState(tool.id)?.request).toEqual({ kind: 'sandbox', capabilities: ['fetch'] });
    await registry.setState(tool.id, 'suspended', 'operator_hold');
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'suspended', request_json: null });
  });

  it('a restriction made while a reactivation is being written is the word that stays', async () => {
    const tool = makeTool();
    registry.register(tool, 'agent');
    await settle();
    await registry.suspend(tool.id, 'operator_hold');

    // Not awaited in between: the demotion arrives while the reactivation's
    // writes run.
    const reactivation = registry.setState(tool.id, 'active', null, { setBy: 'host' });
    const demotion = registry.demote(tool.id, 'bad output');
    const [returned] = await Promise.all([reactivation, demotion]);

    expect(returned.state).toBe('demoted');
    expect(registry.isActive(tool.id)).toBe(false);
    expect((registry.get(tool.id) as EmergentTool & { isActive?: boolean }).isActive).toBe(false);
    expect(registry.recordUse(tool.id, {}, {}, true, 1)).toBe(false);
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'demoted', state_reason: 'bad output' });
    expect(readToolRow(db, tool.id)?.is_active).toBe(0);
    const states = registry.getAuditLog(tool.id).filter((e) => e.eventType === 'state').map((e) => (e.data as { state: string }).state);
    expect(states[states.length - 1]).toBe('demoted');
  });

  it('a reactivation whose write fails leaves the tool off, in memory and in storage', async () => {
    const tool = makeTool();
    registry.register(tool, 'agent');
    await settle();
    await registry.suspend(tool.id, 'operator_hold');

    db.failNext('agentos_emergent_tool_state');
    await expect(registry.setState(tool.id, 'active', null, { setBy: 'host' })).rejects.toThrow(
      'simulated storage failure',
    );

    expect(registry.isActive(tool.id)).toBe(false);
    expect((registry.get(tool.id) as EmergentTool & { isActive?: boolean }).isActive).toBe(false);
    expect(registry.recordUse(tool.id, {}, {}, true, 1)).toBe(false);
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'suspended' });
    expect(readToolRow(db, tool.id)?.is_active).toBe(0);
    // The trail records no change to active that never took effect.
    const states = registry.getAuditLog(tool.id).filter((e) => e.eventType === 'state').map((e) => (e.data as { state: string }).state);
    expect(states).not.toContain('active');
  });

  it('a whole-row write by a process that holds no state for the tool keeps its stored suspension', async () => {
    const tool = makeTool({ id: 'emergent_test_5' });
    registry.register(tool, 'agent');
    await settle();
    await registry.suspend(tool.id, 'operator_hold');

    // Another process on the same store, holding nothing for the tool, rewrites
    // its row from an object that says nothing about state.
    const other = new EmergentToolRegistry(
      { ...DEFAULT_EMERGENT_CONFIG, enabled: true, persistSandboxSource: true },
      db,
    );
    await other.ensureSchema();
    other.upsert({ ...tool, description: 'Doubles a number, again.' });
    await settle();

    expect(readToolRow(db, tool.id)?.description).toBe('Doubles a number, again.');
    expect(readToolRow(db, tool.id)?.is_active).toBe(0);
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'suspended', set_by: 'host' });
  });

  it('a whole-row write by a process that holds no state keeps a flag the host lowered with its own SQL, whatever the state row says', async () => {
    const tool = makeTool({ id: 'emergent_test_8' });
    registry.register(tool, 'agent');
    await settle();
    // The state row is written by a state write, not by registration.
    await registry.setState(tool.id, 'active', null, { setBy: 'library' });
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'active' });
    expect(readToolRow(db, tool.id)?.is_active).toBe(1);
    db.raw.prepare('UPDATE agentos_emergent_tools SET is_active = 0 WHERE id = ?').run(tool.id);

    const other = new EmergentToolRegistry(
      { ...DEFAULT_EMERGENT_CONFIG, enabled: true, persistSandboxSource: true },
      db,
    );
    await other.ensureSchema();
    other.upsert({ ...tool, description: 'Doubles a number, again.' });
    await settle();

    expect(readToolRow(db, tool.id)?.description).toBe('Doubles a number, again.');
    expect(readToolRow(db, tool.id)?.is_active).toBe(0);
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'active' });
  });

  it('a reactivation whose flag write fails is not held in memory, and its row says the flag write is pending', async () => {
    const tool = makeTool({ id: 'emergent_test_9' });
    registry.register(tool, 'agent');
    await settle();
    await registry.suspend(tool.id, 'operator_hold');

    db.failNext('SET is_active = COALESCE(');
    await expect(registry.setState(tool.id, 'active', null, { setBy: 'host' })).rejects.toThrow(
      'simulated storage failure',
    );

    expect(registry.isActive(tool.id)).toBe(false);
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'active', flag_synced: 0 });
    expect(readToolRow(db, tool.id)?.is_active).toBe(0);

    // The next state write finishes the flag write.
    await registry.setState(tool.id, 'active', null, { setBy: 'host' });
    expect(registry.isActive(tool.id)).toBe(true);
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'active', flag_synced: 1 });
    expect(readToolRow(db, tool.id)?.is_active).toBe(1);
  });

  it("a refused write leaves the flag as the host set it, even when the row's state is active", async () => {
    const tool = makeTool({ id: 'emergent_test_10' });
    registry.register(tool, 'agent');
    await settle();
    await registry.setState(tool.id, 'active', null, { setBy: 'library' });
    db.raw.prepare('UPDATE agentos_emergent_tools SET is_active = 0 WHERE id = ?').run(tool.id);

    // Another process read no state row, and writes on that condition.
    const other = new EmergentToolRegistry(
      { ...DEFAULT_EMERGENT_CONFIG, enabled: true, persistSandboxSource: true },
      db,
    );
    await other.ensureSchema();
    const refused = await other.setState(tool.id, 'active', null, { setBy: 'library', ifRow: 'absent' });

    expect(refused).toMatchObject({ state: 'active', setBy: 'library' });
    expect(readToolRow(db, tool.id)?.is_active).toBe(0);
  });

  it("a write overtaken by another process's reactivation holds that word in memory, active included", async () => {
    const tool = makeTool({ id: 'emergent_test_11' });
    registry.register(tool, 'agent');
    await settle();
    await registry.suspend(tool.id, 'operator_hold');
    const other = new EmergentToolRegistry(
      { ...DEFAULT_EMERGENT_CONFIG, enabled: true, persistSandboxSource: true },
      db,
    );
    await other.ensureSchema();

    // This registry's suspension is held before its flag write; the other
    // registry reactivates the tool meanwhile.
    const gate = db.gateNext('SET is_active = COALESCE(');
    const suspending = registry.setState(tool.id, 'suspended', 'operator_hold_again');
    await gate.entered;
    await other.setState(tool.id, 'active', null, { setBy: 'host' });
    gate.release();

    expect(await suspending).toMatchObject({ state: 'active', setBy: 'host' });
    expect(registry.isActive(tool.id)).toBe(true);
    expect((registry.get(tool.id) as EmergentTool & { isActive?: boolean }).isActive).toBe(true);
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'active' });
    expect(readToolRow(db, tool.id)?.is_active).toBe(1);
  });

  it("a write conditioned on no row, over a state row whose tool row is gone, reads as removed", async () => {
    db.raw
      .prepare(
        `INSERT INTO agentos_emergent_tool_state (tool_id, state, state_reason, state_at, request_json, updated_at)
         VALUES (?, 'active', NULL, ?, NULL, ?)`,
      )
      .run('emergent_gone', 1, 1);

    const result = await registry.setState('emergent_gone', 'active', null, { setBy: 'library', ifRow: 'absent' });

    expect(result).toMatchObject({ state: 'demoted', reason: 'removed' });
  });

  it('two activations in flight hold the later one', async () => {
    const tool = makeTool({ id: 'emergent_test_12' });
    registry.register(tool, 'agent');
    await settle();
    await registry.suspend(tool.id, 'operator_hold');

    const first = registry.setState(tool.id, 'active', null, { setBy: 'host' });
    const second = registry.setState(tool.id, 'active', null, { setBy: 'host' });
    await Promise.all([first, second]);

    expect(registry.isActive(tool.id)).toBe(true);
    expect(registry.getState(tool.id)?.writeId).toBe(readStateRow(db, tool.id)?.write_id);
  });

  it("a queued activation that lands after another process's suspension was observed holds its own write", async () => {
    const tool = makeTool({ id: 'emergent_test_13' });
    registry.register(tool, 'agent');
    await settle();
    await registry.suspend(tool.id, 'operator_hold');
    const other = new EmergentToolRegistry(
      { ...DEFAULT_EMERGENT_CONFIG, enabled: true, persistSandboxSource: true },
      db,
    );
    await other.ensureSchema();

    // Two activations queued in this process. The first's flag write is held
    // open; another process suspends the tool meanwhile, so the first reads
    // that suspension back and holds it. The second then lands as the newer
    // word, and this process holds it as such.
    const gate = db.gateNext('SET is_active = COALESCE(');
    const first = registry.setState(tool.id, 'active', null, { setBy: 'host' });
    const second = registry.setState(tool.id, 'active', null, { setBy: 'host' });
    await gate.entered;
    await other.setState(tool.id, 'suspended', 'operator_hold_elsewhere', { setBy: 'host' });
    gate.release();

    expect(await first).toMatchObject({ state: 'suspended', reason: 'operator_hold_elsewhere' });
    expect(await second).toMatchObject({ state: 'active' });
    expect(registry.isActive(tool.id)).toBe(true);
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'active' });
    expect(readToolRow(db, tool.id)?.is_active).toBe(1);
    expect(registry.getState(tool.id)?.writeId).toBe(readStateRow(db, tool.id)?.write_id);
  });

  it('a tool registered before the schema is ready gets its row, and its first state write lands after it', async () => {
    const fresh = new EmergentToolRegistry(
      { ...DEFAULT_EMERGENT_CONFIG, enabled: true, persistSandboxSource: true },
      db,
    );
    const tool = makeTool({ id: 'emergent_test_14' });
    fresh.register(tool, 'agent');
    const record = await fresh.setState(tool.id, 'active', null, {
      request: { kind: 'sandbox', capabilities: ['crypto'] },
      setBy: 'library',
    });

    expect(record).toMatchObject({ state: 'active' });
    expect(fresh.isActive(tool.id)).toBe(true);
    expect(readToolRow(db, tool.id)).toMatchObject({ name: tool.name, is_active: 1 });
    expect(readStateRow(db, tool.id)).toMatchObject({ state: 'active', request: { kind: 'sandbox', capabilities: ['crypto'] } });
  });

  it('cleaning up a session leaves the tools of a session whose id merely begins the same way', async () => {
    const one = { ...makeTool({ id: 'emergent_sess_1' }), source: 'forged by agent a during session sess-1' };
    const ten = { ...makeTool({ id: 'emergent_sess_10' }), source: 'forged by agent a during session sess-10' };
    registry.register(one, 'session');
    registry.register(ten, 'session');
    await settle();

    expect(registry.cleanupSession('sess-1')).toBe(1);

    expect(registry.get(one.id)).toBeUndefined();
    expect(registry.get(ten.id)).toBeDefined();
    await registry.settled(one.id);
    expect(readToolRow(db, one.id)).toBeUndefined();
    expect(readToolRow(db, ten.id)).toBeDefined();
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

  it('demote writes the demoted state as the host\'s and removing a tool removes its state row', async () => {
    const tool = makeTool();
    registry.register(tool, 'agent');
    await settle();

    await registry.demote(tool.id, 'bad output');
    expect(readStateRow(db, tool.id)).toMatchObject({
      state: 'demoted',
      state_reason: 'bad output',
      set_by: 'host',
    });
    expect(registry.get(tool.id)?.usageStats.confidenceScore).toBe(0);
    expect((registry.get(tool.id) as EmergentTool & { isActive?: boolean }).isActive).toBe(false);

    registry.remove(tool.id);
    await settle();
    expect(readStateRow(db, tool.id)).toBeUndefined();
  });

  it('an awaited demote rejects when its write fails, and an un-awaited one is handled', async () => {
    const tool = makeTool();
    registry.register(tool, 'agent');
    await settle();

    db.failNext('agentos_emergent_tool_state');
    await expect(registry.demote(tool.id, 'bad output')).rejects.toThrow('simulated storage failure');
    // The restriction held in memory even though the row did not change.
    expect(registry.isActive(tool.id)).toBe(false);

    // A caller written against the old void signature does not await. A
    // failed write must not surface as an unhandled rejection, which vitest
    // reports as a failure of this run.
    db.failNext('agentos_emergent_tool_state');
    void registry.demote(tool.id, 'bad output again');
    await settle();
    await settle();
  });

  it('recording a use updates the usage columns and leaves the stored source alone', async () => {
    // The row was written by a host with its own SQL, in the JSON form.
    const stored = JSON.stringify({
      mode: 'sandbox',
      code: 'function execute(input) { return { doubled: input.n * 2 }; }',
      allowlist: [],
    });
    const tool = makeTool({ id: 'emergent_test_3' });
    registry.register(tool, 'agent');
    await settle();
    db.raw
      .prepare('UPDATE agentos_emergent_tools SET implementation_source = ? WHERE id = ?')
      .run(stored, tool.id);

    expect(registry.recordUse(tool.id, { n: 1 }, { doubled: 2 }, true, 12)).toBe(true);
    await settle();

    const row = readToolRow(db, tool.id);
    expect(row?.implementation_source).toBe(stored);
    expect(row?.total_uses).toBe(1);
    expect(row?.success_count).toBe(1);
    expect(row?.avg_execution_ms).toBe(12);
  });

  it('with source persistence off, a rewrite keeps a stored source instead of redacting it', async () => {
    const offDb = createSqliteAdapter();
    const offRegistry = new EmergentToolRegistry(
      { ...DEFAULT_EMERGENT_CONFIG, enabled: true, persistSandboxSource: false },
      offDb,
    );
    await offRegistry.ensureSchema();
    const code = 'function execute(input) { return { doubled: input.n * 2 }; }';
    const tool = makeTool({ id: 'emergent_test_4', tier: 'agent' });
    offRegistry.register(tool, 'agent');
    await settle();
    // A fresh forge with persistence off stores the redacted record.
    expect(String(readToolRow(offDb, tool.id)?.implementation_source)).toContain('"redacted":true');

    // A host stored the code itself; a later whole-row rewrite must keep it.
    offDb.raw
      .prepare('UPDATE agentos_emergent_tools SET implementation_source = ? WHERE id = ?')
      .run(code, tool.id);
    await offRegistry.promote(tool.id, 'shared', 'admin');

    expect(readToolRow(offDb, tool.id)?.implementation_source).toBe(code);
    expect(readToolRow(offDb, tool.id)?.tier).toBe('shared');

    // A source in a form this release does not know is kept too; only a
    // redacted record is ever written over.
    const unknownShape = '{"v":2,"body":"function execute(i){return i}"}';
    offDb.raw
      .prepare('UPDATE agentos_emergent_tools SET implementation_source = ? WHERE id = ?')
      .run(unknownShape, tool.id);
    expect(offRegistry.recordUse(tool.id, {}, {}, true, 3)).toBe(true);
    await settle();
    offRegistry.upsert({ ...offRegistry.get(tool.id)!, description: 'Doubles a number, twice over.' });
    await settle();
    expect(readToolRow(offDb, tool.id)?.implementation_source).toBe(unknownShape);
    expect(readToolRow(offDb, tool.id)?.description).toBe('Doubles a number, twice over.');
  });
});
