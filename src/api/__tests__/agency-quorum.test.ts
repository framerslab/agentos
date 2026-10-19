import { describe, expect, it, vi } from 'vitest';
import { enforceQuorum } from '../runtime/strategies/shared.js';
import { compileParallel } from '../runtime/strategies/parallel.js';
import { AgencyQuorumError, type Agent, type AgencyOptions } from '../types.js';
import { setLoggerFactory, resetLoggerFactory } from '../../core/logging/loggerFactory.js';

const ok = (name: string, provider: string) => ({
  name,
  result: { text: `${name} view`, provider, model: 'm', usage: { totalTokens: 1 } } as Record<string, unknown>,
});

describe('enforceQuorum', () => {
  it('is a no-op without a quorum config', () => {
    expect(() => enforceQuorum(undefined, [], 6)).not.toThrow();
  });

  it('throws AgencyQuorumError when too few agents succeeded', () => {
    expect(() => enforceQuorum({ minAgents: 2 }, [ok('a', 'openai')], 6)).toThrow(AgencyQuorumError);
  });

  it('throws when successes collapse to a single provider below minProviders', () => {
    const settled = [ok('a', 'openai'), ok('b', 'openai'), ok('c', 'openai')];
    expect(() => enforceQuorum({ minAgents: 2, minProviders: 2 }, settled, 6)).toThrow(/1 distinct providers/);
  });

  it('passes when both floors are met', () => {
    const settled = [ok('a', 'openai'), ok('b', 'anthropic')];
    expect(() => enforceQuorum({ minAgents: 2, minProviders: 2 }, settled, 6)).not.toThrow();
  });

  it("onShortfall 'proceed' writes the shortfall through the host's logger instead of throwing, and to no console", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lines: Array<{ level: string; message: unknown; meta: unknown }> = [];
    const write = (level: string) => (message: unknown, meta?: unknown) => { lines.push({ level, message, meta }); };
    const logger = { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug'), child: () => logger };
    setLoggerFactory(() => logger as never);
    try {
      expect(() =>
        enforceQuorum({ minAgents: 3, onShortfall: 'proceed' }, [ok('a', 'openai')], 6),
      ).not.toThrow();
      expect(lines).toEqual([
        { level: 'warn', message: expect.stringContaining('quorum shortfall'), meta: { event: 'parallel_quorum_shortfall', shortfall: expect.stringContaining('1/6 agents succeeded (need 3)') } },
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      resetLoggerFactory();
      warn.mockRestore();
    }
  });

  it('ignores empty provider strings when counting diversity', () => {
    const settled = [ok('a', 'openai'), { name: 'b', result: { text: 'x' } as Record<string, unknown> }];
    expect(() => enforceQuorum({ minProviders: 2 }, settled, 2)).toThrow(AgencyQuorumError);
  });
});

describe('compileParallel quorum integration', () => {
  it('rejects with AgencyQuorumError BEFORE synthesis when seats collapse', async () => {
    const seat = (provider: string): Agent =>
      ({
        generate: async () => ({ text: 'view', provider, model: 'm', usage: { totalTokens: 1 } }),
      }) as unknown as Agent;
    const failing = {
      generate: async () => {
        throw new Error('provider down');
      },
    } as unknown as Agent;

    const agents = { a: seat('openai'), b: failing, c: failing };
    const config = {
      model: 'openai:gpt-4o', // synthesis config — must never be reached
      agents,
      quorum: { minAgents: 2, minProviders: 2 },
    } as unknown as AgencyOptions;

    const strategy = compileParallel(agents, config);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(strategy.execute('brief', undefined)).rejects.toBeInstanceOf(AgencyQuorumError);
    err.mockRestore();
  });
});
