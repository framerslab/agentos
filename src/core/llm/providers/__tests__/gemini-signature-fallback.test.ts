/**
 * @fileoverview A Gemini tool call carries a `thoughtSignature` that only
 * Gemini understands. When a fallback chain replays that history through
 * another provider, the Chat Completions adapters must send just the standard
 * `id`, `type` and `function` fields. The OpenAI case builds the real request
 * body through generateCompletion; OpenRouterProvider sends over axios, so its
 * case calls the message mapper that builds its request body.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { OpenAIProvider } from '../implementations/OpenAIProvider';
import { OpenRouterProvider } from '../implementations/OpenRouterProvider';
import type { ChatMessage } from '../IProvider';

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    body: null,
  } as unknown as Response;
}

const completion = {
  id: 'chatcmpl-fallback',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o-2024-08-06',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
};

/** History whose assistant turn was produced by Gemini 3, signature attached. */
const geminiHistory: ChatMessage[] = [
  { role: 'user', content: 'Weather in Paris?' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'call_gemini_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
      thoughtSignature: 'sig-from-gemini',
    }],
  },
  { role: 'tool', tool_call_id: 'call_gemini_1', name: 'get_weather', content: '{"temp_c":18}' },
];

/** The request body of the first non-listing call. */
const completionBody = () => {
  const call = fetchMock.mock.calls.find(([url]) => !String(url).endsWith('/models'));
  return JSON.parse(call![1].body);
};

describe('Gemini thought signatures on non-Gemini providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/models') ? jsonResponse({ object: 'list', data: [] }) : jsonResponse(completion),
    );
  });

  it('OpenAIProvider sends only the standard tool-call fields', async () => {
    const provider = new OpenAIProvider();
    await provider.initialize({ apiKey: 'sk-test-key' });
    await provider.generateCompletion('gpt-4o', geminiHistory, {});

    const assistant = completionBody().messages.find((m: { role: string }) => m.role === 'assistant');
    expect(assistant.tool_calls).toEqual([
      { id: 'call_gemini_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
    ]);
  });

  it('OpenRouterProvider maps only the standard tool-call fields', () => {
    const provider = new OpenRouterProvider();
    const mapMessages = (provider as unknown as Record<string, (m: ChatMessage[]) => ChatMessage[]>)
      .mapToOpenRouterMessages.bind(provider);

    const assistant = mapMessages(geminiHistory).find(m => m.role === 'assistant')!;
    expect(assistant.tool_calls).toEqual([
      { id: 'call_gemini_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
    ]);
  });
});
