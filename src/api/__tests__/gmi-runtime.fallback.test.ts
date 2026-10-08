/**
 * agent({ runtime: 'gmi' }) end to end: model fallback inside a GMI turn, over
 * the real provider manager, completion gateway, GMI, prompt engine and session
 * store. Only the provider classes are stubbed (helpers/stubProviders.ts), at
 * their module boundary; each test scripts its providers under keys of its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async () => ({ AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic') }));
import { agent } from '../agent';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { GMIErrorCode } from '../../core/utils/errors';

let n = 0;
const key = () => `k-fallback-${++n}`;
const overloaded = () => Object.assign(new Error('overloaded'), { httpStatus: 529 });
const lookup = (output: unknown) => ({ name: 'lookup', description: 'x', inputSchema: { type: 'object' }, execute: async () => ({ success: true, output }) });

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("agent({ runtime: 'gmi' }) fallback", () => {
  it('a primary that fails to initialise falls through to the fallback, which the result names', async () => {
    const k = key(); const fb = key();
    script('anthropic', k, { initThrows: Object.assign(new Error('401 invalid key'), { httpStatus: 401 }) });
    script('openai', fb, { replies: [reply.text('From the fallback.')] });
    vi.stubEnv('OPENAI_API_KEY', fb);
    const r = await agent({ runtime: 'gmi', provider: 'anthropic', model: 'claude-x', apiKey: k, fallbackProviders: [{ provider: 'openai', model: 'stub-model' }] }).session('s').send('hi');
    expect(r).toMatchObject({ text: 'From the fallback.', provider: 'openai' });
  });

  it('a fallback with a smaller window gets a prompt rebuilt within it', async () => {
    const k = key(); const fb = key();
    script('openai', k, { window: 128_000, replies: [overloaded()] });
    const small = script('anthropic', fb, { window: 2_000, replies: [reply.text('Short.')] });
    vi.stubEnv('ANTHROPIC_API_KEY', fb);
    const session = agent({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [{ provider: 'anthropic', model: 'claude-x' }] }).session('s');
    for (let i = 0; i < 3; i++) session.reseed([...session.messages(), { role: 'user', content: `note ${i} ` + 'x '.repeat(4000) }, { role: 'assistant', content: 'ok' }] as never);
    expect((await session.send('now')).text).toBe('Short.');
    // The stub has no tokenizer: four characters a token, the prompt engine's own estimate.
    const chars = JSON.stringify(small.seen[0].messages).length;
    expect(chars).toBeLessThan(2_000 * 4);
  });

  it('step 0 on Anthropic with a tool call, step 1 on OpenAI after Anthropic fails: the history reaches OpenAI in its own format', async () => {
    const k = key(); const fb = key();
    script('anthropic', k, { replies: [reply.tools([{ id: 'c1', name: 'lookup', args: { q: 'a' } }]), overloaded()] });
    const oa = script('openai', fb, { replies: [reply.text('Done.')] });
    vi.stubEnv('OPENAI_API_KEY', fb);
    const r = await agent({ runtime: 'gmi', provider: 'anthropic', model: 'claude-x', apiKey: k, fallbackProviders: [{ provider: 'openai', model: 'stub-model' }], tools: [lookup('A')] }).session('s').send('go');
    expect(r.text).toBe('Done.');
    const msgs = oa.seen[0].messages;
    expect(msgs.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'c1')).toBe(true);
    expect(msgs.some((m) => m.role === 'tool' && m.tool_call_id === 'c1')).toBe(true);
  });

  it('a tool runs in step 0 and step 1 fails with the chain exhausted: send rejects with the GMI code and messages() keeps step 0 marked partial', async () => {
    const k = key();
    script('openai', k, { replies: [reply.tools([{ id: 'c1', name: 'lookup', args: {} }]), overloaded()] });
    const execute = vi.fn(async () => ({ success: true, output: 1 }));
    const session = agent({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [], tools: [{ ...lookup(1), execute }] }).session('s');
    await expect(session.send('go')).rejects.toMatchObject({ code: GMIErrorCode.LLM_PROVIDER_ERROR });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(session.messages().map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(session.messages().at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1', partial: true });
  });

  it('a provider that throws after the first delta: stream text resolves partial and fullStream ends with error', async () => {
    const k = key(); script('openai', k, { replies: [reply.breakAfterFirstDelta('Part')] });
    const r = agent({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [] }).session('s').stream('go');
    const types: string[] = [];
    for await (const p of r.fullStream) types.push(p.type);
    expect(types).toEqual(['text', 'error']);
    expect(await r.text).toBe('Part');
  });

  it('a step that fails after output still counts what the provider billed: stream usage and session.usage() report it', async () => {
    const k = key();
    const billed = { promptTokens: 12, completionTokens: 4, totalTokens: 16 };
    script('openai', k, { replies: [reply.textThenThrow('Sure, here', Object.assign(new Error('refused'), { details: { usage: billed } }))] });
    const session = agent({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [] }).session('s');
    const r = session.stream('go');
    expect(await r.text).toBe('Sure, here');
    expect(await r.finishReason).toBe('error');
    expect(await r.usage).toMatchObject(billed);
    expect((await session.usage()).totalTokens).toBe(16);
  });

  it('after a fallback inside a turn, the next step stays on the fallback; the next user turn starts at the primary', async () => {
    const k = key(); const fb = key();
    const an = script('anthropic', k, { replies: [overloaded(), reply.text('Back on primary.')] });
    const oa = script('openai', fb, { replies: [reply.tools([{ id: 'c1', name: 'lookup', args: {} }]), reply.text('Step one on fallback.')] });
    vi.stubEnv('OPENAI_API_KEY', fb);
    const session = agent({ runtime: 'gmi', provider: 'anthropic', model: 'claude-x', apiKey: k, fallbackProviders: [{ provider: 'openai', model: 'stub-model' }], tools: [lookup(1)] }).session('s');
    const first = await session.send('turn one');
    expect(first).toMatchObject({ text: 'Step one on fallback.', provider: 'openai' });
    expect(oa.seen.length).toBe(2);
    expect(an.seen.length).toBe(1);
    // The primary's failure opened no lasting verdict for this test: the next turn may try it.
    globalLLMProviderHealth.reset();
    const second = await session.send('turn two');
    expect(second).toMatchObject({ text: 'Back on primary.', provider: 'anthropic' });
    expect(an.seen.length).toBe(2);
  });
});
