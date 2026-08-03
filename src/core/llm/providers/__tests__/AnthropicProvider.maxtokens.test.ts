import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('fetch', vi.fn());

import {
  AnthropicProvider,
  clampAnthropicMaxTokens,
  resolveAnthropicModelEntry,
} from '../implementations/AnthropicProvider';
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

describe('resolveAnthropicModelEntry — shared catalog resolution (pricing + clamp)', () => {
  it('resolves an exact catalog id', () => {
    expect(resolveAnthropicModelEntry('claude-sonnet-5')?.modelId).toBe('claude-sonnet-5');
  });

  it('resolves a dated snapshot id to its catalog row by prefix', () => {
    expect(resolveAnthropicModelEntry('claude-sonnet-5-20260101')?.modelId).toBe('claude-sonnet-5');
    expect(resolveAnthropicModelEntry('claude-sonnet-4-6-20260115')?.modelId).toBe(
      'claude-sonnet-4-6',
    );
  });

  it('resolves a bare alias to a dated catalog row', () => {
    expect(resolveAnthropicModelEntry('claude-haiku-4-5')?.modelId).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('returns undefined for unknown models', () => {
    expect(resolveAnthropicModelEntry('some-future-model')).toBeUndefined();
  });

  it('prices dated snapshot ids through estimateCost instead of undefined (unmetered spend)', async () => {
    const provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'test-key' });
    const priced = provider as unknown as {
      estimateCost(i: number, o: number, m: string): number | undefined;
    };
    // Sonnet 5 sticker: $3/1M input + $15/1M output.
    expect(priced.estimateCost(1_000_000, 1_000_000, 'claude-sonnet-5-20260101')).toBeCloseTo(
      18,
      5,
    );
    expect(priced.estimateCost(1000, 1000, 'not-a-real-model')).toBeUndefined();
  });
});

describe('claude-sonnet-4-6 output ceiling — 128K per current Anthropic specs', () => {
  it('no longer clamps a >64K caller budget on sonnet-4-6', () => {
    expect(clampAnthropicMaxTokens('claude-sonnet-4-6', 100000)).toBe(100000);
    expect(clampAnthropicMaxTokens('claude-sonnet-4-6', 200000)).toBe(128000);
  });

  it('reports the corrected ceiling via getModelInfo; legacy Sonnet 4.5 stays 64K', async () => {
    const provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'test-key' });
    const info = await provider.getModelInfo('claude-sonnet-4-6');
    expect(info?.outputTokenLimit).toBe(128000);
    const legacy = await provider.getModelInfo('claude-sonnet-4-5');
    expect(legacy?.outputTokenLimit).toBe(64000);
  });
});
