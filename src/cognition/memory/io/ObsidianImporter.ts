/**
 * @fileoverview Obsidian vault importer for AgentOS memory brain.
 *
 * Extends `MarkdownImporter` with Obsidian-specific parsing:
 *
 * 1. **`[[wikilinks]]`** — each `[[Target Note]]` (or `[[Target|Alias]]`) in
 *    a note's body is parsed.  For each wikilink, the importer looks up (or
 *    creates) a `knowledge_nodes` entry for the target label and then creates
 *    a `knowledge_edges` row of type `'related_to'` linking the source trace
 *    node to the target node.
 *
 * 2. **`#tags`** — inline hashtags are extracted from the body and merged
 *    into the trace's `tags` JSON column (in addition to any front-matter tags).
 *
 * 3. **`![[image.png]]`** — embedded-image syntax is detected and a warning
 *    is logged.  Embedded images are not imported in the current version.
 *
 * @module memory/io/ObsidianImporter
 */

import { sha256 } from '../core/util/crossPlatformCrypto.js';
import { v4 as uuidv4 } from 'uuid';
import type { ImportOptions, ImportResult } from './facade/types.js';
import type { Brain } from '../retrieval/store/Brain.js';
import { MarkdownImporter } from './MarkdownImporter.js';

// ---------------------------------------------------------------------------
// Regex constants
// ---------------------------------------------------------------------------

/**
 * Matches Obsidian wikilinks: `[[Target]]` or `[[Target|Alias]]`.
 * Capture group 1 is the target note name; alias (if any) is ignored.
 * Does NOT match embedded images (`![[...]]`) — those use a separate pattern.
 */
const WIKILINK_RE = /(?<!!)\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/**
 * Matches Obsidian embedded images: `![[image.png]]`.
 * Used to emit a warning — embedded images are not yet supported for import.
 */
const EMBED_RE = /!\[\[[^\]]+\]\]/g;

/**
 * Matches inline hashtags: `#tagName` (not preceded by `[` or `#`).
 * Only captures the tag name (group 1) without the leading `#`.
 */
