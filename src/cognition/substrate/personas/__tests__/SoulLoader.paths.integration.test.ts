/**
 * @file SoulLoader.paths.integration.test.ts
 * The soul loader against a temp folder: a soul's files are read only when each is a regular file in the soul's
 * own folder, reached through no link, without waiting, and the memory folder a load starts is made without
 * writing through a link. Each case runs `loadSoul` and `loadSoulSync`.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { buildSystemPrompt } from '../../../../api/agent.js';
import { loadSoul, loadSoulSync, type LoadedSoul } from '../SoulLoader.js';

// The soul's folder is <base>/souls/aria; <base>/outside holds what no soul may read or write.
let base: string;
let outside: string;
let soul: string;
let warn: MockInstance<typeof console.warn>;

const SECRET = 'Text outside the soul folder, which no soul may read.';
const SOUL = '---\nname: Aria\nagentId: aria\n---\nYou are Aria.';

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-paths-'));
  outside = path.join(base, 'outside');
  soul = path.join(base, 'souls', 'aria');
  fs.mkdirSync(outside);
  fs.mkdirSync(soul, { recursive: true });
  fs.writeFileSync(path.join(soul, 'SOUL.md'), SOUL);
  fs.writeFileSync(path.join(outside, 'secret.md'), SECRET);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  fs.rmSync(base, { recursive: true, force: true });
});

/** The soul loaded by `loadSoul`, then by `loadSoulSync`. */
async function loadBoth(source = soul): Promise<LoadedSoul[]> {
  return [await loadSoul({ source }), loadSoulSync({ source })];
}

/** The warnings that name `file`. */
function warningsAbout(file: string): string[] {
  return warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes(file));
}

