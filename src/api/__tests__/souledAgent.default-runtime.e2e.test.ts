/**
 * The runtime a souled agent runs on, end to end over the real souledAgent(), agent(), gmi(), GMI, generateText,
 * provider manager and Memory store; only the OpenAI provider class is stubbed (helpers/stubProviders.ts), at its
 * module boundary.
 *
 * - With no `runtime`, a souled agent runs on the GMI runtime: its handle is a `gmi()` agent's and a session turn
 *   streams its model call, as a GMI does.
 * - That default runs the light profile: no embedding is asked for, the soul's memory provider files the turn, and no
 *   message is scored for sentiment.
 * - A `channels`, `voice` or `avatar` option throws, naming the option. A `responseSchema`, which the GMI runtime does
 *   not read, throws before anything opens.
 * - A session opened with a user id sends no end-user id to the model provider, and the turn's tools still read the
 *   user; `sendUserIdToProvider` sends it.
 * - A front-matter `voice` or `avatar` is left out, with one `soul.field_ignored` line each.
 * - `close()` stops a session turn still running: the turn rejects, and nothing of it is compiled. A host's
 *   `onBeforeGeneration`, `onAfterGeneration` or `onBeforeToolExecution` hook that never answers does not hold it.
 * - An inline soul, and an optional soul that does not load, give a plain agent on the GMI runtime too.
 * - `runtime: 'legacy'` still runs the legacy path: no GMI mark, one whole model call a turn, the three options
 *   accepted, `generate()` validated against a `responseSchema`, no end-user id with or without
 *   `sendUserIdToProvider`, a running turn let finish by `close()`, and a plain legacy agent for an inline soul.
 * - A store written under either runtime opens under the other, each recalling what the other filed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pino from 'pino';
import { z } from 'zod';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

/** The options a case passes beside the route and the soul: `runtime` is left out unless the case names one. */
type Extra = Record<string, unknown>;

/** The three options the GMI runtime has no implementation for, each set to a config that asks for it. */
const UNSUPPORTED: ReadonlyArray<[string, Extra]> = [
  ['channels', { channels: { discord: { token: 'x' } } }],
  ['voice', { voice: { enabled: true } }],
  ['avatar', { avatar: { enabled: true } }],
];

let n = 0;
const key = () => `k-souled-default-runtime-${++n}`;
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

/** A soul folder of its own, holding SOUL.md with `frontmatter` after the name and the id. */
function soulDir(frontmatter = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-default-runtime-e2e-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'SOUL.md'), `---\nname: Aria\nagentId: aria-1\n${frontmatter}---\nYou are Aria.`);
  return dir;
}

/** The store folders (`.store`) anywhere under `dir`: an agent that opened its soul's store made one. */
const storeFoldersIn = (dir: string): string[] =>
  fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((entry) => path.basename(entry) === '.store');

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

/** Replies to spare, each with words of its own. */
const spare = (): ProviderScript['replies'] => Array.from({ length: 12 }, (_, i) => reply.text(`Noted ${i}.`));

/**
 * A souled agent on the stubbed OpenAI provider, in a soul folder of its own. No `runtime` is passed unless `extra`
 * names one: the agent runs on souledAgent()'s default.
 */
