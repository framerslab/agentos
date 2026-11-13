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
import { verifyActionEvidence } from '../ActionEvidence.js';
import { SqlActionLimiter, type ActionLimitRule } from '../ActionLimiter.js';
import { governTool, governedActionOf, type ActionAuditSink, type ActionGovernance, type GovernedActionIds } from '../GovernedTool.js';
import {
  CONTEXT, DAY, MESSAGES, MUTE_POLICY, OPENAI, RULES, RULE_BOOK, auditSink, capture, message, messageStore, muteOf, muteTool, posted, serve, text, toolCall,
  type Json, type Line, type MuteArgs, type MuteTool, type RecordingSink,
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

    it("(d) a dry run whose answer does not meet the tool's output schema is refused before anything is counted", async () => {
      const limiter = limiterOf();
      const reserve = vi.spyOn(limiter, 'reserve');
      const typed: MuteTool = { ...mute, outputSchema: { type: 'object', properties: { muted: { type: 'boolean' } }, required: ['muted'] } };
      // the default answer, { dryRun: true }, has no `muted`
      const dry = governTool(typed, { ...MUTE_POLICY, dryRunOutput: undefined }, governanceOf(limiter, { mode: 'dryRun' }));
      expect(governance((await viaModel(dry, muteOf(message('m1')))).result)).toMatchObject({ outcome: 'refused_arguments', code: 'POLICY_ERROR' });
      expect(reserve).not.toHaveBeenCalled();
      expect(audit.outcomes()).toEqual(['refused_arguments']);
      // an answer that meets it is the dry run's
      const answered = governTool(typed, MUTE_POLICY, governanceOf(limiter, { mode: 'dryRun' }));
      expect((await viaModel(answered, muteOf(message('m1')))).result).toMatchObject({ success: true, output: { muted: true } });
      expect(mute.execute).not.toHaveBeenCalled();
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

    it('repeated quotes cannot reset the three-attempt retry ceiling', async () => {
      mute = muteTool(async () => ({ success: false, error: 'nothing changed' }));
      const governed = governTool(mute, MUTE_POLICY, governanceOf(limiterOf()));
      const args = muteOf(message('m1'));
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(governance((await viaModel(governed, args)).result).outcome).toBe('failed');
      }
      args.evidence.quotes.push({ ...args.evidence.quotes[0] });
      expect(governance((await viaModel(governed, args)).result)).toMatchObject({ outcome: 'limit_reached', code: 'RETRIES_EXHAUSTED' });
      expect(mute.execute).toHaveBeenCalledTimes(3);
    });

    it('repeated quotes do not make an executed action new', async () => {
      const rules = [RULES[0]];
      const governed = governTool(mute, { ...MUTE_POLICY, limits: rules }, governanceOf(limiterOf(under.prefix(), rules)));
      const args = muteOf(message('m1'));
      expect(governance((await viaModel(governed, args)).result).outcome).toBe('executed');
      args.evidence.quotes.push({ ...args.evidence.quotes[0] });
      expect(governance((await viaModel(governed, args)).result).outcome).toBe('duplicate');
      expect(mute.execute).toHaveBeenCalledTimes(1);
    });

    it('two quotes of one message count as one toward minQuotes', async () => {
      const governed = governTool(mute, { ...MUTE_POLICY, evidence: { minQuotes: 2 } }, governanceOf(limiterOf()));
      const twice = muteOf(message('m1'));
      twice.evidence.quotes.push({ ...twice.evidence.quotes[0] });
      expect(governance((await viaModel(governed, twice)).result)).toMatchObject({ outcome: 'voided_evidence', code: 'NO_QUOTES' });
      const twoParts = muteOf(message('m1'));
      twoParts.evidence.quotes.push({ messageId: 'm1', quote: 'everyone here knows it' });
      expect(governance((await viaModel(governed, twoParts)).result)).toMatchObject({ outcome: 'voided_evidence', code: 'NO_QUOTES' });
      expect(mute.execute).not.toHaveBeenCalled();
      // two messages of the same author meet the rule
      const two = muteOf(message('m1'), { quotes: ['m1', 'm5'].map((id) => ({ messageId: id, quote: message(id).text })) });
      expect(governance((await viaModel(governed, two)).result).outcome).toBe('executed');
    });

    it('a rule listed twice in the limits counts once', async () => {
      const room = { ...RULES[0], max: 1 };
      const rules = [room, { ...room }];
      const governed = governTool(mute, { ...MUTE_POLICY, limits: rules }, governanceOf(limiterOf(under.prefix(), rules)));
      expect(governance((await viaModel(governed, muteOf(message('m1')))).result).outcome).toBe('executed');
      expect(governance((await viaModel(governed, muteOf(message('m2')))).result)).toMatchObject({ outcome: 'limit_reached', code: 'mute_room_hour' });
      expect(mute.execute).toHaveBeenCalledTimes(1);
    });

    it.each(['evidence', 'audit', 'limiter'] as const)('isolates arguments changed while awaiting %s', async (stage) => {
      let callerArgs: MuteArgs | undefined;
      const mutate = () => {
        if (!callerArgs) throw new Error('missing call arguments');
        callerArgs.userId = 'u_victim';
        callerArgs.evidence.ruleId = 'not.in.the.book';
      };
      const limiter = limiterOf();
      const reserve = limiter.reserve.bind(limiter);
      if (stage === 'limiter') vi.spyOn(limiter, 'reserve').mockImplementation(async (request) => {
        mutate();
        return reserve(request);
      });
      const source = messageStore();
      const governed = governTool(mute, MUTE_POLICY, governanceOf(limiter, {
        evidenceSource: { ...source, getMessage: async (id) => {
          if (stage === 'evidence') mutate();
          return source.getMessage(id);
        } },
        audit: { finish: audit.finish, begin: async (record) => {
          await audit.begin(record);
          if (stage === 'audit') mutate();
        } },
      }));
      const exposed: ITool<MuteArgs> = { ...governed, execute: (args, context) => {
        callerArgs = args;
        return governed.execute(args, context);
      } };
      expect(governance((await viaModel(exposed, muteOf(message('m1')))).result).outcome).toBe('executed');
      expect(mute.execute).toHaveBeenCalledTimes(1);
      expect(mute.execute.mock.calls[0][0]).toMatchObject({ userId: 'u_attacker', evidence: { ruleId: 'harassment.1' } });
      expect(audit.begun[0]).toMatchObject({ target: { accountId: 'u_attacker' }, evidence: { ruleId: 'harassment.1' } });
    });

    it('the standalone evidence check keeps the evidence it started checking', async () => {
      const evidence = muteOf(message('m1')).evidence;
      const check = await verifyActionEvidence(evidence, { getMessage: async () => {
        evidence.targetId = 'u_victim';
        evidence.quotes[0].quote = 'a replacement that was never stored';
        return message('m1');
      } }, RULE_BOOK);
      expect(check.ok).toBe(true);
      expect(check.quotes).toEqual([expect.objectContaining({ messageId: 'm1', quoteLength: message('m1').text.length })]);
    });

    it.each([
      { minQuotes: Number.NaN },
      { minQuoteLength: Number.NaN },
    ])('invalid evidence thresholds fail closed: %j', async (evidenceRule) => {
      const limiter = limiterOf();
      const reserve = vi.spyOn(limiter, 'reserve');
      const args = muteOf(message('m1'), { quotes: 'minQuotes' in evidenceRule ? [] : [{ messageId: 'm1', quote: 'Y' }] });
      const governed = governTool(mute, { ...MUTE_POLICY, evidence: evidenceRule }, governanceOf(limiter));
      expect(governance((await viaModel(governed, args)).result)).toMatchObject({ outcome: 'refused_arguments', code: 'POLICY_ERROR' });
      expect(mute.execute).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
      await expect(verifyActionEvidence(args.evidence, messageStore(), RULE_BOOK, evidenceRule)).rejects.toThrow(TypeError);
    });

    it('different target messages remain different actions with the same supporting evidence', async () => {
      type HoldArgs = MuteArgs & { messageId: string };
      const execute = vi.fn(async (_args: HoldArgs) => ({ success: true, output: { held: true } }));
      const hold: ITool<HoldArgs, { held: boolean }> = {
        id: 'hold-message-v1', name: 'hold_message', displayName: 'Hold message', description: 'Holds one message.',
        inputSchema: { type: 'object', properties: { userId: { type: 'string' }, roomId: { type: 'string' }, messageId: { type: 'string' } }, required: ['userId', 'roomId', 'messageId'] },
        execute,
      };
      const rules = [RULES[0]];
      const governed = governTool(hold, {
        action: 'hold_message', limits: rules,
        target: (args) => ({ accountId: args.userId, roomId: args.roomId, messageId: args.messageId }),
      }, governanceOf(limiterOf(under.prefix(), rules)));
      const args = muteOf(message('m1'), { quotes: ['m1', 'm5'].map((id) => ({ messageId: id, quote: message(id).text })) });
      for (const messageId of ['m1', 'm5']) {
        expect(governance((await viaModel(governed, { ...args, messageId })).result).outcome).toBe('executed');
      }
      expect(governance((await viaModel(governed, { ...args, messageId: 'm5' })).result).outcome).toBe('duplicate');
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it('a failed result drops returned reversal data before reaching the caller', async () => {
      mute = muteTool(async (args) => ({ success: false, error: 'nothing changed', details: {
        reversalRef: args.evidence.quotes[0].quote,
        reversal: { previousText: args.evidence.quotes[0].quote }, reversible: true, retryable: true,
      } }));
      const governed = governTool(mute, MUTE_POLICY, governanceOf(limiterOf()));
      const { result } = await viaModel(governed, muteOf(message('m1')));
      expect(governance(result)).toMatchObject({ outcome: 'failed', code: 'REVERSAL_DROPPED' });
      expect(result.details).not.toHaveProperty('reversalRef');
      expect(result.details).not.toHaveProperty('reversal');
      expect(result.details?.retryable).toBe(true);
      expect(audit.finished[0].end).toMatchObject({ outcome: 'failed', code: 'REVERSAL_DROPPED' });
      expect(audit.finished[0].end).not.toHaveProperty('reversalRef');
      expect(JSON.stringify(result)).not.toContain(message('m1').text);
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

    it('(j) an account forgotten while an action on it runs: the same action is not reserved again until the first ends', async () => {
      const rules = [RULES[1]];
      const prefix = under.prefix();
      const limiter = limiterOf(prefix, rules);
      let again: ToolExecutionResult | undefined;
      let nested = false;
      let governed: ITool<MuteArgs> | undefined;
      // while the action runs, the host deletes the account's rows and the same action is asked for again
      mute = muteTool(async (args, context) => {
        if (!nested) {
          nested = true;
          await limiter.forgetTarget('u_attacker');
          again = await (governed as ITool<MuteArgs>).execute(structuredClone(args), context);
        }
        return { success: true, output: { muted: true } };
      });
      governed = governTool(mute, { ...MUTE_POLICY, limits: rules }, governanceOf(limiter));
      expect(governance((await viaModel(governed, muteOf(message('m1')))).result).outcome).toBe('executed');
      expect(governance(again as ToolExecutionResult).outcome).toBe('duplicate');
      expect(mute.execute).toHaveBeenCalledTimes(1);
      // once the action has ended, its rows go
      await limiter.forgetTarget('u_attacker');
      expect(await under.db.all(`SELECT account_id FROM ${prefix}_w${DAY}_reservations`)).toEqual([]);
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

    it("the tool's own refusal before approval is recorded as the governed call's end", async () => {
      const refusing: MuteTool = { ...mute, refusalBeforeApproval: () => ({ success: false, error: 'This room cannot be muted.' }) };
      const governed = governTool(refusing, MUTE_POLICY, governanceOf(limiterOf()));
      const refusal = governed.refusalBeforeApproval?.(muteOf(message('m1')), CONTEXT) as ToolExecutionResult;
      expect(refusal).toMatchObject({ success: false, error: 'This room cannot be muted.', details: { governance: { outcome: 'refused_arguments', code: 'TOOL_REFUSED' } } });
      await vi.waitFor(() => { expect(audit.finished).toHaveLength(1); });
      expect(audit.begun).toEqual([expect.objectContaining({ id: governance(refusal).recordId, target: { messageIds: [] }, evidence: { quotes: [] } })]);
      expect(audit.finished[0].end).toMatchObject({ outcome: 'refused_arguments', code: 'TOOL_REFUSED' });
      expect(lines.filter((line) => line.event === 'action.ended')).toEqual([expect.objectContaining({ outcome: 'refused_arguments', code: 'TOOL_REFUSED' })]);
      // a tool that names no refusal: nothing is answered and nothing recorded
      expect(governTool(mute, MUTE_POLICY, governanceOf(limiterOf())).refusalBeforeApproval?.(muteOf(message('m1')), CONTEXT)).toBeUndefined();
      expect(audit.begun).toHaveLength(1);
      expect(mute.execute).not.toHaveBeenCalled();
    });

    it("(q) a provider's call id reaches no record, whichever step refuses the call", async () => {
      const governed = governTool(mute, MUTE_POLICY, governanceOf(limiterOf()));
      const atOne = await viaModel(governed, muteOf(message('m1'), { targetId: SENTENCE }), 'MeetMeAt221BakerStreet');
      expect(governance(atOne.result).outcome).toBe('refused_arguments');
      const atTwo = await viaModel(governed, muteOf(message('m1'), { ruleId: 'not.in.the.book' }), 'MeetMeAt221BakerStreet');
      expect(governance(atTwo.result)).toMatchObject({ outcome: 'voided_evidence', code: 'UNKNOWN_RULE' });
      expect(audit.begun).toHaveLength(2);
      expect(audit.begun[0].id).toMatch(RECORD_ID);
      expect(audit.begun[1].id).toMatch(RECORD_ID);
      expect(audit.begun[0].id).toBe(governance(atOne.result).recordId);
      expect(audit.begun[1].id).toBe(governance(atTwo.result).recordId);
      expect(audit.finished.map((f) => f.recordId)).toEqual(audit.begun.map((record) => record.id));
      for (const record of audit.begun) expect(Object.keys(record).some((key) => /call|correlation/i.test(key))).toBe(false);
      for (const { end } of audit.finished) expect(Object.keys(end).some((key) => /call|correlation/i.test(key))).toBe(false);
      expect(mute.execute).not.toHaveBeenCalled();
      expect(everything()).not.toContain('MeetMeAt221BakerStreet');
    });
  });
}
