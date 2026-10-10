/**
 * @fileoverview MarkdownLoader — loads `.md` and `.mdx` documents.
 *
 * Parses YAML front-matter using the `gray-matter` library, strips it from
 * the returned content, and promotes key metadata fields (title, author,
 * createdAt, etc.) into the {@link DocumentMetadata} shape.
 *
 * When no `title` key is present in the front-matter the loader falls back
 * to extracting the first ATX heading (`# …`) from the document body.
 *
 * Front matter is read as data. A block marked as JavaScript (`---js` or
 * `---javascript`), which gray-matter's own engine would evaluate, is taken
 * off the content like any front matter and gives no metadata.
 *
 * @module memory/ingestion/MarkdownLoader
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { IDocumentLoader } from './IDocumentLoader.js';
import type { LoadOptions, LoadedDocument, DocumentMetadata } from '../facade/types.js';
import { readFrontMatter } from '../../../../core/utils/frontMatter.js';
import { validatePath } from './pathUtils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Extensions handled by this loader, each with a leading dot. */
const SUPPORTED_EXTENSIONS = ['.md', '.mdx'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the lower-cased extension (with dot) of a file path.
 *
 * @param filePath - Absolute or relative file path.
 */
function extOf(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

/**
 * Approximate word count for the body text (excludes front-matter).
 *
 * @param text - Stripped Markdown body string.
 */
function wordCount(text: string): number {
  return text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
}

/**
 * Extract the first ATX heading from a Markdown body.
 *
 * Matches `# Title` at the beginning of a line (with optional leading
 * whitespace) and returns the trimmed heading text.  Returns `undefined`
 * when no heading is found.
 *
 * @param body - Markdown body text with front-matter already removed.
 */
function extractFirstHeading(body: string): string | undefined {
  // Match ATX headings at level 1 only (`# …`) — the most common title pattern.
  const match = /^#{1}\s+(.+)/m.exec(body);
  return match ? match[1].trim() : undefined;
}

/**
 * Coerce a raw front-matter date value (Date object, ISO string, or number)
 * into an ISO 8601 string, returning `undefined` when conversion is not
 * possible.
 *
 * @param value - Raw value from the parsed front-matter data object.
 */
function toIsoString(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// MarkdownLoader
// ---------------------------------------------------------------------------

/**
 * Document loader for Markdown (`.md`) and MDX (`.mdx`) files.
 *
 * ### Front-matter handling
 * YAML front-matter delimited by `---` is parsed via `gray-matter`.  All
 * key-value pairs are merged into {@link DocumentMetadata} as-is, with a
 * handful of well-known keys (`title`, `author`, `createdAt`, `modifiedAt`,
 * `language`) mapped to the corresponding typed metadata fields.  A block
 * marked as JavaScript (`---js`) is never evaluated: it is dropped and gives
 * no metadata.
 *
 * ### Title extraction fallback
 * When the front-matter does **not** contain a `title` field the loader
 * searches the document body for the first level-1 ATX heading (`# Title`)
 * and uses that as the title.
 *
 * ### Returned content
 * The `content` field in the returned {@link LoadedDocument} contains the
 * Markdown body **without** the front-matter block.
 *
 * @implements {IDocumentLoader}
 *
 * @example
 * ```ts
 * const loader = new MarkdownLoader();
 * const doc = await loader.load('/docs/architecture.md');
 * console.log(doc.metadata.title); // from front-matter or first # heading
 * ```
 */
export class MarkdownLoader implements IDocumentLoader {
  /** @inheritdoc */
  readonly supportedExtensions: string[] = [...SUPPORTED_EXTENSIONS];

  // -------------------------------------------------------------------------
  // canLoad
  // -------------------------------------------------------------------------

  /** @inheritdoc */
  canLoad(source: string | Buffer): boolean {
    if (Buffer.isBuffer(source)) {
      // Without an extension we tentatively accept Buffers for flexibility;
      // callers should prefer path-based loading to ensure correct routing.
      return false;
    }
    return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extOf(source));
  }

  // -------------------------------------------------------------------------
  // load
  // -------------------------------------------------------------------------

  /** @inheritdoc */
  async load(source: string | Buffer, _options?: LoadOptions): Promise<LoadedDocument> {
    let raw: string;
    let resolvedPath: string | undefined;

    if (Buffer.isBuffer(source)) {
      raw = source.toString('utf8');
    } else {
      resolvedPath = validatePath(source);
      const bytes = await fs.readFile(resolvedPath);
      raw = bytes.toString('utf8');
    }

    // ---- Parse front-matter ----
    // Read as data: a block marked as JavaScript is dropped, never evaluated.
    const parsed = readFrontMatter(raw);

    // `parsed.content` is the body with front-matter stripped.
    const body = parsed.content;

    // ---- Build metadata ----
    const fm = parsed.data as Record<string, unknown>;

    // Attempt to resolve a title from: frontmatter > first heading.
    const fmTitle =
      typeof fm['title'] === 'string' ? fm['title'] : undefined;
    const headingTitle = fmTitle === undefined ? extractFirstHeading(body) : undefined;
    const title = fmTitle ?? headingTitle;

    const meta: DocumentMetadata = {
      // Well-known scalar fields.
      ...(title !== undefined ? { title } : {}),
      ...(typeof fm['author'] === 'string' ? { author: fm['author'] } : {}),
      ...(fm['createdAt'] !== undefined
        ? { createdAt: toIsoString(fm['createdAt']) }
        : {}),
      ...(fm['modifiedAt'] !== undefined
        ? { modifiedAt: toIsoString(fm['modifiedAt']) }
        : {}),
      ...(typeof fm['language'] === 'string' ? { language: fm['language'] } : {}),
      // Spread all remaining front-matter keys as generic extras.
      ...fm,
      // Override title with resolved value (may differ from fm.title when
      // extracted from heading) and add standard fields.
      ...(title !== undefined ? { title } : {}),
      wordCount: wordCount(body),
      ...(resolvedPath ? { source: resolvedPath } : {}),
    };

    return {
      content: body,
      metadata: meta,
      format: 'md',
    };
  }
}
