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
import pino from 'pino';
import { agent, type Agent, type AgentOptions } from '../agent';
import { gmi } from '../gmi';
import { souledAgent } from '../souledAgent';
import { SoulLoadError } from '../../cognition/substrate/personas/SoulLoader';
import { hardLimitsBlock } from '../../cognition/substrate/personas/hardLimits';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

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
