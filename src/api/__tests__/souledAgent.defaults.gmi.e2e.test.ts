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
 * - With cognitive memory on, the mind runs reconsolidation, involuntary recall and temporal gist only where the host
 *   turns one on, and a `gmi()` on its own keeps every mechanism. A mechanism turned on that has nothing to run it on
 *   a souled agent is said in one `memory.mechanism_inactive` line at open.
 * - A turn is stored with a neutral emotional state whatever the mood of the mind; `emotionalStamp: 'mood'` stores
 *   the mood.
 * - Cognitive memory with no embedding provider named, and consolidation turned on, do not open, and nothing is
 *   opened; a named provider is sent the turn's text.
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
import { CognitiveMemoryManager } from '../../cognition/memory/CognitiveMemoryManager';
import { brainOf } from '../../cognition/memory/io/facade/handedBrain';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';

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
        // The root's step: a team whose one seat is the souled member, allowed to launch, and to name whoami for its
        // own team's seat (a nested team's tools stay within its launching seat's).
        reply.tools([{ id: 'l1', name: 'launch_agency', args: { goal: 'Check.', seats: [{ role: 'checker', agentKey: 'aria', tools: ['launch_agency', 'whoami'] }] } }]),
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
    // The root holds whoami too: a launch names for a seat only tools its launching agent has.
    const root = gmi({
      provider: 'openai',
      model: 'stub-model',
      apiKey: k,
      fallbackProviders: [],
      instructions: 'Coordinate.',
      tools: [whoami().tool],
      agencies: { launch: true, maxDepth: 2, members: { aria } },
    } as unknown as Parameters<typeof gmi>[0]);
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

