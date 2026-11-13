/**
 * @file supplied-fields.sweep.e2e.test.ts
 * One marker through every field a model, a vendor's call id, a tool or a thrown error supplies, one field per run
 * with every other field genuine: a guarded generateText() tool loop over a governed tool, and the same tool under an
 * agency() approval. The marker has an id's shape, a word's and a constant code's at once. It reaches no audit
 * record, no log line, no guard report and no stop error, and every run still ends as its other fields say.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { agency } from '../../api/agency.js';
import { generateText, type TextGuardrailOptions, type TextGuardrailReport } from '../../api/generateText.js';
import { hitl } from '../../api/hitl.js';
import { AgentOSResponseChunkType } from '../../api/types/AgentOSResponse.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';
import { resetLoggerFactory } from '../../core/logging/loggerFactory.js';
import type { ITool } from '../../core/tools/ITool.js';
import { GuardrailAction, type GuardrailContext, type IGuardrailService } from '../guardrails/IGuardrailService.js';
import { SqlActionLimiter } from '../runtime/ActionLimiter.js';
import { governTool, type ActionGovernance, type GovernedToolPolicy } from '../runtime/GovernedTool.js';
import {
  MUTE_POLICY, OPENAI, RULES, RULE_BOOK, auditSink, capture, message, messageStore, muteOf, muteTool, serve, text, toolCall,
  type Json, type Line, type MuteArgs, type MuteTool, type RecordingSink,
} from '../runtime/__tests__/governedFixtures.js';

const MARK = 'ZZMARK_QX';
/** An error whose message, code and name all carry the marker. */
const marked = (): Error => Object.assign(new Error(MARK), { name: 'ZzmarkQxError', code: MARK });
const context: GuardrailContext = { userId: 'user-1', sessionId: 'session-1' };
const RECORD_ID = /^act_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A guard that notes every tool call, so the report names each one. */
const noting: IGuardrailService = {
  id: 'notes', config: { evaluateToolCalls: true, reasonCodes: ['NOTE_1'] },
  evaluateOutput: async ({ chunk }) => (chunk.type === AgentOSResponseChunkType.TOOL_CALL_REQUEST ? { action: GuardrailAction.FLAG, reasonCode: 'NOTE_1' } : null),
};
type Kept = { report?: TextGuardrailReport; error?: Json };

