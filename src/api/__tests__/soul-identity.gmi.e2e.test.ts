/**
 * A soul's identity end to end on every way of building an agent: agent({ soul }), souledAgent() and the GMI path.
 * Runs over the real agent, GMI, generateText, provider manager, Memory store and wiki; only the OpenAI provider class
 * is stubbed (helpers/stubProviders.ts), at its module boundary, and each model call's messages are read from the
 * script.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { z } from 'zod';
import { agent, type Agent, type AgentOptions } from '../agent';
import { gmi } from '../gmi';
import { souledAgent } from '../souledAgent';
import { SoulLoadError } from '../../cognition/substrate/personas/SoulLoader';
import { hardLimitsBlock } from '../../cognition/substrate/personas/hardLimits';
import { PERSONALITY_SECTION_HEADING, renderPersonalitySection } from '../../cognition/substrate/personas/personalityPrompt';
import { SCHEMA_INSTRUCTION_LEAD } from '../runtime/structuredReply';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { Brain } from '../../cognition/memory/retrieval/store/Brain';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import { CognitiveMemoryManager } from '../../cognition/memory/CognitiveMemoryManager';
import { InMemoryLearningStore } from '../../cognition/learning/store/InMemoryLearningStore';
import { stableIdOfName } from '../../cognition/substrate/personas/stableId';

let n = 0;
const key = () => `k-soul-identity-${++n}`;
const stubbed = (apiKey: string, extra: Record<string, unknown> = {}) =>
  ({ provider: 'openai', model: 'stub-model', apiKey, fallbackProviders: [], ...extra }) as unknown as AgentOptions;

const LIMITS = ['Never name a diagnosis.', 'Never promise an outcome.'];
const BLOCK = hardLimitsBlock(LIMITS)!;
/** Front matter with an id, traits and hard limits. */
const FULL = [
  'name: Aria', 'agentId: aria-1',
  'hexaco:', '  honestyHumility: 0.9', '  extraversion: 0.8',
  'hardLimits:', ...LIMITS.map((limit) => `  - ${limit}`),
].join('\n');

let dir: string;
const logged: Record<string, unknown>[] = [];
/** Writes SOUL.md into the test's soul folder. */
const writeSoul = (frontmatter: string, body = 'You are Aria.') =>
  fs.writeFileSync(path.join(dir, 'SOUL.md'), frontmatter ? `---\n${frontmatter}\n---\n${body}` : body);

