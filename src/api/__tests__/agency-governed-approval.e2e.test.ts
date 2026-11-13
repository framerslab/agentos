/**
 * @file agency-governed-approval.e2e.test.ts
 * A governed tool under a real agency() whose approvals name it: the approval is asked, the governed call runs, and a
 * callback that throws what it was shown writes one typed line that holds none of it. Real agency(), generateText and
 * OpenAIProvider; only fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { agency, runPostApprovalGuardrails } from '../agency.js';
import { hitl } from '../hitl.js';
import { APPROVAL_GRANTED, createApprovalGate, createApprovalSlot } from '../runtime/approval-gate.js';
import type { ApprovalRequest } from '../types.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';
import { resetLoggerFactory } from '../../core/logging/loggerFactory.js';
import { SqlActionLimiter } from '../../safety/runtime/ActionLimiter.js';
import { governTool, type GovernedToolPolicy } from '../../safety/runtime/GovernedTool.js';
import {
  MUTE_POLICY, OPENAI, RULES, RULE_BOOK, auditSink, capture, message, messageStore, muteOf, muteTool, serve, text, toolCall,
  type Line, type MuteArgs, type MuteTool, type RecordingSink,
} from '../../safety/runtime/__tests__/governedFixtures.js';

describe('(n) an approval callback that throws what it was shown', () => {
  // one mute a day per account, and no room limit: the four runs below mute four accounts in one room
  const DAILY = [RULES[1]];
  const policy: GovernedToolPolicy<MuteArgs> = { ...MUTE_POLICY, limits: DAILY };
  let db: StorageAdapter;
  let lines: Line[];
  let audit: RecordingSink;
  let mute: MuteTool;

  beforeEach(async () => {
    fetchMock.mockReset();
    globalLLMProviderHealth.reset();
    db = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });
    lines = capture();
    audit = auditSink();
    mute = muteTool();
  });
  afterEach(async () => { resetLoggerFactory(); vi.restoreAllMocks(); await db.close(); });

  /** One agency run that mutes the author of `id` after an approval whose callback throws `thrown(<the call's first quote>)`. */
  async function run(id: string, thrown: (quote: string) => unknown): Promise<Line[]> {
    const limiter = new SqlActionLimiter({ db, rules: DAILY, tablePrefix: 'gt_n', requireShared: false });
    const governed = governTool(mute, policy, { actor: { id: 'moderator-1', kind: 'agent' }, mode: 'enforce', limiter, evidenceSource: messageStore(), ruleBook: RULE_BOOK, audit });
    const team = agency({
      provider: 'openai', model: 'gpt-4.1', apiKey: OPENAI.apiKey,
      tools: { mute_in_room: governed },
      agents: { moderator: { instructions: 'Mute the account when asked.' } },
      strategy: 'sequential',
      // the governed tool's own evidence check stands in for the pattern checks, which read the quote
      hitl: { approvals: { beforeTool: ['mute_in_room'] }, handler: hitl.autoApprove(), postApprovalGuardrails: [] },
      on: { approvalRequested: (request: ApprovalRequest) => { throw thrown((request.details as { args: MuteArgs }).args.evidence.quotes[0].quote); } },
    } as never);
    serve(fetchMock, [toolCall('mute_in_room', muteOf(message(id))), text('done')]);
    const before = lines.length;
    const result = (await team.generate('mute the account')) as { text: string };
    expect(result.text).toBe('done');
    return lines.slice(before).filter((line) => line.event === 'agency.callback_failed');
  }

  it('writes one line per throw with a listed type and code and none of the words, and the call goes on', async () => {
    const warned = vi.spyOn(console, 'warn');

    expect(await run('m1', (quote) => new Error(quote))).toEqual([expect.objectContaining({ callback: 'approvalRequested', type: 'Error', code: 'unknown' })]);
    expect(JSON.stringify(lines)).not.toContain('worthless');

    // a stored message whose whole text has a code's shape, thrown back as the error's code and message
    expect(await run('m7', (quote) => Object.assign(new Error(quote), { code: quote }))).toEqual([expect.objectContaining({ callback: 'approvalRequested', type: 'Error', code: 'unknown' })]);
    expect(JSON.stringify(lines)).not.toContain('PERSONAL_DATA');

    expect(await run('m3', () => Object.assign(new Error('x'), { name: 'MeetMeAtBakerStreetError' }))).toEqual([expect.objectContaining({ callback: 'approvalRequested', type: 'unknown', code: 'unknown' })]);
    expect(JSON.stringify(lines)).not.toContain('MeetMeAt');

    expect(await run('m4', () => Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toEqual([expect.objectContaining({ callback: 'approvalRequested', type: 'Error', code: 'ECONNRESET' })]);

    expect(warned.mock.calls.filter(([first]) => /callback threw/.test(String(first)))).toEqual([]);
    expect(mute.execute).toHaveBeenCalledTimes(4);
    expect(audit.outcomes()).toEqual(['executed', 'executed', 'executed', 'executed']);
  });
});

