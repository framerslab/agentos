/** @fileoverview Parse/serialize wiki pages (gray-matter) and render the index.md catalog. */
import { readFrontMatter, writeFrontMatter } from '../../../../core/utils/frontMatter.js';
import { migratedBlockOf, withMigratedText, withoutMigratedEndMarker } from './migrateMemoryMd.js';
import { type WikiPage, type WikiPageOrigin, type WikiPageType, isWikiPageType } from './types.js';

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

/** The origin a page's front matter tells: by its `sources` field alone. */
function originOfFrontMatter(data: Record<string, unknown>): WikiPageOrigin {
  if (!Object.prototype.hasOwnProperty.call(data, 'sources')) return 'operator';
  if (!Array.isArray(data.sources)) return 'uncertain';
  return data.sources.length > 0 ? 'compiled' : 'operator';
}

/**
 * The origin of a page file's text, from its front matter: `compiled` when `sources` is a list that holds an entry,
 * `uncertain` when the front matter does not parse or `sources` is there and is not a list, else `operator`.
 *
 * A compile lists the traces a page was made from in `sources`; a page written by hand lists none.
 *
 * @param raw - The page file's text.
 */
export function pageOriginOf(raw: string): WikiPageOrigin {
  let data: Record<string, unknown>;
  try {
    data = readFrontMatter(raw).data;
  } catch {
    return 'uncertain';
  }
  return originOfFrontMatter(data);
}

/**
 * The origin of a page: the one `parsePage` read from its front matter, or, for a page built in code, `compiled`
 * when it lists sources and `operator` when it lists none.
 */
export function originOfPage(page: WikiPage): WikiPageOrigin {
  return page.origin ?? (page.sources.length > 0 ? 'compiled' : 'operator');
}

/**
 * Parse a page file's content into a WikiPage. `id` is the caller-known relative id.
 * The front matter is read as data: a block marked as JavaScript is dropped, never evaluated.
 * Blank lines between the front matter and the body are dropped, and the body's first line
 * keeps its indentation. The page's `origin` is set from the front matter (see {@link pageOriginOf}).
 *
 * @throws {Error} When the front matter does not parse.
 */
export function parsePage(id: string, raw: string): WikiPage {
  const { data, content } = readFrontMatter(raw);
  const type: WikiPageType = isWikiPageType(data.type) ? data.type : inferTypeFromId(id);
  const body = content.replace(/^(?:[ \t]*\r?\n)+/, '');
  return {
    id,
    type,
    summary: typeof data.summary === 'string' ? data.summary : '',
    updated: typeof data.updated === 'string' ? data.updated : '',
    sources: Array.isArray(data.sources) ? data.sources.map(String) : [],
    body,
    links: extractWikiLinks(body),
    origin: originOfFrontMatter(data),
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

/**
 * Render index.md: the operator's pages grouped by type, each with a one-line summary and link. A page a compile
 * wrote, and one whose origin cannot be told, is left out (see {@link originOfPage}): its summary and its id reach
 * no catalog, and so no prompt.
 */
export function renderCatalog(pages: WikiPage[]): string {
  const groups: Record<WikiPageType, WikiPage[]> = { entity: [], concept: [], log: [] };
  for (const p of pages) {
    if (originOfPage(p) === 'operator') groups[p.type].push(p);
  }
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

/**
 * The memory index a prompt is given: the catalog of the operator's pages, after the text migrated from a legacy
 * `MEMORY.md` that `indexMd` holds, without that text's end marker. It is what the wiki store writes into
 * `memory/index.md`, rendered from the pages rather than read from the file, so nothing else the file holds reaches
 * a prompt.
 *
 * @param pages - The pages under memory/; only the operator's are listed.
 * @param indexMd - The text of `memory/index.md`, read for its migrated block alone.
 * @returns The index, trimmed.
 */
export function operatorIndexText(pages: WikiPage[], indexMd: string): string {
  const catalog = renderCatalog(pages);
  const migrated = migratedBlockOf(indexMd);
  return withoutMigratedEndMarker(migrated === null ? catalog : withMigratedText(catalog, migrated));
}

function inferTypeFromId(id: string): WikiPageType {
  if (id.startsWith('entities/')) return 'entity';
  if (id.startsWith('log/')) return 'log';
  return 'concept';
}
