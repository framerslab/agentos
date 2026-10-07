import { describe, expect, it } from 'vitest';
import { checkContextFit } from '../contextWindowFit.js';
import { ContextWindowExceededError } from '../../../core/llm/providers/errors/ContextWindowExceededError.js';
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '../../../core/llm/providers/errors/errorCodes.js';
import { isRetryableError } from '../../generateText.js';

const MAGNUM = 'anthracite-org/magnum-v4-72b';
const LLAMA = 'meta-llama/llama-3.3-70b-instruct';

/**
 * One user message of `chars` characters. The estimate is chars / 4 plus
 * 10%, rounded up: 145_452 chars -> 40_000 tokens; 112_727 -> 31_000;
 * 105_454 -> 29_000. A message's `role` is not counted.
 */
function messagesOf(chars: number) {
  return [{ role: 'user', content: 'x'.repeat(chars) }];
}

describe('checkContextFit', () => {
  it('rejects 40k estimated tokens on magnum and accepts them on llama-3.3-70b', () => {
    const magnum = checkContextFit({ provider: 'openrouter', model: MAGNUM, messages: messagesOf(145_452), maxTokens: 800 });
    expect(magnum).toEqual({ fits: false, contextWindow: 32_768, estimatedInputTokens: 40_000, outputTokens: 800 });
    const llama = checkContextFit({ provider: 'openrouter', model: LLAMA, messages: messagesOf(145_452), maxTokens: 800 });
    expect(llama.fits).toBe(true);
  });

  it('counts the hop output budget: headroom can tip a request over', () => {
    const plain = checkContextFit({ provider: 'openrouter', model: MAGNUM, messages: messagesOf(112_727), maxTokens: 800 });
    expect(plain).toMatchObject({ fits: true, estimatedInputTokens: 31_000 });
    const withHeadroom = checkContextFit({
      provider: 'openrouter',
      model: MAGNUM,
      messages: messagesOf(112_727),
      maxTokens: 1_824,
    });
    expect(withHeadroom.fits).toBe(false);
  });

  it('counts the provider default when the call sets no maxTokens', () => {
    const fit = checkContextFit({ provider: 'openrouter', model: MAGNUM, messages: messagesOf(105_454) });
    expect(fit).toMatchObject({ fits: false, estimatedInputTokens: 29_000, outputTokens: 4_096 });
  });

  it('lets customModelParams.max_tokens win, as in the payload', () => {
    const raised = checkContextFit({
      provider: 'openrouter',
      model: MAGNUM,
      messages: messagesOf(105_454),
      maxTokens: 800,
      customModelParams: { max_tokens: 8_000 },
    });
    expect(raised).toMatchObject({ fits: false, outputTokens: 8_000 });
    const lowered = checkContextFit({
      provider: 'openrouter',
      model: MAGNUM,
      messages: messagesOf(105_454),
      customModelParams: { max_tokens: 1_000 },
    });
    expect(lowered).toMatchObject({ fits: true, outputTokens: 1_000 });
  });

  it('counts system blocks and tool schemas, not image parts', () => {
    const base = checkContextFit({ provider: 'openrouter', model: LLAMA, messages: [{ role: 'user', content: 'hi' }] });
    const withSystem = checkContextFit({
      provider: 'openrouter',
      model: LLAMA,
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'y'.repeat(4_000), cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(withSystem.estimatedInputTokens).toBeGreaterThan(base.estimatedInputTokens + 1_000);
    const withTools = checkContextFit({
      provider: 'openrouter',
      model: LLAMA,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'd'.repeat(4_000), parameters: {} } }],
    });
    expect(withTools.estimatedInputTokens).toBeGreaterThan(base.estimatedInputTokens + 1_000);
    const withImage = checkContextFit({
      provider: 'openrouter',
      model: LLAMA,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(400_000)}` } },
          ],
        },
      ],
    });
    expect(withImage.estimatedInputTokens).toBe(base.estimatedInputTokens);
  });

  it('does not count Gemini thought signatures, which OpenRouter never receives', () => {
    const turn = (thoughtSignature?: string) => [
      { role: 'user', content: 'x'.repeat(90_909) },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
            ...(thoughtSignature !== undefined ? { thoughtSignature } : {}),
          },
        ],
      },
    ];
    const without = checkContextFit({ provider: 'openrouter', model: MAGNUM, messages: turn() });
    const withSignature = checkContextFit({ provider: 'openrouter', model: MAGNUM, messages: turn('s'.repeat(16_000)) });
    expect(withSignature.estimatedInputTokens).toBe(without.estimatedInputTokens);
    expect(withSignature.fits).toBe(true);
  });

  it("takes a request as fitting when the call enables OpenRouter's context compression", () => {
    const compressed = checkContextFit({
      provider: 'openrouter',
      model: MAGNUM,
      messages: messagesOf(145_452),
      customModelParams: { plugins: [{ id: 'context-compression' }] },
    });
    expect(compressed).toMatchObject({ fits: true, contextWindow: 32_768, estimatedInputTokens: 40_000 });
    const disabled = checkContextFit({
      provider: 'openrouter',
      model: MAGNUM,
      messages: messagesOf(145_452),
      customModelParams: { plugins: [{ id: 'context-compression', enabled: false }] },
    });
    expect(disabled.fits).toBe(false);
    const otherPlugin = checkContextFit({
      provider: 'openrouter',
      model: MAGNUM,
      messages: messagesOf(145_452),
      customModelParams: { plugins: [{ id: 'web' }] },
    });
    expect(otherPlugin.fits).toBe(false);
  });

  it('takes a model without a known window as fitting', () => {
    const fit = checkContextFit({ provider: 'openai', model: 'gpt-5.6-sol', messages: messagesOf(1_000_000) });
    expect(fit.fits).toBe(true);
    expect(fit).not.toHaveProperty('contextWindow');
    // A catalog model id on another provider is not the catalog entry.
    expect(checkContextFit({ provider: 'openai', model: MAGNUM, messages: messagesOf(145_452) }).fits).toBe(true);
  });
});

describe('ContextWindowExceededError', () => {
  it('carries the retryable code and no HTTP status', () => {
    const err = new ContextWindowExceededError({
      provider: 'openrouter',
      model: MAGNUM,
      contextWindow: 32_768,
      estimatedInputTokens: 40_000,
      outputTokens: 800,
    });
    expect(err.code).toBe(CONTEXT_WINDOW_EXCEEDED_CODE);
    expect((err as { httpStatus?: unknown }).httpStatus).toBeUndefined();
    expect(err.name).toBe('ContextWindowExceededError');
    expect(err).toBeInstanceOf(Error);
    expect(isRetryableError(err)).toBe(true);
  });
});
