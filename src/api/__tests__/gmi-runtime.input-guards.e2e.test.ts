/**
 * The `guards` option on the GMI runtime, end to end over the real agent, GMI, provider manager, completion gateway,
 * session store and a souled agent's memory store; only the provider class is stubbed (helpers/stubProviders.ts), at
 * its module boundary.
 *
 * - `guards` with `stages: ['input']` is enforced on a session's `send()` and `stream()` and on the agent's
 *   `generate()` and `stream()`: the user's turn is judged once the turn holds the session's lock, before any model
 *   call. A block stops the turn and nothing is sent, kept or filed; a sanitiser's text is what the model, the history
 *   and memory get; a replacement is the reply, with no model call and no history.
 * - Any other stage, and no `stages`, stays refused on the GMI runtime before any turn starts.
 * - A guard that throws follows its posture: closed by default, open with `failClosed: false`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agent, type Agent, type AgentOptions } from '../agent';
import { souledAgent } from '../souledAgent';
import { GuardrailStopError } from '../errors';
import type { StreamPart } from '../streamText';
import { inputDecisionOf, type TextGuardrailReport } from '../runtime/textGuardrails';
import type { Brain } from '../../cognition/memory/retrieval/store/Brain';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { GuardrailAction, type GuardrailConfig, type GuardrailContext, type IGuardrailService } from '../../safety/guardrails/IGuardrailService';
import { reply, script } from './helpers/stubProviders';

/** The runtime every agent of this file runs on. */
const RUNTIME = 'gmi' as const;

let n = 0;
const key = () => `k-input-guards-${++n}`;
const base = (apiKey: string, extra: Record<string, unknown> = {}) =>
  ({ runtime: RUNTIME, provider: 'openai', model: 'stub-model', apiKey, fallbackProviders: [], instructions: 'Be brief.', ...extra }) as unknown as AgentOptions;

const context: GuardrailContext = { userId: 'user-1', sessionId: 'session-1' };
/** Guards that run the input stage alone. */
const inputOnly = (...services: IGuardrailService[]) => ({ services, context, stages: ['input'] as const });

const ORIGINAL = 'my number is 555 0100';
const SANITISED = 'my number is [removed]';
const REPLACEMENT = 'Here is who can help.';
const blocksInput: IGuardrailService = { id: 'in', evaluateInput: async () => ({ action: GuardrailAction.BLOCK, reasonCode: 'RULE_IN', reason: 'the guard said why' }) };
const sanitisesInput: IGuardrailService = { id: 'san', config: { canSanitize: true }, evaluateInput: async () => ({ action: GuardrailAction.SANITIZE, modifiedText: SANITISED }) };
const replacesInput: IGuardrailService = { id: 'rep', evaluateInput: async () => ({ action: GuardrailAction.BLOCK, reasonCode: 'RULE_IN', replacementText: REPLACEMENT }) };
const throwsInput = (config: GuardrailConfig = {}): IGuardrailService => ({
  id: 'down',
  config,
  evaluateInput: async () => {
    throw new Error('the guard is down');
  },
});

