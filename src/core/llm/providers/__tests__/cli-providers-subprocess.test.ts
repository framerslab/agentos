/**
 * @fileoverview The two CLI providers on their real bridges, with the
 * subprocess stubbed where the bridges spawn it (execa). A failed run is
 * stubbed with the fields execa 10 sets on its error (lib/return/result.js):
 * `failed`, `timedOut`, `isCanceled`, `isTerminated` (a signal ended the
 * process), `exitCode`, `signal`, `stdout` and `stderr`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

import type { IProvider, ModelCompletionOptions, ModelCompletionResponse } from '../IProvider';
import { ClaudeCodeCLIBridge } from '../implementations/ClaudeCodeCLIBridge';
import { ClaudeCodeProvider } from '../implementations/ClaudeCodeProvider';
import { GeminiCLIBridge } from '../implementations/GeminiCLIBridge';
import { GeminiCLIProvider } from '../implementations/GeminiCLIProvider';
import { isRetryableError } from '../../../../api/generateText';
import { streamText, type StreamPart } from '../../../../api/streamText';
import type { CLISubprocessBridge } from '../../../../safety/sandbox/subprocess/CLISubprocessBridge';
import type { StreamEvent } from '../../../../safety/sandbox/subprocess/types';

/** The fields of an execa 10 failure that the bridges read. */
interface ExecaFailure {
  exitCode?: number;
  signal?: string;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  /** The run's `timeout` in milliseconds, which execa names in the message of a timed-out run. */
  timeout?: number;
  isCanceled?: boolean;
}

/**
 * An error shaped as execa 10 rejects with when a run fails. Its message
 * starts as execa's does (getErrorPrefix in lib/return/message.js).
 */
function execaError({
  exitCode,
  signal,
  stdout = '',
  stderr = '',
  timedOut = false,
  timeout,
  isCanceled = false,
}: ExecaFailure): Error {
  const message = timedOut
    ? `Command timed out after ${timeout} milliseconds`
    : isCanceled
      ? 'Command was canceled'
      : signal !== undefined
        ? `Command was killed with ${signal}`
        : `Command failed with exit code ${exitCode}`;
  return Object.assign(new Error(message), {
    failed: true,
    timedOut,
    isCanceled,
    isTerminated: signal !== undefined,
    exitCode,
    signal,
    stdout,
    stderr,
  });
}

/**
 * Answers the checks a provider's `initialize()` runs (`which`, `--version`
 * and the `pong` ping) and hands every other spawn to `run`.
 */
function stubCli(binary: string, run: (args: string[], options: Record<string, any>) => unknown): void {
  execaMock.mockImplementation((command: string, args: string[] = [], options: Record<string, any> = {}) => {
    if (command === 'which') return Promise.resolve({ stdout: `/usr/local/bin/${binary}\n` });
    if (args[0] === '--version') return Promise.resolve({ stdout: `${binary} 2.0.0\n` });
    if (options.input === 'Reply with exactly: pong') return Promise.resolve({ stdout: '{"result":"pong"}' });
    return run(args, options);
  });
}

const PROVIDERS: Array<{ name: string; binary: string; model: string; create: () => IProvider }> = [
  { name: 'ClaudeCodeProvider', binary: 'claude', model: 'claude-sonnet-4-6', create: () => new ClaudeCodeProvider() },
  { name: 'GeminiCLIProvider', binary: 'gemini', model: 'gemini-3.5-flash', create: () => new GeminiCLIProvider() },
];

const HELLO = [{ role: 'user' as const, content: 'Hello' }];

beforeEach(() => {
  execaMock.mockReset();
});

describe.each(PROVIDERS)('$name: a failed run, as the bridge classifies it', ({ binary, model, create }) => {
  it.each([
    ['Authentication failed: run the login again', 'NOT_AUTHENTICATED'],
    ['Error: Rate Limit exceeded, try again later', 'RATE_LIMITED'],
    ['Prompt is too long for the Context window', 'CONTEXT_TOO_LONG'],
  ])('reads stderr without regard to case: %s', async (stderr, code) => {
    stubCli(binary, () => Promise.reject(execaError({ exitCode: 1, stderr })));
    const provider = create();
    await provider.initialize({});

    await expect(provider.generateCompletion(model, HELLO, {})).rejects.toMatchObject({ code });
  });

  it('reports a call cancelled through abortSignal as REQUEST_ABORTED, which no fallback retries', async () => {
    let spawned!: () => void;
    const running = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    // As execa does with `cancelSignal`: the abort kills the process (SIGTERM)
    // and the run rejects with `isCanceled` and `isTerminated` set.
    stubCli(binary, (_args, options) => {
      spawned();
      return new Promise((_resolve, reject) => {
        const signal = options.cancelSignal as AbortSignal;
        signal.addEventListener('abort', () => reject(execaError({ isCanceled: true, signal: 'SIGTERM' })), {
          once: true,
        });
      });
    });
    const provider = create();
    await provider.initialize({});
    const controller = new AbortController();

    const call = provider.generateCompletion(model, HELLO, { abortSignal: controller.signal });
    await running;
    controller.abort();
    const error = await call.then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toMatchObject({ code: 'REQUEST_ABORTED', recoverable: false });
    expect(isRetryableError(error)).toBe(false);
  });
});

/**
 * A run as execa 10 returns it: a native promise for the outcome, with the
 * child's stdout beside it. The CLI writes `lines` to stdout and then exits
 * with `exitCode`; a non-zero exit rejects the promise as execa does.
 */
function cliRun(lines: unknown[], exitCode: number, stderr = '') {
  const outcome: Promise<unknown> =
    exitCode === 0
      ? Promise.resolve({ failed: false, exitCode: 0, stdout: '', stderr })
      : Promise.reject(execaError({ exitCode, stderr }));
  // The stream under test reports the outcome by awaiting it; the stub does
  // not fail a test with an unhandled rejection of its own.
  outcome.catch(() => undefined);
  return Object.assign(outcome, {
    stdout: (async function* () {
      for (const line of lines) yield Buffer.from(`${JSON.stringify(line)}\n`);
    })(),
    kill: vi.fn(),
  });
}

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'The weather in a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

/** get_weather as streamText() takes it. */
const STREAM_TEXT_TOOLS = {
  get_weather: { description: WEATHER_TOOL.function.description, parameters: WEATHER_TOOL.function.parameters },
};

/** The text of each text part of a streamText() stream, in order. */
function textPartsOf(parts: StreamPart[]): string[] {
  return parts.flatMap((part) => (part.type === 'text' ? [part.text] : []));
}

/** The stream-json lines each CLI writes for the cases below. */
interface StreamFixture {
  /** A reply of "Hello", ending with the CLI's success result. */
  hello: unknown[];
  /** A reply of `text` in one piece, as the CLI writes it now, ending with the CLI's success result. */
  reply: (text: string) => unknown[];
  /** A reply that calls get_weather for Paris, ending with the success result. */
  toolCall: unknown[];
  /** A result line the CLI flags as an error, and the message it carries. */
  errorResult: unknown;
  errorMessage: string;
  /** An error event line, and the message it carries. */
  errorEvent: unknown;
  errorEventMessage: string;
}

