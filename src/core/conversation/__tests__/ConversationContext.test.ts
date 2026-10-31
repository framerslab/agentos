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
 * results, `summary` is a summary of earlier messages, a name that starts with `q` is the user's and any other name is
 * a reply.
 */
function fields(name: string): Omit<ConversationMessage, 'id' | 'timestamp'> {
  if (name === 'call') return { role: MessageRole.ASSISTANT, content: null, tool_calls: CALLS };
  if (name === 'read' || name === 'write') {
    return { role: MessageRole.TOOL, content: `${name} done`, tool_call_id: `call-${name}`, name: `${name}_file` };
  }
  if (name === 'summary') return { role: MessageRole.SUMMARY, content: 'The user asked about the notes.' };
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

    it.each([undefined, Number.NaN])('with a head setting of %s keeps the first two messages, as the default does', (head) => {
      // A head setting that is not a number keeps the default head of two: a limit of four keeps the first two
      // messages and the newest two, and getHistory() returns them.
      const context = contextWith(['q1', 'r1', 'q2', 'r2', 'q3'], {
        maxHistoryLengthMessages: 4,
        messagesToKeepVerbatimHead: head,
      });

      expect(names(context.getHistory())).toEqual(['q1', 'r1', 'r2', 'q3']);
      context.addMessage(fields('r3'));
      expect(names(context.getAllMessages())).toEqual(['q1', 'r1', 'q3', 'r3']);
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

    it('with no limit keeps a summary that follows the first messages', () => {
      // A summary right after the first two messages stands for the messages it replaced. A limit of six keeps the
      // first two, the summary and the newest three.
      const context = contextWith(['q1', 'r1', 'summary', 'q2', 'r2', 'q3', 'r3', 'q4', 'r4'], {
        maxHistoryLengthMessages: 6,
      });

      expect(names(context.getHistory())).toEqual(['q1', 'r1', 'summary', 'r3', 'q4', 'r4']);
    });

    it('with no limit keeps the last summary after the first messages, where it sorts after the messages it replaced', () => {
      // A conversation loaded from storage holds the messages a summary replaced, and the summary sorts by its own
      // time, after them. A limit of six keeps the first two messages, the summary and the newest three, and so does
      // the trim at the next message.
      const context = contextWith(['q1', 'r1', 'q2', 'r2', 'q3', 'r3', 'summary', 'q4', 'r4', 'q5', 'r5'], {
        maxHistoryLengthMessages: 6,
      });

      expect(names(context.getHistory())).toEqual(['q1', 'r1', 'summary', 'r4', 'q5', 'r5']);
      context.addMessage(fields('q6'));
      expect(names(context.getAllMessages())).toEqual(['q1', 'r1', 'summary', 'q5', 'r5', 'q6']);
    });
  });

  describe('with automatic summarization', () => {
    /**
     * A conversation over the messages named `messageNames` whose summaries `summarize` writes: past ten messages it
     * keeps the first two and the newest two and summarizes four of the messages between them, unless `config` says
     * otherwise.
     */
    function summarizingContext(
      messageNames: string[],
      summarize: IUtilityAI['summarize'],
      config: Partial<ConversationContextConfig> = {},
    ): ConversationContext {
      return contextWith(messageNames, {
        maxHistoryLengthMessages: 10,
        enableAutomaticSummarization: true,
        utilityAI: { summarize } as unknown as IUtilityAI,
        messagesToKeepVerbatimHead: 2,
        messagesToKeepVerbatimTail: 2,
        summarizationChunkSize: 4,
        ...config,
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

    it('keeps the summary when the history is still past its limit with too few messages left for another chunk, and at the next trim', async () => {
      // A history loaded past its limit of ten, summarized eight messages at a time. The chunk reaches into the round,
      // so it is summarized through the round's end, ten messages. Twelve are left, and the seven between the summary
      // and the newest two are too few for another chunk, so the oldest after the summary are dropped instead.
      const summarize = vi.fn(async () => 'The user asked about the notes.');
      const context = summarizingContext(
        ['q1', 'r1', 'q2', 'r2', 'q3', 'r3', 'q4', 'r4', 'q5', 'call', 'read', 'write', 'done', 'q6', 'r6', 'q7', 'r7', 'q8', 'r8', 'q9'],
        summarize,
        { summarizationChunkSize: 8 },
      );

      context.addMessage(fields('r9'));

      await vi.waitFor(() =>
        expect(names(context.getAllMessages())).toEqual(['q1', 'r1', 'summary', 'r6', 'q7', 'r7', 'q8', 'r8', 'q9', 'r9']),
      );
      const summary = context.getAllMessages().find((message) => message.role === MessageRole.SUMMARY);
      expect(summary?.metadata?.summarizedMessageIds).toEqual(
        ['q2', 'r2', 'q3', 'r3', 'q4', 'r4', 'q5', 'call', 'read', 'write'].map((name) => `msg-${name}`),
      );

      // the next message leaves too few for a chunk again: the oldest after the summary go, and the summary stays
      context.addMessage(fields('q10'));

      await vi.waitFor(() =>
        expect(names(context.getAllMessages())).toEqual(['q1', 'r1', 'summary', 'q7', 'r7', 'q8', 'r8', 'q9', 'r9', 'q10']),
      );
      expect(summarize).toHaveBeenCalledTimes(1);
    });

    it('manages the messages recorded after a history is cleared while a summary is made', async () => {
      let finish: (summary: string) => void = () => {};
      const summarize = vi
        .fn(async () => 'The user asked about the weather.')
        .mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
      const context = summarizingContext(['q1', 'r1', 'q2', 'r2', 'q3', 'call', 'read', 'write', 'done', 'q4'], summarize);

      context.addMessage(fields('r4'));
      expect(summarize).toHaveBeenCalledTimes(1);
      context.clearHistory();
      // eleven messages, past the limit of ten, recorded while the cleared history's summary is made
      for (const name of ['q5', 'r5', 'q6', 'r6', 'q7', 'r7', 'q8', 'r8', 'q9', 'r9', 'q10']) {
        context.addMessage(fields(name));
      }
      expect(summarize).toHaveBeenCalledTimes(1);
      finish('The user asked about the notes.');

      await vi.waitFor(() =>
        expect(names(context.getAllMessages())).toEqual(['q5', 'r5', 'summary', 'q8', 'r8', 'q9', 'r9', 'q10']),
      );
      const summary = context.getAllMessages().find((message) => message.role === MessageRole.SUMMARY);
      expect(summary?.content).toBe('The user asked about the weather.');
    });

    it('summarizes the whole part of a chunk size that is not a whole number', async () => {
      const summarize = vi.fn(async () => 'The user asked about the notes.');
      const context = summarizingContext(['q1', 'r1', 'q2', 'r2', 'q3', 'r3', 'q4', 'r4', 'q5', 'r5'], summarize, {
        summarizationChunkSize: 4.5,
      });

      context.addMessage(fields('q6'));

      await vi.waitFor(() =>
        expect(names(context.getAllMessages())).toEqual(['q1', 'r1', 'summary', 'q4', 'r4', 'q5', 'r5', 'q6']),
      );
      const summary = context.getAllMessages().find((message) => message.role === MessageRole.SUMMARY);
      expect(summary?.metadata?.summarizedMessageIds).toEqual(['q2', 'r2', 'q3', 'r3'].map((name) => `msg-${name}`));
    });
  });
});