async function open(extra: Extra = {}, replies: ProviderScript['replies'] = spare()): Promise<{ a: SouledAgent; s: ProviderScript; told: Array<Record<string, any>> }> {
  const apiKey = key();
  const s = script('openai', apiKey, { whole: true, replies });
  const { seen: told, tool } = whoami();
  const a = await souledAgent({
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    soul: soulDir(),
    retention: { traces: 'until-deletion' },
    tombstoneKey: 'k-souled-default-runtime-tombstones',
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
/** The messages of a model call that carry `id` anywhere, in their text or as the name they are sent under. */
const holdersOf = (call: ModelCall, id: string) =>
  call.messages.map((message) => JSON.stringify(message)).filter((json) => json.includes(id));
/** The texts a model call's `<memory_recall>` block holds, the datamark taken out; none when it has no block. */
const recalledIn = (call: ModelCall): string[] => {
  const OPEN = '<memory_recall>';
  const CLOSE = '</memory_recall>';
  const message = call.messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(OPEN));
  if (!message) return [];
  const { items } = JSON.parse((message.content as unknown as string).slice(OPEN.length, -CLOSE.length)) as { items: Array<{ text: string }> };
  return items.map((item) => item.text.replaceAll('^', ' '));
};
/** Whether a handle is a `gmi()` agent's: the mark `gmi()` puts on the handle it returns. */
const gmiMarkOf = (a: unknown) => (a as { __gmiHandle?: unknown }).__gmiHandle;
/** A model step that calls `whoami` once. */
const askWho = () => reply.tools([{ id: 'c1', name: 'whoami', args: {} }]);
/** A reply the provider holds until `answer` is called, and its opener. */
function held(text: string): { reply: ProviderScript['replies'][number]; answer: () => void } {
  let answer!: () => void;
  const gate = new Promise<void>((resolve) => {
    answer = resolve;
  });
  return { reply: reply.hold([], gate, reply.text(text)), answer };
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('a souled agent with no runtime set', () => {
  it('runs on the GMI runtime: its handle carries the GMI mark, and a session turn streams its model call', async () => {
    const { a, s } = await open({}, [reply.text('Hello.'), ...spare()]);

    expect(gmiMarkOf(a)).toBe(true);
    expect((await a.session('s1').send('Hi.')).text).toBe('Hello.');
    expect(turnCalls(s)).toHaveLength(1);
    // A GMI streams every model call; the legacy path asks for a whole completion on a send.
    expect(turnCalls(s)[0].streamed).toBe(true);
  });

  it('runs the light profile: no embedding is asked for, the soul files the turn, and no sentiment is scored', async () => {
    const { a, s } = await open({}, [reply.text('A canary, lovely.'), ...spare()]);
    await a.session('s1', { userId: 'u-42' }).send('My canary is LARK-7.');

    expect(turnCalls(s).map((call) => call.streamed)).toEqual([true]);
    // Both sides of the turn reach the soul's store through its memory provider: no mind files them.
    await vi.waitFor(async () => expect((await a.exportUserMemory!('u-42')).traces).toHaveLength(2), { timeout: 4_000 });
    const doc = await a.exportUserMemory!('u-42');
    expect(doc.held.traces.map((trace) => trace.filedBy)).toEqual(['soul', 'soul']);
    expect(doc.profiling).toEqual({ sentiment: 'off', moodStamps: 0 });
    // Cognitive memory is off, so nothing was embedded, and no embedding provider is among the recipients.
    expect(s.embedCalls).toBe(0);
    expect((await a.recipients!()).map((recipient) => recipient.role)).not.toContain('embedding');
  });

  it.each(UNSUPPORTED)('throws for a %s option, naming it', async (option, extra) => {
    const k = key();
    script('openai', k, { whole: true, replies: spare() });

    await expect(
      souledAgent({ provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [], soul: soulDir(), ...extra } as unknown as SouledAgentOptions),
    ).rejects.toThrow(`gmi(): '${option}' is not available on the GMI path; remove it or use runtime: 'legacy'.`);
  });

  it('throws for a responseSchema, which the GMI runtime does not read, before anything opens', async () => {
    const k = key();
    script('openai', k, { whole: true, replies: spare() });
    const dir = soulDir();
    const opening = souledAgent({
      provider: 'openai',
      model: 'stub-model',
      apiKey: k,
      fallbackProviders: [],
      soul: dir,
      responseSchema: z.object({ count: z.number() }),
    } as unknown as SouledAgentOptions);

    await expect(opening).rejects.toBeInstanceOf(TypeError);
    await expect(opening).rejects.toThrow(/responseSchema.*runtime: 'legacy'/);
    // Refused before the soul loads: no store folder was made in the soul's workspace.
    expect(storeFoldersIn(dir)).toEqual([]);
  });

  it("sends no end-user id for a session opened with a user id, and the turn's tools still read the user", async () => {
    const { a, s, told } = await open({}, [askWho(), ...spare()]);
    const session = a.session('s1', { userId: 'u-42' });
    await session.send('Who am I?');
    // A second turn: its request carries the first turn's messages as history.
    await session.send('And now?');

    // The first turn's tool step and its reply, then the second turn.
    expect(turnCalls(s)).toHaveLength(3);
    for (const call of turnCalls(s)) {
      expect(call.options.userId).toBeUndefined();
      // Nor as the name a user message is sent under, which OpenAI's Chat Completions API receives.
      expect(holdersOf(call, 'u-42')).toEqual([]);
    }
    expect(told).toHaveLength(1);
    expect(told[0].userContext).toMatchObject({ userId: 'u-42', memorySubject: { kind: 'user', id: 'u-42' } });
    // The GMI's turn knows its user and withholds the id from the provider, by the souled agent's rule.
    expect(told[0].callerTurn).toMatchObject({ providerUserId: 'u-42', withholdUserId: true });
  });

  it('with sendUserIdToProvider, a session turn sends the user id it was opened with', async () => {
    const { a, s } = await open({ sendUserIdToProvider: true }, [askWho(), ...spare()]);
    await a.session('s1', { userId: 'u-42' }).send('Who am I?');

    expect(turnCalls(s)).toHaveLength(2);
    for (const call of turnCalls(s)) expect(call.options.userId).toBe('u-42');
  });

  it('leaves a front-matter voice and avatar out, with one soul.field_ignored line each, and the turn runs', async () => {
    const { a } = await open({ soul: soulDir('voice:\n  provider: elevenlabs\n  voiceId: rachel\navatar:\n  type: static\n') }, [reply.text('Hello.'), ...spare()]);

    expect((await a.session('s1').send('Hi.')).text).toBe('Hello.');
    expect(lines('soul.field_ignored').map((line) => line.field).sort()).toEqual(['avatar', 'voice']);
  });

  it('close() stops a session turn still running: the turn rejects, and nothing of it is compiled', async () => {
    const late = held('Lovely.');
    const { a, s } = await open({ pendingWritesTimeoutMs: 50 }, [late.reply, ...spare()]);
    try {
      const turn = a.session('s1').send('My favourite tea is jasmine.').then(
        () => 'answered',
        () => 'stopped',
      );
      // The turn has reached its model call, which the provider holds.
      await vi.waitFor(() => expect(turnCalls(s)).toHaveLength(1), { timeout: 4_000 });
      await a.close();

      // The reply never came: close() ended the turn, where the legacy runtime leaves it running.
      expect(await Promise.race([turn, sleep(2_000).then(() => 'still running')])).toBe('stopped');
      expect(s.seen.filter(isMerge)).toEqual([]);
    } finally {
      late.answer();
    }
  });

  it.each<[string, ProviderScript['replies']]>([
    ['onBeforeGeneration', [reply.text('Hello.')]],
    ['onAfterGeneration', [reply.text('Hello.')]],
    ['onBeforeToolExecution', [askWho()]],
  ])('close() stops a session turn whose %s hook never answers, and returns', async (hook, replies) => {
    let entered!: () => void;
    const inHook = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const answers: Array<() => void> = [];
    // The host's hook: it is entered and does not answer until the case ends.
    const hang = () => {
      entered();
      return new Promise<undefined>((resolve) => answers.push(() => resolve(undefined)));
    };
    const { a } = await open({ pendingWritesTimeoutMs: 50, [hook]: hang }, [...replies, ...spare()]);
    try {
      const turn = a.session('s1').send('Hi.').then(
        () => 'answered',
        () => 'stopped',
      );
      await inHook;

      // The turn holds its session while the hook runs: close() ends the wait for the hook and the turn.
      expect(await Promise.race([a.close().then(() => 'closed'), sleep(3_000).then(() => 'still closing')])).toBe('closed');
      expect(await Promise.race([turn, sleep(2_000).then(() => 'still running')])).toBe('stopped');
    } finally {
      for (const answer of answers) answer();
    }
  });

  it.each([
    ['an inline soul', { content: 'You are Aria.' }],
    ['an optional soul that does not load', { path: '/no/such/soul-default-runtime', optional: true }],
  ] as const)('gives a plain agent on the GMI runtime for %s', async (_name, soul) => {
    const { a, s } = await open({ soul, retention: undefined, tombstoneKey: undefined }, [reply.text('Hello.'), ...spare()]);

    // No workspace, so no store; the plain agent built in the soul's place runs on the same default.
    expect(a.memory).toBeUndefined();
    expect(gmiMarkOf(a)).toBe(true);
    expect((await a.session('s1').send('Hi.')).text).toBe('Hello.');
    expect(turnCalls(s).map((call) => call.streamed)).toEqual([true]);
  });
});

describe("a souled agent on runtime: 'legacy'", () => {
  it('runs the legacy path: no GMI mark, and a session turn is one whole model call', async () => {
    const { a, s } = await open({ runtime: 'legacy' }, [reply.text('Hello.'), ...spare()]);

    expect(gmiMarkOf(a)).toBeUndefined();
    expect((await a.session('s1').send('Hi.')).text).toBe('Hello.');
    expect(turnCalls(s)).toHaveLength(1);
    expect(turnCalls(s)[0].streamed).toBe(false);
  });

  it.each(UNSUPPORTED)('accepts a %s option, which the GMI runtime refuses', async (_option, extra) => {
    const { a, s } = await open({ runtime: 'legacy', ...extra }, [reply.text('Hello.'), ...spare()]);

    expect(gmiMarkOf(a)).toBeUndefined();
    expect((await a.session('s1').send('Hi.')).text).toBe('Hello.');
    expect(turnCalls(s)[0].streamed).toBe(false);
  });

  it("validates generate() against the agent's responseSchema, which the GMI runtime refuses", async () => {
    const { a } = await open({ runtime: 'legacy', responseSchema: z.object({ count: z.number() }) }, [reply.text('{"count": 3}'), ...spare()]);

    expect((await a.generate('How many?')).parsed).toEqual({ count: 3 });
  });

  it.each([
    ['without sendUserIdToProvider', {}],
    ['with sendUserIdToProvider', { sendUserIdToProvider: true }],
  ] as const)('sends no end-user id for a session opened with a user id, %s', async (_name, extra) => {
    const { a, s, told } = await open({ runtime: 'legacy', ...extra }, [askWho(), ...spare()]);
    await a.session('s1', { userId: 'u-42' }).send('Who am I?');

    expect(turnCalls(s)).toHaveLength(2);
    for (const call of turnCalls(s)) {
      expect(call.options.userId).toBeUndefined();
      expect(holdersOf(call, 'u-42')).toEqual([]);
    }
    // The turn's tool still reads the session's user.
    expect(told).toHaveLength(1);
    expect(told[0].userContext).toMatchObject({ userId: 'u-42' });
  });

  it('close() lets a session turn still running finish, within its wait', async () => {
    const late = held('Lovely.');
    const { a, s } = await open({ runtime: 'legacy' }, [late.reply, ...spare()]);
    const turn = a.session('s1').send('My favourite tea is jasmine.');
    await vi.waitFor(() => expect(turnCalls(s)).toHaveLength(1), { timeout: 4_000 });
    const closing = a.close();
    // The reply arrives while close() is running: the turn answers, and its text is compiled.
    setTimeout(late.answer, 100);
    const [answer] = await Promise.all([turn, closing]);

    expect(answer.text).toBe('Lovely.');
    expect(JSON.stringify(s.seen.filter(isMerge).map((call) => call.messages))).toContain('My favourite tea is jasmine.');
  });

  it('writes no soul.field_ignored line for a front-matter voice or avatar', async () => {
    const { a } = await open(
      { runtime: 'legacy', soul: soulDir('voice:\n  provider: elevenlabs\n  voiceId: rachel\navatar:\n  type: static\n') },
      [reply.text('Hello.'), ...spare()],
    );

    expect((await a.session('s1').send('Hi.')).text).toBe('Hello.');
    expect(lines('soul.field_ignored')).toEqual([]);
  });

  it('gives a plain legacy agent for an inline soul', async () => {
    const { a, s } = await open({ runtime: 'legacy', soul: { content: 'You are Aria.' }, retention: undefined, tombstoneKey: undefined }, [
      reply.text('Hello.'),
      ...spare(),
    ]);

    expect(a.memory).toBeUndefined();
    expect(gmiMarkOf(a)).toBeUndefined();
    expect((await a.session('s1').send('Hi.')).text).toBe('Hello.');
    expect(turnCalls(s).map((call) => call.streamed)).toEqual([false]);
  });
});

describe('a store written under one runtime', () => {
  it("opens under the other with the person's memory, so going back needs no data move", async () => {
    const dir = soulDir();
    const fact = 'My canary Tirwhistle sings at dawn.';
    const asked = 'Tell me about Tirwhistle.';

    const legacy = await open({ runtime: 'legacy', soul: dir }, [reply.text('Lovely.'), ...spare()]);
    await legacy.a.session('s1', { userId: 'u-42' }).send(fact);
    await vi.waitFor(async () => expect((await legacy.a.exportUserMemory!('u-42')).traces).toHaveLength(2), { timeout: 4_000 });
    await legacy.a.close();

    // The default recalls what the legacy runtime filed, and files the next turn beside it.
    const gmi = await open({ soul: dir }, [reply.text('It sings at dawn.'), ...spare()]);
    expect(gmiMarkOf(gmi.a)).toBe(true);
    await gmi.a.session('s2', { userId: 'u-42' }).send(asked);
    expect(recalledIn(turnCalls(gmi.s)[0])).toContain(fact);
    await vi.waitFor(async () => expect((await gmi.a.exportUserMemory!('u-42')).traces).toHaveLength(4), { timeout: 4_000 });
    await gmi.a.close();

    // And back: the legacy runtime recalls what the default filed.
    const back = await open({ runtime: 'legacy', soul: dir }, [reply.text('At dawn.'), ...spare()]);
    expect(gmiMarkOf(back.a)).toBeUndefined();
    await back.a.session('s3', { userId: 'u-42' }).send('When does Tirwhistle sing?');
    expect(recalledIn(turnCalls(back.s)[0])).toEqual(expect.arrayContaining([fact, asked]));
  });
});
