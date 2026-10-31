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
 * 4. **A trace's own note** — a note whose front-matter `id` names a trace
 *    the brain holds, and which holds that trace's text and what
 *    `ObsidianExporter` writes after it, counts as skipped; the tags of its
 *    tag line and the links of its **Related:** list that the trace does not
 *    hold yet, such as a tag or a link added in Obsidian, are added to it.
 *
 * @module memory/io/ObsidianImporter
 */

import { sha256 } from '../core/util/crossPlatformCrypto.js';
import { v4 as uuidv4 } from 'uuid';
import type { ImportOptions, ImportResult } from './facade/types.js';
import type { Brain } from '../retrieval/store/Brain.js';
import { MarkdownImporter, withLfLineBreaks, type HeldTrace } from './MarkdownImporter.js';

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
 * Matches one whole wikilink, `[[Target]]` or `[[Target|Alias]]`, as
 * {@link WIKILINK_RE} reads it. Capture group 1 is the target.
 */
const WIKILINK_TARGET_RE = /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/;

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

/** What `ObsidianExporter` writes after a trace's text, read back from a note. */
interface ExportedAdditions {
  /** The tags of the tag line, without their `#`. */
  tags: string[];
  /** The labels of the **Related:** list's links, in its order. */
  links: string[];
}

/**
 * Read `additions` as what `ObsidianExporter` writes after a trace's text:
 * the tag line, the **Related:** list, or the tag line, a blank line and the
 * list.
 *
 * @param additions - What a note holds after a trace's text, without the whitespace around it.
 * @param labels    - Labels that hold a line break, whose links run over more than one line.
 * @returns The tags and links, or `undefined` when the note holds anything else there.
 */
function readExportedAdditions(additions: string, labels: ReadonlySet<string>): ExportedAdditions | undefined {
  let at = 0;
  let tags: string[] = [];
  const tagLine = TAG_LINE_RE.exec(additions);
  if (tagLine) {
    tags = tagLine[0]
      .split(' ')
      .map((word) => word.slice(1))
      .filter((tag) => tag !== '');
    at = tagLine[0].length;
    if (at === additions.length) return { tags, links: [] };
    if (!additions.startsWith('\n\n', at)) return undefined;
    at += 2;
  }
  if (!additions.startsWith(RELATED_HEADING, at)) return undefined;
  const links = readRelatedList(additions, at + RELATED_HEADING.length, labels);
  return links ? { tags, links } : undefined;
}

/**
 * Read `additions`, from `from` to its end, as one or more links of a
 * **Related:** list: each a line break, `- [[`, a label and `]]`. A label is
 * the rest of its line when that line ends in `]]`, or one of `labels`, which
 * runs over the line breaks it holds. The places a link may start are kept in
 * a list and read one by one, each once, so a list of any length is read
 * without recursion.
 *
 * @param additions - What a note holds after a trace's text, without the whitespace around it.
 * @param from      - Where the first link starts.
 * @param labels    - Labels that hold a line break, whose links run over more than one line.
 * @returns The links' labels, in the list's order, or `undefined` when the links do not run to the end of `additions`.
 */
