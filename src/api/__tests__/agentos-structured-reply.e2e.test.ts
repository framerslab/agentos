/**
 * @file agentos-structured-reply.e2e.test.ts
 * A structured turn on the real runtime with an OpenAI provider stub: the schema instruction closes the system prompt,
 * no delta reaches the caller before the check, a matching reply returns its parsed value on the final chunk, a reply
 * that does not match is asked for again inside the turn with the issues named, an exhausted turn ends as
 * GMI_STRUCTURED_OUTPUT_INVALID or returns the last reply as invalid, a refusal from the model ends the turn with no
 * repair request and no schema check (text or a lifted value beside it included), a sanitizer that breaks the shape is caught after the guardrails, a schemaRef resolves through the
 * registry, and a JSON Schema checks like a Zod one, sent anew with each request under one $id too. A JSON Schema that
 * does not compile is refused before the provider is called, and the requests after it compile theirs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const provider = vi.hoisted(() => ({
  calls: [] as Array<Array<{ role: string; content: unknown }>>,
  replies: [] as Array<Array<Record<string, unknown>>>,
}));

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', () => {
  class OpenAIProvider {
    readonly providerId = 'openai';
    isInitialized = false;
    async initialize() { this.isInitialized = true; }
    async generateCompletion() { return { choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }], responseText: 'ok' }; }
    async *generateCompletionStream(_modelId: string, messages: Array<{ role: string; content: unknown }>) {
      provider.calls.push(messages);
      yield* provider.replies.shift() ?? [];
    }
    async generateEmbeddings() { return { embeddings: [] }; }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  }
  return { OpenAIProvider };
});

import { AgentOS } from '../AgentOS';
import { AgentOSResponseChunkType, type AgentOSFinalResponseChunk } from '../types/AgentOSResponse';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';
import { GMIErrorCode } from '../../core/utils/errors.js';
import { GuardrailAction, type IGuardrailService } from '../../safety/guardrails/IGuardrailService';

const persona = { id: 'planner', name: 'Planner', description: 'Drafts a week.', version: '1.0.0', baseSystemPrompt: 'You draft the week from the path.' } as unknown as IPersonaDefinition;
const week = z.object({ items: z.array(z.object({ date: z.string(), title: z.string(), heavy: z.boolean() })) });

const reply = (text: string) => [
  { responseTextDelta: text },
  { isFinal: true, choices: [{ message: { role: 'assistant', content: text }, finishReason: 'stop' }], usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } },
];
/**
 * A refusal as OpenAIProvider streams it (openai-refusal.e2e.test.ts pins the shape on the real provider): the message
 * in refusal pieces, never as text, and a final chunk whose choice holds the whole message beside `stop`.
 */
const REFUSAL = "I'm sorry, I cannot assist with that request.";
const refusal = () => [
  { refusalDelta: "I'm sorry, " },
  { refusalDelta: 'I cannot assist with that request.' },
  { isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: null }, finishReason: 'stop', refusal: REFUSAL }], usage: { promptTokens: 81, completionTokens: 11, totalTokens: 92 } },
];
const GOOD = '{"items":[{"date":"2026-10-13","title":"Chapter 2 drill","heavy":false}]}';
const BAD = '{"items":[{"date":"2026-10-13","title":"Chapter 2 drill"}]}';

async function boot(extra: Record<string, unknown> = {}): Promise<AgentOS> {
  return AgentOS.create({
    modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] },
    turnPlanning: { enabled: false },
    personas: [persona],
    ...extra,
  } as any);
}

async function collect(agentos: AgentOS, options: Record<string, unknown>, sessionId: string): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of agentos.processRequest({ userId: 'u', sessionId, selectedPersonaId: 'planner', textInput: 'Draft my week.', options } as any)) chunks.push(chunk);
  return chunks;
}
const finalOf = (chunks: any[]): AgentOSFinalResponseChunk | undefined => chunks.find((c) => c.type === AgentOSResponseChunkType.FINAL_RESPONSE);
const errorOf = (chunks: any[]) => chunks.find((c) => c.type === AgentOSResponseChunkType.ERROR);
const deltasOf = (chunks: any[]) => chunks.filter((c) => c.type === AgentOSResponseChunkType.TEXT_DELTA);
const systemTextOf = (messages: Array<{ role: string; content: unknown }>) =>
  messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n\n');