const STREAM_PROVIDERS: Array<(typeof PROVIDERS)[number] & { fixture: StreamFixture }> = [
  {
    ...PROVIDERS[0],
    fixture: {
      hello: [
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'result', subtype: 'success', is_error: false, result: 'Hello', session_id: 's1' },
      ],
      // With --include-partial-messages, which the bridge passes, each delta
      // comes wrapped as a stream_event (SDKPartialAssistantMessage in
      // @anthropic-ai/claude-agent-sdk 0.3.296, sdk.d.ts).
      reply: (text) => [
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
          parent_tool_use_id: null,
          session_id: 's1',
        },
        { type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's1' },
      ],
      toolCall: [
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 's1',
          result: JSON.stringify({
            response_type: 'tool_calls',
            tool_calls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } }],
          }),
        },
      ],
      // Claude Code reports an API failure as a result with is_error set and
      // the failure as its result text.
      errorResult: { type: 'result', subtype: 'success', is_error: true, result: 'API Error: 401 invalid x-api-key', session_id: 's1' },
      errorMessage: 'API Error: 401 invalid x-api-key',
      // The error line the bridge reads (ClaudeCodeCLIBridge.parseStreamEvent),
      // with an error object as the Messages API writes one. The message types of
      // @anthropic-ai/claude-agent-sdk 0.3.296 list no top-level error line, so
      // this case holds the bridge to its own reading of one.
      errorEvent: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      errorEventMessage: 'Overloaded',
    },
  },
  {
    ...PROVIDERS[1],
    fixture: {
      hello: [
        { type: 'text', text: 'Hello' },
        { type: 'result', status: 'success' },
      ],
      // MessageEvent and ResultEvent in packages/core/src/output/types.ts
      // (google-gemini/gemini-cli at 9b6e0265).
      reply: (text) => [
        { type: 'message', timestamp: '2026-10-10T12:00:00.000Z', role: 'assistant', content: text, delta: true },
        { type: 'result', timestamp: '2026-10-10T12:00:00.000Z', status: 'success' },
      ],
      toolCall: [
        { type: 'text', text: '<tool_call id="call_1" name="get_weather">{"city":"Paris"}</tool_call>' },
        { type: 'result', status: 'success' },
      ],
      // The result the Gemini CLI writes before it exits non-zero
      // (packages/cli/src/utils/errors.ts, handleError, in google-gemini/gemini-cli).
      errorResult: {
        type: 'result',
        status: 'error',
        error: { type: 'FatalAuthenticationError', message: 'Request had invalid authentication credentials.' },
      },
      errorMessage: 'Request had invalid authentication credentials.',
      // An error event of severity 'error' (ErrorEvent in packages/core/src/output/types.ts),
      // as packages/cli/src/nonInteractiveCli.ts writes it when the session runs out of turns.
      errorEvent: {
        type: 'error',
        timestamp: '2026-10-10T12:00:00.000Z',
        severity: 'error',
        message: 'Maximum session turns exceeded',
      },
      errorEventMessage: 'Maximum session turns exceeded',
    },
  },
];

describe.each(STREAM_PROVIDERS)('$name: how a stream ends', ({ binary, model, create, fixture }) => {
  async function streamOf(
    lines: unknown[],
    exitCode: number,
    { options = {}, stderr = '' }: { options?: ModelCompletionOptions; stderr?: string } = {},
  ): Promise<ModelCompletionResponse[]> {
    stubCli(binary, () => cliRun(lines, exitCode, stderr));
    const provider = create();
    await provider.initialize({});
    const chunks: ModelCompletionResponse[] = [];
    for await (const chunk of provider.generateCompletionStream(model, HELLO, options)) chunks.push(chunk);
    return chunks;
  }

  it('passes the reply on once the CLI has exited cleanly', async () => {
    const finals = (await streamOf(fixture.hello, 0)).filter((chunk) => chunk.isFinal);

    expect(finals).toHaveLength(1);
    expect(finals[0].error).toBeUndefined();
    expect(finals[0].choices[0]).toMatchObject({ finishReason: 'stop', message: { content: 'Hello' } });
  });

  it('passes a tool call on once the CLI has exited cleanly', async () => {
    const chunks = await streamOf(fixture.toolCall, 0, { options: { tools: [WEATHER_TOOL] } });
    const final = chunks[chunks.length - 1];

    expect(final.error).toBeUndefined();
    expect(final.choices[0].finishReason).toBe('tool_calls');
    expect(final.choices[0].message.tool_calls?.[0]?.function).toMatchObject({
      name: 'get_weather',
      arguments: JSON.stringify({ city: 'Paris' }),
    });
  });

  it('ends with the classified exit failure when the CLI exits non-zero after its result line', async () => {
    const finals = (await streamOf(fixture.hello, 1, { stderr: 'Fatal: the session store went away' })).filter(
      (chunk) => chunk.isFinal,
    );

    expect(finals).toHaveLength(1);
    expect(finals[0].choices).toEqual([]);
    expect(finals[0].error).toMatchObject({ code: 'CRASHED' });
  });

  it("ends a stream the caller aborts with the abort chunk the abortSignal contract asks for (error.type 'abort')", async () => {
    let spawned!: () => void;
    const running = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    // A run that writes nothing until execa stops it for the caller's signal;
    // stdout closes when the process ends.
    stubCli(binary, (_args, options) => {
      spawned();
      const outcome = new Promise((_resolve, reject) => {
        const signal = options.cancelSignal as AbortSignal;
        signal.addEventListener('abort', () => reject(execaError({ isCanceled: true, signal: 'SIGTERM' })), {
          once: true,
        });
      });
      outcome.catch(() => undefined);
      return Object.assign(outcome, {
        stdout: (async function* () {
          await outcome.catch(() => undefined);
        })(),
        kill: vi.fn(),
      });
    });
    const provider = create();
    await provider.initialize({});
    const controller = new AbortController();
    const chunks: ModelCompletionResponse[] = [];

    const reading = (async () => {
      for await (const chunk of provider.generateCompletionStream(model, HELLO, { abortSignal: controller.signal })) {
        chunks.push(chunk);
      }
    })();
    await running;
    controller.abort();
    await reading;

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ isFinal: true, error: { type: 'abort', code: 'REQUEST_ABORTED' } });
  });

  it.each([0, 1])(
    'ends with an error carrying the message of a result the CLI flags as an error (exit code %i)',
    async (exitCode) => {
      const finals = (await streamOf([fixture.errorResult], exitCode)).filter((chunk) => chunk.isFinal);

      expect(finals).toHaveLength(1);
      expect(finals[0].choices).toEqual([]);
      expect(finals[0].error).toMatchObject({ code: 'CRASHED', message: expect.stringContaining(fixture.errorMessage) });
    },
  );

  it('ends with the error event the CLI writes, not the failed exit that follows it', async () => {
    // The exit alone would classify as RATE_LIMITED from this stderr.
    const finals = (
      await streamOf([fixture.hello[0], fixture.errorEvent], 1, { stderr: 'Error: Rate Limit exceeded, try again later' })
    ).filter((chunk) => chunk.isFinal);

    expect(finals).toHaveLength(1);
    expect(finals[0].choices).toEqual([]);
    expect(finals[0].error?.message).toContain(fixture.errorEventMessage);
    expect(finals[0].error?.code).not.toBe('RATE_LIMITED');
  });
});

