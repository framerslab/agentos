/**
 * Unit tests for AgentSessionVoiceAdapter.
 *
 * Verifies that the adapter correctly wraps AgentSession.stream()
 * into the IVoicePipelineAgentSession interface.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentSessionVoiceAdapter } from '../providers/AgentSessionVoiceAdapter.js';
import type { VoiceTurnMetadata } from '../types.js';

/** Create a minimal mock AgentSession. */
function createMockAgentSession() {
  return {
    id: 'test-session',
    stream: vi.fn(),
    send: vi.fn(),
    messages: vi.fn(() => []),
    usage: vi.fn(),
    clear: vi.fn(),
  };
}

/** Create a mock StreamTextResult with an async iterable textStream. */
function createMockStreamResult(tokens: string[]) {
  return {
    textStream: (async function* () {
      for (const t of tokens) yield t;
    })(),
    fullStream: (async function* () {})(),
    text: Promise.resolve(tokens.join('')),
    usage: Promise.resolve({ promptTokens: 0, completionTokens: 0 }),
    toolCalls: Promise.resolve([]),
  };
}

const mockMetadata: VoiceTurnMetadata = {
  speakers: ['user'],
  endpointReason: 'punctuation',
  speechDurationMs: 2500,
  wasInterrupted: false,
  transcriptConfidence: 0.95,
};

describe('AgentSessionVoiceAdapter', () => {
  it('should yield tokens from AgentSession.stream().textStream', async () => {
    const mockSession = createMockAgentSession();
    mockSession.stream.mockReturnValue(createMockStreamResult(['Hello', ' ', 'world']));

    const adapter = new AgentSessionVoiceAdapter(mockSession as any);
    const tokens: string[] = [];

    for await (const token of adapter.sendText('Hi there', mockMetadata)) {
      tokens.push(token);
    }

    expect(tokens).toEqual(['Hello', ' ', 'world']);
    expect(mockSession.stream).toHaveBeenCalledWith('Hi there', { abortSignal: expect.any(AbortSignal) });
  });

  it('should stop yielding tokens after abort() is called', async () => {
    const mockSession = createMockAgentSession();
    // Create a slow stream that yields tokens with delays
    const slowStream = {
      textStream: (async function* () {
        yield 'First';
        yield 'Second';
        yield 'Third';
        yield 'Fourth';
      })(),
      fullStream: (async function* () {})(),
      text: Promise.resolve('First Second Third Fourth'),
      usage: Promise.resolve({ promptTokens: 0, completionTokens: 0 }),
      toolCalls: Promise.resolve([]),
    };
    mockSession.stream.mockReturnValue(slowStream);

    const adapter = new AgentSessionVoiceAdapter(mockSession as any);
    const tokens: string[] = [];

    for await (const token of adapter.sendText('Hi', mockMetadata)) {
      tokens.push(token);
      if (tokens.length === 2) {
        adapter.abort();
      }
    }

    // Should have stopped after abort (may get 2 or 3 depending on timing)
    expect(tokens.length).toBeLessThanOrEqual(3);
    expect(tokens[0]).toBe('First');
    expect(tokens[1]).toBe('Second');
  });

  it('should implement abort() method', () => {
    const mockSession = createMockAgentSession();
    const adapter = new AgentSessionVoiceAdapter(mockSession as any);
    expect(typeof adapter.abort).toBe('function');
    // Should not throw
    adapter.abort();
  });
});
