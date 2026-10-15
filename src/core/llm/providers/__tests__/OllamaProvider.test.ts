import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { postMock, getMock, createMock } = vi.hoisted(() => {
  const postMock = vi.fn();
  const getMock = vi.fn();
  const createMock = vi.fn(() => ({
    defaults: { baseURL: 'http://localhost:11434/api' },
    post: postMock,
  }));

  return { postMock, getMock, createMock };
});

vi.mock('axios', () => ({
  default: {
    create: createMock,
    get: getMock,
  },
  create: createMock,
  get: getMock,
}));

import { OllamaProvider } from '../implementations/OllamaProvider';

describe('OllamaProvider multimodal message mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockResolvedValue({ data: 'Ollama is running' });
    postMock.mockResolvedValue({
      status: 200,
      data: {
        model: 'llava',
        created_at: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: 'caption',
        },
        done: true,
        prompt_eval_count: 6,
        eval_count: 3,
      },
    });
  });

  it.each(['\n', ''])('buffers a JSON response split across chunks with terminator %j', async (terminator) => {
    const provider = new OllamaProvider();
    await provider.initialize({ baseURL: 'http://localhost:11434' });
    const content = 'sentinel-words-7731-é';
    const bytes = Buffer.from(JSON.stringify({
      model: 'llava', created_at: '2026-01-01T00:00:00Z',
      message: { role: 'assistant', content }, done: true,
    }) + terminator);
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    postMock.mockResolvedValueOnce({ data: Readable.from([bytes.subarray(0, split), bytes.subarray(split)]) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const events = [];
      for await (const event of provider.generateCompletionStream('llava', [{ role: 'user', content: 'hello' }], {})) events.push(event);
      expect(events).toHaveLength(1);
      expect(events[0].responseTextDelta).toBe(content);
      expect(events[0].isFinal).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('logs only the byte length and a fixed diagnostic for malformed stream JSON', async () => {
    const provider = new OllamaProvider();
    await provider.initialize({ baseURL: 'http://localhost:11434' });
    const raw = 'sentinel-words-7731-é';
    postMock.mockResolvedValueOnce({ data: Readable.from([Buffer.from(raw + '\n')]) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const events = [];
      for await (const event of provider.generateCompletionStream('llava', [], {})) events.push(event);
      expect(events).toEqual([]);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'OllamaProvider: Could not parse stream chunk JSON:',
        { eventBytes: Buffer.byteLength(raw), error: 'Invalid stream JSON.' },
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('sentinel-words-7731');
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves inline base64 image inputs for vision-capable Ollama chat models', async () => {
    const provider = new OllamaProvider();
    await provider.initialize({ baseURL: 'http://localhost:11434', defaultModelId: 'llava' });

    await provider.generateCompletion(
      'llava',
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image for retrieval.' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,Zm9vYmFy' },
            },
          ],
        },
      ],
      {}
    );

    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith(
      '/chat',
      expect.objectContaining({
        model: 'llava',
        messages: [
          expect.objectContaining({
            role: 'user',
            content: 'Describe this image for retrieval.',
            images: ['Zm9vYmFy'],
          }),
        ],
      }),
      // CR8: per-call requestTimeout is now threaded as the axios request config.
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('sends an image-only message with empty text, and reads a data URL as WHATWG Fetch does', async () => {
    const provider = new OllamaProvider();
    await provider.initialize({ baseURL: 'http://localhost:11434', defaultModelId: 'llava' });

    await provider.generateCompletion(
      'llava',
      [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png; base64 ,Zm9v\nYmFy' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,Zm9vYmFy%3D%3D' } },
            { type: 'image_url', image_url: { url: 'data:image/svg+xml,%3Csvg%3E' } },
            // The fragment is not part of the data.
            { type: 'image_url', image_url: { url: 'data:image/svg+xml,%3Csvg%2F%3E#icon' } },
          ],
        },
      ],
      {},
    );

    const [, body] = postMock.mock.calls[0];
    // No text: the content is empty, not the parts (and their data URLs) as JSON.
    expect(body.messages).toEqual([
      expect.objectContaining({ role: 'user', content: '', images: ['Zm9vYmFy', 'Zm9vYmFy==', 'PHN2Zz4=', 'PHN2Zy8+'] }),
    ]);
  });

  it('sends the parts of a message with no text and no image, such as a tool result, as JSON', async () => {
    const provider = new OllamaProvider();
    await provider.initialize({ baseURL: 'http://localhost:11434', defaultModelId: 'llava' });
    const toolResult = { type: 'tool_result', tool_use_id: 'call_1', content: 'It is 14 C in Lisbon.' };

    await provider.generateCompletion(
      'llava',
      [{ role: 'user', content: [toolResult as never] }],
      {},
    );

    const [, body] = postMock.mock.calls[0];
    expect(body.messages).toEqual([expect.objectContaining({ role: 'user', content: JSON.stringify([toolResult]) })]);
    expect(body.messages[0]).not.toHaveProperty('images');
  });

  it('refuses an image URL Ollama cannot be sent, instead of dropping it, before any request', async () => {
    const provider = new OllamaProvider();
    await provider.initialize({ baseURL: 'http://localhost:11434', defaultModelId: 'llava' });

    const refused = provider.generateCompletion(
      'llava',
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this picture?' },
            { type: 'image_url', image_url: { url: 'https://example.org/scan.png' } },
          ],
        },
      ],
      {},
    );

    await expect(refused).rejects.toMatchObject({ code: 'IMAGE_URL_NOT_SUPPORTED', httpStatus: 400 });
    expect(postMock).not.toHaveBeenCalled();
  });
});