describe('no supplied field reaches a record, a line, a report or a stop error', () => {
  let db: StorageAdapter;
  let lines: Line[];
  let audit: RecordingSink;
  let mute: MuteTool;
  let made = 0;

  beforeEach(async () => {
    fetchMock.mockReset();
    globalLLMProviderHealth.reset();
    db = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });
    lines = capture();
    audit = auditSink();
    mute = muteTool();
  });
  afterEach(async () => { resetLoggerFactory(); vi.restoreAllMocks(); await db.close(); });

  const governanceOf = (over: Partial<ActionGovernance> = {}): ActionGovernance => ({
    actor: { id: 'moderator-1', kind: 'agent' }, mode: 'enforce',
    limiter: new SqlActionLimiter({ db, rules: RULES, tablePrefix: `sw_${(made += 1)}`, requireShared: false }),
    evidenceSource: messageStore(), ruleBook: RULE_BOOK, audit, ...over,
  });
  const good = (): MuteArgs => muteOf(message('m1'));
  const withEvidence = (over: Json): MuteArgs => ({ ...good(), evidence: { ...good().evidence, ...over } });
  /** One guarded model turn that calls `name` with `args`: the report, or the error the call rejected with. */
  async function turn(tools: Record<string, ITool>, name: string, args: unknown, over: { callId?: string; guards?: Partial<TextGuardrailOptions> } = {}): Promise<Kept> {
    serve(fetchMock, [toolCall(name, args as Json, over.callId ?? 'call_1'), text('done')]);
    try {
      const result = await generateText({ ...OPENAI, prompt: 'moderate the room', tools, maxSteps: 3, guards: { services: [noting], context, ...over.guards } });
      return { report: result.guardReport };
    } catch (error) {
      return { error: { ...(error as object), name: (error as Error).name, message: (error as Error).message } };
    }
  }
  /** Lower-cased, the marker is in nothing a host keeps; every record has a minted id and a hashed key. */
  function clean(kept: Kept, reportKeepsIt = false): void {
    expect(JSON.stringify([audit.begun, audit.finished]).toLowerCase()).not.toContain('zzmark');
    expect(JSON.stringify(lines).toLowerCase()).not.toContain('zzmark');
    if (!reportKeepsIt) expect(JSON.stringify(kept).toLowerCase()).not.toContain('zzmark');
    for (const record of audit.begun) {
      expect(record.id).toMatch(RECORD_ID);
      expect(record.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    }
  }
  const eventsOf = (event: string): Line[] => lines.filter((line) => line.event === event);

  it.each([
    ['evidence.targetId', { targetId: MARK }, 'TARGET_MISMATCH'],
    ['evidence.roomId', { roomId: MARK }, 'TARGET_MISMATCH'],
    ['evidence.ruleId', { ruleId: MARK }, 'UNKNOWN_RULE'],
    ['evidence.policyVersion', { policyVersion: MARK }, 'UNKNOWN_POLICY_VERSION'],
    ["a quote's messageId", { quotes: [{ messageId: MARK, quote: 'You are worthless and everyone here knows it' }] }, 'MESSAGE_NOT_FOUND'],
    ['a verdictRefs entry', { verdictRefs: [MARK] }, 'VERDICT_NOT_FOUND'],
  ] as const)('%s', async (_field, over, code) => {
    const kept = await turn({ mute_in_room: governTool(mute, MUTE_POLICY, governanceOf()) }, 'mute_in_room', withEvidence(over as Json));
    expect(audit.finished.map((f) => [f.end.outcome, f.end.code])).toEqual([['voided_evidence', code]]);
    expect(mute.execute).not.toHaveBeenCalled();
    clean(kept);
  });

  it("the provider's tool call id, and a call that names an unregistered tool", async () => {
    const governed = governTool(mute, MUTE_POLICY, governanceOf());
    const byId = await turn({ mute_in_room: governed }, 'mute_in_room', good(), { callId: MARK });
    expect(audit.outcomes()).toEqual(['executed']);
    expect(byId.report?.toolCalls).toEqual([expect.objectContaining({ toolCallId: 'tc_1_0', toolName: 'mute_in_room' })]);
    clean(byId);
    const byName = await turn({ mute_in_room: governed }, MARK, good());
    expect(byName.report?.toolCalls).toEqual([expect.objectContaining({ toolCallId: 'tc_1_0', toolName: 'unregistered' })]);
    expect(audit.outcomes()).toEqual(['executed']);
    clean(byName);
  });

  it("a policy's idempotencyKey() and expiresAt() that return what the model wrote", async () => {
    type Noted = MuteArgs & { note?: string };
    const keyed: GovernedToolPolicy<Noted> = { ...(MUTE_POLICY as GovernedToolPolicy<Noted>), idempotencyKey: (args) => String(args.note) };
    clean(await turn({ mute_in_room: governTool(mute as never, keyed, governanceOf()) }, 'mute_in_room', { ...good(), note: MARK }));
    expect(audit.outcomes()).toEqual(['executed']);
    const dated: GovernedToolPolicy<Noted> = { ...(MUTE_POLICY as GovernedToolPolicy<Noted>), expiresAt: (args) => String(args.note) };
    clean(await turn({ mute_in_room: governTool(mute as never, dated, governanceOf()) }, 'mute_in_room', { ...muteOf(message('m2')), note: MARK }));
    expect(audit.finished.at(-1)?.end).toMatchObject({ outcome: 'refused_arguments', code: 'POLICY_ERROR' });
    expect(mute.execute).toHaveBeenCalledTimes(1);
  });

  it('a tool that returns it as its reversal, and a tool that throws it', async () => {
    const returning = muteTool(async () => ({ success: true, output: { muted: true }, details: { reversalRef: MARK, reversal: { previousText: MARK } } }));
    clean(await turn({ mute_in_room: governTool(returning, MUTE_POLICY, governanceOf()) }, 'mute_in_room', good()));
    expect(audit.finished.at(-1)?.end).toMatchObject({ outcome: 'executed', code: 'REVERSAL_DROPPED' });
    const throwing = muteTool(async () => { throw marked(); });
    clean(await turn({ mute_in_room: governTool(throwing, MUTE_POLICY, governanceOf()) }, 'mute_in_room', muteOf(message('m2'))));
    expect(audit.outcomes()).toEqual(['executed', 'failed']);
  });

  it("an audit sink's finish(), a host guard and an onVerdict that each throw it", async () => {
    const sink = { begin: audit.begin, finish: async () => { throw marked(); } };
    clean(await turn({ mute_in_room: governTool(mute, MUTE_POLICY, governanceOf({ audit: sink })) }, 'mute_in_room', good()));
    expect(mute.execute).toHaveBeenCalledTimes(1);
    expect(eventsOf('action.audit_failed')).toEqual([expect.objectContaining({ half: 'finish', type: 'unknown', code: 'unknown' })]);

    const thrower: IGuardrailService = { id: 'thrower', evaluateInput: async () => { throw marked(); } };
    const stopped = await turn({ mute_in_room: governTool(mute, MUTE_POLICY, governanceOf()) }, 'mute_in_room', muteOf(message('m2')), { guards: { services: [thrower] } });
    expect(stopped.error).toMatchObject({ name: 'GuardrailStopError', code: 'GUARDRAIL_UNAVAILABLE' });
    expect(eventsOf('guardrail.failed')).toEqual([expect.objectContaining({ guardrailId: 'thrower', type: 'unknown', code: 'unknown' })]);
    clean(stopped);

    clean(await turn({ mute_in_room: governTool(mute, MUTE_POLICY, governanceOf()) }, 'mute_in_room', muteOf(message('m3')), { guards: { onVerdict: () => { throw marked(); } } }));
    expect(eventsOf('guardrail.verdict_callback_failed')).toEqual([expect.objectContaining({ type: 'unknown', code: 'unknown' })]);
    expect(mute.execute).toHaveBeenCalledTimes(2);
  });

  it('a host guard that answers it as a code it does not list: the report keeps the code, the line writes unknown', async () => {
    const coder: IGuardrailService = { id: 'coder', evaluateInput: async () => ({ action: GuardrailAction.FLAG, reasonCode: MARK }) };
    const kept = await turn({ mute_in_room: governTool(mute, MUTE_POLICY, governanceOf()) }, 'mute_in_room', good(), { guards: { services: [coder, noting] } });
    expect(kept.report?.input).toEqual([expect.objectContaining({ reasonCode: MARK })]);
    expect(eventsOf('guardrail.verdict').filter((line) => line.guardrailId === 'coder')).toEqual([expect.objectContaining({ stage: 'input', action: 'flag', code: 'unknown' })]);
    expect(audit.outcomes()).toEqual(['executed']);
    clean(kept, true);
  });

  it('under an agency() approval, an approvalRequested that throws it', async () => {
    const team = agency({
      provider: 'openai', model: 'gpt-4.1', apiKey: OPENAI.apiKey,
      tools: { mute_in_room: governTool(mute, MUTE_POLICY, governanceOf()) },
      agents: { moderator: { instructions: 'Mute the account when asked.' } },
      strategy: 'sequential',
      hitl: { approvals: { beforeTool: ['mute_in_room'] }, handler: hitl.autoApprove(), postApprovalGuardrails: [] },
      on: { approvalRequested: () => { throw marked(); } },
    } as never);
    serve(fetchMock, [toolCall('mute_in_room', good(), MARK), text('done')]);
    expect(((await team.generate('mute the account')) as { text: string }).text).toBe('done');
    expect(eventsOf('agency.callback_failed')).toEqual([expect.objectContaining({ callback: 'approvalRequested', type: 'unknown', code: 'unknown' })]);
    expect(audit.outcomes()).toEqual(['executed']);
    clean({});
  });
});
