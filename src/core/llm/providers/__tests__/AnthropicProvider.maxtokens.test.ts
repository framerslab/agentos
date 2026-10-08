import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('fetch', vi.fn());

import {
  AnthropicProvider,
  clampAnthropicMaxTokens,
  estimateAnthropicCostUSD,
  resolveAnthropicModelEntry,
} from '../implementations/AnthropicProvider';
import type { ChatMessage } from '../IProvider';

describe('clampAnthropicMaxTokens — output ceiling clamp (truncation-retry 64000 hard-400)', () => {
  it('clamps an over-large request to the model output ceiling', () => {
    expect(clampAnthropicMaxTokens('claude-opus-4-8', 200000)).toBe(128000); // Opus real ceiling
    expect(clampAnthropicMaxTokens('claude-haiku-4-5', 100000)).toBe(64000); // Haiku real ceiling
  });

  it('clamps Claude Opus 4.5 to its 64K ceiling through the bare alias and the dated id', () => {
    expect(clampAnthropicMaxTokens('claude-opus-4-5', 128000)).toBe(64000);
    expect(clampAnthropicMaxTokens('claude-opus-4-5-20251101', 128000)).toBe(64000);
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

  it('returns undefined for unknown models and for an empty id', () => {
    expect(resolveAnthropicModelEntry('some-future-model')).toBeUndefined();
    // Every catalog id starts with '', so the prefix fallback alone would
    // resolve an empty model echo to the first row and price it as Opus 5.5.
    expect(resolveAnthropicModelEntry('')).toBeUndefined();
  });

  it('resolves a dated Sonnet 5.5 id to its own row, not to Sonnet 5', () => {
    expect(resolveAnthropicModelEntry('claude-sonnet-5-5-20261001')?.modelId).toBe('claude-sonnet-5-5');
    expect(resolveAnthropicModelEntry('claude-sonnet-5-20260101')?.modelId).toBe('claude-sonnet-5');
  });

  it('resolves the bare Opus 4.5 alias to the dated row', () => {
    expect(resolveAnthropicModelEntry('claude-opus-4-5')?.modelId).toBe('claude-opus-4-5-20251101');
  });

  it('prices dated snapshot ids instead of returning undefined (unmetered spend)', () => {
    const million = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    // Sonnet 5 and Sonnet 5.5 bill $2/$10, Opus 4.5 $5/$25.
    expect(estimateAnthropicCostUSD('claude-sonnet-5-20260101', million)).toBeCloseTo(12, 5);
    expect(estimateAnthropicCostUSD('claude-sonnet-5-5', million)).toBeCloseTo(12, 5);
    expect(estimateAnthropicCostUSD('claude-opus-4-5', million)).toBeCloseTo(30, 5);
    expect(estimateAnthropicCostUSD('claude-opus-4-5-20251101', million)).toBeCloseTo(30, 5);
    expect(
      estimateAnthropicCostUSD('not-a-real-model', { input_tokens: 1000, output_tokens: 1000 }),
    ).toBeUndefined();
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
