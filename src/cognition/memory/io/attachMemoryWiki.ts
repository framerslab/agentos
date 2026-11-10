/** @fileoverview Wire a markdown memory wiki onto a Memory facade + soul workspace. */
import { WikiMemoryStore, WikiCompiler } from '../../substrate/memory/wiki/index.js';
import type { CompileResult } from '../../substrate/memory/wiki/index.js';
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

  // Boot sync: markdown is the source of truth → index it into the store.
  await store.index();

  const tools = [...(opts.tools ?? []), new ReadMemoryPageTool({ readPage: (id) => store.readPage(id) })];
  return { store, tools };
}
