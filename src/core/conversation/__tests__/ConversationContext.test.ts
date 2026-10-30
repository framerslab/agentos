import { describe, expect, it, vi } from 'vitest';

import type { IUtilityAI } from '../../../cognition/nlp/ai_utilities/IUtilityAI';
import { ConversationContext, type ConversationContextConfig } from '../ConversationContext';
import { MessageRole, type ConversationMessage } from '../ConversationMessage';

/** The calls of the conversations' tool round: read a file, then write a summary of it back. */
const CALLS = [
  { id: 'call-read', name: 'read_file', arguments: { path: 'notes.txt' } },
  { id: 'call-write', name: 'write_file', arguments: { path: 'summary.txt' } },
];

/**
 * The message named `name`: `call` is an assistant message that names both calls, `read` and `write` are their
 * results, a name that starts with `q` is the user's and any other name is a reply.
 */
function fields(name: string): Omit<ConversationMessage, 'id' | 'timestamp'> {
  if (name === 'call') return { role: MessageRole.ASSISTANT, content: null, tool_calls: CALLS };
  if (name === 'read' || name === 'write') {
    return { role: MessageRole.TOOL, content: `${name} done`, tool_call_id: `call-${name}`, name: `${name}_file` };
  }
  return { role: name.startsWith('q') ? MessageRole.USER : MessageRole.ASSISTANT, content: name };
}

/** A conversation that holds the messages named `names`, as one loaded from storage holds them, with `config`. */
function contextWith(names: string[], config: Partial<ConversationContextConfig> = {}): ConversationContext {
  return new ConversationContext(
    'conv-history-cuts',
    config,
    names.map((name, index) => ({ id: `msg-${name}`, timestamp: 1_000 + index, ...fields(name) })),
  );
}

/** The names of `messages`, as `fields()` gives them, and `summary` for a summary. */
function names(messages: ReadonlyArray<Readonly<ConversationMessage>>): string[] {
  return messages.map((message) => {
    if (message.role === MessageRole.SUMMARY) return 'summary';
    if (message.tool_calls?.length) return 'call';
    if (message.role === MessageRole.TOOL) return message.tool_call_id === 'call-read' ? 'read' : 'write';
    return String(message.content);
  });
}

