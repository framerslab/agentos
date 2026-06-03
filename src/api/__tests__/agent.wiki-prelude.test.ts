import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSystemPrompt } from '../agent.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentprompt-'));
  fs.writeFileSync(path.join(dir, 'SOUL.md'), '---\nname: Aria\n---\nYou are Aria.');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('agent wiki prelude', () => {
  it('injects the memory index catalog after the soul identity', () => {
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Facts\n\nUser prefers terse commits.');
    const prompt = buildSystemPrompt({ soul: dir } as any) ?? '';
    expect(prompt).toContain('You are Aria.');
    expect(prompt).toContain('Long-Term Memory (index)');
    expect(prompt).toContain('User prefers terse commits.');
    expect(prompt).toContain('read_memory_page');
    expect(prompt.indexOf('You are Aria.')).toBeLessThan(prompt.indexOf('Long-Term Memory'));
  });
});
