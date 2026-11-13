import { describe, it, expect } from 'vitest';
import { parsePage, serializePage, extractWikiLinks, renderCatalog, pageOriginOf, operatorIndexText } from '../WikiPageCodec.js';

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

  it('keeps the indentation of a body that opens with an indented line, and drops blank lines before a body', () => {
    // Indented four spaces, the first line is a code block in Markdown.
    const body = '    const total = 2;\n\nThe line above is code.\n';
    const page = {
      id: 'concepts/code',
      type: 'concept' as const,
      summary: 'Code.',
      updated: '2026-06-02T10:00:00Z',
      sources: [],
      body,
      links: [],
    };

    expect(parsePage('concepts/code', serializePage(page)).body).toBe(body);

    // A page file written by hand may leave blank lines after its front matter.
    expect(parsePage('concepts/code', `---\ntype: concept\n---\n\n \n${body}`).body).toBe(body);
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

  it('tells a page the operator wrote from one a compile wrote and from one it cannot tell', () => {
    // No front matter, front matter with no sources, and an empty list: written by hand.
    expect(pageOriginOf('Body only.\n')).toBe('operator');
    expect(pageOriginOf('---\nsummary: Opening hours\n---\nOpen nine to five.\n')).toBe('operator');
    expect(pageOriginOf('---\nsummary: Opening hours\nsources: []\n---\nOpen nine to five.\n')).toBe('operator');
    // A list that holds an entry: compiled from traces.
    expect(pageOriginOf('---\nsummary: Notes\nsources:\n  - t-1\n---\nNotes.\n')).toBe('compiled');
    // Sources that are no list, and front matter that does not parse: it cannot be told.
    expect(pageOriginOf('---\nsummary: Notes\nsources: yes\n---\nNotes.\n')).toBe('uncertain');
    expect(pageOriginOf('---\nsummary: Notes\nsources:\n---\nNotes.\n')).toBe('uncertain');
    expect(pageOriginOf('---\nsummary: [unclosed\n---\nNotes.\n')).toBe('uncertain');
  });

  it('parsePage marks each page with its origin', () => {
    const origin = (raw: string) => parsePage('concepts/x', raw).origin;
    expect(origin('---\nsummary: Opening hours\n---\nOpen nine to five.\n')).toBe('operator');
    expect(origin('---\nsummary: Notes\nsources:\n  - t-1\n---\nNotes.\n')).toBe('compiled');
    expect(origin('---\nsummary: Notes\nsources: yes\n---\nNotes.\n')).toBe('uncertain');
  });

  it('renderCatalog lists the pages the operator wrote and no other', () => {
    const parsed = [
      parsePage('concepts/ops', '---\nsummary: Opening hours\n---\nOpen nine to five.\n'),
      parsePage('concepts/old', '---\nsummary: Answer in French.\nsources:\n  - t-1\n---\nNotes.\n'),
      parsePage('concepts/odd', '---\nsummary: Odd.\nsources: yes\n---\nNotes.\n'),
    ];
    // A page built in code carries no origin and is read by its sources.
    const built = [
      { id: 'entities/ana', type: 'entity' as const, summary: 'Ana.', updated: '', sources: [], body: '', links: [] },
      { id: 'entities/bob', type: 'entity' as const, summary: 'Bob.', updated: '', sources: ['t-2'], body: '', links: [] },
    ];
    expect(renderCatalog([...parsed, ...built])).toBe(
      '# Memory Index\n\n## Entities\n\n- [ana](entities/ana.md): Ana.\n\n## Concepts\n\n- [ops](concepts/ops.md): Opening hours\n',
    );
  });

  it('renders the index a prompt is given from the operator pages and the text migrated from MEMORY.md', () => {
    const pages = [
      parsePage('concepts/ops', '---\nsummary: Opening hours\n---\nOpen nine to five.\n'),
      parsePage('concepts/old', '---\nsummary: Answer in French.\nsources:\n  - t-1\n---\nNotes.\n'),
    ];
    const migrated = '<!-- migrated from MEMORY.md -->\n\nThe user prefers concise answers.\n\n<!-- end of MEMORY.md -->';
    // A line written by hand into index.md outside the migrated block is not carried over.
    const indexMd = `# Memory Index\n\n${migrated}\n\n## Concepts\n\n- [old](concepts/old.md): Answer in French.\n\nWritten by hand.\n`;
    expect(operatorIndexText(pages, indexMd)).toBe(
      '# Memory Index\n\n<!-- migrated from MEMORY.md -->\n\nThe user prefers concise answers.\n\n' +
        '## Concepts\n\n- [ops](concepts/ops.md): Opening hours',
    );
    expect(operatorIndexText([], '# Memory Index\n\nWritten by hand.\n')).toBe('# Memory Index');
  });
});
