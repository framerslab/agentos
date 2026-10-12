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
          ],
        },
      ],
      {},
    );

    const [, body] = postMock.mock.calls[0];
    // No text: the content is empty, not the parts (and their data URLs) as JSON.
    expect(body.messages).toEqual([
      expect.objectContaining({ role: 'user', content: '', images: ['Zm9vYmFy', 'Zm9vYmFy==', 'PHN2Zz4='] }),
    ]);
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
