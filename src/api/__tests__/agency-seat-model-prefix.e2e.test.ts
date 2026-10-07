import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
import { agency } from '../agency.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const USAGE = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
function anthropicText(text: string): Response {
  const events = [
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const requests = (p: RegExp) => fetchMock.mock.calls.filter(([u]) => p.test(String(u)));

beforeEach(() => { fetchMock.mockReset(); globalLLMProviderHealth.reset(); });
afterEach(() => vi.unstubAllEnvs());

describe('a seat model that names its provider', () => {
  it.each(['openai', 'ollama'])('in an agency whose provider is %s, the seat goes to Anthropic with the Anthropic key', async (agencyProvider) => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-seat-0001');
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (/api\.anthropic\.com\/v1\/messages/.test(u)) return anthropicText('from anthropic');
      if (/\/v1\/models/.test(u)) return jsonResponse({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] });
      throw new Error(`unexpected request ${u}`);
    });
    const team = agency({
      provider: agencyProvider, model: agencyProvider === 'ollama' ? 'llama3.2' : 'gpt-4.1',
      ...(agencyProvider === 'ollama' ? { baseUrl: 'http://127.0.0.1:11434' } : { apiKey: 'sk-openai-agency-0002' }),
      agents: { seat: { model: 'anthropic:claude-opus-5-5', instructions: 'Answer.' } },
      strategy: 'sequential',
    });
    const result = (await team.generate('hi')) as Record<string, unknown>;
    expect(result.text).toBe('from anthropic');
    expect(requests(/api\.anthropic\.com/)).toHaveLength(1);
    const headers = (requests(/api\.anthropic\.com/)[0][1] as { headers: Record<string, string> }).headers;
    expect(headers['x-api-key']).toBe('sk-ant-seat-0001');
    expect(requests(/openai\.com/)).toHaveLength(0);
  });

  it('a plain-model seat under an agency named only by its model prefix is auto-detected and sends its own key', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-seat-0001');
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (/api\.anthropic\.com\/v1\/messages/.test(u)) return anthropicText('from anthropic');
      throw new Error(`unexpected request ${u}`);
    });
    const team = agency({
      model: 'openai:gpt-4.1', apiKey: 'sk-openai-agency-0002',
      agents: { seat: { model: 'claude-opus-5-5', instructions: 'Answer.' } },
      strategy: 'sequential',
    });
    const result = (await team.generate('hi')) as Record<string, unknown>;
    expect(result.text).toBe('from anthropic');
    expect(requests(/api\.anthropic\.com/)).toHaveLength(1);
    // Auto-detection picked Anthropic; the agency's OpenAI key stays behind.
    const headers = (requests(/api\.anthropic\.com/)[0][1] as { headers: Record<string, string> }).headers;
    expect(headers['x-api-key']).toBe('sk-ant-seat-0001');
  });
});
