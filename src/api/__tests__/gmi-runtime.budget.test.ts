/**
 * A spend budget on the GMI path, end to end: gmi() with `budget` (the agent's, a call's, a send's), the completion
 * gateway's check before every step, the GMI provider manager's check before every metaprompt, and the charges the
 * turn runner records. Only the provider classes are stubbed (helpers/stubProviders.ts), at their module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
// The fallback hop's provider, stubbed as gmi-runtime.fallback.test.ts stubs it.
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async () => ({ AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic') }));
import { z } from 'zod';
import { gmi } from '../gmi';
import { agent } from '../agent';
import { SpendBudget, type SpendLimitInfo } from '../runtime/spendBudget';
import { GMIErrorCode } from '../../core/utils/errors';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-budget-${++n}`;
/** A reply whose usage is `total` tokens. */
const costly = (text: string, total: number) => reply.text(text, 'stub-model', { promptTokens: total - 50, completionTokens: 50, totalTokens: total });

/** A promise the test opens. */
function opening(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
/** A tool step whose usage is `total` tokens. */
const costlyTools = (calls: Parameters<typeof reply.tools>[0], total: number) => {
  const step = reply.tools(calls);
  Object.assign(step[step.length - 1], { usage: { promptTokens: total - 50, completionTokens: 50, totalTokens: total } });
  return step;
};

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('a spend budget on the GMI path', () => {
  it('gmi() takes a budget, and a step past it is refused before the provider is called', async () => {
    const k = key();
    const s = script('openai', k, { replies: [costly('One.', 2_950), reply.text('Two.')] });
    const budget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 3_000, unpriced: 'allow' });
    const a = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Answer.', maxTokens: 100, budget });
    const session = a.session('s1');

    await expect(session.send('First.')).resolves.toMatchObject({ text: 'One.' });
    expect(budget.tokensUsed()).toBe(2_950);
    // 2,950 counted: the next step's estimate (its prompt and its 100 output tokens) passes 3,000.
    await expect(session.send('Second.')).rejects.toMatchObject({ code: GMIErrorCode.LLM_PROVIDER_ERROR, message: expect.stringContaining('Token cap exceeded') });
    expect(s.seen).toHaveLength(1);
    // The session's stream is held to the agent's budget too: it ends with the refusal.
    const parts: Array<{ type: string; error?: unknown }> = [];
    for await (const part of session.stream('Third.').fullStream) parts.push(part);
    expect(parts.at(-1)).toMatchObject({ type: 'error', error: expect.objectContaining({ message: expect.stringContaining('Token cap exceeded') }) });
    expect(s.seen).toHaveLength(1);
  });

  it('a structured send is estimated without the tool definitions its requests leave out', async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('{"a":"x"}')] });
    // About 40,000 characters of tool definitions (about 10,000 tokens), in a parameter's description.
    const lookup = { description: 'Look up.', parameters: { type: 'object', properties: { q: { type: 'string', description: 'x'.repeat(40_000) } } }, execute: async () => 'found' };
    // The prompt and the 4,096-token output default fit 12,000 tokens; with the tool definitions they would not.
    const budget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 12_000, unpriced: 'allow' });
    const a = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Extract.', budget, tools: { lookup } });

    const result = await a.session('s1').send('Extract.', { responseSchema: z.object({ a: z.string() }) });
    expect(result.object).toEqual({ a: 'x' });
    // The request went without the tools, and its prompt is small.
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0].options.tools).toBeUndefined();
    expect(JSON.stringify(s.seen[0].messages).length).toBeLessThan(10_000);
  });

  it('a step after its turn was stopped in a tool round is not held to the budget: nothing is sent, and the turn ends stopped', async () => {
    const k = key();
    const s = script('openai', k, { replies: [costlyTools([{ id: 't1', name: 'wait', args: {} }], 2_950), reply.text('Unused.')] });
    const onLimitReached = vi.fn();
    const budget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 3_000, unpriced: 'allow', onLimitReached });
    const started = opening();
    const release = opening();
    const wait = {
      description: 'Wait.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        started.open();
        await release.promise;
        return 'done';
      },
    };
    const a = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Answer.', maxTokens: 100, budget, tools: { wait } });
    const session = a.session('s1');

    const outcome = session.send('Go.').then(() => 'resolved', (error: unknown) => error);
    await started.promise;
    // close() stops the turn while its tool runs; the next step's estimate would pass what the budget has left.
    const closing = session.close();
    release.open();
    expect(await outcome).toMatchObject({ code: GMIErrorCode.LLM_PROVIDER_ERROR, message: expect.stringMatching(/abort/i) });
    await closing;
    expect(onLimitReached).not.toHaveBeenCalled();
    expect(s.seen).toHaveLength(1);
  });

  it('a fallback hop is checked with the output cap it sends', async () => {
    const k = key();
    const fb = key();
    const primary = script('openai', k, { replies: [Object.assign(new Error('overloaded'), { httpStatus: 529 })] });
    const fallback = script('anthropic', fb, { replies: [reply.text('Unused.')] });
    vi.stubEnv('ANTHROPIC_API_KEY', fb);
    const budget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 3_000, unpriced: 'allow' });
    // The route's 100 output tokens fit the cap; the fallback hop sends 100 + 5,000 of headroom (fallbackHopOverrides).
    const a = gmi({
      provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Answer.', maxTokens: 100, budget,
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-x', maxTokensHeadroom: 5_000 }],
    });

    await expect(a.session('s1').send('Hi.')).rejects.toMatchObject({ code: GMIErrorCode.LLM_PROVIDER_ERROR, message: expect.stringContaining('Token cap exceeded') });
    // The primary's request went out and failed (the precondition); the fallback's was refused before it was sent.
    expect(primary.seen).toHaveLength(1);
    expect(fallback.seen).toHaveLength(0);
  });

  it('a billed failed attempt and an outside cost are charged to the budget', async () => {
    const k = key();
    const billedFailure = Object.assign(new Error('overloaded'), { httpStatus: 529, details: { usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 } } });
    script('openai', k, { replies: [reply.text('One.'), billedFailure] });
    const budget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 10_000, unpriced: 'allow' });
    const a = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Answer.', maxTokens: 100, fallbackProviders: [], budget });
    const session = a.session('s1');

    await session.send('First.');
    expect(budget.tokensUsed()).toBe(15);
    await expect(session.send('Second.')).rejects.toMatchObject({ code: GMIErrorCode.LLM_PROVIDER_ERROR });
    expect(budget.tokensUsed()).toBe(31);
    session.recordExternalCost(0.25, { kind: 'stt' });
    expect(budget.spentUSD()).toBeCloseTo(0.25);
  });

  it('generate() takes abortSignal and budget', async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Answer.')] });
    const agentBudget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 50, unpriced: 'allow' });
    const a = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Answer.', maxTokens: 100, budget: agentBudget });

    // A signal that has already aborted starts no turn.
    const stopped = new AbortController();
    stopped.abort(new Error('stopped by the caller'));
    await expect(a.generate('Hi.', { abortSignal: stopped.signal })).rejects.toThrow('stopped by the caller');
    expect(s.seen).toHaveLength(0);

    // A call's budget replaces the agent's, whose 50 tokens could not cover this call.
    const callBudget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 10_000, unpriced: 'allow' });
    await expect(a.generate('Hi.', { budget: callBudget })).resolves.toMatchObject({ text: 'Answer.' });
    expect([callBudget.tokensUsed(), agentBudget.tokensUsed()]).toEqual([15, 0]);

    // Without one the agent's applies.
    await expect(a.generate('Hi.')).rejects.toMatchObject({ code: GMIErrorCode.LLM_PROVIDER_ERROR });
    expect(s.seen).toHaveLength(1);
  });

  it("generate() and a session send reject with the reason of a signal that aborts after the turn's last request, and verify no citations", async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Answer.'), reply.text('Answer.')] });
    let stop = new AbortController();
    const retrieve = vi.fn(async () => [{ content: 'Answer.' }]);
    const embedFn = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const a = gmi({
      provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Answer.', maxTokens: 100,
      // The last step's hook runs after its request: the abort comes once nothing more is sent.
      onAfterGeneration: async () => {
        stop.abort(new Error('late stop'));
      },
      verifyCitations: { retrieve, embedFn },
    });

    await expect(a.generate('Hi.', { abortSignal: stop.signal })).rejects.toThrow('late stop');
    stop = new AbortController();
    await expect(a.session('s1').send('Hi.', { abortSignal: stop.signal })).rejects.toThrow('late stop');
    // Each request went out (the precondition), and no source was retrieved or embedded after the abort.
    expect(s.seen).toHaveLength(2);
    expect(retrieve).not.toHaveBeenCalled();
    expect(embedFn).not.toHaveBeenCalled();
  });

  it("a session send keeps its turn's own failure when the caller's signal aborts after it", async () => {
    const k = key();
    const s = script('openai', k, { replies: [costlyTools([{ id: 't1', name: 'lookup', args: {} }], 2_950), reply.text('Unused.')] });
    const budget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 3_000, unpriced: 'allow' });
    const lookup = { description: 'Look up.', parameters: { type: 'object', properties: {} }, execute: async () => 'found' };
    const a = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Answer.', maxTokens: 100, budget, tools: { lookup } });
    const stop = new AbortController();

    // The budget refuses the step after the tool round, which ends the turn. The turn hands over its usage once that
    // failure is recorded, before the send settles: the caller's signal aborts then.
    const options = { abortSignal: stop.signal, __onUsage: () => stop.abort(new Error('stopped late')) };
    await expect(a.session('s1').send('Go.', options as never)).rejects.toMatchObject({
      code: GMIErrorCode.LLM_PROVIDER_ERROR,
      message: expect.stringContaining('Token cap exceeded'),
    });
    expect(stop.signal.aborted).toBe(true);
    expect(s.seen).toHaveLength(1);
  });

  it("stream() and a session stream whose signal has already aborted start no turn: the one error part carries the signal's reason", async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Unused.')] });
    const getContext = vi.fn(async () => ({ contextText: 'Remembered.' }));
    const onBeforeGeneration = vi.fn(async () => undefined);
    const onLimitReached = vi.fn();
    const a = gmi({
      provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Answer.', maxTokens: 100,
      memoryProvider: { getContext },
      onBeforeGeneration,
      budget: new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 50, unpriced: 'allow', onLimitReached }),
    });
    const stopped = new AbortController();
    const reason = new Error('stopped');
    stopped.abort(reason);

    for (const result of [a.stream('Hi.', { abortSignal: stopped.signal }), a.session('s1').stream('Hi.', { abortSignal: stopped.signal })]) {
      const parts: Array<{ type: string; error?: unknown }> = [];
      for await (const part of result.fullStream) parts.push(part);
      expect(parts).toEqual([{ type: 'error', error: reason }]);
      await expect(result.text).resolves.toBe('');
    }
    // Nothing of a turn ran: no memory context, no hook, no budget check, no request.
    expect(getContext).not.toHaveBeenCalled();
    expect(onBeforeGeneration).not.toHaveBeenCalled();
    expect(onLimitReached).not.toHaveBeenCalled();
    expect(s.seen).toHaveLength(0);
  });

  it("a stream whose signal aborts mid-turn ends with the signal's reason in its error part, one-shot and in a session", async () => {
    const k = key();
    const never = opening();
    const delta = reply.text('Partial')[0];
    const s = script('openai', k, { replies: [reply.hold([delta], never.promise), reply.hold([delta], never.promise)] });
    const a = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Answer.', maxTokens: 100 });
    const session = a.session('s1');

    for (const [index, start] of [(signal: AbortSignal) => a.stream('Hi.', { abortSignal: signal }), (signal: AbortSignal) => session.stream('Hi.', { abortSignal: signal })].entries()) {
      const stop = new AbortController();
      const result = start(stop.signal);
      // The request is out and held: the abort comes during it.
      await vi.waitFor(() => expect(s.seen).toHaveLength(index + 1));
      const reason = new Error('custom stop');
      stop.abort(reason);
      const parts: Array<{ type: string; error?: unknown }> = [];
      for await (const part of result.fullStream) parts.push(part);
      expect(parts.at(-1)).toEqual({ type: 'error', error: reason });
      await expect(result.text).resolves.toBe('Partial');
    }
    expect(s.aborts).toBe(2);
  });

  it("stream() takes a call's budget in place of the agent's, and without one the agent's applies", async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Answer.'), reply.text('Unused.')] });
    const agentBudget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 50, unpriced: 'allow' });
    const a = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Answer.', maxTokens: 100, budget: agentBudget });

    const callBudget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 10_000, unpriced: 'allow' });
    // The turn runs whether or not its parts are read.
    await expect(a.stream('Hi.', { budget: callBudget }).text).resolves.toBe('Answer.');
    expect([callBudget.tokensUsed(), agentBudget.tokensUsed()]).toEqual([15, 0]);

    const parts: Array<{ type: string; error?: unknown }> = [];
    for await (const part of a.stream('Hi.').fullStream) parts.push(part);
    expect(parts.at(-1)).toMatchObject({ type: 'error', error: expect.objectContaining({ message: expect.stringContaining('Token cap exceeded') }) });
    expect(s.seen).toHaveLength(1);
  });

  it("generate() with a signal that has already aborted runs no hook, and one its signal stops before the request rejects with the signal's reason", async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Answer.'), reply.text('Unused.')] });
    let stopInHook: AbortController | undefined;
    const onBeforeGeneration = vi.fn(async () => {
      stopInHook?.abort(new Error('stopped in the hook'));
    });
    const a = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Answer.', maxTokens: 100, onBeforeGeneration });

    const stopped = new AbortController();
    stopped.abort(new Error('stopped by the caller'));
    await expect(a.generate('Hi.', { abortSignal: stopped.signal })).rejects.toThrow('stopped by the caller');
    expect(onBeforeGeneration).not.toHaveBeenCalled();
    await expect(a.generate('Hi.')).resolves.toMatchObject({ text: 'Answer.' });
    expect(onBeforeGeneration).toHaveBeenCalledTimes(1);

    // The signal aborts during the turn, before its request: nothing is sent, and the call rejects with the reason.
    stopInHook = new AbortController();
    await expect(a.generate('Hi.', { abortSignal: stopInHook.signal })).rejects.toThrow('stopped in the hook');
    expect(onBeforeGeneration).toHaveBeenCalledTimes(2);
    expect(s.seen).toHaveLength(1);
  });

  it("a budget bounds a GMI's metaprompt calls, and the turn's reply stands", async () => {
    const k = key();
    // `whole` answers a metaprompt's unstreamed request, should one be sent.
    const s = script('openai', k, { replies: [costly('I hear you.', 2_950), reply.text('{"mood":"calm"}')], whole: true });
    const refused: SpendLimitInfo[] = [];
    const budget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 3_000, unpriced: 'allow', onLimitReached: (info) => { refused.push(info); } });
    // The full profile tracks sentiment and runs the five preset metaprompts; a confused turn raises one, by its
    // confusion words ('confused', 'unclear', 'explain'), whatever score the sentiment lexicon gives the text.
    // memory: false: the full profile turns cognitive memory on, whose first build needs an embedding key this test does
    // not set (gmi-runtime.memory.test.ts pins that refusal); sentiment tracking and the metaprompts stay on.
    const a = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Help.', maxTokens: 100, cognition: 'full', memory: false, budget });

    const result = await a.session('s1').send('I am confused and this is unclear. Please explain it again.');
    expect(result.text).toBe('I hear you.');
    // The metaprompt runs after the turn, queued: its check refuses it before its request.
    const unstreamed = () => s.seen.filter((call) => !call.streamed);
    await vi.waitFor(() => expect(refused.map((info) => info.what), `metaprompt requests sent: ${unstreamed().length}`).toContain('gmi.metaprompt'));
    expect(unstreamed()).toEqual([]);
  });

  it('a queued metaprompt spends inside the budget of the turn that queued it, whenever it runs', async () => {
    const k = key();
    const firstMetaprompt = opening();
    const thirdTurn = opening();
    const s = script('openai', k, {
      whole: true,
      // In the order the requests arrive: turn 0, its metaprompt (held), turn 1, turn 2 (held), turn 1's metaprompt.
      replies: [
        reply.text('One.'),
        reply.hold(reply.text('{"mood":"calm"}'), firstMetaprompt.promise),
        reply.text('Two.'),
        reply.hold([], thirdTurn.promise, reply.text('Three.')),
        reply.text('{"mood":"calm"}'),
      ],
    });
    // Sentiment tracking with the confusion metaprompt alone: each confused turn raises one.
    const a = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Help.', maxTokens: 100, cognition: { sentiment: true, metaprompts: ['confusion_clarification'] }, memory: false });
    const session = a.session('s1');
    const unstreamed = () => s.seen.filter((call) => !call.streamed);

    await session.send('I am confused and this is unclear. Please explain it.');
    await vi.waitFor(() => expect(unstreamed()).toHaveLength(1));
    const first = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 10_000, unpriced: 'allow' });
    await session.send('I am still confused. Explain it again.', { budget: first });
    expect(first.tokensUsed()).toBe(15);
    // Turn 1's metaprompt waits behind turn 0's; turn 2 starts and holds its request.
    const third = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 10_000, unpriced: 'allow' });
    const thirdSent = session.send('Go on.', { budget: third });
    await vi.waitFor(() => expect(s.seen).toHaveLength(4));
    firstMetaprompt.open();
    // Turn 1's metaprompt runs while turn 2 runs, and its 15 tokens go to turn 1's budget.
    await vi.waitFor(() => expect(unstreamed()).toHaveLength(2));
    await vi.waitFor(() => expect(first.tokensUsed()).toBe(30));
    expect(third.tokensUsed()).toBe(0);
    thirdTurn.open();
    await expect(thirdSent).resolves.toMatchObject({ text: 'Three.' });
    await session.close();
  });

  it('a metaprompt its budget refuses is warned about, by its id and the refusal', async () => {
    const k = key();
    const s = script('openai', k, { replies: [costly('I hear you.', 2_950), reply.text('{"mood":"calm"}')], whole: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The default 'throw': no function hears of the refusal.
    const budget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 3_000, unpriced: 'allow' });
    const a = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Help.', maxTokens: 100, cognition: { sentiment: true, metaprompts: ['confusion_clarification'] }, memory: false, budget });

    await a.session('s1').send('I am confused and this is unclear. Please explain it again.');
    const lines = () => warn.mock.calls.map((call) => call.map(String).join(' '));
    await vi.waitFor(() => expect(lines()).toEqual(expect.arrayContaining([expect.stringMatching(/metaprompt 'gmi_confusion_clarification'.*Token cap exceeded/)])));
    expect(s.seen.filter((call) => !call.streamed)).toEqual([]);
  });

  it('a metaprompt answered inside its budget is charged what its answer used', async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('I hear you.'), reply.text('{"mood":"calm"}')], whole: true });
    const budget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 10_000, unpriced: 'allow' });
    const a = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Help.', maxTokens: 100, cognition: { sentiment: true, metaprompts: ['confusion_clarification'] }, memory: false, budget });

    await a.session('s1').send('I am confused and this is unclear. Please explain it again.');
    // The turn's 15 tokens, then the metaprompt's 15, which may already be in by the time the send returns.
    await vi.waitFor(() => expect(s.seen.filter((call) => !call.streamed)).toHaveLength(1));
    await vi.waitFor(() => expect(budget.tokensUsed()).toBe(30));
  });

  it('a session send takes a per-send budget, on the GMI engine and on the legacy one', async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Unused.')], whole: true });
    const tiny = () => new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 50, unpriced: 'allow' });
    const onGmi = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Answer.', maxTokens: 100 });
    await expect(onGmi.session('g').send('Hi.', { budget: tiny() })).rejects.toMatchObject({ code: GMIErrorCode.LLM_PROVIDER_ERROR, message: expect.stringContaining('Token cap exceeded') });
    const onLegacy = agent({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Answer.', maxTokens: 100 });
    await expect(onLegacy.session('l').send('Hi.', { budget: tiny() })).rejects.toThrow(/Token cap exceeded/);
    expect(s.seen).toHaveLength(0);
  });

  it('a session stream takes a per-stream budget, on the GMI engine and on the legacy one', async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Unused.')], whole: true });
    const tiny = () => new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 50, unpriced: 'allow' });
    const onGmi = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Answer.', maxTokens: 100 });
    const onLegacy = agent({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Answer.', maxTokens: 100 });

    for (const result of [onGmi.session('g').stream('Hi.', { budget: tiny() }), onLegacy.session('l').stream('Hi.', { budget: tiny() })]) {
      const parts: Array<{ type: string; error?: unknown }> = [];
      for await (const part of result.fullStream) parts.push(part);
      expect(parts.at(-1)).toMatchObject({ type: 'error', error: expect.objectContaining({ message: expect.stringContaining('Token cap exceeded') }) });
    }
    expect(s.seen).toHaveLength(0);
  });

  it("a legacy agent's generate() holds the budget its settings make across the validation retries of the call", async () => {
    const k = key();
    // Three answers that do not parse, 900 tokens each: the second attempt's estimate passes what the first left.
    const s = script('openai', k, { replies: [costly('not json', 900), costly('still not json', 900), costly('nope', 900)], whole: true });
    const a = agent({
      provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Answer in JSON.', maxTokens: 100,
      responseSchema: z.object({ a: z.string() }),
      controls: { maxValidationRetries: 2 },
    });

    await expect(a.generate('x', { budget: { maxCostUSD: 1, maxTotalTokens: 1_000, unpriced: 'allow' } })).rejects.toThrow(/Token cap exceeded/);
    expect(s.seen).toHaveLength(1);
  });

  it("a tool call that fails inside the tool executor's pipeline tells the model what failed, without the calling turn's live objects", async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.tools([{ id: 't1', name: 'lookup', args: {} }]), reply.text('Done.')] });
    const budget = new SpendBudget({ maxCostUSD: 1, unpriced: 'allow' });
    // A capability list written as one string: the executor's capability check throws outside the tool's own catches.
    const lookup = {
      name: 'lookup',
      description: 'Look up.',
      inputSchema: { type: 'object', properties: {} },
      requiredCapabilities: 'search' as unknown as string[],
      execute: async () => ({ success: true, output: 'found' }),
    };
    const a = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Answer.', maxTokens: 100, budget, tools: [lookup] });

    await expect(a.session('s1').send('Look it up.')).resolves.toMatchObject({ text: 'Done.' });
    const toolMessages = JSON.stringify(s.seen[1].messages.filter((message) => message.role === 'tool'));
    // The precondition: the pipeline's failure reached the model.
    expect(toolMessages).toContain('internal pipeline');
    expect(toolMessages).not.toContain('callerTurn');
    expect(toolMessages).not.toContain(budget.id);
  });
});
