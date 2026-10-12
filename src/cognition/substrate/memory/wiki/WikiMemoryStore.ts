/** @fileoverview Markdown-first wiki store: owns memory/, indexes pages into the memory store. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { parsePage, serializePage, renderCatalog } from './WikiPageCodec.js';
import { isWikiPageId, resolveWikiPagePath } from './WikiPageId.js';
import type { WikiPage, MetaIndex, IndexResult } from './types.js';

/** One entry of a folder's listing: its name, and whether it is a folder. `fs.Dirent` has this shape. */
export interface WikiFolderEntry {
  name: string;
  isDirectory(): boolean;
}

/**
 * List the page ids under `memoryDir`: each `.md` file's path under the folder without `.md`, with `/` between
 * folders on every platform, the form the compiler writes and `readPage` takes. Every file or folder whose name
 * starts with a dot (`.meta/` among them) is skipped, and so is every file whose path makes no valid page id,
 * `index.md` among them, so every id listed is one `readPage` accepts.
 *
 * @param memoryDir - The wiki's folder.
 * @param readDir - Lists one folder, given its path. A folder it cannot list is skipped.
 * @param paths - The path functions that build a folder's path from `memoryDir` and its names: the platform's by
 *   default.
 * @returns The ids, sorted.
 */
export async function listWikiPageIds(
  memoryDir: string,
  readDir: (dir: string) => Promise<readonly WikiFolderEntry[]>,
  paths: Pick<path.PlatformPath, 'join'> = path,
): Promise<string[]> {
  const out: string[] = [];
  const walk = async (names: readonly string[]): Promise<void> => {
    let entries: readonly WikiFolderEntry[];
    try {
      entries = await readDir(paths.join(memoryDir, ...names));
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        await walk([...names, e.name]);
      } else if (e.name.endsWith('.md')) {
        // Ids join folders with `/` on every platform, never with the platform's separator.
        const id = [...names, e.name.slice(0, -3)].join('/');
        if (isWikiPageId(id)) out.push(id);
      }
    }
  };
  await walk([]);
  return out.sort();
}

/**
 * The page entries of `.meta/index.json` in an object with no prototype, so a page id that names a member every
 * object has (`constructor`, `toString`, `__proto__`) finds only its own entry. An entry with no list of trace ids
 * is dropped, and its page is indexed again.
 */
function pageEntries(pages: unknown): MetaIndex['pages'] {
  const entries: MetaIndex['pages'] = Object.create(null);
  if (pages === null || typeof pages !== 'object' || Array.isArray(pages)) return entries;
  for (const [id, entry] of Object.entries(pages)) {
    if (entry !== null && typeof entry === 'object' && Array.isArray((entry as { traceIds?: unknown }).traceIds)) {
      entries[id] = entry as MetaIndex['pages'][string];
    }
  }
  return entries;
}

/** The slice of the Memory facade the store depends on (injected for testability). */
export interface MemoryIndexPort {
  remember(content: string, options?: Record<string, unknown>): Promise<{ id: string }>;
  forget(traceId: string): Promise<void>;
  chunk(text: string): Array<{ text: string }>;
}

export interface WikiMemoryStoreOptions {
  memoryDir: string;
  port: MemoryIndexPort;
  agentId: string;
}

export class WikiMemoryStore {
  private readonly memoryDir: string;
  private readonly port: MemoryIndexPort;
  private readonly agentId: string;

  constructor(opts: WikiMemoryStoreOptions) {
    this.memoryDir = opts.memoryDir;
    this.port = opts.port;
    this.agentId = opts.agentId;
  }

  /**
   * The file of page `id`, inside memory/. The id is checked first, so a refused id never reaches the disk.
   *
   * @throws InvalidWikiPageIdError when the id does not have the wiki's id form (see `isWikiPageId`) or its
   *   file would be outside memory/.
   */
  private pagePath(id: string): string {
    return resolveWikiPagePath(this.memoryDir, id);
  }

  /** Read every page file under memory/ (excluding index.md and every file or folder whose name starts with a dot). */
  async load(): Promise<WikiPage[]> {
    const ids = await this.listPageIds();
    const pages: WikiPage[] = [];
    for (const id of ids) {
      const page = await this.readPage(id);
      if (page) pages.push(page);
    }
    return pages;
  }

  /**
   * Read page `id`, or null when it has no file or the file cannot be read.
   *
   * @throws InvalidWikiPageIdError when the id is refused (see `isWikiPageId`); nothing is read.
   */
  async readPage(id: string): Promise<WikiPage | null> {
    const file = this.pagePath(id);
    try {
      const raw = await fs.readFile(file, 'utf8');
      return parsePage(id, raw);
    } catch {
      return null;
    }
  }

