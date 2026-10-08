/**
 * Folding a GMI turn's chunks into the result shapes of generateText and
 * streamText (send() and stream() on the GMI path).
 */
import { describe, expect, it } from 'vitest';
import { GmiTurnFolder, streamFromGmiTurn } from '../gmiResults.js';
import { GMIOutputChunkType, type GMIOutputChunk } from '../../../cognition/substrate/IGMI';
import { GMIError } from '../../../core/utils/errors';

const c = (type: GMIOutputChunkType, content: unknown, extras: Partial<GMIOutputChunk> = {}): GMIOutputChunk => ({ type, content, interactionId: 'i', timestamp: new Date(), ...extras });
const step = (stepIndex: number, text: string, finishReason: string, usage?: Record<string, number>, extra: Record<string, unknown> = {}) =>
  c(GMIOutputChunkType.STEP_FINISHED, { stepIndex, text, finishReason, providerId: 'openai', modelId: 'gpt-4o', hop: 0, ...(usage ? { usage } : {}), ...extra });
const u = (p: number, q: number) => ({ promptTokens: p, completionTokens: q, totalTokens: p + q });
const gmiError = (message: string, code: string) => c(GMIOutputChunkType.ERROR, message, { errorDetails: { name: 'GMIError', message, code, details: { hop: 0 } } });

/** Yields `chunks`, throwing before chunk `throwAt` (after the last one when `throwAt` is the length). */
async function* from(chunks: GMIOutputChunk[], throwAt?: number) {
  for (let i = 0; i < chunks.length; i++) {
    if (i === throwAt) throw new Error('stream broke');
    yield chunks[i];
  }
  if (throwAt !== undefined && throwAt >= chunks.length) throw new Error('stream broke');
}

const preambleToolAnswer = [
  c(GMIOutputChunkType.TEXT_DELTA, 'Let me check.'),
  c(GMIOutputChunkType.TOOL_CALL_REQUEST, [{ id: 'c1', name: 'lookup', arguments: { q: 'a' } }]),
  step(0, 'Let me check.', 'tool_calls', u(10, 2)),
  c(GMIOutputChunkType.TOOL_RESULT, { toolCallId: 'c1', name: 'lookup', result: { ok: true }, isError: false }),
  c(GMIOutputChunkType.TEXT_DELTA, 'Found it.'),
  step(1, 'Found it.', 'stop', u(20, 3), { responseModel: 'gpt-4o-2024', providerMessageId: 'msg_2' }),
];

describe('GmiTurnFolder', () => {
  it('text only', () => {
    const f = new GmiTurnFolder();
    [c(GMIOutputChunkType.TEXT_DELTA, 'Hi.'), step(0, 'Hi.', 'stop', u(5, 1))].forEach((x) => f.push(x));
    expect(f.toGenerateTextResult()).toMatchObject({ text: 'Hi.', finishReason: 'stop', provider: 'openai', model: 'gpt-4o', usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 }, toolCalls: [] });
  });

  it('preamble, tool step, answer: text is the answer, tool calls carry results, usage sums the steps', () => {
    const f = new GmiTurnFolder();
    preambleToolAnswer.forEach((x) => f.push(x));
    expect(f.toGenerateTextResult()).toMatchObject({
      text: 'Found it.', finishReason: 'stop', responseModel: 'gpt-4o-2024', providerMessageId: 'msg_2',
      usage: { promptTokens: 30, completionTokens: 5, totalTokens: 35 },
      toolCalls: [{ name: 'lookup', args: { q: 'a' }, result: { ok: true } }],
    });
  });

  it('counts each step once: running USAGE_UPDATE totals are not added', () => {
    const f = new GmiTurnFolder();
    [c(GMIOutputChunkType.USAGE_UPDATE, u(5, 0)), c(GMIOutputChunkType.USAGE_UPDATE, u(5, 1)), step(0, 'Hi.', 'stop', u(5, 1))].forEach((x) => f.push(x));
    expect(f.usage()).toEqual({ promptTokens: 5, completionTokens: 1, totalTokens: 6 });
  });

  it("adds a failed attempt's billed usage, reported on its own USAGE_UPDATE, to the turn", () => {
    const f = new GmiTurnFolder();
    f.push(c(GMIOutputChunkType.USAGE_UPDATE, u(40, 0), { metadata: { attemptFailed: true, hop: 0, providerId: 'anthropic', modelId: 'claude-x' } }));
    f.push(step(0, 'From the fallback.', 'stop', u(12, 3)));
    expect(f.toGenerateTextResult().usage).toEqual({ promptTokens: 52, completionTokens: 3, totalTokens: 55 });
    expect(f.failedAttempts()).toEqual([{ providerId: 'anthropic', modelId: 'claude-x', usage: u(40, 0) }]);
  });

  it('outstanding tool calls and no text end as tool-calls, as streamText reports', () => {
    const f = new GmiTurnFolder();
    [c(GMIOutputChunkType.TOOL_CALL_REQUEST, [{ id: 'c1', name: 'lookup', arguments: {} }]), step(0, '', 'tool_calls'), c(GMIOutputChunkType.TOOL_RESULT, { toolCallId: 'c1', name: 'lookup', result: 1, isError: false })].forEach((x) => f.push(x));
    expect(f.toGenerateTextResult().finishReason).toBe('tool-calls');
  });

  it('a structured step: text is the JSON string, the object is exposed, the turn ends with stop', () => {
    const f = new GmiTurnFolder();
    f.push(c(GMIOutputChunkType.TEXT_DELTA, 'Here you go.'));
    f.push(step(0, 'Here you go.', 'tool_use', undefined, { structuredOutput: { city: 'Lyon' } }));
    expect(f.toGenerateTextResult()).toMatchObject({ text: '{"city":"Lyon"}', finishReason: 'stop' });
    expect(f.structuredOutput()).toEqual({ city: 'Lyon' });
  });

  it('an error chunk makes the turn an error that keeps the GMI code', () => {
    const f = new GmiTurnFolder();
    [c(GMIOutputChunkType.TEXT_DELTA, 'Partial'), gmiError('LLM stream error: reset', 'LLM_PROVIDER_ERROR')].forEach((x) => f.push(x));
    expect(f.error()).toMatchObject({ code: 'LLM_PROVIDER_ERROR', message: 'LLM stream error: reset' });
    expect(f.toGenerateTextResult().finishReason).toBe('error');
    const thrown = f.toError();
    expect(thrown).toBeInstanceOf(GMIError);
    expect(thrown).toMatchObject({ code: 'LLM_PROVIDER_ERROR', details: { hop: 0 } });
  });

  it('onAfterGeneration overrides replace a step text', () => {
    const f = new GmiTurnFolder();
    [c(GMIOutputChunkType.TEXT_DELTA, 'raw'), step(0, 'raw', 'stop')].forEach((x) => f.push(x));
    f.overrideStepText(0, 'clean');
    expect(f.toGenerateTextResult().text).toBe('clean');
  });

  it('a call id reused by a later step keeps its own result', () => {
    const f = new GmiTurnFolder();
    [
      c(GMIOutputChunkType.TOOL_CALL_REQUEST, [{ id: 'call_0', name: 'lookup', arguments: { q: 'a' } }]),
      step(0, '', 'tool_calls'),
      c(GMIOutputChunkType.TOOL_RESULT, { toolCallId: 'call_0', name: 'lookup', result: 'A', isError: false }),
      c(GMIOutputChunkType.TOOL_CALL_REQUEST, [{ id: 'call_0', name: 'lookup', arguments: { q: 'b' } }]),
      step(1, '', 'tool_calls'),
      c(GMIOutputChunkType.TOOL_RESULT, { toolCallId: 'call_0', name: 'lookup', result: undefined, isError: true, errorDetails: { message: 'B failed' } }),
      step(2, 'Done.', 'stop'),
    ].forEach((x) => f.push(x));
    expect(f.toolCalls()).toEqual([
      { name: 'lookup', args: { q: 'a' }, result: 'A' },
      { name: 'lookup', args: { q: 'b' }, error: 'B failed' },
    ]);
  });
});

