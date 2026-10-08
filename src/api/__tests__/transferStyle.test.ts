/**
 * @file transferStyle.test.ts
 * The high-level transferStyle API with a key passed in the call. `fetch` is
 * mocked: no API is called.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { transferStyle } from '../transferStyle.js';

/** A minimal 1x1 PNG, used as both the source image and the style reference. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('transferStyle', () => {
  const saved = { openai: process.env.OPENAI_API_KEY, replicate: process.env.REPLICATE_API_TOKEN };

  afterEach(() => {
    vi.restoreAllMocks();
    if (saved.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.openai;
    if (saved.replicate === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = saved.replicate;
  });

  it('authenticates with the apiKey it is given when the environment has none', async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ created: 1, data: [{ b64_json: 'c3R5bGVk' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await transferStyle({
      provider: 'openai',
      model: 'gpt-image-1',
      image: TINY_PNG,
      styleReference: TINY_PNG,
      prompt: 'Paint it in the style of the reference.',
      apiKey: 'sk-style',
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/images/edits');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-style');
    expect(result.provider).toBe('openai');
    expect(result.images[0]).toMatchObject({ base64: 'c3R5bGVk' });
  });

  it('sends the key to the provider a prefixed model names, not to one the environment selects', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.REPLICATE_API_TOKEN = 'r8-from-env';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ created: 1, data: [{ b64_json: 'c3R5bGVk' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await transferStyle({
      model: 'openai:gpt-image-1',
      image: TINY_PNG,
      styleReference: TINY_PNG,
      prompt: 'Paint it in the style of the reference.',
      apiKey: 'sk-style',
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/images/edits');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-style');
    expect(result.provider).toBe('openai');
  });

  it('refuses a key when the call names no provider', async () => {
    process.env.REPLICATE_API_TOKEN = 'r8-from-env';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      transferStyle({ image: TINY_PNG, styleReference: TINY_PNG, prompt: 'x', apiKey: 'sk-style' }),
    ).rejects.toThrow('an apiKey needs `provider`');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
