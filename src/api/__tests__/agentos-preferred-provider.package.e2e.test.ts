/**
 * @file agentos-preferred-provider.package.e2e.test.ts
 * A turn's provider as a host sets it: `AgentOS.create()` and `processRequest()` from the package's root index, with
 * OpenAI and Anthropic configured and only their provider classes stubbed (helpers/stubProviders.ts), so the real
 * runtime, GMI manager, GMI, completion gateway and provider manager run. A request whose
 * `options.preferredProviderId` names Anthropic, on a persona whose default provider is OpenAI, sends its model call to
 * Anthropic with the model it names; a request that names no provider goes to the persona's provider, and a persona
 * that names Anthropic sends its turns there.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/llm/providers/implementations/OpenAIProvider')>()),
  OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai'),
}));
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/llm/providers/implementations/AnthropicProvider')>()),
  AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic'),
}));
import { AgentOS, AgentOSResponseChunkType } from '../../index';
import type { AgentOSInput } from '../../index';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-preferred-provider-${++n}`;

const onOpenAI = {
  id: 'on-openai', name: 'On OpenAI', description: 'A persona whose default provider is OpenAI.', version: '1.0.0',
  baseSystemPrompt: 'You are terse.', defaultProviderId: 'openai', defaultModelId: 'gpt-4o-mini',
};
const onAnthropic = {
  id: 'on-anthropic', name: 'On Anthropic', description: 'A persona whose default provider is Anthropic.', version: '1.0.0',
  baseSystemPrompt: 'You are terse.', defaultProviderId: 'anthropic', defaultModelId: 'claude-sonnet-4-0',
};

interface Booted { agentos: AgentOS; openai: ProviderScript; anthropic: ProviderScript }

async function boot(): Promise<Booted> {
  const openaiKey = key();
  const anthropicKey = key();
  const openai = script('openai', openaiKey);
  const anthropic = script('anthropic', anthropicKey);
  const agentos = await AgentOS.create({
    modelProviderManagerConfig: {
      providers: [
        { providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: openaiKey } },
        { providerId: 'anthropic', enabled: true, config: { apiKey: anthropicKey } },
      ],
    },
    turnPlanning: { enabled: false },
    personas: [onOpenAI, onAnthropic],
  } as never);
  return { agentos, openai, anthropic };
}

async function turn(agentos: AgentOS, input: Partial<AgentOSInput>): Promise<{ text: string | null | undefined; error: unknown }> {
  let text: string | null | undefined;
  let error: unknown;
  for await (const chunk of agentos.processRequest({ userId: 'host-user', textInput: 'Hello?', ...input } as AgentOSInput)) {
    if (chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE) text = (chunk as { finalResponseText?: string | null }).finalResponseText;
    if (chunk.type === AgentOSResponseChunkType.ERROR) error = chunk;
  }
  return { text, error };
}

const calls = (s: ProviderScript) => s.seen.filter((call) => call.streamed).map((call) => call.modelId);

describe("a turn's preferredProviderId through the package root", () => {
  let booted: Booted | undefined;
  afterEach(async () => {
    if (booted) await booted.agentos.shutdown();
    booted = undefined;
    globalLLMProviderHealth.reset();
    vi.restoreAllMocks();
  });

  it("sends the model call to the provider the request names, over the persona's default provider", async () => {
    booted = await boot();
    booted.anthropic.replies.push(reply.text('From Anthropic.', 'claude-sonnet-4-0'));

    const result = await turn(booted.agentos, {
      sessionId: 's-named', selectedPersonaId: 'on-openai',
      options: { preferredProviderId: 'anthropic', preferredModelId: 'claude-sonnet-4-0' },
    });

    expect(result.error).toBeUndefined();
    expect(result.text).toBe('From Anthropic.');
    expect(calls(booted.anthropic)).toEqual(['claude-sonnet-4-0']);
    expect(calls(booted.openai)).toEqual([]);
  });

  it("keeps the persona's provider for a request that names none, and for one that names only a model", async () => {
    booted = await boot();
    booted.openai.replies.push(reply.text('From OpenAI.', 'gpt-4o-mini'), reply.text('From OpenAI again.', 'gpt-4.1-mini'));

    const plain = await turn(booted.agentos, { sessionId: 's-plain', selectedPersonaId: 'on-openai' });
    const modelOnly = await turn(booted.agentos, { sessionId: 's-model-only', selectedPersonaId: 'on-openai', options: { preferredModelId: 'gpt-4.1-mini' } });

    expect(plain).toEqual({ text: 'From OpenAI.', error: undefined });
    expect(modelOnly).toEqual({ text: 'From OpenAI again.', error: undefined });
    expect(calls(booted.openai)).toEqual(['gpt-4o-mini', 'gpt-4.1-mini']);
    expect(calls(booted.anthropic)).toEqual([]);
  });

  it("goes back to the persona's provider on a later turn of the same session that names none", async () => {
    booted = await boot();
    booted.anthropic.replies.push(reply.text('From Anthropic.', 'claude-sonnet-4-0'));
    booted.openai.replies.push(reply.text('From OpenAI.', 'gpt-4o-mini'));

    const named = await turn(booted.agentos, {
      sessionId: 's-same', selectedPersonaId: 'on-openai',
      options: { preferredProviderId: 'anthropic', preferredModelId: 'claude-sonnet-4-0' },
    });
    const unnamed = await turn(booted.agentos, { sessionId: 's-same', selectedPersonaId: 'on-openai' });

    expect(named.text).toBe('From Anthropic.');
    expect(unnamed.text).toBe('From OpenAI.');
    expect(calls(booted.anthropic)).toEqual(['claude-sonnet-4-0']);
    expect(calls(booted.openai)).toEqual(['gpt-4o-mini']);
  });

  it('sends the turns of a persona that names Anthropic to Anthropic', async () => {
    booted = await boot();
    booted.anthropic.replies.push(reply.text('From Anthropic.', 'claude-sonnet-4-0'));

    const result = await turn(booted.agentos, { sessionId: 's-persona', selectedPersonaId: 'on-anthropic' });

    expect(result).toEqual({ text: 'From Anthropic.', error: undefined });
    expect(calls(booted.anthropic)).toEqual(['claude-sonnet-4-0']);
    expect(calls(booted.openai)).toEqual([]);
  });
});