/**
 * stream-json as the current Gemini CLI writes it (google-gemini/gemini-cli at
 * 9b6e0265: the event types in packages/core/src/output/types.ts, written by
 * packages/cli/src/nonInteractiveCli.ts): an init event, the prompt echoed as
 * a user message, the reply as assistant message deltas, and a result event
 * that carries no text and has its token counts in `stats`.
 */
describe('GeminiCLIProvider: the stream-json the current Gemini CLI writes', () => {
  const at = '2026-10-10T12:00:00.000Z';
  const stats = {
    total_tokens: 15,
    input_tokens: 12,
    output_tokens: 3,
    cached: 0,
    input: 12,
    duration_ms: 840,
    tool_calls: 0,
    models: { 'gemini-3.5-flash': { total_tokens: 15, input_tokens: 12, output_tokens: 3, cached: 0, input: 12 } },
  };
  const opening = [
    { type: 'init', timestamp: at, session_id: 'g1', model: 'gemini-3.5-flash' },
    { type: 'message', timestamp: at, role: 'user', content: 'Hello' },
  ];

  async function streamOf(lines: unknown[]): Promise<ModelCompletionResponse[]> {
    stubCli('gemini', () => cliRun(lines, 0));
    const provider = new GeminiCLIProvider();
    await provider.initialize({});
    const chunks: ModelCompletionResponse[] = [];
    for await (const chunk of provider.generateCompletionStream('gemini-3.5-flash', HELLO, {})) chunks.push(chunk);
    return chunks;
  }

  it('passes on the reply written as assistant message deltas, with the token counts of the result stats', async () => {
    const chunks = await streamOf([
      ...opening,
      { type: 'message', timestamp: at, role: 'assistant', content: 'Hi ', delta: true },
      { type: 'message', timestamp: at, role: 'assistant', content: 'there', delta: true },
      { type: 'result', timestamp: at, status: 'success', stats },
    ]);
    const final = chunks[chunks.length - 1];

    // The echoed prompt is not reply text.
    expect(chunks.filter((chunk) => !chunk.isFinal).map((chunk) => chunk.responseTextDelta)).toEqual(['Hi ', 'there']);
    expect(final.error).toBeUndefined();
    expect(final).toMatchObject({ isFinal: true, choices: [{ finishReason: 'stop', message: { content: 'Hi there' } }] });
    expect(final.usage).toMatchObject({ promptTokens: 12, completionTokens: 3, totalTokens: 15 });
  });

  it('goes on past an error event the CLI marks as a warning', async () => {
    const chunks = await streamOf([
      ...opening,
      { type: 'message', timestamp: at, role: 'assistant', content: 'Hi there', delta: true },
      // What the CLI writes when it stops a loop; the run then ends with a success result.
      { type: 'error', timestamp: at, severity: 'warning', message: 'Loop detected, stopping execution' },
      { type: 'result', timestamp: at, status: 'success', stats },
    ]);
    const final = chunks[chunks.length - 1];

    expect(final.error).toBeUndefined();
    expect(final).toMatchObject({ isFinal: true, choices: [{ finishReason: 'stop', message: { content: 'Hi there' } }] });
  });
});

/**
 * With tools, GeminiCLIProvider asks the model for each tool call as a block
 * of its reply, <tool_call id=".." name="..">{json}</tool_call>
 * (injectToolSchemas), and reads the tool calls from the whole reply when the
 * result event arrives. The Gemini CLI writes the reply as message deltas
 * wherever the model's chunks end (packages/cli/src/nonInteractiveCli.ts in
 * google-gemini/gemini-cli at 9b6e0265), so a block can come in pieces.
 */
