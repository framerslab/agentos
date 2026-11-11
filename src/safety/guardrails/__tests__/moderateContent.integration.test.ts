/**
 * @file moderateContent.integration.test.ts
 * `moderateContent()` as a host calls it for content people send each other: guards closed unless they say otherwise,
 * screens that run before any guard that calls a vendor, a typed context, a dry run, a signal that stops further
 * vendor requests, and a decision that carries codes and ids and none of the content.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { moderateContent } from '../contentModeration';
import { evaluateInputGuardrails, holdResult } from '../guardrailDispatcher';
import { PhraseListGuardrail, StaticPhraseListSource } from '../builtin/PhraseListGuardrail';
import { GuardrailAction, type GuardrailConfig, type GuardrailContext, type GuardrailEvaluationResult, type IGuardrailService } from '../IGuardrailService';
import type { AgentOSInput } from '../../../api/types/AgentOSInput';
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
