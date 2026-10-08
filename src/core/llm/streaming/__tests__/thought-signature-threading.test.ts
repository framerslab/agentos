/**
 * @fileoverview A Gemini 3 tool call carries a `thoughtSignature` that the next
 * turn must send back; without one Gemini 3 rejects the request with HTTP 400.
 * GeminiProvider falls back to Google's placeholder when a signature is
 * missing, so a dropped signature fails no request but loses thought
 * continuity. These tests pin that the paths which rebuild tool calls keep it:
 * the stream reconstructor, the stream batcher, and the conversation history
 * round trip.
 */
import { describe, expect, it } from 'vitest';
import { StreamingReconstructor, reconstructStream } from '../StreamingReconstructor';
import { batchStream } from '../StreamingBatcher';
import { ConversationHistoryManager } from '../../../../cognition/substrate/ConversationHistoryManager';
import { PromptEngine } from '../../PromptEngine';
import { SessionHistoryBuffer } from '../../../../api/sessionHistory';
import type { SessionTranscriptMessage } from '../../../../api/sessionTranscript';
import type { ConversationToolCallRequest } from '../../../conversation/ConversationMessage';
import type { ChatMessage, ModelCompletionResponse } from '../../providers/IProvider';

function toolDeltaChunk(isFinal = false): ModelCompletionResponse {
  return {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 1,
    modelId: 'gemini-3.8-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: null }, finishReason: isFinal ? 'tool_calls' : null }],
    toolCallsDeltas: [{
      index: 0,
      id: 'call_gemini_1',
      type: 'function',
      function: { name: 'get_weather', arguments_delta: '{"city":"Paris"}' },
      thoughtSignature: 'sig-abc',
    }],
    isFinal,
  } as ModelCompletionResponse;
}

async function* oneToolCall(): AsyncGenerator<ModelCompletionResponse, void, undefined> {
  yield toolDeltaChunk(true);
}

/** GeminiProvider's stream shape: the tool-call delta, then a separate final chunk. */
async function* deltaThenFinal(): AsyncGenerator<ModelCompletionResponse, void, undefined> {
  yield toolDeltaChunk(false);
  yield {
    id: 'chunk-2',
    object: 'chat.completion.chunk',
    created: 1,
    modelId: 'gemini-3.8-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: null }, finishReason: 'tool_calls' }],
    isFinal: true,
  } as ModelCompletionResponse;
}

describe('thoughtSignature threading', () => {
  it('reconstructStream keeps the signature on the rebuilt tool call', async () => {
    const result = await reconstructStream(oneToolCall());
    expect(result.toolCalls[0]).toMatchObject({ id: 'call_gemini_1', name: 'get_weather', thoughtSignature: 'sig-abc' });
  });

  it('the incremental StreamingReconstructor keeps the signature on getToolCalls()', () => {
    // streamText falls back to this reconstructor when a final chunk carries
    // no tool_calls.
    const reconstructor = new StreamingReconstructor();
    reconstructor.push(toolDeltaChunk(true));
    expect(reconstructor.getToolCalls()[0]).toMatchObject({ id: 'call_gemini_1', thoughtSignature: 'sig-abc' });
  });

  it('PromptEngine keeps the signature when it rebuilds history tool calls', () => {
    const engine = new PromptEngine();
    const normalize = (engine as unknown as Record<string, (c: ConversationToolCallRequest[]) => unknown>)
      .normalizeToolCalls.bind(engine);
    const rebuilt = normalize([
      { id: 'call_gemini_1', name: 'get_weather', arguments: { city: 'Paris' }, thoughtSignature: 'sig-abc' },
    ]) as Array<{ thoughtSignature?: string }>;
    expect(rebuilt[0].thoughtSignature).toBe('sig-abc');
  });

  it('batchStream keeps the signature on the merged tool-call delta', async () => {
    // The delta arrives in a non-final chunk, so it is buffered and merged
    // into a batch before the final chunk is passed through.
    const out: ModelCompletionResponse[] = [];
    for await (const chunk of batchStream(deltaThenFinal(), { maxLatencyMs: 60_000 })) out.push(chunk);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('chunk-1-batch-0');
    expect(out[0].toolCallsDeltas?.[0]).toMatchObject({ id: 'call_gemini_1', thoughtSignature: 'sig-abc' });
    expect(out[1].isFinal).toBe(true);
  });

  it('ConversationHistoryManager keeps the signature through its history format and back', () => {
    const manager = new ConversationHistoryManager();
    const assistant: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_gemini_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        thoughtSignature: 'sig-abc',
      }],
    };
    const stored = manager.convertToConversationMessage(assistant);
    expect(stored.tool_calls?.[0].thoughtSignature).toBe('sig-abc');
    const restored = manager.convertToChatMessage(stored);
    expect(restored?.tool_calls?.[0].thoughtSignature).toBe('sig-abc');
  });

  it('a session checkpoint keeps the signature through reseed and messages()', () => {
    const buffer = new SessionHistoryBuffer({ maxTokens: 100_000, evictChunkRatio: 0.25, minKeepSends: 8 });
    const checkpoint: SessionTranscriptMessage[] = [
      { role: 'user', content: 'Weather in Paris?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_gemini_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          thoughtSignature: 'sig-abc',
        }],
      },
      { role: 'tool', tool_call_id: 'call_gemini_1', content: '{"temp_c":18}' },
    ];
    buffer.reseed(checkpoint);
    const assistant = buffer.messages().find(
      (m): m is Extract<SessionTranscriptMessage, { role: 'assistant' }> => m.role === 'assistant',
    );
    expect(assistant?.tool_calls?.[0].thoughtSignature).toBe('sig-abc');
  });

  it('adds no signature field to calls that never had one', async () => {
    async function* unsigned(): AsyncGenerator<ModelCompletionResponse, void, undefined> {
      const chunk = toolDeltaChunk(true);
      delete chunk.toolCallsDeltas![0].thoughtSignature;
      yield chunk;
    }
    const result = await reconstructStream(unsigned());
    expect(result.toolCalls[0]).not.toHaveProperty('thoughtSignature');
  });
});
