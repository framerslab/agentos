/**
 * @fileoverview The phrase-list guard: matches after normalisation (a zero-width joiner inside a word, a Cyrillic
 * look-alike, curly quotes), the three match kinds, a judge that blocks, allows, answers nonsense or throws, the
 * replacement per rule, the empty-list refusal, and the atomic reload.
 */
import { describe, expect, it } from 'vitest';
import { AgentOSResponseChunkType, type AgentOSFinalResponseChunk } from '../../../api/types/AgentOSResponse';
import { GuardrailAction, type GuardrailContext } from '../IGuardrailService';
import {
  PhraseListGuardrail,
  StaticPhraseListSource,
  normalizePhraseText,
  type PhraseJudge,
  type PhraseListSnapshot,
  type PhraseListSource,
} from '../builtin/PhraseListGuardrail';

const context: GuardrailContext = { userId: 'u', sessionId: 's', personaId: 'p' };
const snapshot = (entries: PhraseListSnapshot['entries'], version = '1'): PhraseListSnapshot => ({ version, reviewedAt: '2026-10-08', reviewedBy: 'counsel', entries });
const finalChunk = (text: string): AgentOSFinalResponseChunk => ({
  type: AgentOSResponseChunkType.FINAL_RESPONSE,
  streamId: 'stream',
  gmiInstanceId: 'gmi',
  personaId: 'p',
  isFinal: true,
  timestamp: new Date().toISOString(),
  finalResponseText: text,
});
const judgeAnswering = (verdict: unknown): PhraseJudge => ({ judge: async () => verdict as never });

describe('normalizePhraseText', () => {
  it('folds case, drops zero-width characters and marks, maps look-alikes and straightens quotes', () => {
    expect(normalizePhraseText('You​ll PASS for sure')).toBe('youll pass for sure');
    expect(normalizePhraseText('yоu will pаss')).toBe('you will pass'); // Cyrillic о and а
    expect(normalizePhraseText('I’ll book it')).toBe("i'll book it");
    expect(normalizePhraseText('résumé  text')).toBe('resume text');
  });
});

