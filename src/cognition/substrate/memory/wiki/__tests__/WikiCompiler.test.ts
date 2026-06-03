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
