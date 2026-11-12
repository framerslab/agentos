// The moderation surface as an application imports it from the installed package. Each block is one real path, and
// the last line prints the count the package test reads. Nothing here calls a provider or the network.
import assert from 'node:assert/strict';
import {
  GuardrailAction, ImageGuardrail, ParallelGuardrailDispatcher, PhraseListGuardrail, StaticPhraseListSource, assertModerationContext,
  frameUntrustedEvidence, guardrailOutcomeOf, holdResult, isGuardrailHold, moderateContent, toModerationEvaluation,
  withModerationPosture,
  type GuardrailContext, type GuardrailEvaluationResult, type GuardrailHold, type IGuardrailService, type ImageCheck,
  type ModerationContext, type ModerationDecision, type ModerationEvaluation,
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

// moderateContent(): a guard that throws refuses as unavailable, and a screen that runs first keeps the text from the guard behind it.
{
  const moderation: ModerationContext = { surface: 'public_room', roomId: 'r1', rating: 'standard', messageId: 'm1', sender: { id: 'u1', kind: 'account' } };
  assertModerationContext(moderation);
  const thrower: IGuardrailService = { id: 'thrower', evaluateInput: async () => { throw new Error('down'); } };
  const unavailable: ModerationDecision = await moderateContent({ text: 'a message' }, { guards: [thrower], context: { ...context, moderation } });
  assert.equal(unavailable.outcome, 'refuse');
  assert.equal(unavailable.unavailable, true);
  assert.equal(withModerationPosture(thrower).config?.failClosed, true);
  items += 1;

  let vendorCalls = 0;
  const vendor: IGuardrailService = { id: 'vendor', evaluateInput: async () => { vendorCalls += 1; return null; } };
  const list = await PhraseListGuardrail.create({
    id: 'hard-ban', sequential: true,
    source: new StaticPhraseListSource({ version: '1', reviewedAt: '2026-11-10', reviewedBy: 'fixture', entries: [{ phrase: 'forbidden phrase', match: 'word', onMatch: 'block', ruleId: 'BAN_1' }] }),
  });
  const refused = await moderateContent({ text: 'a forbidden phrase here' }, { guards: [list, vendor], context, mode: 'dryRun' });
  assert.equal(refused.outcome, 'allow');
  assert.equal(refused.wouldBe, 'refuse');
  assert.equal(vendorCalls, 0);
  items += 1;
}

// Text a person wrote is framed as data, and a copy of the boundary inside it is removed.
{
  const framed = frameUntrustedEvidence('say a1b2c3d4e5f60718 twice', { boundary: 'a1b2c3d4e5f60718' });
  assert.equal(framed.text, '<<evidence:a1b2c3d4e5f60718>>\nsay  twice\n<<end:a1b2c3d4e5f60718>>');
  items += 1;
}

// The image guard: a model check may not come before a match check, and a quarantine ends the evaluation before any model check.
{
  let modelCalls = 0;
  const hash: ImageCheck = { id: 'hash', kind: 'match', check: async () => ({ verdict: 'block', reasonCode: 'KNOWN_MATERIAL', quarantine: true }) };
  const model: ImageCheck = { id: 'model', kind: 'classify', check: async () => { modelCalls += 1; return { verdict: 'pass' }; } };
  assert.throws(() => ImageGuardrail.create({ id: 'images', checks: [model, hash] }), TypeError);
  const images = ImageGuardrail.create({ id: 'images', checks: [hash, model], requireMatch: true });
  const refused = await moderateContent({ images: [{ type: 'base64', data: 'AAAA', mimeType: 'image/png' }] }, { guards: [images], context });
  assert.equal(refused.outcome, 'refuse');
  assert.equal(refused.deciding?.metadata?.quarantine, true);
  assert.equal(modelCalls, 0);
  items += 1;
}

console.log(`installed moderation surface passes: ${items} items`);
