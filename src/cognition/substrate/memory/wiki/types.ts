/** @fileoverview Shared types for the soul memory wiki. */

export const WIKI_PAGE_TYPES = ['entity', 'concept', 'log'] as const;
export type WikiPageType = (typeof WIKI_PAGE_TYPES)[number];

export function isWikiPageType(v: unknown): v is WikiPageType {
  return typeof v === 'string' && (WIKI_PAGE_TYPES as readonly string[]).includes(v);
}

/** A single wiki page: parsed frontmatter + markdown body. */
export interface WikiPage {
  /**
   * Stable id = path relative to memory/ without extension, with `/` between folders, e.g. 'entities/johnny'.
   * The store refuses an id without this form (see `isWikiPageId`) before it reads or writes a file.
   */
  id: string;
  type: WikiPageType;
  /** One-line catalog summary. */
  summary: string;
  /** ISO8601 last-update timestamp. */
  updated: string;
  /** Provenance: ids of memory traces that fed this page. */
  sources: string[];
  /** Markdown body (frontmatter stripped). */
  body: string;
  /** Parsed `[[wikilink]]` targets found in the body. */
  links: string[];
}

/** Persisted in `.meta/index.json`. */
export interface MetaIndex {
  /** ISO8601 watermark: last successful compile. */
  lastCompiledAt: string | null;
  /** pageId → { hash, traceIds } so re-index only touches changed pages. */
  pages: Record<string, { hash: string; traceIds: string[] }>;
}

export interface IndexResult {
  /** Page ids re-embedded this run. */
  indexed: string[];
  /** Unchanged page ids. */
  skipped: string[];
  /** Trace ids forgotten. */
  removed: string[];
}

export interface CompileResult {
  pagesWritten: string[];
  tracesConsumed: number;
  conflicts: Array<{ pageId: string; note: string }>;
}
