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
    expect((await callTool(host.orchestrator, 'double_it', { n: 2 }, { gmiId: 'agent-seed' })).output).toEqual({
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

    // The agent tool runs for its agent and refuses every other; the shared one runs for both.
    expect((await callTool(host.orchestrator, 'double_it', { n: 2 }, { gmiId: 'agent-a' })).output).toEqual({
      doubled: 4,
    });
    const other = await callTool(host.orchestrator, 'double_it', { n: 2 }, { gmiId: 'agent-b' });
    expect(other.isError).toBe(true);
    expect(JSON.stringify(other)).toMatch(/belongs to agent agent-a/);
    expect((await callTool(host.orchestrator, 'echo_text', { text: 'hi' }, { gmiId: 'agent-b' })).output).toEqual({
      text: 'hi',
    });
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
    const gate = db.gateNext('FROM agentos_emergent_tool_state\n        WHERE tool_id = ?');
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

  it('a reactivation changes the state row and the flag together, so a load that runs meanwhile sees the old pair or the new', async () => {
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

    // The reactivation's one write is held open: nothing has changed yet, in
    // either table, and a load meanwhile reads the old pair.
    const gate = db.gateNext('INSERT INTO agentos_emergent_tool_state');
    const reactivating = hostA.engine.reactivateTool('raw-1');
    await gate.entered;
    expect(readToolRow(db, 'raw-1')?.is_active).toBe(0);
    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'suspended' });
    const meanwhile = await hostB.engine.loadPersistedTools({ tiers: ['shared'] });
    expect(meanwhile.outcomes).toEqual([
      { toolId: 'raw-1', name: 'double_it', state: 'suspended', reason: 'operator_hold' },
    ]);
    gate.release();
    expect(await reactivating).toMatchObject({ state: 'active' });

    expect(readStateRow(db, 'raw-1')).toMatchObject({ state: 'active' });
    expect(readToolRow(db, 'raw-1')?.is_active).toBe(1);
    expect((await hostB.engine.loadPersistedTools({ tiers: ['shared'] })).outcomes[0]).toMatchObject({ state: 'active' });
    expect((await callTool(hostA.orchestrator, 'double_it', { n: 2 })).output).toEqual({ doubled: 4 });
  });
});
