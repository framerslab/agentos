/**
 * @file requiredGuardrails.test.ts
 * A required guard is held to the stages it declares: a guard that has both methods but runs on one stage does not
 * cover the other, and the phrase-list guard declares the stages it was built with.
 */
import { describe, expect, it } from 'vitest';
import type { IGuardrailService } from '../IGuardrailService';
import { PhraseListGuardrail, StaticPhraseListSource } from '../builtin/PhraseListGuardrail';
import { checkRequiredGuardrails } from '../requiredGuardrails';

const both: IGuardrailService = { id: 'both', evaluateInput: async () => null, evaluateOutput: async () => null };

describe('checkRequiredGuardrails', () => {
  it('holds a guard to the stages it declares, and to its methods when it declares none', () => {
    const inputOnly: IGuardrailService = { ...both, id: 'input-only', stages: ['input'] };
    const report = checkRequiredGuardrails(
      [{ id: 'both', service: both }, { id: 'input-only', service: inputOnly }],
      [
        { id: 'both', stages: ['input', 'output'], timeoutMs: 1000 },
        { id: 'input-only', stages: ['output'], timeoutMs: 1000 },
        { id: 'absent', stages: ['output'], timeoutMs: 1000 },
      ],
    );
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(['absent']);
    expect(report.missingStage).toEqual([{ id: 'input-only', stage: 'output' }]);
  });

  it('reports a declared stage whose method is missing', () => {
    const declared: IGuardrailService = { id: 'd', stages: ['input', 'output'], evaluateInput: async () => null };
    expect(checkRequiredGuardrails([{ id: 'd', service: declared }], [{ id: 'd', stages: ['output'], timeoutMs: 1000 }]).missingStage).toEqual([{ id: 'd', stage: 'output' }]);
  });

  it('a phrase-list guard built for one stage is not coverage for the other', async () => {
    const source = new StaticPhraseListSource({ version: '1', reviewedAt: '2026-10-08', reviewedBy: 'test', entries: [{ phrase: 'you will pass', match: 'word', onMatch: 'block', ruleId: 'outcome_promise' }] });
    const guard = await PhraseListGuardrail.create({ id: 'never-do', source, stages: ['input'] });
    expect(guard.stages).toEqual(['input']);
    const report = checkRequiredGuardrails([{ id: 'never-do', service: guard }], [{ id: 'never-do', stages: ['output'], timeoutMs: 1000 }]);
    expect(report.missingStage).toEqual([{ id: 'never-do', stage: 'output' }]);
    const bothStages = await PhraseListGuardrail.create({ id: 'never-do', source });
    expect(checkRequiredGuardrails([{ id: 'never-do', service: bothStages }], [{ id: 'never-do', stages: ['input', 'output'], timeoutMs: 1000 }]).ok).toBe(true);
  });
});
