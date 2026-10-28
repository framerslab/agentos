/**
 * @file agency-return-approval.e2e.test.ts
 * A `beforeReturn` approval's `modifications.output` replaces the final text
 * only after it has gone through the agency's output guardrails and the
 * post-approval check, as the strategy's text did: a replacement the check
 * blocks is refused as a blocked final text is, under generate() and stream(),
 * a replacement it passes is returned, and an approval without modifications
 * returns the strategy's text as before. With an output schema, `parsed` is
 * read from the text the caller receives: a replacement that matches the
 * schema is parsed, one that does not is returned once with `parsed`
 * undefined, and an approval without modifications leaves the validation
 * retry as it was. A replacement that hands the strategy's own text back is
 * the approver's answer as any other is, and a replacement that does not
 * match writes one line through the host's logger.
 * Real agent(), agency(), generateText, streamText and OpenAIProvider; only
 * fetch is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { agency } from '../agency.js';
import type { ApprovalDecision, ApprovalRequest } from '../types.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';
import { setLoggerFactory, resetLoggerFactory } from '../../core/logging/loggerFactory.js';

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
/** The output schema of the structured cases. ANSWER and REWRITTEN hold no JSON, so they do not match it. */
const ROTATION = z.object({ rotate: z.string() });
/** A strategy's final text that matches the schema. */
const ANSWER_JSON = '{"rotate":"weekly"}';
/** A replacement that matches the schema, with another value. */
const REWRITTEN_JSON = '{"rotate":"every Sunday"}';

/**
 * Answers the model listing always, and the chat requests in turn with
 * `replies` (the strategy's final text when none is given); the last reply
 * answers every request after it.
 */
function serveAnswer(...replies: string[]): void {
  const answers = replies.length ? replies : [ANSWER];
  let next = 0;
  fetchMock.mockImplementation(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (/\/v1\/models/.test(u)) return listing();
    if (!/\/v1\/chat\/completions/.test(u)) throw new Error(`unexpected request ${u}`);
    const content = answers[Math.min(next++, answers.length - 1)];
    const body = JSON.parse(String(init?.body)) as Json;
    return body.stream ? textStream(content) : text(content);
  });
}

/** The bodies of the chat requests the stub answered: one for each run of the strategy's one agent. */
const chatBodies = (): Json[] =>
  fetchMock.mock.calls
    .filter(([url]) => /\/v1\/chat\/completions/.test(String(url)))
    .map(([, init]) => JSON.parse(String((init as { body?: unknown }).body)) as Json);

type Team = {
  generate: (prompt: string) => Promise<unknown>;
  stream: (prompt: string) => { fullStream: AsyncIterable<Json>; text: Promise<string>; parsed: Promise<unknown> };
};

/** One agent under the sequential strategy, with the agency's output guardrail and a beforeReturn approval; `extra` adds agency options. */
function team(handler: (r: ApprovalRequest) => Promise<ApprovalDecision>, on: Json, extra: Json = {}): Team {
  return agency({
    provider: 'openai', model: 'gpt-4.1', apiKey: KEY,
    agents: { worker: { instructions: 'You answer the operator.' } },
    strategy: 'sequential',
    guardrails: { output: [OUTPUT_GUARD] },
    hitl: { approvals: { beforeReturn: true }, handler },
    on,
    ...extra,
  } as never) as unknown as Team;
}

const approve = (modifications?: ApprovalDecision['modifications']) =>
  vi.fn(async (_r: ApprovalRequest): Promise<ApprovalDecision> => ({ approved: true, ...(modifications ? { modifications } : {}) }));

type LogLine = { level: string; message: unknown; meta: Json | undefined };
/** Every line the host's logger (`setLoggerFactory`) is handed while `run` runs. */
async function logLines(run: () => Promise<void>): Promise<LogLine[]> {
  const lines: LogLine[] = [];
  const make = (): unknown => {
    const write = (level: string) => (message: unknown, meta?: Json) => { lines.push({ level, message, meta }); };
    return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug'), child: () => make() };
  };
  setLoggerFactory(() => make() as never);
  try { await run(); } finally { resetLoggerFactory(); }
  return lines;
}

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

