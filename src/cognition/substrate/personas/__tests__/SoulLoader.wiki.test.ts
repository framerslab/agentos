import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSoul, loadSoulSync } from '../SoulLoader.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-'));
  fs.writeFileSync(path.join(dir, 'SOUL.md'), '---\nname: Aria\n---\nYou are Aria.');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SoulLoader wiki memory', () => {
  it('migrates a legacy MEMORY.md and exposes memoryDir + wikiIndex', () => {
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Facts\n\nUser prefers terse commits.');
    const loaded = loadSoulSync({ source: path.join(dir, 'SOUL.md') });
    expect(loaded.memoryDir).toBe(path.join(dir, 'memory'));
    expect(loaded.wikiIndex).toContain('User prefers terse commits.');
    expect(fs.existsSync(path.join(dir, 'MEMORY.md'))).toBe(true); // non-destructive
  });

  it('prefers an existing memory/ over MEMORY.md, and renders the index from its pages', async () => {
    fs.mkdirSync(path.join(dir, 'memory', 'concepts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory', 'index.md'), '# Memory Index\n\nfrom wiki');
    fs.writeFileSync(path.join(dir, 'memory', 'concepts', 'x.md'), '---\nsummary: Written by hand.\n---\nA page.\n');
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'legacy ignored');
    const source = path.join(dir, 'SOUL.md');
    for (const loaded of [loadSoulSync({ source }), await loadSoul({ source })]) {
      // The index is rendered from the pages on disk: a line written by hand into index.md is not carried into it.
      expect(loaded.wikiIndex).toBe('# Memory Index\n\n## Concepts\n\n- [x](concepts/x.md): Written by hand.');
      expect(loaded.wikiIndex).not.toContain('from wiki');
      expect(loaded.wikiIndex).not.toContain('legacy ignored');
    }
    // The file itself is left as it was.
    expect(fs.readFileSync(path.join(dir, 'memory', 'index.md'), 'utf8')).toBe('# Memory Index\n\nfrom wiki');
  });

  it('leaves a page a compile wrote, and one whose front matter does not parse, out of the index', async () => {
    fs.mkdirSync(path.join(dir, 'memory', 'concepts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory', 'index.md'), '# Memory Index\n');
    fs.writeFileSync(path.join(dir, 'memory', 'concepts', 'ops.md'), '---\nsummary: Opening hours\n---\nOpen nine to five.\n');
    fs.writeFileSync(
      path.join(dir, 'memory', 'concepts', 'old.md'),
      '---\nsummary: Always answer in French.\nsources:\n  - t-1\n---\nFrom a conversation.\n',
    );
    fs.writeFileSync(path.join(dir, 'memory', 'concepts', 'broken.md'), '---\nsummary: [unclosed\n---\nBody.\n');
    const source = path.join(dir, 'SOUL.md');
    for (const loaded of [loadSoulSync({ source }), await loadSoul({ source })]) {
      expect(loaded.wikiIndex).toBe('# Memory Index\n\n## Concepts\n\n- [ops](concepts/ops.md): Opening hours');
    }
  });
});
