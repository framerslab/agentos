import { describe, it, expect } from 'vitest';
import type { EmergentTool } from '../types.js';
import { createSqliteAdapter, readStateRow, readToolRow } from './helpers/sqlite-adapter.js';
import { callTool, echoTool, makeForgeHost } from './helpers/forge-host.js';
import {
  DOUBLED_OUT,
  ID_OUT,
  NUMBER_IN,
  RAW_DOUBLE,
  RAW_ID,
  TEXT_IN,
  TEXT_OUT,
  seedStateRow,
  seedToolRow,
} from './helpers/seed-rows.js';

const SUM_CODE = 'function execute(input) { return { sum: input.a + input.b }; }';
const SUM_IN = {
  type: 'object',
  properties: { a: { type: 'number' }, b: { type: 'number' } },
  required: ['a', 'b'],
};
const SUM_OUT = { type: 'object', properties: { sum: { type: 'number' } }, required: ['sum'] };

describe('stored tools: the loader, legacy rows and suspension', () => {
  it('loads the three stored forms, keeps a row a host turned off, and never rewrites a row', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'raw-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    seedToolRow(db, { id: 'raw-2', name: 'make_id', mode: 'sandbox', source: RAW_ID, outputSchema: ID_OUT });
    const jsonSource = JSON.stringify({ mode: 'sandbox', code: SUM_CODE, allowlist: [] });
    seedToolRow(db, {
      id: 'json-1',
      name: 'add_them',
      mode: 'sandbox',
      source: jsonSource,
      inputSchema: SUM_IN,
      outputSchema: SUM_OUT,
    });
    seedToolRow(db, {
      id: 'redacted-1',
      name: 'lost_source',
      mode: 'sandbox',
      source: JSON.stringify({
        redacted: true,
        reason: 'sandbox-source-not-persisted',
        allowlist: ['fetch'],
        codeBytes: 64,
      }),
    });
    seedToolRow(db, {
      id: 'off-1',
      name: 'turned_off',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      isActive: 0,
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });

    const summary = await host.engine.loadPersistedTools({ tiers: ['agent', 'shared'], agentId: 'agent-seed' });

    expect(summary).toMatchObject({ active: 3, suspended: 1, demoted: 1, failed: [] });
    // Raw code: the request is inferred from the code and stored.
    expect(readStateRow(db, 'raw-2')).toMatchObject({
      state: 'active',
      request: { kind: 'sandbox', capabilities: ['crypto'], inferred: true },
    });
    // Code stored with its list: the request is the stored list, nothing inferred.
    expect(readStateRow(db, 'json-1')).toMatchObject({
      state: 'active',
      request: { kind: 'sandbox', capabilities: [] },
    });
    expect(readStateRow(db, 'redacted-1')).toMatchObject({
      state: 'suspended',
      state_reason: 'source_not_persisted',
    });
    expect(readStateRow(db, 'off-1')).toMatchObject({
      state: 'demoted',
      state_reason: 'legacy_inactive',
    });

    // The loaded tools run through the orchestrator.
    expect((await callTool(host.orchestrator, 'double_it', { n: 21 })).output).toEqual({ doubled: 42 });
    expect((await callTool(host.orchestrator, 'add_them', { a: 2, b: 3 })).output).toEqual({ sum: 5 });
    const made = await callTool(host.orchestrator, 'make_id', {});
    expect(typeof made.output.id).toBe('string');
    expect(await host.orchestrator.getTool('lost_source')).toBeUndefined();
    expect(await host.orchestrator.getTool('turned_off')).toBeUndefined();

    // Loading and calling left the stored source exactly as the host wrote it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readToolRow(db, 'json-1')?.implementation_source).toBe(jsonSource);
    expect(readToolRow(db, 'json-1')?.total_uses).toBe(1);
  });

  it('a stored request this release cannot read survives a load, a suspension and a reactivation', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'raw-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    // A newer release wrote a capability this one does not know.
    const foreign = '{"kind":"sandbox","capabilities":["fs.read","fs.write"]}';
    seedStateRow(db, { toolId: 'raw-1', state: 'active', requestJson: foreign });

    const summary = await host.engine.loadPersistedTools({ tiers: ['shared'] });
    expect(summary.outcomes).toEqual([{ toolId: 'raw-1', name: 'double_it', state: 'active', reason: null }]);
    expect((await callTool(host.orchestrator, 'double_it', { n: 3 })).output).toEqual({ doubled: 6 });
    expect(readStateRow(db, 'raw-1')?.request_json).toBe(foreign);

    expect(await host.engine.suspendTool('raw-1', 'host_hold')).toBe(true);
    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'suspended', request_json: foreign });

    expect(await host.engine.reactivateTool('raw-1')).toMatchObject({ state: 'active' });
    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'active', request_json: foreign });
    expect((await callTool(host.orchestrator, 'double_it', { n: 4 })).output).toEqual({ doubled: 8 });
  });

  it('a suspension holds across a use, a host-built sync and the next load, until the host clears it', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'raw-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    await host.engine.loadPersistedTools({ tiers: ['shared'] });

    expect(await host.engine.suspendTool('raw-1', 'operator_hold')).toBe(true);

    expect(await host.orchestrator.getTool('double_it')).toBeUndefined();
    expect((await callTool(host.orchestrator, 'double_it', { n: 1 })).isError).toBe(true);
    expect(readStateRow(db, 'raw-1')).toMatchObject({
      state: 'suspended',
      state_reason: 'operator_hold',
    });
    expect(readToolRow(db, 'raw-1')?.is_active).toBe(0);

    // A host that rebuilds the tool from its own row does not bring it back.
    const hostBuilt: EmergentTool = {
      id: 'raw-1',
      name: 'double_it',
      description: 'Seeded tool double_it.',
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
      implementation: { mode: 'sandbox', code: RAW_DOUBLE, allowlist: [] },
      tier: 'shared',
      createdBy: 'agent-seed',
      createdAt: new Date(1_700_000_000_000).toISOString(),
      judgeVerdicts: [],
      usageStats: {
        totalUses: 0,
        successCount: 0,
        failureCount: 0,
        avgExecutionTimeMs: 0,
        lastUsedAt: null,
        confidenceScore: 0.9,
      },
      source: 'forged by agent agent-seed during session sess-seed',
    };
    expect(await host.engine.syncPersistedTool(hostBuilt)).toMatchObject({
      state: 'suspended',
      reason: 'operator_hold',
    });
    expect(await host.orchestrator.getTool('double_it')).toBeUndefined();

    // Nor does the next load: the reason is the host's, not the library's.
    const again = await host.engine.loadPersistedTools({ tiers: ['shared'] });
    expect(again.outcomes).toEqual([
      { toolId: 'raw-1', name: 'double_it', state: 'suspended', reason: 'operator_hold' },
    ]);
    expect(await host.orchestrator.getTool('double_it')).toBeUndefined();

    // The host clears it.
    expect(await host.engine.reactivateTool('raw-1')).toMatchObject({ state: 'active' });
    expect((await callTool(host.orchestrator, 'double_it', { n: 4 })).output).toEqual({ doubled: 8 });
    expect(readToolRow(db, 'raw-1')?.is_active).toBe(1);
  });

  it("a host's suspension holds through the next load even when its reason is one of the library's words, and a library suspension lifts when its cause is gone", async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'raw-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    seedToolRow(db, { id: 'odd-1', name: 'odd_shape', mode: 'sandbox', source: '{"v":2}' });
    const first = await host.engine.loadPersistedTools({ tiers: ['shared'] });
    expect(first.outcomes).toContainEqual({ toolId: 'raw-1', name: 'double_it', state: 'active', reason: null });
    expect(first.outcomes).toContainEqual({
      toolId: 'odd-1',
      name: 'odd_shape',
      state: 'suspended',
      reason: 'source_unreadable',
    });
    expect(readStateRow(db, 'odd-1')).toMatchObject({ state: 'suspended', set_by: 'library' });

    // The host holds the tool under its own policy and happens to use a word
    // the library also uses. Who set the suspension decides, not the word.
    expect(await host.engine.suspendTool('raw-1', 'source_unreadable')).toBe(true);
    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'suspended', set_by: 'host' });

    // The unreadable row is repaired by the host's own SQL.
    db.raw.prepare('UPDATE agentos_emergent_tools SET implementation_source = ? WHERE id = ?').run(RAW_DOUBLE, 'odd-1');

    const again = await host.engine.loadPersistedTools({ tiers: ['shared'] });
    expect(again.outcomes).toContainEqual({
      toolId: 'raw-1',
      name: 'double_it',
      state: 'suspended',
      reason: 'source_unreadable',
    });
    expect(again.outcomes).toContainEqual({ toolId: 'odd-1', name: 'odd_shape', state: 'active', reason: null });
    expect(await host.orchestrator.getTool('double_it')).toBeUndefined();
    expect((await callTool(host.orchestrator, 'odd_shape', { n: 2 })).output).toEqual({ doubled: 4 });
    expect(readStateRow(db, 'odd-1')).toMatchObject({ state: 'active', set_by: 'library' });

    // Only the host lifts its own hold.
    expect(await host.engine.reactivateTool('raw-1')).toMatchObject({ state: 'active' });
    expect((await callTool(host.orchestrator, 'double_it', { n: 2 })).output).toEqual({ doubled: 4 });
  });

  it("a refused reactivation of a host's suspension leaves it the host's, whatever words it uses", async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'raw-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    await host.engine.loadPersistedTools({ tiers: ['shared'] });
    expect(await host.engine.suspendTool('raw-1', 'source_unreadable')).toBe(true);

    // The source breaks; the host's reactivation is refused for the same words.
    db.raw.prepare('UPDATE agentos_emergent_tools SET implementation_source = ? WHERE id = ?').run('{"v":2}', 'raw-1');
    expect(await host.engine.reactivateTool('raw-1')).toMatchObject({ state: 'suspended', reason: 'source_unreadable' });
    // The refusal is the library's finding, so a later load re-checks it.
    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'suspended', set_by: 'library' });

    // Repaired: the next load lifts the library's suspension.
    db.raw.prepare('UPDATE agentos_emergent_tools SET implementation_source = ? WHERE id = ?').run(RAW_DOUBLE, 'raw-1');
    const again = await host.engine.loadPersistedTools({ tiers: ['shared'] });
    expect(again.outcomes).toEqual([{ toolId: 'raw-1', name: 'double_it', state: 'active', reason: null }]);
    expect((await callTool(host.orchestrator, 'double_it', { n: 3 })).output).toEqual({ doubled: 6 });
  });

  it('a row whose state write fails at load is reported failed and is not registered, and loads at the next start', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'raw-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      tier: 'agent',
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    // The full statement text: the loader's own row read joins the state table.
    db.failNext('INSERT INTO agentos_emergent_tool_state');

    const summary = await host.engine.loadPersistedTools({ tiers: ['agent'], agentId: 'agent-seed' });

    expect(summary.failed).toEqual([{ toolId: 'raw-1', name: 'double_it', error: 'simulated storage failure' }]);
    expect(summary.outcomes).toEqual([]);
    expect(host.engine.getAgentTools('agent-seed')).toEqual([]);
    expect(await host.orchestrator.getTool('double_it')).toBeUndefined();
    expect(readToolRow(db, 'raw-1')?.is_active).toBe(1);
    expect(readStateRow(db, 'raw-1')).toBeUndefined();

    const again = await host.engine.loadPersistedTools({ tiers: ['agent'], agentId: 'agent-seed' });
    expect(again.outcomes).toEqual([{ toolId: 'raw-1', name: 'double_it', state: 'active', reason: null }]);
    expect((await callTool(host.orchestrator, 'double_it', { n: 2 }, { personaId: 'agent-seed' })).output).toEqual({
      doubled: 4,
    });
  });

  it('a suspension or a demotion another process stored is taken in at the next load, and the executable goes', async () => {
    const db = createSqliteAdapter();
    const hostA = await makeForgeHost({ db });
    const hostB = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'raw-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    await hostA.engine.loadPersistedTools({ tiers: ['shared'] });
    await hostB.engine.loadPersistedTools({ tiers: ['shared'] });
    expect((await callTool(hostA.orchestrator, 'double_it', { n: 2 })).output).toEqual({ doubled: 4 });

    expect(await hostB.engine.suspendTool('raw-1', 'operator_hold')).toBe(true);

    const again = await hostA.engine.loadPersistedTools({ tiers: ['shared'] });
    expect(again.outcomes).toEqual([
      { toolId: 'raw-1', name: 'double_it', state: 'suspended', reason: 'operator_hold' },
    ]);
    expect(await hostA.orchestrator.getTool('double_it')).toBeUndefined();
    expect((await callTool(hostA.orchestrator, 'double_it', { n: 2 })).isError).toBe(true);

    // The host clears it on one side; the other takes a demotion in the same way.
    expect(await hostB.engine.reactivateTool('raw-1')).toMatchObject({ state: 'active' });
    expect((await hostA.engine.loadPersistedTools({ tiers: ['shared'] })).outcomes[0]).toMatchObject({ state: 'active' });
    expect((await callTool(hostA.orchestrator, 'double_it', { n: 3 })).output).toEqual({ doubled: 6 });
    expect(await hostB.engine.demoteTool('raw-1', 'bad output')).toBe(true);
    const demoted = await hostA.engine.loadPersistedTools({ tiers: ['shared'] });
    expect(demoted.outcomes).toEqual([{ toolId: 'raw-1', name: 'double_it', state: 'demoted', reason: 'bad output' }]);
    expect(await hostA.orchestrator.getTool('double_it')).toBeUndefined();
  });

  it("a raw-code row's stored request, not the text of its code, is what the rebuilt tool may reach", async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    // The text scan reads `crypto.` only; this code reaches crypto another way,
    // and the request stored when it was forged says what it was granted.
    const code = 'function execute(input) { const c = crypto; return { id: c.randomUUID() }; }';
    seedToolRow(db, { id: 'raw-3', name: 'make_id', mode: 'sandbox', source: code, outputSchema: ID_OUT });
    seedStateRow(db, {
      toolId: 'raw-3',
      state: 'active',
      setBy: 'library',
      requestJson: '{"kind":"sandbox","capabilities":["crypto"]}',
    });

    const summary = await host.engine.loadPersistedTools({ tiers: ['shared'] });

    expect(summary.outcomes).toEqual([{ toolId: 'raw-3', name: 'make_id', state: 'active', reason: null }]);
    const made = await callTool(host.orchestrator, 'make_id', {});
    expect(made.isError).toBeFalsy();
    expect(typeof made.output.id).toBe('string');
    // The stored request is untouched by the load.
    expect(readStateRow(db, 'raw-3')?.request).toEqual({ kind: 'sandbox', capabilities: ['crypto'] });
  });

  it('a reactivation recovers a tool whose suspension failed to store', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'raw-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    await host.engine.loadPersistedTools({ tiers: ['shared'] });

    db.failNext('INSERT INTO agentos_emergent_tool_state');
    await expect(host.engine.suspendTool('raw-1', 'operator_hold')).rejects.toThrow('simulated storage failure');
    // Held off in this process while the row still reads active.
    expect((await callTool(host.orchestrator, 'double_it', { n: 1 })).isError).toBe(true);
    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'active' });

    expect(await host.engine.reactivateTool('raw-1')).toMatchObject({ state: 'active' });
    expect((await callTool(host.orchestrator, 'double_it', { n: 2 })).output).toEqual({ doubled: 4 });
  });

  it('demoting a tool leaves a later tool of the same name callable', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    const first = await callTool(host.orchestrator, 'forge_tool', {
      name: 'make_id',
      description: 'Returns a fresh identifier.',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: ID_OUT,
      implementation: { mode: 'sandbox', code: RAW_ID, allowlist: ['crypto'] },
      testCases: [{ input: {}, expectedOutput: {} }],
    });
    const second = await callTool(host.orchestrator, 'forge_tool', {
      name: 'make_id',
      description: 'Returns a fixed identifier.',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: ID_OUT,
      implementation: { mode: 'sandbox', code: "function execute(input) { return { id: 'fixed-id' }; }", allowlist: [] },
      testCases: [{ input: {}, expectedOutput: { id: 'fixed-id' } }],
    });
    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    const older = String(first.output.toolId);

    // The newer tool holds the name in the executor; demoting the older one
    // must not take the newer one's executable away.
    expect(await host.engine.demoteTool(older, 'superseded')).toBe(true);
    const made = await callTool(host.orchestrator, 'make_id', {});
    expect(made.isError).toBeFalsy();
    expect(made.output).toEqual({ id: 'fixed-id' });
  });

  it('a load that read a row before another process suspended it does not write over the suspension', async () => {
    const db = createSqliteAdapter();
    const hostA = await makeForgeHost({ db });
    const hostB = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'raw-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });

    // Host A has read the row and is about to write its active state when host
    // B's suspension lands.
    const gate = db.gateNext('INSERT INTO agentos_emergent_tool_state');
    const loading = hostA.engine.loadPersistedTools({ tiers: ['shared'] });
    await gate.entered;
    expect(await hostB.engine.suspendTool('raw-1', 'operator_hold')).toBe(true);
    gate.release();
    const summary = await loading;

    expect(summary.outcomes).toEqual([
      { toolId: 'raw-1', name: 'double_it', state: 'suspended', reason: 'operator_hold' },
    ]);
    expect(await hostA.orchestrator.getTool('double_it')).toBeUndefined();
    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'suspended', set_by: 'host' });
    expect(readToolRow(db, 'raw-1')?.is_active).toBe(0);
  });

  it('a row whose input_schema does not read loads suspended as unreadable instead of accepting any input', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'bad-schema-1',
      name: 'bad_schema',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      inputSchemaRaw: 'not json',
    });

    const summary = await host.engine.loadPersistedTools({ tiers: ['shared'] });

    expect(summary.outcomes).toEqual([
      { toolId: 'bad-schema-1', name: 'bad_schema', state: 'suspended', reason: 'source_unreadable' },
    ]);
    expect(summary.failed).toEqual([]);
    expect(await host.orchestrator.getTool('bad_schema')).toBeUndefined();
    // The row keeps its columns as the host wrote them.
    expect(readToolRow(db, 'bad-schema-1')?.input_schema).toBe('not json');
    expect(readToolRow(db, 'bad-schema-1')?.is_active).toBe(0);
  });

  it('a row a host turns off with its own SQL is demoted at the next load and taken out of the executor', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db, tools: [echoTool()] });
    seedToolRow(db, {
      id: 'compose-1',
      name: 'echo_once',
      mode: 'compose',
      source: JSON.stringify({
        mode: 'compose',
        steps: [{ name: 's1', tool: 'echo', inputMapping: { text: '$input.text' } }],
      }),
      inputSchema: TEXT_IN,
      outputSchema: TEXT_OUT,
    });
    await host.engine.loadPersistedTools({ tiers: ['shared'] });
    expect((await callTool(host.orchestrator, 'echo_once', { text: 'hi' })).output).toEqual({ text: 'hi' });
    expect(readStateRow(db, 'compose-1')).toMatchObject({
      state: 'active',
      request: { kind: 'compose', steps: [{ name: 's1', tool: 'echo' }] },
    });

    db.raw.prepare('UPDATE agentos_emergent_tools SET is_active = 0 WHERE id = ?').run('compose-1');
    const again = await host.engine.loadPersistedTools({ tiers: ['shared'] });

    expect(again.outcomes).toEqual([
      { toolId: 'compose-1', name: 'echo_once', state: 'demoted', reason: 'legacy_inactive' },
    ]);
    expect(await host.orchestrator.getTool('echo_once')).toBeUndefined();
    expect(readStateRow(db, 'compose-1')).toMatchObject({ state: 'demoted' });
  });

  it('a load whose flag write fails is reported failed, and the next load finishes the flag write', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'raw-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    db.failNext('SET is_active = COALESCE(');

    const summary = await host.engine.loadPersistedTools({ tiers: ['shared'] });

    expect(summary.failed).toEqual([{ toolId: 'raw-1', name: 'double_it', error: 'simulated storage failure' }]);
    expect(await host.orchestrator.getTool('double_it')).toBeUndefined();
    // The state row landed with its flag write still marked pending.
    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'active', flag_synced: 0 });

    const again = await host.engine.loadPersistedTools({ tiers: ['shared'] });
    expect(again.outcomes).toEqual([{ toolId: 'raw-1', name: 'double_it', state: 'active', reason: null }]);
    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'active', flag_synced: 1 });
    expect(readToolRow(db, 'raw-1')?.is_active).toBe(1);
    expect((await callTool(host.orchestrator, 'double_it', { n: 2 })).output).toEqual({ doubled: 4 });
  });

  it('a state row whose flag write never finished is finished at the next load, in either direction', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'raw-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      isActive: 0,
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    seedStateRow(db, {
      toolId: 'raw-1',
      state: 'active',
      setBy: 'library',
      requestJson: '{"kind":"sandbox","capabilities":[]}',
      flagSynced: 0,
    });
    seedToolRow(db, { id: 'raw-2', name: 'sum_it', mode: 'sandbox', source: SUM_CODE, inputSchema: SUM_IN, outputSchema: SUM_OUT });
    seedStateRow(db, { toolId: 'raw-2', state: 'suspended', reason: 'operator_hold', setBy: 'host', requestJson: null, flagSynced: 0 });

    const summary = await host.engine.loadPersistedTools({ tiers: ['shared'] });

    expect(summary.outcomes).toEqual(
      expect.arrayContaining([
        { toolId: 'raw-1', name: 'double_it', state: 'active', reason: null },
        { toolId: 'raw-2', name: 'sum_it', state: 'suspended', reason: 'operator_hold' },
      ]),
    );
    expect(readToolRow(db, 'raw-1')?.is_active).toBe(1);
    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'active', flag_synced: 1 });
    expect(readToolRow(db, 'raw-2')?.is_active).toBe(0);
    expect(readStateRow(db, 'raw-2')).toMatchObject({ state: 'suspended', flag_synced: 1 });
    expect((await callTool(host.orchestrator, 'double_it', { n: 2 })).output).toEqual({ doubled: 4 });
    expect(await host.orchestrator.getTool('sum_it')).toBeUndefined();
  });

  it('a code row holding JSON of neither stored shape loads suspended as unreadable', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    const unknownShape = '{"v":2,"body":"function execute(i){return i}"}';
    seedToolRow(db, { id: 'odd-1', name: 'odd_shape', mode: 'sandbox', source: unknownShape });

    const summary = await host.engine.loadPersistedTools({ tiers: ['shared'] });

    expect(summary.outcomes).toEqual([
      { toolId: 'odd-1', name: 'odd_shape', state: 'suspended', reason: 'source_unreadable' },
    ]);
    expect(await host.orchestrator.getTool('odd_shape')).toBeUndefined();
    // The row keeps the source as the host wrote it.
    expect(readToolRow(db, 'odd-1')?.implementation_source).toBe(unknownShape);
    expect(readToolRow(db, 'odd-1')?.is_active).toBe(0);
  });

  it('a forged tool stores what it asked for, and removing it takes it out of the executor', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });

    const forged = await callTool(host.orchestrator, 'forge_tool', {
      name: 'make_id',
      description: 'Returns a fresh identifier.',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: ID_OUT,
      implementation: { mode: 'sandbox', code: RAW_ID, allowlist: ['crypto'] },
      testCases: [{ input: {}, expectedOutput: {} }],
    });

    expect(forged.isError).toBeFalsy();
    const toolId = String(forged.output.toolId);
    expect(readStateRow(db, toolId)).toMatchObject({
      state: 'active',
      request: { kind: 'sandbox', capabilities: ['crypto'] },
    });
    expect(await host.orchestrator.getTool('make_id')).toBeDefined();

    await host.engine.removeTool(toolId);

    expect(await host.orchestrator.getTool('make_id')).toBeUndefined();
  });

  it('with source persistence off, a tool forged in this process survives a later load, and demoteTool takes it out for good', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db, config: { persistSandboxSource: false } });
    const forged = await callTool(host.orchestrator, 'forge_tool', {
      name: 'double_it',
      description: 'Doubles a number.',
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
      implementation: { mode: 'sandbox', code: RAW_DOUBLE, allowlist: [] },
      testCases: [{ input: { n: 2 }, expectedOutput: { doubled: 4 } }],
    }, { sessionId: 'sess-test' });
    expect(forged.isError).toBeFalsy();
    const toolId = String(forged.output.toolId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The row holds the redacted record, not the code.
    expect(String(readToolRow(db, toolId)?.implementation_source)).toContain('"redacted":true');

    const summary = await host.engine.loadPersistedTools({ tiers: ['session'], sessionId: 'sess-test' });

    expect(summary.outcomes).toEqual([{ toolId, name: 'double_it', state: 'active', reason: null }]);
    expect((await callTool(host.orchestrator, 'double_it', { n: 5 })).output).toEqual({ doubled: 10 });

    expect(await host.engine.demoteTool(toolId, 'bad output')).toBe(true);

    expect(await host.orchestrator.getTool('double_it')).toBeUndefined();
    expect(readStateRow(db, toolId)).toMatchObject({ state: 'demoted', state_reason: 'bad output' });
    const again = await host.engine.loadPersistedTools({ tiers: ['session'], sessionId: 'sess-test' });
    expect(again.outcomes).toEqual([
      { toolId, name: 'double_it', state: 'demoted', reason: 'bad output' },
    ]);
  });

  it("an agent's stored tools load for that agent only, and a loaded agent tool runs for its agent only", async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'a-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      tier: 'agent',
      createdBy: 'agent-a',
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    seedToolRow(db, {
      id: 'b-1',
      name: 'sum_it',
      mode: 'sandbox',
      source: SUM_CODE,
      tier: 'agent',
      createdBy: 'agent-b',
      inputSchema: SUM_IN,
      outputSchema: SUM_OUT,
    });
    seedToolRow(db, {
      id: 's-1',
      name: 'echo_text',
      mode: 'sandbox',
      source: 'function execute(input) { return { text: input.text }; }',
      tier: 'shared',
      inputSchema: TEXT_IN,
      outputSchema: TEXT_OUT,
    });

    // A private tier without its selector is refused, whatever else is asked for.
    await expect(host.engine.loadPersistedTools({ tiers: ['agent', 'shared'] })).rejects.toThrow(/selector_required/);
    await expect(host.engine.loadPersistedTools({ tiers: ['session'] })).rejects.toThrow(/selector_required/);
    expect(await host.orchestrator.getTool('echo_text')).toBeUndefined();

    const loaded = await host.engine.loadPersistedTools({ tiers: ['agent', 'shared'], agentId: 'agent-a' });
    expect(loaded.outcomes.map((o) => o.toolId).sort()).toEqual(['a-1', 's-1']);
    expect(await host.orchestrator.getTool('sum_it')).toBeUndefined();

    // The agent tool runs for its persona and refuses every other, whatever
    // GMI instance calls; the shared one runs for both.
    expect(
      (await callTool(host.orchestrator, 'double_it', { n: 2 }, { personaId: 'agent-a', gmiId: 'gmi-instance-1' }))
        .output,
    ).toEqual({ doubled: 4 });
    const other = await callTool(host.orchestrator, 'double_it', { n: 2 }, { personaId: 'agent-b' });
    expect(other.isError).toBe(true);
    expect(JSON.stringify(other)).toMatch(/belongs to agent agent-a/);
    expect((await callTool(host.orchestrator, 'echo_text', { text: 'hi' }, { personaId: 'agent-b' })).output).toEqual(
      { text: 'hi' },
    );
  });

  it('a code-with-list row runs with its stored request when that is narrower than its list', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'list-f',
      name: 'fetch_it',
      mode: 'sandbox',
      source: JSON.stringify({
        mode: 'sandbox',
        code: 'function execute(input) { return fetch(input.url).then((r) => ({ ok: r.ok })); }',
        allowlist: ['fetch'],
      }),
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    seedStateRow(db, { toolId: 'list-f', state: 'active', setBy: 'library', requestJson: '{"kind":"sandbox","capabilities":[]}' });

    const summary = await host.engine.loadPersistedTools({ tiers: ['shared'] });

    expect(summary.outcomes).toEqual([{ toolId: 'list-f', name: 'fetch_it', state: 'active', reason: null }]);
    const called = await callTool(host.orchestrator, 'fetch_it', { url: 'http://127.0.0.1:9/' });
    expect(called.isError).toBe(true);
    expect(JSON.stringify(called)).toMatch(/fetch/);
  });

  it('a host-synced tool with no stored row gets its row, so its uses are recorded and the next load finds it', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    const tool: EmergentTool = {
      id: 'host-1',
      name: 'double_it',
      description: 'Doubles a number.',
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
      implementation: { mode: 'sandbox', code: RAW_DOUBLE, allowlist: [] },
      tier: 'shared',
      createdBy: 'host',
      createdAt: new Date(1_700_000_000_000).toISOString(),
      judgeVerdicts: [],
      usageStats: { totalUses: 0, successCount: 0, failureCount: 0, avgExecutionTimeMs: 0, lastUsedAt: null, confidenceScore: 0.9 },
      source: 'hydrated by the host from its own store',
    };

    expect(await host.engine.syncPersistedTool(tool)).toEqual({ toolId: 'host-1', name: 'double_it', state: 'active', reason: null });
    expect(readToolRow(db, 'host-1')).toMatchObject({ name: 'double_it', is_active: 1 });
    expect((await callTool(host.orchestrator, 'double_it', { n: 2 })).output).toEqual({ doubled: 4 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readToolRow(db, 'host-1')?.total_uses).toBe(1);

    const other = await makeForgeHost({ db });
    expect((await other.engine.loadPersistedTools({ tiers: ['shared'] })).outcomes).toEqual([
      { toolId: 'host-1', name: 'double_it', state: 'active', reason: null },
    ]);
  });

  it('an agent-tier row from an earlier release, owned by a GMI instance id, loads suspended and runs for no one', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'old-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      tier: 'agent',
      createdBy: 'gmi-instance-0b7e3c1a',
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });

    const loaded = await host.engine.loadPersistedTools({ tiers: ['agent'], agentId: 'gmi-instance-0b7e3c1a' });
    expect(loaded.outcomes).toEqual([{ toolId: 'old-1', name: 'double_it', state: 'suspended', reason: 'legacy_owner' }]);
    expect(readToolRow(db, 'old-1')).toMatchObject({ is_active: 0 });
    expect(readStateRow(db, 'old-1')).toMatchObject({ state: 'suspended', state_reason: 'legacy_owner' });
    const called = await callTool(host.orchestrator, 'double_it', { n: 2 }, { personaId: 'anyone' });
    expect(called.isError).toBe(true);
    const asStoredOwner = await callTool(host.orchestrator, 'double_it', { n: 2 }, { personaId: 'gmi-instance-0b7e3c1a' });
    expect(asStoredOwner.isError).toBe(true);

    // The host's reactivation goes through the same path and cannot change the
    // owner, so the row stays suspended; the next load re-checks it and says
    // the same. Forging the tool again under the persona is the way back.
    expect(await host.engine.reactivateTool('old-1')).toEqual({ toolId: 'old-1', name: 'double_it', state: 'suspended', reason: 'legacy_owner' });
    const again = await host.engine.loadPersistedTools({ tiers: ['agent'], agentId: 'gmi-instance-0b7e3c1a' });
    expect(again.outcomes).toEqual([{ toolId: 'old-1', name: 'double_it', state: 'suspended', reason: 'legacy_owner' }]);
  });

  it('a stored request wider than a stored list grants nothing the list did not', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'list-w',
      name: 'fetch_it',
      mode: 'sandbox',
      source: JSON.stringify({
        mode: 'sandbox',
        code: 'function execute(input) { return fetch(input.url).then((r) => ({ ok: r.ok })); }',
        allowlist: ['crypto'],
      }),
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    seedStateRow(db, {
      toolId: 'list-w',
      state: 'active',
      setBy: 'library',
      requestJson: '{"kind":"sandbox","capabilities":["fetch","crypto"]}',
    });

    expect((await host.engine.loadPersistedTools({ tiers: ['shared'] })).outcomes).toEqual([
      { toolId: 'list-w', name: 'fetch_it', state: 'active', reason: null },
    ]);
    const called = await callTool(host.orchestrator, 'fetch_it', { url: 'http://127.0.0.1:9/' });
    expect(called.isError).toBe(true);
    expect(JSON.stringify(called)).toMatch(/fetch/);
  });

  it('a tool another process removes while a load has it in hand is not registered, and gets no orphan state row', async () => {
    const db = createSqliteAdapter();
    const hostA = await makeForgeHost({ db });
    seedToolRow(db, { id: 'raw-1', name: 'double_it', mode: 'sandbox', source: RAW_DOUBLE, inputSchema: NUMBER_IN, outputSchema: DOUBLED_OUT });

    // Host A has read the row and is about to write its state when the tool
    // is removed (both rows deleted, as remove() does) by another process.
    const gate = db.gateNext('INSERT INTO agentos_emergent_tool_state');
    const loading = hostA.engine.loadPersistedTools({ tiers: ['shared'] });
    await gate.entered;
    db.raw.prepare('DELETE FROM agentos_emergent_tools WHERE id = ?').run('raw-1');
    db.raw.prepare('DELETE FROM agentos_emergent_tool_state WHERE tool_id = ?').run('raw-1');
    gate.release();
    const summary = await loading;

    expect(summary.outcomes).toEqual([{ toolId: 'raw-1', name: 'double_it', state: 'demoted', reason: 'removed' }]);
    expect(await hostA.orchestrator.getTool('double_it')).toBeUndefined();
    expect(readStateRow(db, 'raw-1')).toBeUndefined();
    expect(readToolRow(db, 'raw-1')).toBeUndefined();
  });

  it("a load with nothing to write that finds the row gone reports the tool removed", async () => {
    const db = createSqliteAdapter();
    const hostA = await makeForgeHost({ db });
    seedToolRow(db, { id: 'raw-1', name: 'double_it', mode: 'sandbox', source: RAW_DOUBLE, inputSchema: NUMBER_IN, outputSchema: DOUBLED_OUT });
    seedStateRow(db, { toolId: 'raw-1', state: 'active', setBy: 'library', requestJson: '{"kind":"sandbox","capabilities":[]}' });

    const gate = db.gateNext('FROM agentos_emergent_tool_state s\n        WHERE s.tool_id = ?');
    const loading = hostA.engine.loadPersistedTools({ tiers: ['shared'] });
    await gate.entered;
    db.raw.prepare('DELETE FROM agentos_emergent_tools WHERE id = ?').run('raw-1');
    db.raw.prepare('DELETE FROM agentos_emergent_tool_state WHERE tool_id = ?').run('raw-1');
    gate.release();
    const summary = await loading;

    expect(summary.outcomes).toEqual([{ toolId: 'raw-1', name: 'double_it', state: 'demoted', reason: 'removed' }]);
    expect(await hostA.orchestrator.getTool('double_it')).toBeUndefined();
  });

  it("a host's reactivation overtaken by another process's suspension yields to it, in memory and in the row", async () => {
    const db = createSqliteAdapter();
    const hostA = await makeForgeHost({ db });
    const hostB = await makeForgeHost({ db });
    seedToolRow(db, { id: 'raw-1', name: 'double_it', mode: 'sandbox', source: RAW_DOUBLE, isActive: 0, inputSchema: NUMBER_IN, outputSchema: DOUBLED_OUT });
    seedStateRow(db, { toolId: 'raw-1', state: 'suspended', reason: 'operator_hold', setBy: 'host', requestJson: null });
    expect((await hostA.engine.loadPersistedTools({ tiers: ['shared'] })).outcomes[0]).toMatchObject({ state: 'suspended' });

    // Host A's reactivation has written its state row and is held before its
    // flag write; host B suspends the tool meanwhile.
    const gate = db.gateNext('SET is_active = COALESCE(');
    const reactivating = hostA.engine.reactivateTool('raw-1');
    await gate.entered;
    expect(await hostB.engine.suspendTool('raw-1', 'operator_hold_again')).toBe(true);
    gate.release();

    expect(await reactivating).toMatchObject({ state: 'suspended', reason: 'operator_hold_again' });
    expect(await hostA.orchestrator.getTool('double_it')).toBeUndefined();
    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'suspended', state_reason: 'operator_hold_again' });
    expect(readToolRow(db, 'raw-1')?.is_active).toBe(0);
    // Host A holds the suspension too: the next load in A keeps the tool off.
    expect((await hostA.engine.loadPersistedTools({ tiers: ['shared'] })).outcomes[0]).toMatchObject({ state: 'suspended' });
  });

  it('a load that read a lowered flag does not demote a tool the host reactivated meanwhile', async () => {
    const db = createSqliteAdapter();
    const hostA = await makeForgeHost({ db });
    const hostB = await makeForgeHost({ db });
    seedToolRow(db, { id: 'raw-1', name: 'double_it', mode: 'sandbox', source: RAW_DOUBLE, isActive: 0, inputSchema: NUMBER_IN, outputSchema: DOUBLED_OUT });
    seedStateRow(db, { toolId: 'raw-1', state: 'active', setBy: 'library', requestJson: '{"kind":"sandbox","capabilities":[]}' });

    // Host A read the lowered flag and is about to record the host's disable
    // when the host reactivates the tool through host B.
    const gate = db.gateNext('INSERT INTO agentos_emergent_tool_state');
    const loading = hostA.engine.loadPersistedTools({ tiers: ['shared'] });
    await gate.entered;
    expect(await hostB.engine.reactivateTool('raw-1')).toMatchObject({ state: 'active' });
    gate.release();
    const summary = await loading;

    expect(summary.outcomes).toEqual([{ toolId: 'raw-1', name: 'double_it', state: 'active', reason: null }]);
    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'active' });
    expect(readToolRow(db, 'raw-1')?.is_active).toBe(1);
    expect((await callTool(hostA.orchestrator, 'double_it', { n: 2 })).output).toEqual({ doubled: 4 });
  });

  it('a tool whose removal is under way (tool row gone, state row not yet) is not registered by a load', async () => {
    const db = createSqliteAdapter();
    const hostA = await makeForgeHost({ db });
    seedToolRow(db, { id: 'raw-1', name: 'double_it', mode: 'sandbox', source: RAW_DOUBLE, inputSchema: NUMBER_IN, outputSchema: DOUBLED_OUT });

    const gate = db.gateNext('INSERT INTO agentos_emergent_tool_state');
    const loading = hostA.engine.loadPersistedTools({ tiers: ['shared'] });
    await gate.entered;
    db.raw.prepare('DELETE FROM agentos_emergent_tools WHERE id = ?').run('raw-1');
    gate.release();
    const summary = await loading;

    expect(summary.outcomes).toEqual([{ toolId: 'raw-1', name: 'double_it', state: 'demoted', reason: 'removed' }]);
    expect(await hostA.orchestrator.getTool('double_it')).toBeUndefined();
    expect(readStateRow(db, 'raw-1')).toBeUndefined();
  });

  it('a request another process narrowed under a load, in the same millisecond, is what the tool runs with', async () => {
    const db = createSqliteAdapter();
    const hostA = await makeForgeHost({ db });
    const code = 'function execute(input) { return fetch(input.url).then((r) => ({ ok: r.ok })); }';
    seedToolRow(db, {
      id: 'raw-f',
      name: 'fetch_it',
      mode: 'sandbox',
      source: code,
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    seedStateRow(db, { toolId: 'raw-f', state: 'active', setBy: 'library', requestJson: '{"kind":"sandbox","capabilities":["fetch"]}' });

    // The row reads active with its request, so host A has nothing to write;
    // its second read is held while another process narrows the request,
    // leaving state, setter and time as they were.
    const gate = db.gateNext('FROM agentos_emergent_tool_state s\n        WHERE s.tool_id = ?');
    const loading = hostA.engine.loadPersistedTools({ tiers: ['shared'] });
    await gate.entered;
    db.raw
      .prepare("UPDATE agentos_emergent_tool_state SET request_json = ?, write_id = 'another-write' WHERE tool_id = ?")
      .run('{"kind":"sandbox","capabilities":[]}', 'raw-f');
    gate.release();
    const summary = await loading;

    expect(summary.outcomes).toEqual([{ toolId: 'raw-f', name: 'fetch_it', state: 'active', reason: null }]);
    const called = await callTool(hostA.orchestrator, 'fetch_it', { url: 'http://127.0.0.1:9/' });
    expect(called.isError).toBe(true);
    expect(JSON.stringify(called)).toMatch(/fetch/);
  });

  it('with source persistence off, a host-synced tool runs from the implementation the host supplied', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db, config: { persistSandboxSource: false } });
    const tool: EmergentTool = {
      id: 'host-2',
      name: 'double_it',
      description: 'Doubles a number.',
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
      implementation: { mode: 'sandbox', code: RAW_DOUBLE, allowlist: [] },
      tier: 'shared',
      createdBy: 'host',
      createdAt: new Date(1_700_000_000_000).toISOString(),
      judgeVerdicts: [],
      usageStats: { totalUses: 0, successCount: 0, failureCount: 0, avgExecutionTimeMs: 0, lastUsedAt: null, confidenceScore: 0.9 },
      source: 'hydrated by the host from its own store',
    };

    expect(await host.engine.syncPersistedTool(tool)).toEqual({ toolId: 'host-2', name: 'double_it', state: 'active', reason: null });
    expect((await callTool(host.orchestrator, 'double_it', { n: 2 })).output).toEqual({ doubled: 4 });
    // The row holds the redacted record: a load elsewhere cannot rebuild it.
    expect(String(readToolRow(db, 'host-2')?.implementation_source)).toContain('"redacted":true');
    const other = await makeForgeHost({ db, config: { persistSandboxSource: false } });
    expect((await other.engine.loadPersistedTools({ tiers: ['shared'] })).outcomes).toEqual([
      { toolId: 'host-2', name: 'double_it', state: 'suspended', reason: 'source_not_persisted' },
    ]);
  });

  it('a load whose registration with the host fails holds nothing, keeps the row, and loads at the next start', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, { id: 'raw-1', name: 'double_it', mode: 'sandbox', source: RAW_DOUBLE, inputSchema: NUMBER_IN, outputSchema: DOUBLED_OUT });
    const hooks = host.engine as unknown as { onToolForged?: (...args: unknown[]) => Promise<void> };
    const wired = hooks.onToolForged;
    hooks.onToolForged = async () => {
      throw new Error('executor refused');
    };

    const summary = await host.engine.loadPersistedTools({ tiers: ['shared'] });

    expect(summary.failed).toEqual([{ toolId: 'raw-1', name: 'double_it', error: 'executor refused' }]);
    expect(summary.outcomes).toEqual([]);
    expect(host.engine.getAgentTools('agent-seed')).toEqual([]);
    expect(await host.orchestrator.getTool('double_it')).toBeUndefined();
    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'active' });

    hooks.onToolForged = wired;
    const again = await host.engine.loadPersistedTools({ tiers: ['shared'] });
    expect(again.outcomes).toEqual([{ toolId: 'raw-1', name: 'double_it', state: 'active', reason: null }]);
    expect((await callTool(host.orchestrator, 'double_it', { n: 2 })).output).toEqual({ doubled: 4 });
  });

  it('a stored tool the host renamed lets go of the old name at the next load', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, { id: 'raw-1', name: 'double_it', mode: 'sandbox', source: RAW_DOUBLE, inputSchema: NUMBER_IN, outputSchema: DOUBLED_OUT });
    await host.engine.loadPersistedTools({ tiers: ['shared'] });
    expect((await callTool(host.orchestrator, 'double_it', { n: 2 })).output).toEqual({ doubled: 4 });

    db.raw.prepare('UPDATE agentos_emergent_tools SET name = ? WHERE id = ?').run('twice_it', 'raw-1');
    const again = await host.engine.loadPersistedTools({ tiers: ['shared'] });

    expect(again.outcomes).toEqual([{ toolId: 'raw-1', name: 'twice_it', state: 'active', reason: null }]);
    expect(await host.orchestrator.getTool('double_it')).toBeUndefined();
    expect((await callTool(host.orchestrator, 'twice_it', { n: 3 })).output).toEqual({ doubled: 6 });
  });

  it("a host-synced tool's source names its session in the older form too", async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    const tool: EmergentTool = {
      id: 'host-3',
      name: 'double_it',
      description: 'Doubles a number.',
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
      implementation: { mode: 'sandbox', code: RAW_DOUBLE, allowlist: [] },
      tier: 'session',
      createdBy: 'host',
      createdAt: new Date(1_700_000_000_000).toISOString(),
      judgeVerdicts: [],
      usageStats: { totalUses: 0, successCount: 0, failureCount: 0, avgExecutionTimeMs: 0, lastUsedAt: null, confidenceScore: 0.9 },
      source: 'hydrated by the host for session sess-h1',
    };

    expect(await host.engine.syncPersistedTool(tool)).toMatchObject({ state: 'active' });
    expect(readToolRow(db, 'host-3')).toMatchObject({ created_by_session: 'sess-h1' });
    expect(host.engine.getSessionTools('sess-h1').map((t) => t.id)).toEqual(['host-3']);
  });

  it('a forged tool whose row did not land still runs in its process, and says so', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    db.failNext('INTO agentos_emergent_tools');

    const forged = await callTool(host.orchestrator, 'forge_tool', {
      name: 'double_it',
      description: 'Doubles a number.',
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
      implementation: { mode: 'sandbox', code: RAW_DOUBLE, allowlist: [] },
      testCases: [{ input: { n: 2 }, expectedOutput: { doubled: 4 } }],
    });

    expect(forged.isError).toBeFalsy();
    const toolId = String(forged.output.toolId);
    expect(readToolRow(db, toolId)).toBeUndefined();
    expect(readStateRow(db, toolId)).toBeUndefined();
    expect((await callTool(host.orchestrator, 'double_it', { n: 5 })).output).toEqual({ doubled: 10 });
  });

  it('removing a stored tool this process never loaded deletes its rows', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, { id: 'raw-1', name: 'double_it', mode: 'sandbox', source: RAW_DOUBLE, inputSchema: NUMBER_IN, outputSchema: DOUBLED_OUT });
    seedStateRow(db, { toolId: 'raw-1', state: 'active', setBy: 'library', requestJson: null });

    expect(await host.engine.removeTool('raw-1')).toBeUndefined();

    expect(readToolRow(db, 'raw-1')).toBeUndefined();
    expect(readStateRow(db, 'raw-1')).toBeUndefined();
    expect((await host.engine.loadPersistedTools({ tiers: ['shared'] })).outcomes).toEqual([]);
  });

  it('a tool removed while a load had it in hand is not put back, and its rows go', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, { id: 'raw-1', name: 'double_it', mode: 'sandbox', source: RAW_DOUBLE, inputSchema: NUMBER_IN, outputSchema: DOUBLED_OUT });

    // The load's flag write is held open; the host removes the tool meanwhile.
    const gate = db.gateNext('SET is_active = COALESCE(');
    const loading = host.engine.loadPersistedTools({ tiers: ['shared'] });
    await gate.entered;
    const removing = host.engine.removeTool('raw-1');
    gate.release();
    const summary = await loading;
    await removing;

    expect(summary.outcomes).toEqual([{ toolId: 'raw-1', name: 'double_it', state: 'demoted', reason: 'removed' }]);
    expect(await host.orchestrator.getTool('double_it')).toBeUndefined();
    expect(readToolRow(db, 'raw-1')).toBeUndefined();
    expect(readStateRow(db, 'raw-1')).toBeUndefined();
  });

  it('a row read before a removal began is not put back by an admission that starts after it', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, { id: 'a-1', name: 'double_it', mode: 'sandbox', source: RAW_DOUBLE, inputSchema: NUMBER_IN, outputSchema: DOUBLED_OUT });
    seedToolRow(db, { id: 'b-1', name: 'sum_it', mode: 'sandbox', source: SUM_CODE, inputSchema: SUM_IN, outputSchema: SUM_OUT });
    db.raw.prepare('UPDATE agentos_emergent_tools SET created_at = ? WHERE id = ?').run(1_700_000_000_001, 'b-1');
    // Both rows active with their requests stored, so each admission writes nothing.
    seedStateRow(db, { toolId: 'a-1', state: 'active', setBy: 'library', requestJson: '{"kind":"sandbox","capabilities":[]}' });
    seedStateRow(db, { toolId: 'b-1', state: 'active', setBy: 'library', requestJson: '{"kind":"sandbox","capabilities":[]}' });

    // The first row's admission is held; the second row was read with it.
    const first = db.gateNext('FROM agentos_emergent_tool_state s');
    const loading = host.engine.loadPersistedTools({ tiers: ['shared'] });
    await first.entered;
    // The host removes the second tool meanwhile, and its row deletes are held too.
    const deleting = db.gateNext('DELETE FROM agentos_emergent_tools');
    const removing = host.engine.removeTool('b-1');
    await deleting.entered;
    first.release();
    // The second admission runs as far as it can while the deletes are held.
    await new Promise((resolve) => setTimeout(resolve, 20));
    deleting.release();
    const summary = await loading;
    await removing;

    expect(summary.outcomes).toEqual([
      { toolId: 'a-1', name: 'double_it', state: 'active', reason: null },
      { toolId: 'b-1', name: 'sum_it', state: 'demoted', reason: 'removed' },
    ]);
    expect(await host.orchestrator.getTool('sum_it')).toBeUndefined();
    expect(readToolRow(db, 'b-1')).toBeUndefined();
    expect((await callTool(host.orchestrator, 'double_it', { n: 2 })).output).toEqual({ doubled: 4 });
  });

  it('a tool replaced under its id while its executable registers is settled to the replacement', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, { id: 'raw-1', name: 'double_it', mode: 'sandbox', source: RAW_DOUBLE, inputSchema: NUMBER_IN, outputSchema: DOUBLED_OUT });
    const engine = host.engine as unknown as {
      onToolForged: (tool: EmergentTool, executable: unknown) => Promise<void>;
      registry: { adopt: (tool: EmergentTool, record: Record<string, unknown>) => boolean };
    };
    const register = engine.onToolForged;
    let calls = 0;
    engine.onToolForged = async (tool, executable) => {
      calls += 1;
      if (calls === 1) {
        // Another admission puts a renamed copy under the id while this registration runs.
        engine.registry.adopt(
          { ...tool, name: 'double_it_v2' },
          { toolId: tool.id, state: 'active', reason: null, setBy: 'library', at: 1, request: null },
        );
      }
      await register(tool, executable);
    };

    const summary = await host.engine.loadPersistedTools({ tiers: ['shared'] });

    expect(summary.outcomes).toEqual([{ toolId: 'raw-1', name: 'double_it_v2', state: 'active', reason: null }]);
    expect(calls).toBe(2);
    expect(await host.orchestrator.getTool('double_it')).toBeUndefined();
    expect((await callTool(host.orchestrator, 'double_it_v2', { n: 4 })).output).toEqual({ doubled: 8 });
  });

  it('a replacement whose executable fails to register leaves nothing under the name, and the load reports it', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, { id: 'raw-1', name: 'double_it', mode: 'sandbox', source: RAW_DOUBLE, inputSchema: NUMBER_IN, outputSchema: DOUBLED_OUT });
    const engine = host.engine as unknown as {
      onToolForged: (tool: EmergentTool, executable: unknown) => Promise<void>;
      registry: { adopt: (tool: EmergentTool, record: Record<string, unknown>) => boolean };
    };
    const register = engine.onToolForged;
    let calls = 0;
    engine.onToolForged = async (tool, executable) => {
      calls += 1;
      if (calls > 1) {
        throw new Error('registration refused');
      }
      engine.registry.adopt({ ...tool }, { toolId: tool.id, state: 'active', reason: null, setBy: 'library', at: 1, request: null });
      await register(tool, executable);
    };

    const summary = await host.engine.loadPersistedTools({ tiers: ['shared'] });

    expect(summary.outcomes).toEqual([]);
    expect(summary.failed).toEqual([
      { toolId: 'raw-1', name: 'double_it', error: expect.stringMatching(/registration refused/) },
    ]);
    expect(await host.orchestrator.getTool('double_it')).toBeUndefined();
  });

  it("a host's row write for a tool whose removal is still deleting lands after the deletes", async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    const tool: EmergentTool = {
      id: 'host-2',
      name: 'double_it',
      description: 'Doubles a number.',
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
      implementation: { mode: 'sandbox', code: RAW_DOUBLE, allowlist: [] },
      tier: 'shared',
      createdBy: 'host',
      createdAt: new Date(1_700_000_000_000).toISOString(),
      judgeVerdicts: [],
      usageStats: { totalUses: 0, successCount: 0, failureCount: 0, avgExecutionTimeMs: 0, lastUsedAt: null, confidenceScore: 0.9 },
      source: 'hydrated by the host from its own store',
    };

    // The removal's first delete is held open; the host syncs the same id meanwhile.
    const gate = db.gateNext('DELETE FROM agentos_emergent_tools');
    const removing = host.engine.removeTool('host-2');
    await gate.entered;
    const syncing = host.engine.syncPersistedTool(tool);
    gate.release();
    await removing;

    expect(await syncing).toEqual({ toolId: 'host-2', name: 'double_it', state: 'active', reason: null });
    expect(readToolRow(db, 'host-2')).toMatchObject({ name: 'double_it', is_active: 1 });
    expect((await callTool(host.orchestrator, 'double_it', { n: 3 })).output).toEqual({ doubled: 6 });
  });

  it("a session's cleanup takes its tools out of the executor", async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'sc-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      tier: 'session',
      createdBy: 'agent-c',
      createdBySession: 'sess-c',
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    await host.engine.loadPersistedTools({ tiers: ['session'], sessionId: 'sess-c' });
    expect(await host.orchestrator.getTool('double_it')).toBeDefined();
    expect(host.engine.getSessionTools('sess-c').map((t) => t.id)).toEqual(['sc-1']);

    const removed = host.engine.cleanupSession('sess-c');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(removed.map((t) => t.id)).toEqual(['sc-1']);
    expect(await host.orchestrator.getTool('double_it')).toBeUndefined();
    expect(host.engine.getSessionTools('sess-c')).toEqual([]);
    // A call by name finds nothing registered.
    expect((await callTool(host.orchestrator, 'double_it', { n: 2 })).isError).toBe(true);
  });

  it("a session's stored tools load for that session only", async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'sa-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      tier: 'session',
      createdBySession: 'sess-a',
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    seedToolRow(db, {
      id: 'sb-1',
      name: 'sum_it',
      mode: 'sandbox',
      source: SUM_CODE,
      tier: 'session',
      createdBySession: 'sess-b',
      inputSchema: SUM_IN,
      outputSchema: SUM_OUT,
    });

    const loaded = await host.engine.loadPersistedTools({ tiers: ['session'], sessionId: 'sess-a' });
    expect(loaded.outcomes).toEqual([{ toolId: 'sa-1', name: 'double_it', state: 'active', reason: null }]);
    expect(await host.orchestrator.getTool('sum_it')).toBeUndefined();
    expect((await callTool(host.orchestrator, 'double_it', { n: 4 })).output).toEqual({ doubled: 8 });
  });

  it("a tool forged in a session loads again for that session, whatever characters its id holds, and for no other", async () => {
    const db = createSqliteAdapter();
    const hostA = await makeForgeHost({ db });
    const forged = await callTool(
      hostA.orchestrator,
      'forge_tool',
      {
        name: 'double_it',
        description: 'Doubles a number.',
        inputSchema: NUMBER_IN,
        outputSchema: DOUBLED_OUT,
        implementation: { mode: 'sandbox', code: RAW_DOUBLE, allowlist: [] },
        testCases: [{ input: { n: 2 }, expectedOutput: { doubled: 4 } }],
      },
      { sessionId: 'sess:a.1' },
    );
    expect(forged.isError).toBeFalsy();
    const toolId = String(forged.output.toolId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readToolRow(db, toolId)).toMatchObject({ tier: 'session', created_by_session: 'sess:a.1' });

    const hostB = await makeForgeHost({ db });
    expect((await hostB.engine.loadPersistedTools({ tiers: ['session'], sessionId: 'sess' })).outcomes).toEqual([]);
    expect(await hostB.orchestrator.getTool('double_it')).toBeUndefined();
    const loaded = await hostB.engine.loadPersistedTools({ tiers: ['session'], sessionId: 'sess:a.1' });
    expect(loaded.outcomes).toEqual([{ toolId, name: 'double_it', state: 'active', reason: null }]);
    expect((await callTool(hostB.orchestrator, 'double_it', { n: 3 })).output).toEqual({ doubled: 6 });
  });

  it('a row read active before another process suspended it is not registered: the row is read again before the tool is adopted', async () => {
    const db = createSqliteAdapter();
    const hostA = await makeForgeHost({ db });
    const hostB = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'raw-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    seedStateRow(db, {
      toolId: 'raw-1',
      state: 'active',
      setBy: 'library',
      requestJson: '{"kind":"sandbox","capabilities":[]}',
    });

    // The row reads active with its request, so host A has nothing to write;
    // its second read of the state row is held open while host B suspends.
    const gate = db.gateNext('FROM agentos_emergent_tool_state s\n        WHERE s.tool_id = ?');
    const loading = hostA.engine.loadPersistedTools({ tiers: ['shared'] });
    await gate.entered;
    expect(await hostB.engine.suspendTool('raw-1', 'operator_hold')).toBe(true);
    gate.release();
    const summary = await loading;

    expect(summary.outcomes).toEqual([
      { toolId: 'raw-1', name: 'double_it', state: 'suspended', reason: 'operator_hold' },
    ]);
    expect(await hostA.orchestrator.getTool('double_it')).toBeUndefined();
    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'suspended', set_by: 'host' });
    expect(readToolRow(db, 'raw-1')?.is_active).toBe(0);
  });

  it("a first write refused by another process's row leaves the tool with that row's grant, not the one derived here", async () => {
    const db = createSqliteAdapter();
    const hostA = await makeForgeHost({ db });
    const code = 'function execute(input) { return fetch(input.url).then((r) => ({ ok: r.ok })); }';
    seedToolRow(db, {
      id: 'raw-f',
      name: 'fetch_it',
      mode: 'sandbox',
      source: code,
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });

    // Host A derives `fetch` from the code and is about to store it when
    // another process stores an active row granting nothing.
    const gate = db.gateNext('INSERT INTO agentos_emergent_tool_state');
    const loading = hostA.engine.loadPersistedTools({ tiers: ['shared'] });
    await gate.entered;
    seedStateRow(db, {
      toolId: 'raw-f',
      state: 'active',
      setBy: 'library',
      requestJson: '{"kind":"sandbox","capabilities":[]}',
    });
    gate.release();
    const summary = await loading;

    expect(summary.outcomes).toEqual([{ toolId: 'raw-f', name: 'fetch_it', state: 'active', reason: null }]);
    expect(readStateRow(db, 'raw-f')?.request).toEqual({ kind: 'sandbox', capabilities: [] });
    // The tool runs with the stored grant: no fetch.
    const called = await callTool(hostA.orchestrator, 'fetch_it', { url: 'http://127.0.0.1:9/' });
    expect(called.isError).toBe(true);
    expect(JSON.stringify(called)).toMatch(/fetch/);
  });

  it("a load between a reactivation's state write and its flag write finishes the flag write, and reads the reactivation", async () => {
    const db = createSqliteAdapter();
    const hostA = await makeForgeHost({ db });
    const hostB = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'raw-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      isActive: 0,
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    seedStateRow(db, { toolId: 'raw-1', state: 'suspended', reason: 'operator_hold', setBy: 'host', requestJson: null });
    expect((await hostA.engine.loadPersistedTools({ tiers: ['shared'] })).outcomes[0]).toMatchObject({
      state: 'suspended',
    });

    // The reactivation's flag write is held open after its state row write:
    // the row reads active with the flag off and its flag write marked pending.
    const gate = db.gateNext('SET is_active = COALESCE(');
    const reactivating = hostA.engine.reactivateTool('raw-1');
    await gate.entered;
    expect(readToolRow(db, 'raw-1')?.is_active).toBe(0);
    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'active', flag_synced: 0 });

    // Host B's load finishes the flag write and reads the reactivation.
    const meanwhile = await hostB.engine.loadPersistedTools({ tiers: ['shared'] });
    expect(meanwhile.outcomes).toEqual([{ toolId: 'raw-1', name: 'double_it', state: 'active', reason: null }]);
    expect(readToolRow(db, 'raw-1')?.is_active).toBe(1);
    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'active', flag_synced: 1 });
    gate.release();
    expect(await reactivating).toMatchObject({ state: 'active' });

    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'active', flag_synced: 1 });
    expect(readToolRow(db, 'raw-1')?.is_active).toBe(1);
    expect((await callTool(hostA.orchestrator, 'double_it', { n: 2 })).output).toEqual({ doubled: 4 });
  });
});