describe('GeminiCLIProvider: tool-call markup in the reply, through streamText()', () => {
  const at = '2026-10-10T12:00:00.000Z';
  const opening = [
    { type: 'init', timestamp: at, session_id: 'g1', model: 'gemini-3.5-flash' },
    { type: 'message', timestamp: at, role: 'user', content: 'What is the weather in Paris?' },
  ];
  /** A piece of the reply, as the CLI writes each one. */
  const piece = (content: string) => ({ type: 'message', timestamp: at, role: 'assistant', content, delta: true });
  const result = {
    type: 'result',
    timestamp: at,
    status: 'success',
    stats: { total_tokens: 15, input_tokens: 12, output_tokens: 3, cached: 0, input: 12, duration_ms: 840, tool_calls: 0 },
  };

  /**
   * streamText() on the gemini-cli provider, with get_weather or with no
   * tools, over a CLI that writes the reply in `pieces` and exits 0: the
   * stream's parts, its text, and whether each run of the CLI was given a
   * system prompt, which is where the provider writes the tools.
   */
  async function streamTextOver(pieces: string[], { tools }: { tools: boolean }) {
    const prompted: boolean[] = [];
    stubCli('gemini', (_args, options) => {
      prompted.push(options.env?.GEMINI_SYSTEM_MD !== undefined);
      return cliRun([...opening, ...pieces.map(piece), result], 0);
    });
    const stream = streamText({
      provider: 'gemini-cli',
      model: 'gemini-3.5-flash',
      prompt: 'What is the weather in Paris?',
      ...(tools ? { tools: STREAM_TEXT_TOOLS } : {}),
    });
    const parts: StreamPart[] = [];
    for await (const part of stream.fullStream) parts.push(part);
    return { prompted, parts, text: await stream.text };
  }

  it('streams the prose around a tool-call block as text, and the block as the tool call alone', async () => {
    const { prompted, parts, text } = await streamTextOver(
      [
        'Let me look that up. ',
        '<tool',
        '_call id="call_1" na',
        'me="get_weather">{"city": ',
        '"Paris"}</tool_',
        'call>',
        'Back in a moment.',
      ],
      { tools: true },
    );

    expect(prompted).toEqual([true]);
    expect(textPartsOf(parts)).toEqual(['Let me look that up. ', 'Back in a moment.']);
    expect(parts.filter((part) => part.type === 'tool-call')).toEqual([
      { type: 'tool-call', toolName: 'get_weather', args: { city: 'Paris' } },
    ]);
    expect(text).toBe('Let me look that up. Back in a moment.');
  });

  it("streams a '<' in prose that opens no tool-call block as it arrives", async () => {
    // An HTML tag, a comparison, a tag whose name starts as tool_call does, and tool_call with no attributes.
    const pieces = ['Wrap it in <b>bold</b>. ', 'If a < b, ', 'the <toolbar> tag stays, ', 'and so does <tool_call> alone.'];
    const { prompted, parts, text } = await streamTextOver(pieces, { tools: true });

    expect(prompted).toEqual([true]);
    expect(textPartsOf(parts)).toEqual(pieces);
    expect(parts.filter((part) => part.type === 'tool-call')).toEqual([]);
    expect(text).toBe(pieces.join(''));
  });

  it('passes on, by the end of the reply, prose that quotes an opening tag no closing tag follows', async () => {
    const pieces = ['A call opens with ', '<tool_call id="call_1" name="get_weather">', ' and its arguments follow.'];
    const { prompted, parts, text } = await streamTextOver(pieces, { tools: true });

    expect(prompted).toEqual([true]);
    expect(textPartsOf(parts).join('')).toBe(pieces.join(''));
    expect(parts.filter((part) => part.type === 'tool-call')).toEqual([]);
    expect(text).toBe(pieces.join(''));
  });

  it('streams a block whose body is not JSON as text once its closing tag arrives, with no tool call', async () => {
    // parseToolCallsFromText() skips a block whose body JSON.parse rejects, so the reply holds no tool call.
    const block = '<tool_call id="call_1" name="get_weather">{city: Paris}</tool_call>';
    const { prompted, parts, text } = await streamTextOver(
      ['Here: ', '<tool_call id="call_1" name="get_weather">', '{city: Paris}', '</tool_call>', ' Done.'],
      { tools: true },
    );

    expect(prompted).toEqual([true]);
    expect(textPartsOf(parts)).toEqual(['Here: ', block, ' Done.']);
    expect(parts.filter((part) => part.type === 'tool-call')).toEqual([]);
    expect(text).toBe(`Here: ${block} Done.`);
  });

  it('streams a reply with no tools as it arrives, markup and all', async () => {
    const pieces = ['Here is one: ', '<tool_call id="call_1" name="get_weather">', '{"city": "Paris"}</tool_call>'];
    const { prompted, parts, text } = await streamTextOver(pieces, { tools: false });

    expect(prompted).toEqual([false]);
    expect(textPartsOf(parts)).toEqual(pieces);
    expect(parts.filter((part) => part.type === 'tool-call')).toEqual([]);
    expect(text).toBe(pieces.join(''));
  });

  it("ends with the abort chunk (error.type 'abort') when the caller aborts while the consumer holds text held back to the reply's end", async () => {
    // No closing tag follows the opening tag, so the reply's text is held back until the reply ends.
    const reply = '<tool_call id="call_1" name="get_weather"> opens a call.';
    let run!: ReturnType<typeof cancellableRun>;
    stubCli('gemini', (_args, options) => {
      run = cancellableRun([...opening, piece(reply), result], options.cancelSignal);
      return run;
    });
    const provider = new GeminiCLIProvider();
    await provider.initialize({});
    const controller = new AbortController();
    const chunks: ModelCompletionResponse[] = [];
    let endedBeforeAbort: boolean | undefined;
    for await (const chunk of provider.generateCompletionStream('gemini-3.5-flash', HELLO, {
      tools: [WEATHER_TOOL],
      abortSignal: controller.signal,
    })) {
      chunks.push(chunk);
      if (chunk.responseTextDelta && !controller.signal.aborted) {
        endedBeforeAbort = run.state.ended;
        controller.abort();
      }
    }
    const final = chunks[chunks.length - 1];

    // The CLI had exited 0 and the held text had gone out before the abort: the case under test was reached.
    expect(endedBeforeAbort).toBe(true);
    expect(chunks.filter((chunk) => !chunk.isFinal).map((chunk) => chunk.responseTextDelta)).toEqual([reply]);
    expect(final).toMatchObject({ isFinal: true, error: { type: 'abort', code: 'REQUEST_ABORTED' } });
    expect(final.choices).toEqual([]);
  });
});

/**
 * A run whose outcome only the code under test can observe. vi.fn() attaches
 * handlers of its own to a Promise its implementation returns (the
 * settledResults record, @vitest/spy 5.0.3 src/index.ts), which would hide a
 * rejection the bridge leaves unhandled. The run is therefore a plain object
 * with the outcome's then, catch and finally bound to it, which the bridge
 * awaits as it awaits execa's subprocess. The CLI writes `lines` and runs on
 * until `exit` ends it; a non-zero code rejects the outcome as execa does.
 */
function unobservedRun(lines: unknown[]) {
  let settle!: (code: number) => void;
  const outcome = new Promise<unknown>((resolve, reject) => {
    settle = (code) =>
      code === 0
        ? resolve({ failed: false, exitCode: 0, stdout: '', stderr: '' })
        : reject(execaError({ exitCode: code }));
  });
  const subprocess = {
    then: (onFulfilled?: any, onRejected?: any) => outcome.then(onFulfilled, onRejected),
    catch: (onRejected?: any) => outcome.catch(onRejected),
    finally: (onFinally?: any) => outcome.finally(onFinally),
    stdout: (async function* () {
      for (const line of lines) yield Buffer.from(`${JSON.stringify(line)}\n`);
    })(),
    kill: vi.fn(),
  };
  return { subprocess, exit: (code: number) => settle(code) };
}