describe('PhraseListGuardrail', () => {
  it('matches a word phrase between word boundaries, a substring anywhere, and a regex, after normalisation', async () => {
    const guard = await PhraseListGuardrail.create({
      id: 'never-do',
      source: new StaticPhraseListSource(
        snapshot([
          { phrase: 'you will pass', match: 'word', onMatch: 'block', ruleId: 'outcome_promise' },
          { phrase: 'diagnos', match: 'substring', onMatch: 'block', ruleId: 'diagnosis' },
          { phrase: "i(?:'| wi)ll (?:book|send) ", match: 'regex', onMatch: 'block', ruleId: 'outward_act' },
        ]),
      ),
      replacementFor: (ruleId) => (ruleId === 'outcome_promise' ? 'No promise is made.' : undefined),
      replacementText: 'The reply was replaced.',
    });
    const block = async (text: string) => guard.evaluateOutput({ context, chunk: finalChunk(text) });
    expect(await block('Keep at it and yоu​ will pass the exam.')).toMatchObject({ action: GuardrailAction.BLOCK, reasonCode: 'outcome_promise', replacementText: 'No promise is made.', metadata: { guardrailId: 'never-do', ruleId: 'outcome_promise', listVersion: '1' } });
    expect(await block('That bypasses the rule.')).toBeNull(); // "you will pass" is not inside "bypasses"
    expect(await block('Self-diagnosing is risky.')).toMatchObject({ action: GuardrailAction.BLOCK, reasonCode: 'diagnosis', replacementText: 'The reply was replaced.' });
    expect(await block('I’ll book the seat for you.')).toMatchObject({ reasonCode: 'outward_act' });
    expect(await block('A plain reply about the week.')).toBeNull();
    // the input stage reads the person's text the same way
    expect(await guard.evaluateInput({ context, input: { userId: 'u', sessionId: 's', textInput: 'you will pass, right?' } })).toMatchObject({ reasonCode: 'outcome_promise' });
    // a chunk that is not the final response is not judged
    expect(await guard.evaluateOutput({ context, chunk: { ...finalChunk('you will pass'), type: AgentOSResponseChunkType.TEXT_DELTA, isFinal: false } as never })).toBeNull();
  });

  it('asks the judge on a judge entry and fails closed on a block, a thin answer, a malformed one and a throw', async () => {
    const make = (judge: PhraseJudge) =>
      PhraseListGuardrail.create({
        id: 'money',
        source: new StaticPhraseListSource(snapshot([{ phrase: 'index fund', match: 'word', onMatch: 'judge', ruleId: 'money' }])),
        judge,
        judgeThreshold: 0.7,
        replacementFor: () => 'Arithmetic only.',
      });
    const text = 'Put the fee into an index fund until the exam.';
    const run = async (judge: PhraseJudge) => (await make(judge)).evaluateOutput({ context, chunk: finalChunk(text) });
    expect(await run(judgeAnswering({ block: false, confidence: 0.95 }))).toBeNull();
    expect(await run(judgeAnswering({ block: true, confidence: 0.9, reason: 'advice to invest' }))).toMatchObject({ action: GuardrailAction.BLOCK, reasonCode: 'money', reason: 'advice to invest', replacementText: 'Arithmetic only.' });
    expect(await run(judgeAnswering({ block: false, confidence: 0.4 }))).toMatchObject({ action: GuardrailAction.BLOCK, reason: expect.stringContaining('not sure enough') });
    expect(await run(judgeAnswering({ verdict: 'fine' }))).toMatchObject({ action: GuardrailAction.BLOCK, reason: expect.stringContaining('no usable answer') });
    expect(await run({ judge: async () => Promise.reject(new Error('judge down')) })).toMatchObject({ action: GuardrailAction.BLOCK, reason: expect.stringContaining('could not answer') });
    // a text that matches no entry never reaches the judge
    let asked = 0;
    const counting: PhraseJudge = { judge: async () => { asked += 1; return { block: true, confidence: 1 }; } };
    expect(await (await make(counting)).evaluateOutput({ context, chunk: finalChunk('Keep the receipts.') })).toBeNull();
    expect(asked).toBe(0);
  });

  it('refuses an empty list, a list that does not load, and judge entries without a judge', async () => {
    await expect(PhraseListGuardrail.create({ id: 'g', source: new StaticPhraseListSource(snapshot([])) })).rejects.toThrow(/is empty/);
    await expect(PhraseListGuardrail.create({ id: 'g', source: { load: () => Promise.reject(new Error('disk gone')) } })).rejects.toThrow('disk gone');
    await expect(PhraseListGuardrail.create({ id: 'g', source: new StaticPhraseListSource(snapshot([{ phrase: 'x', match: 'word', onMatch: 'judge' }])) })).rejects.toThrow(/no judge/);
  });

  it('swaps the list atomically on reload and keeps the last good one when a reload fails', async () => {
    let current = snapshot([{ phrase: 'first rule', match: 'word', onMatch: 'block', ruleId: 'first' }], '1');
    let fail = false;
    const source: PhraseListSource = { load: async () => (fail ? Promise.reject(new Error('cannot read')) : current) };
    const guard = await PhraseListGuardrail.create({ id: 'g', source });
    const hit = async (text: string) => (await guard.evaluateOutput({ context, chunk: finalChunk(text) }))?.reasonCode ?? null;
    expect(await hit('the first rule')).toBe('first');
    current = snapshot([{ phrase: 'second rule', match: 'word', onMatch: 'block', ruleId: 'second' }], '2');
    await guard.reload();
    expect(guard.snapshot?.version).toBe('2');
    expect([await hit('the first rule'), await hit('the second rule')]).toEqual([null, 'second']);
    fail = true;
    await expect(guard.reload()).rejects.toThrow('cannot read');
    expect(guard.snapshot?.version).toBe('2');
    expect(await hit('the second rule')).toBe('second');
    // a list that compiles badly is refused whole, and the one in force stays
    fail = false;
    current = snapshot([{ phrase: '(', match: 'regex', onMatch: 'block' }], '3');
    await expect(guard.reload()).rejects.toThrow();
    expect(guard.snapshot?.version).toBe('2');
  });

  it('runs fail-closed with its deadline and evaluates only the stages it was given', async () => {
    const guard = await PhraseListGuardrail.create({ id: 'g', source: new StaticPhraseListSource(snapshot([{ phrase: 'x', match: 'word', onMatch: 'block' }])), stages: ['output'], timeoutMs: 1234 });
    expect(guard.config).toMatchObject({ failClosed: true, timeoutMs: 1234, canSanitize: false });
    expect(await guard.evaluateInput({ context, input: { userId: 'u', sessionId: 's', textInput: 'x' } })).toBeNull();
    expect(await guard.evaluateOutput({ context, chunk: finalChunk('x') })).toMatchObject({ action: GuardrailAction.BLOCK, reasonCode: 'PHRASE_LIST' });
  });
});
