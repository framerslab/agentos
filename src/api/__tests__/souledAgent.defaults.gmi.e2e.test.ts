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
 * - A team a session launches seats its sessions as the session's user and keeps the same rule for the id.
 * - A turn whose tombstone read stalls ends at once when its session closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pino from 'pino';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import { gmi } from '../gmi';
import { buildSessionSeat } from '../runtime/agencyLaunch/sessionSeat';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { ForgottenLedger } from '../../cognition/memory/suppression/ForgottenLedger';

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
 * calls `whoami` once, and every later one is text, unless the case passes replies of its own.
 */
async function open(
  extra: Partial<SouledAgentOptions> = {},
  replies: ProviderScript['replies'] = [reply.tools([{ id: 'c1', name: 'whoami', args: {} }]), ...Array.from({ length: 12 }, (_, i) => reply.text(`Noted ${i}.`))],
): Promise<{ a: SouledAgent; s: ProviderScript; told: Array<Record<string, any>> }> {
  if ((extra as { cognition?: unknown }).cognition !== undefined) {
    // Cognitive memory embeds with the OpenAI key the environment holds: a script of its own records those calls.
    const embeddings = key();
    script('openai', embeddings, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', embeddings);
  }
  const apiKey = key();
  const s = script('openai', apiKey, {
    whole: true,
    replies,
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
/**
 * The messages of a model call that carry `id` anywhere, in their text or as the name they are sent under, each as its
 * role and the words around the id: empty when none does.
 */
const holdersOf = (call: ModelCall, id: string) =>
  call.messages
    .map((message) => ({ role: (message as { role?: string }).role, json: JSON.stringify(message) }))
    .filter(({ json }) => json.includes(id))
    .map(({ role, json }) => ({ role, around: json.slice(Math.max(0, json.indexOf(id) - 160), json.indexOf(id) + 40) }));
/** A model step that launches a one-seat team whose seat may call `whoami`. */
const launchWhoami = (id = 'l1') =>
  reply.tools([
    { id, name: 'launch_agency', args: { goal: 'Check who asks.', seats: [{ role: 'lead', instructions: 'Ask who is asking.', tools: ['whoami'] }] } },
  ]);

describe.each(MEMORY)('the end user id a souled GMI sends, %s', (_name, cognition) => {
  it('a session turn and a seat send no end-user id unless the host opts in, and the tools still read the user', async () => {
    const { a, s, told } = await open(cognition);
    const session = a.session('s1', { userId: 'u-42' });
    await session.send('Who am I?');
    // A second turn: its request carries the first turn's messages as history.
    await session.send('And now?');
    await buildSessionSeat(a, { form: 'persistent', role: 'helper', userId: 'u-42' }).generate('Hello from the team.');

    // The session's first turn (the tool step and the reply), its second turn and the seat's call.
    expect(turnCalls(s)).toHaveLength(4);
    for (const call of turnCalls(s)) {
      expect(call.options.userId).toBeUndefined();
      // Nor as the name a user message is sent under, which OpenAI's Chat Completions API receives.
      expect(holdersOf(call, 'u-42')).toEqual([]);
    }
    // The tool read the session's user and its memory subject; the turn names its user to a tool, with the rule that
    // no provider receives the id, so a team the tool launches seats its sessions as that user and sends no id either.
    expect(told).toHaveLength(1);
    expect(told[0].userContext).toMatchObject({ userId: 'u-42', memorySubject: { kind: 'user', id: 'u-42' } });
    expect(told[0].callerTurn).toMatchObject({ providerUserId: 'u-42', withholdUserId: true });
  });

  it('with sendUserIdToProvider, a session turn and a seat send the user id they were opened with', async () => {
    const { a, s, told } = await open({ ...cognition, sendUserIdToProvider: true });
    await a.session('s1', { userId: 'u-42' }).send('Who am I?');
    await buildSessionSeat(a, { form: 'persistent', role: 'helper', userId: 'u-42' }).generate('Hello from the team.');

    expect(turnCalls(s)).toHaveLength(3);
    for (const call of turnCalls(s)) expect(call.options.userId).toBe('u-42');
    expect(told[0].userContext).toMatchObject({ userId: 'u-42', memorySubject: { kind: 'user', id: 'u-42' } });
    expect(told[0].callerTurn?.providerUserId).toBe('u-42');
    expect(told[0].callerTurn?.withholdUserId).toBeUndefined();
  });

  it('a session opened with no user id sends none, with the opt-in too', async () => {
    const { a, s } = await open({ ...cognition, sendUserIdToProvider: true });
    await a.session('s2').send('Who am I?');

    expect(turnCalls(s)).toHaveLength(2);
    for (const call of turnCalls(s)) expect(call.options.userId).toBeUndefined();
  });
});

describe.each(MEMORY)('a team a souled GMI session launches, %s', (_name, cognition) => {
  /** The root's launch step, the seat's whoami step and its reply, then the root's reply: a fresh script each case. */
  const launch = () => [launchWhoami(), reply.tools([{ id: 'w1', name: 'whoami', args: {} }]), reply.text('Seat done.'), reply.text('All done.')];

  it("seats its session as the launching turn's user, and no call of the team sends the user id", async () => {
    const { a, s, told } = await open({ ...cognition, agencies: { launch: true } } as Partial<SouledAgentOptions>, launch());
    const answer = await a.session('s1', { userId: 'u-42' }).send('Check who asks.');

    expect(answer.text).toBe('All done.');
    // The root's two steps and the seat's two.
    expect(turnCalls(s)).toHaveLength(4);
    for (const call of turnCalls(s)) {
      expect(call.options.userId).toBeUndefined();
      expect(holdersOf(call, 'u-42')).toEqual([]);
    }
    // The seat's tool reads the user the launching session serves, not the seat's own session id.
    expect(told).toHaveLength(1);
    expect(told[0].userContext).toMatchObject({ userId: 'u-42' });
  });

  it('with sendUserIdToProvider, the seat sends the user id as the launching turn does', async () => {
    const { a, s, told } = await open({ ...cognition, agencies: { launch: true }, sendUserIdToProvider: true } as Partial<SouledAgentOptions>, launch());
    await a.session('s1', { userId: 'u-42' }).send('Check who asks.');

    expect(turnCalls(s)).toHaveLength(4);
    for (const call of turnCalls(s)) expect(call.options.userId).toBe('u-42');
    expect(told[0].userContext).toMatchObject({ userId: 'u-42' });
  });
});

describe('a souled GMI seated as a persistent member of a plain gmi() team', () => {
  it('keeps its rule for the id in a team its own seat launches', async () => {
    const k = key();
    const s = script('openai', k, {
      whole: true,
      replies: [
        // The root's step: a team whose one seat is the souled member, allowed to launch.
        reply.tools([{ id: 'l1', name: 'launch_agency', args: { goal: 'Check.', seats: [{ role: 'checker', agentKey: 'aria', tools: ['launch_agency'] }] } }]),
        // The member's seat turn: a team of its own whose seat may call whoami.
        launchWhoami('l2'),
        reply.tools([{ id: 'w1', name: 'whoami', args: {} }]),
        reply.text('Seat done.'),
        reply.text('Checker done.'),
        reply.text('All done.'),
      ],
    });
    const { seen: told, tool } = whoami();
    const aria = await souledAgent({
      runtime: RUNTIME,
      provider: 'openai',
      model: 'stub-model',
      apiKey: k,
      fallbackProviders: [],
      soul: soulDir(),
      retention: { traces: 'until-deletion' },
      tombstoneKey: 'k-souled-defaults-tombstones',
      tools: [tool],
      agencies: { launch: true },
    } as unknown as SouledAgentOptions);
    opened.push(aria);
    const root = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [], instructions: 'Coordinate.', agencies: { launch: true, maxDepth: 2, members: { aria } } });
    try {
      const answer = await root.session('p1', { userId: 'u-42' }).send('Check it.');

      expect(answer.text).toBe('All done.');
      const calls = turnCalls(s);
      // The root's launch, the member's launch, the nested seat's two steps, the member's reply and the root's.
      expect(calls).toHaveLength(6);
      // The root is a plain gmi(), which sends the id it was given.
      expect(calls[0].options.userId).toBe('u-42');
      // The souled member's seat sends none, and neither does the team it launched.
      for (const call of calls.slice(1, 5)) {
        expect(call.options.userId).toBeUndefined();
        expect(holdersOf(call, 'u-42')).toEqual([]);
      }
      // The nested seat's tool still reads the user the root's session serves.
      expect(told).toHaveLength(1);
      expect(told[0].userContext).toMatchObject({ userId: 'u-42' });
    } finally {
      await root.close();
    }
  });
});

describe('a souled GMI turn whose tombstone read stalls, with cognitive memory on', () => {
  it('ends at once when its session closes', async () => {
    // The memory hooks' timeout, which bounds each tombstone read of the turn, is far beyond the case's deadline: only
    // the turn's stop can end the wait in time.
    const beforeGeneration = vi.fn(async () => undefined);
    const { a } = await open({ ...MEMORY[1][1], memoryProviderOptions: { timeoutMs: 30_000 }, onBeforeGeneration: beforeGeneration } as Partial<SouledAgentOptions>);
    // Every tombstone read waits until the case ends.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = ForgottenLedger.prototype.isForgotten;
    let reads = 0;
    vi.spyOn(ForgottenLedger.prototype, 'isForgotten').mockImplementation(async function (this: ForgottenLedger, subject) {
      reads += 1;
      await gate;
      return original.call(this, subject);
    });
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    try {
      const session = a.session('s1', { userId: 'u-42' });
      const outcome = session.send('Who am I?').then(
        () => 'answered',
        () => 'stopped',
      );
      // The turn waits on its read, before its model call.
      await vi.waitFor(() => expect(reads).toBeGreaterThan(0), { timeout: 10_000 });
      const deadline = sleep(3000).then(() => 'still waiting');
      const closed = session.close().then(() => 'closed');

      expect(await Promise.race([closed, deadline])).toBe('closed');
      expect(await Promise.race([outcome, deadline])).toBe('stopped');
      // The stopped turn started nothing more: no model call was prepared.
      expect(beforeGeneration).not.toHaveBeenCalled();
    } finally {
      release();
    }
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
    const { a, s } = await open({ ...soul, sendUserIdToProvider: true });
    await a.session('s1', { userId: 'u-42' }).send('Who am I?');

    expect(turnCalls(s)).toHaveLength(2);
    for (const call of turnCalls(s)) expect(call.options.userId).toBe('u-42');
  });
});
