/**
 * @fileoverview HtmlLoader — basic HTML-to-text document loader.
 *
 * Converts `.html` and `.htm` files into plain text with lightweight textual
 * transformations.  This is intentionally a *simple* loader — it covers the
 * common case of stripping tag soup and decoding standard HTML entities.  For
 * complex documents (nested frames, JavaScript-rendered content) a headless
 * browser or DOM-parsing library would be more appropriate.
 *
 * Tags are found with forward scans that visit each character a bounded
 * number of times, so a load takes time linear in the document's length
 * however its markup is broken.  A pattern such as `/<[^>]+>/g` scans from
 * every `<` to the end of a page that never closes it, about n²/2 steps, and a
 * megabyte of such markup would hold the caller's event loop for minutes.
 * Each scan below gives the result of the pattern its documentation names.
 *
 * Supported extensions: `.html`, `.htm`
 *
 * @module memory/ingestion/HtmlLoader
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { IDocumentLoader } from './IDocumentLoader.js';
import type { LoadOptions, LoadedDocument, DocumentMetadata } from '../facade/types.js';
import { validatePath } from './pathUtils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Extensions handled by this loader, each with a leading dot. */
const SUPPORTED_EXTENSIONS = ['.html', '.htm'] as const;

/**
 * Names of the block-level tags that become line breaks, each matched as the
 * start of a tag's name (`<pre>` counts as `p`, `<link>` as `li`, `<track>` as
 * `tr`).  `<h1>` to `<h6>` are matched apart.
 */
const BLOCK_TAG_NAMES = ['p', 'div', 'section', 'article', 'header', 'footer', 'li', 'tr', 'blockquote'] as const;

// ---------------------------------------------------------------------------
// Markup scans
// ---------------------------------------------------------------------------

/**
 * Whether `text` holds `word` at `at`, with ASCII letters compared without
 * case.
 *
 * Only ASCII letters fold, as in a regular expression with the `i` flag and no
 * `u` flag: `ſ` does not match `s`, and the Kelvin sign does not match `k`.
 *
 * @param text - The text to look in.
 * @param at - Where `word` would start.
 * @param word - The characters to find, any letters among them in lower case.
 */
function hasAt(text: string, at: number, word: string): boolean {
  if (at + word.length > text.length) return false;
  for (let i = 0; i < word.length; i += 1) {
    const expected = word.charCodeAt(i);
    const actual = text.charCodeAt(at + i);
    // A lower-case ASCII letter less 0x20 is the same letter in upper case.
    if (actual !== expected && !(expected >= 0x61 && expected <= 0x7a && actual === expected - 0x20)) {
      return false;
    }
  }
  return true;
}

/**
 * The first index at or after `from` where `text` holds `tag`, with ASCII
 * letters compared without case, or -1 when there is none.
 *
 * Each `<` is found with `indexOf` and at most `tag.length` characters are
 * compared there, so the scan visits each character a bounded number of
 * times.
 *
 * @param text - The text to look in.
 * @param tag - The characters to find, starting with `<`, any letters among them in lower case.
 * @param from - Where to start looking.
 */
function indexOfTag(text: string, tag: string, from: number): number {
  for (let at = text.indexOf('<', from); at !== -1; at = text.indexOf('<', at + 1)) {
    if (hasAt(text, at, tag)) return at;
  }
  return -1;
}

/**
 * Whether a UTF-16 code unit is a word character for `\b` in a regular
 * expression without the `u` flag: an ASCII letter or digit, or `_`.
 *
 * @param code - The code unit, or `NaN` past the end of the text.
 */
function isWordCharacter(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f // _
  );
}

/**
 * Replaces each `<script>…</script>` or `<style>…</style>` block with one
 * space, as `/<script\b[^>]*>[\s\S]*?<\/script>/gi` (or the same pattern for
 * `style`) does, in one forward scan.
 *
 * A block opens at `<script` (any case) with no word character after it, runs
 * to the first `>` after that and closes at the first `</script>` (any case)
 * after its `>`.  An opening with no `>` after it, or no closing tag after its
 * `>`, leaves the rest of the text as it is: no later opening has either, so
 * none is scanned again.
 *
 * @param html - The markup.
 * @param name - The element's name: `script` or `style`.
 */
function removeRawTextBlocks(html: string, name: 'script' | 'style'): string {
  const opening = `<${name}`;
  const closing = `</${name}>`;
  let text = '';
  let kept = 0;
  let at = html.indexOf('<');
  while (at !== -1) {
    if (hasAt(html, at, opening) && !isWordCharacter(html.charCodeAt(at + opening.length))) {
      const openingEnd = html.indexOf('>', at + opening.length);
      if (openingEnd === -1) break;
      const closingAt = indexOfTag(html, closing, openingEnd + 1);
      if (closingAt === -1) break;
      text += html.slice(kept, at) + ' ';
      kept = closingAt + closing.length;
      at = html.indexOf('<', kept);
    } else {
      at = html.indexOf('<', at + 1);
    }
  }
  return text + html.slice(kept);
}

