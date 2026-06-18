import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('fetch', vi.fn());

import { AnthropicProvider, clampAnthropicMaxTokens } from '../implementations/AnthropicProvider';
import type { ChatMessage } from '../IProvider';

describe('clampAnthropicMaxTokens — output ceiling clamp (truncation-retry 64000 hard-400)', () => {
  it('clamps an over-large request to the model output ceiling', () => {
    expect(clampAnthropicMaxTokens('claude-opus-4-8', 200000)).toBe(128000); // Opus real ceiling
    expect(clampAnthropicMaxTokens('claude-haiku-4-5', 100000)).toBe(64000); // Haiku real ceiling
  });

  it('leaves a within-ceiling request untouched (no truncation)', () => {
    expect(clampAnthropicMaxTokens('claude-opus-4-8', 64000)).toBe(64000);
    expect(clampAnthropicMaxTokens('claude-sonnet-4-6', 64000)).toBe(64000);
    expect(clampAnthropicMaxTokens('claude-haiku-4-5', 8000)).toBe(8000);
  });

  it('matches dated model variants by prefix', () => {
    expect(clampAnthropicMaxTokens('claude-opus-4-7-20260501', 200000)).toBe(128000);
  });

  it('passes unknown models through unchanged (no catalog ceiling to enforce)', () => {
    expect(clampAnthropicMaxTokens('some-future-model', 64000)).toBe(64000);
  });
});

describe('Anthropic catalog — corrected per Anthropic specs', () => {
  let provider: AnthropicProvider;
  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'test-key' });
  });

  it('reports the real Opus 4.x ceilings (128K output / 1M context)', async () => {
    const info = await provider.getModelInfo('claude-opus-4-8');
    expect(info?.outputTokenLimit).toBe(128000);
    expect(info?.contextWindowSize).toBe(1000000);
  });

  it('reports Haiku 4.5 at 64K output', async () => {
    // getModelInfo matches the catalog id exactly (the bare alias resolves via
    // clampAnthropicMaxTokens's prefix match instead — covered above).
    const info = await provider.getModelInfo('claude-haiku-4-5-20251001');
    expect(info?.outputTokenLimit).toBe(64000);
  });

  it('clamps the built payload max_tokens to the model ceiling', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const payload = (provider as unknown as {
      buildRequestPayload: (m: string, msgs: ChatMessage[], o: unknown, s: boolean) => { max_tokens: number };
    }).buildRequestPayload('claude-opus-4-8', messages, { maxTokens: 200000 }, true);
    expect(payload.max_tokens).toBe(128000);
  });
});
