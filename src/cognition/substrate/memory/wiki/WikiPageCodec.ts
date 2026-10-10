/** @fileoverview Parse/serialize wiki pages (gray-matter) and render the index.md catalog. */
import { readFrontMatter, writeFrontMatter } from '../../../../core/utils/frontMatter.js';
import { type WikiPage, type WikiPageType, isWikiPageType } from './types.js';

const WIKILINK_RE = /\[\[\s*([^\]]+?)\s*\]\]/g;

/** Extract `[[wikilink]]` targets, trimmed and de-duplicated, order-preserving. */
export function extractWikiLinks(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(WIKILINK_RE)) {
    const target = m[1].trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

/**
 * Parse a page file's content into a WikiPage. `id` is the caller-known relative id.
 * The front matter is read as data: a block marked as JavaScript is dropped, never evaluated.
 */
export function parsePage(id: string, raw: string): WikiPage {
  const { data, content } = readFrontMatter(raw);
  const type: WikiPageType = isWikiPageType(data.type) ? data.type : inferTypeFromId(id);
  const body = content.replace(/^\s+/, '');
  return {
    id,
    type,
    summary: typeof data.summary === 'string' ? data.summary : '',
    updated: typeof data.updated === 'string' ? data.updated : '',
    sources: Array.isArray(data.sources) ? data.sources.map(String) : [],
    body,
    links: extractWikiLinks(body),
  };
}

/**
 * Serialize a WikiPage back to markdown with YAML frontmatter. The body is written as it is and
 * never read, so one that opens with a line of dashes keeps every line.
 */
export function serializePage(page: WikiPage): string {
  return writeFrontMatter(page.body.endsWith('\n') ? page.body : page.body + '\n', {
    id: page.id,
    type: page.type,
    summary: page.summary,
    updated: page.updated,
    sources: page.sources,
  });
}

/** Render index.md: pages grouped by type, each with a one-line summary and link. */
export function renderCatalog(pages: WikiPage[]): string {
  const groups: Record<WikiPageType, WikiPage[]> = { entity: [], concept: [], log: [] };
  for (const p of pages) groups[p.type].push(p);
  const lines: string[] = ['# Memory Index', ''];
  const headings: Array<[WikiPageType, string]> = [
    ['entity', '## Entities'],
    ['concept', '## Concepts'],
    ['log', '## Log'],
  ];
  for (const [type, heading] of headings) {
    const list = groups[type];
    if (list.length === 0) continue;
    lines.push(heading, '');
    for (const p of list.sort((a, b) => a.id.localeCompare(b.id))) {
      const name = p.id.split('/').pop() ?? p.id;
      const summary = p.summary ? `: ${p.summary}` : '';
      lines.push(`- [${name}](${p.id}.md)${summary}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function inferTypeFromId(id: string): WikiPageType {
  if (id.startsWith('entities/')) return 'entity';
  if (id.startsWith('log/')) return 'log';
  return 'concept';
}