describe.each(STREAM_PROVIDERS)('$name: a consumer that stops reading the stream early', ({ binary, model, create, fixture }) => {
  it('ends the CLI, and a non-zero exit that follows is no unhandled rejection', async () => {
    // The CLI has written the first piece of its reply and has more to write.
    const run = unobservedRun([fixture.hello[0], fixture.hello[0]]);
    stubCli(binary, () => run.subprocess);
    const provider = create();
    await provider.initialize({});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const chunks: ModelCompletionResponse[] = [];
      for await (const chunk of provider.generateCompletionStream(model, HELLO, {})) {
        chunks.push(chunk);
        break;
      }
      run.exit(1);
      // Node reports a rejection nothing handles once the microtasks of the turn have run.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      // While a test listens for unhandledRejection, Vitest leaves such a
      // rejection to it (runtime/moduleRunner/errorCatcher.ts in vitest 5.0.3),
      // so this listener is where it shows.
      expect(unhandled).not.toHaveBeenCalled();
      expect(run.subprocess.kill).toHaveBeenCalled();
      expect(chunks).toHaveLength(1);
      expect(chunks[0].isFinal).toBe(false);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

/**
 * A run the CLI ended before the bridge read its last output, as execa 10
 * settles it. Node's stream for the pipe then holds the rest of the output and
 * its end, and emits 'end' on the tick after the read that empties it; execa
 * settles the run once the process has exited and its stdio streams have
 * finished (waitForSubprocessResult in lib/resolve/wait-subprocess.js, which
 * waits on lib/resolve/stdio.js and lib/resolve/wait-stream.js). Here stdout
 * is a Readable that holds the CLI's lines and their end, and the run settles
 * with `exitCode` when it emits 'end'. As in unobservedRun, the run is a plain
 * object, so only the code under test can handle its rejection.
 */
function exitedRun(lines: unknown[], exitCode: number) {
  const stdout = new Readable({ read() {} });
  stdout.push(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  stdout.push(null);
  const outcome = new Promise<unknown>((resolve, reject) => {
    stdout.once('end', () =>
      exitCode === 0
        ? resolve({ failed: false, exitCode: 0, stdout: '', stderr: '' })
        : reject(execaError({ exitCode })),
    );
  });
  return {
    then: (onFulfilled?: any, onRejected?: any) => outcome.then(onFulfilled, onRejected),
    catch: (onRejected?: any) => outcome.catch(onRejected),
    finally: (onFinally?: any) => outcome.finally(onFinally),
    stdout,
    kill: vi.fn(),
  };
}

describe.each(STREAM_PROVIDERS)('$name: a consumer that waits on each chunk', ({ binary, model, create, fixture }) => {
  it('ends with the classified failed exit, which is no unhandled rejection while the consumer waits', async () => {
    // The CLI wrote its reply and its result line and exited 1 before the
    // bridge read its stdout.
    stubCli(binary, () => exitedRun(fixture.hello, 1));
    const provider = create();
    await provider.initialize({});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const chunks: ModelCompletionResponse[] = [];
      for await (const chunk of provider.generateCompletionStream(model, HELLO, {})) {
        chunks.push(chunk);
        // A consumer that hands each chunk on and waits for the write: the
        // microtasks of the turn run out while the stream waits at its yield.
        await new Promise((resolve) => setImmediate(resolve));
      }

      // The consumer waited on a chunk of the reply, which the bridge read
      // with the end of stdout: the case under test was reached.
      expect(chunks.filter((chunk) => !chunk.isFinal).map((chunk) => chunk.responseTextDelta)).toEqual(['Hello']);
      // While a test listens for unhandledRejection, Vitest leaves such a
      // rejection to it (runtime/moduleRunner/errorCatcher.ts in vitest 5.0.3),
      // so this listener is where it shows.
      expect(unhandled).not.toHaveBeenCalled();
      const finals = chunks.filter((chunk) => chunk.isFinal);
      expect(finals).toHaveLength(1);
      expect(finals[0].choices).toEqual([]);
      expect(finals[0].error).toMatchObject({ code: 'CRASHED' });
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('ClaudeCodeProvider: an error result with no result text', () => {
  it('ends the stream with the error subtype and the errors the CLI lists', async () => {
    // SDKResultError in @anthropic-ai/claude-agent-sdk 0.3.296 (sdk.d.ts): the
    // error subtypes carry no result; their detail is in errors.
    stubCli('claude', () =>
      cliRun(
        [
          {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            num_turns: 1,
            errors: ['Request timed out', 'Retries used up'],
            session_id: 's1',
          },
        ],
        1,
      ),
    );
    const provider = new ClaudeCodeProvider();
    await provider.initialize({});
    const chunks: ModelCompletionResponse[] = [];
    for await (const chunk of provider.generateCompletionStream('claude-sonnet-4-6', HELLO, {})) chunks.push(chunk);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      isFinal: true,
      choices: [],
      error: {
        code: 'CRASHED',
        message: 'Claude Code returned an error: error_during_execution: Request timed out; Retries used up',
      },
    });
  });

  it('reads the listed errors as the SDK does: each trimmed, a blank one left out', async () => {
    // The SDK's own reader of an error result (Query.readMessages in
    // @anthropic-ai/claude-agent-sdk 0.3.296, sdk.mjs) trims each entry of
    // errors and drops the blank ones before it joins them with '; '. The
    // result of a startup failure carries the text the CLI wrote to stderr
    // (startup_failure_reason in sdk.d.ts).
    stubCli('claude', () =>
      cliRun(
        [
          {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            num_turns: 0,
            errors: ['The working directory is unavailable: /srv/app\n', '  '],
            startup_failure_reason: 'cwd_unavailable',
            session_id: 's1',
          },
        ],
        1,
      ),
    );
    const provider = new ClaudeCodeProvider();
    await provider.initialize({});
    const chunks: ModelCompletionResponse[] = [];
    for await (const chunk of provider.generateCompletionStream('claude-sonnet-4-6', HELLO, {})) chunks.push(chunk);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      isFinal: true,
      choices: [],
      error: {
        code: 'CRASHED',
        message: 'Claude Code returned an error: error_during_execution: The working directory is unavailable: /srv/app',
      },
    });
  });
});

/**
 * StreamEvent is exported (@framers/agentos/sandbox/subprocess), so a host can
 * read a bridge's stream itself. Before 0.13.41 an error result's `result` was
 * the CLI's own result text, '' when it wrote none. 0.13.41 put the failure's
 * message there, which a host that does not read `isError` takes for a reply;
 * `result` keeps the CLI's own text, and the message has a field of its own.
 */
describe('A direct consumer of a CLI bridge: a result the CLI flags as an error', () => {
  it.each<{ name: string; binary: string; create: () => CLISubprocessBridge; line: unknown; expected: object }>([
    {
      name: 'GeminiCLIBridge, the result the CLI writes before a failed exit',
      binary: 'gemini',
      create: () => new GeminiCLIBridge(),
      line: {
        type: 'result',
        timestamp: '2026-10-10T12:00:00.000Z',
        status: 'error',
        error: { type: 'FatalAuthenticationError', message: 'Request had invalid authentication credentials.' },
      },
      expected: { type: 'result', result: '', isError: true, error: 'Request had invalid authentication credentials.' },
    },
    {
      name: 'ClaudeCodeCLIBridge, an error subtype with no result text',
      binary: 'claude',
      create: () => new ClaudeCodeCLIBridge(),
      line: { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 2, errors: ['Reached the turn limit'], session_id: 's1' },
      expected: { type: 'result', result: '', isError: true, error: 'error_max_turns: Reached the turn limit' },
    },
    {
      name: 'ClaudeCodeCLIBridge, an API error whose result text is the error',
      binary: 'claude',
      create: () => new ClaudeCodeCLIBridge(),
      line: { type: 'result', subtype: 'success', is_error: true, result: 'API Error: 401 invalid x-api-key', session_id: 's1' },
      expected: { type: 'result', result: 'API Error: 401 invalid x-api-key', isError: true, error: 'API Error: 401 invalid x-api-key' },
    },
  ])('$name: result as before 0.13.41, the message in error', async ({ binary, create, line, expected }) => {
    stubCli(binary, () => cliRun([line], 1));
    const events: StreamEvent[] = [];
    const reading = (async () => {
      for await (const event of create().stream({ prompt: 'Hello' })) events.push(event);
    })();

    await expect(reading).rejects.toMatchObject({ code: 'CRASHED' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject(expected);
  });
});

/**
 * stream-json as Claude Code writes it with --include-partial-messages, which
 * the bridge passes: each Messages API stream event wrapped as
 * { type: 'stream_event', event }, then the complete assistant message, whose
 * content is a list of blocks (SDKPartialAssistantMessage and
 * SDKAssistantMessage in @anthropic-ai/claude-agent-sdk 0.3.296, sdk.d.ts).
 */
describe('ClaudeCodeProvider: the stream-json Claude Code writes with partial messages', () => {
  it('passes on the text deltas nested under stream_event, and the complete message after them once', async () => {
    const frame = { parent_tool_use_id: null, session_id: 's1' };
    const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: null };
    stubCli('claude', () =>
      cliRun(
        [
          { type: 'stream_event', event: { type: 'message_start', message: { ...message, content: [] } }, ...frame },
          { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } }, ...frame },
          { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } }, ...frame },
          { type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, ...frame },
          { type: 'assistant', message: { ...message, content: [{ type: 'text', text: 'Hi there' }] }, ...frame },
          { type: 'stream_event', event: { type: 'message_stop' }, ...frame },
          { type: 'result', subtype: 'success', is_error: false, result: 'Hi there', session_id: 's1', usage: { input_tokens: 12, output_tokens: 3 } },
        ],
        0,
      ),
    );
    const provider = new ClaudeCodeProvider();
    await provider.initialize({});
    const chunks: ModelCompletionResponse[] = [];
    for await (const chunk of provider.generateCompletionStream('claude-sonnet-4-6', HELLO, {})) chunks.push(chunk);
    const final = chunks[chunks.length - 1];

    expect(chunks.filter((chunk) => !chunk.isFinal).map((chunk) => chunk.responseTextDelta)).toEqual(['Hi ', 'there']);
    expect(final.error).toBeUndefined();
    expect(final).toMatchObject({ isFinal: true, choices: [{ finishReason: 'stop', message: { content: 'Hi there' } }] });
  });
});

/**
 * A run that writes `lines` and exits 0, its stdout read in two pieces: the
 * second starts two bytes into the first `character` the lines carry. A pipe
 * hands over what the CLI has written so far, wherever a character's bytes
 * end, and the child's stdout gives Buffers: execa 10 sets no encoding on it,
 * and decodes its own copy of the output, `result.stdout`, through one
 * StringDecoder for the whole stream (lib/transform/encoding-transform.js).
 */
function splitRun(lines: unknown[], character: string) {
  const bytes = Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  const at = bytes.indexOf(Buffer.from(character)) + 2;
  return Object.assign(Promise.resolve({ failed: false, exitCode: 0, stdout: '', stderr: '' }), {
    stdout: (async function* () {
      yield bytes.subarray(0, at);
      yield bytes.subarray(at);
    })(),
    kill: vi.fn(),
  });
}

describe.each(STREAM_PROVIDERS)('$name: a character whose bytes two reads of stdout split', ({ binary, model, create, fixture }) => {
  it('passes the character on whole, in the text delta and in the reply', async () => {
    // U+1F600 takes four bytes in UTF-8, and the first read ends after two of them.
    const reply = 'Hi \u{1F600}';
    stubCli(binary, () => splitRun(fixture.reply(reply), '\u{1F600}'));
    const provider = create();
    await provider.initialize({});
    const chunks: ModelCompletionResponse[] = [];
    for await (const chunk of provider.generateCompletionStream(model, HELLO, {})) chunks.push(chunk);
    const final = chunks[chunks.length - 1];

    expect(chunks.filter((chunk) => !chunk.isFinal).map((chunk) => chunk.responseTextDelta)).toEqual([reply]);
    expect(final.error).toBeUndefined();
    expect(final).toMatchObject({ isFinal: true, choices: [{ finishReason: 'stop', message: { content: reply } }] });
  });
});

/**
 * A run that writes `lines` and exits 0, settled as execa 10 settles a run
 * that has a `timeout`. The timer starts at the spawn; when it fires before
 * the run has settled, execa calls kill(), which does nothing to a process
 * that has exited, and fails the run with `timedOut` (killAfterTimeout in
 * lib/terminate/timeout.js). The run settles once the process has exited and
 * its stdout has ended; a run the timer failed waits for that as well
 * (waitForSubprocessResult in lib/resolve/wait-subprocess.js) and carries the
 * exit code the process had (getAsyncResult in lib/methods/main-async.js).
 * stdout hands over one line per read, as a pipe does while the CLI streams
 * its reply, and ends after the last line: the CLI has exited by then.
 */
function timedRun(lines: unknown[], timeout: number) {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, timeout);
  let settle!: () => void;
  const outcome = new Promise<unknown>((resolve, reject) => {
    settle = () => {
      clearTimeout(timer);
      if (timedOut) reject(execaError({ exitCode: 0, timedOut: true, timeout }));
      else resolve({ failed: false, exitCode: 0, stdout: '', stderr: '' });
    };
  });
  outcome.catch(() => undefined);
  return Object.assign(outcome, {
    stdout: (async function* () {
      for (const line of lines) yield Buffer.from(`${JSON.stringify(line)}\n`);
      settle();
    })(),
    kill: vi.fn(),
  });
}

describe.each(STREAM_PROVIDERS)('$name: a consumer slower than the timeout', ({ binary, model, create, fixture }) => {
  it('gets the whole reply and its final chunk from a CLI that wrote them and exited 0 in time', async () => {
    const timeout = 200;
    stubCli(binary, (_args, options) => timedRun(fixture.hello, options.timeout));
    const provider = create();
    await provider.initialize({ requestTimeout: timeout });
    const chunks: ModelCompletionResponse[] = [];
    for await (const chunk of provider.generateCompletionStream(model, HELLO, {})) {
      chunks.push(chunk);
      // A consumer that spends longer than the timeout on each chunk.
      if (!chunk.isFinal) await new Promise((resolve) => setTimeout(resolve, 2 * timeout));
    }
    const final = chunks[chunks.length - 1];

    // The consumer held a chunk of the reply past the timeout: the case under test was reached.
    expect(chunks.filter((chunk) => !chunk.isFinal).map((chunk) => chunk.responseTextDelta)).toEqual(['Hello']);
    expect(final.error).toBeUndefined();
    expect(final).toMatchObject({ isFinal: true, choices: [{ finishReason: 'stop', message: { content: 'Hello' } }] });
  });
});

/**
 * A run that writes `lines` and exits 0, settled as execa 10 settles a run
 * given a `cancelSignal`. The run settles once the process has exited and its
 * stdout has ended (waitForSubprocessResult in lib/resolve/wait-subprocess.js).
 * When the signal aborts before then, execa calls kill(), which does nothing to
 * a process that has exited, and fails the run with `isCanceled` and the exit
 * code the process had (terminateOnCancel in lib/terminate/cancel.js;
 * getAsyncResult in lib/methods/main-async.js). Once the run has settled,
 * execa stops listening to the signal (handlePromise in
 * lib/methods/main-async.js), and an abort changes nothing. stdout hands over
 * one line per read and ends after the last line: the CLI has exited by then,
 * and `state.ended` is set.
 */
function cancellableRun(lines: unknown[], cancelSignal: AbortSignal) {
  const state = { ended: false };
  let settle!: () => void;
  const outcome = new Promise<unknown>((resolve, reject) => {
    settle = () => {
      state.ended = true;
      if (cancelSignal.aborted) reject(execaError({ exitCode: 0, isCanceled: true }));
      else resolve({ failed: false, exitCode: 0, stdout: '', stderr: '' });
    };
  });
  outcome.catch(() => undefined);
  return Object.assign(outcome, {
    stdout: (async function* () {
      for (const line of lines) yield Buffer.from(`${JSON.stringify(line)}\n`);
      settle();
    })(),
    kill: vi.fn(),
    state,
  });
}

describe.each(STREAM_PROVIDERS)(
  '$name: a caller who aborts while the consumer still takes the events of a run that has ended',
  ({ binary, model, create, fixture }) => {
    it("ends with the abort chunk the abortSignal contract asks for (error.type 'abort'), not the tool call", async () => {
      let run!: ReturnType<typeof cancellableRun>;
      // A piece of text, then a reply that calls get_weather; the CLI then exits 0.
      stubCli(binary, (_args, options) => {
        run = cancellableRun([fixture.hello[0], ...fixture.toolCall], options.cancelSignal);
        return run;
      });
      const provider = create();
      await provider.initialize({});
      const controller = new AbortController();
      const chunks: ModelCompletionResponse[] = [];
      let endedBeforeAbort: boolean | undefined;
      for await (const chunk of provider.generateCompletionStream(model, HELLO, {
        tools: [WEATHER_TOOL],
        abortSignal: controller.signal,
      })) {
        chunks.push(chunk);
        if (!chunk.isFinal && !controller.signal.aborted) {
          // The consumer takes its time over the first chunk, and the caller aborts meanwhile.
          await new Promise((resolve) => setTimeout(resolve, 50));
          endedBeforeAbort = run.state.ended;
          controller.abort();
        }
      }
      const final = chunks[chunks.length - 1];

      // The CLI had written its reply and exited before the caller aborted: the case under test was reached.
      expect(endedBeforeAbort).toBe(true);
      expect(final).toMatchObject({ isFinal: true, error: { type: 'abort', code: 'REQUEST_ABORTED' } });
      expect(final.choices).toEqual([]);
    });
  },
);

/**
 * The session id of a Gemini CLI stream, which a direct reader of the bridge
 * gets on the result event. The current CLI writes the id on the init event
 * that opens the stream (InitEvent in packages/core/src/output/types.ts at
 * 9b6e0265, written by packages/cli/src/nonInteractiveCli.ts), and its
 * result event has no such field (ResultEvent).
 */
describe('GeminiCLIBridge: the session id of a stream', () => {
  const at = '2026-10-10T12:00:00.000Z';

  it.each<{ name: string; lines: unknown[] }>([
    {
      name: 'written on the init event, when the result carries none',
      lines: [
        { type: 'init', timestamp: at, session_id: 'g1', model: 'gemini-3.5-flash' },
        { type: 'message', timestamp: at, role: 'user', content: 'Hello' },
        { type: 'message', timestamp: at, role: 'assistant', content: 'Hi there', delta: true },
        { type: 'result', timestamp: at, status: 'success' },
      ],
    },
    {
      name: 'written on a result line that carries one',
      lines: [
        { type: 'message', timestamp: at, role: 'assistant', content: 'Hi there', delta: true },
        { type: 'result', timestamp: at, status: 'success', session_id: 'g1' },
      ],
    },
  ])('ends with a result that carries the id $name', async ({ lines }) => {
    stubCli('gemini', () => cliRun(lines, 0));
    const events: StreamEvent[] = [];
    for await (const event of new GeminiCLIBridge().stream({ prompt: 'Hello' })) events.push(event);

    expect(events.map((event) => event.type)).toEqual(['text_delta', 'result']);
    expect(events[1]).toMatchObject({ type: 'result', sessionId: 'g1' });
  });
});

/**
 * Claude Code's JSON result for a turn stopped by an error subtype
 * (SDKResultError in @anthropic-ai/claude-agent-sdk 0.3.296, sdk.d.ts): no
 * result text, and its detail in `errors`, here none. The CLI can exit
 * non-zero after it: the SDK's own reader of a run (Query.readMessages in
 * sdk.mjs) replaces the process's exit error with the error result's text
 * ("Replacing exit error with result text") unless the run was aborted.
 */
describe('ClaudeCodeProvider: a non-streaming call whose result Claude Code flags as an error', () => {
  const line = { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 2, errors: [], session_id: 's1' };

  it.each([0, 1])('reports the error subtype and its errors (exit code %i)', async (exitCode) => {
    // execa strips the final newline of stdout (stripFinalNewline).
    const stdout = JSON.stringify(line);
    stubCli('claude', () =>
      exitCode === 0
        ? Promise.resolve({ failed: false, exitCode: 0, stdout, stderr: '' })
        : Promise.reject(execaError({ exitCode, stdout })),
    );
    const provider = new ClaudeCodeProvider();
    await provider.initialize({});

    await expect(provider.generateCompletion('claude-sonnet-4-6', HELLO, {})).rejects.toMatchObject({
      code: 'CRASHED',
      message: 'Claude Code returned an error: error_max_turns',
    });
  });
});

/**
 * With --json-schema, which ClaudeCodeProvider passes when tools are present,
 * Claude Code returns the reply that matches the schema in the result's
 * structured_output (SDKResultSuccess in @anthropic-ai/claude-agent-sdk
 * 0.3.296, sdk.d.ts; the SDK hands its own json_schema output format to the
 * CLI as --json-schema, sdk.mjs). Such a turn ends with no trailing assistant
 * message (the note on end-turn tool sessions in sdk.d.ts), and the SDK does
 * not say what the CLI writes in `result` then; here it is empty.
 *
 * streamText() and the StreamingReconstructor build a reply's text from the
 * chunks' responseTextDelta alone (the step loop of src/api/streamText.ts,
 * applyChunk in src/core/llm/streaming/StreamingReconstructor.ts), so a text
 * reply reaches them only through a text delta. Whether Claude Code writes
 * text deltas of its own before the reply in such a run (text the model
 * writes before it, or whitespace) the SDK's types do not say; the cases
 * below hold the provider to a reply that reaches the consumer once either way.
 */
describe('ClaudeCodeProvider: a reply Claude Code returns as structured output', () => {
  const cases = [
    {
      name: 'a tool call',
      structured: {
        response_type: 'tool_calls',
        tool_calls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } }],
      },
      expected: {
        finishReason: 'tool_calls',
        message: {
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Paris' }) } },
          ],
        },
      },
      deltas: [],
    },
    {
      name: 'a text reply',
      structured: { response_type: 'text', text: 'It is sunny in Paris.' },
      expected: { finishReason: 'stop', message: { content: 'It is sunny in Paris.' } },
      deltas: ['It is sunny in Paris.'],
    },
  ];
  const resultLine = (structured: object) => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    structured_output: structured,
    session_id: 's1',
    usage: { input_tokens: 12, output_tokens: 3 },
  });

  it.each(cases)('generateCompletion() returns $name from one run with the schema', async ({ structured, expected }) => {
    const runs: string[][] = [];
    stubCli('claude', (args) => {
      runs.push(args);
      return Promise.resolve({ failed: false, exitCode: 0, stdout: JSON.stringify(resultLine(structured)), stderr: '' });
    });
    const provider = new ClaudeCodeProvider();
    await provider.initialize({});

    const response = await provider.generateCompletion('claude-sonnet-4-6', HELLO, { tools: [WEATHER_TOOL] });

    expect(response.choices[0]).toMatchObject(expected);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain('--json-schema');
  });

  it.each(cases)('generateCompletionStream() ends with $name', async ({ structured, expected, deltas }) => {
    const runs: string[][] = [];
    stubCli('claude', (args) => {
      runs.push(args);
      return cliRun([resultLine(structured)], 0);
    });
    const provider = new ClaudeCodeProvider();
    await provider.initialize({});
    const chunks: ModelCompletionResponse[] = [];
    for await (const chunk of provider.generateCompletionStream('claude-sonnet-4-6', HELLO, { tools: [WEATHER_TOOL] })) {
      chunks.push(chunk);
    }
    const final = chunks[chunks.length - 1];

    expect(final.error).toBeUndefined();
    expect(final.choices[0]).toMatchObject(expected);
    // A text reply goes out as one text delta before the final chunk; a tool call with none.
    expect(chunks.filter((chunk) => !chunk.isFinal).map((chunk) => chunk.responseTextDelta)).toEqual(deltas);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain('--json-schema');
  });

  const textReply = { response_type: 'text', text: 'It is sunny in Paris.' };
  /** A text delta as Claude Code writes it with --include-partial-messages. */
  const textDelta = (text: string) => ({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    parent_tool_use_id: null,
    session_id: 's1',
  });

  /**
   * streamText() with get_weather on the claude-code-cli provider, over a CLI
   * that writes `lines` and exits 0: the stream's parts, its text, and the
   * arguments of each run of the CLI.
   */
  async function streamTextWithTool(lines: unknown[]) {
    const runs: string[][] = [];
    stubCli('claude', (args) => {
      runs.push(args);
      return cliRun(lines, 0);
    });
    const result = streamText({
      provider: 'claude-code-cli',
      model: 'claude-sonnet-4-6',
      prompt: 'What is the weather in Paris?',
      tools: STREAM_TEXT_TOOLS,
    });
    const parts: StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part);
    return { runs, parts, text: await result.text };
  }

  it.each([
    { name: 'that came only in structured_output', lines: [resultLine(textReply)], texts: [textReply.text] },
    {
      // The reply's text streamed as deltas, and the same reply in structured_output.
      name: 'that the CLI also wrote as text deltas, once',
      lines: [textDelta(textReply.text), resultLine(textReply)],
      texts: [textReply.text],
    },
    {
      // No one delta is the reply, and together they hold it.
      name: 'that the CLI also wrote in two text deltas, once',
      lines: [textDelta('It is sunny '), textDelta('in Paris.'), resultLine(textReply)],
      texts: ['It is sunny ', 'in Paris.'],
    },
    {
      name: 'that the CLI also wrote as text deltas after other text, once',
      lines: [textDelta('Let me check the weather. '), textDelta(textReply.text), resultLine(textReply)],
      texts: ['Let me check the weather. ', textReply.text],
    },
    {
      // Text deltas that are not the reply, which came only in structured_output.
      name: 'after a text delta of whitespace',
      lines: [textDelta('\n\n'), resultLine(textReply)],
      texts: ['\n\n', textReply.text],
    },
    {
      name: 'after a text delta the model wrote before it',
      lines: [textDelta('Let me check the weather. '), resultLine(textReply)],
      texts: ['Let me check the weather. ', textReply.text],
    },
  ])('streamText() with tools resolves a text reply $name', async ({ lines, texts }) => {
    const { runs, parts, text } = await streamTextWithTool(lines);

    // streamText() ran the CLI once, with the schema: the case under test was reached.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain('--json-schema');
    expect(textPartsOf(parts)).toEqual(texts);
    expect(text).toBe(texts.join(''));
  });

  it('streamText() with tools passes on a tool call in structured_output after a text delta, with no text of its own', async () => {
    const { runs, parts, text } = await streamTextWithTool([
      textDelta('Let me check the weather. '),
      // The first case's reply: get_weather for Paris.
      resultLine(cases[0].structured),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain('--json-schema');
    expect(textPartsOf(parts)).toEqual(['Let me check the weather. ']);
    expect(parts.filter((part) => part.type === 'tool-call')).toEqual([
      { type: 'tool-call', toolName: 'get_weather', args: { city: 'Paris' } },
    ]);
    expect(text).toBe('Let me check the weather. ');
  });

  it("ends with the abort chunk (error.type 'abort') when the caller aborts while the consumer holds the reply's text delta", async () => {
    let run!: ReturnType<typeof cancellableRun>;
    stubCli('claude', (_args, options) => {
      run = cancellableRun([resultLine(textReply)], options.cancelSignal);
      return run;
    });
    const provider = new ClaudeCodeProvider();
    await provider.initialize({});
    const controller = new AbortController();
    const chunks: ModelCompletionResponse[] = [];
    let endedBeforeAbort: boolean | undefined;
    for await (const chunk of provider.generateCompletionStream('claude-sonnet-4-6', HELLO, {
      tools: [WEATHER_TOOL],
      abortSignal: controller.signal,
    })) {
      chunks.push(chunk);
      if (chunk.responseTextDelta && !controller.signal.aborted) {
        endedBeforeAbort = run.state.ended;
        controller.abort();
      }
    }
    const final = chunks[chunks.length - 1];

    // The CLI had exited 0 and the reply's delta had gone out before the abort: the case under test was reached.
    expect(endedBeforeAbort).toBe(true);
    expect(chunks.filter((chunk) => !chunk.isFinal).map((chunk) => chunk.responseTextDelta)).toEqual([textReply.text]);
    expect(final).toMatchObject({ isFinal: true, error: { type: 'abort', code: 'REQUEST_ABORTED' } });
    expect(final.choices).toEqual([]);
  });
});
