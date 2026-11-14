/**
 * @file guardrailOutcome.test.ts
 * What a list of evaluations amounts to, and an evaluation as the moderation entry points report it.
 */
import { describe, expect, it } from 'vitest';
import { guardrailOutcomeOf, toModerationEvaluation } from '../guardrailDispatcher';
import { GuardrailAction, type GuardrailEvaluationResult } from '../IGuardrailService';

const of = (action: GuardrailAction, extra: Partial<GuardrailEvaluationResult> = {}): GuardrailEvaluationResult => ({ action, ...extra });
const HOLD = of(GuardrailAction.BLOCK, { hold: { reviewCode: 'REVIEW' } });

describe('guardrailOutcomeOf', () => {
  it.each([
    [[], 'allow'],
    [[of(GuardrailAction.ALLOW)], 'allow'],
    [[of(GuardrailAction.SANITIZE)], 'sanitize'],
    [[of(GuardrailAction.SANITIZE), of(GuardrailAction.FLAG)], 'flag'],
    [[of(GuardrailAction.FLAG), HOLD], 'hold'],
    [[HOLD, of(GuardrailAction.BLOCK)], 'block'],
    [[of(GuardrailAction.BLOCK), HOLD], 'block'],
    [[of(GuardrailAction.FLAG, { hold: { reviewCode: 'REVIEW' } })], 'flag'],
  ] as const)('%j is %s', (evaluations, outcome) => {
    expect(guardrailOutcomeOf(evaluations as readonly GuardrailEvaluationResult[])).toBe(outcome);
  });
});

describe('toModerationEvaluation', () => {
  it('drops the reason and the details and keeps codes, the hold and the metadata', () => {
    const reported = toModerationEvaluation({ action: GuardrailAction.BLOCK, reason: 'a sentence a judge wrote', details: { text: 'x' }, reasonCode: 'spam.link-1', hold: { reviewCode: 'REVIEW_1' }, metadata: { guardrailId: 'g' } });
    expect(reported).toEqual({ action: GuardrailAction.BLOCK, reasonCode: 'spam.link-1', hold: { reviewCode: 'REVIEW_1' }, metadata: { guardrailId: 'g' } });
  });
  it('writes a code that holds a sentence as INVALID_CODE', () => {
    const reported = toModerationEvaluation({ action: GuardrailAction.BLOCK, reasonCode: 'meet me at the corner', hold: { reviewCode: 'call 555 0100' } });
    expect(reported.reasonCode).toBe('INVALID_CODE');
    expect(reported.hold).toEqual({ reviewCode: 'INVALID_CODE' });
  });
  it('writes a code of 65 characters, and a review code with a dot, as INVALID_CODE', () => {
    expect(toModerationEvaluation({ action: GuardrailAction.FLAG, reasonCode: 'A'.repeat(65) }).reasonCode).toBe('INVALID_CODE');
    expect(toModerationEvaluation({ action: GuardrailAction.BLOCK, hold: { reviewCode: 'a.b' } }).hold).toEqual({ reviewCode: 'INVALID_CODE' });
  });
  it('reports no hold for a hold on another action', () => {
    expect(toModerationEvaluation({ action: GuardrailAction.FLAG, hold: { reviewCode: 'REVIEW' } })).toEqual({ action: GuardrailAction.FLAG });
  });
});
