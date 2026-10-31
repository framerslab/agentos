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
 * results, `summary` is a summary of earlier messages, `thought` is a thought, a name that starts with `q` is the
 * user's and any other name is a reply.
 */
function fields(name: string): Omit<ConversationMessage, 'id' | 'timestamp'> {
  if (name === 'call') return { role: MessageRole.ASSISTANT, content: null, tool_calls: CALLS };
  if (name === 'thought') return { role: MessageRole.THOUGHT, content: 'thought' };
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

    it.each([undefined, Number.NaN, null, ''])('with a head setting of %s keeps the first two messages, as the default does', (head) => {
      // A head setting that is not a number keeps the default head of two: a limit of four keeps the first two
      // messages and the newest two, and getHistory() returns them.
      const context = contextWith(['q1', 'r1', 'q2', 'r2', 'q3'], {
        maxHistoryLengthMessages: 4,
        messagesToKeepVerbatimHead: head as number | undefined,
      });

      expect(names(context.getHistory())).toEqual(['q1', 'r1', 'r2', 'q3']);
      context.addMessage(fields('r3'));
      expect(names(context.getAllMessages())).toEqual(['q1', 'r1', 'q3', 'r3']);
    });

    it('with a limit of null keeps the default of a hundred messages', () => {
      // A setting left null, as a config file leaves one it does not set, keeps its default: a limit of none would let
      // the history grow without end.
      const loaded = Array.from({ length: 100 }, (_, index) => (index % 2 === 0 ? `q${index}` : `r${index}`));
      const context = contextWith(loaded, { maxHistoryLengthMessages: null as unknown as number });

      context.addMessage(fields('q100'));

      expect(context.getAllMessages()).toHaveLength(100);
      expect(names(context.getAllMessages()).slice(0, 3)).toEqual(['q0', 'r1', 'r3']);
    });

    it.each([0, -3])('with a limit of %s keeps every message, as getHistory() returns them', (limit) => {
      const context = contextWith(['q1', 'r1', 'q2', 'r2'], { maxHistoryLengthMessages: limit });

      context.addMessage(fields('q3'));

      expect(names(context.getAllMessages())).toEqual(['q1', 'r1', 'q2', 'r2', 'q3']);
      expect(names(context.getHistory())).toEqual(['q1', 'r1', 'q2', 'r2', 'q3']);
    });
  });

  describe('getHistory', () => {
    it('with roles left out that hold a call or its results leaves out the rest of the round', () => {
      // A limit of four keeps the first two messages and the newest two. Leaving out the tool messages leaves out the
      // call's results, so the call is left out with them, and leaving out the assistant's messages leaves out the
      // call, so its results are left out with it: a provider refuses a call without its results and a result without
      // its call. A thought left out of a round leaves its call and results together.
      const context = contextWith(['q1', 'call', 'read', 'write', 'q2', 'q3', 'q4', 'q5'], { maxHistoryLengthMessages: 4 });

      expect(names(context.getHistory(undefined, [MessageRole.TOOL]))).toEqual(['q1', 'q2', 'q4', 'q5']);
      expect(names(context.getHistory(undefined, [MessageRole.ASSISTANT]))).toEqual(['q1', 'q2', 'q4', 'q5']);
      expect(names(context.getHistory(5, [MessageRole.TOOL]))).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);

      const thinking = contextWith(['q1', 'r1', 'call', 'thought', 'read', 'write', 'done']);
      expect(names(thinking.getHistory(undefined, [MessageRole.THOUGHT]))).toEqual(['q1', 'r1', 'call', 'read', 'write', 'done']);
    });

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

    it('runs the passes of the messages recorded while a summary is made once it ends', async () => {
      // A history loaded past its limit of ten, summarized four messages at a time. Three messages are recorded while
      // the first summary is made, and their passes find it holding the lock. They run once it ends, each summarizing
      // the next four messages, until the history is within its limit.
      let finish: (summary: string) => void = () => {};
      const summarize = vi
        .fn(async () => 'The user asked about the weather.')
        .mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
      const context = summarizingContext(
        ['q1', 'r1', 'q2', 'r2', 'q3', 'r3', 'q4', 'r4', 'q5', 'r5', 'q6', 'r6', 'q7', 'r7'],
        summarize,
      );

      context.addMessage(fields('q8'));
      expect(summarize).toHaveBeenCalledTimes(1);
      for (const name of ['r8', 'q9', 'r9']) context.addMessage(fields(name));
      finish('The user asked about the notes.');

      await vi.waitFor(() =>
        expect(names(context.getAllMessages())).toEqual(['q1', 'r1', 'summary', 'q7', 'r7', 'q8', 'r8', 'q9', 'r9']),
      );
      expect(summarize).toHaveBeenCalledTimes(3);
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

    it('leaves a call that waits for its results out of a summary that keeps no newest messages', async () => {
      // A limit of six that keeps no first and no newest messages, summarized seven at a time. The call passes the
      // limit with its results still to come, and a summary of it would leave them without it, so the call stays out of
      // the summary until both results are recorded. The summary then takes the round whole.
      let finish: (summary: string) => void = () => {};
      const summarize = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
      const context = summarizingContext(['q1', 'r1', 'q2', 'r2', 'q3', 'r3'], summarize, {
        maxHistoryLengthMessages: 6,
        messagesToKeepVerbatimHead: 0,
        messagesToKeepVerbatimTail: 0,
        summarizationChunkSize: 7,
      });

      const round = ['call', 'read', 'write'].map((name) => context.addMessage(fields(name)));
      finish('The user asked about the notes.');

      await vi.waitFor(() => expect(names(context.getAllMessages())).toEqual(['summary']));
      const summary = context.getAllMessages().find((message) => message.role === MessageRole.SUMMARY);
      expect(summary?.metadata?.summarizedMessageIds).toEqual([
        ...['q2', 'r2', 'q3', 'r3'].map((name) => `msg-${name}`),
        ...round.map((message) => message.id),
      ]);
      expect(summarize).toHaveBeenCalledTimes(1);
    });

    it('drops a summary when a result for a call in its chunk is recorded while it is made', async () => {
      // Other messages were recorded between the call's two results, so the call and its first result are in the chunk
      // of the summary the fifth question starts, and the second result is recorded while that summary is made. The
      // summary would leave that result without its call, so it is dropped. The round now runs from the call to the
      // newest message, and the pass the result started keeps it whole.
      let finish: (summary: string) => void = () => {};
      const summarize = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
      const context = summarizingContext(['q1', 'r1', 'call', 'read', 'q2', 'r2', 'q3', 'r3', 'q4', 'r4'], summarize);

      context.addMessage(fields('q5'));
      expect(summarize).toHaveBeenCalledTimes(1);
      context.addMessage(fields('write'));
      finish('The user asked about the notes.');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(names(context.getAllMessages())).toEqual(
        ['q1', 'r1', 'call', 'read', 'q2', 'r2', 'q3', 'r3', 'q4', 'r4', 'q5', 'write'],
      );
      expect(summarize).toHaveBeenCalledTimes(1);
    });

    it.each([-3, 0, 1])('summarizes two messages at a time with a chunk size of %s', async (chunkSize) => {
      // A summary takes the place of the messages it summarizes, so a chunk of fewer than two would leave the history
      // as long as it was, or make it longer.
      const summarize = vi.fn(async () => 'The user asked about the notes.');
      const context = summarizingContext(['q1', 'r1', 'q2', 'r2', 'q3', 'r3', 'q4', 'r4', 'q5', 'r5'], summarize, {
        summarizationChunkSize: chunkSize,
      });

      context.addMessage(fields('q6'));

      await vi.waitFor(() =>
        expect(names(context.getAllMessages())).toEqual(['q1', 'r1', 'summary', 'q3', 'r3', 'q4', 'r4', 'q5', 'r5', 'q6']),
      );
      const summary = context.getAllMessages().find((message) => message.role === MessageRole.SUMMARY);
      expect(summary?.metadata?.summarizedMessageIds).toEqual(['q2', 'r2'].map((name) => `msg-${name}`));
    });

    it('leaves the waiting passes to a summary a new message starts between them', async () => {
      // Two messages are recorded while the first summary is made, so two passes wait for it. Once it is made the first
      // of them finds the history within its limit, and before the second runs a new message starts a summary of its
      // own, which waits on a timer as a summarizer waits on its reply. The second pass would find that summary being
      // made and count itself again, over and over, so it is left to the pass making the summary. Each pass is counted,
      // and the hundred-and-first throws, so a loop that never ends fails the test instead of holding the event loop.
      let finish: (summary: string) => void = () => {};
      const summarize = vi
        .fn(() => new Promise<string>((resolve) => setTimeout(() => resolve('The user asked about the weather.'), 0)))
        .mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
      const context = summarizingContext(['q1', 'r1', 'q2', 'r2', 'q3', 'r3', 'q4', 'r4', 'q5', 'r5'], summarize);
      let passes = 0;
      const manageHistoryLength = (context as any).manageHistoryLength.bind(context);
      vi.spyOn(context as any, 'manageHistoryLength').mockImplementation(() => {
        passes += 1;
        if (passes > 100) throw new Error('the history passes do not end');
        return manageHistoryLength();
      });

      context.addMessage(fields('q6'));
      expect(summarize).toHaveBeenCalledTimes(1);
      context.addMessage(fields('r6'));
      context.addMessage(fields('q7'));
      finish('The user asked about the notes.');
      // the first summary is made and the first waiting pass has run
      await Promise.resolve();
      context.addMessage(fields('r7'));
      expect(summarize).toHaveBeenCalledTimes(2);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(passes).toBeLessThan(20);
      expect(names(context.getAllMessages())).toEqual(['q1', 'r1', 'summary', 'r5', 'q6', 'r6', 'q7', 'r7']);
      const summary = context.getAllMessages().find((message) => message.role === MessageRole.SUMMARY);
      expect(summary?.content).toBe('The user asked about the weather.');
    });

    it('makes the summary again when a message of its chunk is rewritten while it is made', async () => {
      // A limit of six that keeps no first and no newest messages, summarized seven at a time. The reply that passes
      // the limit starts a summary of all seven, and an output guardrail rewrites the reply while it is made. A summary
      // of the reply as it was would keep what the guardrail removed, so it is dropped and made again from the reply as
      // the guardrail left it.
      let finish: (summary: string) => void = () => {};
      const summarize = vi
        .fn(async (_text: string) => 'The user asked about the card.')
        .mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
      const context = summarizingContext(['q1', 'r1', 'q2', 'r2', 'q3', 'r3'], summarize, {
        maxHistoryLengthMessages: 6,
        messagesToKeepVerbatimHead: 0,
        messagesToKeepVerbatimTail: 0,
        summarizationChunkSize: 7,
      });

      const reply = context.addMessage({ role: MessageRole.ASSISTANT, content: 'The card is 4111 1111 1111 1111.' });
      expect(summarize).toHaveBeenCalledTimes(1);
      context.replaceMessageContent(reply.id, 'The card is [removed].');
      finish('The user asked about the card 4111 1111 1111 1111.');

      await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(names(context.getAllMessages())).toEqual(['summary']));
      expect(summarize.mock.calls[1][0]).toContain('The card is [removed].');
      expect(summarize.mock.calls[1][0]).not.toContain('4111');
      expect(context.getAllMessages()[0].content).toBe('The user asked about the card.');
    });

    it('keeps a new summary and the last summary of a loaded conversation at the trims after it', async () => {
      // A conversation loaded from storage holds a summary that sorts by its own time, after messages it does not all
      // stand for. A pass summarizes the eight oldest messages after the head into a summary of its own, right after
      // the head, and leaves seven between it and the newest two, too few for another chunk, so it trims the history.
      // The two summaries stand for different messages the trim drops, so it keeps both, and so does the next trim.
      const summarize = vi.fn(async () => 'The user asked about the weather.');
      const context = summarizingContext(
        ['q1', 'r1', 'q2', 'r2', 'q3', 'r3', 'q4', 'r4', 'q5', 'r5', 'q6', 'summary', 'q7', 'r7', 'q8', 'r8', 'q9', 'r9'],
        summarize,
        { summarizationChunkSize: 8 },
      );
      const summaries = () =>
        context.getAllMessages().filter((message) => message.role === MessageRole.SUMMARY).map((message) => message.content);

      context.addMessage(fields('q10'));

      await vi.waitFor(() =>
        expect(names(context.getAllMessages())).toEqual(['q1', 'r1', 'summary', 'summary', 'r7', 'q8', 'r8', 'q9', 'r9', 'q10']),
      );
      expect(summaries()).toEqual(['The user asked about the weather.', 'The user asked about the notes.']);

      context.addMessage(fields('r10'));

      await vi.waitFor(() =>
        expect(names(context.getAllMessages())).toEqual(['q1', 'r1', 'summary', 'summary', 'q8', 'r8', 'q9', 'r9', 'q10', 'r10']),
      );
      expect(summaries()).toEqual(['The user asked about the weather.', 'The user asked about the notes.']);
      expect(summarize).toHaveBeenCalledTimes(1);
    });
  });
});
