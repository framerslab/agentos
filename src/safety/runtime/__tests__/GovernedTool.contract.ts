/**
 * @file GovernedTool.contract.ts
 * A governed tool as a model's tool loop runs it: the real generateText() (only fetch is stubbed) over a tool wrapped
 * by governTool(), a SQL limiter on the store under test, an in-memory message store and an audit sink that records
 * what it is given. Each case names the call that must not act, and what the audit record may hold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageAdapter } from '@framers/sql-storage-adapter';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { generateText } from '../../../api/generateText.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import { resetLoggerFactory } from '../../../core/logging/loggerFactory.js';
import type { ITool, ToolExecutionContext, ToolExecutionResult } from '../../../core/tools/ITool.js';
import { SqlActionLimiter, type ActionLimitRule } from '../ActionLimiter.js';
import { governTool, governedActionOf, type ActionAuditSink, type ActionGovernance, type GovernedActionIds } from '../GovernedTool.js';
import {
  DAY, MESSAGES, MUTE_POLICY, OPENAI, RULES, RULE_BOOK, auditSink, capture, message, messageStore, muteOf, muteTool, posted, serve, text, toolCall,
  type Json, type Line, type MuteTool, type RecordingSink,
} from './governedFixtures.js';

/** The store a suite runs on. `prefix()` answers a table prefix no other test uses; `close()` removes what the test made. */
export interface StoreUnderTest { db: StorageAdapter; prefix(): string; close(): Promise<void> }

const RECORD_ID = /^act_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVERSAL_KEY = /^rev_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SENTENCE = 'the user above broke every rule we have';

