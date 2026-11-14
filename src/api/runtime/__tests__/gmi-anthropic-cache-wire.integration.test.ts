/**
 * @file gmi-anthropic-cache-wire.integration.test.ts
 * The request bodies a GMI turn puts on the Anthropic wire: agent({ runtime: 'gmi' }) and the full runtime
 * (AgentOS.create) over the real AnthropicProvider, with only fetch stubbed and, for cognitive memory, the separate
 * embedding provider. The fixed system entries go out as a first block with a cache marker, the changing entries
 * after it, and the opt-outs (`cache: false`, the auto-cache switch, a model with no cache support) keep one system
 * string. A spy on the real memory assembler records the block each turn sends, which must arrive whole in the user
 * message. No live provider request runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const capture = vi.hoisted(() => ({ assemblies: [] as Array<{ contextText: string; tokensUsed: number }> }));
vi.mock('../../../core/llm/providers/implementations/OpenAIProvider', async () => ({
  OpenAIProvider: (await import('../../__tests__/helpers/stubProviders')).stubProviderClass('openai'),
}));
vi.mock('../../../cognition/memory/core/prompt/MemoryPromptAssembler', async (original) => {
  const actual = await original<typeof import('../../../cognition/memory/core/prompt/MemoryPromptAssembler')>();
  return { ...actual, assembleMemoryContext: (...args: Parameters<typeof actual.assembleMemoryContext>) => {
    const result = actual.assembleMemoryContext(...args); capture.assemblies.push(result); return result;
  } };
});
import { agent, type AgentOptions } from '../../agent';
import { script, systemTextOf } from '../../__tests__/helpers/stubProviders';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry';
import { APPLICATION_NOTE_FRAME, PromptEngine } from '../../../core/llm/PromptEngine';
import { promptEngineConfig } from '../../../cognition/substrate/__tests__/helpers/scriptedGmi';
import { MEMORY_RECALL_SYSTEM_LINE } from '../memoryDataBlock';
import { AgentOS } from '../../AgentOS';
import { DEFAULT_PROMPT_PROFILE_CONFIG } from '../../structured/prompting/PromptProfileRouter';
import { createCurrentDateTimeTool } from '../../../core/tools/builtins/currentDateTime';

/** The frame line the prompt engine opens retrieved text with. */
const FRAME = APPLICATION_NOTE_FRAME;
type Json = Record<string, any>;
let bodies: Json[];
let agents: ReturnType<typeof agent>[];
let serial = 0;
function response(model: string) {
  const events = [
    { type: 'message_start', message: { id: 'msg-test', type: 'message', role: 'assistant', content: [], model,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Noted.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
}
function make(extra: Record<string, unknown> = {}) {
  const a = agent({ runtime: 'gmi', provider: 'anthropic', model: 'claude-sonnet-4-6',
    apiKey: `wire-test-${++serial}`, fallbackProviders: [], cognition: { mechanisms: false }, chainOfThought: false,
    systemBlocks: [{ text: 'Policy', cacheBreakpoint: true }, { text: 'Clock' }], ...extra,
  } as unknown as AgentOptions);
  agents.push(a); return a;
}
const markerCount = (value: unknown): number => !value || typeof value !== 'object' ? 0
  : Object.entries(value).reduce((sum, [key, nested]) => sum + (key === 'cache_control' ? 1 : markerCount(nested)), 0);
/** The text of each block of a request's `system`, or the one string it is. */
const systemTexts = (system: unknown): unknown[] => Array.isArray(system) ? system.map((part: any) => part.text) : [system];
/** The lifetime of each marker of a request, in the order Anthropic reads them: the system blocks, then the messages. */
const lifetimesOf = (body: Json): string[] => [
  ...(Array.isArray(body.system) ? body.system : []),
  ...body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []),
].filter((block: any) => block?.cache_control).map((block: any) => block.cache_control.ttl ?? '5m');
/** Whether every one-hour marker comes before every five-minute one, the only order Anthropic accepts. */
const hourFirst = (lifetimes: string[]): boolean =>
  lifetimes.indexOf('5m') < 0 || lifetimes.lastIndexOf('1h') < lifetimes.indexOf('5m');
beforeEach(() => {
  bodies = []; agents = []; capture.assemblies.length = 0; globalLLMProviderHealth.reset();
  vi.stubEnv('AGENTOS_ANTHROPIC_AUTO_CACHE', '1');
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    // Only a model request carries a body; anything else (a key probe) gets an empty answer.
    const raw = init?.body;
    if (typeof raw !== 'string') return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    const body = JSON.parse(raw); bodies.push(body); return response(body.model);
  }));
});
afterEach(async () => {
  for (const a of agents) await a.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
describe('GMI Anthropic wire', () => {
  it('sends a marked fixed block before the changing tail and keeps the tool definitions identical', async () => {
    let turn = 0;
    const a = make({
      tools: [{ name: 'lookup', description: 'Look up.', inputSchema: { type: 'object', properties: {} }, execute: async () => ({ success: true, output: 'ok' }) }],
      onBeforeGeneration: ({ messages }: any) => {
        turn += 1;
        return { messages: messages.map((message: any) => message.role === 'system' && message.content === 'Clock'
          ? { ...message, content: `Clock ${turn}` } : message) };
      },
    });
    const session = a.session('wire'); await session.send('one'); await session.send('two');
    expect(bodies).toHaveLength(2);
    expect(Array.isArray(bodies[0].system), 'the system goes out as blocks').toBe(true);
    expect(bodies[0].system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(bodies[0].system[0].text).toContain('Policy');
    expect(bodies[0].system[0]).toEqual(bodies[1].system[0]);
    expect(JSON.stringify(bodies[0].tools)).toBe(JSON.stringify(bodies[1].tools));
    expect(bodies[0].tools.length).toBeGreaterThan(0);
    expect(bodies[0].system.at(-1).text).toBe('Clock 1');
    expect(bodies[1].system.at(-1).text).toBe('Clock 2');
  });
  it('uses one trimmed marked block when every entry is fixed', async () => {
    await make({ systemBlocks: [{ text: '  Policy  ' }] }).generate('hi');
    expect(bodies[0].system).toEqual([{ type: 'text', text: 'Policy', cache_control: { type: 'ephemeral' } }]);
  });
  it('cache false keeps the hook and wire as one string with no marker', async () => {
    const seen: any[] = [];
    await make({ cache: false, onBeforeGeneration: ({ messages }: any) => { seen.push(messages); } }).generate('hi');
    expect(seen[0].filter((message: any) => message.role === 'system')).toEqual([{ role: 'system', content: 'Policy\n\nClock' }]);
    expect(bodies[0].system).toBe('Policy\n\nClock'); expect(markerCount(bodies[0])).toBe(0);
  });
  it('tail false leaves only the fixed-block marker', async () => {
    await make({ cache: { tail: false } }).generate('hi');
    expect(markerCount(bodies[0])).toBe(1);
    expect(bodies[0].system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(markerCount(bodies[0].messages)).toBe(0);
    expect(bodies[0]).not.toHaveProperty('cache_control');
  });
  it('carries the one-hour TTL', async () => {
    await make({ cache: { ttl: '1h' } }).generate('hi');
    expect(bodies[0].system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
  it.each(['0', 'false'])('sends no markers when auto caching is %s', async (value) => {
    vi.stubEnv('AGENTOS_ANTHROPIC_AUTO_CACHE', value); await make().generate('hi');
    expect(bodies[0].system).toBe('Policy\n\nClock'); expect(markerCount(bodies[0])).toBe(0);
  });
  it('sends no marker for a non-Claude proxy model', async () => {
    await make({ model: 'proxy-model' }).generate('hi');
    expect(bodies[0].system).toBe('Policy\n\nClock'); expect(markerCount(bodies[0])).toBe(0);
  });
  it('drops empty blocks and keeps onBeforeGeneration system text', async () => {
    let system: unknown;
    await make({ systemBlocks: [{ text: 'A', cacheBreakpoint: true }, { text: '' }, { text: 'B' }],
      onBeforeGeneration: (ctx: any) => { system = ctx.system; },
    }).generate('hi');
    expect(system).toBe('A\n\nB');
    expect(systemTexts(bodies[0].system)).toEqual(['A', 'B']);
  });
  it('leaves exactly four host markers on the wire', async () => {
    await make({ onBeforeGeneration: ({ messages }: any) => ({ messages: [...messages,
      ...Array.from({ length: 4 }, (_, i) => ({ role: 'system', content: [{
        type: 'text', text: `Host ${i}`, cache_control: { type: 'ephemeral' },
      }] })),
    ] }) }).generate('hi');
    expect(markerCount(bodies[0])).toBe(4);
    expect(bodies[0].system[0]).not.toHaveProperty('cache_control');
  });
  // Anthropic reads markers in the order tools, system, messages, and refuses a one-hour marker after a five-minute one.
  it('sends no five-minute marker before a one-hour marker the hook adds', async () => {
    await make({ onBeforeGeneration: ({ messages }: any) => ({ messages: [...messages,
      { role: 'system', content: [{ type: 'text', text: 'Host', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    ] }) }).generate('hi');
    const blocks = [
      ...(Array.isArray(bodies[0].system) ? bodies[0].system : []),
      ...bodies[0].messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []),
    ];
    const lifetimes = blocks.filter((block: any) => block?.cache_control).map((block: any) => block.cache_control.ttl ?? '5m');
    const firstShort = lifetimes.indexOf('5m');
    expect(firstShort < 0 || lifetimes.lastIndexOf('1h') < firstShort, `every one-hour marker comes first: ${lifetimes.join(', ')}`).toBe(true);
    expect(bodies[0].system.find((block: any) => block.text === 'Host')?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
  // A hook that copies the parts holds a copy of the GMI's marked part: another object with the same text and marker.
  it('leaves four markers when a hook copies the parts and adds four of its own', async () => {
    await make({ onBeforeGeneration: ({ messages }: any) => ({ messages: [...structuredClone(messages),
      ...Array.from({ length: 4 }, (_, i) => ({ role: 'system', content: [{
        type: 'text', text: `Host ${i}`, cache_control: { type: 'ephemeral' },
      }] })),
    ] }) }).generate('hi');
    expect(markerCount(bodies[0]), 'at most four markers reach the provider').toBe(4);
    expect(bodies[0].system[0]).not.toHaveProperty('cache_control');
  });
  it('sends no five-minute marker before a one-hour marker when the hook copies each part', async () => {
    await make({ onBeforeGeneration: ({ messages }: any) => ({ messages: [
      ...messages.map((message: any) => ({
        ...message,
        content: Array.isArray(message.content) ? message.content.map((part: any) => ({ ...part })) : message.content,
      })),
      { role: 'system', content: [{ type: 'text', text: 'Host', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    ] }) }).generate('hi');
    const lifetimes = lifetimesOf(bodies[0]);
    expect(hourFirst(lifetimes), `copied parts: every one-hour marker comes first: ${lifetimes.join(', ')}`).toBe(true);
    expect(bodies[0].system.find((block: any) => block.text === 'Host')?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
  // A marker equal to the GMI's that the hook sets on the fixed part is removed only where the request would be refused.
  it('drops an equal marker the hook sets on the fixed part when the request would hold five markers', async () => {
    await make({ onBeforeGeneration: ({ messages }: any) => {
      messages.find((message: any) => message.role === 'system').content[0].cache_control = { type: 'ephemeral' };
      return { messages: [...messages, ...Array.from({ length: 4 }, (_, i) => ({ role: 'system', content: [{
        type: 'text', text: `Host ${i}`, cache_control: { type: 'ephemeral' },
      }] }))] };
    } }).generate('hi');
    expect(markerCount(bodies[0]), 'at most four markers reach the provider').toBe(4);
    expect(bodies[0].system[0]).not.toHaveProperty('cache_control');
  });
  it('keeps the marker on a copied part as the hook returned it when the request is valid', async () => {
    await make({ cache: { tail: false }, onBeforeGeneration: ({ messages }: any) => ({ messages: structuredClone(messages) }) }).generate('hi');
    expect(bodies[0].system[0]).toEqual({ type: 'text', text: 'Policy', cache_control: { type: 'ephemeral' } });
    expect(markerCount(bodies[0])).toBe(1);
  });
  it('sends no one-hour marker after a shorter one the hook puts before it', async () => {
    await make({ cache: { ttl: '1h' }, onBeforeGeneration: ({ messages }: any) => {
      const newest = messages.map((message: any) => message.role).lastIndexOf('user');
      return { messages: [
        { role: 'system', content: [{ type: 'text', text: 'Org', cache_control: { type: 'ephemeral' } }] },
        ...messages.map((message: any, index: number) => index !== newest ? message : {
          ...message,
          content: [{ type: 'text', text: String(message.content), cache_control: { type: 'ephemeral' } }],
        }),
      ] };
    } }).generate('hi');
    const lifetimes = lifetimesOf(bodies[0]);
    expect(hourFirst(lifetimes), `host markers before the GMI's: every one-hour marker comes first: ${lifetimes.join(', ')}`).toBe(true);
    expect(bodies[0].system[0]).toEqual({ type: 'text', text: 'Org', cache_control: { type: 'ephemeral' } });
  });
  it('splits at the last breakpoint when a blank block comes before it', async () => {
    await make({ systemBlocks: [{ text: '  ' }, { text: 'Policy', cacheBreakpoint: true }, { text: 'Clock' }] }).generate('hi');
    expect(systemTexts(bodies[0].system), 'a leading blank block').toEqual(['Policy', 'Clock']);
    expect(bodies[0].system[0].cache_control).toEqual({ type: 'ephemeral' });
  });
  it('keeps every block through the last breakpoint in the marked block when a blank block sits among them', async () => {
    await make({ systemBlocks: [{ text: 'A' }, { text: ' ' }, { text: 'B', cacheBreakpoint: true }, { text: 'C' }] }).generate('hi');
    expect(systemTexts(bodies[0].system), 'a blank block before the breakpoint').toEqual(['A\n\n \n\nB', 'C']);
    expect(bodies[0].system[0].cache_control).toEqual({ type: 'ephemeral' });
  });
  it('uses the last breakpoint and keeps the recall line in the hook base text', async () => {
    let system: unknown;
    await make({
      systemBlocks: [{ text: 'A', cacheBreakpoint: true }, { text: 'B', cacheBreakpoint: true }, { text: 'C' }],
      memoryProvider: { getContext: async () => '' },
      onBeforeGeneration: (context: any) => { system = context.system; },
    }).generate('hi');
    expect(systemTexts(bodies[0].system)).toEqual(['A\n\nB', `C\n\n${MEMORY_RECALL_SYSTEM_LINE}`]);
    expect(bodies[0].system[0]).toMatchObject({ text: 'A\n\nB', cache_control: { type: 'ephemeral' } });
    expect(system).toBe(`A\n\nB\n\nC\n\n${MEMORY_RECALL_SYSTEM_LINE}`);
  });
  it('joins multiple blocks without a breakpoint as one fixed entry', async () => {
    await make({ systemBlocks: [{ text: 'A' }, { text: '' }, { text: 'B' }] }).generate('hi');
    expect(bodies[0].system).toEqual([{ type: 'text', text: 'A\n\nB', cache_control: { type: 'ephemeral' } }]);
  });
  it('delivers cognitive memory whole in the user message after the cached block', async () => {
    const embeddingKey = `embedding-${++serial}`; script('openai', embeddingKey, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', embeddingKey);
    const a = make({ cognition: { memory: { embedding: { provider: 'openai' } }, mechanisms: false } });
    const session = a.session('memory');
    await session.send('The camping stove is in parcel locker number 14.');
    session.clear();
    const result = await session.send('Which parcel locker holds the camping stove?');
    const block = capture.assemblies.at(-1)!;
    expect(block.contextText.length).toBeGreaterThan(0);
    const body = bodies.at(-1)!;
    expect(JSON.stringify(body.system)).not.toContain('parcel locker number 14');
    const userText = body.messages.filter((message: any) => message.role === 'user').map((message: any) =>
      typeof message.content === 'string' ? message.content : message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n\n'),
    ).join('\n\n');
    expect(userText).toContain(block.contextText);
    expect(result.memoryRecall?.delivery?.memoryBlockTokens).toBeGreaterThan(0);
    const counter = new PromptEngine(); await counter.initialize(promptEngineConfig());
    expect(result.memoryRecall?.delivery?.memoryBlockTokens).toBe(await counter.estimateTokenCount(block.contextText, 'claude-sonnet-4-6'));
    expect(result.memoryRecall?.delivery?.otherContext?.cutBy).toBeUndefined();
    expect(Array.isArray(body.system), 'the system goes out as blocks').toBe(true);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(systemTextOf([{ role: 'system', content: body.system }])).toContain('Policy');
  });
  it("sends the memory block as a text block of its own before the person's words, which arrive untouched", async () => {
    const embeddingKey = `embedding-${++serial}`; script('openai', embeddingKey, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', embeddingKey);
    const a = make({ cognition: { memory: { embedding: { provider: 'openai' } }, mechanisms: false }, cache: { tail: false } });
    const session = a.session('words');
    await session.send("Work at the hotel front desk is slow in the afternoon, so I end up bothering Tess when I'm bored.");
    session.clear();
    const words = "Hey Tess! Slow afternoon at work so I'm bothering you.";
    await session.send(words);
    const block = capture.assemblies.at(-1)!;
    expect(block.contextText.length).toBeGreaterThan(0);
    const body = bodies.at(-1)!;
    const newest = body.messages.filter((message: any) => message.role === 'user').at(-1);
    expect(newest.content).toEqual([
      { type: 'text', text: `${FRAME}\n${block.contextText}` },
      { type: 'text', text: words },
    ]);
    expect(JSON.stringify(body)).not.toContain('User Query:');
    expect(JSON.stringify(body)).not.toContain('Context:\\n');
  });
});

describe('full-runtime Anthropic wire', () => {
  it('keeps the fixed block and the tools identical while the prompt-profile add-on changes', async () => {
    const os = await AgentOS.create({
      modelProviderManagerConfig: { providers: [{ providerId: 'anthropic', enabled: true, isDefault: true, config: { apiKey: `wire-runtime-${++serial}` } }] },
      turnPlanning: { enabled: false },
      // the runtime registers no tool of its own, so the host names one: the requests then carry a tool list to compare
      tools: [createCurrentDateTimeTool()],
      orchestratorConfig: {
        enableConversationalPersistence: false,
        promptProfileConfig: { ...DEFAULT_PROMPT_PROFILE_CONFIG, routing: { ...DEFAULT_PROMPT_PROFILE_CONFIG.routing, reviewEveryNTurns: 1 } },
      },
      personas: [{ id: 'cached-runtime', name: 'Cached runtime', description: 'Full-runtime cache wire test.', version: '1.0.0',
        baseSystemPrompt: 'Host policy.', defaultProviderId: 'anthropic', defaultModelId: 'claude-sonnet-4-6' }],
    } as any);
    const send = async (textInput: string) => {
      for await (const chunk of os.processRequest({ userId: 'u', sessionId: 'runtime-cache', selectedPersonaId: 'cached-runtime',
        textInput, options: { customFlags: { mode: 'general' } } } as any)) void chunk;
    };
    try {
      await send('Hello.');
      await send('Hello again.');
      await send('Give me a deep dive on the architecture trade-off.');
      const turns = bodies.filter((body) => JSON.stringify(body.system ?? '').includes('Host policy.'));
      expect(turns).toHaveLength(3);
      const [, second, third] = turns;
      for (const body of [second, third]) {
        expect(Array.isArray(body.system), 'the full runtime sends system blocks').toBe(true);
        expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
        expect(body.system[0].text).not.toContain('Meta-Preset');
      }
      expect(second.system[0]).toEqual(third.system[0]);
      expect(JSON.stringify(second.tools)).toBe(JSON.stringify(third.tools));
      expect(second.tools.map((tool: Json) => tool.name)).toContain('getCurrentDateTime');
      expect(systemTextOf([{ role: 'system', content: second.system }])).toContain('Meta-Preset: Concise');
      expect(systemTextOf([{ role: 'system', content: third.system }])).toContain('Meta-Preset: Deep Dive');
    } finally {
      await os.shutdown();
    }
  });
});
