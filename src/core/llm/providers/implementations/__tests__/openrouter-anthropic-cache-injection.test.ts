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

  it('cache:false leaves the request untouched', async () => {
    const wire = await capture('anthropic/claude-sonnet-4-6', convo, { cache: false });
    for (const m of wire) expect(typeof m.content).toBe('string');
  });

  it('AGENTOS_ANTHROPIC_AUTO_CACHE=0 disables injection', async () => {
    process.env.AGENTOS_ANTHROPIC_AUTO_CACHE = '0';
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
});
