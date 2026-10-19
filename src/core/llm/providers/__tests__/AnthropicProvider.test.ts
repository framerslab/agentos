/**
 * @fileoverview Unit tests for AnthropicProvider.
 *
 * Validates the key structural differences between Anthropic's Messages API
 * and the OpenAI-style IProvider contract:
 * - System message extraction to top-level `system` field
 * - Tool definition conversion (`parameters` → `input_schema`)
 * - Stop reason mapping (`end_turn` → `stop`, `tool_use` → `tool_calls`)
 * - max_tokens enforcement (always present in payload)
 * - Non-streaming response mapping
 * - Streaming SSE event parsing
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock fetch globally so no real HTTP requests are made
// ---------------------------------------------------------------------------
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  AnthropicProvider,
  modelSupportsForcedToolChoice,
} from '../implementations/AnthropicProvider';
import type { ChatMessage } from '../IProvider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a minimal successful Anthropic Messages API response. */
function makeAnthropicResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_test_123',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello from Anthropic!' }],
    model: 'claude-sonnet-4-20250514',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

/** Creates a mock fetch Response with JSON body. */
function mockJsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    json: () => Promise.resolve(data),
    body: null,
  } as unknown as Response;
}

/** Creates a mock ReadableStream from SSE event strings. */
function createSseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // Each SSE event is separated by double newline
  const fullPayload = events.join('\n\n') + '\n\n';
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(fullPayload));
      controller.close();
    },
  });
}

/** `data:` line for one SSE event object. */
const d = (o: unknown) => `data: ${JSON.stringify(o)}`;

/**
 * Canonical SSE event sequence for a raw Messages response — the streamed
 * equivalent of `makeAnthropicResponse()`, since generateCompletion rides
 * the SSE transport by default.
 */
function sseEventsFromMessage(msg: ReturnType<typeof makeAnthropicResponse>): string[] {
  const events: string[] = [
    d({
      type: 'message_start',
      message: { ...msg, content: [], stop_reason: null },
    }),
  ];
  const content = msg.content as Array<Record<string, unknown>>;
  content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(d({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }));
      events.push(d({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }));
    } else if (block.type === 'tool_use') {
      events.push(d({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name },
      }));
      events.push(d({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
      }));
    } else if (block.type === 'thinking') {
      events.push(d({
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }));
      events.push(d({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } }));
      events.push(d({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } }));
    } else if (block.type === 'redacted_thinking') {
      events.push(d({
        type: 'content_block_start',
        index,
        content_block: { type: 'redacted_thinking', data: block.data },
      }));
    }
    events.push(d({ type: 'content_block_stop', index }));
  });
  const usage = msg.usage as { output_tokens: number };
  events.push(d({
    type: 'message_delta',
    delta: { stop_reason: msg.stop_reason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  }));
  events.push(d({ type: 'message_stop' }));
  return events;
}

/** Mock fetch Response whose body is a completed SSE stream of `msg`. */
function mockSseResponse(msg: ReturnType<typeof makeAnthropicResponse>): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: () => Promise.reject(new Error('SSE body, not JSON')),
    body: createSseStream(sseEventsFromMessage(msg)),
  } as unknown as Response;
}

