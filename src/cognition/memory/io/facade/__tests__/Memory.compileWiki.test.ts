import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Memory } from '../Memory.js';
import { conversationScopeKey } from '../../../retrieval/store/conversationScopeKey.js';

/** The scope the traces of these tests are filed under: one user of one agent. */
const SCOPE = conversationScopeKey('a1', { kind: 'user', id: 'ana' });
/** A page store that holds nothing and keeps nothing. */
const noPages = () => ({ readPage: async () => null, writePage: async () => {} });
/** When the scope was last compiled (Unix ms), from its registry row; null before its first compile. */
const watermarkOf = async (mem: Memory): Promise<number | null> =>
  (await mem.listScopes()).find((row) => row.scopeId === SCOPE)?.compiledAt ?? null;

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
  it("runs the attached compiler over a scope's new traces, with that scope's page store", async () => {
    const mem = await makeMemory(true);
    await mem.remember('Johnny prefers terse commits.', { type: 'episodic', scope: 'conversation', scopeId: SCOPE });

    const compiled: any[] = [];
    const asked: string[] = [];
    const store = noPages();
    mem.attachWiki({
      storeFor: (scopeId: string) => {
        asked.push(scopeId);
        return store;
      },
      compiler: {
        compile: async (input: any) => {
          compiled.push(input);
          return { pagesWritten: ['entities/johnny'], tracesConsumed: 1, conflicts: [] };
        },
      },
    });

    const res = await mem.compileWiki({ reason: 'explicit' });
    expect(res.pagesWritten).toEqual(['entities/johnny']);
    expect(compiled).toHaveLength(1);
    expect(compiled[0].traces.map((t: any) => t.content)).toEqual(['Johnny prefers terse commits.']);
    expect(compiled[0].reason).toBe('explicit');
    // The compiler writes through the store of the scope it compiles, and no other.
    expect(compiled[0].store).toBe(store);
    expect(asked).toEqual([SCOPE]);
  });

  it('advances the watermark to the newest processed trace and drains on re-compile', async () => {
    const mem = await makeMemory(true);
    const t = await mem.remember('Johnny likes terse commits.', { type: 'episodic', scope: 'conversation', scopeId: SCOPE });

    let compileCalls = 0;
    mem.attachWiki({
      storeFor: () => noPages(),
      compiler: {
        compile: async (input: any) => {
          compileCalls++;
          return {
            pagesWritten: input.traces.length ? ['entities/johnny'] : [],
            tracesConsumed: input.traces.length,
            conflicts: [],
          };
        },
      },
    });

    const first = await mem.compileWiki({ reason: 'explicit' });
    expect(first.tracesConsumed).toBe(1);
    // The scope's watermark is the trace's own created_at, NOT wall-clock now.
    expect(await watermarkOf(mem)).toBe(t.createdAt);

    const callsAfterFirst = compileCalls;
    const second = await mem.compileWiki({ reason: 'explicit' });
    expect(second.tracesConsumed).toBe(0);
    expect(second.pagesWritten).toEqual([]);
    // Window already drained → compiler not invoked again.
    expect(compileCalls).toBe(callsAfterFirst);
  });

  it('keeps the watermark when a compile rejects, so the next compile takes up the same traces', async () => {
    const mem = await makeMemory(false);
    await mem.remember('Johnny prefers terse commits.', { type: 'episodic', scope: 'conversation', scopeId: SCOPE });

    let diskFull = true;
    const compiled: string[][] = [];
    mem.attachWiki({
      storeFor: () => noPages(),
      compiler: {
        compile: async (input: any) => {
          compiled.push(input.traces.map((t: any) => t.content));
          if (diskFull) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
          return { pagesWritten: ['entities/johnny'], tracesConsumed: input.traces.length, conflicts: [] };
        },
      },
    });

    await expect(mem.compileWiki({ reason: 'explicit' })).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await watermarkOf(mem)).toBeNull();

    diskFull = false;
    const res = await mem.compileWiki({ reason: 'explicit' });
    expect(res.tracesConsumed).toBe(1);
    expect(compiled).toEqual([['Johnny prefers terse commits.'], ['Johnny prefers terse commits.']]);
    expect(await watermarkOf(mem)).not.toBeNull();
  });

  it('leaves a trace of any other scope out of every compile', async () => {
    const mem = await makeMemory(false);
    await mem.remember('Johnny prefers terse commits.', { type: 'episodic', scope: 'persona', scopeId: 'a1' });

    let compileCalls = 0;
    mem.attachWiki({
      storeFor: () => noPages(),
      compiler: {
        compile: async () => {
          compileCalls++;
          return { pagesWritten: [], tracesConsumed: 0, conflicts: [] };
        },
      },
    });

    expect(await mem.compileWiki({ reason: 'explicit' })).toEqual({ pagesWritten: [], tracesConsumed: 0, conflicts: [] });
    expect(compileCalls).toBe(0);
  });

  it('no-ops when no wiki is attached', async () => {
    const mem = await makeMemory(false);
    const res = await mem.compileWiki({ reason: 'explicit' });
    expect(res.pagesWritten).toEqual([]);
  });
});
