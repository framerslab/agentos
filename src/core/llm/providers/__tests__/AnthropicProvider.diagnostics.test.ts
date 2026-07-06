import { describe, it, expect, beforeEach } from 'vitest';

import {
  AnthropicProvider,
  normalizeCacheDiagnostics,
} from '../implementations/AnthropicProvider';
import type { ChatMessage } from '../IProvider';

/**
 * Cache diagnostics (beta `cache-diagnosis-2026-04-07`) — request/response
 * plumbing on the Anthropic provider:
 *
 * - `options.cacheDiagnostics` → `payload.diagnostics.previous_message_id`
 * - the beta header rides exactly the requests that carry the payload field,
 *   comma-composing with the interleaved-thinking beta when both apply
 * - the response's `diagnostics` verdict normalizes losslessly into the
 *   camelCased `cacheDiagnostics` on ModelCompletionResponse
 */

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are a test.' },
  { role: 'user', content: 'Hello.' },
];

function makeApiResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_test_1',
    type: 'message' as const,
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'Hi.' }],
    model: 'claude-opus-4-8',
    stop_reason: 'end_turn' as const,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

describe('normalizeCacheDiagnostics', () => {
  it('maps null (compared, no divergence / first-turn opt-in) to null', () => {
    expect(normalizeCacheDiagnostics(null)).toBeNull();
    expect(normalizeCacheDiagnostics(undefined)).toBeNull();
  });

  it('maps a pending comparison to { cacheMissReason: null }', () => {
    expect(normalizeCacheDiagnostics({ cache_miss_reason: null })).toEqual({
      cacheMissReason: null,
    });
  });

  it('maps a populated miss reason field-for-field', () => {
    expect(
      normalizeCacheDiagnostics({
        cache_miss_reason: { type: 'system_changed', cache_missed_input_tokens: 41850 },
      }),
    ).toEqual({
      cacheMissReason: { type: 'system_changed', cacheMissedInputTokens: 41850 },
    });
  });

  it('omits cacheMissedInputTokens when the API omits it (non-*_changed types)', () => {
    expect(
      normalizeCacheDiagnostics({ cache_miss_reason: { type: 'previous_message_not_found' } }),
    ).toEqual({ cacheMissReason: { type: 'previous_message_not_found' } });
  });
});

describe('AnthropicProvider cache-diagnostics request plumbing', () => {
  let provider: AnthropicProvider;

  beforeEach(async () => {
    provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'test-key' });
  });

  it('attaches payload.diagnostics with the threaded previous_message_id', () => {
    const payload = (provider as any).buildRequestPayload(
      'claude-opus-4-8',
      MESSAGES,
      { cacheDiagnostics: { previousMessageId: 'msg_prev_42' } },
      false,
    );
    expect(payload.diagnostics).toEqual({ previous_message_id: 'msg_prev_42' });
  });

  it('sends previous_message_id: null on the first-turn opt-in', () => {
    const payload = (provider as any).buildRequestPayload(
      'claude-opus-4-8',
      MESSAGES,
      { cacheDiagnostics: { previousMessageId: null } },
      false,
    );
    expect(payload.diagnostics).toEqual({ previous_message_id: null });
  });

  it('omits payload.diagnostics entirely when the option is not set', () => {
    const payload = (provider as any).buildRequestPayload('claude-opus-4-8', MESSAGES, {}, false);
    expect('diagnostics' in payload).toBe(false);
  });

  it('adds the cache-diagnosis beta header exactly when the payload carries diagnostics', () => {
    const withDiag = (provider as any).betaHeaders({ diagnostics: { previous_message_id: null } });
    expect(withDiag['anthropic-beta']).toBe('cache-diagnosis-2026-04-07');

    const without = (provider as any).betaHeaders({});
    expect(without['anthropic-beta']).toBeUndefined();
  });

  it('comma-joins the diagnostics beta with the interleaved-thinking beta', () => {
    const headers = (provider as any).betaHeaders({
      thinking: { type: 'adaptive' },
      diagnostics: { previous_message_id: 'msg_1' },
    });
    expect(headers['anthropic-beta']).toBe(
      'interleaved-thinking-2025-05-14,cache-diagnosis-2026-04-07',
    );
  });
});

describe('AnthropicProvider cache-diagnostics response mapping', () => {
  let provider: AnthropicProvider;

  beforeEach(async () => {
    provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'test-key' });
  });

  it('leaves cacheDiagnostics absent when the API returned no diagnostics field', () => {
    const completion = (provider as any).mapResponseToCompletion(makeApiResponse());
    expect('cacheDiagnostics' in completion).toBe(false);
  });

  it('surfaces null for a compared-no-divergence verdict', () => {
    const completion = (provider as any).mapResponseToCompletion(
      makeApiResponse({ diagnostics: null }),
    );
    expect(completion.cacheDiagnostics).toBeNull();
  });

  it('surfaces the normalized miss reason and keeps the message id for threading', () => {
    const completion = (provider as any).mapResponseToCompletion(
      makeApiResponse({
        diagnostics: {
          cache_miss_reason: { type: 'messages_changed', cache_missed_input_tokens: 1200 },
        },
      }),
    );
    expect(completion.cacheDiagnostics).toEqual({
      cacheMissReason: { type: 'messages_changed', cacheMissedInputTokens: 1200 },
    });
    // The provider message id is the thread key for the NEXT call's
    // previous_message_id — it must survive the mapping.
    expect(completion.id).toBe('msg_test_1');
  });
});