/**
 * Whether the tag at `at`, a `<`, opens or closes a block-level element, as
 * `<\/?(p|div|section|article|header|footer|h[1-6]|li|tr|blockquote)` matches
 * there.  The name may go on with any characters.
 *
 * @param text - The markup.
 * @param at - The index of a `<`.
 */
function isBlockTag(text: string, at: number): boolean {
  const name = text.charCodeAt(at + 1) === 0x2f /* / */ ? at + 2 : at + 1;
  for (const block of BLOCK_TAG_NAMES) {
    if (hasAt(text, name, block)) return true;
  }
  const level = text.charCodeAt(name + 1);
  return hasAt(text, name, 'h') && level >= 0x31 && level <= 0x36; // h1 to h6
}

/**
 * Replaces each block-level tag with a line break, as
 * `/<\/?(p|div|section|article|header|footer|h[1-6]|li|tr|blockquote)[^>]*>/gi`
 * does, in one forward scan.
 *
 * A tag runs from its `<` to the first `>` after it.  A block-level tag with no
 * `>` after it leaves the rest of the text as it is: no later tag ends either.
 *
 * @param text - The markup, its script and style blocks removed.
 */
function breakBlockTags(text: string): string {
  let out = '';
  let kept = 0;
  let at = text.indexOf('<');
  while (at !== -1) {
    if (isBlockTag(text, at)) {
      const end = text.indexOf('>', at + 1);
      if (end === -1) break;
      out += text.slice(kept, at) + '\n';
      kept = end + 1;
      at = text.indexOf('<', kept);
    } else {
      at = text.indexOf('<', at + 1);
    }
  }
  return out + text.slice(kept);
}

/**
 * Removes every tag, as `/<[^>]+>/g` does, in one forward scan.
 *
 * A tag runs from a `<` to the first `>` after it and holds at least one
 * character, so `<>` stays as text and an attribute holding `<` stays inside
 * its tag.  A `<` with no `>` after it leaves the rest of the text as it is: no
 * later `<` has one either.
 *
 * @param text - The markup.
 */
function removeTags(text: string): string {
  let out = '';
  let kept = 0;
  let at = text.indexOf('<');
  while (at !== -1) {
    const end = text.indexOf('>', at + 1);
    if (end === -1) break;
    if (end > at + 1) {
      out += text.slice(kept, at);
      kept = end + 1;
    }
    at = text.indexOf('<', end + 1);
  }
  return out + text.slice(kept);
}

/**
 * Strip all HTML/XML tags from a string.
 *
 * Handles multi-line tags and self-closing tags.  Does **not** attempt to
 * parse the HTML into a DOM; purely textual.  Each step visits each character
 * a bounded number of times.
 *
 * @param html - Raw HTML string.
 */
function stripTags(html: string): string {
  // Remove `<script>…</script>` and `<style>…</style>` blocks entirely so
  // their content doesn't leak into the extracted text.
  let text = removeRawTextBlocks(removeRawTextBlocks(html, 'script'), 'style');

  // Replace block-level elements with newlines to preserve paragraph breaks.
  text = breakBlockTags(text);

  // Replace `<br>` and `<hr>` with newlines.  These patterns stay: the run of
  // whitespace after a `<br` or `<hr` is read from that tag alone, so each
  // pattern takes time linear in the text.
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<hr\s*\/?>/gi, '\n');

  // Strip remaining tags.
  return removeTags(text);
}

/**
 * Decode a small but common set of named and numeric HTML entities.
 *
 * Covers the most frequently encountered entities in prose documents.
 * Full entity decoding would require an external library; this subset handles
 * ~95% of real-world cases without dependencies.
 *
 * @param text - Text containing HTML entity references.
 */
function decodeEntities(text: string): string {
  return text
    // Named character entities (most common subset).
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&lsquo;/gi, '\u2018')
    .replace(/&rsquo;/gi, '\u2019')
    .replace(/&ldquo;/gi, '\u201C')
    .replace(/&rdquo;/gi, '\u201D')
    .replace(/&copy;/gi, '©')
    .replace(/&reg;/gi, '®')
    .replace(/&trade;/gi, '™')
    // Numeric decimal entities: &#160; &#8212; etc.
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(parseInt(code, 10)),
    )
    // Numeric hexadecimal entities: &#x00A0; &#x2014; etc.
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    );
}