export function runGovernedToolSuite(name: string, open: () => Promise<StoreUnderTest>): void {
  describe(`a governed tool under generateText(), ${name}`, () => {
    let under: StoreUnderTest;
    let lines: Line[];
    let audit: RecordingSink;
    let mute: MuteTool;

    beforeEach(async () => {
      fetchMock.mockReset();
      globalLLMProviderHealth.reset();
      under = await open();
      lines = capture();
      audit = auditSink();
      mute = muteTool();
    });
    afterEach(async () => {
      // no audit record holds a quote, in any case
      const written = JSON.stringify([audit.begun, audit.finished]);
      for (const stored of MESSAGES) if (stored.text.length >= 12) expect(written).not.toContain(stored.text);
      resetLoggerFactory();
      vi.restoreAllMocks();
      await under.close();
    });

    const limiterOf = (prefix = under.prefix(), rules: readonly ActionLimitRule[] = RULES): SqlActionLimiter =>
      new SqlActionLimiter({ db: under.db, rules, tablePrefix: prefix, requireShared: false });
    const governanceOf = (limiter: SqlActionLimiter, over: Partial<ActionGovernance> = {}): ActionGovernance => ({
      actor: { id: 'moderator-1', kind: 'agent', model: 'gpt-4.1' }, mode: 'enforce', limiter,
      evidenceSource: messageStore(), ruleBook: RULE_BOOK, audit, ...over,
    });
    /** One model turn that calls the tool through the real loop: what the loop received from the tool, and what the model was told. */
    async function viaModel(tool: ITool, args: unknown, callId = 'call_1'): Promise<{ result: ToolExecutionResult; told: unknown }> {
      const received: ToolExecutionResult[] = [];
      const recorded: ITool = { ...tool, execute: async (a: never, c: ToolExecutionContext) => { const r = await tool.execute(a, c); received.push(r); return r; } };
      serve(fetchMock, [toolCall(tool.name, args as Json, callId), text('done')]);
      const reply = await generateText({ ...OPENAI, prompt: 'moderate the room', tools: { [tool.name]: recorded }, maxSteps: 3 });
      expect(reply.text).toBe('done');
      expect(received).toHaveLength(1);
      const turn = (posted(fetchMock).at(-1) as Json).messages.find((m: Json) => m.role === 'tool');
      return { result: received[0], told: JSON.parse(turn.content) };
    }
    const governance = (result: ToolExecutionResult): { outcome: string; code?: string; recordId: string } => result.details?.governance;
    const everything = (): string => JSON.stringify([audit.begun, audit.finished, lines]);

    it('(a) a quote that differs from the stored message by one character voids the action', async () => {
      const governed = governTool(mute, MUTE_POLICY, governanceOf(limiterOf()));
      const { result, told } = await viaModel(governed, muteOf(message('m1'), { quotes: [{ messageId: 'm1', quote: 'You are worthless and everyone here knows iT' }] }));
      expect(result.success).toBe(false);
      expect(governance(result)).toMatchObject({ outcome: 'voided_evidence', code: 'QUOTE_MISMATCH' });
      expect(typeof told).toBe('string');
      expect(String(told)).not.toContain('worthless');
      expect(mute.execute).not.toHaveBeenCalled();
      expect(audit.outcomes()).toEqual(['voided_evidence']);
      expect(lines.filter((line) => line.event === 'action.ended')).toEqual([expect.objectContaining({ action: 'mute_in_room', outcome: 'voided_evidence', code: 'QUOTE_MISMATCH', mode: 'enforce' })]);
    });

    it('(b) a target who did not write the quoted message voids the action', async () => {
      const governed = governTool(mute, MUTE_POLICY, governanceOf(limiterOf()));
      const args = { userId: 'u_victim', roomId: 'r1', evidence: { ...muteOf(message('m1')).evidence, targetId: 'u_victim' } };
      expect(governance((await viaModel(governed, args)).result)).toMatchObject({ outcome: 'voided_evidence', code: 'AUTHOR_MISMATCH' });
      expect(mute.execute).not.toHaveBeenCalled();
    });

    it('(c) a fourth mute in one room within the hour is refused, across two limiters on one store', async () => {
      const prefix = under.prefix();
      const first = governTool(mute, MUTE_POLICY, governanceOf(limiterOf(prefix)));
      for (const id of ['m1', 'm2', 'm3']) expect(governance((await viaModel(first, muteOf(message(id)))).result).outcome).toBe('executed');
      const second = governTool(mute, MUTE_POLICY, governanceOf(limiterOf(prefix)));
      expect(governance((await viaModel(second, muteOf(message('m4')))).result)).toMatchObject({ outcome: 'limit_reached', code: 'mute_room_hour' });
      expect(mute.execute).toHaveBeenCalledTimes(3);
    });

    it('(d) a dry run answers as the tool would, runs nothing and takes nothing from the real allowance', async () => {
      const limiter = limiterOf();
      const dry = governTool(mute, MUTE_POLICY, governanceOf(limiter, { mode: 'dryRun' }));
      const { result, told } = await viaModel(dry, muteOf(message('m1')));
      expect(result).toMatchObject({ success: true, output: { muted: true }, details: { dryRun: true, governance: { outcome: 'would_execute' } } });
      expect(told).toEqual({ muted: true });
      expect(mute.execute).not.toHaveBeenCalled();
      expect(audit.begun[0].mode).toBe('dryRun');
      // the same action for real: the target's one mute a day is still there
      const real = governTool(mute, MUTE_POLICY, governanceOf(limiter));
      expect(governance((await viaModel(real, muteOf(message('m1')))).result).outcome).toBe('executed');
      expect(mute.execute).toHaveBeenCalledTimes(1);
    });

    it('(e) an audit sink that cannot write refuses the action, and nothing was reserved', async () => {
      const limiter = limiterOf();
      const reserve = vi.spyOn(limiter, 'reserve');
      const down: ActionAuditSink = { begin: async () => { throw new Error('the sink is down'); }, finish: audit.finish };
      const governed = governTool(mute, MUTE_POLICY, governanceOf(limiter, { audit: down }));
      expect(governance((await viaModel(governed, muteOf(message('m1')))).result).outcome).toBe('audit_unavailable');
      expect(reserve).not.toHaveBeenCalled();
      expect(mute.execute).not.toHaveBeenCalled();
      expect(lines.filter((line) => line.event === 'action.audit_failed')).toEqual([expect.objectContaining({ action: 'mute_in_room', half: 'begin', type: 'Error', code: 'unknown' })]);
    });

    it('(f) the same call twice runs once', async () => {
      const governed = governTool(mute, MUTE_POLICY, governanceOf(limiterOf()));
      expect(governance((await viaModel(governed, muteOf(message('m1')))).result).outcome).toBe('executed');
      expect(governance((await viaModel(governed, muteOf(message('m1')))).result).outcome).toBe('duplicate');
      expect(mute.execute).toHaveBeenCalledTimes(1);
    });

    it('(g) a call that quotes one account and acts on another is voided', async () => {
      const governed = governTool(mute, MUTE_POLICY, governanceOf(limiterOf()));
      const args = { ...muteOf(message('m1')), userId: 'u_victim' };
      expect(governance((await viaModel(governed, args)).result)).toMatchObject({ outcome: 'voided_evidence', code: 'TARGET_MISMATCH' });
      expect(mute.execute).not.toHaveBeenCalled();
    });

    it('(h) a tool that fails is not counted, and its action may be asked for three times in all', async () => {
      mute = muteTool(async () => ({ success: false, error: 'nothing changed' }));
      const governed = governTool(mute, MUTE_POLICY, governanceOf(limiterOf()));
      for (let attempt = 0; attempt < 3; attempt += 1) expect(governance((await viaModel(governed, muteOf(message('m1')))).result).outcome).toBe('failed');
      expect(governance((await viaModel(governed, muteOf(message('m1')))).result)).toMatchObject({ outcome: 'limit_reached', code: 'RETRIES_EXHAUSTED' });
      expect(mute.execute).toHaveBeenCalledTimes(3);
    });

    it('(j) a limiter that never reserved forgets one target by exact key', async () => {
      const prefix = under.prefix();
      const governed = governTool(mute, MUTE_POLICY, governanceOf(limiterOf(prefix)));
      for (const id of ['m9', 'm10']) expect(governance((await viaModel(governed, muteOf(message(id)))).result).outcome).toBe('executed');
      await limiterOf(prefix).forgetTarget('a_b');
      const daily = `${prefix}_w${DAY}`;
      expect(await under.db.all<{ account_id: string }>(`SELECT account_id FROM ${daily}_reservations`)).toEqual([{ account_id: 'mute_target_day|t:axb' }]);
      expect(await under.db.all<{ account_id: string }>(`SELECT account_id FROM ${daily}_meter`)).toEqual([{ account_id: 'mute_target_day|t:axb' }]);
    });

    it('(k) evidence whose target is a sentence is refused, and the sentence is written nowhere', async () => {
      const governed = governTool(mute, MUTE_POLICY, governanceOf(limiterOf()));
      const { result } = await viaModel(governed, muteOf(message('m1'), { targetId: SENTENCE }));
      expect(governance(result)).toMatchObject({ outcome: 'refused_arguments', code: 'ARGUMENT_SHAPE' });
      expect(mute.execute).not.toHaveBeenCalled();
      expect(audit.begun).toHaveLength(1);
      expect(audit.begun[0]).toMatchObject({ target: { messageIds: [] }, evidence: { quotes: [] } });
      expect(everything()).not.toContain('broke every rule');
    });

    it('(l) the reversal key is the one the library made, never a value the tool returns', async () => {
      const limiter = limiterOf();
      // a tool that answers the quote itself as its reversal key
      const echoing = muteTool(async (args) => ({ success: true, output: { muted: true }, details: { reversalRef: args.evidence.quotes[0].quote } }));
      const first = await viaModel(governTool(echoing, MUTE_POLICY, governanceOf(limiter)), muteOf(message('m6')));
      expect(governance(first.result)).toMatchObject({ outcome: 'executed', code: 'REVERSAL_DROPPED' });
      expect(audit.finished[0].end).toMatchObject({ outcome: 'executed', code: 'REVERSAL_DROPPED' });
      expect('reversalRef' in audit.finished[0].end).toBe(false);
      expect(Object.values(audit.finished[0].end)).not.toContain('rev_1');
      // a tool that answers an object holding the quote
      const holding = muteTool(async (args) => ({ success: true, output: { muted: true }, details: { reversal: { previousText: args.evidence.quotes[0].quote } } }));
      const second = await viaModel(governTool(holding, MUTE_POLICY, governanceOf(limiter)), muteOf(message('m1')));
      expect(governance(second.result)).toMatchObject({ outcome: 'executed', code: 'REVERSAL_DROPPED' });
      expect('reversalRef' in audit.finished[1].end).toBe(false);
      expect(JSON.stringify(audit.finished[1])).not.toContain('worthless');
      // a tool that files its reversal under the key it was handed
      let handed: GovernedActionIds | undefined;
      const filing = muteTool(async (_args, context) => { handed = governedActionOf(context); return { success: true, output: { muted: true }, details: { reversible: true } }; });
      const third = await viaModel(governTool(filing, MUTE_POLICY, governanceOf(limiter)), muteOf(message('m3')));
      expect(handed?.reversalRef).toMatch(REVERSAL_KEY);
      expect(handed?.recordId).toBe(governance(third.result).recordId);
      expect(audit.finished[2].end).toMatchObject({ outcome: 'executed', reversalRef: handed?.reversalRef });
      expect(audit.finished[2].end.code).toBeUndefined();
    });

    it('(m) a rule, a policy version and a verdict the host does not hold void the action', async () => {
      const governed = governTool(mute, MUTE_POLICY, governanceOf(limiterOf()));
      const of = async (over: Json) => governance((await viaModel(governed, muteOf(message('m1'), over))).result);
      expect(await of({ ruleId: 'MeetMeAt221BakerStreet' })).toMatchObject({ outcome: 'voided_evidence', code: 'UNKNOWN_RULE' });
      expect(await of({ policyVersion: '2025-01' })).toMatchObject({ outcome: 'voided_evidence', code: 'UNKNOWN_POLICY_VERSION' });
      expect(await of({ verdictRefs: ['v_missing'] })).toMatchObject({ outcome: 'voided_evidence', code: 'VERDICT_NOT_FOUND' });
      expect(mute.execute).not.toHaveBeenCalled();
      expect(everything()).not.toContain('MeetMeAt221BakerStreet');
    });

    it("(q) a provider's call id reaches no record, whichever step refuses the call", async () => {
      const governed = governTool(mute, MUTE_POLICY, governanceOf(limiterOf()));
      const atOne = await viaModel(governed, muteOf(message('m1'), { targetId: SENTENCE }), 'MeetMeAt221BakerStreet');
      expect(governance(atOne.result).outcome).toBe('refused_arguments');
      const atTwo = await viaModel(governed, muteOf(message('m1'), { ruleId: 'not.in.the.book' }), 'MeetMeAt221BakerStreet');
      expect(governance(atTwo.result)).toMatchObject({ outcome: 'voided_evidence', code: 'UNKNOWN_RULE' });
      expect(audit.begun).toHaveLength(2);
      expect(audit.begun[0].id).toMatch(RECORD_ID);
      expect(audit.begun[0].id).toBe(governance(atOne.result).recordId);
      expect(audit.begun[1].id).toBe(governance(atTwo.result).recordId);
      for (const record of audit.begun) expect(Object.keys(record).some((key) => /call|correlation/i.test(key))).toBe(false);
      expect(mute.execute).not.toHaveBeenCalled();
      expect(everything()).not.toContain('MeetMeAt221BakerStreet');
    });
  });
}
