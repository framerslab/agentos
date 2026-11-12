/** @fileoverview Wire a markdown memory wiki onto a Memory facade + soul workspace. */
import { messageOf } from '../../../api/runtime/memoryObserveFailures.js';
import { WikiMemoryStore, WikiCompiler, UserWikiStore, originOfPage } from '../../substrate/memory/wiki/index.js';
import type { UserWikiPagesPort } from '../../substrate/memory/wiki/index.js';
import type { AttachedWiki } from './facade/Memory.js';
import { conversationScopeKey, parseConversationScopeKey } from '../retrieval/store/conversationScopeKey.js';
import { memoryLog } from '../log.js';
import { guardedWrite } from '../suppression/guardedWrite.js';
import type { WikiCompilerStorePort } from '../../substrate/memory/wiki/WikiCompiler.js';
import { ReadMemoryPageTool, type ReadMemoryPagePort } from './tools/ReadMemoryPageTool.js';

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

/**
 * Minimal Memory-facade surface this helper needs (structural: the facade's types alone are imported, never the
 * class): the trace calls the operator's pages are indexed with, and the page rows a subject's own pages are kept in
 * (`UserWikiPagesPort`).
 */
export interface WikiAttachableMemory extends UserWikiPagesPort {
  /**
   * Whether a subject other than `scopeId` holds a page of that id, or, with null, whether any subject does. It
   * tells a refusal's log line why a page was not found; no caller's result depends on it.
   */
  pageExistsOutside(scopeId: string | null, pageId: string): Promise<boolean>;
  remember(content: string, options?: Record<string, unknown>): Promise<{ id: string }>;
  forget(traceId: string): Promise<void>;
  /** Deletes traces for good: the chunks of an operator page that was edited, removed or deleted. */
  deleteTraces(ids: readonly string[]): Promise<unknown>;
  /** Takes the wiki: a page store per conversation scope, the compiler, and the two optional compile hooks. */
  attachWiki(wiki: AttachedWiki): void;
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
  /**
   * Maps the subject a tool call runs for to the subject whose pages it reads, before any key is built: a host that
   * files every session that names no user under one user passes the same mapping its writes use, so the page tool
   * reads the key those writes went to. Unset, the subject is read as given.
   */
  subjectOf?: (subject: { kind: 'user' | 'session'; id: string }) => { kind: 'user' | 'session'; id: string };
  /**
   * Whether a subject is served its own pages, by the key they are filed under: false reads and lists the operator's
   * pages alone for it, and its own pages answer as pages that do not exist. A host whose policy keeps no memory for
   * an account answers false for it. Unset, every subject is served its own pages.
   */
  ownPagesServed?: (scopeKey: string) => boolean | Promise<boolean>;
  /**
   * Asked once a batch of a scope's traces, before the compiler: the traces to compile (a host can screen their
   * text), or why this scope's compile does not run. A skipped scope keeps its watermark and is logged.
   */
  beforeScopeCompile?: AttachedWiki['beforeScopeCompile'];
  /**
   * The reason to log for an error a scope's compile threw, such as `'budget'` for a spend budget's refusal: the
   * scope is then skipped, its traces wait for the next compile, and the other scopes compile. Undefined, or no
   * answer: the error rejects the compile call once every scope has run.
   */
  compileSkipReasonOf?: AttachedWiki['compileSkipReasonOf'];
  /**
   * `false`: no compile. No compiler is attached to the facade, so its `compileWiki()` writes nothing and no
   * subject's page is ever made; the operator's pages are indexed and read as before.
   */
  compile?: false;
  /**
   * Whether a subject is forgotten: the forgotten-user ledger's check (`ForgottenLedger.isForgotten`). With it, a
   * forgotten asker of `read_memory_page` gets no page and an empty listing, a forgotten subject's scope is not
   * compiled, and a page a compile wrote after the subject's tombstone is deleted once that compile is done. Each
   * refusal writes one line with the reason `forgotten`.
   */
  isForgotten?: (subject: { kind: 'user' | 'session'; id: string }) => Promise<boolean>;
  /**
   * Runs one scope's compile: a host that orders each subject's writes, compiles and deletion one after another
   * passes it, and runs `work` in the subject's turn. Unset: the compile runs at once.
   */
  runScope?: <T>(scopeId: string, work: () => Promise<T>) => Promise<T>;
}

