/**
 * @fileoverview Request-shape tests for zero-config prompt caching on
 * OpenRouter `anthropic/*` slugs: cache_control markers injected on the
 * system message and the final message, caller-marker stand-down, the
 * cache:false / env kill-switch opt-outs, ttl carry, and non-Anthropic
 * slugs staying byte-identical (OpenRouter forwards cache_control to
 * Anthropic; other upstreams cache automatically without markers).
 *
 * All requests are stubbed at the makeApiRequest seam so neither
 * initialize() nor the completion calls can reach the network.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { OpenRouterProvider } from '../OpenRouterProvider';
import type { ChatMessage } from '../../IProvider';
import { agent } from '../../../../../api/agent';
import { systemTextOf } from '../../../../../api/__tests__/helpers/stubProviders';

type WirePart = {
  type?: string;
  text?: string;
  cache_control?: { type: string; ttl?: string };
};

type WireMessage = {
  role: string;
  content: string | WirePart[] | null;
};

type ApiCall = [
  endpoint: string,
  method: string,
  timeout: number | undefined,
  payload: Record<string, unknown> | undefined,
  isStream: boolean | undefined,
];

function chatBody(model = 'anthropic/claude-sonnet-4-6') {
  return {
    id: 'gen-1',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [
      { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  };
}

/**
 * Builds a provider whose makeApiRequest is fully stubbed: /models returns
 * an empty catalog (initialize succeeds offline), chat completions return a
 * minimal body, and stream requests return an immediately-terminating SSE
 * stream. Returns the spy so tests can read the exact wire payload.
 */
async function makeProvider(): Promise<{
  provider: OpenRouterProvider;
  calls: () => ApiCall[];
}> {
  const provider = new OpenRouterProvider();
  const seam = provider as unknown as {
    makeApiRequest: (
      endpoint: string,
      method: string,
      timeout?: number,
      payload?: Record<string, unknown>,
      isStream?: boolean,
    ) => Promise<unknown>;
  };
  const spy = vi
    .spyOn(seam, 'makeApiRequest')
    .mockImplementation(async (endpoint, _method, _timeout, _payload, isStream) => {
      if (endpoint === '/models') return { data: [] };
      if (isStream) return Readable.from(['data: [DONE]\n\n']);
      return chatBody();
    });
  await provider.initialize({ apiKey: 'sk-or-test' });
  return { provider, calls: () => spy.mock.calls as unknown as ApiCall[] };
}

function lastChatMessages(calls: ApiCall[]): WireMessage[] {
  const chat = calls.filter((c) => c[0] === '/chat/completions').at(-1);
  expect(chat).toBeDefined();
  return (chat![3] as { messages: WireMessage[] }).messages;
}

async function capture(
  modelId: string,
  messages: ChatMessage[],
  options: Record<string, unknown> = {},
): Promise<WireMessage[]> {
  const { provider, calls } = await makeProvider();
  await provider.generateCompletion(modelId, messages, options);
  return lastChatMessages(calls());
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENTOS_ANTHROPIC_AUTO_CACHE;
});