describe('ConversationContext history cuts', () => {
  describe('a trim past maxHistoryLengthMessages', () => {
    it('keeps a tool round whole when the newest messages it keeps start at a result, past the limit, and leaves the round out whole later', () => {
      // A limit of six keeps the first two messages and the newest four. When q2 is recorded the newest four start at
      // `read`: a cut there drops the call and keeps both of its results.
      const context = contextWith(['q1', 'r1', 'call', 'read', 'write', 'done'], { maxHistoryLengthMessages: 6 });

      context.addMessage(fields('q2'));
      expect(names(context.getAllMessages())).toEqual(['q1', 'r1', 'call', 'read', 'write', 'done', 'q2']);
      context.addMessage(fields('r2'));
      expect(names(context.getAllMessages())).toEqual(['q1', 'r1', 'call', 'read', 'write', 'done', 'q2', 'r2']);

      // once the newest four start after the round, the round is left out whole
      context.addMessage(fields('q3'));
      expect(names(context.getAllMessages())).toEqual(['q1', 'r1', 'done', 'q2', 'r2', 'q3']);
    });

    it('keeps the results of a call the kept head ends on in the head', () => {
      // The first turn stopped for the host's tools, so the first two messages are its question and its call. A limit
      // of four keeps them and the newest two.
      const context = contextWith(['q1', 'call', 'read', 'write'], { maxHistoryLengthMessages: 4 });

      context.addMessage(fields('done'));
      context.addMessage(fields('q2'));
      context.addMessage(fields('r2'));

      expect(names(context.getAllMessages())).toEqual(['q1', 'call', 'read', 'write', 'q2', 'r2']);
    });
  });

  describe('getHistory', () => {
    it('with a limit that ends inside a tool round returns the round whole', () => {
      const context = contextWith(['q1', 'r1', 'q2', 'call', 'read', 'write', 'done']);

      // the newest three start right after the call, the newest two between its results
      expect(names(context.getHistory(3))).toEqual(['call', 'read', 'write', 'done']);
      expect(names(context.getHistory(2))).toEqual(['call', 'read', 'write', 'done']);
      // a limit that ends outside every round returns that many messages
      expect(names(context.getHistory(1))).toEqual(['done']);
    });

    it('with no limit returns the first messages and the newest that a trim keeps, with a round they reach into whole', () => {
      // A conversation loaded from storage holds every message it recorded, past its limit, until its next message
      // trims it. A limit of four with one message at the head keeps the first message and the newest three, which
      // start at `write`; the newest four would start at `read`, after the call it answers.
      const context = contextWith(['q1', 'r1', 'call', 'read', 'write', 'done', 'q2'], {
        maxHistoryLengthMessages: 4,
        messagesToKeepVerbatimHead: 1,
      });

      expect(names(context.getHistory())).toEqual(['q1', 'call', 'read', 'write', 'done', 'q2']);
    });
  });

  describe('with automatic summarization', () => {
    /**
     * A conversation over the messages named `messageNames` whose summaries `summarize` writes: past ten messages it
     * keeps the first two and the newest two and summarizes four of the messages between them.
     */
    function summarizingContext(messageNames: string[], summarize: IUtilityAI['summarize']): ConversationContext {
      return contextWith(messageNames, {
        maxHistoryLengthMessages: 10,
        enableAutomaticSummarization: true,
        utilityAI: { summarize } as unknown as IUtilityAI,
        messagesToKeepVerbatimHead: 2,
        messagesToKeepVerbatimTail: 2,
        summarizationChunkSize: 4,
      });
    }

    it.each([
      {
        label: 'summarizes a tool round its chunk reaches into whole',
        messages: ['q1', 'r1', 'q2', 'r2', 'q3', 'call', 'read', 'write', 'done', 'q4'],
        history: ['q1', 'r1', 'summary', 'done', 'q4', 'r4'],
        summarized: ['q2', 'r2', 'q3', 'call', 'read', 'write'],
      },
      {
        label: 'keeps the results of a call the kept head ends on in the head',
        messages: ['q1', 'call', 'read', 'write', 'done', 'q2', 'r2', 'q3', 'r3', 'q4'],
        history: ['q1', 'call', 'read', 'write', 'summary', 'r3', 'q4', 'r4'],
        summarized: ['done', 'q2', 'r2', 'q3'],
      },
    ])('$label', async ({ messages, history, summarized }) => {
      const summarize = vi.fn(async () => 'The user asked about the notes.');
      const context = summarizingContext(messages, summarize);

      context.addMessage(fields('r4'));

      await vi.waitFor(() => expect(names(context.getAllMessages())).toEqual(history));
      const summary = context.getAllMessages().find((message) => message.role === MessageRole.SUMMARY);
      expect(summary?.metadata?.summarizedMessageIds).toEqual(summarized.map((name) => `msg-${name}`));
    });

    it('keeps a message recorded while the summary is made, after the summary', async () => {
      let finish: (summary: string) => void = () => {};
      const summarize = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
      const context = summarizingContext(['q1', 'r1', 'q2', 'r2', 'q3', 'call', 'read', 'write', 'done', 'q4'], summarize);

      context.addMessage(fields('r4'));
      expect(summarize).toHaveBeenCalledTimes(1);
      context.addMessage(fields('q5'));
      finish('The user asked about the notes.');

      await vi.waitFor(() =>
        expect(names(context.getAllMessages())).toEqual(['q1', 'r1', 'summary', 'done', 'q4', 'r4', 'q5']),
      );
    });

    it('leaves a history cleared while the summary is made cleared', async () => {
      let finish: (summary: string) => void = () => {};
      const summarize = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
      const context = summarizingContext(['q1', 'r1', 'q2', 'r2', 'q3', 'call', 'read', 'write', 'done', 'q4'], summarize);

      context.addMessage(fields('r4'));
      expect(summarize).toHaveBeenCalledTimes(1);
      context.clearHistory();
      finish('The user asked about the notes.');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(names(context.getAllMessages())).toEqual([]);
    });
  });
});
