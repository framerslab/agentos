import { describe, it, expect } from 'vitest';
import { parsePage, serializePage, extractWikiLinks, renderCatalog } from '../WikiPageCodec.js';

describe('WikiPageCodec', () => {
  it('round-trips a page through serialize → parse', () => {
    const page = {
      id: 'entities/johnny',
      type: 'entity' as const,
      summary: 'Founder of Frame.',
      updated: '2026-06-02T10:00:00Z',
      sources: ['trace:a'],
      body: 'Founder of [[Frame]] and [[wilds-ai]].',
      links: ['Frame', 'wilds-ai'],
    };
    const md = serializePage(page);
    const parsed = parsePage('entities/johnny', md);
    expect(parsed.type).toBe('entity');
    expect(parsed.summary).toBe('Founder of Frame.');
    expect(parsed.sources).toEqual(['trace:a']);
    expect(parsed.body.trim()).toBe('Founder of [[Frame]] and [[wilds-ai]].');
    expect(parsed.links).toEqual(['Frame', 'wilds-ai']);
  });

  it('keeps a body that opens with a front-matter block, and evaluates none marked as JavaScript', () => {
    // Evaluated, the block would set this global and give the type 'log'.
    const mark = '__agentosWikiFrontMatterEvaluated';
    const body = `---js\n{ type: (globalThis.${mark} = true) && 'log' }\n---\nNotes on [[Frame]].\n`;
    const page = {
      id: 'concepts/notes',
      type: 'concept' as const,
      summary: 'Notes.',
      updated: '2026-06-02T10:00:00Z',
      sources: ['trace:a'],
      body,
      links: ['Frame'],
    };

    try {
      // Written under the page's own front matter, the body comes back whole.
      const parsed = parsePage('concepts/notes', serializePage(page));
      expect(parsed.type).toBe('concept');
      expect(parsed.summary).toBe('Notes.');
      expect(parsed.body).toBe(body);

      // As a page file's own front matter, the block is dropped and the id decides the type.
      const direct = parsePage('concepts/notes', body);
      expect(direct.type).toBe('concept');
      expect(direct.body).toBe('Notes on [[Frame]].\n');

      expect(Reflect.get(globalThis, mark)).toBeUndefined();
    } finally {
      Reflect.deleteProperty(globalThis, mark);
    }
  });

  it('extractWikiLinks dedupes and trims', () => {
    expect(extractWikiLinks('see [[Frame]] and [[ Frame ]] and [[AgentOS]]')).toEqual(['Frame', 'AgentOS']);
  });

  it('defaults type to concept and tolerates missing frontmatter', () => {
    const parsed = parsePage('concepts/x', '# X\n\nbody only, no frontmatter');
    expect(parsed.type).toBe('concept');
    expect(parsed.summary).toBe('');
    expect(parsed.links).toEqual([]);
  });

  it('renderCatalog groups pages by type with summaries + links', () => {
    const cat = renderCatalog([
      { id: 'entities/johnny', type: 'entity', summary: 'Founder.', updated: '', sources: [], body: '', links: [] },
      { id: 'concepts/billing', type: 'concept', summary: 'How billing works.', updated: '', sources: [], body: '', links: [] },
    ]);
    expect(cat).toContain('# Memory Index');
    expect(cat).toContain('## Entities');
    expect(cat).toContain('[johnny](entities/johnny.md)');
    expect(cat).toContain('Founder.');
    expect(cat).toContain('## Concepts');
  });
});
