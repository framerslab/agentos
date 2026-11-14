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
import type { AgentOSInput, ITool } from '@framers/agentos';
import { GuardrailStopError, generateText, type TextGuardrailReport } from '@framers/agentos';
import { governTool, governedActionOf, type ActionAuditRecord, type ActionLimiter, type EvidenceSource } from '@framers/agentos/safety/runtime';
import { INJECTION_PROBES, runInjectionProbes } from '@framers/agentos/safety/evaluation';

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

// Guards under generateText(): a blocked prompt stops the call before any request, and a fixed reply takes its place when the guard gives one.
{
  const blocks: IGuardrailService = { id: 'in', evaluateInput: async () => ({ action: GuardrailAction.BLOCK, reasonCode: 'RULE_IN' }) };
  const stopped = await generateText({ provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-fixture-never-sent', prompt: 'a prompt', guards: { services: [blocks], context } }).catch((error: unknown) => error);
  assert.ok(stopped instanceof GuardrailStopError);
  assert.equal(stopped.code, 'GUARDRAIL_BLOCKED');
  const report: TextGuardrailReport = stopped.report;
  assert.equal(report.result, 'stopped');
  items += 1;

  const replaces: IGuardrailService = { id: 'in', evaluateInput: async () => ({ action: GuardrailAction.BLOCK, reasonCode: 'RULE_IN', replacementText: 'A fixed reply.' }) };
  const replaced = await generateText({ provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-fixture-never-sent', prompt: 'a prompt', guards: { services: [replaces], context } });
  assert.equal(replaced.text, 'A fixed reply.');
  assert.equal(replaced.usage.totalTokens, 0);
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

// A governed tool: a quote the store does not hold voids the call, and a call that runs is recorded without its quote.
{
  const stored = { id: 'm1', authorId: 'u1', roomId: 'r1', text: 'You are worthless and everyone here knows it' };
  const source: EvidenceSource = { getMessage: async (id) => (id === stored.id ? stored : null) };
  // a limiter of the fixture's own: the packed package is exercised here, not a store
  const limiter: ActionLimiter = { reserve: async () => ({ status: 'reserved', commit: async () => undefined, release: async () => undefined }) };
  const begun: ActionAuditRecord[] = [];
  let ran = 0;
  let handed: string | undefined;
  const hold: ITool<{ messageId: string; evidence: { targetId: string; roomId?: string; ruleId: string; policyVersion: string; quotes: Array<{ messageId: string; quote: string }> } }> = {
    id: 'hold-message-v1', name: 'hold_message', displayName: 'Hold message', description: 'Holds one message for review.',
    inputSchema: { type: 'object', properties: { messageId: { type: 'string' } }, required: ['messageId'] },
    execute: async (_args, toolContext) => { ran += 1; handed = governedActionOf(toolContext)?.recordId; return { success: true, output: { held: true } }; },
  };
  const governed = governTool(hold, {
    action: 'hold_message',
    target: (args) => ({ accountId: args.evidence.targetId, roomId: args.evidence.roomId, messageId: args.messageId }),
    limits: [{ id: 'hold_room_hour', scope: 'room', windowMs: 3_600_000, max: 10 }],
  }, { actor: { id: 'moderator-1', kind: 'agent' }, mode: 'enforce', limiter, evidenceSource: source, ruleBook: { '2026-11': ['harassment.1'] }, audit: { begin: async (record) => { begun.push(record); }, finish: async () => undefined } });
  const toolContext = { gmiId: 'g', personaId: 'p', userContext: { userId: 'system' } } as Parameters<typeof governed.execute>[1];
  const evidence = { targetId: 'u1', roomId: 'r1', ruleId: 'harassment.1', policyVersion: '2026-11', quotes: [{ messageId: 'm1', quote: 'You are worthless and everyone here knows iT' }] };

  const voided = await governed.execute({ messageId: 'm1', evidence }, toolContext);
  assert.equal(voided.success, false);
  assert.equal(voided.details?.governance.code, 'QUOTE_MISMATCH');
  assert.equal(ran, 0);
  items += 1;

  const executed = await governed.execute({ messageId: 'm1', evidence: { ...evidence, quotes: [{ messageId: 'm1', quote: stored.text }] } }, toolContext);
  assert.equal(executed.details?.governance.outcome, 'executed');
  assert.equal(handed, executed.details?.governance.recordId);
  assert.equal(JSON.stringify(begun).includes('worthless'), false);
  items += 1;
}

// The probes: two or more per technique, and a run in which nothing ran passes with every ask counted.
{
  const perTechnique = new Map<string, number>();
  for (const probe of INJECTION_PROBES) perTechnique.set(probe.technique, (perTechnique.get(probe.technique) ?? 0) + 1);
  assert.equal(perTechnique.size, 10);
  assert.ok([...perTechnique.values()].every((count) => count >= 2));
  const report = await runInjectionProbes({ run: async () => ({ executed: [], proposed: 1 }), authorOf: () => undefined, allowedActions: ['hold_message'], maxExecuted: 1 });
  assert.deepEqual(report, { passed: true, findings: [], proposed: INJECTION_PROBES.length, executed: 0 });
  items += 1;
}

console.log(`installed moderation surface passes: ${items} items`);