const HASHTAG_RE = /(?<![[#])#([\w-]+)/g;

/**
 * The line of a trace's tags `ObsidianExporter` writes after its text: each
 * tag as a `#tag` word, a space between two.
 */
const TAG_LINE_RE = /^#\S*(?: #\S*)*/;

/** The heading `ObsidianExporter` writes above the list of a trace's links. */
const RELATED_HEADING = '**Related:**';

/** What opens each item of the **Related:** list: a line break and the opening of its link. */
const RELATED_ITEM = '\n- [[';

/** No labels with a line break: each link of a **Related:** list is read as one line. */
const NO_LABELS: ReadonlySet<string> = new Set();

// ---------------------------------------------------------------------------
// What the export writes after a trace's text
// ---------------------------------------------------------------------------

/**
 * Whether `additions` is what `ObsidianExporter` writes after a trace's text:
 * the tag line, the **Related:** list, or the tag line, a blank line and the
 * list.
 *
 * @param additions - What a note holds after a trace's text, without the whitespace around it.
 * @param labels    - Labels that hold a line break, whose links run over more than one line.
 * @returns `true` when the note holds nothing else there.
 */
function isExportedAdditions(additions: string, labels: ReadonlySet<string>): boolean {
  let at = 0;
  const tagLine = TAG_LINE_RE.exec(additions);
  if (tagLine) {
    at = tagLine[0].length;
    if (at === additions.length) return true;
    if (!additions.startsWith('\n\n', at)) return false;
    at += 2;
  }
  return additions.startsWith(RELATED_HEADING, at) && isRelatedList(additions, at + RELATED_HEADING.length, labels);
}

/**
 * Whether `additions`, from `from` to its end, is one or more links of a
 * **Related:** list: each a line break, `- [[`, a label and `]]`. A label is
 * the rest of its line when that line ends in `]]`, or one of `labels`, which
 * runs over the line breaks it holds. The places a link may start are kept in
 * a list and read one by one, each once, so a list of any length is read
 * without recursion.
 *
 * @param additions - What a note holds after a trace's text, without the whitespace around it.
 * @param from      - Where the first link starts.
 * @param labels    - Labels that hold a line break, whose links run over more than one line.
 * @returns `true` when the links run to the end of `additions`.
 */
function isRelatedList(additions: string, from: number, labels: ReadonlySet<string>): boolean {
  const toRead = [from];
  const seen = new Set(toRead);
  let at: number | undefined;
  while ((at = toRead.pop()) !== undefined) {
    if (!additions.startsWith(RELATED_ITEM, at)) continue;
    const start = at + RELATED_ITEM.length;
    const lineBreak = additions.indexOf('\n', start);
    const lineEnd = lineBreak === -1 ? additions.length : lineBreak;
    const ends = lineEnd - start >= 2 && additions.endsWith(']]', lineEnd) ? [lineEnd] : [];
    for (const label of labels) {
      if (additions.startsWith(`${label}]]`, start)) ends.push(start + label.length + 2);
    }
    for (const end of ends) {
      if (end === additions.length) return true;
      if (!seen.has(end)) {
        seen.add(end);
        toRead.push(end);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Parsed front-matter fields (same shape as MarkdownImporter expects).
 */
interface TraceFrontmatter {
  id?: string;
  type?: string;
  scope?: string;
  strength?: number;
  tags?: string[];
  createdAt?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// ObsidianImporter
// ---------------------------------------------------------------------------

/**
 * Imports an Obsidian vault (directory of Markdown files) into a `Brain`.
 *
 * **Usage:**
 * ```ts
 * const importer = new ObsidianImporter(brain);
 * const result = await importer.import('/path/to/obsidian-vault');
 * ```
 */
export class ObsidianImporter extends MarkdownImporter {
  /**
   * The labels of the brain's graph that hold a line break, read the first
   * time an import meets a **Related:** list that does not read as one line a
   * link. The export writes a label as the brain holds it, so a link to such
   * a label runs over the label's line breaks.
   */
  private _labelsWithLineBreaks: Promise<ReadonlySet<string>> | undefined;

  /**
   * @param brain - The target `Brain` to import into.
   */
  constructor(brain: Brain) {
    super(brain);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Recursively walk `sourceDir` and import every `.md` file as
   * `MarkdownImporter` does, reading each note's `#tags` and `[[wikilinks]]`
   * as well. Each import reads the brain's graph afresh: the labels it holds
   * that have a line break are read once, when a note first needs them (see
   * {@link holdsTraceText}).
   *
   * @param sourceDir - Directory to recursively scan for `.md` files.
   * @param options   - `dedup` (default `true`) skips a note the brain holds.
   * @returns `ImportResult` with counts of imported, skipped, and errored items.
   */
  override async import(sourceDir: string, options?: Pick<ImportOptions, 'dedup'>): Promise<ImportResult> {
    this._labelsWithLineBreaks = undefined;
    return super.import(sourceDir, options);
  }

  // -------------------------------------------------------------------------
  // Overridden hooks
  // -------------------------------------------------------------------------

  /**
   * Whether a note's body holds a trace's text: the body is the text, as a
   * Markdown note's is, or it opens with the text, without its leading and
   * trailing whitespace, and holds after it, past whitespace, only what
   * `ObsidianExporter` writes there: the tag line, the **Related:** list, or
   * the tag line, a blank line and the list. Each link of the list is a line
   * `- [[label]]`, or runs over the line breaks of a label the brain's graph
   * holds, as the export writes a label that holds a line break; the graph is
   * read for such labels once, when a list does not read as one line a link.
   * The text is read whole, so a trace whose own text ends in a line of hashtags,
   * and a trace with no text, are the duplicates of their own notes too, and
   * a vault exported from a brain and imported into it adds nothing. A note
   * that holds anything else after the text, such as a paragraph added in
   * Obsidian before or after its links, is not the trace's own note.
   *
   * @param text - The text of the trace the note's `id` names.
   * @param body - The note's body, without its leading and trailing whitespace.
   * @returns A promise of `true` when the note holds the trace's text.
   */
  protected override async holdsTraceText(text: string, body: string): Promise<boolean> {
    if (await super.holdsTraceText(text, body)) return true;
    const own = text.trim();
    if (!body.startsWith(own)) return false;
    const rest = body.slice(own.length);
    // The export writes a blank line between the text and what it adds; a trace with no text keeps none past the trim.
    if (own !== '' && !/^\s/.test(rest)) return false;
    const additions = rest.trim();
    if (isExportedAdditions(additions, NO_LABELS)) return true;
    if (!additions.includes(RELATED_HEADING)) return false;
    // A link to a label that holds a line break runs over more than one line: read such labels once an import needs them.
    this._labelsWithLineBreaks ??= this._readLabelsWithLineBreaks();
    return isExportedAdditions(additions, await this._labelsWithLineBreaks);
  }

  /**
   * Post-process a successfully imported Markdown file:
   *
   * 1. Warn about any embedded images (`![[...]]`).
   * 2. Extract inline `#hashtags` and merge them into the trace's tag list.
   * 3. Parse `[[wikilinks]]` and create `knowledge_edges` entries.
   *
   * @param _filePath    - Absolute path of the source file (unused here).
   * @param _frontmatter - Parsed front-matter data.
   * @param body         - Markdown body (content after front-matter).
   * @param result       - Mutable `ImportResult` accumulator.
   * @param traceId      - The ID of the just-inserted trace.
   */
  protected override async postProcess(
    _filePath: string,
    _frontmatter: TraceFrontmatter,
    body: string,
    result: ImportResult,
    traceId: string,
  ): Promise<void> {
    // ---- 1. Warn about embedded images ----
    const embedMatches = body.match(EMBED_RE);
    if (embedMatches && embedMatches.length > 0) {
      console.warn(
        `[ObsidianImporter] Embedded images are not yet supported in import. ` +
          `Found ${embedMatches.length} embed(s) in trace ${traceId}.`,
      );
    }

    // ---- 2. Extract inline hashtags and persist to trace ----
    const inlineTags: string[] = [];
    let tagMatch: RegExpExecArray | null;
    HASHTAG_RE.lastIndex = 0;
    while ((tagMatch = HASHTAG_RE.exec(body)) !== null) {
      if (tagMatch[1]) inlineTags.push(tagMatch[1]);
    }

    if (inlineTags.length > 0) {
      await this._mergeTagsIntoTrace(traceId, inlineTags, result);
    }

    // ---- 3. Parse wikilinks and create knowledge_edges ----
    const wikiTargets: string[] = [];
    let wikilinkMatch: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((wikilinkMatch = WIKILINK_RE.exec(body)) !== null) {
      if (wikilinkMatch[1]) wikiTargets.push(wikilinkMatch[1].trim());
    }

    for (const target of wikiTargets) {
      await this._upsertWikiEdge(traceId, target, result);
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Read the labels of the brain's graph that hold a line break.
   *
   * @returns The labels, as the brain holds them.
   */
  private async _readLabelsWithLineBreaks(): Promise<ReadonlySet<string>> {
    const rows = await this.brain.all<{ label: string }>(
      'SELECT DISTINCT label FROM knowledge_nodes WHERE brain_id = ? AND label LIKE ?',
      [this.brain.brainId, '%\n%'],
    );
    return new Set(rows.map((row) => row.label));
  }

  /**
   * Merge a list of inline hashtag names into a trace's `tags` JSON column.
   *
   * Reads the current tags array, deduplicates, and writes back.
   *
   * @param traceId    - ID of the trace to update.
   * @param newTags    - Hashtag names to add (without the leading `#`).
   * @param result     - Mutable result accumulator (errors recorded here).
   */
  private async _mergeTagsIntoTrace(
    traceId: string,
    newTags: string[],
    result: ImportResult,
  ): Promise<void> {
    try {
      const brainRef = (this as unknown as { brain: Brain }).brain;
      const brainId = brainRef.brainId;

      const row = await brainRef.get<{ tags: string }>(
        'SELECT tags FROM memory_traces WHERE brain_id = ? AND id = ?',
        [brainId, traceId],
      );

      if (!row) return;

      let existing: string[] = [];
      try {
        existing = JSON.parse(row.tags) as string[];
      } catch {
        existing = [];
      }

      const merged = Array.from(new Set([...existing, ...newTags]));

      await brainRef.run(
        'UPDATE memory_traces SET tags = ? WHERE brain_id = ? AND id = ?',
        [JSON.stringify(merged), brainId, traceId],
      );
    } catch (err) {
      result.errors.push(`Tag merge error for trace ${traceId}: ${String(err)}`);
    }
  }

  /**
   * Ensure `knowledge_nodes` entries exist for both the source trace and the
   * target label, then create a `knowledge_edges` row (type `'related_to'`)
   * linking them.
   *
   * Because `knowledge_edges.source_id` has a FK reference to
   * `knowledge_nodes(id)`, we first upsert a node for the source trace (using
   * the trace content as the label) before creating the edge.  This lets
   * Obsidian's graph view visualise which note links to which concept.
   *
   * Both node upserts and the edge insert use `INSERT OR IGNORE` so repeated
   * imports don't create duplicates.
   *
   * @param sourceTraceId - The memory trace ID that contains the wikilink.
   * @param targetLabel   - The label of the linked note (wikilink target).
   * @param result        - Mutable result accumulator.
   */
  private async _upsertWikiEdge(
    sourceTraceId: string,
    targetLabel: string,
    result: ImportResult,
  ): Promise<void> {
    try {
      const brainRef = (this as unknown as { brain: Brain }).brain;
      const { dialect } = brainRef.features;
      const brainId = brainRef.brainId;

      // ---- Upsert source knowledge node for the trace ----
      // We use the trace ID itself as the node label so the graph stays navigable.
      const sourceLabel = `trace:${sourceTraceId}`;
      const sourceHash = await sha256(`wiki-source::${sourceTraceId}`);

      let sourceNodeId: string;
      const existingSource = await brainRef.get<{ id: string }>(
        `SELECT id FROM knowledge_nodes WHERE brain_id = ? AND label = ? LIMIT 1`,
        [brainId, sourceLabel],
      );

      if (existingSource) {
        sourceNodeId = existingSource.id;
      } else {
        sourceNodeId = `kn_${uuidv4()}`;
        await brainRef.run(
          dialect.insertOrIgnore(
            'knowledge_nodes',
            ['brain_id', 'id', 'type', 'label', 'properties', 'embedding', 'confidence', 'source', 'created_at'],
            ['?', '?', "'trace'", '?', '?', 'NULL', '1.0', "'{}'", '?'],
          ),
          [
            brainId,
            sourceNodeId,
            sourceLabel,
            JSON.stringify({ import_hash: sourceHash, trace_id: sourceTraceId }),
            Date.now(),
          ],
        );
      }

      // ---- Upsert target knowledge node for the wikilink label ----
      const targetHash = await sha256(`wiki::${targetLabel}`);

      let targetNodeId: string;
      const existingTarget = await brainRef.get<{ id: string }>(
        `SELECT id FROM knowledge_nodes WHERE brain_id = ? AND label = ? LIMIT 1`,
        [brainId, targetLabel],
      );

      if (existingTarget) {
        targetNodeId = existingTarget.id;
      } else {
        targetNodeId = `kn_${uuidv4()}`;
        await brainRef.run(
          dialect.insertOrIgnore(
            'knowledge_nodes',
            ['brain_id', 'id', 'type', 'label', 'properties', 'embedding', 'confidence', 'source', 'created_at'],
            ['?', '?', "'concept'", '?', '?', 'NULL', '1.0', "'{}'", '?'],
          ),
          [
            brainId,
            targetNodeId,
            targetLabel,
            JSON.stringify({ import_hash: targetHash, obsidian_wikilink: true }),
            Date.now(),
          ],
        );
      }

      // ---- Create the directed edge: source node → target node ----
      const edgeHash = await sha256(`${sourceNodeId}::${targetNodeId}::related_to`);

      // Check for existing edge before insert (extra safety beyond OR IGNORE).
      const existingEdge = await brainRef.get<{ id: string }>(
        `SELECT id FROM knowledge_edges
           WHERE brain_id = ? AND ${dialect.jsonExtract('metadata', '$.import_hash')} = ? LIMIT 1`,
        [brainId, edgeHash],
      );

      if (!existingEdge) {
        await brainRef.run(
          dialect.insertOrIgnore(
            'knowledge_edges',
            ['brain_id', 'id', 'source_id', 'target_id', 'type', 'weight', 'bidirectional', 'metadata', 'created_at'],
            ['?', '?', '?', '?', "'related_to'", '1.0', '0', '?', '?'],
          ),
          [
            brainId,
            `ke_${uuidv4()}`,
            sourceNodeId,
            targetNodeId,
            JSON.stringify({ import_hash: edgeHash, source: 'obsidian_wikilink', trace_id: sourceTraceId }),
            Date.now(),
          ],
        );
      }
    } catch (err) {
      result.errors.push(
        `Wikilink edge error (${sourceTraceId} → "${targetLabel}"): ${String(err)}`,
      );
    }
  }
}
