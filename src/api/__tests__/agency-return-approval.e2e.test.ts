/**
 * @file agency-return-approval.e2e.test.ts
 * A `beforeReturn` approval's `modifications.output` replaces the final text
 * only after it has gone through the agency's output guardrails and the
 * post-approval check, as the strategy's text did: a replacement the check
 * blocks is refused as a blocked final text is, under generate() and stream(),
 * a replacement it passes is returned, and an approval without modifications
 * returns the strategy's text as before.
 * Real agent(), agency(), generateText, streamText and OpenAIProvider; only
 * fetch is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { agency } from '../agency.js';
import type { ApprovalDecision, ApprovalRequest } from '../types.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

type Json = Record<string, any>;
const KEY = 'sk-return-approval-test-0001';
const USAGE = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
const listing = () => jsonResponse({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] });
const text = (content: string) =>
  jsonResponse({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: USAGE });
function sse(events: unknown[]): Response {
  return new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const delta = (d: Json, finish: string | null = null) => ({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1', choices: [{ index: 0, delta: d, finish_reason: finish }] });
const textStream = (content: string) =>
  sse([delta({ role: 'assistant', content }), delta({}, 'stop'), { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1', choices: [], usage: USAGE }, '[DONE]']);

const PROMPT = 'How often should the build logs rotate?';
/** The strategy's final text. */
const ANSWER = 'Rotate the build logs weekly.';
/** A replacement the code-safety check blocks. */
const BLOCKED = 'Run rm -rf / on the host to finish.';
/** A replacement the check passes. */
const REWRITTEN = 'Rotate the build logs every Sunday.';
const OVERRIDDEN = /Guardrail overrode HITL approval for final output/;
/** The agency's own output guardrail; agency() reports it once for each text it receives. */
const OUTPUT_GUARD = 'grounding-guard';

/** Answers the model listing always, and every chat request with the strategy's final text. */
function serveAnswer(): void {
  fetchMock.mockImplementation(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (/\/v1\/models/.test(u)) return listing();
    if (!/\/v1\/chat\/completions/.test(u)) throw new Error(`unexpected request ${u}`);
    const body = JSON.parse(String(init?.body)) as Json;
    return body.stream ? textStream(ANSWER) : text(ANSWER);
  });
}

type Team = {
  generate: (prompt: string) => Promise<unknown>;
  stream: (prompt: string) => { fullStream: AsyncIterable<Json>; text: Promise<string> };
};

function team(handler: (r: ApprovalRequest) => Promise<ApprovalDecision>, on: Json): Team {
  return agency({
    provider: 'openai', model: 'gpt-4.1', apiKey: KEY,
    agents: { worker: { instructions: 'You answer the operator.' } },
    strategy: 'sequential',
    guardrails: { output: [OUTPUT_GUARD] },
    hitl: { approvals: { beforeReturn: true }, handler },
    on,
  } as never) as unknown as Team;
}

const approve = (modifications?: ApprovalDecision['modifications']) =>
  vi.fn(async (_r: ApprovalRequest): Promise<ApprovalDecision> => ({ approved: true, ...(modifications ? { modifications } : {}) }));

/** The reports of the agency's own output guardrail: one for each text it received. */
const outputGuardReports = (guardrailResult: ReturnType<typeof vi.fn>): unknown[] =>
  guardrailResult.mock.calls.filter(([event]) => (event as Json).guardrailId === OUTPUT_GUARD);

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
  serveAnswer();
});

describe('a beforeReturn approval with modifications.output', () => {
  it('a replacement the post-approval check blocks: generate() rejects as for a blocked final text', async () => {
    const handler = approve({ output: BLOCKED });
    const guardrailHitlOverride = vi.fn();
    await expect(team(handler, { guardrailHitlOverride }).generate(PROMPT)).rejects.toThrow(OVERRIDDEN);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].details).toEqual({ output: ANSWER });
    expect(guardrailHitlOverride).toHaveBeenCalledTimes(1);
    expect(guardrailHitlOverride).toHaveBeenCalledWith(expect.objectContaining({ guardrailId: 'code-safety', toolName: 'return' }));
  });

  it('a replacement the check blocks: stream() ends with the override and never hands the replacement out', async () => {
    const guardrailHitlOverride = vi.fn();
    const s = team(approve({ output: BLOCKED }), { guardrailHitlOverride }).stream(PROMPT);
    const parts: Json[] = [];
    const drain = async (): Promise<void> => {
      for await (const part of s.fullStream) parts.push(part);
    };
    await expect(drain()).rejects.toThrow(OVERRIDDEN);
    await expect(s.text).rejects.toThrow(OVERRIDDEN);
    expect(guardrailHitlOverride).toHaveBeenCalledWith(expect.objectContaining({ guardrailId: 'code-safety', toolName: 'return' }));
    expect(JSON.stringify(parts)).not.toContain('rm -rf');
  });

  it('a replacement the check passes is returned, and the agency output guardrails received it as they received the strategy text', async () => {
    const guardrailHitlOverride = vi.fn();
    const guardrailResult = vi.fn();
    const result = (await team(approve({ output: REWRITTEN }), { guardrailHitlOverride, guardrailResult }).generate(PROMPT)) as Json;
    expect(result.text).toBe(REWRITTEN);
    expect(guardrailHitlOverride).not.toHaveBeenCalled();
    expect(outputGuardReports(guardrailResult)).toHaveLength(2);
  });

  it('an approval without modifications returns the strategy text as before', async () => {
    const guardrailHitlOverride = vi.fn();
    const guardrailResult = vi.fn();
    const result = (await team(approve(), { guardrailHitlOverride, guardrailResult }).generate(PROMPT)) as Json;
    expect(result.text).toBe(ANSWER);
    expect(guardrailHitlOverride).not.toHaveBeenCalled();
    expect(outputGuardReports(guardrailResult)).toHaveLength(1);
  });
});