async function collect(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

/** The four calls of a GMI agent that take `guards`. */
const SURFACES = ['session.send', 'session.stream', 'generate', 'stream'] as const;
type Surface = (typeof SURFACES)[number];
const SESSION = 'guarded';

/** One call through `surface`: its text, its error and its report, as a send rejects or a stream ends. */
async function call(a: Agent, surface: Surface, input: string, guards: unknown): Promise<{ text: string; error?: unknown; report?: TextGuardrailReport }> {
  if (surface === 'session.send' || surface === 'generate') {
    try {
      const result = surface === 'generate' ? await a.generate(input, { guards } as never) : await a.session(SESSION).send(input, { guards } as never);
      return { text: result.text, report: result.guardReport };
    } catch (error) {
      return { text: '', error };
    }
  }
  const result = surface === 'stream' ? a.stream(input, { guards } as never) : a.session(SESSION).stream(input, { guards } as never);
  const parts = await collect(result.fullStream);
  return { text: await result.text, error: parts.find((part) => part.type === 'error')?.error, report: await result.guardReport };
}
const holdsHistory = (surface: Surface) => surface.startsWith('session.');

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(SURFACES)("guards with stages: ['input'] through %s on the GMI runtime", (surface) => {
  it('an input guard that blocks stops the turn before any model call', async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Answered.')] });
    const a = agent(base(k));
    try {
      const { error, text } = await call(a, surface, ORIGINAL, inputOnly(blocksInput));
      expect(error).toBeInstanceOf(GuardrailStopError);
      expect(error).toMatchObject({ code: 'GUARDRAIL_BLOCKED', stage: 'input', reasonCode: 'RULE_IN', guardrailId: 'in', report: { mode: 'enforce', result: 'stopped' } });
      expect(JSON.stringify((error as GuardrailStopError).report)).not.toContain('555 0100');
      expect(text).toBe('');
      expect(s.seen).toEqual([]);
      if (holdsHistory(surface)) {
        expect(a.session(SESSION).messages()).toEqual([]);
        // The session serves the next turn, which carries nothing of the stopped one.
        await expect(a.session(SESSION).send('hello')).resolves.toMatchObject({ text: 'Answered.' });
        expect(JSON.stringify(s.seen)).not.toContain('555 0100');
      }
    } finally {
      await a.close();
    }
  });

  it('an input guard that sanitises changes what the model, the history and the memory provider get', async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Noted.')] });
    const getContext = vi.fn(async (_text: string) => null);
    const observe = vi.fn(async (_role: 'user' | 'assistant', _text: string, _context?: unknown) => undefined);
    const a = agent(base(k, { memoryProvider: { getContext, observe } }));
    try {
      const { error, text, report } = await call(a, surface, ORIGINAL, inputOnly(sanitisesInput));
      expect(error).toBeUndefined();
      expect(text).toBe('Noted.');
      expect(s.seen).toHaveLength(1);
      expect(JSON.stringify(s.seen[0].messages)).toContain(SANITISED);
      expect(JSON.stringify(s.seen)).not.toContain('555 0100');
      expect(inputDecisionOf(report)).toBe('sanitized');
      expect(report).toMatchObject({ mode: 'enforce', result: 'sanitized' });
      expect(getContext.mock.calls.map(([recalled]) => recalled)).toEqual([SANITISED]);
      if (holdsHistory(surface)) {
        expect(a.session(SESSION).messages()[0]).toEqual({ role: 'user', content: SANITISED });
        await vi.waitFor(() => expect(observe).toHaveBeenCalledWith('user', SANITISED, expect.anything()));
      }
      expect(JSON.stringify(observe.mock.calls)).not.toContain('555 0100');
    } finally {
      await a.close();
    }
  });

  it('an input guard that replaces answers with no model call and no history', async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Answered.')] });
    const observe = vi.fn(async (_role: 'user' | 'assistant', _text: string, _context?: unknown) => undefined);
    const a = agent(base(k, { memoryProvider: { observe } }));
    try {
      const { error, text, report } = await call(a, surface, 'a refused prompt', inputOnly(replacesInput));
      expect(error).toBeUndefined();
      expect(text).toBe(REPLACEMENT);
      expect(inputDecisionOf(report)).toBe('replaced');
      expect(report).toMatchObject({ result: 'replaced' });
      expect(s.seen).toEqual([]);
      expect(observe).not.toHaveBeenCalled();
      if (holdsHistory(surface)) {
        expect(a.session(SESSION).messages()).toEqual([]);
        await a.session(SESSION).send('And again?');
        expect(JSON.stringify(s.seen[0].messages)).not.toContain('refused prompt');
        expect(JSON.stringify(s.seen[0].messages)).not.toContain(REPLACEMENT);
      }
    } finally {
      await a.close();
    }
  });
});

describe('a replaced send on the GMI runtime', () => {
  it('reports no usage, no tool calls and an empty transcript delta', async () => {
    const k = key();
    script('openai', k, { replies: [] });
    const a = agent(base(k));
    try {
      const result = await a.session('replaced').send('a refused prompt', { guards: inputOnly(replacesInput) });
      expect(result).toMatchObject({ text: REPLACEMENT, toolCalls: [], finishReason: 'stop', transcriptDelta: [] });
      expect(result.usage.totalTokens).toBe(0);
    } finally {
      await a.close();
    }
  });
});

