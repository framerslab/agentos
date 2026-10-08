import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { EmergentToolRegistry } from '../EmergentToolRegistry.js';
import type { EmergentTool } from '../types.js';
import { createSqliteAdapter } from './helpers/sqlite-adapter.js';

const intent = {
  toolId: 'tool-1',
  callId: 'call-1',
  agentId: 'agent-1',
  capability: 'fetch',
  target: 'https://api.example.com/x',
  decision: 'allowed' as const,
  decidedBy: 'ceiling',
};

describe('effect records', () => {
  it('writes an intent row and its terminal, the target as a digest unless full', async () => {
    const db = createSqliteAdapter();
    const registry = new EmergentToolRegistry({}, db);
    const digest = registry.effectsStore({ content: 'digest' });
    expect(digest).toBeDefined();
    const id = await digest!.intent(intent);
    await digest!.terminal(id, { outcome: 'ok', bytes: 12 });
    expect(db.raw.prepare('SELECT * FROM agentos_emergent_effects WHERE id = ?').get(id)).toMatchObject({
      tool_id: 'tool-1',
      call_id: 'call-1',
      agent_id: 'agent-1',
      capability: 'fetch',
      target: createHash('sha256').update('https://api.example.com/x').digest('hex'),
      target_form: 'digest',
      decision: 'allowed',
      decided_by: 'ceiling',
      outcome: 'ok',
      bytes: 12,
    });

    const full = registry.effectsStore({ content: 'full' })!;
    await full.whole(
      { ...intent, callId: 'call-2', capability: 'fs.read', target: '/etc/passwd', decision: 'refused', decidedBy: 'path_not_allowed' },
      { outcome: 'refused', code: 'path_not_allowed' },
    );
    expect(
      db.raw.prepare("SELECT target, outcome, code FROM agentos_emergent_effects WHERE call_id = 'call-2'").get(),
    ).toEqual({ target: '/etc/passwd', outcome: 'refused', code: 'path_not_allowed' });
  });

  it('prunes rows older than retainDays, in the effects table only', async () => {
    const db = createSqliteAdapter();
    const registry = new EmergentToolRegistry({}, db);
    await registry.ensureSchema();
    const tenDaysAgo = Date.now() - 10 * 86_400_000;
    db.raw
      .prepare(
        `INSERT INTO agentos_emergent_effects
           (id, tool_id, call_id, agent_id, capability, target, target_form, decision, decided_by, intent_at)
         VALUES ('old', 't', 'c', 'a', 'fetch', 'x', 'digest', 'allowed', 'ceiling', ?)`,
      )
      .run(tenDaysAgo);
    await registry.effectsStore({ content: 'digest', retainDays: 7 })!.intent(intent);
    const ids = (db.raw.prepare('SELECT id FROM agentos_emergent_effects').all() as Array<{ id: string }>).map(
      (row) => row.id,
    );
    expect(ids).toHaveLength(1);
    expect(ids).not.toContain('old');

    // The prune searches an index on intent_at; it does not scan the table.
    const plan = db.raw
      .prepare('EXPLAIN QUERY PLAN DELETE FROM agentos_emergent_effects WHERE intent_at < ?')
      .all(Date.now()) as Array<{ detail: string }>;
    expect(plan.map((step) => step.detail).join('\n')).toContain('idx_emergent_effects_intent');
  });

  it('has no store without a storage adapter', () => {
    expect(new EmergentToolRegistry({}).effectsStore({ content: 'digest' })).toBeUndefined();
  });

  it('keeps the newest 1,000 audit entries in memory', () => {
    const registry = new EmergentToolRegistry({});
    const tool: EmergentTool = {
      id: 'ring-1',
      name: 'ring',
      description: 'Counts.',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      implementation: { mode: 'sandbox', code: 'function execute() { return {}; }', allowlist: [] },
      tier: 'session',
      createdBy: 'agent-1',
      createdAt: new Date().toISOString(),
      judgeVerdicts: [],
      usageStats: {
        totalUses: 0,
        successCount: 0,
        failureCount: 0,
        avgExecutionTimeMs: 0,
        lastUsedAt: null,
        confidenceScore: 0.9,
      },
      source: 'test',
    };
    registry.register(tool, 'session');
    for (let i = 0; i < 1005; i += 1) {
      registry.recordUse('ring-1', {}, {}, true, 1);
    }
    const log = registry.getAuditLog();
    expect(log).toHaveLength(1000);
    expect(log[log.length - 1]?.eventType).toBe('use');
  });
});