function readRelatedList(additions: string, from: number, labels: ReadonlySet<string>): string[] | undefined {
  const toRead = [from];
  // Each place a link ends, with the place it started and its label.
  const reached = new Map<number, { from: number; label: string } | undefined>([[from, undefined]]);
  let at: number | undefined;
  while ((at = toRead.pop()) !== undefined) {
    if (!additions.startsWith(RELATED_ITEM, at)) continue;
    const start = at + RELATED_ITEM.length;
    const lineBreak = additions.indexOf('\n', start);
    const lineEnd = lineBreak === -1 ? additions.length : lineBreak;
    const ends: Array<{ end: number; label: string }> = [];
    if (lineEnd - start >= 2 && additions.endsWith(']]', lineEnd)) {
      ends.push({ end: lineEnd, label: additions.slice(start, lineEnd - 2) });
    }
    for (const label of labels) {
      if (additions.startsWith(`${label}]]`, start)) ends.push({ end: start + label.length + 2, label });
    }
    for (const { end, label } of ends) {
      if (reached.has(end)) continue;
      reached.set(end, { from: at, label });
      if (end === additions.length) {
        const links: string[] = [];
        for (let link = reached.get(end); link; link = reached.get(link.from)) links.push(link.label);
        return links.reverse();
      }
      toRead.push(end);
    }
  }
  return undefined;
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

  /** How many held traces this import has added a tag to. */
  private _retagged = 0;

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
   * {@link holdsTraceText}). An import that inserted a note, or added a tag
   * to a trace the brain holds, rebuilds the brain's full-text index once,
   * after its last note, so the full-text search finds the note and the tag.
   *
   * @param sourceDir - Directory to recursively scan for `.md` files.
   * @param options   - `dedup` (default `true`) skips a note the brain holds.
   * @returns `ImportResult` with counts of imported, skipped, and errored items.
   */
  override async import(sourceDir: string, options?: Pick<ImportOptions, 'dedup'>): Promise<ImportResult> {
    this._labelsWithLineBreaks = undefined;
    this._retagged = 0;
    const result = await super.import(sourceDir, options);
    if (result.imported > 0 || this._retagged > 0) await this._rebuildFullTextIndex();
    return result;
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
   * read for such labels once, when a list does not read as one line a link,
   * through `db`, the note's transaction.
   * The text is read whole, so a trace whose own text ends in a line of hashtags,
   * and a trace with no text, are the duplicates of their own notes too, and
   * a vault exported from a brain and imported into it adds nothing. A note
   * that holds anything else after the text, such as a paragraph added in
   * Obsidian before or after its links, is not the trace's own note. Line
   * breaks are read as `\n` in the note, the text and the labels alike, so a
   * note an editor saved again with CRLF line endings is its trace's own note.
   *
   * @param text - The text of the trace the note's `id` names.
   * @param body - The note's body, without its leading and trailing whitespace.
   * @param db   - What the graph is read through: the note's transaction, or the brain.
   * @returns A promise of `true` when the note holds the trace's text.
   */
  protected override async holdsTraceText(text: string, body: string, db: Pick<Brain, 'all'> = this.brain): Promise<boolean> {
    if (await super.holdsTraceText(text, body)) return true;
    const own = withLfLineBreaks(text).trim();
    const note = withLfLineBreaks(body);
    if (!note.startsWith(own)) return false;
    const rest = note.slice(own.length);
    // The export writes a blank line between the text and what it adds; a trace with no text keeps none past the trim.
    if (own !== '' && !/^\s/.test(rest)) return false;
    return (await this._readAdditions(rest.trim(), db)) !== undefined;
  }

  /**
   * Add to a trace what its own note holds beyond the trace: the tags of the
   * note's tag line the trace does not hold, a tag compared in the form the
   * tag line writes it (whitespace as `-`), and links from the trace's node to
   * the labels of the note's **Related:** list it does not link to, a link
   * read as {@link postProcess} reads one. A note left as the export wrote it
   * adds nothing to a trace that still holds the tags and links the export
   * wrote; a tag or a link the trace lost after the export is added again.
   *
   * @param trace  - The trace the note is the note of.
   * @param body   - The note's body, without its leading and trailing whitespace.
   * @param result - Mutable result accumulator (errors recorded here).
   */
  protected override async addNoteToHeldTrace(trace: HeldTrace, body: string, result: ImportResult): Promise<void> {
    const own = withLfLineBreaks(trace.content).trim();
    const note = withLfLineBreaks(body);
    if (!note.startsWith(own)) return;
    const additions = note.slice(own.length).trim();
    if (additions === '') return;
    const read = await this._readAdditions(additions);
    if (!read) return;
    await this._addTagsToHeldTrace(trace, read.tags, result);
    await this._addLinksToHeldTrace(trace.id, read.links, result);
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
   * Read what a note holds after a trace's text as what `ObsidianExporter`
   * writes there. A list that does not read as one line a link is read again
   * with the labels of the brain's graph that hold a line break, which are
   * read once an import first needs them.
   *
   * @param additions - What the note holds after the trace's text, without the whitespace around it.
   * @param db        - What the graph's labels are read through, the first time: a note's transaction, which holds a
   *   connection of the brain's own, or the brain.
   * @returns The tags and links, or `undefined` when the note holds anything else there.
   */
  private async _readAdditions(additions: string, db: Pick<Brain, 'all'> = this.brain): Promise<ExportedAdditions | undefined> {
    const read = readExportedAdditions(additions, NO_LABELS);
    if (read || !additions.includes(RELATED_HEADING)) return read;
    // A link to a label that holds a line break runs over more than one line.
    this._labelsWithLineBreaks ??= this._readLabelsWithLineBreaks(db);
    return readExportedAdditions(additions, await this._labelsWithLineBreaks);
  }

  /**
   * Add to a held trace the tags of its note's tag line that it does not hold.
   *
   * @param trace  - The trace the note is the note of.
   * @param tags   - The tags of the note's tag line, without their `#`.
   * @param result - Mutable result accumulator (errors recorded here).
   */
  private async _addTagsToHeldTrace(trace: HeldTrace, tags: readonly string[], result: ImportResult): Promise<void> {
    let held: unknown = [];
    try {
      held = JSON.parse(trace.tags);
    } catch {
      held = [];
    }
    const heldTags = Array.isArray(held) ? held.filter((tag): tag is string => typeof tag === 'string') : [];
    // The tag line writes a tag's whitespace as '-', so it names a held tag in that form.
    const written = new Set(heldTags.map((tag) => tag.replace(/\s+/g, '-')));
    const added = [...new Set(tags)].filter((tag) => !written.has(tag));
    if (added.length === 0) return;
    await this._mergeTagsIntoTrace(trace.id, added, result);
    this._retagged++;
  }

  /**
   * Link a held trace's node to the labels of its note's **Related:** list
   * that it does not link to yet.
   *
   * @param traceId - The trace the note is the note of.
   * @param links   - The labels of the note's links, in the list's order.
   * @param result  - Mutable result accumulator (errors recorded here).
   */
  private async _addLinksToHeldTrace(traceId: string, links: readonly string[], result: ImportResult): Promise<void> {
    if (links.length === 0) return;
    let linked: Set<string>;
    try {
      linked = new Set((await this._linkedLabelsOf(traceId)).map(withLfLineBreaks));
    } catch (err) {
      result.errors.push(`Link read error for trace ${traceId}: ${String(err)}`);
      return;
    }
    for (const link of links) {
      if (linked.has(withLfLineBreaks(link))) continue;
      const target = WIKILINK_TARGET_RE.exec(`[[${link}]]`)?.[1]?.trim();
      if (!target || linked.has(withLfLineBreaks(target))) continue;
      await this._upsertWikiEdge(traceId, target, result);
      linked.add(withLfLineBreaks(target));
    }
  }

  /**
   * The labels of the nodes a trace's node links to in this brain's graph,
   * read as `ObsidianExporter` reads the links it writes.
   *
   * @param traceId - The trace.
   * @returns The labels, as the brain holds them.
   */
  private async _linkedLabelsOf(traceId: string): Promise<string[]> {
    const { dialect } = this.brain.features;
    const sourceTrace = dialect.ifnull(dialect.jsonExtract('src.properties', '$.trace_id'), 'ke.source_id');
    const rows = await this.brain.all<{ label: string }>(
      `SELECT kn.label
         FROM knowledge_edges ke
         JOIN knowledge_nodes src ON src.brain_id = ke.brain_id AND src.id = ke.source_id
         JOIN knowledge_nodes kn ON kn.brain_id = ke.brain_id AND kn.id = ke.target_id
        WHERE ke.brain_id = ? AND ${sourceTrace} = ?`,
      [this.brain.brainId, traceId],
    );
    return rows.map((row) => row.label);
  }

  /**
   * Rebuild the brain's full-text index (best-effort) with the statement
   * `Brain.fullTextRebuild` returns. The import's rows are written, so a
   * failure is logged and never fails the import.
   */
  private async _rebuildFullTextIndex(): Promise<void> {
    try {
      const rebuild = this.brain.fullTextRebuild();
      await this.brain.run(rebuild.sql, rebuild.params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A database the index was never created in has nothing to rebuild.
      if (message.includes('no such module: fts5') || message.includes('no such table: memory_traces_fts')) {
        return;
      }
      console.warn(
        `[ObsidianImporter] full-text index rebuild after an import failed for brain ${this.brain.brainId}: ${message}`,
      );
    }
  }

  /**
   * Read the labels of the brain's graph that hold a line break.
   *
   * @param db - What they are read through: a note's transaction, or the brain.
   * @returns The labels, each line break in them as `\n`.
   */
  private async _readLabelsWithLineBreaks(db: Pick<Brain, 'all'>): Promise<ReadonlySet<string>> {
    const rows = await db.all<{ label: string }>(
      'SELECT DISTINCT label FROM knowledge_nodes WHERE brain_id = ? AND (label LIKE ? OR label LIKE ?)',
      [this.brain.brainId, '%\n%', '%\r%'],
    );
    return new Set(rows.map((row) => withLfLineBreaks(row.label)));
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
