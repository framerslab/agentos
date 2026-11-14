/**
 * Which system entries a GMI turn labels fixed, and when it asks the prompt engine for a cached first block: on an
 * Anthropic-family hop with prompt caching, unless the call opts out (`cache: false`, a `customModelParams` override,
 * the auto-cache switch, a model with no cache support). A `beforeModelCall` hook sees the split prompt; the GMI
 * removes only its own marker when the hook's result would carry more than four. Runs the real GMI and PromptEngine
 * over a scripted provider.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScriptedGmi, scriptedProvider, textReply, textTurn, runTurn, systemTextOf, toolCallReply } from './helpers/scriptedGmi';

afterEach(() => { vi.unstubAllEnvs(); });
const base = [
  { content: 'Policy', priority: 1, stability: 'persona' },
  { content: 'Clock', priority: 50, stability: 'turn' },
];
async function request(options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const provider = scriptedProvider([textReply('Done.')], 'anthropic');
  const built = await createScriptedGmi({ provider: provider.provider, persona: {
    defaultModelId: 'claude-sonnet-4-6', baseSystemPrompt: base,
    defaultModelCompletionOptions: options,
  }, ...extra } as never);
  try { await runTurn(built.gmi, textTurn('t1', 'Hi.')); } finally { await built.gmi.shutdown(); }
  return { ...provider, gmi: built.gmi };
}
const systems = (messages: any[]) => messages.filter((message) => message.role === 'system');
const markers = (value: unknown): number => {
  if (!value || typeof value !== 'object') return 0;
  return Object.entries(value).reduce((total, [key, item]) => total + (key === 'cache_control' ? 1 : markers(item)), 0);
};

describe('GMI cache eligibility', () => {
  it('labels the base and splits before turn metadata', async () => {
    const result = await request();
    expect(systems(result.received[0])).toHaveLength(2);
    expect(systemTextOf(result.received[0])).toBe('Policy\n\nClock');
    expect(markers(result.received[0])).toBe(1);
  });
  it.each(['system', 'messages', 'tools', 'cache_control'])('stands down for customModelParams.%s', async (key) => {
    const result = await request({ customModelParams: { [key]: [] } });
    expect(systems(result.received[0])).toEqual([{ role: 'system', content: 'Policy\n\nClock' }]);
    expect(markers(result.received[0])).toBe(0);
  });
  it.each(['0', 'false'])('stands down when the auto-cache switch is %s', async (value) => {
    vi.stubEnv('AGENTOS_ANTHROPIC_AUTO_CACHE', value);
    const result = await request();
    expect(systems(result.received[0])).toEqual([{ role: 'system', content: 'Policy\n\nClock' }]);
  });
  it.each([{ cache: false }, { customModelParams: { model: 'proxy-model' } }])('stands down for %j', async (options) => {
    const result = await request(options);
    expect(systems(result.received[0])).toEqual([{ role: 'system', content: 'Policy\n\nClock' }]);
  });
  it('removes only its own fifth marker after the hook', async () => {
    const result = await request({}, { config: { beforeModelCall: ({ messages }: any) => [
      ...messages,
      ...Array.from({ length: 4 }, (_, i) => ({ role: 'system', content: [
        { type: 'text', text: `Host ${i}`, cache_control: { type: 'ephemeral' } },
      ] })),
    ] } });
    expect(markers(result.received[0])).toBe(4);
    expect((systems(result.received[0])[0].content as any[])[0]).not.toHaveProperty('cache_control');
    expect((result.gmi as any).reasoningTrace.entries.filter((entry: any) =>
      entry.type === 'WARNING' && entry.message === 'Dropped the GMI system cache marker because the hook supplied more than four markers.',
    )).toHaveLength(1);
  });
  // A hook that writes a marker of its own on the fixed part has taken that marker over: the GMI's is gone, so nothing
  // is the GMI's to remove, and the hook's five go out as returned.
  it.each([
    { how: 'sets a new marker', write: (part: any) => { part.cache_control = { type: 'ephemeral', ttl: '1h' }; } },
    { how: 'changes the marker in place', write: (part: any) => { part.cache_control.ttl = '1h'; } },
  ])('leaves the fixed part marked when the hook $how on it and adds four more', async ({ write }) => {
    const result = await request({}, { config: { beforeModelCall: ({ messages }: any) => {
      write(messages.find((message: any) => message.role === 'system').content[0]);
      return [
        ...messages,
        ...Array.from({ length: 4 }, (_, i) => ({ role: 'system', content: [
          { type: 'text', text: `Host ${i}`, cache_control: { type: 'ephemeral' } },
        ] })),
      ];
    } } });
    expect((systems(result.received[0])[0].content as any[])[0], "the hook's one-hour marker stays on the fixed part")
      .toEqual({ type: 'text', text: 'Policy', cache_control: { type: 'ephemeral', ttl: '1h' } });
    expect(markers(result.received[0])).toBe(5);
    expect((result.gmi as any).reasoningTrace.entries.filter((entry: any) =>
      entry.type === 'WARNING' && entry.message === 'Dropped the GMI system cache marker because the hook supplied more than four markers.',
    )).toHaveLength(0);
  });
  it('includes hard limits in the marked block when all entries are fixed', async () => {
    const result = await request({}, { persona: { defaultModelId: 'claude-sonnet-4-6', baseSystemPrompt: 'Policy', hardLimits: ['Final constraint.'] } });
    const system = systems(result.received[0]);
    expect(system).toHaveLength(1);
    expect(Array.isArray(system[0].content), 'the fixed block is a text part').toBe(true);
    expect(system[0].content[0].text).toMatch(/Final constraint\.$/);
    expect(system[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });
  it('keeps hard limits last while labeling personality and turn entries', async () => {
    const provider = scriptedProvider([textReply('Done.')], 'anthropic');
    const { gmi, promptEngine } = await createScriptedGmi({ provider: provider.provider, persona: {
      defaultModelId: 'claude-sonnet-4-6', baseSystemPrompt: 'Policy', hardLimits: ['Keep this limit.'],
    }, config: { personaTraits: { authored: { honesty: 0.9, extraversion: 0.9 } } } });
    const construct = vi.spyOn(promptEngine, 'constructPrompt');
    try {
      await runTurn(gmi, textTurn('labels', 'Hello.', {
        rollingSummary: { text: 'Summary' }, promptProfile: { systemInstructions: 'Profile' },
        capabilityDiscovery: { promptContext: 'Discovery' }, skillPromptContext: 'Skill',
      } as any));
      const entries = construct.mock.calls[0][0].systemPrompts as any[];
      expect(entries[0].stability).toBe('persona');
      expect(entries.find((entry) => entry.source === 'gmi:personality')?.stability).toBe('persona');
      for (const priority of [50, 55, 57, 60]) expect(entries.find((entry) => entry.priority === priority)?.stability).toBe('turn');
      expect(entries.at(-1).stability).toBe('persona');
      expect(systemTextOf(provider.received[0]).trimEnd()).toMatch(/Keep this limit\.$/);
    } finally { await gmi.shutdown(); }
  });
  it('passes a hook replacement through without adding a marker', async () => {
    const replacement = [{ role: 'system', content: 'Host replacement' }, { role: 'user', content: 'Hi.' }];
    const result = await request({}, { config: { beforeModelCall: () => replacement } });
    expect(result.received[0]).toEqual(replacement);
    expect(markers(result.received[0])).toBe(0);
  });
  it('labels a learner personality section as conversation-stable', async () => {
    const provider = scriptedProvider([textReply('Done.')], 'anthropic');
    const session = {
      prepareTurn: vi.fn(async () => ({
        systemPrompts: [{ content: 'Learned traits', priority: 2, source: 'learning:personality' }],
        learner: 'bound', mode: 'on',
      })),
      endSession: vi.fn(async () => undefined), currentTraits: () => ({}),
    };
    const { gmi, promptEngine } = await createScriptedGmi({ provider: provider.provider,
      persona: { baseSystemPrompt: 'Policy', defaultModelId: 'claude-sonnet-4-6' }, config: { learning: session as any },
    });
    const construct = vi.spyOn(promptEngine, 'constructPrompt');
    try {
      await runTurn(gmi, textTurn('learner-label', 'Hi.'));
      expect((construct.mock.calls[0][0].systemPrompts as any[]).find((entry) => entry.source === 'learning:personality').stability).toBe('conversation');
      expect(Array.isArray(provider.received[0][0].content), 'the fixed block is a text part').toBe(true);
      expect((provider.received[0][0].content as any[])[0].text).toBe('Policy\n\nLearned traits');
    } finally { await gmi.shutdown(); }
  });
  it('sums reported cache counters on raw GMIOutput and leaves absent counters absent', async () => {
    const usage = { promptTokens: 3, completionTokens: 2, totalTokens: 5,
      cacheReadInputTokens: 11, cacheCreationInputTokens: 17, cacheCreationExtendedInputTokens: 0, inclusiveInputTokens: 31 };
    const tool = toolCallReply([{ id: 'lookup-cache', name: 'lookup', args: { q: 'x' } }]);
    tool.at(-1)!.usage = usage;
    const p = scriptedProvider([tool, textReply('Done.', usage), textReply('No cache fields.')]);
    const { gmi } = await createScriptedGmi({ provider: p.provider });
    try {
      const first = await runTurn(gmi, textTurn('usage-1', 'Look up x.'));
      expect(first.output.usage).toMatchObject({ cacheReadTokens: 22, cacheCreationTokens: 34,
        cacheCreationExtendedTokens: 0, inclusiveInputTokens: 62 });
      const second = await runTurn(gmi, textTurn('usage-2', 'Hi.'));
      for (const field of ['cacheReadTokens', 'cacheCreationTokens', 'cacheCreationExtendedTokens', 'inclusiveInputTokens']) {
        expect(second.output.usage).not.toHaveProperty(field);
      }
    } finally { await gmi.shutdown(); }
  });
});
