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

/**
 * Runs one compaction pass over `messages`, after an earlier pass that left its boundary at `previousBoundary` when
 * one is given, and returns the ids of the messages it summarized and the boundary it stored.
 */
async function compact(
  messages: ConversationMessage[],
  config: Partial<RollingSummaryCompactionConfig>,
  previousBoundary?: number,
) {
  const summarized: string[][] = [];
  const result = await maybeCompactConversationMessages({
    messages,
    sessionMetadata:
      previousBoundary === undefined
        ? {}
        : {
            rollingSummaryState: {
              updatedAt: 500,
              summaryText: '- The user keeps notes.',
              summaryJson: null,
              summaryUptoTimestamp: previousBoundary,
            },
          },
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

  it('ends the summary on a message whose millisecond only an error shares, since the next turn never sends an error', async () => {
    // The error shares r2's millisecond. The next turn's history leaves errors out, so a boundary at r2 hides nothing
    // it would send; ending before r2 instead would leave less than the minimum and no summary at all.
    const messages = [
      message('q1', 1),
      message('r1', 2, { role: MessageRole.ASSISTANT }),
      message('q2', 3),
      message('r2', 4, { role: MessageRole.ASSISTANT }),
      message('failed', 4, { role: MessageRole.ERROR }),
      message('q3', 5),
      message('r3', 6, { role: MessageRole.ASSISTANT }),
    ];

    const { summarized, boundary } = await compact(messages, {
      headMessagesToKeep: 2,
      tailMessagesToKeep: 2,
      minMessagesToSummarize: 2,
    });

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

  it('starts a later pass at the boundary of the earlier one, since the next turn keeps the head of the conversation', async () => {
    // An earlier pass summarized s1 and s2. The next turn sends h1, h2 and the messages after the boundary, so a pass
    // that kept back the first messages after the boundary as its head would leave the round out of the summary and
    // out of the history.
    const messages = [
      message('h1', 1),
      message('h2', 2, { role: MessageRole.ASSISTANT }),
      message('s1', 3),
      message('s2', 4, { role: MessageRole.ASSISTANT }),
      call('call', 5, ['c1', 'c2']),
      answer('result1', 6, 'c1'),
      answer('result2', 7, 'c2'),
      message('done', 8, { role: MessageRole.ASSISTANT }),
      message('tail1', 9),
      message('tail2', 10, { role: MessageRole.ASSISTANT }),
    ];

    const { summarized, boundary } = await compact(messages, { headMessagesToKeep: 2, tailMessagesToKeep: 2 }, 4);

    expect(summarized).toEqual([['call', 'result1', 'result2', 'done']]);
    expect(boundary).toBe(8);
  });

  it('counts the kept head as the next turn does, a message no pass summarizes among it', async () => {
    // The next turn keeps the first two messages of the history it sends: the summary message and q1. A head counted
    // over the messages a pass may summarize would keep back r1 too, which would then reach neither the summary nor
    // the history.
    const messages = [
      message('earlier', 1, { role: MessageRole.SUMMARY }),
      message('q1', 2),
      message('r1', 3, { role: MessageRole.ASSISTANT }),
      message('q2', 4),
      message('r2', 5, { role: MessageRole.ASSISTANT }),
      message('q3', 6),
      message('r3', 7, { role: MessageRole.ASSISTANT }),
    ];

    const { summarized, boundary } = await compact(messages, { headMessagesToKeep: 2, tailMessagesToKeep: 2 });

    expect(summarized).toEqual([['r1', 'q2', 'r2']]);
    expect(boundary).toBe(5);
  });
});