describe('a beforeReturn approval and the output schema', () => {
  it('a replacement that matches the schema: generate() and stream() read parsed from it, and the strategy runs once for each', async () => {
    serveAnswer(ANSWER_JSON);
    const handler = approve({ output: REWRITTEN_JSON });
    const withSchema = team(handler, {}, { output: ROTATION });

    const result = (await withSchema.generate(PROMPT)) as Json;
    expect(handler.mock.calls[0][0].details).toEqual({ output: ANSWER_JSON });
    expect(result.text).toBe(REWRITTEN_JSON);
    expect(result.parsed).toEqual({ rotate: 'every Sunday' });
    expect(chatBodies()).toHaveLength(1);

    const s = withSchema.stream(PROMPT);
    const parts: Json[] = [];
    for await (const part of s.fullStream) parts.push(part);
    expect(parts.filter((part) => part.type === 'final-output')).toEqual([
      expect.objectContaining({ text: REWRITTEN_JSON, parsed: { rotate: 'every Sunday' } }),
    ]);
    await expect(s.parsed).resolves.toEqual({ rotate: 'every Sunday' });
    expect(chatBodies()).toHaveLength(2);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('a replacement that does not match the schema is returned once, with parsed undefined: the strategy runs once and the approval is asked once', async () => {
    // The validation retry is at its default, one more attempt. The strategy's
    // text fails the schema in the first case and matches it in the second;
    // the replacement fails it in both.
    for (const strategyText of [ANSWER, ANSWER_JSON]) {
      fetchMock.mockClear();
      serveAnswer(strategyText);
      const handler = approve({ output: REWRITTEN });
      const result = (await team(handler, {}, { output: ROTATION }).generate(PROMPT)) as Json;
      expect(result.text).toBe(REWRITTEN);
      expect(result.parsed).toBeUndefined();
      expect(chatBodies()).toHaveLength(1);
      expect(handler).toHaveBeenCalledTimes(1);
    }
  });

  it('an approval without modifications on a text that fails the schema: the validation retry runs as before, and parsed comes from the second attempt', async () => {
    serveAnswer(ANSWER, ANSWER_JSON);
    const handler = approve();
    const result = (await team(handler, {}, { output: ROTATION }).generate(PROMPT)) as Json;
    expect(result.text).toBe(ANSWER_JSON);
    expect(result.parsed).toEqual({ rotate: 'weekly' });
    const bodies = chatBodies();
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1].messages)).toContain(`Response was: ${ANSWER}`);
    expect(handler.mock.calls.map(([request]) => request.details)).toEqual([{ output: ANSWER }, { output: ANSWER_JSON }]);
  });

  it('a replacement that hands the strategy text back, which fails the schema, is returned once with parsed undefined: the strategy runs once and the approval is asked once', async () => {
    // An approver that always sends the text back, edited or not, here
    // unedited: the replacement is the strategy's own text.
    const handler = approve({ output: ANSWER });
    const result = (await team(handler, {}, { output: ROTATION }).generate(PROMPT)) as Json;
    expect(result.text).toBe(ANSWER);
    expect(result.parsed).toBeUndefined();
    expect(chatBodies()).toHaveLength(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a replacement that does not match the schema writes one line through the host logger, and one that matches writes none', async () => {
    const unparsed = (lines: LogLine[]): LogLine[] => lines.filter((line) => line.meta?.event === 'agency_replacement_unparsed');
    const failing = await logLines(async () => {
      const result = (await team(approve({ output: REWRITTEN }), {}, { output: ROTATION }).generate(PROMPT)) as Json;
      expect(result.parsed).toBeUndefined();
    });
    expect(unparsed(failing)).toEqual([
      { level: 'info', message: expect.any(String), meta: { event: 'agency_replacement_unparsed', agency: '__agency__', strategy: 'sequential' } },
    ]);
    const matching = await logLines(async () => {
      const result = (await team(approve({ output: REWRITTEN_JSON }), {}, { output: ROTATION }).generate(PROMPT)) as Json;
      expect(result.parsed).toEqual({ rotate: 'every Sunday' });
    });
    expect(unparsed(matching)).toEqual([]);
  });
});
