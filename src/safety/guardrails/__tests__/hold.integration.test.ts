/**
 * @file hold.integration.test.ts
 * A hold is a BLOCK that asks for a person's review: through the dispatcher's own entry points it ranks under a
 * refusal and over everything else, nothing it keeps back is delivered, and a guard's failure is one typed event
 * with no error text.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { ParallelGuardrailDispatcher } from '../ParallelGuardrailDispatcher';
import { createGuardrailBlockedStream, holdResult, isGuardrailHold, serializeEvaluation, wrapOutputGuardrails } from '../guardrailDispatcher';
import { GuardrailAction, type GuardrailConfig, type GuardrailContext, type GuardrailEvaluationResult, type IGuardrailService } from '../IGuardrailService';
import type { AgentOSInput } from '../../../api/types/AgentOSInput';
import { AgentOSResponseChunkType, type AgentOSErrorChunk, type AgentOSResponse } from '../../../api/types/AgentOSResponse';
import { resetLoggerFactory, setLogger } from '../../../core/logging/loggerFactory.js';

type Line = Record<string, unknown>;
const context: GuardrailContext = { userId: 'user-1', sessionId: 'session-1' };
const input = { userId: 'user-1', sessionId: 'session-1', textInput: 'a message' } as AgentOSInput;
const HOLD: GuardrailEvaluationResult = { action: GuardrailAction.BLOCK, hold: { reviewCode: 'REVIEW' } };
const REFUSE: GuardrailEvaluationResult = { action: GuardrailAction.BLOCK, reasonCode: 'RULE_1' };

/** A guard that answers `evaluation` at both stages. */
const answering = (id: string, evaluation: GuardrailEvaluationResult | null, config: GuardrailConfig = {}): IGuardrailService => ({
  id, config, evaluateInput: async () => evaluation, evaluateOutput: async () => evaluation,
});
/** A pino logger handed to AgentOS, and the lines it received. */
function capture(): Line[] {
  const lines: Line[] = [];
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { lines.push(JSON.parse(line)); } }));
  return lines;
}
/** A model turn that ends with `text` as its final reply. */
async function* reply(text: string): AsyncGenerator<AgentOSResponse, void, undefined> {
  yield { type: AgentOSResponseChunkType.FINAL_RESPONSE, streamId: 's1', gmiInstanceId: 'g1', personaId: 'p1', isFinal: true, timestamp: '2026-11-10T00:00:00.000Z', finalResponseText: text } as AgentOSResponse;
}
const toolCallChunk = (): AgentOSResponse => ({
  type: AgentOSResponseChunkType.TOOL_CALL_REQUEST, streamId: 's1', gmiInstanceId: 'g1', personaId: 'p1', isFinal: false, timestamp: '2026-11-10T00:00:00.000Z',
  toolCalls: [{ id: 'call-1', name: 'mute', arguments: { userId: 'u2' } }], executionMode: 'internal', requiresExternalToolResult: false,
} as AgentOSResponse);
async function collect(stream: AsyncGenerator<AgentOSResponse, void, undefined>): Promise<AgentOSResponse[]> {
  const out: AgentOSResponse[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

afterEach(() => { resetLoggerFactory(); vi.restoreAllMocks(); });

describe('a hold on a block, on input', () => {
  it('is the outcome when a guard holds and no guard refuses', async () => {
    const outcome = await ParallelGuardrailDispatcher.evaluateInput([answering('a', HOLD), answering('b', null)], input, context);
    expect(outcome.outcome).toBe('hold');
    expect(outcome.evaluation?.action).toBe(GuardrailAction.BLOCK);
    expect(outcome.evaluation?.hold?.reviewCode).toBe('REVIEW');
    expect(isGuardrailHold(outcome.evaluation)).toBe(true);
  });

  it('ranks under a refusal registered after it, and stays in the list', async () => {
    const outcome = await ParallelGuardrailDispatcher.evaluateInput([answering('a', HOLD), answering('b', null), answering('c', REFUSE)], input, context);
    expect(outcome.outcome).toBe('block');
    expect(outcome.evaluation?.reasonCode).toBe('RULE_1');
    expect(outcome.evaluation?.hold).toBeUndefined();
    expect((outcome.evaluations ?? []).some((e) => e.hold?.reviewCode === 'REVIEW')).toBe(true);
  });

  it('sets the outcome on every path: no guards, an allow, a flag, a phase 1 hold', async () => {
    expect((await ParallelGuardrailDispatcher.evaluateInput([], input, context)).outcome).toBe('allow');
    expect((await ParallelGuardrailDispatcher.evaluateInput([answering('a', null)], input, context)).outcome).toBe('allow');
    expect((await ParallelGuardrailDispatcher.evaluateInput([answering('a', { action: GuardrailAction.FLAG })], input, context)).outcome).toBe('flag');
    const phase1 = await ParallelGuardrailDispatcher.evaluateInput([answering('a', HOLD, { canSanitize: true }), answering('b', REFUSE)], input, context);
    expect(phase1.outcome).toBe('hold');
    expect(phase1.evaluations).toHaveLength(1);
  });

  it('is ignored on an action other than BLOCK, and says so once per guard', async () => {
    const lines = capture();
    const flagged: GuardrailEvaluationResult = { action: GuardrailAction.FLAG, hold: { reviewCode: 'REVIEW' } };
    const first = await ParallelGuardrailDispatcher.evaluateInput([answering('flagger', flagged)], input, context);
    await ParallelGuardrailDispatcher.evaluateInput([answering('flagger', flagged)], input, context);
    expect(first.outcome).toBe('flag');
    expect(lines.filter((line) => line.event === 'guardrail.hold_ignored')).toEqual([expect.objectContaining({ guardrailId: 'flagger', stage: 'input' })]);
  });

  it('says so for each guard that has no id, though each is written as unknown', async () => {
    const lines = capture();
    const flagged: GuardrailEvaluationResult = { action: GuardrailAction.FLAG, hold: { reviewCode: 'REVIEW' } };
    const unnamed = (): IGuardrailService => ({ config: {}, evaluateInput: async () => flagged });
    const first = unnamed();
    await ParallelGuardrailDispatcher.evaluateInput([first, unnamed()], input, context);
    await ParallelGuardrailDispatcher.evaluateInput([first], input, context);
    expect(lines.filter((line) => line.event === 'guardrail.hold_ignored')).toEqual([
      expect.objectContaining({ guardrailId: 'unknown', stage: 'input' }),
      expect.objectContaining({ guardrailId: 'unknown', stage: 'input' }),
    ]);
  });
});

describe('a hold on a block, on output and tool calls', () => {
  it('ends the reply as a block does, with the hold in the error chunk and nothing delivered', async () => {
    const chunks = await collect(wrapOutputGuardrails([answering('a', HOLD)], context, reply('the reply'), { streamId: 's1' }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe(AgentOSResponseChunkType.ERROR);
    expect(((chunks[0] as AgentOSErrorChunk).details as { hold?: { reviewCode: string } }).hold?.reviewCode).toBe('REVIEW');
    expect(JSON.stringify(chunks)).not.toContain('the reply');
  });

  it('in hold mode, holds the text before an actionable tool call and reports it to onVerdict with the withheld calls', async () => {
    async function* textThenExternalCall(): AsyncGenerator<AgentOSResponse, void, undefined> {
      yield { type: AgentOSResponseChunkType.TEXT_DELTA, streamId: 's1', gmiInstanceId: 'g1', personaId: 'p1', isFinal: false, timestamp: '2026-11-10T00:00:00.000Z', textDelta: 'the text before' } as AgentOSResponse;
      yield { ...toolCallChunk(), executionMode: 'external', requiresExternalToolResult: true } as AgentOSResponse;
    }
    const verdicts: Array<{ action: GuardrailAction; hold?: { reviewCode: string }; toolCallIds?: string[]; originalText: string | null }> = [];
    const chunks = await collect(wrapOutputGuardrails([answering('a', HOLD)], context, textThenExternalCall(), { streamId: 's1', holdUntilFinal: true, onVerdict: (v) => { verdicts.push(v); } }));
    expect(chunks).toHaveLength(1);
    expect(((chunks[0] as AgentOSErrorChunk).details as { hold?: { reviewCode: string } }).hold).toEqual({ reviewCode: 'REVIEW' });
    expect(verdicts).toEqual([expect.objectContaining({ action: GuardrailAction.BLOCK, hold: { reviewCode: 'REVIEW' }, toolCallIds: ['call-1'], originalText: 'the text before' })]);
    expect(JSON.stringify(chunks)).not.toContain('the text before');
  });

  it('a refusal later in registration order outranks an earlier hold in phase 2', async () => {
    const verdicts: Array<{ reasonCode?: string; hold?: { reviewCode: string } }> = [];
    const chunks = await collect(wrapOutputGuardrails([answering('a', HOLD), answering('c', REFUSE)], context, reply('the reply'), { streamId: 's1', onVerdict: (v) => { verdicts.push(v); } }));
    expect((chunks[0] as AgentOSErrorChunk).code).toBe('RULE_1');
    expect(verdicts).toEqual([expect.objectContaining({ action: GuardrailAction.BLOCK, reasonCode: 'RULE_1' })]);
    expect(verdicts[0].hold).toBeUndefined();
  });

  it('a refusal later in registration order outranks an earlier hold on a streamed delta', async () => {
    const streaming = { evaluateStreamingChunks: true };
    async function* deltaThenReply(): AsyncGenerator<AgentOSResponse, void, undefined> {
      yield { type: AgentOSResponseChunkType.TEXT_DELTA, streamId: 's1', gmiInstanceId: 'g1', personaId: 'p1', isFinal: false, timestamp: '2026-11-10T00:00:00.000Z', textDelta: 'the delta' } as AgentOSResponse;
      yield* reply('the reply');
    }
    const verdicts: Array<{ reasonCode?: string; hold?: { reviewCode: string } }> = [];
    const chunks = await collect(wrapOutputGuardrails([answering('a', HOLD, streaming), answering('c', REFUSE, streaming)], context, deltaThenReply(), { streamId: 's1', onVerdict: (v) => { verdicts.push(v); } }));
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as AgentOSErrorChunk).code).toBe('RULE_1');
    expect(((chunks[0] as AgentOSErrorChunk).details as { hold?: unknown }).hold).toBeUndefined();
    expect(verdicts).toEqual([expect.objectContaining({ action: GuardrailAction.BLOCK, reasonCode: 'RULE_1' })]);
    expect(verdicts[0].hold).toBeUndefined();
    expect(JSON.stringify(chunks)).not.toContain('the delta');
  });

  it('a held tool call is a refused tool call, and a refusal outranks it', async () => {
    const tools = { evaluateToolCalls: true };
    const held = await ParallelGuardrailDispatcher.evaluateToolCall([answering('a', HOLD, tools)], context, toolCallChunk());
    expect(held.outcome).toBe('block');
    expect(held.outcome === 'block' && held.evaluation.hold?.reviewCode).toBe('REVIEW');
    const refused = await ParallelGuardrailDispatcher.evaluateToolCall([answering('a', HOLD, tools), answering('c', REFUSE, tools)], context, toolCallChunk());
    expect(refused.outcome === 'block' && refused.evaluation.reasonCode).toBe('RULE_1');
  });

  it('a caller can rank a closed guard\'s failure under a hold; the default order is unchanged', async () => {
    const failing: IGuardrailService = { id: 'down', config: { failClosed: true }, evaluateOutput: async () => { throw new Error('down'); } };
    const holding: IGuardrailService = { id: 'holder', evaluateOutput: async () => HOLD };
    const byDefault = await collect(wrapOutputGuardrails([failing, holding], context, reply('the reply'), { streamId: 's1' }));
    expect((byDefault[0] as AgentOSErrorChunk).code).toBe('GUARDRAIL_ERROR');
    const holdsFirst = (evaluations: readonly GuardrailEvaluationResult[]) => evaluations.find((e) => isGuardrailHold(e)) ?? evaluations.find((e) => e.action === GuardrailAction.BLOCK);
    const picked = await collect(wrapOutputGuardrails([failing, holding], context, reply('the reply'), { streamId: 's1', pickBlock: holdsFirst }));
    expect(((picked[0] as AgentOSErrorChunk).details as { hold?: { reviewCode: string } }).hold?.reviewCode).toBe('REVIEW');
    const tools = { evaluateToolCalls: true, failClosed: true };
    const call = await ParallelGuardrailDispatcher.evaluateToolCall([{ ...failing, config: tools }, { ...holding, config: { evaluateToolCalls: true } }], context, toolCallChunk(), undefined, holdsFirst);
    expect(call.outcome === 'block' && call.evaluation.hold?.reviewCode).toBe('REVIEW');
  });

  it('a caller\'s picker is shown the BLOCK of a screen that runs first', async () => {
    const shown: GuardrailEvaluationResult[][] = [];
    const picker = (evaluations: readonly GuardrailEvaluationResult[]) => { shown.push([...evaluations]); return evaluations.find((e) => e.action === GuardrailAction.BLOCK); };
    const call = await ParallelGuardrailDispatcher.evaluateToolCall([answering('screen', REFUSE, { evaluateToolCalls: true, sequential: true }), answering('later', HOLD, { evaluateToolCalls: true })], context, toolCallChunk(), undefined, picker);
    expect(call.outcome === 'block' && call.evaluation.reasonCode).toBe('RULE_1');
    expect(shown).toEqual([[expect.objectContaining({ reasonCode: 'RULE_1' })]]);
    shown.length = 0;
    const chunks = await collect(wrapOutputGuardrails([answering('screen', REFUSE, { sequential: true })], context, reply('the reply'), { streamId: 's1', pickBlock: picker }));
    expect((chunks[0] as AgentOSErrorChunk).code).toBe('RULE_1');
    expect(shown).toEqual([[expect.objectContaining({ reasonCode: 'RULE_1' })]]);
  });

  it('a reply a picker lets pass is never reported as blocked', async () => {
    const declines = () => undefined;
    const flagging = answering('flagger', { action: GuardrailAction.FLAG, reasonCode: 'NOTE' });
    const verdicts: GuardrailAction[] = [];
    const flagged = await collect(wrapOutputGuardrails([answering('refuser', REFUSE), flagging], context, reply('the reply'), { streamId: 's1', pickBlock: declines, onVerdict: (v) => { verdicts.push(v.action); } }));
    expect(flagged.at(-1)?.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    const allowed = await collect(wrapOutputGuardrails([answering('refuser', REFUSE)], context, reply('the reply'), { streamId: 's2', pickBlock: declines, onVerdict: (v) => { verdicts.push(v.action); } }));
    expect(allowed.at(-1)?.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    expect(verdicts).toEqual([GuardrailAction.FLAG, GuardrailAction.ALLOW]);
  });

  it('a caller\'s picker is shown every answer before a screen\'s BLOCK, in registration order', async () => {
    const shown: string[][] = [];
    const picker = (evaluations: readonly GuardrailEvaluationResult[]) => { shown.push(evaluations.map((e) => e.reasonCode ?? '')); return evaluations.find((e) => e.action === GuardrailAction.BLOCK); };
    const NOTE: GuardrailEvaluationResult = { action: GuardrailAction.FLAG, reasonCode: 'NOTE' };
    await ParallelGuardrailDispatcher.evaluateToolCall([answering('first', NOTE, { evaluateToolCalls: true, sequential: true }), answering('screen', REFUSE, { evaluateToolCalls: true, sequential: true })], context, toolCallChunk(), undefined, picker);
    expect(shown).toEqual([['NOTE', 'RULE_1']]);
    shown.length = 0;
    // a guard of the parallel phase registered before a screen is shown before the screen's answer
    await collect(wrapOutputGuardrails([answering('classifier', REFUSE), answering('screen', NOTE, { sequential: true })], context, reply('the reply'), { streamId: 's1', pickBlock: picker }));
    expect(shown).toEqual([['RULE_1', 'NOTE']]);
  });

  it('is carried by the serialised entry and the blocked stream', async () => {
    expect(serializeEvaluation(holdResult('REVIEW', { reasonCode: 'NEEDS_REVIEW' }))).toMatchObject({ action: GuardrailAction.BLOCK, reasonCode: 'NEEDS_REVIEW', hold: { reviewCode: 'REVIEW' } });
    const [chunk] = await collect(createGuardrailBlockedStream(context, HOLD, { streamId: 's1' }));
    expect(((chunk as AgentOSErrorChunk).details as { hold?: { reviewCode: string } }).hold).toEqual({ reviewCode: 'REVIEW' });
  });
});

describe("a guard's failure is a typed event", () => {
  const MARKER = 'private-words-5521';
  const throwing = (config: GuardrailConfig): IGuardrailService => ({
    id: 'thrower', config,
    evaluateInput: async () => { throw Object.assign(new Error(MARKER), { name: 'PrivateWordsError', code: 'PRIVATE_WORDS' }); },
  });

  it('closed: one guardrail.failed line, no console line, no error text', async () => {
    const lines = capture();
    const warned = vi.spyOn(console, 'warn');
    const outcome = await ParallelGuardrailDispatcher.evaluateInput([throwing({ failClosed: true })], input, context);
    expect(outcome.outcome).toBe('block');
    expect(outcome.evaluation?.reasonCode).toBe('GUARDRAIL_ERROR');
    expect(lines.filter((line) => line.event === 'guardrail.failed')).toEqual([
      expect.objectContaining({ guardrailId: 'thrower', stage: 'input', posture: 'closed', cause: 'error', type: 'unknown', code: 'unknown' }),
    ]);
    expect(warned).not.toHaveBeenCalled();
    expect(JSON.stringify(lines).toLowerCase()).not.toContain('private');
  });

  it('open: skipped as today, with the same event at posture open; a timeout says timeout', async () => {
    const lines = capture();
    const open = await ParallelGuardrailDispatcher.evaluateInput([throwing({})], input, context);
    expect(open.outcome).toBe('allow');
    const slow: IGuardrailService = { id: 'slow', config: { timeoutMs: 5, failClosed: true }, evaluateInput: () => new Promise(() => {}) };
    const timed = await ParallelGuardrailDispatcher.evaluateInput([slow], input, context);
    expect(timed.outcome).toBe('block');
    expect(lines.filter((line) => line.event === 'guardrail.failed').map((line) => [line.guardrailId, line.posture, line.cause])).toEqual([
      ['thrower', 'open', 'error'], ['slow', 'closed', 'timeout'],
    ]);
  });
});