export interface AttachMemoryWikiResult {
  /** The operator's pages: the markdown files under memory/. */
  store: WikiMemoryStore;
  /** The store of one subject's own pages, which are rows of the Memory facade: a user's or a session's scope key. */
  storeFor: (scopeId: string) => UserWikiStore;
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
 * The write-back loop compiles one conversation scope at a time into that scope's own pages, which are rows of the
 * facade (`storeFor`) and never files: the compiler is given each scope's store with its traces, and writes nothing
 * under memory/. The default clusterer runs over one scope's traces at a time, so `concepts/notes` is one page a
 * subject.
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
 * The `read_memory_page` tool it adds answers by who asks (see {@link ReadMemoryPageTool}): a subject reads its own
 * pages, kept as rows of the store under its conversation key, and the operator's pages; another subject's page, and
 * a page an earlier version compiled into the folder, answer a subject as a page that does not exist. A call with no
 * user reads the folder's pages alone. The keys are built here from the agent's id and the turn's subject (through
 * `subjectOf` when the host maps subjects); nothing a tool call passes reaches them.
 *
 * @returns The store (for direct reads) and the augmented tools array.
 * @throws TypeError when `agentId` is not a non-empty string: no key could tell this agent's pages from another's.
 */
export async function attachMemoryWiki(opts: AttachMemoryWikiOptions): Promise<AttachMemoryWikiResult> {
  if (typeof opts.agentId !== 'string' || opts.agentId === '') {
    throw new TypeError('attachMemoryWiki: agentId must be a non-empty string');
  }
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

  // One compiler for every scope, with no store of its own: each compile is given the store of the scope it runs for.
  const compiler = new WikiCompiler({
    llm: opts.llm,
    cluster: opts.cluster ?? defaultCluster,
    now: opts.now,
  });
  const storeFor = (scopeId: string): UserWikiStore => new UserWikiStore({ scopeId, pages: opts.memory, chunk: opts.chunk });

  if (opts.compile !== false) {
    opts.memory.attachWiki({
      ...compileGuardsOf(opts, storeFor),
      compiler,
      ...(opts.compileSkipReasonOf ? { compileSkipReasonOf: opts.compileSkipReasonOf } : {}),
    });
  }

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

  const tools = [...(opts.tools ?? []), new ReadMemoryPageTool(pagePortOf(opts, store))];
  return { store, storeFor, tools };
}

/**
 * The compile's side of the wiki the facade is given: the page store of each scope, the hook asked before a scope's
 * traces go to the compiler, and the runner of each scope's compile.
 *
 * With `isForgotten`, a forgotten subject's scope is skipped before any of its text reaches the compiler, and the
 * store a compile writes through checks the subject again around each page it writes: a page written after the
 * subject's tombstone is deleted once the scope's compile is done (the scope's own compile holds the scope, so its
 * page cannot be deleted from inside it).
 */
function compileGuardsOf(
  opts: AttachMemoryWikiOptions,
  storeFor: (scopeId: string) => UserWikiStore,
): Pick<AttachedWiki, 'storeFor' | 'beforeScopeCompile' | 'runScope'> {
  const isForgotten = opts.isForgotten;
  const subjectOfScope = (scopeId: string) => {
    const subject = parseConversationScopeKey(scopeId)?.subject;
    return subject && subject.kind !== 'operator' ? subject : undefined;
  };
  if (!isForgotten) {
    return {
      storeFor,
      ...(opts.beforeScopeCompile ? { beforeScopeCompile: opts.beforeScopeCompile } : {}),
      ...(opts.runScope ? { runScope: opts.runScope } : {}),
    };
  }
  /** The pages a compile wrote for a subject forgotten while it ran, by scope: deleted once the scope's compile is done. */
  const takenBack = new Map<string, Set<string>>();
  const guardedStoreFor = (scopeId: string): WikiCompilerStorePort => {
    const inner = storeFor(scopeId);
    const subject = subjectOfScope(scopeId);
    if (!subject) return inner;
    return {
      readPage: (id) => inner.readPage(id),
      writePage: async (page) => {
        const outcome = await guardedWrite(
          { isForgotten },
          subject,
          () => inner.writePage(page),
          async () => {
            const ids = takenBack.get(scopeId) ?? new Set<string>();
            ids.add(page.id);
            takenBack.set(scopeId, ids);
          },
        );
        if (outcome.status === 'refused') memoryLog.warn('memory.compile_skipped', { reason: 'forgotten' });
      },
    };
  };
  const runScope = async <T>(scopeId: string, work: () => Promise<T>): Promise<T> => {
    const compile = async (): Promise<T> => {
      try {
        return await work();
      } finally {
        const ids = takenBack.get(scopeId);
        takenBack.delete(scopeId);
        for (const id of ids ?? []) {
          try {
            await storeFor(scopeId).deletePage(id);
          } catch {
            // The page stays until the subject's deletion, or the next re-application of the tombstones, removes it;
            // its subject is forgotten, so no read serves it meanwhile.
          }
        }
      }
    };
    return opts.runScope ? opts.runScope(scopeId, compile) : compile();
  };
  const beforeScopeCompile: NonNullable<AttachedWiki['beforeScopeCompile']> = async (scopeId, traces) => {
    const subject = subjectOfScope(scopeId);
    if (subject && (await isForgotten(subject))) return { skip: 'forgotten' };
    return opts.beforeScopeCompile ? opts.beforeScopeCompile(scopeId, traces) : { traces };
  };
  return { storeFor: guardedStoreFor, beforeScopeCompile, runScope };
}

