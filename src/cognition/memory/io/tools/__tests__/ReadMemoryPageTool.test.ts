import { describe, it, expect } from 'vitest';
import { ReadMemoryPageTool } from '../ReadMemoryPageTool.js';
import type { WikiPage } from '../../../../substrate/memory/wiki/types.js';

const page: WikiPage = {
  id: 'entities/johnny',
  type: 'entity',
  summary: 'Founder.',
  updated: '',
  sources: [],
  body: 'Founder of Frame.',
  links: ['Frame'],
};

/** A port over `readPage` that lists one page as the operator's. */
const portOf = (readPage: (id: string) => Promise<WikiPage | null>) => ({
  readPage,
  listPages: async () => [{ id: page.id, summary: page.summary, owner: 'operator' as const }],
});

describe('ReadMemoryPageTool', () => {
  it('returns the page for a known id', async () => {
    const tool = new ReadMemoryPageTool(portOf(async (id) => (id === 'entities/johnny' ? page : null)));
    const res = await tool.execute({ id: 'entities/johnny' }, {} as any);
    expect(res.success).toBe(true);
    expect(res.output).toMatchObject({ id: 'entities/johnny', body: 'Founder of Frame.' });
  });

  it('returns an error result for an unknown id', async () => {
    const tool = new ReadMemoryPageTool(portOf(async () => null));
    const res = await tool.execute({ id: 'entities/nobody' }, {} as any);
    expect(res.success).toBe(false);
    expect(res.error).toContain('No memory page');
  });

  it('refuses an id without the wiki id form and never asks the port for it', async () => {
    const asked: string[] = [];
    const tool = new ReadMemoryPageTool(
      portOf(async (id) => {
        asked.push(id);
        return page;
      }),
    );
    const res = await tool.execute({ id: '../entities/johnny' }, {} as any);
    expect(res).toMatchObject({ success: false, details: { code: 'INVALID_WIKI_PAGE_ID', problem: 'dot' } });
    expect(res.output).toBeUndefined();
    const typed = await tool.execute({ id: 42 } as any, {} as any);
    expect(typed).toMatchObject({ success: false, details: { code: 'INVALID_WIKI_PAGE_ID', problem: 'type' } });
    expect(asked).toEqual([]);
  });

  it('exposes ITool identity fields, and a schema that takes an id or the listing', () => {
    const tool = new ReadMemoryPageTool(portOf(async () => null));
    expect(tool.name).toBe('read_memory_page');
    expect(tool.id).toBe('read-memory-page-v1');
    // Neither is required: a call gives an id, or asks for the list.
    expect(tool.inputSchema.required).toBeUndefined();
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(['id', 'list']);
    expect(tool.description).toContain('{ "list": true }');
  });

  it('lists the pages the port answers when asked for the list', async () => {
    const tool = new ReadMemoryPageTool(portOf(async () => null));
    const res = await (tool as unknown as { execute(a: unknown, c: unknown): Promise<{ success: boolean; output?: unknown }> }).execute(
      { list: true },
      {},
    );
    expect(res.success).toBe(true);
    expect(res.output).toEqual({ pages: [{ id: 'entities/johnny', summary: 'Founder.', owner: 'operator' }] });
  });
});
