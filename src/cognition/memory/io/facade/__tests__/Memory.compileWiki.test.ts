import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Memory } from '../Memory.js';

const opened: Memory[] = [];
const dirs: string[] = [];

async function makeMemory(selfImprove = false): Promise<Memory> {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memwiki-'));
  dirs.push(d);
  const mem = await Memory.createSqlite(path.join(d, 'm.sqlite'), { graph: false, selfImprove, decay: false });
  opened.push(mem);
  return mem;
}

afterEach(async () => {
  for (const m of opened) {
    try {
      await m.close();
    } catch {
      /* */
    }
  }
  opened.length = 0;
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
  dirs.length = 0;
});

describe('Memory.compileWiki', () => {
  it('runs the attached compiler over recent non-wiki traces then indexes', async () => {
    const mem = await makeMemory(true);
    await mem.remember('Johnny prefers terse commits.', { type: 'episodic', scope: 'persona', scopeId: 'a1' });

    const compiled: any[] = [];
    let indexed = 0;
    mem.attachWiki({
      store: {
        index: async () => {
          indexed++;
          return { indexed: [], skipped: [], removed: [] };
        },
        readMetaWatermark: async () => null,
        writeMetaWatermark: async () => {},
      } as any,
      compiler: {
        compile: async (input: any) => {
          compiled.push(input);
          return { pagesWritten: ['entities/johnny'], tracesConsumed: 1, conflicts: [] };
        },
      } as any,
    });

    const res = await mem.compileWiki({ reason: 'explicit' });
    expect(res.pagesWritten).toEqual(['entities/johnny']);
    expect(compiled[0].traces.some((t: any) => t.content.includes('terse commits'))).toBe(true);
    expect(indexed).toBe(1);
  });

  it('no-ops when no wiki is attached', async () => {
    const mem = await makeMemory(false);
    const res = await mem.compileWiki({ reason: 'explicit' });
    expect(res.pagesWritten).toEqual([]);
  });
});