/**
 * What `read_memory_page` reads through: the asker's own pages (rows of the store under the asker's conversation
 * key), then the operator's folder. Every refusal answers null, as a page that does not exist does, and writes one
 * `memory.page_read_refused` line with its reason. A forgotten asker (`isForgotten`) is answered no page and an
 * empty listing.
 */
function pagePortOf(opts: AttachMemoryWikiOptions, operatorStore: WikiMemoryStore): ReadMemoryPagePort {
  const refused = (reason: 'other_user' | 'no_user' | 'legacy' | 'forgotten'): null => {
    memoryLog.warn('memory.page_read_refused', { reason });
    return null;
  };
  /** The subject an asker's pages are kept for. */
  const subjectFor = (asker: { kind: 'user' | 'session'; id: string }) => (opts.subjectOf ? opts.subjectOf(asker) : asker);
  /** The store of one subject's own pages, and the key they are filed under. */
  const ownPages = (asker: { kind: 'user' | 'session'; id: string }) => {
    const key = conversationScopeKey(opts.agentId, subjectFor(asker));
    return { key, own: new UserWikiStore({ scopeId: key, pages: opts.memory, chunk: opts.chunk }) };
  };
  /** Whether the asker's memory is forgotten: such an asker is answered nothing at all. */
  const forgotten = async (asker: { kind: 'user' | 'session'; id: string }): Promise<boolean> =>
    opts.isForgotten ? opts.isForgotten(subjectFor(asker)) : false;
  return {
    readPage: async (id, asker) => {
      if (asker.subject && (await forgotten(asker.subject))) return refused('forgotten');
      const shared = await operatorStore.readPage(id);
      if (!asker.subject) {
        // Nobody: the operator's folder as it is, the pages an earlier version compiled among them.
        if (shared) return shared;
        // A file that cannot be parsed reads as no page, with no line.
        if ((await operatorStore.pageOrigin(id)) !== null) return null;
        return (await opts.memory.pageExistsOutside(null, id)) ? refused('no_user') : null;
      }
      const { key, own } = ownPages(asker.subject);
      const served = opts.ownPagesServed ? await opts.ownPagesServed(key) : true;
      const page = served ? await own.readPage(id) : null;
      if (page) return page;
      // The folder's page is served only when the text just read is an operator page's.
      if (shared && originOfPage(shared) === 'operator') return shared;
      // A page an earlier version compiled, or one that cannot be told from one, may hold what someone else said:
      // no user is served it.
      const origin = shared ? originOfPage(shared) : await operatorStore.pageOrigin(id);
      if (origin === 'compiled' || origin === 'uncertain') return refused('legacy');
      return (await opts.memory.pageExistsOutside(key, id)) ? refused('other_user') : null;
    },
    listPages: async (asker) => {
      if (asker.subject && (await forgotten(asker.subject))) {
        memoryLog.warn('memory.page_read_refused', { reason: 'forgotten' });
        return [];
      }
      const shared = await operatorStore.load();
      if (!asker.subject) {
        return shared.map((page) => ({ id: page.id, summary: page.summary, owner: 'operator' as const }));
      }
      const { key, own } = ownPages(asker.subject);
      const served = opts.ownPagesServed ? await opts.ownPagesServed(key) : true;
      return [
        ...(served ? await own.listPages() : []).map((page) => ({ id: page.id, summary: page.summary, owner: 'own' as const })),
        ...shared
          .filter((page) => originOfPage(page) === 'operator')
          .map((page) => ({ id: page.id, summary: page.summary, owner: 'operator' as const })),
      ];
    },
  };
}
