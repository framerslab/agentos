/**
 * @file createVisionPipeline.gemini.e2e.test.ts
 * Gemini detection through the real generateText() and GeminiProvider: a
 * pipeline that createVisionPipeline() configured from GEMINI_API_KEY alone,
 * or from GOOGLE_API_KEY alone, sends its cloud request to the Gemini API
 * with that key, and the answer becomes the result's text; an https image
 * URL goes to Gemini to fetch, a prompt Gemini blocked fails the scan, and a
 * malformed data URL is refused before any request without counting against
 * Gemini's health. Only fetch is stubbed.
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

describe('the cloud task, through the real provider', () => {
  it("asks Gemini for a description by default, and for the text alone with cloudTask 'transcribe'", async () => {
    process.env.GEMINI_API_KEY = 'gemini-env-key-e2e';
    const pipeline = await createVisionPipeline({
      strategy: 'cloud-only',
      ocr: 'none',
      handwriting: false,
      documentAI: false,
      embedding: false,
    });

    await pipeline.process(JPEG);
    await pipeline.process(JPEG, { cloudTask: 'transcribe' });

    // The prompt is the text part sent with the image.
    const prompts = fetchMock.mock.calls
      .filter(([url]) => GEMINI.test(String(url)))
      .map(([, init]) => {
        const body = JSON.parse(String((init as RequestInit).body)) as { contents: { parts: { text?: string }[] }[] };
        return body.contents.flatMap((content) => content.parts).flatMap((part) => (part.text ? [part.text] : [])).join('\n');
      });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toMatch(/^Describe this image in detail\./);
    expect(prompts[1]).toMatch(/^Transcribe all the text in this image exactly as written/);
    expect(prompts[1]).not.toMatch(/Describe this image/);
  });
});

describe('image URLs and blocks, through the real provider', () => {
  /** A cloud-only pipeline on the Gemini key alone. */
  async function geminiPipeline() {
    process.env.GEMINI_API_KEY = 'gemini-env-key-e2e';
    return createVisionPipeline({ strategy: 'cloud-only', ocr: 'none', handwriting: false, documentAI: false, embedding: false });
  }

  it('sends an https image URL to Gemini as fileData, and fetches nothing else', async () => {
    const pipeline = await geminiPipeline();

    const result = await pipeline.process('https://images.example.org/receipts/2026-10-12.png');

    expect(result.text).toBe('A receipt for $42.99.');
    // The one request made is Gemini's: the image is not fetched here.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(String(url)).toMatch(GEMINI);
    const body = JSON.parse(String(init.body)) as { contents: { parts: { fileData?: unknown }[] }[] };
    const images = body.contents.flatMap((content) => content.parts).filter((part) => part.fileData);
    expect(images).toEqual([
      { fileData: { fileUri: 'https://images.example.org/receipts/2026-10-12.png', mimeType: 'image/png' } },
    ]);
  });

  it('fails a scan whose prompt Gemini blocked, naming the reason, instead of returning no text', async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ promptFeedback: { blockReason: 'IMAGE_SAFETY' }, usageMetadata: { promptTokenCount: 12, totalTokenCount: 12 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const pipeline = await geminiPipeline();

    await expect(pipeline.process(JPEG)).rejects.toThrow('blockReason: IMAGE_SAFETY');
  });

  it("refuses a malformed data URL before any request, and leaves Gemini's breaker closed", async () => {
    const { globalLLMProviderHealth } = await import('../../../core/safety/LLMProviderHealthRegistry.js');
    globalLLMProviderHealth.reset('gemini');
    const pipeline = await geminiPipeline();

    // Five refusals: the transient class opens the breaker at five failures.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(pipeline.process(`data:${'A'.repeat(50_000)}`)).rejects.toMatchObject({ code: 'INVALID_IMAGE_URL' });
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(globalLLMProviderHealth.isOpen('gemini')).toBe(false);
  });
});
