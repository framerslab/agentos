import { describe, it, expect } from 'vitest';
import { WikiCompiler } from '../WikiCompiler.js';
import type { WikiPage } from '../types.js';

function fakeStore(initial: WikiPage[] = []) {
  const pages = new Map(initial.map((p) => [p.id, p]));
  return {
    pages,
    readPage: async (id: string) => pages.get(id) ?? null,
    writePage: async (p: WikiPage) => {
      pages.set(p.id, p);
    },
  };
}

describe('WikiCompiler', () => {
  it('ignores wiki-tagged traces (no feedback loop)', async () => {
    const store = fakeStore();
    const compiler = new WikiCompiler({
      store: store as any,
      llm: async () => 'SHOULD NOT BE CALLED',
      cluster: async () => [{ pageId: 'entities/x', traceIds: ['t1'] }],
    });
    const res = await compiler.compile({
      traces: [{ id: 't1', content: 'indexed chunk', tags: ['wiki', 'page:entities/x'], entities: [] }] as any,
      reason: 'explicit',
    });
    expect(res.tracesConsumed).toBe(0);
    expect(res.pagesWritten).toEqual([]);
  });

  it('never hands a store an id without the wiki id form, and reports the assignment', async () => {
    const store = fakeStore();
    const prompts: string[] = [];
    const compiler = new WikiCompiler({
      store: store as any,
      llm: async (prompt: string) => {
        prompts.push(prompt);
        return 'merged';
      },
      cluster: async () => [
        { pageId: '../outside', traceIds: ['t1'] },
        { pageId: 'concepts/notes', traceIds: ['t2'] },
      ],
    });
    const res = await compiler.compile({
      traces: [
        { id: 't1', content: 'first', tags: [], entities: [] },
        { id: 't2', content: 'second', tags: [], entities: [] },
      ] as any,
      reason: 'explicit',
    });
    expect(res.pagesWritten).toEqual(['concepts/notes']);
    expect(res.conflicts).toEqual([{ pageId: '../outside', note: expect.stringContaining('refused') }]);
    expect([...store.pages.keys()]).toEqual(['concepts/notes']);
    expect(prompts).toHaveLength(1);
  });

  it('reports a page the file system refuses for its path and goes on, and stops on any other write error', async () => {
    const failure = (code: string) => Object.assign(new Error(`${code}: the write failed`), { code });
    const traces = [
      { id: 't1', content: 'first', tags: [], entities: [] },
      { id: 't2', content: 'second', tags: [], entities: [] },
    ] as any;
    const compilerFailing = (pageId: string, code: string) => {
      const store = fakeStore();
      const write = store.writePage;
      store.writePage = async (p: WikiPage) => {
        if (p.id === pageId) throw failure(code);
        await write(p);
      };
      const compiler = new WikiCompiler({
        store: store as any,
        llm: async () => 'merged',
        cluster: async () => [
          { pageId, traceIds: ['t1'] },
          { pageId: 'concepts/kept', traceIds: ['t2'] },
        ],
      });
      return { store, compiler };
    };

    // The same write would fail on every compile: reported, and the next page is written.
    const refused = compilerFailing('concepts/refused', 'ENAMETOOLONG');
    const res = await refused.compiler.compile({ traces, reason: 'explicit' });
    expect(res.pagesWritten).toEqual(['concepts/kept']);
    expect(res.tracesConsumed).toBe(1);
    expect(res.conflicts).toEqual([{ pageId: 'concepts/refused', note: expect.stringContaining('ENAMETOOLONG') }]);

    // A full disk may pass, so the compile stops and its caller compiles the same traces again.
    const full = compilerFailing('concepts/full', 'ENOSPC');
    await expect(full.compiler.compile({ traces, reason: 'explicit' })).rejects.toMatchObject({ code: 'ENOSPC' });
    expect([...full.store.pages.keys()]).toEqual([]);
  });

  it('merges a new fact into an existing page, preserving prior body', async () => {
    const store = fakeStore([
      { id: 'entities/johnny', type: 'entity', summary: 'Founder.', updated: '', sources: ['t0'], body: 'Founder of Frame.', links: ['Frame'] },
    ]);
    const compiler = new WikiCompiler({
      store: store as any,
      llm: async (prompt: string) => {
        expect(prompt).toContain('Founder of Frame.'); // current body handed to the LLM
        return 'Founder of Frame. Prefers terse commits.';
      },
      cluster: async () => [{ pageId: 'entities/johnny', traceIds: ['t1'] }],
    });
    const res = await compiler.compile({
      traces: [{ id: 't1', content: 'Johnny prefers terse commits.', tags: [], entities: ['Frame'] }] as any,
      reason: 'consolidation',
    });
    expect(res.pagesWritten).toEqual(['entities/johnny']);
    const merged = await store.readPage('entities/johnny');
    expect(merged?.body).toContain('Prefers terse commits.');
    expect(merged?.body).toContain('Founder of Frame.'); // not clobbered
    expect(merged?.sources).toContain('t1'); // provenance appended
  });
});
