/**
 * @file agentos-structured-reply.e2e.test.ts
 * A structured turn on the real runtime with an OpenAI provider stub: the schema instruction closes the system prompt,
 * no delta reaches the caller before the check, a matching reply returns its parsed value on the final chunk, a reply
 * that does not match is asked for again inside the turn with the issues named, an exhausted turn ends as
 * GMI_STRUCTURED_OUTPUT_INVALID or returns the last reply as invalid, a sanitizer that breaks the shape is caught after
 * the guardrails, a schemaRef resolves through the registry, and a JSON Schema checks like a Zod one.
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
});