describe("the post-approval check's guardrailResult callback, called with a host's own callbacks", () => {
  afterEach(() => { resetLoggerFactory(); vi.restoreAllMocks(); });

  it('a callback that throws what it was shown writes one typed line and nothing to the console, and the check still blocks', async () => {
    const lines = capture();
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const quote = message('m1').text;
    const args = { evidence: { quotes: [{ messageId: 'm1', quote }] }, command: 'rm -rf /tmp/cache' };
    const result = await runPostApprovalGuardrails('mute_in_room', args, ['code-safety'], {
      guardrailResult: () => { throw new Error(`the check saw ${quote}`); },
    });
    expect(result).toMatchObject({ passed: false, guardrailId: 'code-safety' });
    expect(lines.filter((line) => line.event === 'agency.callback_failed')).toEqual([expect.objectContaining({ callback: 'guardrailResult', type: 'Error', code: 'unknown' })]);
    expect(JSON.stringify([lines, warned.mock.calls])).not.toContain('worthless');
  });
});


describe('asynchronous failures of callbacks supplied directly to approval helpers', () => {
  afterEach(() => { resetLoggerFactory(); vi.restoreAllMocks(); });

  it('records a rejecting post-approval callback without changing its block', async () => {
    const lines = capture();
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runPostApprovalGuardrails('mute_in_room', { command: 'rm -rf /tmp/cache' }, ['code-safety'], {
      guardrailResult: async () => { throw new Error(message('m1').text); },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(result).toMatchObject({ passed: false, guardrailId: 'code-safety' });
    expect(lines.filter((line) => line.event === 'agency.callback_failed')).toEqual([
      expect.objectContaining({ callback: 'guardrailResult', type: 'Error', code: 'unknown' }),
    ]);
    expect(JSON.stringify([lines, warned.mock.calls])).not.toContain(message('m1').text);
  });

  it('records rejecting callbacks on a directly created approval gate', async () => {
    const lines = capture();
    const slot = createApprovalSlot();
    const gate = createApprovalGate({
      agentName: 'moderator', slot,
      hitl: { approvals: { beforeTool: ['mute_in_room'] }, handler: hitl.autoApprove(), postApprovalGuardrails: [] },
      on: {
        approvalRequested: async () => { throw new Error(message('m1').text); },
        approvalDecided: async () => { throw new Error(message('m1').text); },
      },
    });
    expect(await gate({ name: 'mute_in_room', args: muteOf(message('m1')) as unknown as Record<string, unknown>, id: 'call_1', step: 0 })).toBe(APPROVAL_GRANTED);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(lines.filter((line) => line.event === 'agency.callback_failed').map((line) => line.callback)).toEqual(['approvalRequested', 'approvalDecided']);
    expect(slot.error).toBeUndefined();
    expect(JSON.stringify(lines)).not.toContain(message('m1').text);
  });
});
