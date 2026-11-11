// The moderation surface as an application imports it from the installed package. Each block is one real path, and
// the last line prints the count the package test reads. Nothing here calls a provider or the network.
import assert from 'node:assert/strict';
import {
  GuardrailAction, ParallelGuardrailDispatcher, guardrailOutcomeOf, holdResult, isGuardrailHold, toModerationEvaluation,
  type GuardrailContext, type GuardrailEvaluationResult, type GuardrailHold, type IGuardrailService, type ModerationEvaluation,
} from '@framers/agentos/safety/guardrails';
import type { AgentOSInput } from '@framers/agentos';

let items = 0;
const context: GuardrailContext = { userId: 'user-1', sessionId: 'session-1' };
const input = { userId: 'user-1', sessionId: 'session-1', textInput: 'a message' } as AgentOSInput;
const guard = (id: string, evaluation: GuardrailEvaluationResult | null): IGuardrailService => ({ id, evaluateInput: async () => evaluation });

// A hold is a BLOCK that asks for review, and a refusal outranks it.
{
  const hold: GuardrailHold = { reviewCode: 'REVIEW' };
  const held = await ParallelGuardrailDispatcher.evaluateInput([guard('a', holdResult('REVIEW')), guard('b', null)], input, context);
  assert.equal(held.outcome, 'hold');
  assert.deepEqual(held.evaluation?.hold, hold);
  assert.equal(isGuardrailHold(held.evaluation), true);
  items += 1;
  const refused = await ParallelGuardrailDispatcher.evaluateInput([guard('a', holdResult('REVIEW')), guard('c', { action: GuardrailAction.BLOCK, reasonCode: 'RULE_1' })], input, context);
  assert.equal(refused.outcome, 'block');
  assert.equal(refused.evaluation?.reasonCode, 'RULE_1');
  assert.equal(guardrailOutcomeOf(refused.evaluations ?? []), 'block');
  items += 1;
}

// A reported evaluation carries no reason, and a code that is a sentence is replaced.
{
  const reported: ModerationEvaluation = toModerationEvaluation({ action: GuardrailAction.BLOCK, reason: 'meet me at the corner', reasonCode: 'meet me at the corner' });
  assert.equal('reason' in reported, false);
  assert.equal(reported.reasonCode, 'INVALID_CODE');
  items += 1;
}

console.log(`installed moderation surface passes: ${items} items`);