describe('the memory defaults of a souled agent on the GMI runtime', () => {
  /** Cognitive memory on, embedding through the provider it names. */
  const EMBEDDING = { embedding: { provider: 'openai' } };
  /** Plain text replies to spare, each with words of its own. */
  const texts = (): ProviderScript['replies'] => Array.from({ length: 12 }, (_, i) => reply.text(`Noted ${i}.`));

  /** The embedding provider's script, reached by the OpenAI key the environment holds: every text sent to be embedded. */
  function embeddingScript(): ProviderScript {
    const embeddingKey = key();
    const embeddings = script('openai', embeddingKey, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', embeddingKey);
    return embeddings;
  }

  /** `souledAgent()` on the runtime over the soul folder `dir`, on a provider script of its own. */
  function openIn(dir: string, extra: Record<string, unknown>): Promise<SouledAgent> {
    const apiKey = key();
    script('openai', apiKey, { whole: true, replies: texts() });
    return souledAgent({
      runtime: RUNTIME,
      provider: 'openai',
      model: 'stub-model',
      apiKey,
      fallbackProviders: [],
      soul: dir,
      retention: { traces: 'until-deletion' },
      tombstoneKey: 'k-souled-defaults-tombstones',
      ...extra,
    } as unknown as SouledAgentOptions).then((a) => {
      opened.push(a);
      return a;
    });
  }

  /** What `souledAgent()` threw for `extra` over `dir`; undefined when it opened. */
  const refusalOf = (dir: string, extra: Record<string, unknown>): Promise<unknown> =>
    openIn(dir, extra).then(
      () => undefined,
      (error: unknown) => error,
    );

  /** The mechanisms config each cognitive memory manager built in the case was initialised with, in build order. */
  function mechanismsBuilt(): () => unknown[] {
    const built = vi.spyOn(CognitiveMemoryManager.prototype, 'initialize');
    return () => built.mock.calls.map(([config]) => (config as { cognitiveMechanisms?: unknown }).cognitiveMechanisms);
  }

  /** The emotional state of each live trace stored under one user's key, oldest first. */
  async function emotionsOf(a: SouledAgent, userId: string): Promise<Array<Record<string, unknown>>> {
    const brain = brainOf(a.memory!);
    const rows = await brain.all<{ emotions: string }>(
      "SELECT emotions FROM memory_traces WHERE brain_id = ? AND deleted = 0 AND scope = 'conversation' AND scope_id = ? ORDER BY created_at, id",
      [brain.brainId, conversationScopeKey('aria-1', { kind: 'user', id: userId })],
    );
    return rows.map((row) => JSON.parse(row.emotions) as Record<string, unknown>);
  }

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    [
      'with nothing set, reconsolidation, involuntary recall and temporal gist are off and the other mechanisms are as given',
      { memory: EMBEDDING },
      { reconsolidation: { enabled: false }, involuntaryRecall: { enabled: false }, temporalGist: { enabled: false } },
    ],
    [
      "a host's enabled: true turns one on, and its other settings are kept",
      {
        cognition: {
          memory: EMBEDDING,
          mechanisms: {
            reconsolidation: { enabled: true, driftRate: 0.2 },
            temporalGist: { ageThresholdDays: 7 },
            retrievalInducedForgetting: { suppressionFactor: 0.3 },
            emotionRegulation: { enabled: false },
          },
        },
      },
      {
        reconsolidation: { enabled: true, driftRate: 0.2 },
        involuntaryRecall: { enabled: false },
        temporalGist: { ageThresholdDays: 7, enabled: false },
        retrievalInducedForgetting: { suppressionFactor: 0.3 },
        emotionRegulation: { enabled: false },
      },
    ],
    [
      "the agent's cognitiveMechanisms option is read the same way",
      { memory: EMBEDDING, cognitiveMechanisms: { involuntaryRecall: { enabled: true, probability: 0.5 } } },
      { reconsolidation: { enabled: false }, involuntaryRecall: { enabled: true, probability: 0.5 }, temporalGist: { enabled: false } },
    ],
  ])('the mechanisms of the mind: %s', async (_case, extra, expected) => {
    embeddingScript();
    const built = mechanismsBuilt();
    const a = await openIn(soulDir(), extra);

    await a.session('s1', { userId: 'u-42' }).send('Hello there.');

    expect(built().length).toBeGreaterThan(0);
    for (const mechanisms of built()) expect(mechanisms).toEqual(expected);
  });

  it('the mechanisms of the mind: with the mechanisms off, none is turned on', async () => {
    embeddingScript();
    const built = mechanismsBuilt();
    const a = await openIn(soulDir(), { cognition: { memory: EMBEDDING, mechanisms: false } });

    await a.session('s1', { userId: 'u-42' }).send('Hello there.');

    expect(built().length).toBeGreaterThan(0);
    for (const mechanisms of built()) expect(mechanisms).toBeUndefined();
  });

  it('a gmi() on its own keeps every mechanism', async () => {
    embeddingScript();
    const built = mechanismsBuilt();
    const apiKey = key();
    script('openai', apiKey, { whole: true, replies: texts() });
    const plain = gmi({ provider: 'openai', model: 'stub-model', apiKey, fallbackProviders: [], instructions: 'Help.', memory: EMBEDDING } as unknown as Parameters<typeof gmi>[0]);
    try {
      await plain.session('p1', { userId: 'u-42' }).send('Hello there.');

      // An empty config: each mechanism at its default, which is on.
      expect(built().length).toBeGreaterThan(0);
      for (const mechanisms of built()) expect(mechanisms).toEqual({});
    } finally {
      await plain.close();
    }
  });

  it('a mechanism turned on that nothing runs on a souled agent is said once each at open', async () => {
    embeddingScript();
    await openIn(soulDir(), {
      cognition: {
        memory: EMBEDDING,
        mechanisms: {
          temporalGist: { enabled: true },
          involuntaryRecall: { enabled: true },
          personaDrift: { enabled: true },
          // Reconsolidation runs when it is turned on, so nothing is said of it.
          reconsolidation: { enabled: true },
        },
      },
    });

    expect(
      lines('memory.mechanism_inactive')
        .map((line) => line.mechanism)
        .sort(),
    ).toEqual(['involuntaryRecall', 'personaDrift', 'temporalGist']);
  });

  it('nothing is said of a mechanism the host did not turn on', async () => {
    embeddingScript();
    await openIn(soulDir(), { cognition: { memory: EMBEDDING, mechanisms: { temporalGist: { ageThresholdDays: 7 }, personaDrift: { enabled: false } } } });

    expect(lines('memory.mechanism_inactive')).toEqual([]);
  });

  describe('the emotional state a turn is stored with', () => {
    /** A soul whose mind starts frustrated. */
    function frustratedSoul(): string {
      const dir = soulDir();
      fs.writeFileSync(path.join(dir, 'SOUL.md'), '---\nname: Aria\nagentId: aria-1\ndefaultMood: frustrated\n---\nYou are Aria.');
      return dir;
    }

    it.each<[string, Record<string, unknown>]>([
      ['with nothing set', {}],
      ["with emotionalStamp: 'neutral'", { emotionalStamp: 'neutral' }],
    ])('is neutral whatever the mood of the mind, %s', async (_case, stamp) => {
      embeddingScript();
      const a = await openIn(frustratedSoul(), { memory: EMBEDDING, ...stamp });

      const result = await a.session('s1', { userId: 'u-42' }).send('My canary is named LARK-7.');
      await result.memoryWrite;

      // A neutral state as the store keeps it: no valence or dominance, the middle of the arousal scale, no intensity.
      const stored = await emotionsOf(a, 'u-42');
      expect(stored).toHaveLength(2);
      for (const emotions of stored) expect(emotions).toMatchObject({ valence: 0, arousal: 0.5, dominance: 0, intensity: 0, gmiMood: 'neutral' });
    });

    it("is the mood of the mind with emotionalStamp: 'mood'", async () => {
      embeddingScript();
      const a = await openIn(frustratedSoul(), { memory: EMBEDDING, emotionalStamp: 'mood' });

      const result = await a.session('s1', { userId: 'u-42' }).send('My canary is named LARK-7.');
      await result.memoryWrite;

      const stored = await emotionsOf(a, 'u-42');
      expect(stored).toHaveLength(2);
      for (const emotions of stored) {
        expect(emotions).toMatchObject({ gmiMood: 'frustrated', dominance: 0.2 });
        expect(emotions.valence as number).toBeLessThan(0);
        expect(emotions.arousal as number).toBeCloseTo(0.8, 5);
      }
    });
  });

  describe('the embedding provider of cognitive memory', () => {
    it.each<[string, Record<string, unknown>]>([
      ['memory: true', { memory: true }],
      ['a memory config with no embedding', { memory: { recall: { retrieval: 'hybrid' } } }],
      ['an embedding that names a model alone', { memory: { embedding: { model: 'text-embedding-3-small' } } }],
      ['an embedding provider that is blank', { memory: { embedding: { provider: '  ' } } }],
      ["cognition: 'full'", { cognition: 'full' }],
      ['a cognition config with memory on', { cognition: { memory: true, mechanisms: false } }],
    ])('%s does not open, with a key in the environment too, and nothing is opened', async (_case, extra) => {
      // A key in the environment is what picks the provider for a gmi() on its own: it picks nothing here.
      const embeddings = embeddingScript();
      const dir = soulDir();

      const error = await refusalOf(dir, extra);

      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toMatch(/memory\.embedding/);
      expect(fs.existsSync(path.join(dir, 'memory', '.store'))).toBe(false);
      expect(embeddings.embedCalls).toBe(0);
    });

    it("a named provider is sent the turn's text", async () => {
      const embeddings = embeddingScript();
      const a = await openIn(soulDir(), { memory: EMBEDDING });

      const result = await a.session('s1', { userId: 'u-42' }).send('My canary is named LARK-7.');
      await result.memoryWrite;

      expect(embeddings.embedded.some((text) => text.includes('LARK-7'))).toBe(true);
    });

    it.each<[string, Record<string, unknown>]>([
      ['cognitive memory off', {}],
      ["cognition: 'full' with memory off", { cognition: 'full', memory: false }],
    ])('%s opens with no embedding provider named', async (_case, extra) => {
      const a = await openIn(soulDir(), extra);

      expect(a.memory).toBeDefined();
    });
  });

  describe('consolidation', () => {
    it('turned on does not open, says why, and nothing is opened', async () => {
      embeddingScript();
      const dir = soulDir();

      const error = await refusalOf(dir, { memory: { ...EMBEDDING, consolidation: { enabled: true } } });

      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toMatch(/memory\.consolidation/);
      // Why: a cycle can merge two people's traces, and each person is filed under a key of their own.
      expect((error as Error).message).toMatch(/merge/);
      expect((error as Error).message).toMatch(/key/);
      expect(fs.existsSync(path.join(dir, 'memory', '.store'))).toBe(false);
    });

    it('left off, or set off, opens', async () => {
      embeddingScript();
      const a = await openIn(soulDir(), { memory: { ...EMBEDDING, consolidation: { enabled: false } } });

      expect(a.memory).toBeDefined();
    });
  });
});