/** Mock Response that emits `events` then stalls forever (never closes). */
function stallingSseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (events.length) controller.enqueue(encoder.encode(events.join('\n\n') + '\n\n'));
      // Deliberately never close — simulates a hung upstream connection.
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: () => Promise.reject(new Error('SSE body, not JSON')),
    body,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'test-anthropic-key' });
  });

  // -------------------------------------------------------------------------
  // Per-call request-timeout override
  // -------------------------------------------------------------------------

  describe('per-call requestTimeout override', () => {
    it('aborts at the per-call requestTimeout instead of the 90s default', async () => {
      // maxRetries:1 isolates the timeout-abort assertion from the default (3)
      // retry loop — a hung fetch otherwise retries 3× and outlasts this window.
      const tp = new AnthropicProvider();
      await tp.initialize({ apiKey: 'test-anthropic-key', maxRetries: 1 });
      vi.useFakeTimers();
      try {
        // fetch never settles — only a timeout can end the call.
        fetchMock.mockReturnValue(new Promise<Response>(() => {}));

        const p = tp.generateCompletion(
          'claude-sonnet-4-20250514',
          [{ role: 'user', content: 'Hi' }],
          { requestTimeout: 1000 },
        );
        let settled: 'pending' | 'resolved' | 'rejected' = 'pending';
        void p.then(
          () => { settled = 'resolved'; },
          () => { settled = 'rejected'; },
        );

        // Advance past the per-call 1000ms (+500ms hard-timeout buffer) but
        // well short of the 90s provider default. With the override honored
        // the call rejects; ignoring it leaves the call on the 90s timer.
        await vi.advanceTimersByTimeAsync(1600);

        expect(settled).toBe('rejected');
      } finally {
        vi.useRealTimers();
      }
    });

    it('aborts when the response BODY stalls after headers arrive (not just the connection)', async () => {
      // maxRetries:1 keeps this a single deterministic body-read timeout — with
      // the default 3 the stall retries 3× and the jittered backoffs could push
      // final rejection past the advance window (flaky).
      const tp = new AnthropicProvider();
      await tp.initialize({ apiKey: 'test-anthropic-key', maxRetries: 1 });
      vi.useFakeTimers();
      try {
        // fetch() resolves (headers arrive) but response.json() — the body
        // read — never settles. This is the non-streaming sibling of an SSE
        // stall: the fetch race only covers headers, so without bounding the
        // body read the call hangs forever (the 28-min codegen tool wedge).
        fetchMock.mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => new Promise<never>(() => {}),
        } as unknown as Response);

        const p = tp.generateCompletion(
          'claude-sonnet-4-20250514',
          [{ role: 'user', content: 'Hi' }],
          { requestTimeout: 1000 },
        );
        let settled: 'pending' | 'resolved' | 'rejected' = 'pending';
        let err: unknown;
        void p.then(
          () => { settled = 'resolved'; },
          (e) => { settled = 'rejected'; err = e; },
        );

        // Past the 1000ms body-read bound (× a couple of retries): pre-fix the
        // body read is unbounded and this stays pending forever.
        await vi.advanceTimersByTimeAsync(6000);

        expect(settled).toBe('rejected');
        expect(String((err as Error)?.message)).toMatch(/body|stalled|timed out/i);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // The caller's abort signal
  // -------------------------------------------------------------------------

  describe("the caller's abort signal", () => {
    /** Sends one completion whose fetch waits for its signal, aborts it, and checks the request ended once. */
    async function expectAbortedOnce(p: AnthropicProvider): Promise<void> {
      let sent: AbortSignal | undefined;
      fetchMock.mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            sent = init?.signal ?? undefined;
            sent?.addEventListener('abort', () => reject(sent?.reason), { once: true });
          }),
      );
      const controller = new AbortController();
      const call = p.generateCompletion('claude-sonnet-4-20250514', [{ role: 'user', content: 'Hi' }], {
        abortSignal: controller.signal,
      });
      await vi.waitFor(() => expect(sent).toBeDefined());
      expect(sent?.aborted).toBe(false);
      controller.abort();
      expect(sent?.aborted).toBe(true);
      await expect(call).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
      // Three attempts are allowed, and an abort is not retried.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }

    it('aborts a completion on the streamed transport (the default) and sends no retry', async () => {
      const p = new AnthropicProvider();
      await p.initialize({ apiKey: 'test-anthropic-key', maxRetries: 3 });
      await expectAbortedOnce(p);
    });

    it('aborts a completion on the single-shot transport and sends no retry', async () => {
      const p = new AnthropicProvider();
      await p.initialize({ apiKey: 'test-anthropic-key', maxRetries: 3, streamCompletions: false });
      await expectAbortedOnce(p);
    });
  });

  // -------------------------------------------------------------------------
  // Stream-idle timeout (mid-stream stall)
  // -------------------------------------------------------------------------

  describe('stream-idle timeout', () => {
    it('aborts a stalled stream with STREAM_IDLE_TIMEOUT instead of hanging on reader.read()', async () => {
      vi.useFakeTimers();
      try {
        const encoder = new TextEncoder();
        // Emits the opening event, then stalls forever: never enqueues another
        // chunk and never closes. Pre-fix, parseSseStream's reader.read() would
        // await this second chunk indefinitely (until the caller's outer
        // timeout). The idle watchdog must bound it.
        const stalled = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":1}}}\n\n',
              ),
            );
          },
          // After the queued chunk drains, the consumer's next read pulls — and
          // this never resolves and never closes → a genuine mid-stream stall.
          pull() {
            return new Promise<void>(() => {});
          },
        });
        fetchMock.mockResolvedValue({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          body: stalled,
        } as unknown as Response);

        const p = new AnthropicProvider();
        await p.initialize({ apiKey: 'test-key', streamIdleTimeoutMs: 1000 });

        let settled: 'pending' | 'resolved' | 'rejected' = 'pending';
        const chunks: Array<{ error?: { message?: string } }> = [];
        const consume = (async () => {
          for await (const chunk of p.generateCompletionStream(
            'claude-sonnet-4-20250514',
            [{ role: 'user', content: 'Hi' }],
            {},
          )) {
            chunks.push(chunk as { error?: { message?: string } });
          }
        })().then(
          () => {
            settled = 'resolved';
          },
          () => {
            settled = 'rejected';
          },
        );

        // Past the 1000ms idle bound: the stalled read loses the race, the
        // watchdog aborts, and the generator SETTLES (bounded) instead of
        // hanging forever — pre-fix this never settles within 1300ms.
        await vi.advanceTimersByTimeAsync(1300);
        await consume;

        expect(settled).not.toBe('pending');
        // The stall surfaces as a terminal STREAM_PROCESSING_ERROR chunk whose
        // message names the idle watchdog (not a silent truncation).
        const errChunk = chunks.find((c) => c?.error);
        expect(errChunk?.error?.message).toMatch(/idle|stalled/i);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  describe('initialization', () => {
    it('throws when API key is missing', async () => {
      const p = new AnthropicProvider();
      await expect(p.initialize({ apiKey: '' })).rejects.toThrow('API key is required');
    });

    it('sets providerId to "anthropic"', () => {
      expect(provider.providerId).toBe('anthropic');
    });

    it('marks provider as initialized after successful init', () => {
      expect(provider.isInitialized).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // System message extraction
  // -------------------------------------------------------------------------

  describe('system message handling', () => {
    it('extracts system messages to top-level system field (not a message role)', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hi' },
      ];

      await provider.generateCompletion('claude-sonnet-4-20250514', messages, {});

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);

      // System should be a top-level string, NOT a message with role "system"
      expect(requestBody.system).toBe('You are a helpful assistant.');

      // Messages array should NOT contain system role
      const roles = requestBody.messages.map((m: any) => m.role);
      expect(roles).not.toContain('system');
      expect(roles).toEqual(['user']);
    });

    it('concatenates multiple system messages with double newlines', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      const messages: ChatMessage[] = [
        { role: 'system', content: 'Rule 1: Be helpful.' },
        { role: 'system', content: 'Rule 2: Be concise.' },
        { role: 'user', content: 'Hello' },
      ];

      await provider.generateCompletion('claude-sonnet-4-20250514', messages, {});

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.system).toBe('Rule 1: Be helpful.\n\nRule 2: Be concise.');
    });

    it('omits system field when no system messages are present', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' },
      ];

      await provider.generateCompletion('claude-sonnet-4-20250514', messages, {});

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.system).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Extended thinking (reasoning budget)
  // -------------------------------------------------------------------------

  describe('extended thinking', () => {
    it('sends adaptive thinking, keeps max_tokens, and drops top_p/temperature for opus-4-8', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      await provider.generateCompletion(
        'claude-opus-4-8',
        [{ role: 'user', content: 'Hi' }],
        { thinking: { budgetTokens: 8000 }, maxTokens: 4000, topP: 0.9 },
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Opus 4.7/4.8 reject {type:'enabled', budget_tokens} — adaptive is the
      // only on-mode, and there is no budget for max_tokens to clear.
      expect(requestBody.thinking).toEqual({ type: 'adaptive' });
      expect(requestBody.max_tokens).toBe(4000);
      // Sampling controls are rejected alongside on this family — both dropped.
      expect(requestBody.top_p).toBeUndefined();
      expect(requestBody.temperature).toBeUndefined();
    });

    it('drops top_p and temperature for fable-5 even without a thinking budget', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      await provider.generateCompletion(
        'claude-fable-5',
        [{ role: 'user', content: 'Hi' }],
        { temperature: 0.7, topP: 0.9, maxTokens: 4000 },
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Fable 5 rejects sampling controls (HTTP 400) just like Opus 4.7/4.8 —
      // and unlike the thinking path, this drop must hold with no budget set.
      expect(requestBody.temperature).toBeUndefined();
      expect(requestBody.top_p).toBeUndefined();
    });

    it('sends adaptive thinking for fable-5 when a budget is passed', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      await provider.generateCompletion(
        'claude-fable-5',
        [{ role: 'user', content: 'Hi' }],
        { thinking: { budgetTokens: 8000 }, maxTokens: 4000 },
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.thinking).toEqual({ type: 'adaptive' });
    });

    it('omits the thinking block for a non-reasoning model even when a budget is passed', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      await provider.generateCompletion(
        'claude-sonnet-4-6',
        [{ role: 'user', content: 'Hi' }],
        { thinking: { budgetTokens: 8000 } },
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.thinking).toBeUndefined();
    });

    it('omits the thinking block when no budget is requested', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      await provider.generateCompletion(
        'claude-opus-4-8',
        [{ role: 'user', content: 'Hi' }],
        {},
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.thinking).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Thinking + forced tool_choice — Anthropic rejects the combination, so the
  // provider clamps a forced choice to 'auto' (the supported way to interleave
  // thinking with tool use) instead of letting the request 400.
  // -------------------------------------------------------------------------

  describe('thinking + forced tool_choice', () => {
    const aTool = {
      name: 'doThing',
      description: 'Do a thing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    };

    it("clamps a forced tool_choice ('required' → any) to 'auto' when thinking is enabled", async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      await provider.generateCompletion(
        'claude-opus-4-8',
        [{ role: 'user', content: 'build it' }],
        { thinking: { budgetTokens: 8000 }, toolChoice: 'required', tools: [aTool], maxTokens: 16000 },
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.thinking).toBeDefined();
      expect(requestBody.tool_choice).toEqual({ type: 'auto' });
    });

    it("leaves a forced tool_choice as 'any' when thinking is NOT enabled", async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      await provider.generateCompletion(
        'claude-opus-4-8',
        [{ role: 'user', content: 'build it' }],
        { toolChoice: 'required', tools: [aTool] },
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.thinking).toBeUndefined();
      expect(requestBody.tool_choice).toEqual({ type: 'any' });
    });

    it("leaves tool_choice 'auto' untouched when thinking is enabled", async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      await provider.generateCompletion(
        'claude-opus-4-8',
        [{ role: 'user', content: 'build it' }],
        { thinking: { budgetTokens: 8000 }, toolChoice: 'auto', tools: [aTool], maxTokens: 16000 },
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.thinking).toBeDefined();
      expect(requestBody.tool_choice).toEqual({ type: 'auto' });
    });
  });

  // Fable rejects a forced tool_choice at the API level ("tool_choice forces
  // tool use is not compatible with this model") — even with thinking off. The
  // provider clamps any forced choice to 'auto' for Fable so no caller has to
  // remember the quirk, mirroring the thinking-clamp above.
  describe('forced tool_choice on a model that rejects it (Fable)', () => {
    const aTool = {
      name: 'doThing',
      description: 'Do a thing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    };

    it('modelSupportsForcedToolChoice is false for Fable, true for Sonnet/Opus', () => {
      expect(modelSupportsForcedToolChoice('claude-fable-5')).toBe(false);
      expect(modelSupportsForcedToolChoice('claude-fable-5-20260601')).toBe(false);
      expect(modelSupportsForcedToolChoice('claude-sonnet-4-6')).toBe(true);
      expect(modelSupportsForcedToolChoice('claude-opus-4-8')).toBe(true);
    });

    it("clamps a forced tool_choice ('required') to 'auto' for Fable even without thinking", async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      await provider.generateCompletion(
        'claude-fable-5',
        [{ role: 'user', content: 'build it' }],
        { toolChoice: 'required', tools: [aTool], maxTokens: 16000 },
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.thinking).toBeUndefined();
      expect(requestBody.tool_choice).toEqual({ type: 'auto' });
    });

    it("leaves a forced tool_choice as 'any' for Sonnet (non-Fable unaffected)", async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      await provider.generateCompletion(
        'claude-sonnet-4-6',
        [{ role: 'user', content: 'build it' }],
        { toolChoice: 'required', tools: [aTool] },
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.tool_choice).toEqual({ type: 'any' });
    });
  });

  // -------------------------------------------------------------------------
  // Thinking-block capture (B1) — round-trip substrate for the agent loop
  // -------------------------------------------------------------------------

  describe('thinking-block capture', () => {
    it('captures thinking blocks (with signature) onto the assistant message', async () => {
      fetchMock.mockResolvedValueOnce(
        mockSseResponse(
          makeAnthropicResponse({
            content: [
              { type: 'thinking', thinking: 'Let me reason about this.', signature: 'sig-abc123' },
              { type: 'text', text: 'The answer is 42.' },
            ],
          }),
        ),
      );

      const res = await provider.generateCompletion(
        'claude-opus-4-8',
        [{ role: 'user', content: 'Hi' }],
        {},
      );

      const msg = res.choices[0].message;
      // The signature MUST survive verbatim — it's replayed on the next turn.
      expect(msg.thinkingBlocks).toEqual([
        { type: 'thinking', thinking: 'Let me reason about this.', signature: 'sig-abc123' },
      ]);
      expect(msg.content).toBe('The answer is 42.');
    });

    it('omits thinkingBlocks when the response has none (non-thinking path unchanged)', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));
      const res = await provider.generateCompletion(
        'claude-sonnet-4-6',
        [{ role: 'user', content: 'Hi' }],
        {},
      );
      expect(res.choices[0].message.thinkingBlocks).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Thinking-block replay (B2) — round-trip back into the tool loop
  // -------------------------------------------------------------------------

  describe('thinking-block replay', () => {
    it('replays thinking blocks FIRST in the assistant turn, before text + tool_use', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      await provider.generateCompletion(
        'claude-opus-4-8',
        [
          { role: 'user', content: 'Solve it' },
          {
            role: 'assistant',
            content: 'Working on it',
            thinkingBlocks: [{ type: 'thinking', thinking: 'step 1', signature: 'sig-1' }],
            tool_calls: [
              { id: 'tc1', type: 'function', function: { name: 'calc', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'tc1', content: '42' },
        ],
        {},
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      const assistantMsg = requestBody.messages.find((m: any) => m.role === 'assistant');
      // Anthropic requires thinking → text → tool_use ordering, verbatim.
      expect(assistantMsg.content[0]).toEqual({
        type: 'thinking',
        thinking: 'step 1',
        signature: 'sig-1',
      });
      expect(assistantMsg.content.map((b: any) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    });

    it('sets the interleaved-thinking beta header when replaying thinking blocks', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));
      await provider.generateCompletion(
        'claude-opus-4-8',
        [
          {
            role: 'assistant',
            content: null,
            thinkingBlocks: [{ type: 'thinking', thinking: 't', signature: 's' }],
            tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'tc1', content: 'r' },
        ],
        {},
      );
      expect(fetchMock.mock.calls[0][1].headers['anthropic-beta']).toBe(
        'interleaved-thinking-2025-05-14',
      );
    });

    it('sets the beta header when extended thinking is enabled outbound', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));
      await provider.generateCompletion(
        'claude-opus-4-8',
        [{ role: 'user', content: 'Hi' }],
        { thinking: { budgetTokens: 4000 } },
      );
      expect(fetchMock.mock.calls[0][1].headers['anthropic-beta']).toBe(
        'interleaved-thinking-2025-05-14',
      );
    });

    it('omits the beta header when no thinking is in play', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));
      await provider.generateCompletion('claude-sonnet-4-6', [{ role: 'user', content: 'Hi' }], {});
      expect(fetchMock.mock.calls[0][1].headers['anthropic-beta']).toBeUndefined();
    });

    it('strips prior thinking on non-retaining models, replaying only the last turn (bounded payload)', async () => {
      // Haiku models never retain prior thinking server-side, so the client
      // strip is cache-neutral there and keeps the wire bounded.
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));
      await provider.generateCompletion(
        'claude-haiku-4-5-20251001',
        [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: null,
            thinkingBlocks: [{ type: 'thinking', thinking: 'first', signature: 's1' }],
            tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 't1', content: 'r1' },
          {
            role: 'assistant',
            content: null,
            thinkingBlocks: [{ type: 'thinking', thinking: 'second', signature: 's2' }],
            tool_calls: [{ id: 't2', type: 'function', function: { name: 'f', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 't2', content: 'r2' },
        ],
        {},
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const assistantMsgs = body.messages.filter((m: any) => m.role === 'assistant');
      // Earlier assistant turn: thinking stripped (Anthropic ignores it; keeps the wire bounded
      // so large thinking blocks don't accumulate across a long tool loop).
      expect(assistantMsgs[0].content.some((b: any) => b.type === 'thinking')).toBe(false);
      // Most-recent assistant turn: thinking preserved (Anthropic requires it for continuation).
      expect(assistantMsgs[1].content[0]).toEqual({ type: 'thinking', thinking: 'second', signature: 's2' });
    });

    it('replays prior thinking verbatim on retaining models (cache byte-stability)', async () => {
      // Retaining models keep prior thinking in server context and cache it;
      // a client-side strip would mutate the prior turn's bytes every step
      // and invalidate the whole cached prefix (measured prod 2026-07-06).
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));
      await provider.generateCompletion(
        'claude-opus-4-8',
        [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: null,
            thinkingBlocks: [{ type: 'thinking', thinking: 'first', signature: 's1' }],
            tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 't1', content: 'r1' },
          {
            role: 'assistant',
            content: null,
            thinkingBlocks: [{ type: 'thinking', thinking: 'second', signature: 's2' }],
            tool_calls: [{ id: 't2', type: 'function', function: { name: 'f', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 't2', content: 'r2' },
        ],
        {},
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const assistantMsgs = body.messages.filter((m: any) => m.role === 'assistant');
      expect(assistantMsgs[0].content[0]).toEqual({ type: 'thinking', thinking: 'first', signature: 's1' });
      expect(assistantMsgs[1].content[0]).toEqual({ type: 'thinking', thinking: 'second', signature: 's2' });
    });
  });

  // -------------------------------------------------------------------------
  // max_tokens enforcement
  // -------------------------------------------------------------------------

  describe('max_tokens enforcement', () => {
    it('always includes max_tokens in the request payload (defaults to the model output ceiling)', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      // Do NOT pass maxTokens in options
      await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Hi' },
      ], {});

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      // max_tokens MUST be present — Anthropic rejects requests without it.
      // Default is the model's configured output ceiling (16000 for Sonnet).
      expect(requestBody.max_tokens).toBe(16000);
    });

    it('respects caller-provided maxTokens', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Hi' },
      ], { maxTokens: 1024 });

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.max_tokens).toBe(1024);
    });
  });

  // -------------------------------------------------------------------------
  // Temperature deprecation for reasoning-default models (Opus 4.7)
  // -------------------------------------------------------------------------

  describe('temperature handling per model', () => {
    it('includes temperature in the payload for Claude Sonnet / Haiku / Opus <= 4.6', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));
      await provider.generateCompletion(
        'claude-sonnet-4-6',
        [{ role: 'user', content: 'Hi' }],
        { temperature: 0.3 },
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.3);
    });

    it('includes temperature for older Opus (claude-opus-4-6)', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));
      await provider.generateCompletion(
        'claude-opus-4-6',
        [{ role: 'user', content: 'Hi' }],
        { temperature: 0.7 },
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.7);
    });

    it('OMITS temperature for claude-opus-4-7 even when caller passes it', async () => {
      // Opus 4.7 deprecated temperature (reasoning-default). The Anthropic
      // API returns 400 "`temperature` is deprecated for this model" when
      // temperature is present, so the provider must silently drop it.
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));
      await provider.generateCompletion(
        'claude-opus-4-7',
        [{ role: 'user', content: 'Hi' }],
        { temperature: 0.5 },
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.temperature).toBeUndefined();
    });

    it('OMITS temperature for claude-opus-4-7 with provider-qualified id variations', async () => {
      // Guards against a future change that keeps the major/minor but
      // tacks on a date suffix (e.g. claude-opus-4-7-20260501).
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));
      await provider.generateCompletion(
        'claude-opus-4-7-20260501',
        [{ role: 'user', content: 'Hi' }],
        { temperature: 0.5 },
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.temperature).toBeUndefined();
    });

    it('OMITS temperature for claude-sonnet-5 even when caller passes it', async () => {
      // Sonnet 5 joined the reasoning-default family (adaptive thinking on by
      // default, full effort range incl. xhigh). Like Opus 4.7/4.8 it rejects
      // temperature/top_p with HTTP 400, so the provider must drop it. Sonnet
      // 4.6 (above) still KEEPS temperature — the sonnet-5 deny does not leak.
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));
      await provider.generateCompletion(
        'claude-sonnet-5',
        [{ role: 'user', content: 'Hi' }],
        { temperature: 0.5, topP: 0.9 },
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.temperature).toBeUndefined();
      expect(body.top_p).toBeUndefined();
    });

    it('passes temperature unchanged when model is not a reasoning-default family', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));
      await provider.generateCompletion(
        'claude-haiku-4-5-20251001',
        [{ role: 'user', content: 'Hi' }],
        { temperature: 0 },
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.temperature).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Tool calling format conversion
  // -------------------------------------------------------------------------

  describe('tool calling format', () => {
    it('converts OpenAI-style tool defs to Anthropic input_schema format', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse({
        content: [{
          type: 'tool_use',
          id: 'toolu_123',
          name: 'get_weather',
          input: { location: 'San Francisco' },
        }],
        stop_reason: 'tool_use',
      })));

      const tools = [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather',
          // OpenAI uses "parameters", Anthropic uses "input_schema"
          parameters: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          },
        },
      }];

      await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Weather in SF?' },
      ], { tools });

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);

      // Verify tool was converted to Anthropic format with input_schema
      expect(requestBody.tools).toHaveLength(1);
      expect(requestBody.tools[0]).toEqual({
        name: 'get_weather',
        description: 'Get current weather',
        input_schema: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
        },
      });
    });

    it('maps tool_use response blocks to OpenAI-style tool_calls', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse({
        content: [
          { type: 'text', text: 'Let me check the weather.' },
          {
            type: 'tool_use',
            id: 'toolu_abc',
            name: 'get_weather',
            input: { location: 'NYC', unit: 'celsius' },
          },
        ],
        stop_reason: 'tool_use',
      })));

      const result = await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Weather in NYC?' },
      ], {});

      // Verify tool_calls are in OpenAI format
      const choice = result.choices[0];
      expect(choice.message.tool_calls).toHaveLength(1);
      expect(choice.message.tool_calls![0]).toEqual({
        id: 'toolu_abc',
        type: 'function',
        function: {
          name: 'get_weather',
          // Arguments should be a JSON STRING (OpenAI convention)
          arguments: '{"location":"NYC","unit":"celsius"}',
        },
      });
      expect(choice.finishReason).toBe('tool_calls');
    });
  });

  // -------------------------------------------------------------------------
  // Stop reason mapping
  // -------------------------------------------------------------------------

  describe('stop reason mapping', () => {
    it('maps end_turn to "stop"', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse({
        stop_reason: 'end_turn',
      })));

      const result = await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Hi' },
      ], {});

      expect(result.choices[0].finishReason).toBe('stop');
    });

    it('maps tool_use to "tool_calls"', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse({
        content: [{ type: 'tool_use', id: 'x', name: 'fn', input: {} }],
        stop_reason: 'tool_use',
      })));

      const result = await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Call a tool' },
      ], {});

      expect(result.choices[0].finishReason).toBe('tool_calls');
    });

    it('maps max_tokens to "length"', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse({
        stop_reason: 'max_tokens',
      })));

      const result = await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Long response' },
      ], {});

      expect(result.choices[0].finishReason).toBe('length');
    });

    it('maps stop_sequence to "stop"', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse({
        stop_reason: 'stop_sequence',
      })));

      const result = await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Hi' },
      ], {});

      expect(result.choices[0].finishReason).toBe('stop');
    });
  });

  // -------------------------------------------------------------------------
  // Streaming SSE parsing
  // -------------------------------------------------------------------------

  describe('streaming SSE parsing', () => {
    it('parses content_block_delta text events into responseTextDelta chunks', async () => {
      const sseEvents = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ];

      const stream = createSseStream(sseEvents);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        body: stream,
      });

      const chunks: any[] = [];
      for await (const chunk of provider.generateCompletionStream(
        'claude-sonnet-4-20250514',
        [{ role: 'user', content: 'Hi' }],
        { maxTokens: 100 },
      )) {
        chunks.push(chunk);
      }

      // Should have text delta chunks + final chunk
      const textDeltas = chunks.filter(c => c.responseTextDelta);
      expect(textDeltas).toHaveLength(2);
      expect(textDeltas[0].responseTextDelta).toBe('Hello');
      expect(textDeltas[1].responseTextDelta).toBe(' world');

      // Final chunk should have isFinal: true and usage
      const finalChunk = chunks.find(c => c.isFinal);
      expect(finalChunk).toBeDefined();
      expect(finalChunk!.choices[0].finishReason).toBe('stop');
      expect(finalChunk!.usage).toBeDefined();
      expect(finalChunk!.usage!.promptTokens).toBe(10);
      expect(finalChunk!.usage!.completionTokens).toBe(5);
    });

    it('accumulates streamed thinking blocks (text + signature) onto the final chunk', async () => {
      const sseEvents = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_think","type":"message","role":"assistant","content":[],"model":"claude-opus-4-8","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":6,"output_tokens":0}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me "}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason."}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-xyz"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Answer"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":9}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ];

      const stream = createSseStream(sseEvents);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        body: stream,
      });

      const chunks: any[] = [];
      for await (const chunk of provider.generateCompletionStream(
        'claude-opus-4-8',
        [{ role: 'user', content: 'Hi' }],
        {},
      )) {
        chunks.push(chunk);
      }

      const finalChunk = chunks.find(c => c.isFinal);
      expect(finalChunk).toBeDefined();
      // Streamed thinking text + signature assembled verbatim onto the message.
      expect(finalChunk!.choices[0].message.thinkingBlocks).toEqual([
        { type: 'thinking', thinking: 'Let me reason.', signature: 'sig-xyz' },
      ]);
      expect(finalChunk!.choices[0].message.content).toBe('Answer');
    });

    it('streams redacted_thinking blocks verbatim (data preserved)', async () => {
      const sseEvents = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_red","type":"message","role":"assistant","content":[],"model":"claude-opus-4-8","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":6,"output_tokens":0}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"ENC-blob-123"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ];
      const stream = createSseStream(sseEvents);
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', headers: new Headers(), body: stream });
      const chunks: any[] = [];
      for await (const chunk of provider.generateCompletionStream('claude-opus-4-8', [{ role: 'user', content: 'Hi' }], {})) {
        chunks.push(chunk);
      }
      const finalChunk = chunks.find(c => c.isFinal);
      expect(finalChunk!.choices[0].message.thinkingBlocks).toEqual([
        { type: 'redacted_thinking', data: 'ENC-blob-123' },
      ]);
    });

    it('parses streaming tool_use events with input_json_delta', async () => {
      const sseEvents = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_t1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":15,"output_tokens":0}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_stream","name":"get_weather"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"loc"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"ation\\":\\"SF\\"}"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":8}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ];

      const stream = createSseStream(sseEvents);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        body: stream,
      });

      const chunks: any[] = [];
      for await (const chunk of provider.generateCompletionStream(
        'claude-sonnet-4-20250514',
        [{ role: 'user', content: 'Weather?' }],
        { maxTokens: 100 },
      )) {
        chunks.push(chunk);
      }

      // Should have tool call delta chunks
      const toolDeltas = chunks.filter(c => c.toolCallsDeltas);
      expect(toolDeltas.length).toBeGreaterThanOrEqual(2);

      // Final chunk should have assembled tool_calls
      const finalChunk = chunks.find(c => c.isFinal);
      expect(finalChunk).toBeDefined();
      expect(finalChunk!.choices[0].finishReason).toBe('tool_calls');
      expect(finalChunk!.choices[0].message.tool_calls).toHaveLength(1);
      expect(finalChunk!.choices[0].message.tool_calls![0].function.name).toBe('get_weather');
    });
  });

  // -------------------------------------------------------------------------
  // Authentication headers
  // -------------------------------------------------------------------------

  describe('authentication headers', () => {
    it('sends x-api-key header (not Authorization Bearer)', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      await provider.generateCompletion('claude-sonnet-4-20250514', [
        { role: 'user', content: 'Hi' },
      ], {});

      const headers = fetchMock.mock.calls[0][1].headers;
      // Anthropic uses x-api-key, NOT Authorization: Bearer
      expect(headers['x-api-key']).toBe('test-anthropic-key');
      expect(headers['anthropic-version']).toBe('2023-06-01');
    });
  });

  // -------------------------------------------------------------------------
  // Embeddings (not supported)
  // -------------------------------------------------------------------------

  describe('embeddings', () => {
    it('throws when embeddings are requested', async () => {
      await expect(
        provider.generateEmbeddings('any-model', ['test']),
      ).rejects.toThrow('does not provide an embeddings API');
    });
  });

  // -------------------------------------------------------------------------
  // Model catalog
  // -------------------------------------------------------------------------

  describe('model catalog', () => {
    it('lists known Anthropic models', async () => {
      const models = await provider.listAvailableModels();
      expect(models.length).toBeGreaterThanOrEqual(3);
      const ids = models.map(m => m.modelId);
      expect(ids).toContain('claude-sonnet-4-20250514');
      expect(ids).toContain('claude-opus-4-20250514');
      expect(ids).toContain('claude-haiku-4-5-20251001');
    });

    it('lists claude-fable-5 with 1M context and $10/$50 pricing', async () => {
      const fable = (await provider.listAvailableModels()).find(
        m => m.modelId === 'claude-fable-5',
      );
      expect(fable).toBeDefined();
      expect(fable!.contextWindowSize).toBe(1000000);
      expect(fable!.outputTokenLimit).toBe(128000);
      expect(fable!.pricePer1MTokensInput).toBe(10);
      expect(fable!.pricePer1MTokensOutput).toBe(50);
      expect(fable!.capabilities).toContain('vision_input');
    });

    it('filters models by capability', async () => {
      const visionModels = await provider.listAvailableModels({ capability: 'vision_input' });
      expect(visionModels.length).toBeGreaterThan(0);
      for (const m of visionModels) {
        expect(m.capabilities).toContain('vision_input');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Tool result message conversion
  // -------------------------------------------------------------------------

  describe('tool result messages', () => {
    it('converts tool-role messages to user/tool_result blocks', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      const messages: ChatMessage[] = [
        { role: 'user', content: 'Weather in SF?' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"SF"}' },
          }],
        },
        {
          role: 'tool',
          content: '{"temp": 65, "condition": "foggy"}',
          tool_call_id: 'call_1',
        },
      ];

      await provider.generateCompletion('claude-sonnet-4-20250514', messages, {});

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      const toolResultMsg = requestBody.messages[2];

      // Tool results should be sent as "user" role with tool_result content block
      // (Anthropic convention — tool results go in user messages)
      expect(toolResultMsg.role).toBe('user');
      expect(toolResultMsg.content[0].type).toBe('tool_result');
      expect(toolResultMsg.content[0].tool_use_id).toBe('call_1');
    });
  });

  // -------------------------------------------------------------------------
  // Multi-key pool rotation + failover
  // -------------------------------------------------------------------------

  describe('multi-key rotation + failover', () => {
    function rateLimitedResponse(): Response {
      return {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({ 'retry-after': '0' }),
        json: () => Promise.resolve({ error: { type: 'rate_limit_error', message: 'slow down' } }),
        body: null,
      } as unknown as Response;
    }

    it('rotates to the next key on a 429 retry instead of hammering the rate-limited key', async () => {
      const p = new AnthropicProvider();
      await p.initialize({ apiKey: 'key1,key2', maxRetries: 3 });

      fetchMock.mockResolvedValueOnce(rateLimitedResponse());
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      await p.generateCompletion(
        'claude-sonnet-4-20250514',
        [{ role: 'user', content: 'Hi' }],
        {},
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstKey = fetchMock.mock.calls[0][1].headers['x-api-key'];
      const secondKey = fetchMock.mock.calls[1][1].headers['x-api-key'];
      expect(firstKey).toBe('key1');
      // The retry must fail over to the OTHER key — the rate-limited key is
      // marked exhausted and skipped, not retried on the same throttled key.
      expect(secondKey).toBe('key2');
    });
  });

  // -------------------------------------------------------------------------
  // Streaming completion transport (default)
  //
  // generateCompletion rides the SSE path so parseSseStream's idle watchdog
  // bounds mid-body stalls. A non-streaming POST cannot distinguish a hung
  // connection from a slow generation, so a caller's generous requestTimeout
  // (codegen passes 25 min) turned each hang into a 25-min silence.
  // -------------------------------------------------------------------------

  describe('streaming completion transport', () => {
    it('streams by default: sends stream:true and maps the final message', async () => {
      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      const result = await provider.generateCompletion(
        'claude-sonnet-4-20250514',
        [{ role: 'user', content: 'Hi' }],
        {},
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.stream).toBe(true);
      expect(result.choices[0].message.content).toBe('Hello from Anthropic!');
      expect(result.choices[0].finishReason).toBe('stop');
      expect(result.usage?.promptTokens).toBe(10);
      expect(result.usage?.completionTokens).toBe(5);
      expect(result.id).toBe('msg_test_123');
    });

    it('assembles tool_use input across input_json_delta fragments', async () => {
      const events = [
        d({ type: 'message_start', message: { ...makeAnthropicResponse(), content: [], stop_reason: null } }),
        d({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'doThing' } }),
        d({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } }),
        d({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '1}' } }),
        d({ type: 'content_block_stop', index: 0 }),
        d({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } }),
        d({ type: 'message_stop' }),
      ];
      fetchMock.mockResolvedValueOnce({
        ok: true, status: 200, statusText: 'OK', headers: new Headers(),
        json: () => Promise.reject(new Error('SSE body, not JSON')),
        body: createSseStream(events),
      } as unknown as Response);

      const result = await provider.generateCompletion(
        'claude-sonnet-4-20250514',
        [{ role: 'user', content: 'Hi' }],
        {},
      );

      expect(result.choices[0].finishReason).toBe('tool_calls');
      const toolCalls = result.choices[0].message.tool_calls!;
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].function.name).toBe('doThing');
      expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ a: 1 });
    });

    it('captures thinking blocks (with signature) on the streamed completion', async () => {
      const msg = makeAnthropicResponse({
        content: [
          { type: 'thinking', thinking: 'Let me reason.', signature: 'sig-xyz' },
          { type: 'text', text: 'Answer.' },
        ],
      });
      fetchMock.mockResolvedValueOnce(mockSseResponse(msg));

      const result = await provider.generateCompletion(
        'claude-opus-4-8',
        [{ role: 'user', content: 'Hi' }],
        { thinking: { budgetTokens: 8000 } },
      );

      expect(result.choices[0].message.content).toBe('Answer.');
      expect(result.choices[0].message.thinkingBlocks).toEqual([
        { type: 'thinking', thinking: 'Let me reason.', signature: 'sig-xyz' },
      ]);
    });

    it('surfaces forced structured-output tool input as JSON text content', async () => {
      const msg = makeAnthropicResponse({
        content: [{ type: 'tool_use', id: 'toolu_s', name: 'emit', input: { x: 2 } }],
        stop_reason: 'tool_use',
      });
      fetchMock.mockResolvedValueOnce(mockSseResponse(msg));

      const result = await provider.generateCompletion(
        'claude-sonnet-4-20250514',
        [{ role: 'user', content: 'Hi' }],
        {
          responseFormat: {
            _agentosUseToolForStructuredOutput: true,
            tool: { name: 'emit' },
          } as never,
        },
      );

      expect(result.choices[0].message.content).toBe('{"x":2}');
    });

    it('sends the JSON output format with the stamped schema, no tool and no tool_choice on claude-opus-4-8', async () => {
      // Every model with Anthropic's structured outputs takes output_config.format
      // (anthropicSchemaRoute 'json_schema'); the forced tool is for the two models
      // without it. The format needs no beta header.
      const msg = makeAnthropicResponse({
        content: [{ type: 'text', text: '{"x":2}' }],
        stop_reason: 'end_turn',
      });
      fetchMock.mockResolvedValueOnce(mockSseResponse(msg));

      const result = await provider.generateCompletion(
        'claude-opus-4-8',
        [{ role: 'user', content: 'Hi' }],
        {
          responseFormat: {
            _agentosUseToolForStructuredOutput: true,
            tool: {
              name: 'emit',
              input_schema: {
                type: 'object',
                properties: { x: { type: 'number' } },
                required: ['x'],
              },
            },
          } as never,
        },
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.output_config.format.type).toBe('json_schema');
      // The wire schema is the STAMPED copy: the format requires
      // additionalProperties:false PRESENT on every object node, and
      // zod-lowered schemas omit it.
      expect(requestBody.output_config.format.schema).toEqual({
        type: 'object',
        properties: { x: { type: 'number' } },
        required: ['x'],
        additionalProperties: false,
      });
      expect(requestBody.tools).toBeUndefined();
      expect(requestBody.tool_choice).toBeUndefined();
      expect(fetchMock.mock.calls[0][1].headers['anthropic-beta'] ?? '').not.toContain('structured-outputs-2025-11-13');
      // The JSON is the text block itself.
      expect(result.choices[0].message.content).toBe('{"x":2}');
    });

    it('stamps additionalProperties:false onto NESTED object nodes of the format schema and strips the keywords the format rejects', async () => {
      const msg = makeAnthropicResponse({
        content: [{ type: 'text', text: '{"inner":{"z":1}}' }],
        stop_reason: 'end_turn',
      });
      fetchMock.mockResolvedValueOnce(mockSseResponse(msg));

      await provider.generateCompletion(
        'claude-opus-4-8',
        [{ role: 'user', content: 'Hi' }],
        {
          responseFormat: {
            _agentosUseToolForStructuredOutput: true,
            tool: {
              name: 'emit',
              input_schema: {
                type: 'object',
                properties: {
                  inner: { type: 'object', properties: { z: { type: 'number', minimum: 0 } }, required: ['z'] },
                  list: { type: 'array', maxItems: 25, items: { type: 'string' } },
                },
                required: ['inner'],
              },
            },
          } as never,
        },
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      const schema = requestBody.output_config.format.schema;
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties.inner.additionalProperties).toBe(false);
      // required is untouched — the format accepts optional properties.
      expect(schema.required).toEqual(['inner']);
      // Rejected constraint keywords are stripped from the wire payload
      // ("For 'array' type, property 'maxItems' is not supported"); Zod
      // re-validates caller-side.
      expect('maxItems' in schema.properties.list).toBe(false);
      expect('minimum' in schema.properties.inner.properties.z).toBe(false);
      expect(requestBody.tools).toBeUndefined();
    });

    it('sends the format beside adaptive thinking on claude-opus-5-5, with the thinking header and no structured-outputs header', async () => {
      // The grammar applies to the final output, not to thinking, so the
      // format is never clamped the way a forced tool is with thinking on.
      const msg = makeAnthropicResponse({
        content: [{ type: 'text', text: '{"x":2}' }],
        stop_reason: 'end_turn',
      });
      fetchMock.mockResolvedValueOnce(mockSseResponse(msg));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await provider.generateCompletion(
          'claude-opus-5-5',
          [{ role: 'user', content: 'Hi' }],
          {
            thinking: { budgetTokens: 4000 },
            responseFormat: {
              _agentosUseToolForStructuredOutput: true,
              tool: {
                name: 'emit',
                input_schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
              },
            } as never,
          },
        );

        const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(['adaptive', 'enabled']).toContain(requestBody.thinking?.type);
        expect(requestBody.output_config.format.type).toBe('json_schema');
        expect(requestBody.tools).toBeUndefined();
        expect(requestBody.tool_choice).toBeUndefined();
        const beta = String(fetchMock.mock.calls[0][1].headers['anthropic-beta'] ?? '');
        expect(beta).toContain('interleaved-thinking-2025-05-14');
        expect(beta).not.toContain('structured-outputs-2025-11-13');
        expect(result.choices[0].message.content).toBe('{"x":2}');
        // No clamp warning: nothing was forced.
        expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('clamping'))).toBe(false);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('merges the format over a passthrough output_config instead of wiping either', async () => {
      const msg = makeAnthropicResponse({
        content: [{ type: 'text', text: '{"x":2}' }],
        stop_reason: 'end_turn',
      });
      fetchMock.mockResolvedValueOnce(mockSseResponse(msg));

      await provider.generateCompletion(
        'claude-opus-5-5',
        [{ role: 'user', content: 'Hi' }],
        {
          customModelParams: { output_config: { effort: 'high' } },
          responseFormat: {
            _agentosUseToolForStructuredOutput: true,
            tool: {
              name: 'emit',
              input_schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
            },
          } as never,
        },
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.output_config.effort).toBe('high');
      expect(requestBody.output_config.format.type).toBe('json_schema');
    });

    it('leaves a caller tool that shares the schema name as a tool call on the json_schema route', async () => {
      // The format works beside tools, and only the forced route names a
      // structured tool for the mapper, so a tool_use block called `emit` is a
      // tool call, not the answer; the text block is the content.
      const msg = makeAnthropicResponse({
        content: [
          { type: 'text', text: '{"x":2}' },
          { type: 'tool_use', id: 'toolu_c', name: 'emit', input: { q: 1 } },
        ],
        stop_reason: 'tool_use',
      });
      fetchMock.mockResolvedValueOnce(mockSseResponse(msg));

      const result = await provider.generateCompletion(
        'claude-opus-5-5',
        [{ role: 'user', content: 'Hi' }],
        {
          tools: [
            {
              type: 'function',
              function: { name: 'emit', description: 'Emit a value.', parameters: { type: 'object', properties: { q: { type: 'number' } } } },
            },
          ],
          responseFormat: {
            _agentosUseToolForStructuredOutput: true,
            tool: {
              name: 'emit',
              input_schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
            },
          } as never,
        },
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.output_config.format.type).toBe('json_schema');
      expect(requestBody.tools).toHaveLength(1);
      expect(requestBody.tools[0].name).toBe('emit');
      expect(requestBody.tool_choice).toBeUndefined();
      expect(result.choices[0].message.content).toBe('{"x":2}');
      expect(result.choices[0].message.tool_calls?.[0]?.function.name).toBe('emit');
    });

    it('a schema over the union-typed parameter limit takes the non-strict forced tool on claude-opus-4-8: no format, no schema block', async () => {
      // Anthropic allows at most 16 parameters that use anyOf or a type array
      // across a request's strict schemas and 400s past that, so the format
      // cannot carry this one; the forced tool still rides, without the strict
      // flag, as it did before the format.
      const msg = makeAnthropicResponse({
        content: [{ type: 'tool_use', id: 'toolu_s', name: 'emit', input: { f0: 'a' } }],
        stop_reason: 'tool_use',
      });
      fetchMock.mockResolvedValueOnce(mockSseResponse(msg));
      const properties = Object.fromEntries(
        Array.from({ length: 17 }, (_, i) => [`f${i}`, { type: ['string', 'null'] }]),
      );

      const result = await provider.generateCompletion(
        'claude-opus-4-8',
        [{ role: 'user', content: 'Hi' }],
        {
          responseFormat: {
            _agentosUseToolForStructuredOutput: true,
            tool: {
              name: 'emit',
              input_schema: { type: 'object', properties, required: Object.keys(properties) },
            },
          } as never,
        },
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.tools).toHaveLength(1);
      expect(requestBody.tools[0].name).toBe('emit');
      expect(requestBody.tools[0].strict).toBeUndefined();
      expect(requestBody.tool_choice).toEqual({ type: 'tool', name: 'emit' });
      expect(requestBody.output_config).toBeUndefined();
      expect(String(requestBody.system ?? '')).not.toContain('Answer with JSON only');
      expect(result.choices[0].message.content).toBe('{"f0":"a"}');
      expect(result.schemaRoute).toBe('forced_tool');
    });

    it('a record-bearing schema takes the non-strict forced tool on claude-opus-4-8 (degrades from the format, not to the prompt)', async () => {
      // z.record(...) lowers to a schema-valued additionalProperties, which
      // the format and strict mode reject at the API ("'additionalProperties'
      // must be explicitly set to false") deterministically, on every retry.
      // The forced tool must still ride, just without the strict flag.
      const msg = makeAnthropicResponse({
        content: [{ type: 'tool_use', id: 'toolu_s', name: 'emit', input: { config: { a: 'b' } } }],
        stop_reason: 'tool_use',
      });
      fetchMock.mockResolvedValueOnce(mockSseResponse(msg));

      const result = await provider.generateCompletion(
        'claude-opus-4-8',
        [{ role: 'user', content: 'Hi' }],
        {
          responseFormat: {
            _agentosUseToolForStructuredOutput: true,
            tool: {
              name: 'emit',
              input_schema: {
                type: 'object',
                properties: {
                  config: { type: 'object', additionalProperties: { type: 'string' } },
                },
                required: ['config'],
              },
            },
          } as never,
        },
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.tools[0].strict).toBeUndefined();
      // The forced tool itself is unchanged — only the strict flag is gated.
      expect(requestBody.tools[0].name).toBe('emit');
      expect(requestBody.tool_choice).toEqual({ type: 'tool', name: 'emit' });
      expect(requestBody.output_config).toBeUndefined();
      expect(String(requestBody.system ?? '')).not.toContain('Answer with JSON only');
      expect(result.choices[0].message.content).toBe('{"config":{"a":"b"}}');
    });

    it('with thinking on, a schema over the union-typed limit on claude-opus-4-8 takes the prompt, never a clamped tool: no tool, no format, the schema block, one warning naming thinking', async () => {
      // A forced tool_choice cannot ride with thinking on; the clamp would send
      // the schema tool under `auto`, which guarantees nothing, so the schema
      // goes into the prompt, after the caller's system prompt.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const msg = () =>
          makeAnthropicResponse({ content: [{ type: 'text', text: '{"f0":"a"}' }], stop_reason: 'end_turn' });
        fetchMock.mockResolvedValueOnce(mockSseResponse(msg())).mockResolvedValueOnce(mockSseResponse(msg()));
        const properties = Object.fromEntries(
          Array.from({ length: 17 }, (_, i) => [`f${i}`, { type: ['string', 'null'] }]),
        );
        const options = {
          thinking: { budgetTokens: 1024 },
          responseFormat: {
            _agentosUseToolForStructuredOutput: true,
            tool: {
              name: 'emit',
              input_schema: { type: 'object', properties, required: Object.keys(properties) },
            },
          } as never,
        };
        const messages: ChatMessage[] = [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'Hi' },
        ];

        const result = await provider.generateCompletion('claude-opus-4-8', messages, options);
        await provider.generateCompletion('claude-opus-4-8', messages, options);

        const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(['adaptive', 'enabled']).toContain(requestBody.thinking?.type);
        expect(requestBody.tools).toBeUndefined();
        expect(requestBody.tool_choice).toBeUndefined();
        expect(requestBody.output_config).toBeUndefined();
        const system = JSON.stringify(requestBody.system);
        expect(system).toContain('Answer with JSON only, matching this schema:');
        expect(system).toContain('f16');
        expect(system.indexOf('Answer with JSON only')).toBeGreaterThan(system.indexOf('You are terse.'));
        expect(result.choices[0].message.content).toBe('{"f0":"a"}');
        expect(result.schemaInPayload).toBe(false);
        expect(result.schemaRoute).toBe('none');
        const warnings = warnSpy.mock.calls.filter((c) => String(c[0]).includes('rides the prompt alone'));
        expect(warnings).toHaveLength(1);
        expect(String(warnings[0][0])).toContain('claude-opus-4-8');
        expect(String(warnings[0][0])).toContain('thinking');
        expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('clamping'))).toBe(false);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('with thinking on, a record-bearing schema on claude-opus-4-8 takes the prompt too, with no clamped tool', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        fetchMock.mockResolvedValueOnce(
          mockSseResponse(makeAnthropicResponse({ content: [{ type: 'text', text: '{"config":{"a":"b"}}' }], stop_reason: 'end_turn' })),
        );

        const result = await provider.generateCompletion('claude-opus-4-8', [{ role: 'user', content: 'Hi' }], {
          thinking: { budgetTokens: 1024 },
          responseFormat: {
            _agentosUseToolForStructuredOutput: true,
            tool: {
              name: 'emit',
              input_schema: {
                type: 'object',
                properties: { config: { type: 'object', additionalProperties: { type: 'string' } } },
                required: ['config'],
              },
            },
          } as never,
        });

        const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(requestBody.tools).toBeUndefined();
        expect(requestBody.tool_choice).toBeUndefined();
        expect(requestBody.output_config).toBeUndefined();
        expect(JSON.stringify(requestBody.system)).toContain('Answer with JSON only, matching this schema:');
        expect(result.schemaInPayload).toBe(false);
        // The one warning per model and reason was printed by the case above; none clamps a tool.
        const warnings = warnSpy.mock.calls.filter((c) => String(c[0]).includes('rides the prompt alone'));
        expect(warnings.every((c) => String(c[0]).includes('thinking'))).toBe(true);
        expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('clamping'))).toBe(false);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('a record-bearing schema on claude-sonnet-4-6 and on claude-opus-5, with no thinking option, takes the non-strict forced tool', async () => {
      const recordMarker = {
        _agentosUseToolForStructuredOutput: true,
        tool: {
          name: 'emit',
          input_schema: {
            type: 'object',
            properties: { scores: { type: 'object', additionalProperties: { type: 'number' } } },
            required: ['scores'],
          },
        },
      } as never;
      for (const model of ['claude-sonnet-4-6', 'claude-opus-5']) {
        fetchMock.mockResolvedValueOnce(
          mockSseResponse(
            makeAnthropicResponse({
              content: [{ type: 'tool_use', id: 'toolu_s', name: 'emit', input: { scores: { a: 1 } } }],
              stop_reason: 'tool_use',
            }),
          ),
        );
        const result = await provider.generateCompletion(model, [{ role: 'user', content: 'Grade.' }], { responseFormat: recordMarker });
        const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
        expect(body.model).toBe(model);
        expect(body.thinking).toBeUndefined();
        expect(body.tools).toEqual([
          {
            name: 'emit',
            input_schema: {
              type: 'object',
              properties: { scores: { type: 'object', additionalProperties: { type: 'number' } } },
              required: ['scores'],
            },
          },
        ]);
        expect(body.tool_choice).toEqual({ type: 'tool', name: 'emit' });
        expect(body.output_config).toBeUndefined();
        expect(result.choices[0].message.content).toBe('{"scores":{"a":1}}');
        expect(result.schemaRoute).toBe('forced_tool');
      }
    });

    it('a record-bearing schema takes the prompt on claude-opus-5-5, after the caller system prompt, warning once', async () => {
      // z.record(...) lowers to a schema-valued additionalProperties, which the
      // format rejects at the API ("'additionalProperties' must be explicitly
      // set to false") deterministically, on every retry.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const msg = () =>
          makeAnthropicResponse({ content: [{ type: 'text', text: '{"config":{"a":"b"}}' }], stop_reason: 'end_turn' });
        fetchMock.mockResolvedValueOnce(mockSseResponse(msg())).mockResolvedValueOnce(mockSseResponse(msg()));
        const options = {
          responseFormat: {
            _agentosUseToolForStructuredOutput: true,
            tool: {
              name: 'emit',
              input_schema: {
                type: 'object',
                properties: {
                  config: { type: 'object', additionalProperties: { type: 'string' } },
                },
                required: ['config'],
              },
            },
          } as never,
        };
        const messages: ChatMessage[] = [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'Hi' },
        ];

        const result = await provider.generateCompletion('claude-opus-5-5', messages, options);
        await provider.generateCompletion('claude-opus-5-5', messages, options);

        const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(requestBody.tools).toBeUndefined();
        expect(requestBody.tool_choice).toBeUndefined();
        expect(requestBody.output_config).toBeUndefined();
        const system = String(requestBody.system);
        expect(system.indexOf('You are terse.')).toBeGreaterThanOrEqual(0);
        expect(system.indexOf('Answer with JSON only, matching this schema:')).toBeGreaterThan(system.indexOf('You are terse.'));
        expect(system).toContain('"config"');
        expect(result.choices[0].message.content).toBe('{"config":{"a":"b"}}');
        expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('rides the prompt alone'))).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('a request whose messages enable citations takes the prompt on claude-sonnet-5-5 (the format refuses citations)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        fetchMock.mockResolvedValueOnce(
          mockSseResponse(makeAnthropicResponse({ content: [{ type: 'text', text: '{"x":2}' }], stop_reason: 'end_turn' })),
        );

        await provider.generateCompletion(
          'claude-sonnet-5-5',
          [{ role: 'user', content: 'Summarize the document.' }],
          {
            customModelParams: {
              messages: [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'document',
                      source: { type: 'text', media_type: 'text/plain', data: 'The sky is blue.' },
                      citations: { enabled: true },
                    },
                    { type: 'text', text: 'Summarize the document.' },
                  ],
                },
              ],
            },
            responseFormat: {
              _agentosUseToolForStructuredOutput: true,
              tool: {
                name: 'emit',
                input_schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
              },
            } as never,
          },
        );

        const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(requestBody.output_config).toBeUndefined();
        expect(requestBody.tools).toBeUndefined();
        expect(requestBody.tool_choice).toBeUndefined();
        expect(String(requestBody.system)).toContain('Answer with JSON only, matching this schema:');
        const warnings = warnSpy.mock.calls.filter((c) => String(c[0]).includes('rides the prompt alone'));
        expect(warnings).toHaveLength(1);
        expect(String(warnings[0][0])).toContain('citations');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('the prompt-only schema block never grows a caller-owned passthrough system array: the same params twice send one block each', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const system = [{ type: 'text', text: 'You grade things.' }];
        const customModelParams = { system };
        const recordSchema = {
          type: 'object',
          properties: { scores: { type: 'object', additionalProperties: { type: 'number' } } },
          required: ['scores'],
        };
        for (let i = 0; i < 2; i++) {
          fetchMock.mockResolvedValueOnce(
            mockSseResponse(makeAnthropicResponse({ content: [{ type: 'text', text: '{"scores":{"a":1}}' }], stop_reason: 'end_turn' })),
          );
          await provider.generateCompletion('claude-opus-5-5', [{ role: 'user', content: 'Grade.' }], {
            customModelParams,
            responseFormat: { _agentosUseToolForStructuredOutput: true, tool: { name: 'emit', input_schema: recordSchema } } as never,
          });
        }
        expect(system).toEqual([{ type: 'text', text: 'You grade things.' }]);
        expect(fetchMock.mock.calls).toHaveLength(2);
        for (const call of fetchMock.mock.calls) {
          const body = JSON.parse(call[1].body);
          expect(body.system[0]).toEqual({ type: 'text', text: 'You grade things.' });
          const schemaBlocks = (body.system as Array<{ text: string }>).filter((b) => b.text.startsWith('Answer with JSON only, matching this schema:'));
          expect(schemaBlocks).toHaveLength(1);
        }
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('the citations downgrade drops a passthrough output_config.format, keeps the rest of output_config, and the completion says the schema rode the prompt', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        fetchMock.mockResolvedValueOnce(
          mockSseResponse(makeAnthropicResponse({ content: [{ type: 'text', text: '{"x":2}' }], stop_reason: 'end_turn' })),
        );
        const completion = await provider.generateCompletion('claude-opus-5-5', [{ role: 'user', content: 'Summarize the document.' }], {
          customModelParams: {
            output_config: {
              effort: 'high',
              format: { type: 'json_schema', schema: { type: 'object', properties: {}, additionalProperties: false } },
            },
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'document',
                    source: { type: 'text', media_type: 'text/plain', data: 'The sky is blue.' },
                    citations: { enabled: true },
                  },
                  { type: 'text', text: 'Summarize the document.' },
                ],
              },
            ],
          },
          responseFormat: {
            _agentosUseToolForStructuredOutput: true,
            tool: { name: 'emit', input_schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] } },
          } as never,
        });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.output_config).toEqual({ effort: 'high' });
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
        expect(String(body.system)).toContain('Answer with JSON only, matching this schema:');
        expect(completion.schemaInPayload).toBe(false);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('routes by the model on the wire: a passthrough model from Opus 5.5 to Sonnet 4 takes the forced tool, and the reverse takes the format', async () => {
      const marker = {
        _agentosUseToolForStructuredOutput: true,
        tool: { name: 'emit', input_schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] } },
      } as never;
      fetchMock.mockResolvedValueOnce(
        mockSseResponse(makeAnthropicResponse({ content: [{ type: 'text', text: '{"x":2}' }], stop_reason: 'end_turn' })),
      );
      await provider.generateCompletion('claude-opus-5-5', [{ role: 'user', content: 'Go.' }], {
        customModelParams: { model: 'claude-sonnet-4-20250514' },
        responseFormat: marker,
      });
      const toSonnet4 = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(toSonnet4.model).toBe('claude-sonnet-4-20250514');
      expect(toSonnet4.output_config).toBeUndefined();
      expect(toSonnet4.tools?.[0]?.name).toBe('emit');
      expect(toSonnet4.tool_choice).toEqual({ type: 'tool', name: 'emit' });

      fetchMock.mockResolvedValueOnce(
        mockSseResponse(makeAnthropicResponse({ content: [{ type: 'text', text: '{"x":2}' }], stop_reason: 'end_turn' })),
      );
      await provider.generateCompletion('claude-sonnet-4-20250514', [{ role: 'user', content: 'Go.' }], {
        customModelParams: { model: 'claude-opus-5-5' },
        responseFormat: marker,
      });
      const toOpus = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(toOpus.model).toBe('claude-opus-5-5');
      expect(toOpus.output_config?.format?.type).toBe('json_schema');
      expect(toOpus.tools).toBeUndefined();
      expect(toOpus.tool_choice).toBeUndefined();
    });

    it('the prompt-only route says so on every stream chunk (schemaInPayload false); the format route says nothing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const recordMarker = {
          _agentosUseToolForStructuredOutput: true,
          tool: {
            name: 'emit',
            input_schema: { type: 'object', properties: { scores: { type: 'object', additionalProperties: { type: 'number' } } }, required: ['scores'] },
          },
        } as never;
        fetchMock.mockResolvedValueOnce(
          mockSseResponse(makeAnthropicResponse({ content: [{ type: 'text', text: '{"scores":{"a":1}}' }], stop_reason: 'end_turn' })),
        );
        const chunks: Array<{ schemaInPayload?: boolean }> = [];
        for await (const chunk of provider.generateCompletionStream('claude-sonnet-5-5', [{ role: 'user', content: 'Grade.' }], { responseFormat: recordMarker })) {
          chunks.push(chunk as { schemaInPayload?: boolean });
        }
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.every((c) => c.schemaInPayload === false)).toBe(true);

        fetchMock.mockResolvedValueOnce(
          mockSseResponse(makeAnthropicResponse({ content: [{ type: 'text', text: '{"x":2}' }], stop_reason: 'end_turn' })),
        );
        const onFormat = await provider.generateCompletion('claude-sonnet-5-5', [{ role: 'user', content: 'Go.' }], {
          responseFormat: {
            _agentosUseToolForStructuredOutput: true,
            tool: { name: 'emit', input_schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] } },
          } as never,
        });
        expect(onFormat.schemaInPayload).toBeUndefined();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('keeps the forced tool on claude-sonnet-4-20250514 (no JSON output format), now never strict', async () => {
      const msg = makeAnthropicResponse({
        content: [{ type: 'tool_use', id: 'toolu_s', name: 'emit', input: { x: 2 } }],
        stop_reason: 'tool_use',
      });
      fetchMock.mockResolvedValueOnce(mockSseResponse(msg));

      const result = await provider.generateCompletion(
        'claude-sonnet-4-20250514',
        [{ role: 'user', content: 'Hi' }],
        {
          responseFormat: {
            _agentosUseToolForStructuredOutput: true,
            tool: {
              name: 'emit',
              input_schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
            },
          } as never,
        },
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.output_config).toBeUndefined();
      expect(requestBody.tools).toHaveLength(1);
      expect(requestBody.tools[0].name).toBe('emit');
      expect(requestBody.tools[0].strict).toBeUndefined();
      // The schema goes out as given: no strict stamp on a model without strict tool use.
      expect(requestBody.tools[0].input_schema).toEqual({ type: 'object', properties: { x: { type: 'number' } }, required: ['x'] });
      expect(requestBody.tool_choice).toEqual({ type: 'tool', name: 'emit' });
      expect(fetchMock.mock.calls[0][1].headers['anthropic-beta']).toBeUndefined();
      expect(result.choices[0].message.content).toBe('{"x":2}');
    });

    it('a request whose messages enable citations takes the non-strict forced tool on claude-sonnet-4-6 and drops a passthrough output_config.format', async () => {
      // The format and citations answer 400 together; a plain forced tool beside
      // a citations-enabled document answered 200 with a tool_use stop
      // (live-probed 2026-10-19 on claude-sonnet-4-6).
      fetchMock.mockResolvedValueOnce(
        mockSseResponse(
          makeAnthropicResponse({
            content: [{ type: 'tool_use', id: 'toolu_s', name: 'emit', input: { x: 2 } }],
            stop_reason: 'tool_use',
          }),
        ),
      );
      const completion = await provider.generateCompletion('claude-sonnet-4-6', [{ role: 'user', content: 'Summarize the document.' }], {
        customModelParams: {
          output_config: {
            effort: 'high',
            format: { type: 'json_schema', schema: { type: 'object', properties: {}, additionalProperties: false } },
          },
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: { type: 'text', media_type: 'text/plain', data: 'The sky is blue.' },
                  citations: { enabled: true },
                },
                { type: 'text', text: 'Summarize the document.' },
              ],
            },
          ],
        },
        responseFormat: {
          _agentosUseToolForStructuredOutput: true,
          tool: { name: 'emit', input_schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] } },
        } as never,
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.output_config).toEqual({ effort: 'high' });
      expect(body.tools).toEqual([
        { name: 'emit', input_schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] } },
      ]);
      expect(body.tool_choice).toEqual({ type: 'tool', name: 'emit' });
      expect(String(body.system ?? '')).not.toContain('Answer with JSON only');
      expect(completion.choices[0].message.content).toBe('{"x":2}');
      expect(completion.schemaRoute).toBe('forced_tool');
      expect(completion.schemaInPayload).toBeUndefined();
    });

    it("the prompt-only schema block survives the auto-cache's block placement (thinking on, a 1-hour cache TTL)", async () => {
      // The auto-cache re-emits the provider's own system blocks as an array to
      // place its marker when thinking is on or a TTL is asked for; the schema
      // block must be one of them, or the schema never reaches the model.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const recordMarker = {
          _agentosUseToolForStructuredOutput: true,
          tool: {
            name: 'emit',
            input_schema: {
              type: 'object',
              properties: { scores: { type: 'object', additionalProperties: { type: 'number' } } },
              required: ['scores'],
            },
          },
        } as never;
        const messages: ChatMessage[] = [
          { role: 'system', content: 'You grade things.' },
          { role: 'user', content: 'Grade.' },
        ];
        const reply = () =>
          mockSseResponse(makeAnthropicResponse({ content: [{ type: 'text', text: '{"scores":{"a":1}}' }], stop_reason: 'end_turn' }));
        fetchMock.mockResolvedValueOnce(reply()).mockResolvedValueOnce(reply());

        await provider.generateCompletion('claude-opus-5-5', messages, { thinking: { budgetTokens: 2000 }, responseFormat: recordMarker });
        await provider.generateCompletion('claude-opus-5-5', messages, { cache: { ttl: '1h' }, responseFormat: recordMarker });

        for (const call of fetchMock.mock.calls) {
          const body = JSON.parse(call[1].body);
          expect(Array.isArray(body.system)).toBe(true);
          expect(body.system[0]).toMatchObject({ type: 'text', text: 'You grade things.', cache_control: { type: 'ephemeral' } });
          expect(body.system.at(-1).text.startsWith('Answer with JSON only, matching this schema:')).toBe(true);
          expect(body.system.at(-1).text).toContain('"scores"');
        }
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('counts a strict passthrough tool beside the format toward its union-typed limit: no format goes out, the caller tool stays, and the schema rides the prompt', async () => {
      // A strict tool of ten union-typed parameters beside a format schema of
      // ten answered 400 ("20 parameters with type arrays or anyOf ... limit:
      // 16", live-probed 2026-10-19 on claude-haiku-5-5). Forcing the schema
      // tool would need it in the caller's tools array, which keeps precedence.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const unionsOf = (n: number) => {
          const properties = Object.fromEntries(Array.from({ length: n }, (_, i) => [`u${i}`, { type: ['string', 'null'] }]));
          return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
        };
        const lookup = { name: 'lookup', description: 'Look up.', input_schema: unionsOf(10), strict: true };
        fetchMock.mockResolvedValueOnce(
          mockSseResponse(makeAnthropicResponse({ content: [{ type: 'text', text: '{"u0":null}' }], stop_reason: 'end_turn' })),
        );

        const completion = await provider.generateCompletion('claude-haiku-5-5', [{ role: 'user', content: 'Go.' }], {
          customModelParams: { tools: [lookup] },
          responseFormat: { _agentosUseToolForStructuredOutput: true, tool: { name: 'emit', input_schema: unionsOf(10) } } as never,
        });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.output_config).toBeUndefined();
        expect(body.tools).toEqual([lookup]);
        expect(body.tool_choice).toBeUndefined();
        expect(String(body.system)).toContain('Answer with JSON only, matching this schema:');
        expect(completion.schemaRoute).toBe('none');
        expect(completion.schemaInPayload).toBe(false);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('a passthrough tools array without the schema tool sends no forced choice naming it: the schema rides the prompt; with the schema tool in it, the choice is forced on it', async () => {
      // A forced tool_choice must name a tool the request carries; the
      // passthrough array keeps precedence over the schema tool, so a forced
      // choice on Claude Sonnet 4 (forced-tool route) needs the tool in it.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const lookup = { name: 'lookup', description: 'Look up.', input_schema: { type: 'object', properties: { q: { type: 'string' } } } };
        const schema = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] };
        const marker = { _agentosUseToolForStructuredOutput: true, tool: { name: 'emit', input_schema: schema } } as never;
        fetchMock
          .mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse({ content: [{ type: 'text', text: '{"x":2}' }], stop_reason: 'end_turn' })))
          .mockResolvedValueOnce(
            mockSseResponse(
              makeAnthropicResponse({ content: [{ type: 'tool_use', id: 'toolu_s', name: 'emit', input: { x: 2 } }], stop_reason: 'tool_use' }),
            ),
          );

        const withoutSchemaTool = await provider.generateCompletion('claude-sonnet-4-20250514', [{ role: 'user', content: 'Go.' }], {
          customModelParams: { tools: [lookup] },
          responseFormat: marker,
        });
        const first = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(first.tools).toEqual([lookup]);
        expect(first.tool_choice).toBeUndefined();
        expect(String(first.system)).toContain('Answer with JSON only, matching this schema:');
        expect(withoutSchemaTool.schemaRoute).toBe('none');
        expect(withoutSchemaTool.schemaInPayload).toBe(false);

        const emit = { name: 'emit', input_schema: schema };
        const withSchemaTool = await provider.generateCompletion('claude-sonnet-4-20250514', [{ role: 'user', content: 'Go.' }], {
          customModelParams: { tools: [lookup, emit] },
          responseFormat: marker,
        });
        const second = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(second.tools).toEqual([lookup, emit]);
        expect(second.tool_choice).toEqual({ type: 'tool', name: 'emit' });
        expect(String(second.system ?? '')).not.toContain('Answer with JSON only');
        expect(withSchemaTool.schemaRoute).toBe('forced_tool');
        expect(withSchemaTool.choices[0].message.content).toBe('{"x":2}');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('names the route it took on every completion and stream chunk of a schema request, and on no other', async () => {
      const recordMarker = {
        _agentosUseToolForStructuredOutput: true,
        tool: {
          name: 'emit',
          input_schema: { type: 'object', properties: { scores: { type: 'object', additionalProperties: { type: 'number' } } }, required: ['scores'] },
        },
      } as never;
      fetchMock.mockResolvedValueOnce(
        mockSseResponse(
          makeAnthropicResponse({
            content: [{ type: 'tool_use', id: 'toolu_s', name: 'emit', input: { scores: { a: 1 } } }],
            stop_reason: 'tool_use',
          }),
        ),
      );
      const chunks: Array<{ schemaRoute?: string; schemaInPayload?: boolean }> = [];
      for await (const chunk of provider.generateCompletionStream('claude-sonnet-4-6', [{ role: 'user', content: 'Grade.' }], { responseFormat: recordMarker })) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((c) => c.schemaRoute === 'forced_tool' && c.schemaInPayload === undefined)).toBe(true);

      fetchMock.mockResolvedValueOnce(
        mockSseResponse(makeAnthropicResponse({ content: [{ type: 'text', text: '{"x":2}' }], stop_reason: 'end_turn' })),
      );
      const onFormat = await provider.generateCompletion('claude-opus-4-8', [{ role: 'user', content: 'Go.' }], {
        responseFormat: {
          _agentosUseToolForStructuredOutput: true,
          tool: { name: 'emit', input_schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] } },
        } as never,
      });
      expect(onFormat.schemaRoute).toBe('json_schema');

      fetchMock.mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));
      const plain: Array<{ schemaRoute?: string }> = [];
      for await (const chunk of provider.generateCompletionStream('claude-opus-4-8', [{ role: 'user', content: 'Hi' }], {})) {
        plain.push(chunk);
      }
      expect(plain.some((c) => c.schemaRoute !== undefined)).toBe(false);
    });

    it('logs the schema diagnostic on a 4xx output_config.format rejection (tripwire, 2026-07-07; the format route, 2026-10-19)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        fetchMock.mockResolvedValueOnce(
          mockJsonResponse(
            {
              error: {
                type: 'invalid_request_error',
                message:
                  "output_config.format.schema: For 'array' type, 'minItems' values other than 0 or 1 are not supported (got: [2, 5])",
              },
            },
            400,
          ),
        );

        await expect(
          provider.generateCompletion(
            'claude-opus-4-8',
            [{ role: 'user', content: 'Hi' }],
            {
              responseFormat: {
                _agentosUseToolForStructuredOutput: true,
                tool: {
                  name: 'emit',
                  input_schema: {
                    type: 'object',
                    properties: { title: { type: 'string' } },
                    required: ['title'],
                    additionalProperties: false,
                  },
                },
              } as never,
            },
          ),
        ).rejects.toThrow();

        const diagCall = warnSpy.mock.calls.find(
          (c) => typeof c[0] === 'string' && c[0].includes('strict-schema 4xx diagnostic'),
        );
        expect(diagCall).toBeTruthy();
        const payload = JSON.parse(String(diagCall![1]));
        expect(payload.event).toBe('anthropic_strict_schema_rejection');
        expect(payload.status).toBe(400);
        expect(payload.modelId).toContain('claude');
        expect(typeof payload.payloadUsesStrictTools).toBe('boolean');
        // The outbound format schema rides the diagnostic so the next
        // occurrence is a one-log root-cause; no tool goes out on this route.
        expect(JSON.stringify(payload.outputConfigFormat)).toContain('"title"');
        expect(payload.tools).toEqual([]);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('logs the strict-schema diagnostic on a constraint-keyword rejection too', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        fetchMock.mockResolvedValueOnce(
          mockJsonResponse(
            {
              error: {
                type: 'invalid_request_error',
                message: "tools.0.custom: For 'array' type, property 'maxItems' is not supported",
              },
            },
            400,
          ),
        );
        await expect(
          provider.generateCompletion('claude-opus-4-8', [{ role: 'user', content: 'Hi' }], {}),
        ).rejects.toThrow();
        expect(
          warnSpy.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('strict-schema 4xx diagnostic'),
          ),
        ).toBeTruthy();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('logs the strict-schema diagnostic on an empty-schema rejection too (2026-07-08)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        fetchMock.mockResolvedValueOnce(
          mockJsonResponse(
            {
              error: {
                type: 'invalid_request_error',
                message:
                  "tools.0.custom: Empty schema ({}) that accepts any JSON value is not supported. Please specify a concrete type.",
              },
            },
            400,
          ),
        );
        await expect(
          provider.generateCompletion('claude-opus-4-8', [{ role: 'user', content: 'Hi' }], {}),
        ).rejects.toThrow();
        expect(
          warnSpy.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('strict-schema 4xx diagnostic'),
          ),
        ).toBeTruthy();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('does NOT log the strict-schema diagnostic on unrelated 400s', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        fetchMock.mockResolvedValueOnce(
          mockJsonResponse(
            { error: { type: 'invalid_request_error', message: 'max_tokens too large' } },
            400,
          ),
        );

        await expect(
          provider.generateCompletion('claude-opus-4-8', [{ role: 'user', content: 'Hi' }], {}),
        ).rejects.toThrow();

        expect(
          warnSpy.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('strict-schema 4xx diagnostic'),
          ),
        ).toBeUndefined();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('aborts a mid-body stall after streamIdleTimeoutMs instead of hanging', async () => {
      const idleProvider = new AnthropicProvider();
      await idleProvider.initialize({ apiKey: 'k', streamIdleTimeoutMs: 40, maxRetries: 1 });
      fetchMock.mockResolvedValueOnce(stallingSseResponse([
        d({ type: 'message_start', message: { ...makeAnthropicResponse(), content: [], stop_reason: null } }),
      ]));

      await expect(
        idleProvider.generateCompletion(
          'claude-opus-4-8',
          [{ role: 'user', content: 'Hi' }],
          // The generous caller timeout must NOT extend the idle bound — that
          // is the 25-min codegen stall this transport exists to prevent.
          { requestTimeout: 1_500_000 },
        ),
      ).rejects.toThrow(/Stream idle/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries after an idle stall when maxRetries allows and succeeds', async () => {
      const retryProvider = new AnthropicProvider();
      await retryProvider.initialize({ apiKey: 'k', maxRetries: 2, streamIdleTimeoutMs: 40 });
      fetchMock
        .mockResolvedValueOnce(stallingSseResponse([
          d({ type: 'message_start', message: { ...makeAnthropicResponse(), content: [], stop_reason: null } }),
        ]))
        .mockResolvedValueOnce(mockSseResponse(makeAnthropicResponse()));

      const result = await retryProvider.generateCompletion(
        'claude-sonnet-4-20250514',
        [{ role: 'user', content: 'Hi' }],
        {},
      );

      expect(result.choices[0].message.content).toBe('Hello from Anthropic!');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }, 10_000);

    it('does not retry a non-retryable 4xx connection error', async () => {
      const retryProvider = new AnthropicProvider();
      await retryProvider.initialize({ apiKey: 'k', maxRetries: 3 });
      fetchMock.mockResolvedValue(mockJsonResponse(
        { type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } },
        400,
      ));

      await expect(
        retryProvider.generateCompletion(
          'claude-sonnet-4-20250514',
          [{ role: 'user', content: 'Hi' }],
          {},
        ),
      ).rejects.toThrow(/bad request/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws on a stream that ends without message_delta (incomplete)', async () => {
      // Single attempt: the retry-era default would re-read the one-shot mock
      // Response on retry and mask the incomplete-stream error.
      const singleShot = new AnthropicProvider();
      await singleShot.initialize({ apiKey: 'k', maxRetries: 1 });
      fetchMock.mockResolvedValueOnce({
        ok: true, status: 200, statusText: 'OK', headers: new Headers(),
        json: () => Promise.reject(new Error('SSE body, not JSON')),
        body: createSseStream([
          d({ type: 'message_start', message: { ...makeAnthropicResponse(), content: [], stop_reason: null } }),
        ]),
      } as unknown as Response);

      await expect(
        singleShot.generateCompletion(
          'claude-sonnet-4-20250514',
          [{ role: 'user', content: 'Hi' }],
          {},
        ),
      ).rejects.toThrow(/incomplete/i);
    });

    it('throws the API error from an SSE error event', async () => {
      const singleShot = new AnthropicProvider();
      await singleShot.initialize({ apiKey: 'k', maxRetries: 1 });
      fetchMock.mockResolvedValueOnce({
        ok: true, status: 200, statusText: 'OK', headers: new Headers(),
        json: () => Promise.reject(new Error('SSE body, not JSON')),
        body: createSseStream([
          d({ type: 'message_start', message: { ...makeAnthropicResponse(), content: [], stop_reason: null } }),
          d({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
        ]),
      } as unknown as Response);

      await expect(
        singleShot.generateCompletion(
          'claude-sonnet-4-20250514',
          [{ role: 'user', content: 'Hi' }],
          {},
        ),
      ).rejects.toThrow(/Overloaded/);
    });

    it('falls back to the single-shot JSON transport when streamCompletions: false', async () => {
      const legacyProvider = new AnthropicProvider();
      await legacyProvider.initialize({ apiKey: 'k', streamCompletions: false });
      fetchMock.mockResolvedValueOnce(mockJsonResponse(makeAnthropicResponse()));

      const result = await legacyProvider.generateCompletion(
        'claude-sonnet-4-20250514',
        [{ role: 'user', content: 'Hi' }],
        {},
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.stream).toBe(false);
      expect(result.choices[0].message.content).toBe('Hello from Anthropic!');
    });
  });
});

describe('inclusive input accounting (spec batch-1 C1)', () => {
  let provider: AnthropicProvider;

  beforeEach(async () => {
    fetchMock.mockReset();
    provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'test-anthropic-key' });
  });

  it("adds cache reads and writes back onto Anthropic's exclusive input count", async () => {
    fetchMock.mockResolvedValueOnce(
      mockSseResponse(
        makeAnthropicResponse({
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            cache_read_input_tokens: 400,
            cache_creation_input_tokens: 50,
          },
        }),
      ),
    );

    const res = await provider.generateCompletion(
      'claude-sonnet-4-6',
      [{ role: 'user', content: 'Hello' }],
      {},
    );

    expect(res.usage?.cacheReadInputTokens).toBe(400);
    expect(res.usage?.cacheCreationInputTokens).toBe(50);
    expect(res.usage?.inclusiveInputTokens).toBe(550);
  });
});
