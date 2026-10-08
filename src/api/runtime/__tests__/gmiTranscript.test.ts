/**
 * Conversions between the session store's transcript and a GMI's history:
 * the store's messages become the history a GMI turn starts from, and each
 * finished model step becomes the store messages it adds.
 */
import { describe, expect, it } from 'vitest';
import { transcriptToConversation, stepToTranscript } from '../gmiTranscript.js';
import { MessageRole } from '../../../core/conversation/ConversationMessage';
import { ConversationHistoryManager } from '../../../cognition/substrate/ConversationHistoryManager';
import type { StepFinishedChunkPayload } from '../../../cognition/substrate/IGMI';

const toolStep: StepFinishedChunkPayload = { stepIndex: 0, text: '', finishReason: 'tool_calls', providerId: 'openai', modelId: 'gpt-4o', hop: 0 };

describe('transcriptToConversation', () => {
  it('turns store messages into GMI history: roles, tool calls with parsed arguments and signatures, tool ids, thinking blocks', () => {
    const conv = transcriptToConversation([
      { role: 'user', content: 'Look it up.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' }, thoughtSignature: 'sig' }],
        thinkingBlocks: [{ type: 'thinking', thinking: 'p', signature: 's' }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
      { role: 'assistant', content: 'Found it.', partial: true },
    ]);
    expect(conv.map((m) => m.role)).toEqual([MessageRole.USER, MessageRole.ASSISTANT, MessageRole.TOOL, MessageRole.ASSISTANT]);
    expect(conv[1].tool_calls).toEqual([{ id: 'c1', name: 'lookup', arguments: { q: 'a' }, thoughtSignature: 'sig' }]);
    expect(conv[1].thinkingBlocks).toEqual([{ type: 'thinking', thinking: 'p', signature: 's' }]);
    expect(conv[2].tool_call_id).toBe('c1');
    expect(conv[3]).not.toHaveProperty('partial');
  });

  it('a caller-built signed thinking entry becomes a thinking block; unsigned thinking is dropped', () => {
    const [signed, unsigned] = transcriptToConversation([
      { role: 'assistant', content: 'a', thinking: { text: 'why', signature: 'sig-1' } },
      { role: 'assistant', content: 'b', thinking: { text: 'unsigned' } },
    ]);
    expect(signed.thinkingBlocks).toEqual([{ type: 'thinking', thinking: 'why', signature: 'sig-1' }]);
    expect(unsigned).not.toHaveProperty('thinkingBlocks');
  });

  it('the GMI history it hydrates carries each call with its arguments, its result and multimodal user content', () => {
    const parts = [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }];
    const manager = new ConversationHistoryManager();
    manager.hydrate(transcriptToConversation([
      { role: 'user', content: parts },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'A' },
      { role: 'assistant', content: 'It is A.' },
    ]));
    const history = manager.history;
    expect(history[0]).toMatchObject({ role: 'user', content: parts });
    expect(history[1].tool_calls).toEqual([{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } }]);
    expect(history[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'A' });
    expect(history[3]).toMatchObject({ role: 'assistant', content: 'It is A.' });
  });
});

describe('stepToTranscript', () => {
  it('builds a step block: user message on step 0, the assistant message, then its tool results', () => {
    const block = stepToTranscript({
      step: { ...toolStep, text: 'Let me check.' },
      calls: [{ id: 'c1', name: 'lookup', arguments: { q: 'a' } }],
      results: [{ toolCallId: 'c1', name: 'lookup', result: { ok: true }, isError: false }],
      userMessage: { role: 'user', content: 'Look it up.' },
    });
    expect(block).toEqual([
      { role: 'user', content: 'Look it up.' },
      { role: 'assistant', content: 'Let me check.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    ]);
  });

  it('records a schema answer as its JSON string and leaves out an empty reply', () => {
    expect(stepToTranscript({ step: { stepIndex: 0, text: 'Here you go.', finishReason: 'tool_use', providerId: 'anthropic', modelId: 'm', hop: 0, structuredOutput: { city: 'Lyon' } }, calls: [], results: [] }))
      .toEqual([{ role: 'assistant', content: '{"city":"Lyon"}' }]);
    expect(stepToTranscript({ step: { stepIndex: 0, text: '', finishReason: 'stop', providerId: 'openai', modelId: 'm', hop: 0 }, calls: [], results: [], userMessage: { role: 'user', content: 'Hi.' } }))
      .toEqual([{ role: 'user', content: 'Hi.' }]);
  });

  it("stores the hook's replacement text, the step's thinking blocks and each call's thought signature", () => {
    const thinking = [{ type: 'thinking' as const, thinking: 'plan', signature: 'sig' }];
    const [assistant] = stepToTranscript({
      step: { ...toolStep, text: 'raw', thinkingBlocks: thinking },
      calls: [{ id: 'c1', name: 'lookup', arguments: {}, thoughtSignature: 'ts-1' }],
      results: [{ toolCallId: 'c1', name: 'lookup', result: 'A', isError: false }],
      textOverride: 'clean',
    });
    expect(assistant).toEqual({
      role: 'assistant',
      content: 'clean',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' }, thoughtSignature: 'ts-1' }],
      thinkingBlocks: thinking,
    });
  });

  it('stores each tool result exactly as the GMI put it in its own history, failures included', () => {
    const gmiHistory = new ConversationHistoryManager();
    const cases = [
      { result: { ok: true }, isError: false },
      { result: 'plain text', isError: false },
      { result: null, isError: true, errorDetails: { message: 'boom' } },
      { result: { partial: 1 }, isError: true },
    ];
    for (const r of cases) {
      const sent = gmiHistory.updateWithToolResult({ toolCallId: 'c1', toolName: 'lookup', output: r.result, isError: r.isError, errorDetails: r.errorDetails });
      const stored = stepToTranscript({
        step: toolStep,
        calls: [{ id: 'c1', name: 'lookup', arguments: {} }],
        results: [{ toolCallId: 'c1', name: 'lookup', result: r.result, isError: r.isError, ...(r.errorDetails ? { errorDetails: r.errorDetails } : {}) }],
      }).at(-1);
      expect(stored).toEqual({ role: 'tool', tool_call_id: 'c1', content: sent.content });
    }
  });
});