describe('any other stage stays refused on the GMI runtime', () => {
  const refused: Array<[string, readonly string[] | undefined]> = [
    ["['input', 'output']", ['input', 'output']],
    ["['output']", ['output']],
    ["['toolCalls']", ['toolCalls']],
    ['[]', []],
    ['no stages', undefined],
  ];
  it.each(refused)('guards with %s throw from every call before any turn', async (_label, stages) => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Unguarded.')] });
    const a = agent(base(k));
    try {
      const guards = { services: [blocksInput], context, ...(stages ? { stages } : {}) };
      const session = a.session('refused');
      await expect(session.send('hi', { guards } as never)).rejects.toThrow("the per-call option 'guards'");
      expect(() => session.stream('hi', { guards } as never)).toThrow("the per-call option 'guards'");
      await expect(a.generate('hi', { guards } as never)).rejects.toThrow("the per-call option 'guards'");
      expect(() => a.stream('hi', { guards } as never)).toThrow("the per-call option 'guards'");
      expect(s.seen).toEqual([]);
      expect(session.messages()).toEqual([]);
    } finally {
      await a.close();
    }
  });
});

describe('a guard that throws on the GMI runtime', () => {
  it('follows its posture: closed by default, so the turn rejects and nothing is sent; open with failClosed: false', async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Ran.')] });
    const a = agent(base(k));
    try {
      const session = a.session('posture');
      const closed = await session.send('hi', { guards: inputOnly(throwsInput()) }).catch((e: unknown) => e);
      expect(closed).toBeInstanceOf(GuardrailStopError);
      expect(closed).toMatchObject({ code: 'GUARDRAIL_UNAVAILABLE', stage: 'input' });
      expect(s.seen).toEqual([]);
      expect(session.messages()).toEqual([]);

      const open = await session.send('hi', { guards: inputOnly(throwsInput({ failClosed: false })) });
      expect(open.text).toBe('Ran.');
      expect(s.seen).toHaveLength(1);
    } finally {
      await a.close();
    }
  });
});

describe('a souled agent with cognitive memory off on the GMI runtime', () => {
  let dir: string;
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmi-input-guards-'));
    fs.writeFileSync(path.join(dir, 'SOUL.md'), '---\nname: Aria\nagentId: aria-1\n---\nYou are Aria.');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  type Souled = Awaited<ReturnType<typeof souledAgent>>;
  const brainOf = (a: Souled): Brain => (a.memory as unknown as { _brain: Brain })._brain;
  /** How many of the store's traces hold `words`. */
  async function tracesHolding(a: Souled, words: string): Promise<number> {
    const brain = brainOf(a);
    const row = await brain.get<{ n: number | string }>('SELECT count(*) AS n FROM memory_traces WHERE brain_id = ? AND content LIKE ?', [brain.brainId, `%${words}%`]);
    return Number(row?.n ?? 0);
  }
  /** Waits until the store holds a trace of `words`: a turn never waits for its memory writes. */
  const stored = (a: Souled, words: string) => vi.waitFor(async () => expect(await tracesHolding(a, words)).toBeGreaterThanOrEqual(1), { timeout: 4_000 });

  it('files nothing of a blocked or replaced turn, and the sanitised text of a sanitised one', async () => {
    const k = key();
    const s = script('openai', k, { whole: true, replies: Array.from({ length: 10 }, () => reply.text('Noted.')) });
    const a = await souledAgent({ runtime: RUNTIME, provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [], retention: { traces: 'until-deletion' }, soul: dir } as never);
    try {
      const session = a.session('s-1', { userId: 'alice' });
      await expect(session.send(`${ORIGINAL}, blocked`, { guards: inputOnly(blocksInput) })).rejects.toBeInstanceOf(GuardrailStopError);
      expect(s.seen).toEqual([]);
      expect(session.messages()).toEqual([]);
      await expect(session.send(`${ORIGINAL}, replaced`, { guards: inputOnly(replacesInput) })).resolves.toMatchObject({ text: REPLACEMENT });
      expect(s.seen).toEqual([]);

      await session.send(ORIGINAL, { guards: inputOnly(sanitisesInput) });
      await stored(a, SANITISED);
      // A later turn is filed too, so the absence below is read after the store took the writes that came before it.
      await session.send('Thanks.');
      await stored(a, 'Thanks.');
      expect(await tracesHolding(a, '555 0100')).toBe(0);
      expect(await tracesHolding(a, REPLACEMENT)).toBe(0);
      expect(JSON.stringify(s.seen)).not.toContain('555 0100');
    } finally {
      await a.close();
    }
  });
});