describe('streamFromGmiTurn', () => {
  it('textStream carries each delta once; fullStream maps tool parts; promises resolve', async () => {
    const r = streamFromGmiTurn(from(preambleToolAnswer));
    const texts: string[] = [];
    for await (const t of r.textStream) texts.push(t);
    const parts: string[] = [];
    for await (const p of r.fullStream) parts.push(p.type);
    expect(texts).toEqual(['Let me check.', 'Found it.']);
    expect(parts).toEqual(['text', 'tool-call', 'tool-result', 'text']);
    expect(await r.text).toBe('Found it.');
    expect((await r.usage).totalTokens).toBe(35);
    expect(await r.finishReason).toBe('stop');
    expect(await r.provider).toBe('openai');
    expect(await r.responseModel).toBe('gpt-4o-2024');
  });

  it('an error after delivery: text resolves with the partial text and fullStream ends with error', async () => {
    const r = streamFromGmiTurn(from([c(GMIOutputChunkType.TEXT_DELTA, 'Partial')], 1));
    const parts: string[] = [];
    for await (const p of r.fullStream) parts.push(p.type);
    expect(parts).toEqual(['text', 'error']);
    expect(await r.text).toBe('Partial');
    expect(await r.finishReason).toBe('error');
  });

  it('an in-band error after a finished step: text is what the failed step delivered, the error part keeps the code', async () => {
    const r = streamFromGmiTurn(from([
      ...preambleToolAnswer.slice(0, 4),
      c(GMIOutputChunkType.TEXT_DELTA, 'Fou'),
      gmiError('LLM stream error: reset', 'LLM_PROVIDER_ERROR'),
    ]));
    const parts: Array<{ type: string; error?: unknown }> = [];
    for await (const p of r.fullStream) parts.push(p);
    expect(parts.at(-1)?.error).toMatchObject({ code: 'LLM_PROVIDER_ERROR' });
    expect(await r.text).toBe('Fou');
    expect(await r.finishReason).toBe('error');
  });

  it('every promise settles when the consumer abandons iteration', async () => {
    const r = streamFromGmiTurn(from(preambleToolAnswer));
    for await (const _t of r.textStream) break;
    await expect(Promise.all([r.text, r.usage, r.toolCalls, r.finishReason, r.provider, r.model, r.responseModel, r.serviceTier, r.cacheDiagnostics, r.providerMessageId])).resolves.toBeDefined();
  });

  it('a folder supplied by the caller is used as is: its text overrides reach text', async () => {
    const folder = new GmiTurnFolder();
    const chunks = [c(GMIOutputChunkType.TEXT_DELTA, 'raw'), step(0, 'raw', 'stop')];
    async function* pushing() {
      for (const x of chunks) {
        folder.push(x);
        if (x.type === GMIOutputChunkType.STEP_FINISHED) folder.overrideStepText(0, 'clean');
        yield x;
      }
    }
    const r = streamFromGmiTurn(pushing(), { folder });
    expect(await r.text).toBe('clean');
    expect((await r.usage).totalTokens).toBe(0);
  });

  it('a usage-only step (usage on STEP_FINISHED, no text) is counted', async () => {
    const r = streamFromGmiTurn(from([step(0, '', 'stop', u(4, 0))]));
    expect((await r.usage).totalTokens).toBe(4);
  });
});
