import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fetch so initialize()/any request never hits the network.
vi.stubGlobal('fetch', vi.fn());

import { OpenAIProvider, isOpenAIReasoningModel } from '../implementations/OpenAIProvider';
import type { ChatMessage } from '../IProvider';

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

describe('isOpenAIReasoningModel', () => {
  it('matches o-series and gpt-5 family, not legacy chat models', () => {
    expect(isOpenAIReasoningModel('o3')).toBe(true);
    expect(isOpenAIReasoningModel('o1-mini')).toBe(true);
    expect(isOpenAIReasoningModel('o4-mini')).toBe(true);
    expect(isOpenAIReasoningModel('gpt-5.5')).toBe(true);
    expect(isOpenAIReasoningModel('gpt-5.5-pro')).toBe(true);
    expect(isOpenAIReasoningModel('gpt-5.4')).toBe(true);
    expect(isOpenAIReasoningModel('gpt-5-mini')).toBe(true);
    expect(isOpenAIReasoningModel('gpt-4o')).toBe(false);
    expect(isOpenAIReasoningModel('gpt-4-turbo')).toBe(false);
    expect(isOpenAIReasoningModel('gpt-3.5-turbo')).toBe(false);
  });
});

describe('OpenAIProvider — reasoning-model sampling-param guard', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    // buildChatCompletionPayload is a pure payload builder (modelId + messages +
    // options → request body); it needs no initialization / network, so we skip
    // initialize() which would call refreshAvailableModels over the network.
    provider = new OpenAIProvider();
  });

  it('omits temperature/top_p for reasoning models (o-series/gpt-5 reject them with HTTP 400)', () => {
    const payload = (provider as unknown as {
      buildChatCompletionPayload: (m: string, msgs: ChatMessage[], o: unknown, s: boolean) => Record<string, unknown>;
    }).buildChatCompletionPayload('o3', messages, { temperature: 0.7, topP: 0.9 }, false);
    expect(payload.temperature).toBeUndefined();
    expect(payload.top_p).toBeUndefined();
  });

  it('keeps temperature/top_p for legacy chat models', () => {
    const payload = (provider as unknown as {
      buildChatCompletionPayload: (m: string, msgs: ChatMessage[], o: unknown, s: boolean) => Record<string, unknown>;
    }).buildChatCompletionPayload('gpt-4o', messages, { temperature: 0.7, topP: 0.9 }, false);
    expect(payload.temperature).toBe(0.7);
    expect(payload.top_p).toBe(0.9);
  });
});
