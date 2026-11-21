/**
 * What a souled agent on the GMI runtime sends the model provider about the person a session serves, end to end over
 * the real souledAgent(), gmi(), GMI, generateText, provider manager and Memory store; only the OpenAI provider class
 * is stubbed (helpers/stubProviders.ts), at its module boundary.
 *
 * - A session turn sends no end-user id to the provider unless the host sets `sendUserIdToProvider`, with cognitive
 *   memory off and on, and a seat session sends none either. The turn's tools still read the session's user.
 * - A session whose user id no memory key can be built from runs its turn, and one `memory.hook_failed` line names
 *   the soul's turn memory.
 * - An inline soul, and an optional soul that does not load, give a plain agent: it keeps the same rule for the id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pino from 'pino';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import { buildSessionSeat } from '../runtime/agencyLaunch/sessionSeat';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

/** The runtime every case runs on. */
const RUNTIME = 'gmi' as const;

/** The cognitive memory settings the end-user id cases run under: off (the light profile's default), and on. */
const MEMORY: ReadonlyArray<[string, Partial<SouledAgentOptions>]> = [
  ['cognitive memory off', {}],
  ['cognitive memory on', { cognition: { memory: { embedding: { provider: 'openai' } }, mechanisms: false } } as Partial<SouledAgentOptions>],
];

let n = 0;
const key = () => `k-souled-defaults-${++n}`;
const dirs: string[] = [];
const opened: SouledAgent[] = [];
/** Every line the library logged in the test, parsed. */
let events: Array<Record<string, unknown>>;
beforeEach(() => {
  globalLLMProviderHealth.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  events = [];
  setLogger(
    pino(
      { level: 'debug', base: undefined },
      {
        write(line: string) {
          events.push(JSON.parse(line));
        },
      },
    ),
  );
});
afterEach(async () => {
  while (opened.length) await opened.pop()!.close().catch(() => undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetLoggerFactory();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** The logged lines of one event. */
const lines = (event: string) => events.filter((line) => line.event === event);

/** A soul folder of its own, holding SOUL.md. */
function soulDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-defaults-gmi-e2e-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'SOUL.md'), '---\nname: Aria\nagentId: aria-1\n---\nYou are Aria.');
  return dir;
}

/** A tool that records the context each of its calls is given. */
function whoami() {
  const seen: Array<Record<string, any>> = [];
  const tool = {
    name: 'whoami',
    description: 'Says who is asking.',
    inputSchema: { type: 'object', properties: {} },
    execute: async (_args: unknown, context: Record<string, any>) => {
      seen.push(context);
      return { success: true, output: 'ok' };
    },
  };
  return { seen, tool };
}

/**
 * A souled agent on the stubbed OpenAI provider, on the runtime, in a soul folder of its own. Its script's first reply
 * calls `whoami` once, and every later one is text.
 */