describe('OpenRouter anthropic/* zero-config cache_control', () => {
  const convo: ChatMessage[] = [
    { role: 'system', content: 'stable rules '.repeat(10) },
    { role: 'user', content: 'turn one' },
    { role: 'assistant', content: 'reply one' },
    { role: 'user', content: 'turn two' },
  ];

  it('marks the system message and the final message on anthropic slugs', async () => {
    const wire = await capture('anthropic/claude-sonnet-4-6', convo);

    const systemParts = wire[0].content as WirePart[];
    expect(Array.isArray(systemParts)).toBe(true);
    expect(systemParts[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(systemParts[0].text).toBe('stable rules '.repeat(10));

    const tailParts = wire.at(-1)!.content as WirePart[];
    expect(tailParts.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
    expect(tailParts.at(-1)!.text).toBe('turn two');

    // Middle turns stay plain strings — exactly two breakpoints injected.
    expect(typeof wire[1].content).toBe('string');
    expect(typeof wire[2].content).toBe('string');
  });

  it('carries cache.ttl onto the injected markers', async () => {
    const wire = await capture('anthropic/claude-sonnet-4-6', convo, {
      cache: { ttl: '1h' },
    });
    const systemParts = wire[0].content as WirePart[];
    expect(systemParts[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const tailParts = wire.at(-1)!.content as WirePart[];
    expect(tailParts.at(-1)!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('cache tail:false marks the system message and leaves the final message unmarked', async () => {
    const wire = await capture('anthropic/claude-sonnet-4-6', convo, {
      cache: { tail: false },
    });
    const systemParts = wire[0].content as WirePart[];
    expect(systemParts[0].cache_control).toEqual({ type: 'ephemeral' });
    for (const m of wire.slice(1)) expect(typeof m.content).toBe('string');
  });

  it('cache:false leaves plain requests untouched', async () => {
    const wire = await capture('anthropic/claude-sonnet-4-6', convo, { cache: false });
    for (const m of wire) expect(typeof m.content).toBe('string');
  });

  it('cache:false strips caller-provided markers (hard opt-out parity)', async () => {
    const marked: ChatMessage[] = [
      {
        role: 'system',
        content: [
          { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'volatile' },
        ],
      },
      { role: 'user', content: 'turn' },
    ];
    const wire = await capture('anthropic/claude-sonnet-4-6', marked, { cache: false });
    const systemParts = wire[0].content as WirePart[];
    expect(systemParts.every((p) => p.cache_control === undefined)).toBe(true);
    expect(systemParts.map((p) => p.text)).toEqual(['stable', 'volatile']);
    // The caller's own array is untouched (copy-on-write strip).
    expect(
      (marked[0].content as Array<{ cache_control?: unknown }>)[0].cache_control,
    ).toEqual({ type: 'ephemeral' });
  });

  it('marks the FIRST system message when later system messages exist', async () => {
    const wire = await capture('anthropic/claude-sonnet-4-6', [
      { role: 'system', content: 'stable leading instructions' },
      { role: 'system', content: 'volatile per-turn recall' },
      { role: 'user', content: 'turn' },
    ]);
    const first = wire[0].content as WirePart[];
    expect(first[0].cache_control).toEqual({ type: 'ephemeral' });
    // The volatile later system message stays unmarked.
    expect(typeof wire[1].content).toBe('string');
    const tail = wire.at(-1)!.content as WirePart[];
    expect(tail.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('stands down when a tool definition carries a marker', async () => {
    const wire = await capture('anthropic/claude-sonnet-4-6', convo, {
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', parameters: { type: 'object' } },
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
    for (const m of wire) expect(typeof m.content).toBe('string');
  });

  it('AGENTOS_ANTHROPIC_AUTO_CACHE=0 disables injection', async () => {
    process.env.AGENTOS_ANTHROPIC_AUTO_CACHE = '0';
    const wire = await capture('anthropic/claude-sonnet-4-6', convo);
    for (const m of wire) expect(typeof m.content).toBe('string');
  });

  it('AGENTOS_ANTHROPIC_AUTO_CACHE=false disables injection (direct-path syntax parity)', async () => {
    process.env.AGENTOS_ANTHROPIC_AUTO_CACHE = 'false';
    const wire = await capture('anthropic/claude-sonnet-4-6', convo);
    for (const m of wire) expect(typeof m.content).toBe('string');
  });

  it('non-anthropic slugs stay untouched', async () => {
    const wire = await capture('openai/gpt-4o', convo);
    for (const m of wire) expect(typeof m.content).toBe('string');
  });

  it('stands down when the caller already placed a marker', async () => {
    const marked: ChatMessage[] = [
      {
        role: 'system',
        content: [
          { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'volatile' },
        ],
      },
      { role: 'user', content: 'turn' },
    ];
    const wire = await capture('anthropic/claude-sonnet-4-6', marked);

    // Caller placement wins: the unmarked block stays unmarked and no tail
    // marker appears.
    const systemParts = wire[0].content as WirePart[];
    expect(systemParts[1].cache_control).toBeUndefined();
    expect(typeof wire.at(-1)!.content).toBe('string');
  });

  it('system-only requests get one breakpoint, not two', async () => {
    const wire = await capture('anthropic/claude-haiku-4-5', [
      { role: 'system', content: 'only system' },
    ]);
    const systemParts = wire[0].content as WirePart[];
    expect(systemParts[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('skips messages with no markable text instead of forcing parts', async () => {
    const wire = await capture('anthropic/claude-sonnet-4-6', [
      { role: 'system', content: 'rules' },
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }],
      },
    ]);
    const systemParts = wire[0].content as WirePart[];
    expect(systemParts[0].cache_control).toEqual({ type: 'ephemeral' });
    const tailParts = wire.at(-1)!.content as WirePart[];
    expect(tailParts.every((p) => p.cache_control === undefined)).toBe(true);
  });

  it('marks a customModelParams.messages override, not the replaced array', async () => {
    const override = [
      { role: 'system', content: 'override rules '.repeat(10) },
      { role: 'user', content: 'override turn' },
    ];
    const wire = await capture('anthropic/claude-sonnet-4-6', convo, {
      customModelParams: { messages: override },
    });
    expect(wire).toHaveLength(2);
    const systemParts = wire[0].content as WirePart[];
    expect(systemParts[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(systemParts[0].text).toBe('override rules '.repeat(10));
    const tailParts = wire[1].content as WirePart[];
    expect(tailParts.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
    // The caller's override array is left as it was given.
    expect(override[0].content).toBe('override rules '.repeat(10));
    expect(override[1].content).toBe('override turn');
  });

  it('cache tail:false marks the system message of a customModelParams.messages override', async () => {
    const override = [
      { role: 'system', content: 'override rules '.repeat(10) },
      { role: 'user', content: 'override turn' },
    ];
    const wire = await capture('anthropic/claude-sonnet-4-6', convo, {
      cache: { tail: false, ttl: '1h' },
      customModelParams: { messages: override },
    });
    const systemParts = wire[0].content as WirePart[];
    expect(systemParts[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(typeof wire[1].content).toBe('string');
    expect(override[0].content).toBe('override rules '.repeat(10));
  });

  it('cache tail:false marks a customModelParams.messages override on the streaming path', async () => {
    const { provider, calls } = await makeProvider();
    const stream = provider.generateCompletionStream('anthropic/claude-sonnet-4-6', convo, {
      cache: { tail: false },
      customModelParams: {
        messages: [
          { role: 'system', content: 'override rules' },
          { role: 'user', content: 'override turn' },
        ],
      },
    });
    for await (const chunk of stream) {
      void chunk;
    }
    const wire = lastChatMessages(calls());
    const systemParts = wire[0].content as WirePart[];
    expect(systemParts[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(typeof wire[1].content).toBe('string');
  });

  it('cache:false strips cache_control from tool definitions, including a customModelParams.tools override', async () => {
    const markedTool = () => ({
      type: 'function',
      function: { name: 'lookup', parameters: { type: 'object' } },
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
    const callerTools = [markedTool()];
    const { provider, calls } = await makeProvider();
    await provider.generateCompletion('anthropic/claude-sonnet-4-6', convo, {
      cache: false,
      tools: callerTools as never,
    });
    const overrideTools = [markedTool()];
    const stream = provider.generateCompletionStream('anthropic/claude-sonnet-4-6', convo, {
      cache: false,
      customModelParams: { tools: overrideTools },
    });
    for await (const chunk of stream) {
      void chunk;
    }
    const chats = calls().filter((c) => c[0] === '/chat/completions');
    expect(chats).toHaveLength(2);
    for (const chat of chats) {
      const tools = (chat[3] as { tools: Array<Record<string, unknown>> }).tools;
      expect(tools).toHaveLength(1);
      expect(tools[0].cache_control).toBeUndefined();
      expect((tools[0].function as { name: string }).name).toBe('lookup');
    }
    // The caller's tool arrays keep their markers (copies are stripped).
    expect(callerTools[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(overrideTools[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('reads caller tool markers from the tools actually sent, after a customModelParams.tools override', async () => {
    const wire = await capture('anthropic/claude-sonnet-4-6', convo, {
      cache: { tail: false },
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', parameters: { type: 'object' } },
          cache_control: { type: 'ephemeral' },
        },
      ],
      customModelParams: {
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      },
    });
    // The marked tools were replaced, so no caller marker goes out and the
    // first system message gets the prefix breakpoint.
    const systemParts = wire[0].content as WirePart[];
    expect(systemParts[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(typeof wire.at(-1)!.content).toBe('string');
  });

  it('cache:false removes a request-level cache_control passed through customModelParams', async () => {
    const { provider, calls } = await makeProvider();
    await provider.generateCompletion('anthropic/claude-sonnet-4-6', convo, {
      cache: false,
      customModelParams: { cache_control: { type: 'ephemeral' } },
    });
    const stream = provider.generateCompletionStream('anthropic/claude-sonnet-4-6', convo, {
      cache: false,
      customModelParams: { cache_control: { type: 'ephemeral' } },
    });
    for await (const chunk of stream) {
      void chunk;
    }
    const chats = calls().filter((c) => c[0] === '/chat/completions');
    expect(chats).toHaveLength(2);
    for (const chat of chats) expect(chat[3]!.cache_control).toBeUndefined();
  });

  it('stands down when a request-level cache_control comes through customModelParams, with a messages override', async () => {
    const { provider, calls } = await makeProvider();
    const override = () => [
      { role: 'system', content: 'override rules '.repeat(10) },
      { role: 'user', content: 'override turn' },
    ];
    await provider.generateCompletion('anthropic/claude-sonnet-4-6', convo, {
      cache: { tail: false },
      customModelParams: { cache_control: { type: 'ephemeral' }, messages: override() },
    });
    const stream = provider.generateCompletionStream('anthropic/claude-sonnet-4-6', convo, {
      cache: { tail: false },
      customModelParams: { cache_control: { type: 'ephemeral' }, messages: override() },
    });
    for await (const chunk of stream) {
      void chunk;
    }
    const chats = calls().filter((c) => c[0] === '/chat/completions');
    expect(chats).toHaveLength(2);
    for (const chat of chats) {
      // The caller owns placement: the root marker goes out as set and no
      // message breakpoint is added beside it.
      expect(chat[3]!.cache_control).toEqual({ type: 'ephemeral' });
      const wire = (chat[3] as { messages: WireMessage[] }).messages;
      expect(wire[0].content).toBe('override rules '.repeat(10));
      expect(wire[1].content).toBe('override turn');
    }
  });

  it('stands down when a request-level cache_control comes through customModelParams', async () => {
    const { provider, calls } = await makeProvider();
    await provider.generateCompletion('anthropic/claude-sonnet-4-6', convo, {
      customModelParams: { cache_control: { type: 'ephemeral' } },
    });
    const chat = calls().filter((c) => c[0] === '/chat/completions').at(-1)!;
    expect(chat[3]!.cache_control).toEqual({ type: 'ephemeral' });
    const wire = (chat[3] as { messages: WireMessage[] }).messages;
    for (const message of wire) expect(typeof message.content).toBe('string');
  });

  it('injects on the streaming path too', async () => {
    const { provider, calls } = await makeProvider();
    const stream = provider.generateCompletionStream(
      'anthropic/claude-sonnet-4-6',
      convo,
      {},
    );
    for await (const chunk of stream) {
      void chunk; // drain — the request fires when the generator starts
    }
    const wire = lastChatMessages(calls());
    expect(Array.isArray(wire[0].content)).toBe(true);
    const systemParts = wire[0].content as WirePart[];
    expect(systemParts[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('marks the fixed first system message of a GMI-shaped request and its tail', async () => {
    const messages = await capture('anthropic/claude-sonnet-4-6', [
      { role: 'system', content: 'Policy' }, { role: 'system', content: 'Clock' }, { role: 'user', content: 'Hello.' },
    ]);
    expect((messages[0].content as WirePart[])[0]).toEqual({ type: 'text', text: 'Policy', cache_control: { type: 'ephemeral' } });
    expect(messages[1].content).toBe('Clock');
    expect((messages[2].content as WirePart[])[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('a gmi send reaches OpenRouter with two system messages and a marked first message', async () => {
    const sent: any[] = [];
    vi.spyOn(OpenRouterProvider.prototype as any, 'makeApiRequest').mockImplementation(async (...args: any[]) => {
      const [endpoint, , , payload, streaming] = args;
      if (endpoint === '/models') return { data: [] };
      sent.push(payload);
      if (!streaming) return chatBody();
      return Readable.from([
        `data: ${JSON.stringify({ id: 'gmi-or', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hi.' }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'gmi-or', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });
    const a = agent({ runtime: 'gmi', provider: 'openrouter', model: 'anthropic/claude-sonnet-4-6',
      apiKey: 'or-gmi-two-blocks', fallbackProviders: [], cognition: { mechanisms: false }, chainOfThought: false,
      systemBlocks: [{ text: 'Policy', cacheBreakpoint: true }, { text: 'Clock' }],
    } as unknown as Parameters<typeof agent>[0]);
    try {
      await a.generate('Hi.');
      expect(sent.length, 'the gmi send reached the provider').toBeGreaterThan(0);
      const messages = sent.at(-1).messages;
      expect(messages.filter((message: any) => message.role === 'system')).toHaveLength(2);
      expect(systemTextOf(messages)).toBe('Policy\n\nClock');
      expect(messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
      expect(messages[1].content).toBe('Clock');
      expect(messages.at(-1).content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    } finally { await a.close(); }
  });
});
