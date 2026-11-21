/**
 * What the host's memory policy answers for a minor and for a person who objects to profiling, and which answer a
 * session follows, end to end over the real souledAgent(), agent, generateText, provider manager, Memory store and
 * wiki compiler; only the OpenAI and Anthropic provider classes are stubbed (helpers/stubProviders.ts), at their
 * module boundary. Every case runs on the default runtime and on `runtime: 'gmi'` with cognitive memory off.
 *
 * - `minor: true` on a store that keeps the person's memory until deletion, or on an agent with no `retention`, keeps
 *   no long-term memory for them, whatever `retentionDays` the answer holds: nothing of their turns is filed, they
 *   recall the operator's pages alone, a trace stored before stays, and one `memory.write_refused` line a session
 *   says `minor_no_retention`.
 * - A minor on a store that keeps memory for a number of days is compiled only by the target `compile.minors` names;
 *   without one, nothing of theirs is compiled and `memory.compile_skipped` says `minor_no_compile`. `compile.minors`
 *   names a provider and a model, or the agent does not open. That target takes no other provider's place when it has
 *   no key, and the agent's own key goes to it only when the agent names that provider. Each merge of a compile follows
 *   the person's latest answer.
 * - `profiling: 'off'` and `minor: true` are valid with exactly those values; any other value fails closed.
 * - A later answer for a person, given to any session, replaces the answer another session of theirs keeps from that
 *   session's next turn, and a later failure makes it ask again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async () => ({ AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic') }));
vi.mock('../../core/llm/providers/implementations/OpenRouterProvider', async () => ({ OpenRouterProvider: (await import('./helpers/stubProviders')).stubProviderClass('openrouter') }));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { souledAgent, type MemoryPolicy, type MemoryRetention, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { clearDefaultProvider, setDefaultProvider } from '../runtime/global-default';

/** The runtimes every case runs on: the default runtime, and the GMI runtime with cognitive memory off. */
const RUNTIMES = ['legacy', 'gmi'] as const;

/** The operator's page every case's folder holds, and the line of it a recall shows. */
const OPS_LINE = 'Open nine to five.';
const OPS = `---\nid: concepts/ops\ntype: concept\nsummary: Opening hours\n---\n${OPS_LINE}\n`;