async function open(extra: Partial<SouledAgentOptions> = {}): Promise<{ a: SouledAgent; s: ProviderScript; told: Array<Record<string, any>> }> {
  if ((extra as { cognition?: unknown }).cognition !== undefined) {
    // Cognitive memory embeds with the OpenAI key the environment holds: a script of its own records those calls.
    const embeddings = key();
    script('openai', embeddings, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', embeddings);
  }
  const apiKey = key();
  const s = script('openai', apiKey, {
    whole: true,
    replies: [reply.tools([{ id: 'c1', name: 'whoami', args: {} }]), ...Array.from({ length: 12 }, (_, i) => reply.text(`Noted ${i}.`))],
  });
  const { seen: told, tool } = whoami();
  const a = await souledAgent({
    runtime: RUNTIME,
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    soul: soulDir(),
    retention: { traces: 'until-deletion' },
    tombstoneKey: 'k-souled-defaults-tombstones',
    tools: [tool],
    ...extra,
  } as unknown as SouledAgentOptions);
  opened.push(a);
  return { a, s, told };
}

type ModelCall = ProviderScript['seen'][number];
/** True for a model call that merged traces into a wiki page. */
const isMerge = (call: ModelCall) => JSON.stringify(call.messages).includes('You maintain a knowledge wiki page');
/** The turns' model calls: every call but a wiki merge. */
const turnCalls = (s: ProviderScript) => s.seen.filter((call) => !isMerge(call));

describe.each(MEMORY)('the end user id a souled GMI sends, %s', (_name, cognition) => {
  it('a session turn and a seat send no end-user id unless the host opts in, and the tools still read the user', async () => {
    const { a, s, told } = await open(cognition);
    await a.session('s1', { userId: 'u-42' }).send('Who am I?');
    await buildSessionSeat(a, { form: 'persistent', role: 'helper', userId: 'u-42' }).generate('Hello from the team.');

    // The session's two calls (the tool step and the reply) and the seat's call.
    expect(turnCalls(s)).toHaveLength(3);
    for (const call of turnCalls(s)) expect(call.options.userId).toBeUndefined();
    // The tool read the session's user and its memory subject, and is handed no id to pass to a provider.
    expect(told).toHaveLength(1);
    expect(told[0].userContext).toMatchObject({ userId: 'u-42', memorySubject: { kind: 'user', id: 'u-42' } });
    expect(told[0].callerTurn?.providerUserId).toBeUndefined();
  });

  it('with sendUserIdToProvider, a session turn and a seat send the user id they were opened with', async () => {
    const { a, s, told } = await open({ ...cognition, sendUserIdToProvider: true } as never);
    await a.session('s1', { userId: 'u-42' }).send('Who am I?');
    await buildSessionSeat(a, { form: 'persistent', role: 'helper', userId: 'u-42' }).generate('Hello from the team.');

    expect(turnCalls(s)).toHaveLength(3);
    for (const call of turnCalls(s)) expect(call.options.userId).toBe('u-42');
    expect(told[0].userContext).toMatchObject({ userId: 'u-42', memorySubject: { kind: 'user', id: 'u-42' } });
    expect(told[0].callerTurn?.providerUserId).toBe('u-42');
  });

  it('a session opened with no user id sends none, with the opt-in too', async () => {
    const { a, s } = await open({ ...cognition, sendUserIdToProvider: true } as never);
    await a.session('s2').send('Who am I?');

    expect(turnCalls(s)).toHaveLength(2);
    for (const call of turnCalls(s)) expect(call.options.userId).toBeUndefined();
  });
});

describe("a session whose user id no memory key can be built from, on the souled agent's runtime", () => {
  it("runs its turn, with one memory.hook_failed line for the soul's turn memory", async () => {
    const { a, s } = await open();
    const answer = await a.session('sx', { userId: 'm\uD800' }).send('Are we open from nine?');

    expect(answer.text).toBe('Noted 0.');
    expect(turnCalls(s)).toHaveLength(2);
    expect(lines('memory.hook_failed').filter((line) => line.hook === 'soulMemory')).toHaveLength(1);
  });
});

describe('a souled agent that falls back to a plain agent on the GMI runtime', () => {
  const FALLBACKS: ReadonlyArray<[string, Partial<SouledAgentOptions>]> = [
    ['an inline soul', { soul: { content: '---\nname: Aria\nagentId: aria-1\n---\nYou are Aria.' } } as Partial<SouledAgentOptions>],
    ['an optional soul that does not load', { soul: { path: '/no/such/soul-defaults-gmi', optional: true } } as Partial<SouledAgentOptions>],
  ];

  it.each(FALLBACKS)('%s sends no end-user id unless the host opts in', async (_case, soul) => {
    const { a, s, told } = await open(soul);
    await a.session('s1', { userId: 'u-42' }).send('Who am I?');

    expect(turnCalls(s)).toHaveLength(2);
    for (const call of turnCalls(s)) expect(call.options.userId).toBeUndefined();
    expect(told[0].userContext).toMatchObject({ userId: 'u-42' });
  });

  it.each(FALLBACKS)('%s sends the user id with sendUserIdToProvider', async (_case, soul) => {
    const { a, s } = await open({ ...soul, sendUserIdToProvider: true } as never);
    await a.session('s1', { userId: 'u-42' }).send('Who am I?');

    expect(turnCalls(s)).toHaveLength(2);
    for (const call of turnCalls(s)) expect(call.options.userId).toBe('u-42');
  });
});
