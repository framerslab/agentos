import { describe, it, expect, beforeEach } from 'vitest';
import { EmergentToolRegistry } from '../EmergentToolRegistry.js';
import type { EmergentTool, ToolUsageStats, EmergentConfig } from '../types.js';
import type { IStorageAdapter } from '../EmergentToolRegistry.js';
import { DEFAULT_EMERGENT_CONFIG } from '../types.js';
import type { JSONSchemaObject } from '../../../core/tools/ITool.js';

// ---------------------------------------------------------------------------
// Helpers — builds valid objects without relying on runtime constructors
// ---------------------------------------------------------------------------

/** Counter for unique tool IDs across a test run. */
let idCounter = 0;

/**
 * Build a minimal valid {@link ToolUsageStats} with optional overrides.
 */
function makeUsageStats(
  overrides: Partial<ToolUsageStats> = {},
): ToolUsageStats {
  return {
    totalUses: 0,
    successCount: 0,
    failureCount: 0,
    avgExecutionTimeMs: 0,
    lastUsedAt: null,
    confidenceScore: 0,
    ...overrides,
  };
}

/**
 * Build a minimal valid {@link EmergentTool} with optional overrides.
 * Each call produces a unique `id` unless explicitly overridden.
 */
function makeTool(overrides: Partial<EmergentTool> = {}): EmergentTool {
  idCounter += 1;
  const inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: { value: { type: 'number' } },
    required: ['value'],
  };
  const outputSchema: JSONSchemaObject = {
    type: 'object',
    properties: { result: { type: 'number' } },
  };
  return {
    id: `emergent:test-${idCounter}`,
    name: `test_tool_${idCounter}`,
    description: 'A test tool.',
    inputSchema,
    outputSchema,
    implementation: {
      mode: 'sandbox',
      code: 'function execute(input) { return input; }',
      allowlist: [],
    },
    tier: 'session',
    createdBy: 'agent-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    judgeVerdicts: [],
    usageStats: makeUsageStats(),
    source: 'forged by agent agent-1 during session sess-abc',
    ...overrides,
  };
}

/**
 * Build a registry with emergent capabilities enabled and sensible test defaults.
 */
function makeRegistry(
  overrides: Partial<EmergentConfig> = {},
): EmergentToolRegistry {
  return new EmergentToolRegistry({ ...DEFAULT_EMERGENT_CONFIG, enabled: true, ...overrides });
}

class MockStorageAdapter implements IStorageAdapter {
  rows = new Map<
    string,
    {
      promoted_at: number | null;
      promoted_by: string | null;
      implementation_source?: string | null;
      implementation_mode?: string | null;
    }
  >();

  async run(sql: string, params: unknown[] = []): Promise<unknown> {
    if (sql.includes('INTO agentos_emergent_tools')) {
      const id = String(params[0]);
      this.rows.set(id, {
        promoted_at:
          typeof params[11] === 'number' ? params[11] : null,
        promoted_by:
          typeof params[12] === 'string' ? params[12] : null,
        implementation_source:
          typeof params[6] === 'string' ? params[6] : null,
        implementation_mode:
          typeof params[5] === 'string' ? params[5] : null,
      });
    }
    return {};
  }

  async get(sql: string, params: unknown[] = []): Promise<unknown> {
    if (sql.includes('SELECT promoted_at, promoted_by')) {
      return this.rows.get(String(params[0]));
    }
    return undefined;
  }

  async all(): Promise<unknown[]> {
    return [];
  }