  /**
   * Write a page, then refresh index.md from the full page set.
   *
   * @throws InvalidWikiPageIdError when the page's id is refused (see `isWikiPageId`); nothing is written.
   */
  async writePage(page: WikiPage): Promise<void> {
    const file = this.pagePath(page.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, serializePage(page));
    await this.refreshCatalog();
  }

  async getCatalog(): Promise<string> {
    try {
      return await fs.readFile(path.join(this.memoryDir, 'index.md'), 'utf8');
    } catch {
      return '# Memory Index\n';
    }
  }

  private async refreshCatalog(): Promise<void> {
    const pages = await this.load();
    await fs.writeFile(path.join(this.memoryDir, 'index.md'), renderCatalog(pages));
  }

  /** The page ids under memory/ (see `listWikiPageIds`). */
  private async listPageIds(): Promise<string[]> {
    return listWikiPageIds(this.memoryDir, (dir) => fs.readdir(dir, { withFileTypes: true }));
  }

  /**
   * Read `.meta/index.json`, or an empty index when it is missing or unreadable. Its page entries are held in an
   * object with no prototype (see `pageEntries`), so any page id is safe to look up.
   */
  protected async readMeta(): Promise<MetaIndex> {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(this.memoryDir, '.meta', 'index.json'), 'utf8'));
    } catch {
      // No index yet, or one that does not parse: start from an empty one.
    }
    const meta: Partial<MetaIndex> =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Partial<MetaIndex>) : {};
    return { ...meta, lastCompiledAt: meta.lastCompiledAt ?? null, pages: pageEntries(meta.pages) };
  }

  protected async writeMeta(meta: MetaIndex): Promise<void> {
    const metaDir = path.join(this.memoryDir, '.meta');
    await fs.mkdir(metaDir, { recursive: true });
    await fs.writeFile(path.join(metaDir, 'index.json'), JSON.stringify(meta, null, 2));
  }

  /** Incremental: re-embed only pages whose body hash changed since the last index. */
  async index(opts?: { force?: boolean }): Promise<IndexResult> {
    const pages = await this.load();
    const meta = await this.readMeta();
    const result: IndexResult = { indexed: [], skipped: [], removed: [] };

    for (const page of pages) {
      const hash = createHash('sha256').update(page.body).digest('hex');
      const prior = meta.pages[page.id];
      if (!opts?.force && prior && prior.hash === hash) {
        result.skipped.push(page.id);
        continue;
      }
      // Remove prior traces for this page before re-embedding.
      if (prior) {
        for (const id of prior.traceIds) {
          await this._port.forget(id);
          result.removed.push(id);
        }
      }
      const traceIds: string[] = [];
      for (const chunk of this._port.chunk(page.body)) {
        const trace = await this._port.remember(chunk.text, {
          type: page.type === 'log' ? 'episodic' : 'semantic',
          scope: 'persona',
          scopeId: this._agentId,
          tags: ['wiki', `page:${page.id}`],
          entities: page.links,
        });
        traceIds.push(trace.id);
      }
      meta.pages[page.id] = { hash, traceIds };
      result.indexed.push(page.id);
    }

    // Drop meta entries for deleted pages.
    const liveIds = new Set(pages.map((p) => p.id));
    for (const id of Object.keys(meta.pages)) {
      if (!liveIds.has(id)) {
        for (const t of meta.pages[id].traceIds) {
          await this._port.forget(t);
          result.removed.push(t);
        }
        delete meta.pages[id];
      }
    }

    await this.writeMeta(meta);
    return result;
  }

  /** Full rebuild: clear the meta map and re-embed everything. */
  async rebuildIndex(): Promise<IndexResult> {
    const meta = await this.readMeta();
    for (const entry of Object.values(meta.pages)) {
      for (const t of entry.traceIds) await this._port.forget(t);
    }
    await this.writeMeta({ lastCompiledAt: meta.lastCompiledAt, pages: {} });
    return this.index({ force: true });
  }

  /** Read the last-compile watermark (ISO8601) from `.meta/index.json`. */
  async readMetaWatermark(): Promise<string | null> {
    return (await this.readMeta()).lastCompiledAt;
  }

  /** Advance the last-compile watermark in `.meta/index.json`. */
  async writeMetaWatermark(iso: string): Promise<void> {
    const meta = await this.readMeta();
    meta.lastCompiledAt = iso;
    await this.writeMeta(meta);
  }

  protected get _agentId(): string {
    return this.agentId;
  }
  protected get _port(): MemoryIndexPort {
    return this.port;
  }
}
