import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureMemoryDir } from '../migrateMemoryMd.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ensureMemoryDir', () => {
  it('seeds memory/index.md from MEMORY.md, non-destructively', () => {
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Facts\n\nUser likes terse commits.');
    const memoryDir = ensureMemoryDir(dir);
    expect(memoryDir).toBe(path.join(dir, 'memory'));
    const index = fs.readFileSync(path.join(memoryDir, 'index.md'), 'utf8');
    expect(index).toContain('User likes terse commits.');
    expect(fs.existsSync(path.join(dir, 'MEMORY.md'))).toBe(true); // left in place
    expect(fs.existsSync(path.join(memoryDir, '.meta', 'index.json'))).toBe(true);
  });

  it('is idempotent: existing memory/ is never overwritten', () => {
    const memoryDir = path.join(dir, 'memory');
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, 'index.md'), '# Memory Index\n\nkeep me');
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'should be ignored');
    ensureMemoryDir(dir);
    expect(fs.readFileSync(path.join(memoryDir, 'index.md'), 'utf8')).toContain('keep me');
  });

  it('creates an empty memory/ when neither exists', () => {
    const memoryDir = ensureMemoryDir(dir);
    expect(fs.existsSync(path.join(memoryDir, 'index.md'))).toBe(true);
    expect(fs.readFileSync(path.join(memoryDir, 'index.md'), 'utf8')).toContain('# Memory Index');
  });
});
