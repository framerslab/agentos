import { describe, expect, it } from 'vitest';

import { MessageRole, type ConversationMessage } from '../ConversationMessage';
import { maybeCompactConversationMessages, type RollingSummaryCompactionConfig } from '../RollingSummaryCompactor';

const CONFIG: RollingSummaryCompactionConfig = {
  enabled: true,
  modelId: 'summary-model',
  cooldownMs: 0,
  headMessagesToKeep: 2,
  tailMessagesToKeep: 2,
  minMessagesToSummarize: 1,
  maxMessagesToSummarizePerPass: 48,
  maxOutputTokens: 300,
};

/** A user message whose text is its id, recorded at `timestamp`, with `fields` over it. */
function message(id: string, timestamp: number, fields: Partial<ConversationMessage> = {}): ConversationMessage {
  return { id, timestamp, role: MessageRole.USER, content: id, ...fields };
}

/** An assistant message that calls read_file once for each of `callIds`. */
function call(id: string, timestamp: number, callIds: string[]): ConversationMessage {
  return message(id, timestamp, {
    role: MessageRole.ASSISTANT,
    content: null,
    tool_calls: callIds.map((callId) => ({ id: callId, name: 'read_file', arguments: { path: `${callId}.txt` } })),
  });
}

/** The tool message that answers the call `callId`. */
function answer(id: string, timestamp: number, callId: string): ConversationMessage {
  return message(id, timestamp, { role: MessageRole.TOOL, tool_call_id: callId, name: 'read_file' });
}

/** Runs one compaction pass over `messages` and returns the ids of the messages it summarized and the boundary it stored. */
async function compact(messages: ConversationMessage[], config: Partial<RollingSummaryCompactionConfig>) {
  const summarized: string[][] = [];
  const result = await maybeCompactConversationMessages({
    messages,
    sessionMetadata: {},
    config: { ...CONFIG, ...config },
    now: 1_000,
    llmCaller: async ({ messages: prompt }) => {
      const text = String(prompt[prompt.length - 1]?.content ?? '');
      const input = JSON.parse(text.slice(text.indexOf('INPUT_JSON:') + 'INPUT_JSON:'.length));
      summarized.push(input.new_turns.map((turn: { id: string }) => turn.id));
      return JSON.stringify({ summary_markdown: '- The user reads notes.', memory_json: { facts: [] } });
    },
  });
  return { summarized, boundary: result.summaryUptoTimestamp };
}

describe('maybeCompactConversationMessages', () => {
  it('ends the summary before a message that shares the millisecond of the last message it would take', async () => {
    // The next turn keeps the messages newer than the boundary. A boundary at q3's millisecond would hide the call
    // recorded in that millisecond and keep its result, which would then answer no call.
    const messages = [
      message('q1', 1),
      message('r1', 2, { role: MessageRole.ASSISTANT }),
      message('q2', 3),
      message('r2', 4, { role: MessageRole.ASSISTANT }),
      message('q3', 5),
      call('call', 5, ['c1']),
      answer('read', 6, 'c1'),
      message('done', 7, { role: MessageRole.ASSISTANT }),
      message('q4', 8),
    ];

    const { summarized, boundary } = await compact(messages, { headMessagesToKeep: 2, tailMessagesToKeep: 4 });

    expect(summarized).toEqual([['q2', 'r2']]);
    expect(boundary).toBe(4);
  });

  it('summarizes a tool round past the limit for one pass when the limit cuts into it and leaving it out leaves too little', async () => {
    // The limit of two would end the summary after the first result. Ending it before the round leaves nothing, so the
    // round goes into the summary whole, and the next pass starts after it instead of at the same round again.
    const messages = [
      message('q1', 1),
      message('r1', 2, { role: MessageRole.ASSISTANT }),
      call('call', 3, ['c1', 'c2', 'c3']),
      answer('a1', 4, 'c1'),
      answer('a2', 5, 'c2'),
      answer('a3', 6, 'c3'),
      message('done', 7, { role: MessageRole.ASSISTANT }),
      message('q2', 8),
      message('r2', 9, { role: MessageRole.ASSISTANT }),
      message('q3', 10),
    ];

    const { summarized, boundary } = await compact(messages, {
      headMessagesToKeep: 2,
      tailMessagesToKeep: 2,
      maxMessagesToSummarizePerPass: 2,
      minMessagesToSummarize: 2,
    });

    expect(summarized).toEqual([['call', 'a1', 'a2', 'a3']]);
    expect(boundary).toBe(6);
  });
});
