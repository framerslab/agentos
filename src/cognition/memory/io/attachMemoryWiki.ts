/** @fileoverview Wire a markdown memory wiki onto a Memory facade + soul workspace. */
import { messageOf } from '../../../api/runtime/memoryObserveFailures.js';
import { WikiMemoryStore, WikiCompiler } from '../../substrate/memory/wiki/index.js';
import type { CompileResult } from '../../substrate/memory/wiki/index.js';
import { memoryLog } from './memoryLog.js';
import { ReadMemoryPageTool } from './tools/ReadMemoryPageTool.js';

interface TraceLike {
  id: string;
  content: string;
  tags: string[];
  entities: string[];
}

interface ClusterAssignment {
  pageId: string;
  traceIds: string[];
}

/** Minimal Memory-facade surface this helper needs (structural, no hard import). */
export interface WikiAttachableMemory {
  remember(content: string, options?: Record<string, unknown>): Promise<{ id: string }>;
  forget(traceId: string): Promise<void>;
  /** Deletes traces for good: the chunks of an operator page that was edited, removed or deleted. */
  deleteTraces(ids: readonly string[]): Promise<unknown>;
  attachWiki(wiki: {
    store: {
      index: (o?: { force?: boolean }) => Promise<unknown>;
      readMetaWatermark: () => Promise<string | null>;
      writeMetaWatermark: (iso: string) => Promise<void>;
    };
    compiler: {
      compile: (input: {
        traces: TraceLike[];
        reason: 'consolidation' | 'session-end' | 'explicit';
      }) => Promise<CompileResult>;
    };
  }): void;
}

export interface AttachMemoryWikiOptions {
  memory: WikiAttachableMemory;
  memoryDir: string;
  agentId: string;
  /** LLM merge caller for the compiler (caller supplies its configured model). */
  llm: (prompt: string) => Promise<string>;
  /** Chunk text for indexing (e.g. SemanticChunker.chunk). */
  chunk: (text: string) => Array<{ text: string }>;
  /** Existing agent tools to augment; read_memory_page is appended. */
  tools?: unknown[];
  /** The clock that dates compiled pages, as an ISO 8601 timestamp. Defaults to the current time. */
  now?: () => string;
  /** Override the default by-entity heuristic clusterer. */
  cluster?: (traces: TraceLike[]) => Promise<ClusterAssignment[]>;
}

export interface AttachMemoryWikiResult {
  store: WikiMemoryStore;
  tools: unknown[];
}

/** Slugify an entity name into a page-id-safe segment. */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'misc'
  );
}

/** Default heuristic: group traces by their first entity, else a shared notes page. */
async function defaultCluster(traces: TraceLike[]): Promise<ClusterAssignment[]> {
  const byPage = new Map<string, string[]>();
  for (const t of traces) {
    const entity = t.entities[0];
    const pageId = entity ? `entities/${slug(entity)}` : 'concepts/notes';
    const arr = byPage.get(pageId) ?? [];
    arr.push(t.id);
    byPage.set(pageId, arr);
  }
  return [...byPage.entries()].map(([pageId, traceIds]) => ({ pageId, traceIds }));
}

/**
 * Construct the wiki store + compiler over an agent's memory/ directory, attach
 * the write-back loop to the Memory facade, boot-index the markdown into the
 * store, and append the read_memory_page tool to the agent's tool list.
 *
 * The pages under memory/ are the operator's. At attach, `index.md` is written again from them, so a line an earlier
 * version wrote for a page it compiled is gone from it; a failure to write it is a warning, and the attach goes on,
 * since the prompt's index is rendered from the pages and not read from that file. The operator's pages are then
 * indexed for recall under the operator's conversation key of the agent. Page files that are not the operator's
 * (see `WikiMemoryStore.withheldPages`) are counted in one `memory.legacy_pages` log line.
 *
 * Call this from the layer that owns the Memory facade and the loaded soul: the
 * agent factory consumes an AgentMemoryProvider hook, not the facade itself, so
 * the wiring lives one level up.
 *
 * @returns The store (for direct reads) and the augmented tools array.
 */
export async function attachMemoryWiki(opts: AttachMemoryWikiOptions): Promise<AttachMemoryWikiResult> {
  const store = new WikiMemoryStore({
    memoryDir: opts.memoryDir,
    agentId: opts.agentId,
    port: {
      remember: (content, options) => opts.memory.remember(content, options),
      forget: (id) => opts.memory.forget(id),
      deleteTraces: (ids) => opts.memory.deleteTraces(ids),
      chunk: opts.chunk,
    },
  });

  const compiler = new WikiCompiler({
    store,
    llm: opts.llm,
    cluster: opts.cluster ?? defaultCluster,
    now: opts.now,
  });

  opts.memory.attachWiki({
    store: {
      index: (o) => store.index(o),
      readMetaWatermark: () => store.readMetaWatermark(),
      writeMetaWatermark: (iso) => store.writeMetaWatermark(iso),
    },
    compiler,
  });

  // index.md lists the operator's pages alone, whatever an earlier version wrote into it.
  try {
    await store.refreshCatalog();
  } catch (err) {
    console.warn(
      '[agentos] attachMemoryWiki: memory/index.md could not be refreshed (' +
        messageOf(err) +
        '); the prompt index is rendered from the pages and is not affected.',
    );
  }

  // Boot sync: the operator's markdown is the source of truth → index it into the store.
  await store.index();

  // Pages a compile of an earlier version wrote, and pages that cannot be read, are left as they are and counted.
  const withheld = await store.withheldPages();
  if (withheld.length > 0) memoryLog.warn('memory.legacy_pages', { count: withheld.length });

  const tools = [...(opts.tools ?? []), new ReadMemoryPageTool({ readPage: (id) => store.readPage(id) })];
  return { store, tools };
}
