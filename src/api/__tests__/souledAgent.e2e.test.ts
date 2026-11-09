/**
 * souledAgent() and agent({ soul }) end to end over the real agent, generateText, provider manager, Memory store and
 * wiki; only the OpenAI provider class is stubbed (helpers/stubProviders.ts), at its module boundary.
 *
 * - A soul that fails to load warns once per agent build, in production too.
 * - The recall block a souled agent adds to a turn keeps to the turn's memory token budget.
 * - Text migrated from a legacy MEMORY.md stays in memory/index.md, and so in the system prompt, after the wiki
 *   writes its catalog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agent, buildSystemPrompt, type AgentOptions } from '../agent';
import { souledAgent } from '../souledAgent';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-souled-${++n}`;
const stubbed = (apiKey: string, extra: Partial<AgentOptions> = {}) =>
  ({ provider: 'openai', model: 'stub-model', apiKey, fallbackProviders: [], ...extra }) as unknown as AgentOptions;

let dir: string;
beforeEach(() => {
  globalLLMProviderHealth.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-e2e-'));
  fs.writeFileSync(path.join(dir, 'SOUL.md'), '---\nname: Aria\nagentId: aria-1\n---\nYou are Aria.');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every console.warn line, its arguments joined. */
const linesOf = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.map((call) => call.map(String).join(' '));

/** The text of every system message one model call was sent. */
const systemTexts = (call: ProviderScript['seen'][number]) =>
  call.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));

describe('a soul that fails to load', () => {
  it('warns once for agent() and once for souledAgent(), with NODE_ENV=production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const soulWarnings = () => linesOf(warn).filter((line) => line.includes('/no/such/soul'));

    agent({ provider: 'openai', model: 'gpt-4o', soul: '/no/such/soul' });
    expect(soulWarnings()).toHaveLength(1);
    expect(soulWarnings()[0]).toMatch(/soul/i);

    warn.mockClear();
    await souledAgent({ provider: 'openai', model: 'gpt-4o', soul: '/no/such/soul' });
    expect(soulWarnings()).toHaveLength(1);
  });

  it("warns once for an agent on runtime: 'gmi' that answers a turn", async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const k = key();
    script('openai', k, { replies: [reply.text('Hello.')] });
    const session = agent(stubbed(k, { runtime: 'gmi', soul: '/no/such/soul-gmi' } as Partial<AgentOptions>)).session('s');
    expect((await session.send('hi')).text).toBe('Hello.');
    expect(linesOf(warn).filter((line) => line.includes('/no/such/soul-gmi'))).toHaveLength(1);
  });
});

describe("souledAgent()'s recall", () => {
  /** Eight traces of about 2,000 characters, each matching "green tea". */
  const traces = Array.from({ length: 8 }, (_, i) => `Tea note ${i}: ` + Array.from({ length: 95 }, (_, j) => `green tea batch${i}x${j}`).join(' '));

  async function recallBlock(memoryProviderOptions?: AgentOptions['memoryProviderOptions']): Promise<string | undefined> {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const k = key();
    const s = script('openai', k, { whole: true, replies: [reply.text('Noted.'), reply.text('Tea notes.')] });
    const a = await souledAgent({ ...stubbed(k, memoryProviderOptions ? { memoryProviderOptions } : {}), soul: dir } as never);
    try {
      for (const text of traces) {
        await a.memory!.remember(text, { type: 'episodic', scope: 'persona', scopeId: 'aria-1' });
      }
      await a.generate('What do I know about green tea?');
    } finally {
      await a.close();
    }
    return systemTexts(s.seen[0]).find((text) => text.includes('Tea note'));
  }

  it('keeps the block to a 500-token budget, in whole traces', async () => {
    const block = await recallBlock({ tokenBudget: 500 });
    expect(block).toBeDefined();
    expect(block!.length).toBeGreaterThan(0);
    expect(block!.length).toBeLessThanOrEqual(500 * 4);
  });

  it('cuts the first trace at a word boundary when it alone is larger than the budget', async () => {
    const block = await recallBlock({ tokenBudget: 100 });
    expect(block).toBeDefined();
    expect(block!.length).toBeGreaterThan(0);
    expect(block!.length).toBeLessThanOrEqual(100 * 4);
    const source = traces.find((t) => t.startsWith(block!));
    expect(source).toBeDefined();
    expect(/\s/.test(source!.charAt(block!.length))).toBe(true);
  });

  it("keeps the block to the hooks' default budget when none is passed", async () => {
    const block = await recallBlock();
    expect(block).toBeDefined();
    expect(block!.length).toBeLessThanOrEqual(2000 * 4);
    expect(block!.split('\n').filter((line) => line.startsWith('Tea note')).length).toBeGreaterThanOrEqual(2);
  });
});

describe('text migrated from a legacy MEMORY.md', () => {
  const sentence = 'The user prefers concise answers.';

  it('stays in the system prompt after the wiki writes its catalog', async () => {
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), `${sentence}\n`);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // A plain agent that writes no page gets the prompt it always got.
    expect(buildSystemPrompt({ soul: dir } as AgentOptions)).toBe(
      'You are Aria.\n\n## Long-Term Memory (index)\n\n' +
        'You maintain a memory wiki. This is its index. Use the `read_memory_page` tool to open any page by id.\n\n' +
        `# Memory Index\n\n<!-- migrated from MEMORY.md -->\n\n${sentence}`,
    );

    const k = key();
    script('openai', k, { whole: true, replies: [reply.text('Johnny likes green tea.'), reply.text('Johnny likes green tea and oolong.')] });
    const a = await souledAgent({ ...stubbed(k), soul: dir } as never);
    try {
      await a.memory!.remember('Johnny likes green tea', { type: 'episodic', scope: 'persona', scopeId: 'aria-1' });
      expect((await a.memory!.compileWiki()).pagesWritten).toEqual(['concepts/notes']);
      await a.memory!.remember('Johnny likes oolong too', { type: 'episodic', scope: 'persona', scopeId: 'aria-1' });
      await a.memory!.compileWiki();
    } finally {
      await a.close();
    }

    const index = fs.readFileSync(path.join(dir, 'memory', 'index.md'), 'utf8');
    expect(index).toContain(sentence);
    expect(index).toContain('[notes](concepts/notes.md)');
    expect(index.split('<!-- end of MEMORY.md -->')).toHaveLength(2);
    expect(index.indexOf(sentence)).toBeLessThan(index.indexOf('[notes](concepts/notes.md)'));

    const prompt = buildSystemPrompt({ soul: dir } as AgentOptions) ?? '';
    expect(prompt).toContain(sentence);
    expect(prompt).toContain('[notes](concepts/notes.md)');
    expect(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8')).toBe(`${sentence}\n`);
  });
});
