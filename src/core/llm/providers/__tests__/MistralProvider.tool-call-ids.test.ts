/**
 * @fileoverview Mistral rejects any tool call id that is not nine letters and
 * digits. A conversation can carry ids another provider issued (session
 * history, or a fallback that continues after completed tool rounds), so the
 * provider maps them onto Mistral's form, keeping each call and its result
 * matched. Runs the real provider and its OpenAI delegate with fetch stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { MistralProvider, toMistralToolCallId } from '../implementations/MistralProvider';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: unknown, init?: { method?: string }) => {
    if ((init?.method ?? 'GET') === 'GET') return jsonResponse({ object: 'list', data: [] });
    return jsonResponse({
      id: 'cmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'mistral-large-latest',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
  });
});

describe('MistralProvider tool call ids', () => {
  it('sends foreign tool call ids in the nine-character form, matched between call and result', async () => {
    const provider = new MistralProvider();
    await provider.initialize({ apiKey: 'mistral-test-key' });

    await provider.generateCompletion(
      'mistral-large-latest',
      [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'toolu_01AbCdEfGh', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
            { id: 'Ab3dE5gH9', type: 'function', function: { name: 'get_news', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'toolu_01AbCdEfGh', content: '{"temp_c":18}' },
        { role: 'tool', tool_call_id: 'Ab3dE5gH9', content: '{"headline":"Rain"}' },
      ],
      {},
    );

    const post = fetchMock.mock.calls.find(([, init]) => (init as { method?: string }).method === 'POST');
    const body = JSON.parse(String((post![1] as { body?: unknown }).body)) as {
      messages: Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>;
    };
    const callIds = body.messages[1].tool_calls!.map((c) => c.id);
    expect(callIds[0]).toMatch(/^[A-Za-z0-9]{9}$/);
    expect(callIds[1]).toBe('Ab3dE5gH9');
    expect(body.messages[2].tool_call_id).toBe(callIds[0]);
    expect(body.messages[3].tool_call_id).toBe('Ab3dE5gH9');
    expect(toMistralToolCallId('toolu_01AbCdEfGh')).toBe(callIds[0]);
  });
});
