import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fetch so initialize()/any request never hits the network.
vi.stubGlobal('fetch', vi.fn());

import {
  OpenAIProvider,
  isOpenAIReasoningModel,
  openAiRejectsReasoningEffortWithTools,
} from '../implementations/OpenAIProvider';
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

describe('OpenAIProvider — reasoning_effort mapping', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OpenAIProvider();
  });

  const build = (model: string, options: unknown): Record<string, unknown> =>
    (provider as unknown as {
      buildChatCompletionPayload: (m: string, msgs: ChatMessage[], o: unknown, s: boolean) => Record<string, unknown>;
    }).buildChatCompletionPayload(model, messages, options, false);

  it('sets reasoning_effort for a gpt-5 reasoning model, mapping max -> xhigh', () => {
    expect(build('gpt-5.5', { effort: 'max' }).reasoning_effort).toBe('xhigh');
    expect(build('o3', { effort: 'high' }).reasoning_effort).toBe('high');
  });

  it('omits reasoning_effort for legacy chat models even when effort is given', () => {
    expect(build('gpt-4o', { effort: 'max' }).reasoning_effort).toBeUndefined();
  });

  it('omits reasoning_effort for a reasoning model when no effort is given', () => {
    expect(build('gpt-5.5', {}).reasoning_effort).toBeUndefined();
  });
});


describe('openAiRejectsReasoningEffortWithTools', () => {
  it('is true for the gpt-5 family, false for o-series and legacy chat models', () => {
    expect(openAiRejectsReasoningEffortWithTools('gpt-5.5')).toBe(true);
    expect(openAiRejectsReasoningEffortWithTools('gpt-5.5-pro')).toBe(true);
    expect(openAiRejectsReasoningEffortWithTools('gpt-5-mini')).toBe(true);
    expect(openAiRejectsReasoningEffortWithTools('o3')).toBe(false);
    expect(openAiRejectsReasoningEffortWithTools('gpt-4o')).toBe(false);
  });
});

describe('OpenAIProvider — reasoning_effort + function tools (gpt-5 chat/completions 400 guard)', () => {
  let provider: OpenAIProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OpenAIProvider();
  });
  const build = (model: string, options: unknown): Record<string, unknown> =>
    (provider as unknown as {
      buildChatCompletionPayload: (m: string, msgs: ChatMessage[], o: unknown, s: boolean) => Record<string, unknown>;
    }).buildChatCompletionPayload(model, messages, options, false);

  const TOOLS = [{ type: 'function', function: { name: 'emit', parameters: { type: 'object', properties: {} } } }];

  it('DROPS reasoning_effort when a gpt-5 request carries function tools (would 400 otherwise)', () => {
    const payload = build('gpt-5.5', { effort: 'max', tools: TOOLS });
    expect(payload.reasoning_effort).toBeUndefined();
    expect(payload.tools).toEqual(TOOLS); // tools still sent
  });

  it('KEEPS reasoning_effort for a gpt-5 request with NO tools', () => {
    expect(build('gpt-5.5', { effort: 'max' }).reasoning_effort).toBe('xhigh');
  });

  it('KEEPS reasoning_effort for an o-series request WITH tools (o-series accepts the combo)', () => {
    const payload = build('o3', { effort: 'high', tools: TOOLS });
    expect(payload.reasoning_effort).toBe('high');
    expect(payload.tools).toEqual(TOOLS);
  });

  it('ignores an empty tools array (no incompatibility to guard against)', () => {
    expect(build('gpt-5.5', { effort: 'max', tools: [] }).reasoning_effort).toBe('xhigh');
  });
});
