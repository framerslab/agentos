import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider } from '../implementations/OpenRouterProvider';
import type { ChatMessage } from '../IProvider';

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

function okResponse(provider?: string) {
  return {
    id: 'gen-1',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'meta-llama/llama-3.3-70b-instruct',
    ...(provider ? { provider } : {}),
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

describe('OpenRouterProvider — serving-provider attribution', () => {
  let provider: OpenRouterProvider;
  let makeApiRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = new OpenRouterProvider();
    makeApiRequest = vi.fn();
    Object.assign(provider as unknown as Record<string, unknown>, {
      ensureInitialized: () => {},
      config: { requestTimeout: 60000, streamRequestTimeout: 120000 },
      makeApiRequest,
    });
  });

  it('maps the response body provider field onto servingProvider', async () => {
    // OpenRouter reports which upstream host served the completion (Groq,
    // DeepInfra, ...). Provider-routing prefs change this host, so latency
    // telemetry is blind without the mapping.
    makeApiRequest.mockResolvedValue(okResponse('Groq'));

    const result = await provider.generateCompletion(
      'meta-llama/llama-3.3-70b-instruct',
      messages,
      {} as never
    );

    expect(result.servingProvider).toBe('Groq');
  });

  it('omits servingProvider when the response body has no provider field', async () => {
    makeApiRequest.mockResolvedValue(okResponse());

    const result = await provider.generateCompletion(
      'meta-llama/llama-3.3-70b-instruct',
      messages,
      {} as never
    );

    expect(result.servingProvider).toBeUndefined();
    expect('servingProvider' in result).toBe(false);
  });
});
