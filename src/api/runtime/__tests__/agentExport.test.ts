/**
 * @fileoverview Tests for agent config export/import.
 *
 * Covers:
 * 1. Export agent config captures all fields
 * 2. Import recreates a working agent
 * 3. Round-trip: export → import → export produces equivalent config
 * 4. Validation rejects invalid configs
 * 5. Agency export includes agents + strategy
 * 6. YAML export/import works
 * 7. exportJSON produces valid JSON
 * 8. Agent instance .export() and .exportJSON() methods work
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import YAML from 'yaml';

import type { AgentExportConfig } from '../agentExport.js';
import type { BaseAgentConfig } from '../../types.js';
import {
  exportAgentConfig,
  exportAgentConfigJSON,
  exportAgentConfigYAML,
  importAgent,
  importAgentFromJSON,
  importAgentFromYAML,
  validateAgentExport,
} from '../agentExport.js';

// ---------------------------------------------------------------------------
// Mock the LLM backends — we do not want real API calls in unit tests
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  generateTextResult: {
    text: 'mock reply',
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    toolCalls: [],
  },
  strategyExecute: vi.fn(),
  strategyStream: vi.fn(),
}));

vi.mock('../../generateText.js', () => ({
  generateText: vi.fn(async () => hoisted.generateTextResult),
}));

vi.mock('../../streamText.js', () => ({
  streamText: vi.fn(() => ({
    textStream: (async function* () { yield 'mock'; })(),
    text: Promise.resolve('mock'),
    usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
  })),
}));

vi.mock('../strategies/index.js', () => ({
  compileStrategy: vi.fn(() => ({
    execute: hoisted.strategyExecute,
    stream: hoisted.strategyStream,
  })),
  isAgent: (value: unknown) =>
    typeof (value as Record<string, unknown>)?.generate === 'function',
}));

vi.mock('../usageLedger.js', () => ({
  getRecordedAgentOSUsage: vi.fn(async () => ({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  })),
}));

import { agent } from '../agent.js';
import { agency } from '../../agency.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMinimalAgent() {
  return agent({
    model: 'openai:gpt-4o-mini',
    instructions: 'Be helpful.',
    name: 'test-bot',
  });
}

function makeRichAgent() {
  return agent({
    model: 'openai:gpt-4o',
    provider: 'openai',
    instructions: 'You are a research assistant.',
    name: 'rich-bot',
    personality: { openness: 0.9, conscientiousness: 0.8 },
    maxSteps: 10,
    memory: true,
    guardrails: ['pii-redaction'],
    security: { tier: 'balanced' },
    permissions: { tools: 'all', network: true },
  });
}

function makeMinimalAgency() {
  // Set up strategy mock return value
  hoisted.strategyExecute.mockResolvedValue({
    text: 'agency result',
    agentCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  });

  return agency({
    model: 'openai:gpt-4o',
    strategy: 'sequential',
    agents: {
      researcher: { instructions: 'Research things.', model: 'openai:gpt-4o-mini' },
      writer: { instructions: 'Write summaries.', model: 'openai:gpt-4o' },
    },
    maxRounds: 3,
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Agent Export/Import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.strategyExecute.mockResolvedValue({
      text: 'agency result',
      agentCalls: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  });

  // -------------------------------------------------------------------------
  // 1. Export captures all fields
  // -------------------------------------------------------------------------
  it('exports agent config with all fields', () => {
    const a = makeRichAgent();
    const config = exportAgentConfig(a, {
      name: 'Test Export',
      author: 'unit-test',
      tags: ['test'],
    });

    expect(config.version).toBe('1.0.0');
    expect(config.type).toBe('agent');
    expect(config.exportedAt).toBeDefined();
    expect(new Date(config.exportedAt).getTime()).toBeGreaterThan(0);

    // Config fields should be captured
    expect(config.config.model).toBe('openai:gpt-4o');
    expect(config.config.instructions).toBe('You are a research assistant.');
    expect(config.config.name).toBe('rich-bot');
    expect(config.config.personality?.openness).toBe(0.9);
    expect(config.config.maxSteps).toBe(10);
    expect(config.config.memory).toBe(true);
    expect(config.config.guardrails).toEqual(['pii-redaction']);
    expect(config.config.security?.tier).toBe('balanced');

    // Metadata
    expect(config.metadata?.name).toBe('Test Export');
    expect(config.metadata?.author).toBe('unit-test');

    // Agency fields should not be present for single agents
    expect(config.agents).toBeUndefined();
    expect(config.strategy).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 2. Import recreates a working agent
  // -------------------------------------------------------------------------
  it('imports and recreates a working agent', async () => {
    const original = makeMinimalAgent();
    const config = exportAgentConfig(original);

    const imported = importAgent(config);

    // The imported agent should be a functional Agent instance
    expect(typeof imported.generate).toBe('function');
    expect(typeof imported.stream).toBe('function');
    expect(typeof imported.session).toBe('function');
    expect(typeof imported.close).toBe('function');

    // Should be able to call generate
    const result = await imported.generate('test');
    expect(result).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 3. Round-trip produces equivalent config
  // -------------------------------------------------------------------------
  it('round-trip: export → import → export produces equivalent config', () => {
    const original = makeRichAgent();
    const firstExport = exportAgentConfig(original);

    const imported = importAgent(firstExport);
    const secondExport = exportAgentConfig(imported);

    // Core fields should be identical
    expect(secondExport.version).toBe(firstExport.version);
    expect(secondExport.type).toBe(firstExport.type);
    expect(secondExport.config.model).toBe(firstExport.config.model);
    expect(secondExport.config.instructions).toBe(firstExport.config.instructions);
    expect(secondExport.config.name).toBe(firstExport.config.name);
    expect(secondExport.config.personality).toEqual(firstExport.config.personality);
    expect(secondExport.config.maxSteps).toBe(firstExport.config.maxSteps);
    expect(secondExport.config.memory).toBe(firstExport.config.memory);
    expect(secondExport.config.guardrails).toEqual(firstExport.config.guardrails);
  });

  // -------------------------------------------------------------------------
  // 4. Validation rejects invalid configs
  // -------------------------------------------------------------------------
  it('rejects null config', () => {
    const result = validateAgentExport(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Config must be a non-null object');
  });

  it('rejects missing version', () => {
    const result = validateAgentExport({
      type: 'agent',
      exportedAt: new Date().toISOString(),
      config: {},
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/version/i);
  });

  it('rejects invalid type', () => {
    const result = validateAgentExport({
      version: '1.0.0',
      type: 'invalid',
      exportedAt: new Date().toISOString(),
      config: {},
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/type/i);
  });

  it('rejects agency without agents roster', () => {
    const result = validateAgentExport({
      version: '1.0.0',
      type: 'agency',
      exportedAt: new Date().toISOString(),
      config: {},
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('agents'))).toBe(true);
  });

  it('rejects agency with invalid strategy', () => {
    const result = validateAgentExport({
      version: '1.0.0',
      type: 'agency',
      exportedAt: new Date().toISOString(),
      config: {},
      agents: { a: { instructions: 'test' } },
      strategy: 'nonexistent',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('strategy'))).toBe(true);
  });

  it('accepts a valid agent config', () => {
    const a = makeMinimalAgent();
    const config = exportAgentConfig(a);
    const result = validateAgentExport(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5. Agency export includes agents + strategy
  // -------------------------------------------------------------------------
  it('exports agency with sub-agents and strategy', () => {
    const a = makeMinimalAgency();
    const config = exportAgentConfig(a);

    expect(config.type).toBe('agency');
    expect(config.agents).toBeDefined();
    expect(Object.keys(config.agents!)).toEqual(['researcher', 'writer']);
    // A roster entry is a config or a pre-built seat's marker; these two are configs.
    expect((config.agents!.researcher as BaseAgentConfig).instructions).toBe('Research things.');
    expect((config.agents!.writer as BaseAgentConfig).model).toBe('openai:gpt-4o');
    expect(config.strategy).toBe('sequential');
    expect(config.maxRounds).toBe(3);
  });

  it('validates agency export correctly', () => {
    const a = makeMinimalAgency();
    const config = exportAgentConfig(a);
    const result = validateAgentExport(config);
    expect(result.valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 6. YAML export/import
  // -------------------------------------------------------------------------
  it('exports and imports via YAML round-trip', () => {
    const original = makeRichAgent();
    const yamlStr = exportAgentConfigYAML(original);

    // Should be valid YAML
    const parsed = YAML.parse(yamlStr) as AgentExportConfig;
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.config.model).toBe('openai:gpt-4o');

    // Import from YAML should work
    const imported = importAgentFromYAML(yamlStr);
    expect(typeof imported.generate).toBe('function');
  });

  // -------------------------------------------------------------------------
  // 7. JSON export produces valid JSON
  // -------------------------------------------------------------------------
  it('exports valid JSON string', () => {
    const original = makeMinimalAgent();
    const json = exportAgentConfigJSON(original);

    // Must parse without error
    const parsed = JSON.parse(json) as AgentExportConfig;
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.type).toBe('agent');
    expect(parsed.config.model).toBe('openai:gpt-4o-mini');
  });

  it('imports from JSON string', () => {
    const original = makeMinimalAgent();
    const json = exportAgentConfigJSON(original);
    const imported = importAgentFromJSON(json);

    expect(typeof imported.generate).toBe('function');
    expect(typeof imported.close).toBe('function');
  });

  // -------------------------------------------------------------------------
  // 8. Instance methods .export() and .exportJSON()
  // -------------------------------------------------------------------------
  it('agent instance has .export() method', () => {
    const a = makeMinimalAgent();
    expect(typeof a.export).toBe('function');

    const config = a.export!({ name: 'Instance Export' });
    expect((config as AgentExportConfig).version).toBe('1.0.0');
    expect((config as AgentExportConfig).type).toBe('agent');
    expect((config as AgentExportConfig).metadata?.name).toBe('Instance Export');
  });

  it('agent instance has .exportJSON() method', () => {
    const a = makeMinimalAgent();
    expect(typeof a.exportJSON).toBe('function');

    const json = a.exportJSON!();
    const parsed = JSON.parse(json) as AgentExportConfig;
    expect(parsed.version).toBe('1.0.0');
  });

  it('agency instance has .export() method', () => {
    const a = makeMinimalAgency();
    expect(typeof a.export).toBe('function');

    const config = a.export!() as AgentExportConfig;
    expect(config.type).toBe('agency');
    expect(config.agents).toBeDefined();
  });

  it('agency instance has .exportJSON() method', () => {
    const a = makeMinimalAgency();
    expect(typeof a.exportJSON).toBe('function');

    const json = a.exportJSON!();
    const parsed = JSON.parse(json) as AgentExportConfig;
    expect(parsed.type).toBe('agency');
  });
});