describe("a soul's files are read only from its own folder", () => {
  it.skipIf(process.platform === 'win32')(
    'a STYLE.md that is a link to a file outside is skipped with a warning, and the outside text is nowhere in the soul or the prompt',
    async () => {
      const style = path.join(soul, 'STYLE.md');
      fs.symlinkSync(path.join(outside, 'secret.md'), style);

      const souls = await loadBoth();
      const prompt = buildSystemPrompt({ soul }) ?? '';

      for (const loaded of souls) {
        expect(loaded.soulContent).toBe('You are Aria.');
        expect(loaded.styleContent).toBeUndefined();
        expect(JSON.stringify(loaded)).not.toContain(SECRET);
      }
      expect(prompt).toContain('You are Aria.');
      expect(prompt).not.toContain(SECRET);
      // One warning a load: loadSoul, loadSoulSync and the agent's own load.
      expect(warningsAbout(style)).toEqual(Array(3).fill(`[SoulLoader] Skipped ${style}: it is reached through a symbolic link`));
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a SOUL.md that is a link, or a soul folder that is a link, is not read: the loaders throw, and with requireSoul off nothing outside is read or made',
    async () => {
      fs.rmSync(path.join(soul, 'SOUL.md'));
      fs.symlinkSync(path.join(outside, 'secret.md'), path.join(soul, 'SOUL.md'));
      // A soul folder that is a link to a folder outside, which holds a SOUL.md of its own.
      fs.writeFileSync(path.join(outside, 'SOUL.md'), `---\nname: Outside\n---\n${SECRET}`);
      const linked = path.join(base, 'souls', 'linked');
      fs.symlinkSync(outside, linked, 'dir');

      for (const source of [soul, path.join(soul, 'SOUL.md'), linked]) {
        const thrown = await loadSoul({ source }).catch((err: unknown) => err);
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toMatch(/^SOUL\.md at .* was not read: it is reached through a symbolic link$/);
        expect(() => loadSoulSync({ source })).toThrow(/was not read: it is reached through a symbolic link/);
      }
      const loose = [await loadSoul({ source: linked, requireSoul: false }), loadSoulSync({ source: linked, requireSoul: false })];

      for (const loaded of loose) {
        expect(loaded.soulContent).toBe('');
        expect(JSON.stringify(loaded)).not.toContain(SECRET);
      }
      // No memory/ folder was made in the folder outside, and nothing written there.
      expect(fs.readdirSync(outside).sort()).toEqual(['SOUL.md', 'secret.md']);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a named pipe at STYLE.md or memory/index.md is skipped at once, with no wait for a writer',
    async () => {
      fs.mkdirSync(path.join(soul, 'memory'));
      const style = path.join(soul, 'STYLE.md');
      const index = path.join(soul, 'memory', 'index.md');
      // Named pipes that no process writes: a read that waited would wait for ever, and loadSoulSync would hold the
      // thread with it.
      execFileSync('mkfifo', [style, index]);

      const souls = await loadBoth();

      for (const loaded of souls) {
        expect(loaded.soulContent).toBe('You are Aria.');
        expect(loaded.styleContent).toBeUndefined();
        expect(loaded.wikiIndex).toBeUndefined();
      }
      expect(fs.lstatSync(style).isFIFO()).toBe(true);
      expect(fs.lstatSync(index).isFIFO()).toBe(true);
      expect(warningsAbout(style)).toHaveLength(2);
      // Each load leaves the pipe in place of the memory index and skips its read.
      expect(warningsAbout(index)).toHaveLength(4);
      expect(warningsAbout(index).every((line) => line.endsWith('it is not a regular file'))).toBe(true);
    },
    15_000,
  );
});

describe('the memory folder a load starts is made without writing through a link', () => {
  it.skipIf(process.platform === 'win32')(
    'a memory/index.md or memory/.meta/index.json that is a link leading nowhere is left as it is: nothing is made where it leads, and the soul still loads',
    async () => {
      fs.writeFileSync(path.join(soul, 'MEMORY.md'), '# Facts\n\nThe user likes short replies.\n');
      fs.mkdirSync(path.join(soul, 'memory', '.meta'), { recursive: true });
      const indexTarget = path.join(outside, 'index-target');
      const metaTarget = path.join(outside, 'meta-target');
      fs.symlinkSync(indexTarget, path.join(soul, 'memory', 'index.md'));
      fs.symlinkSync(metaTarget, path.join(soul, 'memory', '.meta', 'index.json'));

      const souls = await loadBoth();

      expect(fs.existsSync(indexTarget)).toBe(false);
      expect(fs.existsSync(metaTarget)).toBe(false);
      expect(fs.readdirSync(outside)).toEqual(['secret.md']);
      expect(fs.lstatSync(path.join(soul, 'memory', 'index.md')).isSymbolicLink()).toBe(true);
      for (const loaded of souls) {
        expect(loaded.soulContent).toBe('You are Aria.');
        expect(loaded.personaDefinition.name).toBe('Aria');
        expect(loaded.memoryContent).toBe('# Facts\n\nThe user likes short replies.');
        expect(loaded.wikiIndex).toBeUndefined();
        expect(loaded.memoryDir).toBe(path.join(soul, 'memory'));
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a memory folder that is a link to a folder outside is left as it is: nothing is made or written in that folder, and the soul still loads',
    async () => {
      fs.writeFileSync(path.join(soul, 'MEMORY.md'), '# Facts\n\nThe user likes short replies.\n');
      fs.symlinkSync(outside, path.join(soul, 'memory'), 'dir');

      const souls = await loadBoth();

      expect(fs.readdirSync(outside)).toEqual(['secret.md']);
      for (const loaded of souls) {
        expect(loaded.soulContent).toBe('You are Aria.');
        expect(loaded.wikiIndex).toBeUndefined();
      }
      expect(warningsAbout(path.join(soul, 'memory'))).toContain(
        `[ensureMemoryDir] Made nothing in ${path.join(soul, 'memory')}: a symbolic link holds the place of the workspace's folder, memory/ or memory/.meta`,
      );
    },
  );
});
