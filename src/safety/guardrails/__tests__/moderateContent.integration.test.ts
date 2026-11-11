/**
 * @file moderateContent.integration.test.ts
 * `moderateContent()` as a host calls it for content people send each other: guards closed unless they say otherwise,
 * screens that run before any guard that calls a vendor, a typed context, a dry run, a signal that stops further
 * vendor requests, and a decision that carries codes and ids and none of the content.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { moderateContent } from '../contentModeration';
import { evaluateInputGuardrails, holdResult, wrapOutputGuardrails } from '../guardrailDispatcher';
import { PhraseListGuardrail, StaticPhraseListSource } from '../builtin/PhraseListGuardrail';
import { ParallelGuardrailDispatcher } from '../ParallelGuardrailDispatcher';
import { GuardrailAction, type GuardrailConfig, type GuardrailContext, type GuardrailEvaluationResult, type IGuardrailService } from '../IGuardrailService';
import type { AgentOSInput } from '../../../api/types/AgentOSInput';
import { AgentOSResponseChunkType, type AgentOSErrorChunk, type AgentOSFinalResponseChunk, type AgentOSResponse, type AgentOSTextDeltaChunk } from '../../../api/types/AgentOSResponse';
import { resetLoggerFactory, setLogger } from '../../../core/logging/loggerFactory.js';

type Line = Record<string, unknown>;
const context: GuardrailContext = { userId: 'user-1', sessionId: 'session-1' };
const REFUSE: GuardrailEvaluationResult = { action: GuardrailAction.BLOCK, reasonCode: 'RULE_1' };

/** A guard that answers `evaluation` on input. */
const answering = (id: string, evaluation: GuardrailEvaluationResult | null, config?: GuardrailConfig): IGuardrailService => ({
  id, ...(config ? { config } : {}), evaluateInput: async () => evaluation,
});
/** A guard that throws on input. With no config it names no `failClosed`. */
const throwing = (config?: GuardrailConfig): IGuardrailService => ({
  id: 'thrower', ...(config ? { config } : {}),
  evaluateInput: async () => { throw new Error('the vendor is down'); },
});
/** A pino logger handed to AgentOS, and the lines it received. */
function capture(): Line[] {
  const lines: Line[] = [];
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { lines.push(JSON.parse(line)); } }));
  return lines;
}
/** A reviewed list with one blocking entry. */
const hardBan = (sequential: boolean): Promise<PhraseListGuardrail> => PhraseListGuardrail.create({
  id: 'hard-ban', sequential,
  source: new StaticPhraseListSource({ version: '1', reviewedAt: '2026-11-10', reviewedBy: 'fixture', entries: [{ phrase: 'forbidden phrase', match: 'word', onMatch: 'block', ruleId: 'BAN_1' }] }),
});
const events = (lines: Line[], event: string): Line[] => lines.filter((line) => line.event === event);

afterEach(() => { resetLoggerFactory(); vi.restoreAllMocks(); });