  async exec(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('EmergentToolRegistry', () => {
  beforeEach(() => {
    // Reset the ID counter so each test starts clean.
    idCounter = 0;
  });

  // -------------------------------------------------------------------------
  // 1. Register a tool at session tier, get() retrieves it
  // -------------------------------------------------------------------------
  it('registers a tool at session tier and retrieves it via get()', () => {
    const registry = makeRegistry();
    const tool = makeTool();

    registry.register(tool, 'session');

    const retrieved = registry.get(tool.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(tool.id);
    expect(retrieved!.name).toBe(tool.name);
    expect(retrieved!.tier).toBe('session');
  });

  // -------------------------------------------------------------------------
  // 2. getByTier('session') returns session tools only
  // -------------------------------------------------------------------------
  it('getByTier("session") returns only session-tier tools', () => {
    const registry = makeRegistry();
    const sessionTool = makeTool({ source: 'forged by agent agent-1 during session sess-abc' });
    const agentTool = makeTool({ source: 'forged by agent agent-2 during session sess-xyz' });

    registry.register(sessionTool, 'session');
    registry.register(agentTool, 'agent');

    const sessionTools = registry.getByTier('session');
    expect(sessionTools).toHaveLength(1);
    expect(sessionTools[0].id).toBe(sessionTool.id);

    const agentTools = registry.getByTier('agent');
    expect(agentTools).toHaveLength(1);
    expect(agentTools[0].id).toBe(agentTool.id);
  });

  // -------------------------------------------------------------------------
  // 3. recordUse() increments totalUses and successCount
  // -------------------------------------------------------------------------
  it('recordUse() increments totalUses and successCount on success', () => {
    const registry = makeRegistry();
    const tool = makeTool();
    registry.register(tool, 'session');

    registry.recordUse(tool.id, { value: 1 }, { result: 2 }, true, 50);

    const stats = registry.getUsageStats(tool.id)!;
    expect(stats.totalUses).toBe(1);
    expect(stats.successCount).toBe(1);
    expect(stats.failureCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 4. recordUse() with success=false increments failureCount
  // -------------------------------------------------------------------------
  it('recordUse() increments failureCount on failure', () => {
    const registry = makeRegistry();
    const tool = makeTool();
    registry.register(tool, 'session');

    registry.recordUse(tool.id, { value: 1 }, null, false, 100);

    const stats = registry.getUsageStats(tool.id)!;
    expect(stats.totalUses).toBe(1);
    expect(stats.successCount).toBe(0);
    expect(stats.failureCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 5. getUsageStats() returns correct stats after multiple uses
  // -------------------------------------------------------------------------
  it('getUsageStats() returns accurate stats after multiple invocations', () => {
    const registry = makeRegistry();
    const tool = makeTool();
    registry.register(tool, 'session');

    // 3 successes, 1 failure
    registry.recordUse(tool.id, {}, {}, true, 40);
    registry.recordUse(tool.id, {}, {}, true, 60);
    registry.recordUse(tool.id, {}, {}, false, 200);
    registry.recordUse(tool.id, {}, {}, true, 100);

    const stats = registry.getUsageStats(tool.id)!;
    expect(stats.totalUses).toBe(4);
    expect(stats.successCount).toBe(3);
    expect(stats.failureCount).toBe(1);
    expect(stats.lastUsedAt).not.toBeNull();

    // Average execution time: (40 + 60 + 200 + 100) / 4 = 100
    expect(stats.avgExecutionTimeMs).toBe(100);
  });

  // -------------------------------------------------------------------------
  // 6. confidenceScore calculated as successCount / totalUses
  // -------------------------------------------------------------------------
  it('confidenceScore is calculated as successCount / totalUses', () => {
    const registry = makeRegistry();
    const tool = makeTool();
    registry.register(tool, 'session');

    // 3 successes out of 4 total
    registry.recordUse(tool.id, {}, {}, true, 10);
    registry.recordUse(tool.id, {}, {}, true, 10);
    registry.recordUse(tool.id, {}, {}, false, 10);
    registry.recordUse(tool.id, {}, {}, true, 10);

    const stats = registry.getUsageStats(tool.id)!;
    expect(stats.confidenceScore).toBe(0.75); // 3/4
  });

  // -------------------------------------------------------------------------
  // 7. promote() moves tool from session to agent tier
  // -------------------------------------------------------------------------
  it('promote() moves a tool from session to agent tier', async () => {
    const registry = makeRegistry();
    const tool = makeTool();
    registry.register(tool, 'session');

    // Session tier should have it.
    expect(registry.getByTier('session')).toHaveLength(1);
    expect(registry.getByTier('agent')).toHaveLength(0);

    await registry.promote(tool.id, 'agent', 'admin');

    // After promotion: session is empty, agent has it.
    expect(registry.getByTier('session')).toHaveLength(0);
    expect(registry.getByTier('agent')).toHaveLength(1);

    const promoted = registry.get(tool.id)!;
    expect(promoted.tier).toBe('agent');
  });

  // -------------------------------------------------------------------------
  // 8. cleanupSession() removes only that session's tools
  // -------------------------------------------------------------------------
  it('cleanupSession() removes only tools matching the session ID', () => {
    const registry = makeRegistry();
    const tool1 = makeTool({ source: 'forged by agent agent-1 during session sess-111' });
    const tool2 = makeTool({ source: 'forged by agent agent-1 during session sess-111' });
    const tool3 = makeTool({ source: 'forged by agent agent-2 during session sess-222' });

    registry.register(tool1, 'session');
    registry.register(tool2, 'session');
    registry.register(tool3, 'session');
    expect(registry.getByTier('session')).toHaveLength(3);

    const removed = registry.cleanupSession('sess-111');

    expect(removed).toBe(2);
    expect(registry.getByTier('session')).toHaveLength(1);
    expect(registry.get(tool1.id)).toBeUndefined();
    expect(registry.get(tool2.id)).toBeUndefined();
    expect(registry.get(tool3.id)).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 9. register() throws when maxSessionTools exceeded
  // -------------------------------------------------------------------------
  it('register() throws when maxSessionTools limit is exceeded', () => {
    const registry = makeRegistry({ maxSessionTools: 2 });

    registry.register(makeTool(), 'session');
    registry.register(makeTool(), 'session');

    expect(() => registry.register(makeTool(), 'session')).toThrow(
      /Session tool limit reached/,
    );
  });

  // -------------------------------------------------------------------------
  // 10. demote() sets confidenceScore to 0 and marks inactive
  // -------------------------------------------------------------------------
  it('demote() sets confidenceScore to 0 and marks the tool inactive', () => {
    const registry = makeRegistry();
    const tool = makeTool();
    registry.register(tool, 'session');

    // Give it some confidence first.
    registry.recordUse(tool.id, {}, {}, true, 10);
    expect(registry.getUsageStats(tool.id)!.confidenceScore).toBe(1);

    registry.demote(tool.id, 'Test demotion reason');

    const stats = registry.getUsageStats(tool.id)!;
    expect(stats.confidenceScore).toBe(0);

    // The tool should be marked inactive via convention property.
    const demoted = registry.get(tool.id) as EmergentTool & { isActive?: boolean };
    expect(demoted.isActive).toBe(false);
  });

  it("preserves promoted_at when a promoted tool's row is rewritten", async () => {
    const adapter = new MockStorageAdapter();
    const registry = new EmergentToolRegistry(
      { ...DEFAULT_EMERGENT_CONFIG, enabled: true },
      adapter,
    );
    await registry.ensureSchema();

    const tool = makeTool();
    registry.register(tool, 'session');
    await registry.promote(tool.id, 'agent', 'admin');
    const firstPromotedAt = adapter.rows.get(tool.id)?.promoted_at;
    expect(firstPromotedAt).not.toBeNull();
    // A stored stamp a fresh Date.now() cannot equal, so a writer that stamps
    // again is caught even within the same millisecond.
    adapter.rows.get(tool.id)!.promoted_at = 1_000;

    // A whole-row rewrite with no approver named: the stored promotion stays.
    // (recordUse no longer rewrites the row, so it cannot drive this case.)
    registry.upsert({ ...registry.get(tool.id)! });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondPromotedAt = adapter.rows.get(tool.id)?.promoted_at;

    expect(secondPromotedAt).toBe(1_000);
  });

  it('redacts sandbox source at rest by default', async () => {
    const adapter = new MockStorageAdapter();
    const registry = new EmergentToolRegistry(
      { ...DEFAULT_EMERGENT_CONFIG, enabled: true },
      adapter,
    );
    await registry.ensureSchema();

    const tool = makeTool();
    registry.register(tool, 'session');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const persisted = adapter.rows.get(tool.id);
    expect(persisted?.implementation_mode).toBe('sandbox');
    expect(persisted?.implementation_source).toContain('"redacted":true');
    expect(persisted?.implementation_source).not.toContain('function execute');
  });

  it('persists raw sandbox source only when explicitly enabled', async () => {
    const adapter = new MockStorageAdapter();
    const registry = new EmergentToolRegistry(
      { ...DEFAULT_EMERGENT_CONFIG, enabled: true, persistSandboxSource: true },
      adapter,
    );
    await registry.ensureSchema();

    const tool = makeTool();
    registry.register(tool, 'session');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const persisted = adapter.rows.get(tool.id);
    expect(persisted?.implementation_mode).toBe('sandbox');
    expect(persisted?.implementation_source).toContain('function execute');
  });

  // -------------------------------------------------------------------------
  // 11. logAudit creates audit entries accessible via getAuditLog()
  // -------------------------------------------------------------------------
  it('audit log records events for all state changes', () => {
    const registry = makeRegistry();
    const tool = makeTool();

    registry.register(tool, 'session');
    registry.recordUse(tool.id, {}, {}, true, 10);
    registry.demote(tool.id, 'bad tool');

    const allEntries = registry.getAuditLog();
    expect(allEntries.length).toBeGreaterThanOrEqual(3);

    const types = allEntries.map((e) => e.eventType);
    expect(types).toContain('register');
    expect(types).toContain('use');
    expect(types).toContain('demote');

    // Filter by tool ID.
    const toolEntries = registry.getAuditLog(tool.id);
    expect(toolEntries).toHaveLength(allEntries.filter((e) => e.toolId === tool.id).length);
  });

  // -------------------------------------------------------------------------
  // Additional: promote() throws when target tier is not higher
  // -------------------------------------------------------------------------
  it('promote() throws when target tier is not higher than current', async () => {
    const registry = makeRegistry();
    const tool = makeTool();
    registry.register(tool, 'agent');

    await expect(registry.promote(tool.id, 'session')).rejects.toThrow(
      /target tier must be strictly higher/,
    );
  });

  // -------------------------------------------------------------------------
  // Additional: the reserved instance-id prefix never reaches the agent tier
  // -------------------------------------------------------------------------
  it('promote() refuses the agent tier for an owner with the reserved instance-id prefix', async () => {
    const registry = makeRegistry();
    const tool = makeTool({ createdBy: 'gmi-instance-0b7e3c1a' });
    registry.register(tool, 'session');

    await expect(registry.promote(tool.id, 'agent')).rejects.toThrow(/reserved prefix "gmi-instance-"/);
    expect(registry.get(tool.id)?.tier).toBe('session');
  });

  // -------------------------------------------------------------------------
  // Additional: register() throws on duplicate ID
  // -------------------------------------------------------------------------
  it('register() throws when a tool with the same ID already exists', () => {
    const registry = makeRegistry();
    const tool = makeTool();

    registry.register(tool, 'session');
    expect(() => registry.register(tool, 'session')).toThrow(
      /already registered/,
    );
  });

  // -------------------------------------------------------------------------
  // Additional: recordUse() throws for unknown tool
  // -------------------------------------------------------------------------
  it('recordUse() throws for an unknown tool ID', () => {
    const registry = makeRegistry();

    expect(() =>
      registry.recordUse('emergent:nonexistent', {}, {}, true, 10),
    ).toThrow(/not found/);
  });

  // -------------------------------------------------------------------------
  // Additional: getUsageStats() returns undefined for unknown tool
  // -------------------------------------------------------------------------
  it('getUsageStats() returns undefined for an unknown tool ID', () => {
    const registry = makeRegistry();
    expect(registry.getUsageStats('emergent:nonexistent')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Additional: register() enforces maxAgentTools limit
  // -------------------------------------------------------------------------
  it('register() throws when maxAgentTools limit is exceeded', () => {
    const registry = makeRegistry({ maxAgentTools: 1 });

    registry.register(makeTool(), 'agent');

    expect(() => registry.register(makeTool(), 'agent')).toThrow(
      /Agent tool limit reached/,
    );
  });

  // -------------------------------------------------------------------------
  // Additional: promote() from agent to shared works
  // -------------------------------------------------------------------------
  it('promote() moves a tool from agent to shared tier', async () => {
    const registry = makeRegistry();
    const tool = makeTool();
    registry.register(tool, 'agent');

    await registry.promote(tool.id, 'shared', 'admin');

    expect(registry.getByTier('agent')).toHaveLength(0);
    expect(registry.getByTier('shared')).toHaveLength(1);
    expect(registry.get(tool.id)!.tier).toBe('shared');
  });

  // -------------------------------------------------------------------------
  // Additional: ensureSchema() is a no-op without a DB adapter
  // -------------------------------------------------------------------------
  it('ensureSchema() completes without error when no DB is provided', async () => {
    const registry = makeRegistry();
    await expect(registry.ensureSchema()).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Additional: getByTier() with agentId scope filter
  // -------------------------------------------------------------------------
  it('getByTier() filters by agentId scope', () => {
    const registry = makeRegistry();
    const tool1 = makeTool({ createdBy: 'agent-A' });
    const tool2 = makeTool({ createdBy: 'agent-B' });

    registry.register(tool1, 'agent');
    registry.register(tool2, 'agent');

    const filtered = registry.getByTier('agent', { agentId: 'agent-A' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].createdBy).toBe('agent-A');
  });
});

describe('EmergentToolRegistry generations', () => {
  const record = (toolId: string) => ({ toolId, state: 'active' as const, reason: null, setBy: 'library' as const, at: 1, request: null });

  it('a removal moves the generation even without storage, so a stale adoption is refused', () => {
    const registry = makeRegistry();
    const tool = makeTool({ id: 'gen-1', tier: 'shared' });
    const before = registry.generation('gen-1');
    registry.register(tool, 'shared');
    expect(registry.generation('gen-1')).not.toBe(before);
    const read = registry.generation('gen-1');
    registry.remove('gen-1');
    expect(registry.generation('gen-1')).not.toBe(read);
    expect(registry.adopt(tool, record('gen-1'), read)).toBe(false);
    expect(registry.get('gen-1')).toBeUndefined();
  });

  it('a registration under a removed id leaves a stale adoption refused and the new tool in place', () => {
    const registry = makeRegistry();
    const first = makeTool({ id: 'gen-2', name: 'first_tool', tier: 'shared' });
    registry.register(first, 'shared');
    const read = registry.generation('gen-2');
    registry.remove('gen-2');
    registry.register(makeTool({ id: 'gen-2', name: 'second_tool', tier: 'shared' }), 'shared');
    expect(registry.adopt(first, record('gen-2'), read)).toBe(false);
    expect(registry.get('gen-2')?.name).toBe('second_tool');
  });

  it('an adoption at the current generation lands, and moves the generation on', () => {
    const registry = makeRegistry();
    const tool = makeTool({ id: 'gen-3', tier: 'shared' });
    const read = registry.generation('gen-3');
    expect(registry.adopt(tool, record('gen-3'), read)).toBe(true);
    expect(registry.get('gen-3')).toBe(tool);
    expect(registry.generation('gen-3')).not.toBe(read);
    expect(registry.adopt(tool, record('gen-3'), read)).toBe(false);
  });
});
