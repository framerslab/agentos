import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Spy on the real `agent` factory so we can inspect what souledAgent passes it,
// while keeping loadSoulFromOption (and the rest of agent.js) real.
const { agentSpy } = vi.hoisted(() => ({
  agentSpy: vi.fn((o: unknown) => ({ __agentOpts: o, generate: async () => ({ text: '' }) })),
}));
vi.mock('../agent.js', async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, agent: agentSpy };
});

import { souledAgent } from '../souledAgent.js';

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

  it('falls back to a plain agent for an inline soul with no workspace', async () => {
    await souledAgent({ provider: 'openai', model: 'gpt-4o', soul: { content: '---\nname: X\n---\nhi' } } as any);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    const passed = agentSpy.mock.calls[0][0] as any;
    expect(passed.memoryProvider).toBeUndefined();
  });
});