let n = 0;
let dir: string;
const opened: SouledAgent[] = [];
/** Every line the library logged in the test, parsed. */
let events: Array<Record<string, unknown>>;
beforeEach(() => {
  globalLLMProviderHealth.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-policy-answers-e2e-'));
  fs.writeFileSync(path.join(dir, 'SOUL.md'), '---\nname: Aria\nagentId: aria-1\n---\nYou are Aria.');
  fs.mkdirSync(path.join(dir, 'memory', 'concepts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'concepts', 'ops.md'), OPS);
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
  clearDefaultProvider();
  resetLoggerFactory();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The logged lines of one event. */
const lines = (event: string) => events.filter((line) => line.event === event);
/** The policy hook's failures. */
const policyFailures = () => lines('memory.hook_failed').filter((line) => line.hook === 'memoryPolicy');

const keyOf = (subject: { kind: 'user' | 'session'; id: string }) => conversationScopeKey('aria-1', subject);
const userKey = (id: string) => keyOf({ kind: 'user', id });

/** Rows of the store's file, read by a connection of the test's own once every agent on it is closed. */
function rows<T>(sql: string, params: unknown[] = []): T[] {
  const db = new Database(path.join(dir, 'memory', '.store', 'memory.sqlite'), { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}
/** The texts of the live conversation traces the store holds under one key, oldest first; a page's chunks are not. */
const textsUnder = (key: string) =>
  rows<{ content: string; tags: string }>(
    "SELECT content, tags FROM memory_traces WHERE scope = 'conversation' AND scope_id = ? AND deleted = 0 ORDER BY created_at, id",
    [key],
  )
    .filter((row) => !(JSON.parse(row.tags) as string[]).includes('wiki'))
    .map((row) => row.content);
/** The page rows the store holds under one key. */
const pagesUnder = (key: string) => rows<{ page_id: string }>('SELECT page_id FROM memory_pages WHERE scope_id = ?', [key]);

type ModelCall = ProviderScript['seen'][number];
/** True for a model call that merged traces into a wiki page. */
const isMerge = (call: ModelCall) => JSON.stringify(call.messages).includes('You maintain a knowledge wiki page');
/** The last model call of a turn: the last one that is not a wiki merge. */
const lastCall = (s: ProviderScript): ModelCall => {
  const turns = s.seen.filter((call) => !isMerge(call));
  return turns[turns.length - 1];
};
/** Every text the recall block of one model call holds, its spaces restored; none when the call has no block. */
const recalledIn = (call: ModelCall): string[] => {
  const OPEN = '<memory_recall>';
  const CLOSE = '</memory_recall>';
  const message = call.messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(OPEN));
  if (!message) return [];
  const { items } = JSON.parse((message.content as unknown as string).slice(OPEN.length, -CLOSE.length)) as { items: Array<{ text: string }> };
  return items.map((item) => item.text.replaceAll('^', ' '));
};

describe.each(RUNTIMES)('policy answers, on runtime %s', (runtime) => {
  /** A souled agent on the stubbed OpenAI provider, on `runtime`, with a script of its own. */
  async function open(extra: Partial<SouledAgentOptions> = {}): Promise<{ a: SouledAgent; s: ProviderScript }> {
    const apiKey = `k-souled-policy-answers-${++n}`;
    const s = script('openai', apiKey, { whole: true, replies: Array.from({ length: 40 }, (_, i) => reply.text(`Noted ${i}.`)) });
    const a = await souledAgent({
      runtime,
      provider: 'openai',
      model: 'stub-model',
      apiKey,
      fallbackProviders: [],
      soul: dir,
      ...extra,
    } as unknown as SouledAgentOptions);
    opened.push(a);
    return { a, s };
  }
  /** Closes an agent the case is done with: close() waits for its writes and compiles. */
  async function closed(a: SouledAgent): Promise<void> {
    opened.splice(opened.indexOf(a), 1);
    await a.close();
  }
  /** One turn of a session, opened for `userId` when one is given. */
  const say = (a: SouledAgent, session: string, userId: string | undefined, text: string) =>
    a.session(session, userId !== undefined ? { userId } : undefined).send(text);

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  describe('a minor on a store that keeps memory until deletion', () => {
    it.each<[string, MemoryRetention | undefined, MemoryPolicy, 'user' | 'session']>([
      ['a user, traces kept until deletion', { traces: 'until-deletion' }, { longTerm: 'compiled', minor: true }, 'user'],
      ['a user, with retentionDays on the answer', { traces: 'until-deletion' }, { longTerm: 'compiled', retentionDays: 7, minor: true }, 'user'],
      ['a user, on an agent with no retention', undefined, { longTerm: 'compiled', minor: true }, 'user'],
      ['a user answered raw, traces kept until deletion', { traces: 'until-deletion' }, { longTerm: 'raw', minor: true }, 'user'],
      ['a user, traces kept until deletion and sessions for days', { traces: 'until-deletion', sessions: { days: 30 } }, { longTerm: 'compiled', minor: true }, 'user'],
      ['a session, sessions kept until deletion and traces for days', { traces: { days: 30 }, sessions: 'until-deletion' }, { longTerm: 'compiled', minor: true }, 'session'],
    ])('keeps no long-term memory: %s', async (_case, retention, answer, kind) => {
      const subject = kind === 'user' ? { kind, id: 'alice' } : { kind, id: 's1' };
      const key = keyOf(subject);
      let asked = 0;
      const { a, s } = await open({
        ...(retention ? { retention } : {}),
        memoryPolicy: () => {
          asked += 1;
          return answer;
        },
      });
      // A trace of the person's, stored before the turns.
      await a.memory!.remember('Alice opens at nine herself.', { type: 'episodic', scope: 'conversation', scopeId: key });
      const userId = kind === 'user' ? 'alice' : undefined;

      await say(a, 's1', userId, 'Is it open from nine?');
      const recalled = recalledIn(lastCall(s));
      expect(recalled).toContain(OPS_LINE);
      expect(recalled).not.toContain('Alice opens at nine herself.');
      await say(a, 's1', userId, 'My owl is named Wexford.');
      await closed(a);

      // Nothing of the two turns was filed; the trace stored before them stands.
      expect(textsUnder(key)).toEqual(['Alice opens at nine herself.']);
      expect(policyFailures()).toEqual([]);
      expect(lines('memory.write_refused')).toHaveLength(1);
      expect(lines('memory.write_refused')[0]).toMatchObject({ reason: 'minor_no_retention' });
      expect(JSON.stringify(lines('memory.write_refused'))).not.toMatch(/alice|s1|Wexford/);
      // The session kept its answer: one ask for the two turns.
      expect(asked).toBe(1);
    });
  });

  describe('the compile of a minor on a store that keeps memory for days', () => {
    it('is run by the provider named for minors alone, and an adult on the agent compiles on its own route', async () => {
      const minorsKey = `k-souled-policy-answers-minors-${++n}`;
      const minors = script('anthropic', minorsKey, {
        whole: true,
        replies: Array.from({ length: 10 }, () => reply.text('Owl notes.')),
      });
      const { a, s } = await open({
        retention: { traces: { days: 30 } },
        tombstoneKey: 'k-souled-policy-answers-tombstones',
        compile: { minors: { provider: 'anthropic', model: 'stub-minor', apiKey: minorsKey } },
        memoryPolicy: (context) => (context.userId === 'alice' ? { longTerm: 'compiled', minor: true } : { longTerm: 'compiled' }),
      });
      await say(a, 's1', 'alice', 'My owl is named Wexford.');
      await say(a, 's2', 'bob', 'My crab is named Pellam.');
      await closed(a);

      // The minor's turn is filed, and her page is compiled on the target named for minors.
      expect(textsUnder(userKey('alice'))).toContain('My owl is named Wexford.');
      const minorMerges = minors.seen.filter(isMerge);
      expect(minorMerges).toHaveLength(1);
      expect(minorMerges[0].modelId).toBe('stub-minor');
      expect(JSON.stringify(minorMerges[0].messages)).toContain('Wexford');
      expect(JSON.stringify(minorMerges[0].messages)).not.toContain('Pellam');
      expect(pagesUnder(userKey('alice'))).toHaveLength(1);
      // None of her text reached the agent's own provider in a compile; the adult's page compiled there.
      const agentMerges = s.seen.filter(isMerge).map((call) => JSON.stringify(call.messages));
      expect(agentMerges).toHaveLength(1);
      expect(agentMerges[0]).toContain('Pellam');
      expect(agentMerges[0]).not.toContain('Wexford');
      expect(pagesUnder(userKey('bob'))).toHaveLength(1);
    });

    it("is never sent to OpenRouter in place of the provider named for minors when that provider has no key", async () => {
      const routerKey = `k-souled-policy-answers-router-${++n}`;
      const router = script('openrouter', routerKey, { whole: true, replies: Array.from({ length: 10 }, () => reply.text('Owl notes.')) });
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('ANTHROPIC_BASE_URL', '');
      vi.stubEnv('OPENROUTER_BASE_URL', '');
      vi.stubEnv('OPENROUTER_API_KEY', routerKey);
      const { a, s } = await open({
        retention: { traces: { days: 30 } },
        compile: { minors: { provider: 'anthropic', model: 'stub-minor' } },
        memoryPolicy: () => ({ longTerm: 'compiled', minor: true }),
      });
      await say(a, 's1', 'alice', 'My owl is named Wexford.');
      await closed(a);

      // Her turn is filed; with no key for the provider named for minors, her page is compiled nowhere.
      expect(textsUnder(userKey('alice'))).toContain('My owl is named Wexford.');
      expect(router.seen).toEqual([]);
      expect(s.seen.filter(isMerge)).toEqual([]);
      expect(pagesUnder(userKey('alice'))).toEqual([]);
    });

    it("takes the agent's own key only to a provider the agent names", async () => {
      // The agent names no provider: the host's default names OpenAI, and the agent's key is set for that.
      const agentKey = `k-souled-policy-answers-${++n}`;
      const s = script('openai', agentKey, { whole: true, replies: Array.from({ length: 40 }, (_, i) => reply.text(`Noted ${i}.`)) });
      // Started only if the agent's key reaches Anthropic.
      const sentAgentKey = script('anthropic', agentKey, { whole: true, replies: Array.from({ length: 10 }, () => reply.text('Owl notes.')) });
      const minorsKey = `k-souled-policy-answers-minors-env-${++n}`;
      const minors = script('anthropic', minorsKey, { whole: true, replies: Array.from({ length: 10 }, () => reply.text('Owl notes.')) });
      vi.stubEnv('ANTHROPIC_API_KEY', minorsKey);
      setDefaultProvider({ provider: 'openai', model: 'stub-model' });
      const a = await souledAgent({
        runtime,
        apiKey: agentKey,
        fallbackProviders: [],
        soul: dir,
        retention: { traces: { days: 30 } },
        compile: { minors: { provider: 'anthropic', model: 'stub-minor' } },
        memoryPolicy: () => ({ longTerm: 'compiled', minor: true }),
      } as unknown as SouledAgentOptions);
      opened.push(a);
      await say(a, 's1', 'alice', 'My owl is named Wexford.');
      await closed(a);

      // Her page is compiled on Anthropic's own key from the environment, never on the key set for OpenAI.
      expect(sentAgentKey.seen).toEqual([]);
      const minorMerges = minors.seen.filter(isMerge);
      expect(minorMerges).toHaveLength(1);
      expect(JSON.stringify(minorMerges[0].messages)).toContain('Wexford');
      expect(s.seen.filter(isMerge)).toEqual([]);
    });

    it("takes the agent's own key only to a provider the agent names, never to one the environment picks for it", async () => {
      // The agent names a plain model and no provider: the environment picks OpenAI for it, and its key is set for that.
      vi.stubEnv('OPENROUTER_API_KEY', '');
      vi.stubEnv('OPENROUTER_BASE_URL', '');
      const envKey = `k-souled-policy-answers-openai-env-${++n}`;
      vi.stubEnv('OPENAI_API_KEY', envKey);
      const agentKey = `k-souled-policy-answers-${++n}`;
      const s = script('openai', agentKey, { whole: true, replies: Array.from({ length: 40 }, (_, i) => reply.text(`Noted ${i}.`)) });
      const minors = script('openai', envKey, { whole: true, replies: Array.from({ length: 10 }, () => reply.text('Owl notes.')) });
      const a = await souledAgent({
        runtime,
        model: 'stub-model',
        apiKey: agentKey,
        fallbackProviders: [],
        soul: dir,
        retention: { traces: { days: 30 } },
        compile: { minors: { provider: 'openai', model: 'stub-minor' } },
        memoryPolicy: () => ({ longTerm: 'compiled', minor: true }),
      } as unknown as SouledAgentOptions);
      opened.push(a);
      await say(a, 's1', 'alice', 'My owl is named Wexford.');
      await closed(a);

      // Her page is compiled on OpenAI's key from the environment: the agent's own key went with no merge.
      expect(s.seen.filter(isMerge)).toEqual([]);
      const minorMerges = minors.seen.filter(isMerge);
      expect(minorMerges).toHaveLength(1);
      expect(minorMerges[0].modelId).toBe('stub-minor');
      expect(JSON.stringify(minorMerges[0].messages)).toContain('Wexford');
    });

    it("follows the person's latest answer at each merge, so a minor's answer given during a compile holds for its next merge", async () => {
      const minorsKey = `k-souled-policy-answers-minors-${++n}`;
      const minors = script('anthropic', minorsKey, { whole: true, replies: Array.from({ length: 10 }, () => reply.text('Child notes.')) });
      let asked = 0;
      const { a, s } = await open({
        retention: { traces: { days: 30 } },
        compile: { minors: { provider: 'anthropic', model: 'stub-minor', apiKey: minorsKey } },
        memoryPolicy: (context) => {
          asked += 1;
          return context.sessionId === 'sb' ? { longTerm: 'compiled', minor: true } : { longTerm: 'compiled' };
        },
      });
      const key = userKey('alice');
      await say(a, 'sa', 'alice', 'My owl is named Wexford.');
      await vi.waitFor(async () => expect(await a.memory!.countScope('conversation', key)).toBe(2), { timeout: 4_000 });
      // Two more traces of hers, each of its own entity: the compile merges three pages, one after another.
      await a.memory!.remember('Owl Wexford hunts at dusk.', { type: 'episodic', scope: 'conversation', scopeId: key, entities: ['Owl'] });
      await a.memory!.remember('Crab Pellam lives in a tank.', { type: 'episodic', scope: 'conversation', scopeId: key, entities: ['Crab'] });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The compile's first merge, on the agent's own route, is held open.
      s.replies.unshift(reply.hold([], gate, reply.text('Adult notes.')));
      const compiling = a.memory!.compileWiki({ reason: 'explicit', scopes: [key] });
      await vi.waitFor(() => expect(s.seen.filter(isMerge)).toHaveLength(1), { timeout: 4_000 });
      // Meanwhile the host answers minor for her, in another session.
      const turn = say(a, 'sb', 'alice', 'I am twelve.');
      await vi.waitFor(() => expect(asked).toBe(2), { timeout: 4_000 });
      release();
      await compiling;
      await turn;

      // Within that one compile, before close() compiles again: the merge sent before the answer went where it went,
      // and each later merge went to the target named for minors.
      const agentMerges = s.seen.filter(isMerge).map((call) => JSON.stringify(call.messages));
      expect(agentMerges).toHaveLength(1);
      expect(agentMerges[0]).not.toMatch(/hunts at dusk|Pellam/);
      const minorMerges = minors.seen.filter(isMerge).map((call) => JSON.stringify(call.messages));
      expect(minorMerges).toHaveLength(2);
      expect(minorMerges.join('\n')).toContain('hunts at dusk');
      expect(minorMerges.join('\n')).toContain('Pellam');
      expect(lines('memory.compile_skipped')).toEqual([]);
      await closed(a);
    });

    it('is not run without compile.minors, and says minor_no_compile', async () => {
      const { a, s } = await open({
        retention: { traces: { days: 30 } },
        memoryPolicy: () => ({ longTerm: 'compiled', minor: true }),
      });
      await say(a, 's1', 'alice', 'My owl is named Wexford.');
      await closed(a);

      // Her turn is filed as usual, both sides of it; nothing of it is compiled anywhere.
      const texts = textsUnder(userKey('alice'));
      expect(texts).toContain('My owl is named Wexford.');
      expect(texts).toHaveLength(2);
      expect(s.seen.filter(isMerge)).toEqual([]);
      expect(pagesUnder(userKey('alice'))).toEqual([]);
      expect(lines('memory.compile_skipped').map((line) => line.reason)).toContain('minor_no_compile');
      expect(lines('memory.write_refused')).toEqual([]);
    });
  });

  describe('compile.minors names a provider and a model', () => {
    it.each<[string, unknown]>([
      ['an empty target', {}],
      ['a provider and no model', { provider: 'anthropic' }],
      ['an empty provider', { provider: '', model: 'm' }],
      ['an empty model', { provider: 'anthropic', model: '' }],
      ['nothing', null],
      ['a word', 'anthropic'],
      // The prefix would take the compile, and the child's text, to the other provider on its key from the environment.
      ['a model whose prefix names another provider', { provider: 'openai', model: 'anthropic:stub-minor' }],
    ])('refuses %s before anything opens', async (_case, minors) => {
      // Each target is one a host can build from configuration that is not there; none of them type-checks.
      const opening = open({ retention: { traces: { days: 30 } }, compile: { minors } as never });
      await expect(opening).rejects.toThrow(TypeError);
      await expect(opening).rejects.toThrow(/compile\.minors/);
      expect(fs.existsSync(path.join(dir, 'memory', '.store'))).toBe(false);
    });
  });

  describe('the forms an answer takes', () => {
    it.each<[string, Record<string, unknown>]>([
      ['minor: false', { longTerm: 'compiled', minor: false }],
      ["profiling: 'on'", { longTerm: 'compiled', profiling: 'on' }],
      ["minor: 'true'", { longTerm: 'raw', minor: 'true' }],
      ['profiling: true', { longTerm: 'off', profiling: true }],
    ])('an answer with %s fails closed', async (_case, answer) => {
      // Each answer is one a host's code can return at run time; none of them type-checks.
      const { a } = await open({ retention: { traces: { days: 30 } }, memoryPolicy: () => answer as never });
      await say(a, 's1', 'alice', 'My owl is named Wexford.');
      await closed(a);

      expect(textsUnder(userKey('alice'))).toEqual([]);
      expect(policyFailures().length).toBeGreaterThan(0);
      for (const line of policyFailures()) expect(line).toMatchObject({ code: 'MEMORY_HOOK_MALFORMED' });
      for (const line of lines('memory.write_refused')) expect(line).toMatchObject({ reason: 'policy_failed' });
    });

    it("an answer with profiling: 'off' files, recalls and compiles as its longTerm says", async () => {
      const { a } = await open({ memoryPolicy: () => ({ longTerm: 'compiled', profiling: 'off' }) });
      await say(a, 's1', 'alice', 'My owl is named Wexford.');
      await closed(a);

      expect(textsUnder(userKey('alice'))).toContain('My owl is named Wexford.');
      expect(pagesUnder(userKey('alice'))).toHaveLength(1);
      expect(policyFailures()).toEqual([]);
      expect(lines('memory.write_refused')).toEqual([]);
    });
  });

  describe("a person's newest answer", () => {
    it("replaces the answer another session of theirs keeps, from that session's next turn", async () => {
      let asked = 0;
      const { a } = await open({
        memoryPolicy: (context) => {
          asked += 1;
          return context.sessionId === 'sb' ? { longTerm: 'off' } : { longTerm: 'compiled' };
        },
      });
      await say(a, 'sa', 'alice', 'My owl is named Wexford.');
      await vi.waitFor(async () => expect(await a.memory!.countScope('conversation', userKey('alice'))).toBe(2), { timeout: 4_000 });
      // The host answers off for the same person in another session.
      await say(a, 'sb', 'alice', 'Keep nothing of me.');
      await say(a, 'sa', 'alice', 'My crab is named Pellam.');
      await closed(a);

      // Session sa follows the newest answer on its next turn, with no new ask.
      expect(asked).toBe(2);
      const texts = textsUnder(userKey('alice'));
      expect(texts).toContain('My owl is named Wexford.');
      expect(texts).not.toContain('My crab is named Pellam.');
      expect(texts).toHaveLength(2);
      expect(policyFailures()).toEqual([]);
    });

    it('a newer answer that failed makes the other session ask again', async () => {
      let asked = 0;
      const { a } = await open({
        memoryPolicy: (context) => {
          asked += 1;
          if (context.sessionId === 'sb') throw new Error('the account service is down');
          return { longTerm: 'compiled' };
        },
      });
      await say(a, 'sa', 'alice', 'My owl is named Wexford.');
      await vi.waitFor(async () => expect(await a.memory!.countScope('conversation', userKey('alice'))).toBe(2), { timeout: 4_000 });
      await say(a, 'sb', 'alice', 'Keep nothing of me.');
      await say(a, 'sa', 'alice', 'My crab is named Pellam.');
      await closed(a);

      // sa asked again on its next turn, and filed under that answer; the failed turn filed nothing.
      expect(asked).toBe(3);
      const texts = textsUnder(userKey('alice'));
      expect(texts).toContain('My crab is named Pellam.');
      expect(texts).not.toContain('Keep nothing of me.');
      expect(texts).toHaveLength(4);
    });
  });
});
