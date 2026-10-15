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

describe('ReadMemoryPageTool', () => {
  it('returns the page for a known id', async () => {
    const tool = new ReadMemoryPageTool({ readPage: async (id) => (id === 'entities/johnny' ? page : null) });
    const res = await tool.execute({ id: 'entities/johnny' }, {} as any);
    expect(res.success).toBe(true);
    expect(res.output?.body).toContain('Founder of Frame.');
    expect(res.output?.id).toBe('entities/johnny');
  });

  it('returns an error result for an unknown id', async () => {
    const tool = new ReadMemoryPageTool({ readPage: async () => null });
    const res = await tool.execute({ id: 'entities/nobody' }, {} as any);
    expect(res.success).toBe(false);
    expect(res.error).toContain('No memory page');
  });

  it('refuses an id without the wiki id form and never asks the port for it', async () => {
    const asked: string[] = [];
    const tool = new ReadMemoryPageTool({
      readPage: async (id) => {
        asked.push(id);
        return page;
      },
    });
    const res = await tool.execute({ id: '../entities/johnny' }, {} as any);
    expect(res).toMatchObject({ success: false, details: { code: 'INVALID_WIKI_PAGE_ID', problem: 'dot' } });
    expect(res.output).toBeUndefined();
    const typed = await tool.execute({ id: 42 } as any, {} as any);
    expect(typed).toMatchObject({ success: false, details: { code: 'INVALID_WIKI_PAGE_ID', problem: 'type' } });
    expect(asked).toEqual([]);
  });

  it('exposes ITool identity fields', () => {
    const tool = new ReadMemoryPageTool({ readPage: async () => null });
    expect(tool.name).toBe('read_memory_page');
    expect(tool.id).toBe('read-memory-page-v1');
    expect(tool.inputSchema.required).toContain('id');
  });
});
