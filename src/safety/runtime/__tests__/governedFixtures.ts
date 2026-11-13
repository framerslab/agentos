/**
 * @file governedFixtures.ts
 * What the governed-tool tests share: stored messages, a message store, an audit sink that records what it is given,
 * a mute tool, limit rules, a rule book, a captured host logger and the chat-completion stubs. Invented text only.
 */
import { vi, type Mock } from 'vitest';
import pino from 'pino';
import { setLogger } from '../../../core/logging/loggerFactory.js';
import type { ITool, ToolExecutionContext, ToolExecutionResult } from '../../../core/tools/ITool.js';
import type { ActionEvidence, EvidenceSource, RuleBook, StoredMessage } from '../ActionEvidence.js';
import type { ActionLimitRule } from '../ActionLimiter.js';
import type { ActionAuditRecord, ActionAuditSink, ActionOutcome, GovernedToolPolicy } from '../GovernedTool.js';

export type Json = Record<string, any>;
export type Line = Record<string, unknown>;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const MESSAGES: StoredMessage[] = [
  { id: 'm1', authorId: 'u_attacker', roomId: 'r1', text: 'You are worthless and everyone here knows it' },
  { id: 'm2', authorId: 'u_victim', roomId: 'r1', text: 'Please stop writing to me like that' },
  { id: 'm3', authorId: 'u_third', roomId: 'r1', text: 'Buy followers at this link right now friends' },
  { id: 'm4', authorId: 'u_fourth', roomId: 'r1', text: 'Nobody asked for your opinion you clown' },
  { id: 'm5', authorId: 'u_attacker', roomId: 'r1', text: 'And another thing you are a waste of space' },
  { id: 'm6', authorId: 'u_short', roomId: 'r1', text: 'rev_1' },
  { id: 'm7', authorId: 'u_loud', roomId: 'r1', text: 'PERSONAL_DATA' },
  { id: 'm8', authorId: 'u_street', roomId: 'r1', text: 'MeetMeAt221BakerStreet' },
  { id: 'm9', authorId: 'a_b', roomId: 'r2', text: 'The first message of account a_b in room two' },
  { id: 'm10', authorId: 'axb', roomId: 'r2', text: 'The first message of account axb in room two' },
];
export const message = (id: string): StoredMessage => MESSAGES.find((m) => m.id === id) as StoredMessage;

/** The host's store: every message above, and the verdict ids it confirms. */
export function messageStore(verdicts: readonly string[] = ['v_1']): EvidenceSource {
  return {
    getMessage: async (id) => MESSAGES.find((m) => m.id === id) ?? null,
    hasVerdict: async (ref) => verdicts.includes(ref),
  };
}

export interface RecordingSink extends ActionAuditSink {
  begun: ActionAuditRecord[];
  finished: Array<{ recordId: string; end: Parameters<ActionAuditSink['finish']>[1] }>;
  outcomes(): ActionOutcome[];
}
/** An audit sink that keeps a copy of everything it receives. */
export function auditSink(): RecordingSink {
  const begun: RecordingSink['begun'] = [];
  const finished: RecordingSink['finished'] = [];
  return {
    begun, finished,
    begin: async (record) => { begun.push(structuredClone(record)); },
    finish: async (recordId, end) => { finished.push({ recordId, end: structuredClone(end) }); },
    outcomes: () => finished.map((f) => f.end.outcome),
  };
}

export interface MuteArgs { userId: string; roomId: string; evidence: ActionEvidence }
export type MuteTool = ITool<MuteArgs, { muted: boolean }> & { execute: Mock };
/** A tool that mutes one account in one room. `run` is what it does; by default it succeeds. */
export function muteTool(run?: (args: MuteArgs, context: ToolExecutionContext) => Promise<ToolExecutionResult<{ muted: boolean }>>): MuteTool {
  return {
    id: 'mute-in-room-v1', name: 'mute_in_room', displayName: 'Mute in room', description: 'Mutes one account in one room.',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' }, roomId: { type: 'string' } }, required: ['userId', 'roomId'] },
    execute: vi.fn(run ?? (async () => ({ success: true, output: { muted: true } }))),
  } as MuteTool;
}

export const RULES: ActionLimitRule[] = [
  { id: 'mute_room_hour', scope: 'room', windowMs: HOUR, max: 3 },
  { id: 'mute_target_day', scope: 'target', windowMs: DAY, max: 1 },
];
export const RULE_BOOK: RuleBook = { '2026-11': ['harassment.1', 'spam.2'] };
export const MUTE_POLICY: GovernedToolPolicy<MuteArgs> = {
  action: 'mute_in_room',
  target: (args) => ({ accountId: args.userId, roomId: args.roomId }),
  limits: RULES,
  dryRunOutput: () => ({ muted: true }),
};

/** Evidence that quotes a stored message whole and names its author, with any field replaced. */
export const evidenceOf = (stored: StoredMessage, over: Partial<ActionEvidence> = {}): ActionEvidence => ({
  targetId: stored.authorId, roomId: stored.roomId, ruleId: 'harassment.1', policyVersion: '2026-11',
  quotes: [{ messageId: stored.id, quote: stored.text }], ...over,
});
/** The mute of a stored message's author for that message. */
export const muteOf = (stored: StoredMessage, over: Partial<ActionEvidence> = {}): MuteArgs => ({
  userId: stored.authorId, roomId: stored.roomId as string, evidence: evidenceOf(stored, over),
});
/** A context as a host's own executor builds one. */
export const CONTEXT = { gmiId: 'gmi-1', personaId: 'persona-1', userContext: { userId: 'system' } } as unknown as ToolExecutionContext;

/** A pino logger handed to AgentOS, and the lines it received. */
export function capture(): Line[] {
  const lines: Line[] = [];
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { lines.push(JSON.parse(line)); } }));
  return lines;
}

export const OPENAI = { provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-governed-test-0001', fallbackProviders: [] };
const USAGE = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
export const text = (content: string) => () =>
  jsonResponse({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: USAGE });
export const toolCall = (name: string, args: Json, id = 'call_1') => () =>
  jsonResponse({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: USAGE });
/** Answers every GET with a model listing and each POST with the next entry of `script`. */
export function serve(fetchMock: Mock, script: Array<() => Response>): void {
  const queue = [...script];
  fetchMock.mockImplementation(async (url: unknown, init?: { method?: string }) => {
    if ((init?.method ?? 'GET') === 'GET') return jsonResponse({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] });
    const next = queue.shift();
    if (!next) throw new Error(`script exhausted at ${String(url)}`);
    return next();
  });
}
/** The parsed body of every POST so far, in order. */
export const posted = (fetchMock: Mock): Json[] =>
  fetchMock.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST').map(([, init]) => JSON.parse(String((init as { body?: unknown }).body)) as Json);