describe('a structured reply on processRequest', () => {
  let booted: AgentOS | undefined;
  afterEach(async () => {
    if (booted) await booted.shutdown();
    booted = undefined;
    provider.calls.length = 0;
    provider.replies.length = 0;
    vi.restoreAllMocks();
  });

  it('returns the parsed value of a matching reply, with the schema instruction last in the system prompt and no delta before the check', async () => {
    booted = await boot();
    provider.replies.push(reply(GOOD));
    const chunks = await collect(booted, { structuredReply: { schema: week, name: 'week' } }, 's-good');
    expect(deltasOf(chunks)).toHaveLength(0);
    const final = finalOf(chunks)!;
    expect(final.structured).toEqual({ value: JSON.parse(GOOD), meta: { schemaName: 'week', valid: true, attempts: 1, enforcement: 'prompt_only', stage: 'model' } });
    expect(final.finalResponseText).toBe(GOOD);
    const system = systemTextOf(provider.calls[0]);
    expect(system).toContain('You draft the week from the path.');
    expect(system).toContain('The JSON object should be a "week".');
    expect(system.indexOf('You draft the week')).toBeLessThan(system.indexOf('The JSON MUST conform'));
  });

  it('asks again inside the turn when the reply does not match, naming the issues, and returns the second reply', async () => {
    booted = await boot();
    provider.replies.push(reply(BAD), reply(GOOD));
    const chunks = await collect(booted, { structuredReply: { schema: week, name: 'week' } }, 's-repair');
    expect(provider.calls).toHaveLength(2);
    const second = provider.calls[1];
    const repair = second.filter((m) => m.role === 'user').at(-1);
    expect(String(repair?.content)).toContain('did not match the required JSON schema for "week"');
    expect(String(repair?.content)).toContain('items.0.heavy');
    expect(second.some((m) => m.role === 'assistant' && String(m.content).includes('Chapter 2 drill'))).toBe(true);
    const final = finalOf(chunks)!;
    expect(final.structured?.meta).toMatchObject({ valid: true, attempts: 2 });
    expect(final.finalResponseText).toBe(GOOD);
    expect(deltasOf(chunks)).toHaveLength(0);
  });

  it('ends the turn as GMI_STRUCTURED_OUTPUT_INVALID when the retries are spent, or returns the last reply as invalid when asked', async () => {
    booted = await boot();
    provider.replies.push(reply(BAD));
    const failed = await collect(booted, { structuredReply: { schema: week, name: 'week', maxRetries: 0 } }, 's-exhausted');
    expect(errorOf(failed)?.code).toBe(GMIErrorCode.STRUCTURED_OUTPUT_INVALID);
    expect(errorOf(failed)?.details).toMatchObject({ schemaName: 'week', attempts: 1 });
    expect(deltasOf(failed)).toHaveLength(0);
    expect(provider.calls).toHaveLength(1);
    provider.replies.push(reply(BAD), reply(BAD));
    const kept = await collect(booted, { structuredReply: { schema: week, name: 'week', maxRetries: 1, onExhausted: 'return_invalid' } }, 's-invalid-kept');
    expect(errorOf(kept)).toBeUndefined();
    const final = finalOf(kept)!;
    expect(final.structured?.meta).toMatchObject({ valid: false, attempts: 2, stage: 'model' });
    expect(final.structured?.meta.issues?.join('\n')).toContain('items.0.heavy');
    expect(final.structured?.value).toEqual(JSON.parse(BAD));
    expect(provider.calls).toHaveLength(3);
  });

  it('ends the turn on a refusal without asking again: as refused under onExhausted error, as an invalid null value under return_invalid', async () => {
    booted = await boot();
    // Retries are left and a matching reply waits: a repair request would get it.
    provider.replies.push(refusal(), reply(GOOD));
    const failed = await collect(booted, { structuredReply: { schema: week, name: 'week', maxRetries: 2 } }, 's-refused');
    expect(provider.calls).toHaveLength(1);
    expect(errorOf(failed)?.code).toBe(GMIErrorCode.STRUCTURED_OUTPUT_INVALID);
    expect(errorOf(failed)?.message).toContain('refused');
    expect(errorOf(failed)?.details).toMatchObject({ schemaName: 'week', attempts: 1, refused: true });
    expect(errorOf(failed)?.details).not.toHaveProperty('issues');
    // The final chunk that carries the error holds no structured value.
    expect(finalOf(failed)?.structured).toBeUndefined();
    expect(deltasOf(failed)).toHaveLength(0);

    provider.calls.length = 0;
    provider.replies.length = 0;
    provider.replies.push(refusal(), reply(GOOD));
    const kept = await collect(booted, { structuredReply: { schema: week, name: 'week', maxRetries: 2, onExhausted: 'return_invalid' } }, 's-refused-kept');
    expect(provider.calls).toHaveLength(1);
    expect(errorOf(kept)).toBeUndefined();
    const final = finalOf(kept)!;
    expect(final.structured).toMatchObject({ value: null, meta: { schemaName: 'week', valid: false, attempts: 1, stage: 'model' } });
    expect(final.structured?.meta.issues).toEqual(['The model refused the request instead of writing the reply.']);
    expect(final.finalResponseText ?? '').toBe('');
  });

  it('never runs the schema check on a refused step that also carries a matching reply, as text or as a lifted value', async () => {
    booted = await boot();
    // A check that counts its runs and throws, as a refinement that throws (or an async one under safeParse) does.
    let checks = 0;
    const watched = week.superRefine(() => {
      checks += 1;
      throw new Error('the schema check ran on a refused step');
    });
    const usage = { promptTokens: 81, completionTokens: 11, totalTokens: 92 };
    // The refusal beside text that parses and matches.
    provider.replies.push([
      { responseTextDelta: GOOD },
      { isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: GOOD }, finishReason: 'stop', refusal: REFUSAL }], usage },
    ], reply(GOOD));
    const failed = await collect(booted, { structuredReply: { schema: watched, name: 'week', maxRetries: 2 } }, 's-refused-text');
    expect(checks).toBe(0);
    expect(provider.calls).toHaveLength(1);
    expect(errorOf(failed)?.code).toBe(GMIErrorCode.STRUCTURED_OUTPUT_INVALID);
    expect(errorOf(failed)?.details).toMatchObject({ schemaName: 'week', attempts: 1, refused: true });
    expect(errorOf(failed)?.details).not.toHaveProperty('issues');
    expect(finalOf(failed)?.structured).toBeUndefined();

    provider.calls.length = 0;
    provider.replies.length = 0;
    // The refusal beside a value the gateway lifted from a schema tool call.
    provider.replies.push([
      { refusalDelta: REFUSAL },
      { isFinal: true, structuredOutput: JSON.parse(GOOD), choices: [{ index: 0, message: { role: 'assistant', content: null }, finishReason: 'stop', refusal: REFUSAL }], usage },
    ], reply(GOOD));
    const kept = await collect(booted, { structuredReply: { schema: watched, name: 'week', maxRetries: 2, onExhausted: 'return_invalid' } }, 's-refused-lifted');
    expect(checks).toBe(0);
    expect(provider.calls).toHaveLength(1);
    expect(errorOf(kept)).toBeUndefined();
    const final = finalOf(kept)!;
    expect(final.structured).toMatchObject({ value: null, meta: { schemaName: 'week', valid: false, attempts: 1, stage: 'model' } });
    expect(final.structured?.meta.issues).toEqual(['The model refused the request instead of writing the reply.']);
  });

  it.each([
    { rewrite: false, throws: false },
    { rewrite: true, throws: false },
    { rewrite: false, throws: true },
    { rewrite: true, throws: true },
  ])('keeps a refused structured reply after output sanitization without checking or repairing it (rewrite: $rewrite, throwing schema: $throws)', async ({ rewrite, throws }) => {
    const sanitizedText = rewrite ? GOOD.replace('Chapter 2 drill', 'Review') : GOOD;
    const evaluateOutput = vi.fn<NonNullable<IGuardrailService['evaluateOutput']>>(async ({ chunk }) =>
      chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE
        ? { action: GuardrailAction.SANITIZE, modifiedText: sanitizedText, reasonCode: 'REDACTED' }
        : null,
    );
    booted = await boot({ guardrailService: { config: { canSanitize: true }, evaluateOutput } });
    const check = vi.fn(() => {
      if (throws) throw new Error('the schema check ran on a sanitized refusal');
    });
    const schema = week.superRefine(check);
    // A Responses refusal beside matching output text. A repair would consume the queued good reply.
    provider.replies.push([
      { responseTextDelta: GOOD },
      { isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: GOOD }, finishReason: 'stop', refusal: REFUSAL }] },
    ], reply(GOOD));
    const chunks = await collect(booted, {
      structuredReply: { schema, name: 'week', maxRetries: 2, onExhausted: 'return_invalid' },
    }, 's-refused-sanitized');
    expect(evaluateOutput.mock.calls.some(([{ chunk }]) => chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE)).toBe(true);
    expect(check).not.toHaveBeenCalled();
    expect(provider.calls).toHaveLength(1);
    expect(provider.replies).toHaveLength(1);
    expect(errorOf(chunks)).toBeUndefined();
    expect(deltasOf(chunks)).toHaveLength(0);
    const final = finalOf(chunks)!;
    expect(final.isFinal).toBe(true);
    expect(final.finalResponseText).toBe(sanitizedText);
    expect(final.structured).toEqual({
      value: null,
      meta: {
        schemaName: 'week', valid: false, attempts: 1, enforcement: 'prompt_only', stage: 'model',
        issues: ['The model refused the request instead of writing the reply.'],
      },
    });
  });

  it('streams the deltas when asked', async () => {
    booted = await boot();
    provider.replies.push(reply(GOOD));
    const chunks = await collect(booted, { structuredReply: { schema: week, streamDeltas: true } }, 's-stream');
    expect(deltasOf(chunks).map((c) => c.textDelta).join('')).toBe(GOOD);
    expect(finalOf(chunks)?.structured?.meta.valid).toBe(true);
  });

  it('checks the text again after an output guardrail rewrote it', async () => {
    const sanitizer: IGuardrailService = {
      config: { canSanitize: true },
      evaluateOutput: async ({ chunk }) =>
        chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE ? { action: GuardrailAction.SANITIZE, modifiedText: '[the reply was replaced]', reasonCode: 'REDACTED' } : null,
    };
    booted = await boot({ guardrailService: sanitizer });
    provider.replies.push(reply(GOOD));
    const errored = await collect(booted, { structuredReply: { schema: week, name: 'week' } }, 's-sanitized-error');
    expect(errorOf(errored)?.code).toBe(GMIErrorCode.STRUCTURED_OUTPUT_INVALID);
    expect(errorOf(errored)?.details).toMatchObject({ stage: 'post_guardrail' });
    expect(finalOf(errored)).toBeUndefined();
    provider.replies.push(reply(GOOD));
    const kept = await collect(booted, { structuredReply: { schema: week, name: 'week', onExhausted: 'return_invalid' } }, 's-sanitized-kept');
    const final = finalOf(kept)!;
    expect(final.finalResponseText).toBe('[the reply was replaced]');
    expect(final.structured?.meta).toMatchObject({ valid: false, stage: 'post_guardrail' });
  });

  it('refuses a spec with no reachable schema before any model call, and resolves a schemaRef through the registry', async () => {
    booted = await boot({ structuredSchemas: new Map([['week', week]]) });
    const refused = await collect(booted, { structuredReply: { schemaRef: 'nope' } }, 's-ref-missing');
    expect(errorOf(refused)?.code).toBe(GMIErrorCode.VALIDATION_ERROR);
    expect(provider.calls).toHaveLength(0);
    provider.replies.push(reply(GOOD));
    const chunks = await collect(booted, { structuredReply: { schemaRef: 'week', name: 'week' } }, 's-ref');
    expect(finalOf(chunks)?.structured).toMatchObject({ value: JSON.parse(GOOD), meta: { valid: true } });
  });

  it('takes a JSON Schema and repairs against it', async () => {
    booted = await boot();
    const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, title: { type: 'string' }, heavy: { type: 'boolean' } }, required: ['date', 'title', 'heavy'] } } }, required: ['items'] };
    provider.replies.push(reply(BAD), reply(GOOD));
    const chunks = await collect(booted, { structuredReply: { schema, name: 'week' } }, 's-json-schema');
    expect(provider.calls).toHaveLength(2);
    expect(String(provider.calls[1].filter((m) => m.role === 'user').at(-1)?.content)).toContain("must have required property 'heavy'");
    expect(finalOf(chunks)?.structured).toMatchObject({ value: JSON.parse(GOOD), meta: { valid: true, attempts: 2 } });
  });

  it('takes a JSON Schema that each request sends anew under one $id, and repairs against it each time', async () => {
    booted = await boot();
    // A host that reads the schema from each request hands over a new object every time, under the same $id.
    const schemaFor = () => ({
      $id: 'urn:example:week',
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, title: { type: 'string' }, heavy: { type: 'boolean' } }, required: ['date', 'title', 'heavy'] } } },
      required: ['items'],
    });
    for (const sessionId of ['s-anew-1', 's-anew-2']) {
      provider.calls.length = 0;
      provider.replies.push(reply(BAD), reply(GOOD));
      const chunks = await collect(booted, { structuredReply: { schema: schemaFor(), name: 'week' } }, sessionId);
      expect(errorOf(chunks)).toBeUndefined();
      expect(provider.calls).toHaveLength(2);
      expect(String(provider.calls[1].filter((m) => m.role === 'user').at(-1)?.content)).toContain("must have required property 'heavy'");
      expect(finalOf(chunks)?.structured).toMatchObject({ value: JSON.parse(GOOD), meta: { valid: true, attempts: 2 } });
    }
  });

  it("refuses a JSON Schema that does not compile before the provider is called, and compiles the next request's schema", async () => {
    booted = await boot();
    const items = { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, title: { type: 'string' }, heavy: { type: 'boolean' } }, required: ['date', 'title', 'heavy'] } };
    // Each schema with the words its refusal carries: 'nonsense' is no JSON Schema type; an $async schema's check
    // answers a promise; the draft-07 meta-schema's own $id is Ajv's; 2020-12 is a draft other than draft-07.
    const uncompiled: Array<[Record<string, unknown>, string]> = [
      [{ type: 'object', properties: { items: { type: 'nonsense' } } }, 'schema is invalid'],
      [{ $async: true, type: 'object', properties: { items }, required: ['items'] }, 'marked $async'],
      [{ $id: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { items }, required: ['items'] }, 'already exists'],
      [{ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { items }, required: ['items'] }, 'no schema with key or ref'],
    ];
    for (const [index, [schema, fault]] of uncompiled.entries()) {
      const refused = errorOf(await collect(booted, { structuredReply: { schema, name: 'week' } }, `s-uncompiled-${index}`));
      expect(refused?.code).toBe(GMIErrorCode.VALIDATION_ERROR);
      expect(refused?.message).toContain('structuredReply.schema is not a valid JSON Schema');
      expect(refused?.message).toContain(fault);
    }
    expect(provider.calls).toHaveLength(0);
    // The refusals left the draft-07 meta-schema where it was: a schema that names it compiles and checks the reply.
    provider.replies.push(reply(BAD), reply(GOOD));
    const schema = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { items }, required: ['items'] };
    const chunks = await collect(booted, { structuredReply: { schema, name: 'week' } }, 's-after-uncompiled');
    expect(errorOf(chunks)).toBeUndefined();
    expect(provider.calls).toHaveLength(2);
    expect(String(provider.calls[1].filter((m) => m.role === 'user').at(-1)?.content)).toContain("must have required property 'heavy'");
    expect(finalOf(chunks)?.structured).toMatchObject({ value: JSON.parse(GOOD), meta: { valid: true, attempts: 2 } });
  });
});
