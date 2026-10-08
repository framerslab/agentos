/**
 * agent({ runtime: 'gmi' }) end to end: what agent() does for a caller and the
 * GMI path has to keep doing. `memoryProvider.observe` runs on the provider and
 * never fails the turn it follows, the request names no user message after the
 * session, and a turn's user message stays in the history with the reply it
 * got. Runs over the real provider manager, completion gateway, GMI, tool
 * orchestrator and session store; only the provider classes are stubbed
 * (helpers/stubProviders.ts), at their module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async () => ({ AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic') }));
import { z } from 'zod';
import { agent, type AgentOptions } from '../agent';
import { ObjectGenerationError } from '../generateObject';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-parity-${++n}`;
const base = (apiKey: string, extra: Record<string, unknown> = {}) =>
  ({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey, fallbackProviders: [], ...extra }) as unknown as AgentOptions;
const lookupTool = (execute: (args: Record<string, unknown>) => Promise<unknown>) => ({ name: 'lookup', description: 'Look up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, execute });

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("agent({ runtime: 'gmi' }) keeps what agent() does", () => {
  it('memoryProvider.observe runs on the provider, so a provider built from a class records the turn', async () => {
    class NotesMemory {
      notes: string[] = [];
      async getContext(): Promise<{ contextText: string }> {
        return { contextText: this.notes.join('\n') };
      }
      async observe(role: 'user' | 'assistant', text: string): Promise<void> {
        this.notes.push(`${role}: ${text}`);
      }
    }
    const memory = new NotesMemory();
    const k = key(); script('openai', k, { replies: [reply.text('Noted.')] });
    await agent(base(k, { memoryProvider: memory })).session('s').send('I like tea');
    await vi.waitFor(() => expect(memory.notes).toEqual(['user: I like tea', 'assistant: Noted.']));
  });

  it('a memoryProvider.observe that throws does not fail the turn it follows', async () => {
    const k = key(); script('openai', k, { replies: [reply.text('Done.')] });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const observe = vi.fn((_role: string, _text: string): Promise<void> => {
      throw new Error('store offline');
    });
    const session = agent(base(k, { memoryProvider: { observe } })).session('s');
    expect((await session.send('hi')).text).toBe('Done.');
    expect(observe.mock.calls).toEqual([['user', 'hi'], ['assistant', 'Done.']]);
    expect(session.messages().map((m) => m.content)).toEqual(['hi', 'Done.']);
  });

  it("no user message is named after the session: a session id with a space in it reaches no provider's name field", async () => {
    const k = key(); const s = script('openai', k, { replies: [reply.tools([{ id: 'c1', name: 'lookup', args: { q: 'x' } }]), reply.text('Found x.')] });
    const session = agent(base(k, { tools: [lookupTool(async () => ({ success: true, output: 'x' }))] })).session('support chat 1');
    expect((await session.send('find x')).text).toBe('Found x.');
    // The second model call replays the turn's user message from the GMI's own history,
    // where the GMI names it after the turn's user: on this path, the session id.
    const users = s.seen[1].messages.filter((m) => m.role === 'user');
    expect(users.map((m) => m.content)).toEqual(['find x']);
    expect(users.map((m) => m.name)).toEqual([undefined]);
  });

  it('a step the store cannot keep (two calls under one id) does not cost the turn its user message', async () => {
    const k = key(); script('openai', k, { replies: [reply.tools([{ id: 'dup', name: 'lookup', args: { q: 'a' } }, { id: 'dup', name: 'lookup', args: { q: 'b' } }]), reply.text('Both looked up.')] });
    const execute = vi.fn(async (_args: Record<string, unknown>) => ({ success: true, output: 'ok' }));
    const session = agent(base(k, { tools: [lookupTool(execute)] })).session('s');
    expect((await session.send('look up a and b')).text).toBe('Both looked up.');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(session.messages()).toEqual([
      { role: 'user', content: 'look up a and b' },
      { role: 'assistant', content: 'Both looked up.' },
    ]);
  });

  it('a structured send whose answer does not parse or validate keeps nothing of the exchange, so a retry starts clean', async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Lyon'), reply.text('{"town":"Lyon"}'), reply.text('{"city":"Lyon"}')] });
    const observe = vi.fn(async (_role: 'user' | 'assistant', _text: string): Promise<void> => undefined);
    const session = agent(base(k, { memoryProvider: { observe } })).session('s');
    const schema = z.object({ city: z.string() });
    // Not JSON, then JSON the schema refuses: agent() parses before it appends, and appends nothing.
    await expect(session.send('where?', { responseSchema: schema })).rejects.toBeInstanceOf(ObjectGenerationError);
    await expect(session.send('where?', { responseSchema: schema })).rejects.toBeInstanceOf(ObjectGenerationError);
    expect(session.messages()).toEqual([]);
    expect(observe).not.toHaveBeenCalled();
    expect((await session.send('where?', { responseSchema: schema })).object).toEqual({ city: 'Lyon' });
    // The retry's request carries neither refused exchange.
    expect(s.seen[2].messages.filter((m) => m.role !== 'system').map((m) => m.content)).toEqual(['where?']);
    expect(session.messages().map((m) => m.content)).toEqual(['where?', '{"city":"Lyon"}']);
  });
});
