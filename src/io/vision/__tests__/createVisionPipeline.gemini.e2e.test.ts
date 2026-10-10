/**
 * @file createVisionPipeline.gemini.e2e.test.ts
 * Gemini detection through the real generateText() and GeminiProvider: a
 * pipeline that createVisionPipeline() configured from GEMINI_API_KEY alone,
 * or from GOOGLE_API_KEY alone, sends its cloud request to the Gemini API
 * with that key, and the answer becomes the result's text. Only fetch is
 * stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { createVisionPipeline } from '../index.js';

/** The variables detection reads, cleared for each test and restored after it. */
const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'];
let saved: Record<string, string | undefined> = {};

/** The first bytes of a JPEG, which the cloud tier sends typed as image/jpeg. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08]);

const GEMINI = /generativelanguage\.googleapis\.com/;

/** A generateContent answer from the Gemini API. */
function geminiAnswer(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6, totalTokenCount: 18 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((name) => [name, process.env[name]]));
  for (const name of KEYS) delete process.env[name];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown) =>
    GEMINI.test(String(url)) ? geminiAnswer('A receipt for $42.99.') : new Response('{}', { status: 404 }),
  );
});

afterEach(() => {
  for (const name of KEYS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('createVisionPipeline Gemini detection, through the real provider', () => {
  it.each([
    ['GEMINI_API_KEY', 'gemini-env-key-e2e'],
    ['GOOGLE_API_KEY', 'google-env-key-e2e'],
  ])('sends the cloud request to Gemini with the key from %s alone', async (name, key) => {
    process.env[name] = key;
    const pipeline = await createVisionPipeline({
      strategy: 'cloud-only',
      ocr: 'none',
      handwriting: false,
      documentAI: false,
      embedding: false,
    });

    const result = await pipeline.process(JPEG);

    expect(result.tiers).toEqual(['cloud-vision']);
    expect(result.tierResults[0]).toMatchObject({ tier: 'cloud-vision', provider: 'gemini' });
    expect(result.text).toBe('A receipt for $42.99.');

    const calls = fetchMock.mock.calls.filter(([url]) => GEMINI.test(String(url)));
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [unknown, RequestInit];
    expect(String(url)).toMatch(/:generateContent/);
    expect(new Headers(init.headers).get('x-goog-api-key')).toBe(key);
    // The image went with the prompt as inline data: typed by its bytes, and
    // those bytes exactly.
    const body = JSON.parse(String(init.body)) as { contents: { parts: { inlineData?: unknown }[] }[] };
    const images = body.contents.flatMap((content) => content.parts).filter((part) => part.inlineData);
    expect(images).toEqual([{ inlineData: { mimeType: 'image/jpeg', data: JPEG.toString('base64') } }]);
  });
});