/**
 * Extract the text content of the first `<title>` element, if present.
 *
 * Reads what `/<title[^>]*>([\s\S]*?)<\/title>/i` captures, in one forward
 * scan: the title opens at the first `<title` (any case), starts after the
 * first `>` after that and ends at the first `</title>` (any case) after its
 * `>`.  Only the first `<title` can open it: when that one has no `>` or no
 * closing tag after it, no later one has either.
 *
 * Returns `undefined` when no `<title>` tag is found.
 *
 * @param html - Raw HTML string.
 */
function extractTitle(html: string): string | undefined {
  const opening = indexOfTag(html, '<title', 0);
  if (opening === -1) return undefined;
  const openingEnd = html.indexOf('>', opening + '<title'.length);
  if (openingEnd === -1) return undefined;
  const closingAt = indexOfTag(html, '</title>', openingEnd + 1);
  if (closingAt === -1) return undefined;
  // Decode entities inside the title and trim surrounding whitespace.
  return decodeEntities(html.slice(openingEnd + 1, closingAt)).trim() || undefined;
}

/**
 * Collapse repeated whitespace and blank lines in extracted text.
 *
 * Runs of more than two consecutive newlines are folded to two (paragraph
 * boundary).  Runs of horizontal whitespace within a line are collapsed to a
 * single space.
 *
 * @param text - Text with raw whitespace inherited from the HTML source.
 */
function normaliseWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')          // Collapse horizontal runs.
    .replace(/\n{3,}/g, '\n\n')       // Collapse blank-line runs.
    .trim();
}

/**
 * Approximate word count.
 *
 * @param text - Plain text string.
 */
function wordCount(text: string): number {
  return text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
}

/**
 * Returns the lower-cased extension of a file path.
 *
 * @param filePath - File path string.
 */
function extOf(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

// ---------------------------------------------------------------------------
// HtmlLoader
// ---------------------------------------------------------------------------

/**
 * Basic document loader for HTML (`.html`, `.htm`) files.
 *
 * ### Text extraction strategy
 * 1. `<script>` and `<style>` blocks are removed entirely.
 * 2. Block-level elements (`<p>`, `<div>`, `<h1>`–`<h6>`, etc.) are replaced
 *    with newline characters to preserve paragraph structure.
 * 3. All remaining HTML tags are stripped.
 * 4. A common subset of HTML entities is decoded.
 * 5. Excessive whitespace is collapsed.
 *
 * Each step visits each character a bounded number of times, so a load takes
 * time linear in the document's length, malformed markup included: an
 * unclosed `<`, `<p`, `<script>`, `<style>` or `<title>` is never scanned again
 * from a later one.
 *
 * ### Metadata
 * - `title` — extracted from the `<title>` element when present.
 * - `wordCount` — approximate count of words in the extracted text.
 * - `source` — absolute file path (when loaded from disk).
 *
 * @implements {IDocumentLoader}
 *
 * @example
 * ```ts
 * const loader = new HtmlLoader();
 * const doc = await loader.load('/public/index.html');
 * console.log(doc.metadata.title); // e.g. 'Welcome to AgentOS'
 * ```
 */
export class HtmlLoader implements IDocumentLoader {
  /** @inheritdoc */
  readonly supportedExtensions: string[] = [...SUPPORTED_EXTENSIONS];

  // -------------------------------------------------------------------------
  // canLoad
  // -------------------------------------------------------------------------

  /** @inheritdoc */
  canLoad(source: string | Buffer): boolean {
    if (Buffer.isBuffer(source)) {
      return false;
    }
    return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extOf(source));
  }

  // -------------------------------------------------------------------------
  // load
  // -------------------------------------------------------------------------

  /** @inheritdoc */
  async load(source: string | Buffer, _options?: LoadOptions): Promise<LoadedDocument> {
    let html: string;
    let resolvedPath: string | undefined;

    if (Buffer.isBuffer(source)) {
      html = source.toString('utf8');
    } else {
      resolvedPath = validatePath(source);
      const bytes = await fs.readFile(resolvedPath);
      html = bytes.toString('utf8');
    }

    // ---- Extract title before stripping tags ----
    const title = extractTitle(html);

    // ---- Convert HTML to plain text ----
    const rawText = stripTags(html);
    const decoded = decodeEntities(rawText);
    const content = normaliseWhitespace(decoded);

    // ---- Assemble metadata ----
    const meta: DocumentMetadata = {
      ...(title !== undefined ? { title } : {}),
      wordCount: wordCount(content),
      ...(resolvedPath ? { source: resolvedPath } : {}),
    };

    return {
      content,
      metadata: meta,
      format: 'html',
    };
  }
}
