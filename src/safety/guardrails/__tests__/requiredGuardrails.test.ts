/**
 * @file requiredGuardrails.test.ts
 * A required guard is held to the stages it declares: a guard that has both methods but runs on one stage does not
 * cover the other, and the phrase-list guard declares the stages it was built with. A required guard's answer with no
 * recognised action blocks, says its cause, and writes one line.
 */
import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { GuardrailAction, type GuardrailContext, type GuardrailEvaluationResult, type IGuardrailService } from '../IGuardrailService';
import type { AgentOSInput } from '../../../api/types/AgentOSInput';
import { PhraseListGuardrail, StaticPhraseListSource } from '../builtin/PhraseListGuardrail';
import { checkRequiredGuardrails, withRequiredPosture } from '../requiredGuardrails';
import { resetLoggerFactory, setLogger } from '../../../core/logging/loggerFactory.js';

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

describe('withRequiredPosture', () => {
  afterEach(() => { resetLoggerFactory(); });

  it('turns an answer with no recognised action into a block that says its cause, with one guardrail.failed line', async () => {
    const lines: Array<Record<string, unknown>> = [];
    setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { lines.push(JSON.parse(line)); } }));
    const nonsense: IGuardrailService = { evaluateInput: async () => ({ action: 'maybe' } as unknown as GuardrailEvaluationResult) };
    const required = withRequiredPosture('safety-gate', nonsense, { id: 'safety-gate', stages: ['input'], timeoutMs: 1000 });
    const context: GuardrailContext = { userId: 'user-1', sessionId: 'session-1' };
    const block = await required.evaluateInput!({ context, input: { userId: 'user-1', sessionId: 'session-1', textInput: 'a message' } as AgentOSInput });
    expect(block).toMatchObject({ action: GuardrailAction.BLOCK, reasonCode: 'GUARDRAIL_MALFORMED' });
    expect(block?.metadata).toEqual({ failClosed: true, cause: 'malformed', guardrailId: 'safety-gate' });
    expect(lines.filter((line) => line.event === 'guardrail.failed')).toEqual([
      expect.objectContaining({ guardrailId: 'safety-gate', stage: 'input', posture: 'closed', cause: 'malformed' }),
    ]);
  });

  it('turns an answer of undefined into the same block, and keeps null as an allow', async () => {
    const context: GuardrailContext = { userId: 'user-1', sessionId: 'session-1' };
    const input = { userId: 'user-1', sessionId: 'session-1', textInput: 'a message' } as AgentOSInput;
    const silent: IGuardrailService = { evaluateInput: async () => undefined as unknown as null };
    const required = withRequiredPosture('safety-gate', silent, { id: 'safety-gate', stages: ['input'], timeoutMs: 1000 });
    expect(await required.evaluateInput!({ context, input })).toMatchObject({ action: GuardrailAction.BLOCK, reasonCode: 'GUARDRAIL_MALFORMED', metadata: { failClosed: true, cause: 'malformed' } });
    const quiet = withRequiredPosture('safety-gate', { evaluateInput: async () => null }, { id: 'safety-gate', stages: ['input'], timeoutMs: 1000 });
    expect(await quiet.evaluateInput!({ context, input })).toBeNull();
  });

  it('turns an action that only prints as one (a String object) into the same block', async () => {
    const context: GuardrailContext = { userId: 'user-1', sessionId: 'session-1' };
    const input = { userId: 'user-1', sessionId: 'session-1', textInput: 'a message' } as AgentOSInput;
    // eslint-disable-next-line no-new-wrappers
    const boxed: IGuardrailService = { evaluateInput: async () => ({ action: new String(GuardrailAction.BLOCK) } as unknown as GuardrailEvaluationResult) };
    const required = withRequiredPosture('safety-gate', boxed, { id: 'safety-gate', stages: ['input'], timeoutMs: 1000 });
    expect(await required.evaluateInput!({ context, input })).toMatchObject({ action: GuardrailAction.BLOCK, reasonCode: 'GUARDRAIL_MALFORMED', metadata: { cause: 'malformed', guardrailId: 'safety-gate' } });
  });
});
