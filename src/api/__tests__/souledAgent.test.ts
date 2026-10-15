import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Spy on the real `agent` factory so we can inspect what souledAgent passes it,
// while keeping loadSoulFromOption (and the rest of agent.js) real.
const { agentSpy } = vi.hoisted(() => ({
  agentSpy: vi.fn((o: unknown) => ({ __agentOpts: o, generate: async () => ({ text: '' }), close: async () => {} })),
}));
vi.mock('../agent.js', async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, agent: agentSpy };
});

import { souledAgent } from '../souledAgent.js';
import { Memory } from '../../cognition/memory/io/facade/Memory.js';
import { WikiMemoryStore } from '../../cognition/substrate/memory/wiki/WikiMemoryStore.js';

let dir: string;
beforeEach(() => {
  agentSpy.mockClear();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-'));
  fs.writeFileSync(path.join(dir, 'SOUL.md'), '---\nname: Aria\nagentId: aria-1\n---\nYou are Aria.');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('souledAgent', () => {
  it('wires a memory provider + read_memory_page tool and creates the wiki store', async () => {
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Facts\n\nUser prefers terse commits.');
    const existingTool = { name: 'other_tool' };
    await souledAgent({ provider: 'openai', model: 'gpt-4o', soul: dir, tools: [existingTool] } as any);

    expect(agentSpy).toHaveBeenCalledTimes(1);
    const passed = agentSpy.mock.calls[0][0] as any;
    expect(passed.memoryProvider).toBeTruthy();
    expect(typeof passed.memoryProvider.observe).toBe('function');
    expect(typeof passed.memoryProvider.getContext).toBe('function');
    const toolNames = passed.tools.map((t: any) => t.name);
    expect(toolNames).toContain('other_tool');
    expect(toolNames).toContain('read_memory_page');
    expect(fs.existsSync(path.join(dir, 'memory', '.store', 'memory.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'memory', 'index.md'))).toBe(true);
  });

  it('closes the memory store when the agent is closed', async () => {
    const closeSpy = vi.spyOn(Memory.prototype, 'close');
    const a = (await souledAgent({ provider: 'openai', model: 'gpt-4o', soul: dir } as any)) as any;
    await a.close();
    expect(closeSpy).toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  it('exposes the memory store on the returned agent for manual compilation', async () => {
    const a = (await souledAgent({ provider: 'openai', model: 'gpt-4o', soul: dir } as any)) as any;
    expect(a.memory).toBeTruthy();
    expect(typeof a.memory.compileWiki).toBe('function');
    await a.close();
  });

  it('folds conversation into the wiki on close (best-effort compileWiki)', async () => {
    const compileSpy = vi.spyOn(Memory.prototype, 'compileWiki');
    const a = (await souledAgent({ provider: 'openai', model: 'gpt-4o', soul: dir } as any)) as any;
    await a.close();
    expect(compileSpy).toHaveBeenCalled();
    compileSpy.mockRestore();
  });

  it('starts with pages named after members every object has, and finds their index entries on the next start', async () => {
    const memoryDir = path.join(dir, 'memory');
    fs.mkdirSync(memoryDir);
    const names = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];
    for (const name of names) {
      fs.writeFileSync(path.join(memoryDir, `${name}.md`), `---\nsummary: The ${name} page.\n---\nNotes on the page ${name}.\n`);
    }
    const indexEntries = () => JSON.parse(fs.readFileSync(path.join(memoryDir, '.meta', 'index.json'), 'utf8')).pages;

    const first = (await souledAgent({ provider: 'openai', model: 'gpt-4o', soul: dir } as any)) as any;
    await first.close();
    const entries = indexEntries();
    expect(Object.keys(entries).sort()).toEqual([...names].sort());

    // Each page finds its own entry, so the next start's index skips all five and indexes none of them again.
    const index = vi.spyOn(WikiMemoryStore.prototype, 'index');
    let boot: any;
    try {
      const second = (await souledAgent({ provider: 'openai', model: 'gpt-4o', soul: dir } as any)) as any;
      // The start's first index is the boot index over memory/.
      boot = await index.mock.results[0]?.value;
      await second.close();
    } finally {
      index.mockRestore();
    }
    expect({ ...boot, skipped: [...boot.skipped].sort() }).toEqual({
      indexed: [],
      skipped: [...names].sort(),
      removed: [],
    });
    expect(indexEntries()).toEqual(entries);
  });

  it('falls back to a plain agent for an inline soul with no workspace', async () => {
    await souledAgent({ provider: 'openai', model: 'gpt-4o', soul: { content: '---\nname: X\n---\nhi' } } as any);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const passed = agentSpy.mock.calls[0][0] as any;
    expect(passed.memoryProvider).toBeUndefined();
  });
});
