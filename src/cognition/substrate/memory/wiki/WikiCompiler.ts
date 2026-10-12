/** @fileoverview Folds new memory traces into wiki pages via LLM merge (merge-not-clobber). */
import { extractWikiLinks } from './WikiPageCodec.js';
import { assertWikiPageId, InvalidWikiPageIdError } from './WikiPageId.js';
import type { WikiPage, WikiPageType, CompileResult } from './types.js';

interface TraceLike {
  id: string;
  content: string;
  tags: string[];
  entities: string[];
}

interface ClusterAssignment {
  /** Target page id, e.g. 'entities/johnny'. */
  pageId: string;
  traceIds: string[];
}

export interface WikiCompilerStorePort {
  readPage(id: string): Promise<WikiPage | null>;
  writePage(page: WikiPage): Promise<void>;
}

export interface WikiCompilerOptions {
  store: WikiCompilerStorePort;
  /** LLM merge call: given a prompt, return the full updated page body. */
  llm: (prompt: string) => Promise<string>;
  /** Group traces into target pages. Injected (LLM- or heuristic-backed). */
  cluster: (traces: TraceLike[]) => Promise<ClusterAssignment[]>;
  /** Current ISO timestamp provider (injected for determinism in tests). */
  now?: () => string;
}

const MERGE_PROMPT = (currentBody: string, facts: string[]): string =>
  `You maintain a knowledge wiki page. Here is the CURRENT page, which may include human edits:\n\n` +
  `---\n${currentBody || '(empty page)'}\n---\n\n` +
  `Integrate these NEW facts without discarding existing content. Preserve voice and structure. ` +
  `Deduplicate. Output ONLY the full updated page body (no frontmatter):\n\n` +
  facts.map((f) => `- ${f}`).join('\n');

export class WikiCompiler {
  constructor(private readonly opts: WikiCompilerOptions) {}

  /**
   * Fold traces into the pages the cluster step assigns them to. An assignment whose page id the wiki
   * refuses (see `isWikiPageId`) is not read, merged or written: it is reported in `conflicts`, with the
   * reason as its note, and the other assignments go on. So is an assignment whose page the store fails to
   * write, such as one whose path the file system refuses: its note says why, its traces are not counted as
   * consumed, and the other assignments go on.
   */
  async compile(input: {
    traces: TraceLike[];
    reason: 'consolidation' | 'session-end' | 'explicit';
  }): Promise<CompileResult> {
    const result: CompileResult = { pagesWritten: [], tracesConsumed: 0, conflicts: [] };

    // Never consume the wiki's own indexed chunks — avoids a feedback loop.
    const traces = input.traces.filter((t) => !t.tags.includes('wiki'));
    if (traces.length === 0) return result;

    const assignments = await this.opts.cluster(traces);
    const byId = new Map(traces.map((t) => [t.id, t]));
    const now = this.opts.now ?? (() => new Date(0).toISOString());

    for (const a of assignments) {
      const facts = a.traceIds.map((id) => byId.get(id)?.content).filter((c): c is string => !!c);
      if (facts.length === 0) continue;

      let current: WikiPage | null;
      try {
        // Checked before the read, so a refused id costs no merge call and is never written.
        assertWikiPageId(a.pageId);
        current = await this.opts.store.readPage(a.pageId);
      } catch (err) {
        if (!(err instanceof InvalidWikiPageIdError)) throw err;
        result.conflicts.push({ pageId: String(a.pageId), note: err.message });
        continue;
      }
      const mergedBody = (await this.opts.llm(MERGE_PROMPT(current?.body ?? '', facts))).trim();

      const type: WikiPageType = current?.type ?? inferType(a.pageId);
      const newSources = [...new Set([...(current?.sources ?? []), ...a.traceIds])];

      try {
        await this.opts.store.writePage({
          id: a.pageId,
          type,
          summary: current?.summary ?? facts[0].slice(0, 120),
          updated: now(),
          sources: newSources,
          body: mergedBody,
          links: extractWikiLinks(mergedBody),
        });
      } catch (err) {
        // One page that cannot be written does not stop the compile, which would then fail on the same
        // batch every time it runs.
        const reason = err instanceof Error ? err.message : String(err);
        result.conflicts.push({ pageId: a.pageId, note: `not written: ${reason}` });
        continue;
      }
      result.pagesWritten.push(a.pageId);
      result.tracesConsumed += a.traceIds.length;
    }
    return result;
  }
}

function inferType(pageId: string): WikiPageType {
  if (pageId.startsWith('entities/')) return 'entity';
  if (pageId.startsWith('log/')) return 'log';
  return 'concept';
}
