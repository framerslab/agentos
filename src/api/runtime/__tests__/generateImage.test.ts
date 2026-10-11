import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateImage } from '../generateImage.js';
import { clearRecordedAgentOSUsage, getRecordedAgentOSUsage } from '../usageLedger.js';

describe('generateImage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('generates images through the OpenAI provider abstraction with namespaced provider options', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          created: 123,
          data: [{ b64_json: 'ZmFrZQ==', revised_prompt: 'revised cat prompt' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await generateImage({
      model: 'openai:gpt-image-2.5-flare',
      prompt: 'A cat in a suit',
      apiKey: 'test-key',
      outputFormat: 'png',
      providerOptions: {
        openai: {
          style: 'natural',
          moderation: 'low',
          extraBody: {
            quality: 'high',
          },
        },
      },
    });

    const [, requestInit] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(String(requestInit?.body));

    expect(result.provider).toBe('openai');
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      mimeType: 'image/png',
      base64: 'ZmFrZQ==',
      revisedPrompt: 'revised cat prompt',
    });
    // `style` was DALL·E 3's: a GPT Image model is not sent it.
    expect(body).not.toHaveProperty('style');
    expect(body.moderation).toBe('low');
    expect(body.quality).toBe('high');
  });

  it('generates images through the OpenRouter provider abstraction', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          created: 456,
          model: 'google/gemini-2.5-flash-image',
          usage: {
            prompt_tokens: 11,
            completion_tokens: 22,
            total_tokens: 33,
            cost: 0.12,
          },
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Here is your image.',
                images: [
                  {
                    image_url: {
                      url: 'data:image/png;base64,aGVsbG8=',
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await generateImage({
      model: 'openrouter:google/gemini-2.5-flash-image',
      prompt: 'Generate a futuristic skyline',
      apiKey: 'test-key',
      modalities: ['image', 'text'],
      aspectRatio: '16:9',
      size: '2K',
      providerOptions: {
        openrouter: {
          provider: {
            order: ['google'],
          },
          extraBody: {
            temperature: 0.2,
          },
        },
      },
    });

    const [, requestInit] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(String(requestInit?.body));

    expect(result.provider).toBe('openrouter');
    expect(result.text).toBe('Here is your image.');
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      mimeType: 'image/png',
      base64: 'aGVsbG8=',
    });
    expect(result.usage).toMatchObject({
      totalImages: 1,
      totalTokens: 33,
      totalCostUSD: 0.12,
    });
    expect(body.provider).toEqual({ order: ['google'] });
    expect(body.temperature).toBe(0.2);
  });

  it('generates images through the Stability provider abstraction', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          image: 'c3RhYmlsaXR5',
          seed: 77,
          finish_reason: 'SUCCESS',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await generateImage({
      model: 'stability:stable-image-core',
      prompt: 'A watercolor fox in the forest',
      apiKey: 'stab-key',
      outputFormat: 'png',
      negativePrompt: 'blurry, low contrast',
      providerOptions: {
        stability: {
          engine: 'sd3-large',
          stylePreset: 'photographic',
          seed: 77,
          cfgScale: 8,
          steps: 30,
        },
      },
    });

    const [url, requestInit] = vi.mocked(globalThis.fetch).mock.calls[0];
    const formData = requestInit?.body as FormData;

    expect(String(url)).toContain('/v2beta/stable-image/generate/sd3');
    expect(formData.get('prompt')).toBe('A watercolor fox in the forest');
    expect(formData.get('negative_prompt')).toBe('blurry, low contrast');
    expect(formData.get('model')).toBe('sd3-large');
    expect(formData.get('style_preset')).toBe('photographic');
    expect(formData.get('seed')).toBe('77');
    expect(result.provider).toBe('stability');
    expect(result.model).toBe('sd3-large');
    expect(result.images[0]).toMatchObject({
      mimeType: 'image/png',
      base64: 'c3RhYmlsaXR5',
    });
  });

  it('generates images through the Replicate provider abstraction', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'succeeded',
          output: ['https://replicate.delivery/pbxt/test-image.webp'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await generateImage({
      model: 'replicate:black-forest-labs/flux-schnell',
      prompt: 'A minimalist product photo of a watch',
      apiKey: 'replicate-token',
      aspectRatio: '16:9',
      outputFormat: 'webp',
      seed: 1234,
      providerOptions: {
        replicate: {
          outputQuality: 85,
          input: {
            go_fast: true,
          },
        },
      },
    });

    const [requestUrl, requestInit] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(String(requestInit?.body));

    // Without an inline version hash, the request routes through the
    // modern /models/{owner}/{name}/predictions endpoint — model name
    // appears in the URL, not in body.version.
    expect(String(requestUrl)).toContain('black-forest-labs/flux-schnell');
    expect(body.input.prompt).toBe('A minimalist product photo of a watch');
    expect(body.input.aspect_ratio).toBe('16:9');
    expect(body.input.output_format).toBe('webp');
    expect(body.input.seed).toBe(1234);
    expect(body.input.output_quality).toBe(85);
    expect(body.input.go_fast).toBe(true);
    expect(result.provider).toBe('replicate');
    expect(result.images[0]).toMatchObject({
      url: 'https://replicate.delivery/pbxt/test-image.webp',
    });
  });

  it('persists image usage when a ledger path is configured', async () => {
    const ledgerPath = path.join(os.tmpdir(), `agentos-generate-image-${Date.now()}.jsonl`);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          created: 999,
          model: 'google/gemini-2.5-flash-image',
          usage: {
            prompt_tokens: 20,
            completion_tokens: 0,
            total_tokens: 20,
            cost: 0.05,
          },
          choices: [
            {
              message: {
                role: 'assistant',
                images: [
                  {
                    image_url: {
                      url: 'https://example.com/image.png',
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await generateImage({
      model: 'openrouter:google/gemini-2.5-flash-image',
      prompt: 'A desert sunrise',
      apiKey: 'test-key',
      usageLedger: { path: ledgerPath, sessionId: 'image-session' },
    });

    await expect(getRecordedAgentOSUsage({ path: ledgerPath, sessionId: 'image-session' })).resolves.toEqual({
      sessionId: 'image-session',
      personaId: undefined,
      promptTokens: 20,
      completionTokens: 0,
      totalTokens: 20,
      costUSD: 0.05,
      calls: 1,
    });

    await clearRecordedAgentOSUsage({ path: ledgerPath });
  });

  it('auto-detects an image provider using media preferences instead of the generic provider order', async () => {
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      ANTHROPIC_API_KEY: 'anthropic-test',
      OPENAI_API_KEY: 'openai-test',
      STABILITY_API_KEY: 'stability-test',
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          image: 'c3RhYmlsaXR5',
          seed: 77,
          finish_reason: 'SUCCESS',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    try {
      const result = await generateImage({
        prompt: 'A watercolor fox in the forest',
        providerPreferences: {
          blocked: ['openai'],
        },
      });

      const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(String(url)).toContain('/v2beta/stable-image/generate/');
      expect(result.provider).toBe('stability');
      expect(result.images[0]).toMatchObject({
        mimeType: 'image/png',
        base64: 'c3RhYmlsaXR5',
      });
    } finally {
      process.env = originalEnv;
    }
  });
});