beforeEach(() => {
  globalLLMProviderHealth.reset();
  logged.length = 0;
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-identity-e2e-'));
});
afterEach(() => {
  resetLoggerFactory();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The log lines of one event. */
const events = (name: string) => logged.filter((line) => line.event === name);
/** Every system text one model call was sent, in order: a string message is one text, a message of parts one text a part. */
const systemTexts = (call: ProviderScript['seen'][number]): string[] =>
  call.messages
    .filter((m) => m.role === 'system')
    .flatMap((m) => (typeof m.content === 'string' ? [m.content] : (m.content as unknown as Array<{ text?: string }>).map((part) => part.text ?? '')));
/** The system text of one model call, joined. */
const systemOf = (call: ProviderScript['seen'][number]): string => systemTexts(call).join('\n\n');
/** The model calls that are turns: every call but the wiki compile's, which carries no system prompt. */
const turnCalls = (s: ProviderScript) => s.seen.filter((call) => !JSON.stringify(call.messages).includes('You maintain a knowledge wiki page'));

describe('a soul that fails to load', () => {
  it('throws SoulLoadError from agent() and gmi() at build, and rejects souledAgent()', async () => {
    const missing = path.join(dir, 'nowhere');
    const builds: Array<() => Agent> = [
      () => agent(stubbed(key(), { soul: missing })),
      () => gmi(stubbed(key(), { soul: missing })),
      () => agent(stubbed(key(), { runtime: 'gmi', soul: { path: missing } })),
    ];
    for (const build of builds) {
      let thrown: unknown;
      try {
        build();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SoulLoadError);
      expect(thrown).toMatchObject({ code: 'SOUL_LOAD_FAILED', source: missing });
    }
    await expect(souledAgent({ ...stubbed(key()), soul: missing } as never)).rejects.toBeInstanceOf(SoulLoadError);
    expect(events('soul.load_failed')).toEqual([]);
  });

  it('throws naming the field when the front matter has a field of the wrong type', async () => {
    writeSoul('name: Aria\nhardLimits: never');
    const message = "front matter field 'hardLimits' must be a list of strings";
    expect(() => agent(stubbed(key(), { soul: dir }))).toThrow(message);
    expect(() => gmi(stubbed(key(), { soul: dir }))).toThrow(message);
    expect(() => agent(stubbed(key(), { soul: { content: '---\nhardLimits: never\n---\nHi.' } }))).toThrow(message);
    await expect(souledAgent({ ...stubbed(key()), soul: dir } as never)).rejects.toThrow(message);
  });

  it.each([
    ['agent()', (k: string, soul: unknown) => agent(stubbed(k, { soul }))],
    ['gmi()', (k: string, soul: unknown) => gmi(stubbed(k, { soul }))],
    ['souledAgent()', (k: string, soul: unknown) => souledAgent({ ...stubbed(k), soul } as never)],
  ] as const)('%s with optional: true runs without the soul and writes one soul.load_failed line', async (_name, build) => {
    const missing = path.join(dir, 'nowhere');
    const k = key();
    const s = script('openai', k, { whole: true, replies: [reply.text('Hello.')] });
    const a = await build(k, { path: missing, optional: true });
    try {
      expect((await a.session('s').send('Hi.')).text).toBe('Hello.');
    } finally {
      await a.close();
    }
    expect(s.seen).toHaveLength(1);
    const lines = events('soul.load_failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ optional: 'yes', type: 'Error' });
    // The line names no path and carries no message.
    expect(JSON.stringify(lines[0])).not.toContain('nowhere');
    expect(lines[0]).not.toHaveProperty('msg');
  });
});

/** The agent built on the soul folder by each way that runs on the default runtime. */
const plainPaths = [
  ['agent({ soul })', async (k: string, extra: Record<string, unknown> = {}) => agent(stubbed(k, { soul: dir, ...extra }))],
  ['souledAgent()', async (k: string, extra: Record<string, unknown> = {}) => souledAgent({ ...stubbed(k, extra), soul: dir } as never)],
] as const;

describe("a soul's hard limits, traits and name on the default runtime", () => {
  // One turn on a new store: the wiki's recall block is still a system message, so a turn that recalled something
  // would have that block after the limits until recalled text leaves the system role.
  it.each(plainPaths)('%s: the last system text of the model call is the hard-limits block', async (_name, build) => {
    writeSoul(FULL);
    const k = key();
    const s = script('openai', k, { whole: true, replies: [reply.text('Hello.'), reply.text('Notes.')] });
    const a = await build(k);
    try {
      await a.session('s').send('Hi.');
    } finally {
      await a.close();
    }
    const [turn] = turnCalls(s);
    expect(systemTexts(turn).join('\n\n').endsWith(BLOCK)).toBe(true);
    expect(systemOf(turn).indexOf('You are Aria.')).toBeLessThan(systemOf(turn).indexOf(BLOCK));
    expect(systemOf(turn).split(BLOCK)).toHaveLength(2);
  });

  it("with systemBlocks, the limits are one more block after the host's, and the cache breakpoint stays on the host's block", async () => {
    writeSoul(FULL);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const k = key();
    const s = script('openai', k, { whole: true, replies: [reply.text('Hello.')] });
    await agent(stubbed(k, { soul: dir, systemBlocks: [{ text: 'Host block.', cacheBreakpoint: true }] })).generate('Hi.');
    const system = s.seen[0].messages.filter((m) => m.role === 'system');
    expect(system).toHaveLength(1);
    const parts = system[0].content as unknown as Array<{ text: string; cache_control?: unknown }>;
    expect(parts.map((part) => part.text)).toEqual(['Host block.', BLOCK]);
    expect(parts[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(parts[1].cache_control).toBeUndefined();
  });

  it("renders the soul's hexaco paragraph when no personality is set, once, and the personality option wins over it", async () => {
    writeSoul(FULL);
    const k = key();
    const s = script('openai', k, { whole: true, replies: [reply.text('A.'), reply.text('B.')] });
    await agent(stubbed(k, { soul: dir })).generate('Hi.');
    await agent(stubbed(k, { soul: dir, personality: { openness: 0.9 } })).generate('Hi.');
    expect(systemOf(s.seen[0])).toContain(renderPersonalitySection({ honestyHumility: 0.9, extraversion: 0.8 })!);
    expect(systemOf(s.seen[0]).split(PERSONALITY_SECTION_HEADING)).toHaveLength(2);
    expect(systemOf(s.seen[1])).toContain(renderPersonalitySection({ openness: 0.9 })!);
    expect(systemOf(s.seen[1])).not.toContain(renderPersonalitySection({ honestyHumility: 0.9, extraversion: 0.8 })!);
    // The limits still close both prompts.
    for (const call of s.seen) expect(systemOf(call).endsWith(BLOCK)).toBe(true);
  });

  it("names the agent by the name option, else by the soul's name", async () => {
    writeSoul(FULL);
    const k = key();
    const s = script('openai', k, { whole: true, replies: [reply.text('A.'), reply.text('B.')] });
    await agent(stubbed(k, { soul: dir, name: 'Support' })).generate('Hi.');
    await agent(stubbed(k, { soul: dir })).generate('Hi.');
    expect(systemOf(s.seen[0])).toContain('Assistant name: Support.');
    expect(systemOf(s.seen[0])).not.toContain('Assistant name: Aria.');
    expect(systemOf(s.seen[1])).toContain('Assistant name: Aria.');
  });

  it('a structured send whose payload carries no schema has the schema instruction right before the limits, which stay last', async () => {
    writeSoul(FULL);
    const k = key();
    const s = script('openai', k, { whole: true, replies: [reply.text('{"city":"Lyon","scores":{"a":1}}')] });
    // A record schema is outside OpenAI's strict JSON schema, so the schema rides the prompt.
    const schema = z.object({ city: z.string(), scores: z.record(z.string(), z.number()) });
    const r = await agent(stubbed(k, { soul: dir })).session('s').send('Where?', { responseSchema: schema });
    expect(r.object).toEqual({ city: 'Lyon', scores: { a: 1 } });
    const texts = systemTexts(s.seen[0]);
    expect(texts.at(-1)).toBe(BLOCK);
    expect(texts.at(-2)).toContain(SCHEMA_INSTRUCTION_LEAD);
    expect(texts.slice(0, -2).join('\n\n')).toContain('You are Aria.');
    expect(texts.slice(0, -2).join('\n\n')).not.toContain(BLOCK);
  });

  it('keeps the limits last under a working-memory block and under a per-call system prompt', async () => {
    writeSoul(FULL);
    const k = key();
    const s = script('openai', k, { whole: true, replies: [reply.text('A.'), reply.text('B.')] });
    const a = agent(stubbed(k, { soul: dir, memory: { working: async () => 'WORKING NOTES' } }));
    await a.session('s').send('Hi.');
    await a.generate('Hi.', { system: 'Answer in one word.' } as never);
    expect(systemOf(s.seen[0]).startsWith('WORKING NOTES')).toBe(true);
    expect(systemOf(s.seen[0]).endsWith(BLOCK)).toBe(true);
    expect(systemOf(s.seen[1])).toBe(`Answer in one word.\n\n${BLOCK}`);
  });

  it('closes a call whose own system prompt is set to undefined with the limits', async () => {
    writeSoul(FULL);
    const k = key();
    const s = script('openai', k, { whole: true, replies: [reply.text('A.')] });
    await agent(stubbed(k, { soul: dir })).generate('Hi.', { system: undefined } as never);
    expect(systemTexts(s.seen[0]).join('\n\n').endsWith(BLOCK)).toBe(true);
  });

  it('adds no block for a soul with no hard limits', async () => {
    writeSoul('name: Aria\nagentId: aria-1');
    const k = key();
    const s = script('openai', k, { whole: true, replies: [reply.text('A.')] });
    await agent(stubbed(k, { soul: dir })).generate('Hi.');
    expect(systemOf(s.seen[0])).not.toContain('## Hard limits');
  });
});

describe("a soul's identity on the GMI path", () => {
  it.each([
    ["agent({ runtime: 'gmi', soul })", async (k: string) => agent(stubbed(k, { runtime: 'gmi', soul: dir }))],
    ["souledAgent({ runtime: 'gmi' })", async (k: string) => souledAgent({ ...stubbed(k, { runtime: 'gmi' }), soul: dir } as never)],
  ] as const)('%s: the system text of every model call ends with the hard-limits block, and holds the trait paragraph once', async (_name, build) => {
    writeSoul(FULL);
    const k = key();
    // More replies than calls: the compile on close answers from them, and an unexpected call would throw.
    const s = script('openai', k, { whole: true, replies: [reply.text('Hello.'), reply.text('Notes.'), reply.text('Notes.'), reply.text('Notes.')] });
    const a = await build(k);
    try {
      await a.session('s').send('Hi.');
    } finally {
      await a.close();
    }
    const [turn] = turnCalls(s);
    expect(systemOf(turn).trimEnd().endsWith(BLOCK)).toBe(true);
    expect(systemOf(turn)).toContain('You are Aria.');
    expect(systemOf(turn).split(PERSONALITY_SECTION_HEADING)).toHaveLength(2);
    expect(systemOf(turn)).toContain(renderPersonalitySection({ honestyHumility: 0.9, extraversion: 0.8 })!);
  });

  it('closes the prompt with the limits after systemBlocks text too', async () => {
    writeSoul(FULL);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Hello.')] });
    await gmi(stubbed(k, { soul: dir, systemBlocks: [{ text: 'Host block.', cacheBreakpoint: true }] })).session('s').send('Hi.');
    expect(systemOf(s.seen[0])).toContain('Host block.');
    expect(systemOf(s.seen[0]).trimEnd().endsWith(BLOCK)).toBe(true);
  });

  it('lets the personality option win over hexaco, and names the agent by the name option', async () => {
    writeSoul(FULL);
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Hello.')] });
    await gmi(stubbed(k, { soul: dir, name: 'Support', personality: { openness: 0.9 } })).session('s').send('Hi.');
    expect(systemOf(s.seen[0])).toContain(renderPersonalitySection({ openness: 0.9 })!);
    expect(systemOf(s.seen[0]).split(PERSONALITY_SECTION_HEADING)).toHaveLength(2);
    expect(systemOf(s.seen[0])).toContain('Assistant name: Support.');
    expect(systemOf(s.seen[0])).not.toContain('Assistant name: Aria.');
  });

  it('writes one soul.field_ignored line for a front matter voice, and the turn runs', async () => {
    writeSoul(`${FULL}\nvoice:\n  provider: elevenlabs\n  voiceId: rachel`);
    const k = key();
    script('openai', k, { replies: [reply.text('Hello.')] });
    const a = gmi(stubbed(k, { soul: dir }));
    expect((await a.session('s').send('Hi.')).text).toBe('Hello.');
    expect(events('soul.field_ignored')).toEqual([expect.objectContaining({ field: 'voice' })]);
  });

  it('runs a soul with no agentId and no name, on an agent with no name, with its limits last and its traits', async () => {
    writeSoul(['hexaco:', '  honestyHumility: 0.9', 'hardLimits:', ...LIMITS.map((limit) => `  - ${limit}`)].join('\n'), 'You are terse.');
    const k = key();
    const s = script('openai', k, { whole: true, replies: [reply.text('A.'), reply.text('B.')] });
    await gmi(stubbed(k, { soul: dir })).session('s').send('Hi.');
    await agent(stubbed(k, { soul: dir })).generate('Hi.');
    for (const call of s.seen) {
      expect(systemOf(call).trimEnd().endsWith(BLOCK)).toBe(true);
      expect(systemOf(call)).toContain(renderPersonalitySection({ honestyHumility: 0.9 })!);
    }
  });
});

describe("the soul's id as the agent's key", () => {
  /** The key the turns of the session `s` are filed under for an agent of that id. */
  const sessionKeyOf = (agentId: string) => conversationScopeKey(agentId, { kind: 'session', id: 's' });

  it.each([['the default runtime', {}], ["runtime: 'gmi'", { runtime: 'gmi' }]] as const)(
    'souledAgent() on %s files its turns under the soul agentId, whatever the agent is named',
    async (_name, extra) => {
      writeSoul(FULL);
      const k = key();
      script('openai', k, { whole: true, replies: [reply.text('Lisbon it is.'), reply.text('Notes.'), reply.text('Notes.'), reply.text('Notes.')] });
      const a = await souledAgent({ ...stubbed(k, { ...extra, name: 'Support' }), soul: dir } as never);
      try {
        await a.session('s').send('I moved to Lisbon.');
        await vi.waitFor(async () => expect((await a.memory!.recall('Lisbon', { scope: 'conversation', scopeId: sessionKeyOf('aria-1') })).length).toBe(2));
        expect(await a.memory!.recall('Lisbon', { scope: 'conversation', scopeId: sessionKeyOf('Support') })).toEqual([]);
      } finally {
        await a.close();
      }
    },
  );

  it('files under the slug of the soul name when the soul has no agentId', async () => {
    writeSoul('name: Aria Stone');
    const k = key();
    script('openai', k, { whole: true, replies: [reply.text('Lisbon it is.'), reply.text('Notes.')] });
    const a = await souledAgent({ ...stubbed(k), soul: dir } as never);
    try {
      await a.session('s').send('I moved to Lisbon.');
      await vi.waitFor(async () => expect((await a.memory!.recall('Lisbon', { scope: 'conversation', scopeId: sessionKeyOf('aria-stone') })).length).toBe(2));
    } finally {
      await a.close();
    }
  });

  it.each([['an agent with no name', {}], ["an agent named 'Support'", { name: 'Support' }]] as const)(
    'files under a stable id of a soul name with no Latin letters, on %s',
    async (_name, extra) => {
      writeSoul('name: アリア');
      const k = key();
      script('openai', k, { whole: true, replies: [reply.text('Lisbon it is.'), reply.text('Notes.')] });
      const a = await souledAgent({ ...stubbed(k, extra), soul: dir } as never);
      try {
        await a.session('s').send('I moved to Lisbon.');
        await vi.waitFor(async () => expect((await a.memory!.recall('Lisbon', { scope: 'conversation', scopeId: sessionKeyOf(stableIdOfName('アリア')) })).length).toBe(2));
      } finally {
        await a.close();
      }
    },
  );

  it('souledAgent() rejects a soul that gives no id on an agent with no name, and makes no store', async () => {
    writeSoul('hardLimits:\n  - Never guess.', 'You are terse.');
    await expect(souledAgent({ ...stubbed(key()), soul: dir } as never)).rejects.toThrow(
      "souledAgent: the soul has no agentId and no name, and the agent has no name; set agentId in SOUL.md's front matter so the agent's memory has one stable id",
    );
    expect(fs.existsSync(path.join(dir, 'memory', '.store'))).toBe(false);
  });

  it('gmi() with memory.store opens its brain under the soul id with no learning.agentKey, and under learning.agentKey when one is set', async () => {
    writeSoul(FULL);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const open = vi.spyOn(Brain, 'openSqlite');
    const first = path.join(dir, 'first.sqlite');
    const a = gmi(stubbed(key(), { soul: dir, memory: { store: { path: first } }, learning: { mode: 'off' } }));
    // Opening a session reads its generation from the store, which opens the brain.
    a.session('s');
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(first, { brainId: 'aria-1' }));
    await a.close();

    const second = path.join(dir, 'second.sqlite');
    const b = gmi(stubbed(key(), { soul: dir, memory: { store: { path: second } }, learning: { mode: 'off', agentKey: 'kept' } }));
    b.session('s');
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(second, { brainId: 'kept' }));
    await b.close();
  });

  it('gmi() with memory.store refuses a soul that gives no id, telling the host to set agentId', () => {
    writeSoul('hardLimits:\n  - Never guess.', 'You are terse.');
    const build = () => gmi(stubbed(key(), { soul: dir, memory: { store: { path: path.join(dir, 'x.sqlite') } }, learning: { mode: 'off' } }));
    expect(build).toThrow('gmi(): memory.store needs learning.agentKey');
    expect(build).toThrow("set agentId in SOUL.md's front matter, and the soul's id names the brain.");
    // Without a soul the error is the one it was: it ends where it ended.
    expect(() => gmi(stubbed(key(), { memory: { store: { path: path.join(dir, 'y.sqlite') } }, learning: { mode: 'off' } }))).toThrow(/one agent to the learning layer\.$/);
  });

  it('gmi() with memory.store and learning.agentKey files the memory of an inline soul that gives no id under that key, before and after its text is edited', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const built = vi.spyOn(CognitiveMemoryManager.prototype, 'initialize');
    const embeddingKey = key();
    script('openai', embeddingKey, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', embeddingKey);
    const memory = { store: { path: path.join(dir, 'kept.sqlite') }, embedding: { provider: 'openai', model: 'text-embedding-3-small' } };
    for (const body of ['Be kind.', 'Be kind and brief.']) {
      const k = key();
      script('openai', k, { replies: [reply.text('Noted.')] });
      const a = gmi(stubbed(k, { soul: { content: `---\nrole: helper\n---\n${body}` }, memory, learning: { agentKey: 'k', mode: 'off' } }));
      try {
        await a.session('s').send('The deploy key lives in the vault.');
      } finally {
        await a.close();
      }
    }
    // The memory's owner, which files its own traces and the persona scopes, is the host's key on both builds.
    const owners = built.mock.calls.map(([config]) => config.agentId);
    expect(owners.length).toBeGreaterThanOrEqual(2);
    expect(new Set(owners)).toEqual(new Set(['k']));
  });
});

describe('what the docs say about the id of a soul that gives none', () => {
  const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
  const doc = (file: string) => fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8');

  it('name learning.agentKey before the id derived from the text, and say an edit moves the derived one', () => {
    const gmiDoc = doc('docs/GMI.md');
    expect(gmiDoc).toContain(
      "else `learning.agentKey`, else an id derived from the soul's text, which changes when that text changes, so an agent that keeps memory gives its soul an `agentId` or sets `learning.agentKey`",
    );
    expect(gmiDoc).toContain("under the persona's id: the soul's id, else a slug of the agent's `name`, else `learning.agentKey`");
  });
});

describe('learners filed under the slug of the agent name before the soul had an id', () => {
  const learning = (store: InMemoryLearningStore, extra: Record<string, unknown> = {}) =>
    ({ runtime: 'gmi', name: 'Aria', personality: { openness: 0.9 }, learning: { store, traits: true, ...extra } });
  /** The agent keys of one user's session rows. */
  const keysOf = async (store: InMemoryLearningStore, userId: string) => new Set((await store.sessionRowsOf('', userId)).map((row) => row.agentKey));

  it('stay under it by one logged fallback, and forgetUser reaches them', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const store = new InMemoryLearningStore();
    const k = key();
    script('openai', k, { replies: [reply.text('One.'), reply.text('Two.'), reply.text('Three.')] });
    const before = agent(stubbed(k, learning(store)));
    await before.session('s1', { userId: 'ana' }).send('Hello.');
    await before.close();
    expect(await keysOf(store, 'ana')).toEqual(new Set(['aria']));

    writeSoul(FULL);
    const after = agent(stubbed(k, { ...learning(store), soul: dir }));
    await after.session('s2', { userId: 'ana' }).send('Hello again.');
    await after.session('s3', { userId: 'ana' }).send('And again.');
    expect(events('soul.id_fallback')).toEqual([expect.objectContaining({ reason: 'old_slug_learner' })]);
    expect(await keysOf(store, 'ana')).toEqual(new Set(['aria']));
    await after.learning!.forgetUser!('ana');
    expect(await store.sessionRowsOf('', 'ana')).toEqual([]);
    await after.close();
  });

  it('stay under it when the store fails its first open: the key is asked again once the store answers', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new InMemoryLearningStore();
    const k = key();
    script('openai', k, { replies: [reply.text('One.'), reply.text('Two.'), reply.text('Three.')] });
    const before = agent(stubbed(k, learning(store)));
    await before.session('s1', { userId: 'dee' }).send('Hello.');
    await before.close();
    expect(await keysOf(store, 'dee')).toEqual(new Set(['aria']));

    writeSoul(FULL);
    vi.spyOn(store, 'freezeRows').mockRejectedValueOnce(new Error('store unavailable'));
    const after = agent(stubbed(k, { ...learning(store), soul: dir }));
    await after.session('s2', { userId: 'dee' }).send('Hello again.');
    await after.session('s3', { userId: 'dee' }).send('And again.');
    await after.close();
    expect(events('soul.id_fallback')).toEqual([expect.objectContaining({ reason: 'old_slug_learner' })]);
    expect(await keysOf(store, 'dee')).toEqual(new Set(['aria']));
  });

  it('are left where they are, with no line, when learning.learnerKey names the key', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const store = new InMemoryLearningStore();
    const k = key();
    script('openai', k, { replies: [reply.text('One.'), reply.text('Two.')] });
    const before = agent(stubbed(k, learning(store)));
    await before.session('s1', { userId: 'ben' }).send('Hello.');
    await before.close();

    writeSoul(FULL);
    const chosen = agent(stubbed(k, { ...learning(store, { learnerKey: 'aria-1' }), soul: dir }));
    await chosen.session('s2', { userId: 'ben' }).send('Hello again.');
    await chosen.close();
    expect(events('soul.id_fallback')).toEqual([]);
    expect(await keysOf(store, 'ben')).toEqual(new Set(['aria', 'aria-1']));
  });

  it('files a new agent under the soul id with no line', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeSoul(FULL);
    const store = new InMemoryLearningStore();
    const k = key();
    script('openai', k, { replies: [reply.text('One.')] });
    const fresh = agent(stubbed(k, { ...learning(store), soul: dir }));
    await fresh.session('s1', { userId: 'cy' }).send('Hello.');
    await fresh.close();
    expect(events('soul.id_fallback')).toEqual([]);
    expect(await keysOf(store, 'cy')).toEqual(new Set(['aria-1']));
  });
});

describe('what the docs say about the limits closing the prompt', () => {
  const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
  const doc = (file: string) => fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8');

  it('name the system messages a turn can add after the limits, and say recall is not one', () => {
    const exception = 'the plan of a call with `planning` on is a system message after the limits.';
    const recall = "A memory provider's recall (the wiki's recall on a souled agent) is a data block in a user-role message, never a system message.";
    for (const file of ['docs/SOUL_FILES.md', 'docs/safety/GUARDRAILS_USAGE.md']) {
      expect(doc(file)).toContain(exception);
      expect(doc(file)).toContain(recall);
    }
    expect(doc('README.md')).not.toContain('Identity, voice, hard limits, and HEXACO scores');
    expect(doc('README.md')).toContain("With `systemBlocks`, the soul's prose and style are left out and its hard limits still close the prompt.");
  });
});