describe('moderateContent: closed unless a guard says otherwise', () => {
  it('(a) a guard that throws refuses as unavailable, and the older entry point still skips it', async () => {
    const lines = capture();
    const decision = await moderateContent({ text: 'a message' }, { guards: [throwing()], context });
    expect(decision).toMatchObject({ outcome: 'refuse', enforced: true, unavailable: true });
    expect(decision.deciding).toMatchObject({ action: GuardrailAction.BLOCK, reasonCode: 'GUARDRAIL_ERROR', metadata: { failClosed: true, cause: 'error', guardrailId: 'thrower' } });
    expect(events(lines, 'guardrail.failed')).toEqual([expect.objectContaining({ guardrailId: 'thrower', stage: 'input', posture: 'closed', cause: 'error' })]);
    expect(events(lines, 'guardrail.verdict')).toEqual([expect.objectContaining({ guardrailId: 'thrower', stage: 'input', action: 'block', code: 'GUARDRAIL_ERROR', mode: 'enforce', unavailable: 'yes' })]);

    const older = await evaluateInputGuardrails([throwing()], { userId: 'user-1', sessionId: 'session-1', textInput: 'a message' } as AgentOSInput, context);
    expect(older.evaluations).toEqual([]);
    expect(older.outcome).toBe('allow');

    const open = await moderateContent({ text: 'a message' }, { guards: [throwing({ failClosed: false })], context });
    expect(open).toMatchObject({ outcome: 'allow', unavailable: false, evaluations: [] });
    expect(events(lines, 'guardrail.failed').at(-1)).toMatchObject({ guardrailId: 'thrower', posture: 'open' });
  });

  it('a guard past the deadline, and one that answers no recognised action, refuse as unavailable with their cause', async () => {
    const lines = capture();
    const slow: IGuardrailService = { id: 'slow', evaluateInput: () => new Promise(() => {}) };
    const timed = await moderateContent({ text: 'a message' }, { guards: [slow], context, timeoutMs: 5 });
    expect(timed).toMatchObject({ outcome: 'refuse', unavailable: true });
    expect(timed.deciding?.metadata).toMatchObject({ failClosed: true, cause: 'timeout', guardrailId: 'slow' });

    const nonsense = answering('nonsense', { action: 'maybe' } as unknown as GuardrailEvaluationResult);
    const malformed = await moderateContent({ text: 'a message' }, { guards: [nonsense], context });
    expect(malformed).toMatchObject({ outcome: 'refuse', unavailable: true });
    expect(malformed.deciding).toMatchObject({ reasonCode: 'GUARDRAIL_MALFORMED', metadata: { failClosed: true, cause: 'malformed', guardrailId: 'nonsense' } });
    const dropped = await moderateContent({ text: 'a message' }, { guards: [answering('nonsense', { action: 'maybe' } as unknown as GuardrailEvaluationResult, { failClosed: false })], context });
    expect(dropped.outcome).toBe('allow');
    expect(events(lines, 'guardrail.failed').map((line) => [line.guardrailId, line.posture, line.cause])).toEqual([
      ['slow', 'closed', 'timeout'], ['nonsense', 'closed', 'malformed'], ['nonsense', 'open', 'malformed'],
    ]);
  });

  it('(c) an outage never hides a hold or a refusal by rule', async () => {
    const held = await moderateContent({ text: 'a message' }, { guards: [throwing(), answering('holder', holdResult('REVIEW'))], context });
    expect(held).toMatchObject({ outcome: 'hold', unavailable: false, hold: { reviewCode: 'REVIEW' } });
    const refused = await moderateContent({ text: 'a message' }, { guards: [throwing(), answering('rule', REFUSE)], context });
    expect(refused).toMatchObject({ outcome: 'refuse', unavailable: false });
    expect(refused.deciding?.reasonCode).toBe('RULE_1');
    expect(refused.evaluations).toHaveLength(2);
  });

  it('(d) a guard that cannot judge input is a configuration error that names it', async () => {
    const outputOnly: IGuardrailService = { id: 'output-only', evaluateOutput: async () => null };
    await expect(moderateContent({ text: 'a message' }, { guards: [outputOnly], context })).rejects.toThrow(TypeError);
    await expect(moderateContent({ text: 'a message' }, { guards: [outputOnly], context })).rejects.toThrow(/output-only/);
    const staged: IGuardrailService = { id: 'staged', stages: ['output'], evaluateInput: async () => null };
    await expect(moderateContent({ text: 'a message' }, { guards: [staged], context })).rejects.toThrow(/staged/);
    const nameless: IGuardrailService = { evaluateOutput: async () => null };
    await expect(moderateContent({ text: 'a message' }, { guards: [answering('first', null), nameless], context })).rejects.toThrow(/guard_1/);
  });

  it('a mode it does not know is a configuration error, before any guard runs', async () => {
    // 'dry_run' is the log line's spelling; taken as a mode it once gave enforced: false beside an enforced outcome
    const spy = vi.fn(async (): Promise<GuardrailEvaluationResult | null> => ({ action: GuardrailAction.SANITIZE, modifiedText: 'cleaned' }));
    const sanitizer: IGuardrailService = { id: 'sanitizer', config: { canSanitize: true }, evaluateInput: spy };
    const call = moderateContent({ text: 'original' }, { guards: [sanitizer], context, mode: 'dry_run' as unknown as 'dryRun' });
    await expect(call).rejects.toThrow(TypeError);
    await expect(call).rejects.toThrow(/mode/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('moderateContent: screens that run first', () => {
  it('(b) a sequential list keeps a blocked text from the guard behind it, in enforce and in a dry run', async () => {
    const lines = capture();
    const spy = vi.fn(async () => null);
    const vendor: IGuardrailService = { id: 'vendor', evaluateInput: spy };
    const list = await hardBan(true);
    const enforced = await moderateContent({ text: 'a forbidden phrase here' }, { guards: [list, vendor], context });
    expect(enforced).toMatchObject({ outcome: 'refuse', unavailable: false, deciding: { reasonCode: 'BAN_1' } });
    const dry = await moderateContent({ text: 'a forbidden phrase here' }, { guards: [list, vendor], context, mode: 'dryRun' });
    expect(dry).toMatchObject({ outcome: 'allow', wouldBe: 'refuse', enforced: false });
    expect(spy).not.toHaveBeenCalled();
    expect(events(lines, 'guardrail.verdict').map((line) => [line.guardrailId, line.action, line.code, line.mode])).toEqual([
      ['hard-ban', 'block', 'BAN_1', 'enforce'], ['hard-ban', 'block', 'BAN_1', 'dry_run'],
    ]);

    await moderateContent({ text: 'an ordinary line' }, { guards: [list, vendor], context });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(events(lines, 'guardrail.verdict')).toHaveLength(2);

    // without `sequential` the list runs beside the vendor guard, as it does today
    await moderateContent({ text: 'a forbidden phrase here' }, { guards: [await hardBan(false), vendor], context });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a guard that only asks to run first cannot rewrite: its SANITIZE is a FLAG', async () => {
    const lines = capture();
    const rewriter = answering('rewriter', { action: GuardrailAction.SANITIZE, modifiedText: 'changed' }, { sequential: true });
    const decision = await moderateContent({ text: 'original' }, { guards: [rewriter], context });
    expect(decision.outcome).toBe('flag');
    expect(decision.sanitizedText).toBeUndefined();
    expect(events(lines, 'guardrail.sanitize_downgraded')).toEqual([expect.objectContaining({ guardrailId: 'rewriter', stage: 'input' })]);

    const sanitizer = answering('sanitizer', { action: GuardrailAction.SANITIZE, modifiedText: 'cleaned' }, { canSanitize: true });
    expect(await moderateContent({ text: 'original' }, { guards: [sanitizer], context })).toMatchObject({ outcome: 'allow', sanitizedText: 'cleaned' });
    const dry = await moderateContent({ text: 'original' }, { guards: [sanitizer], context, mode: 'dryRun' });
    expect(dry.outcome).toBe('allow');
    expect(dry.sanitizedText).toBeUndefined();
    // a rewrite alone is an allow, and still writes one line, as `sanitize`
    expect(events(lines, 'guardrail.verdict').map((line) => [line.guardrailId, line.action, line.code, line.mode])).toEqual([
      ['rewriter', 'flag', 'unknown', 'enforce'], ['sanitizer', 'sanitize', 'unknown', 'enforce'], ['sanitizer', 'sanitize', 'unknown', 'dry_run'],
    ]);
  });

  it('a screen that fails ends the evaluation as its BLOCK does: the guard behind it never sees the text', async () => {
    const spy = vi.fn(async () => holdResult('REVIEW'));
    const decision = await moderateContent({ text: 'a message' }, { guards: [throwing({ sequential: true }), { id: 'holder', evaluateInput: spy }], context });
    expect(decision).toMatchObject({ outcome: 'refuse', unavailable: true, deciding: { reasonCode: 'GUARDRAIL_ERROR', metadata: { guardrailId: 'thrower' } } });
    expect(decision.hold).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('(f) a listed code stops every further vendor request for the content', async () => {
    const second = vi.fn();
    const signal = answering('signal', holdResult('STOP'));
    const judge: IGuardrailService = {
      id: 'judge',
      evaluateInput: async ({ context: seen }) => {
        // the first request is out; a second one starts after 50 ms unless the call's signal says stop
        await new Promise<void>((resolve) => {
          if (seen.vendorSignal?.aborted) { resolve(); return; }
          const timer = setTimeout(resolve, 50);
          seen.vendorSignal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        if (seen.vendorSignal?.aborted) return null;
        second();
        return null;
      },
    };
    const stopped = await moderateContent({ text: 'a message' }, { guards: [signal, judge], context, stopVendorsOn: ['STOP'] });
    expect(stopped).toMatchObject({ outcome: 'hold', hold: { reviewCode: 'STOP' } });
    expect(second).not.toHaveBeenCalled();
    await moderateContent({ text: 'a message' }, { guards: [signal, judge], context });
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('moderateContent: what the decision carries', () => {
  it('(e) no field of the decision holds a guard\'s reason or details', async () => {
    const lines = capture();
    const TEXT = 'meet me at 221 Baker Street tonight';
    const chatty = answering('chatty', { action: GuardrailAction.BLOCK, reason: `Refused because it says: ${TEXT}`, details: { text: TEXT }, reasonCode: `said: ${TEXT}` });
    const decision = await moderateContent({ text: TEXT }, { guards: [chatty], context });
    expect(decision.outcome).toBe('refuse');
    expect(decision.deciding?.reasonCode).toBe('INVALID_CODE');
    expect(JSON.stringify(decision)).not.toContain('Baker');
    expect(JSON.stringify(lines)).not.toContain('Baker');
    expect(events(lines, 'guardrail.verdict')).toEqual([expect.objectContaining({ guardrailId: 'chatty', code: 'unknown' })]);
  });

  it('(g) a hold, and a refusal that outranks it', async () => {
    const hold = answering('a', holdResult('REVIEW'));
    const held = await moderateContent({ text: 'a message' }, { guards: [hold, answering('b', null)], context });
    expect(held).toMatchObject({ outcome: 'hold', enforced: true, unavailable: false, hold: { reviewCode: 'REVIEW' } });
    const refused = await moderateContent({ text: 'a message' }, { guards: [hold, answering('b', null), answering('c', REFUSE)], context });
    expect(refused.outcome).toBe('refuse');
    expect(refused.hold).toBeUndefined();
    expect(refused.evaluations.some((evaluation) => evaluation.hold?.reviewCode === 'REVIEW')).toBe(true);
    expect(await moderateContent({ text: 'a message' }, { guards: [answering('f', { action: GuardrailAction.FLAG, reasonCode: 'NOTE_1' })], context })).toMatchObject({ outcome: 'flag', unavailable: false });
  });

  it('a guard that writes the failure markers into its own answer refuses as a rule, not as an outage', async () => {
    const lines = capture();
    const lookalike = answering('lookalike', { action: GuardrailAction.BLOCK, reasonCode: 'GUARDRAIL_ERROR', metadata: { failClosed: true, cause: 'error' } });
    const alone = await moderateContent({ text: 'a message' }, { guards: [lookalike], context });
    expect(alone).toMatchObject({ outcome: 'refuse', unavailable: false });
    // a rule's refusal outranks a hold, so the lookalike is not passed over for the hold beside it
    const beside = await moderateContent({ text: 'a message' }, { guards: [answering('holder', holdResult('REVIEW')), lookalike], context });
    expect(beside).toMatchObject({ outcome: 'refuse', unavailable: false, deciding: { metadata: { guardrailId: 'lookalike' } } });
    // the library's own code is written only for the library's own failure; the guard does not list it
    expect(events(lines, 'guardrail.verdict').map((line) => [line.guardrailId, line.code, line.unavailable])).toEqual([
      ['lookalike', 'unknown', 'no'], ['lookalike', 'unknown', 'no'],
    ]);
  });

  it('a sanitizer that removes the whole text gives an empty sanitizedText, so the original cannot come back', async () => {
    const remover = answering('remover', { action: GuardrailAction.SANITIZE, modifiedText: null }, { canSanitize: true });
    const decision = await moderateContent({ text: 'call 555 0100' }, { guards: [remover], context });
    expect(decision).toMatchObject({ outcome: 'allow', sanitizedText: '' });
    expect(JSON.stringify(decision)).not.toContain('555');
  });

  it('a guard that answers nothing at all (undefined) is malformed: closed it refuses as unavailable, open it is dropped', async () => {
    const lines = capture();
    const silent = (config?: GuardrailConfig): IGuardrailService => ({ id: 'silent', ...(config ? { config } : {}), evaluateInput: async () => undefined as unknown as null });
    const closed = await moderateContent({ text: 'a message' }, { guards: [silent()], context });
    expect(closed).toMatchObject({ outcome: 'refuse', unavailable: true, deciding: { reasonCode: 'GUARDRAIL_MALFORMED', metadata: { cause: 'malformed' } } });
    const open = await moderateContent({ text: 'a message' }, { guards: [silent({ failClosed: false })], context });
    expect(open).toMatchObject({ outcome: 'allow', unavailable: false, evaluations: [] });
    expect(events(lines, 'guardrail.failed').map((line) => [line.guardrailId, line.posture, line.cause])).toEqual([
      ['silent', 'closed', 'malformed'], ['silent', 'open', 'malformed'],
    ]);
    // an explicit null is still an allow
    expect((await moderateContent({ text: 'a message' }, { guards: [answering('quiet', null)], context })).outcome).toBe('allow');
  });
});

describe('moderateContent: typed context', () => {
  const moderation = { surface: 'public_room', roomId: 'r1', rating: 'standard', messageId: 'm1', sender: { id: 'u1', kind: 'account' as const } };

  it('hands a guard exactly the five fields, the image inputs and a signal of the call\'s own', async () => {
    let seen: { context?: GuardrailContext; input?: AgentOSInput } = {};
    const reader: IGuardrailService = { id: 'reader', evaluateInput: async (payload) => { seen = payload; return null; } };
    const image = { type: 'base64' as const, data: 'AAAA', mimeType: 'image/png' };
    await moderateContent({ text: 'a message', images: [image] }, { guards: [reader], context: { ...context, moderation } });
    expect(seen.context?.moderation).toEqual(moderation);
    expect(seen.context?.vendorSignal?.aborted).toBe(false);
    expect(seen.input).toMatchObject({ userId: 'user-1', sessionId: 'session-1', textInput: 'a message', visionInputs: [image] });
  });

  it('refuses a field that is not an id before any guard runs, naming the field and not its value', async () => {
    const spy = vi.fn(async () => null);
    const call = moderateContent({ text: 'a message' }, { guards: [{ id: 'spy', evaluateInput: spy }], context: { ...context, moderation: { ...moderation, roomId: 'r 1\n' } } });
    await expect(call).rejects.toThrow(TypeError);
    await expect(call).rejects.toThrow(/roomId/);
    await expect(call).rejects.not.toThrow(/r 1/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('a screen that runs first, on the reply', () => {
  const chunk = { streamId: 's1', gmiInstanceId: 'g1', personaId: 'p1', isFinal: false, timestamp: '2026-11-10T00:00:00.000Z' };
  async function* reply(text: string, delta?: string): AsyncGenerator<AgentOSResponse, void, undefined> {
    if (delta !== undefined) yield { ...chunk, type: AgentOSResponseChunkType.TEXT_DELTA, textDelta: delta } as AgentOSResponse;
    yield { ...chunk, type: AgentOSResponseChunkType.FINAL_RESPONSE, isFinal: true, finalResponseText: text } as AgentOSResponse;
  }
  async function collect(stream: AsyncGenerator<AgentOSResponse, void, undefined>): Promise<AgentOSResponse[]> {
    const out: AgentOSResponse[] = [];
    for await (const item of stream) out.push(item);
    return out;
  }

  it('a sequential list ends a refused reply before the guard behind it is called', async () => {
    const spy = vi.fn(async () => null);
    const vendor: IGuardrailService = { id: 'vendor', evaluateOutput: spy };
    const refused = await collect(wrapOutputGuardrails([await hardBan(true), vendor], context, reply('a forbidden phrase here'), { streamId: 's1' }));
    expect(refused).toHaveLength(1);
    expect(refused[0].type).toBe(AgentOSResponseChunkType.ERROR);
    expect((refused[0] as AgentOSErrorChunk).code).toBe('BAN_1');
    expect(JSON.stringify(refused)).not.toContain('forbidden phrase here');
    expect(spy).not.toHaveBeenCalled();

    const passed = await collect(wrapOutputGuardrails([await hardBan(true), vendor], context, reply('an ordinary reply'), { streamId: 's1' }));
    expect((passed.at(-1) as AgentOSFinalResponseChunk).finalResponseText).toBe('an ordinary reply');
    expect(spy).toHaveBeenCalledTimes(1);

    // without `sequential` the list runs beside the vendor guard, as it did before
    await collect(wrapOutputGuardrails([await hardBan(false), vendor], context, reply('a forbidden phrase here'), { streamId: 's1' }));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a guard that only asks to run first cannot rewrite the reply or a streamed delta: its SANITIZE is a FLAG', async () => {
    const lines = capture();
    const rewriter: IGuardrailService = {
      id: 'rewriter', config: { sequential: true, evaluateStreamingChunks: true },
      evaluateOutput: async () => ({ action: GuardrailAction.SANITIZE, modifiedText: 'changed' }),
    };
    const chunks = await collect(wrapOutputGuardrails([rewriter], context, reply('the reply', 'the delta'), { streamId: 's1' }));
    const delta = chunks.find((item) => item.type === AgentOSResponseChunkType.TEXT_DELTA) as AgentOSTextDeltaChunk;
    const final = chunks.find((item) => item.type === AgentOSResponseChunkType.FINAL_RESPONSE) as AgentOSFinalResponseChunk;
    expect(delta.textDelta).toBe('the delta');
    expect(final.finalResponseText).toBe('the reply');
    expect(events(lines, 'guardrail.sanitize_downgraded').map((line) => [line.guardrailId, line.stage])).toEqual([['rewriter', 'output'], ['rewriter', 'output']]);

    // the same answer from a guard that can sanitize rewrites the reply
    const sanitizer: IGuardrailService = { ...rewriter, config: { sequential: true, canSanitize: true } };
    const rewritten = await collect(wrapOutputGuardrails([sanitizer], context, reply('the reply'), { streamId: 's1' }));
    expect((rewritten.at(-1) as AgentOSFinalResponseChunk).finalResponseText).toBe('changed');
  });

  it('two unnamed screens that run first on streamed deltas each keep their own evaluation count', async () => {
    const calls: string[] = [];
    const screen = (name: string): IGuardrailService => ({
      config: { sequential: true, evaluateStreamingChunks: true, maxStreamingEvaluations: 1 },
      evaluateOutput: async ({ chunk: item }) => {
        if (item.type === AgentOSResponseChunkType.TEXT_DELTA) calls.push(name);
        return null;
      },
    });
    await collect(wrapOutputGuardrails([screen('first'), screen('second')], context, reply('the reply', 'the delta'), { streamId: 's1' }));
    expect(calls).toEqual(['first', 'second']);
  });

  it('a tool-call screen that runs first refuses the call before any other tool-call guard sees it', async () => {
    const spy = vi.fn(async () => null);
    const vendor: IGuardrailService = { id: 'vendor', config: { evaluateToolCalls: true }, evaluateOutput: spy };
    const screen = (action: GuardrailAction): IGuardrailService => ({
      id: 'screen', config: { sequential: true, evaluateToolCalls: true },
      evaluateOutput: async () => (action === GuardrailAction.BLOCK ? { action, reasonCode: 'BAN_1' } : null),
    });
    const toolCall = { ...chunk, type: AgentOSResponseChunkType.TOOL_CALL_REQUEST, toolCalls: [{ id: 'call-1', name: 'search', arguments: {} }], executionMode: 'internal', requiresExternalToolResult: false } as unknown as AgentOSResponse;

    // registered after the vendor guard, the screen still answers first
    const refused = await ParallelGuardrailDispatcher.evaluateToolCall([vendor, screen(GuardrailAction.BLOCK)], context, toolCall);
    expect(refused).toMatchObject({ outcome: 'block', evaluation: { reasonCode: 'BAN_1' } });
    expect(spy).not.toHaveBeenCalled();

    const passed = await ParallelGuardrailDispatcher.evaluateToolCall([vendor, screen(GuardrailAction.ALLOW)], context, toolCall);
    expect(passed.outcome).toBe('pass');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
