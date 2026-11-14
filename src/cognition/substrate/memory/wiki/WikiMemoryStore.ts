/** @fileoverview Markdown-first wiki store: owns memory/, indexes pages into the memory store. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFileOutsideLinks } from '../../../../core/utils/linkFreeWrite.js';
import { CONVERSATION_SCOPE, conversationScopeKey } from '../../../memory/retrieval/store/conversationScopeKey.js';
import { originOfPage, pageOriginOf, parsePage, serializePage, renderCatalog } from './WikiPageCodec.js';
import { isWikiPageId, resolveWikiPagePath } from './WikiPageId.js';
import { migratedBlockOf, withMigratedText } from './migrateMemoryMd.js';
import type { WikiPage, WikiPageOrigin, WikiPageStorePort, MetaIndex, IndexResult } from './types.js';

/** The `keyVersion` of a `.meta/index.json` whose pages' chunks are filed under the operator's conversation key. */
const META_KEY_VERSION = 'c1';

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
 * Synchronous companion to {@link listWikiPageIds}, with the same rule: the ids of the `.md` files under
 * `memoryDir` whose path makes a valid page id, dot-named files and folders skipped.
 *
 * @param memoryDir - The wiki's folder.
 * @param readDir - Lists one folder, given its path. A folder it cannot list is skipped.
 * @param paths - The path functions that build a folder's path: the platform's by default.
 * @returns The ids, sorted.
 */
export function listWikiPageIdsSync(
  memoryDir: string,
  readDir: (dir: string) => readonly WikiFolderEntry[],
  paths: Pick<path.PlatformPath, 'join'> = path,
): string[] {
  const out: string[] = [];
  const walk = (names: readonly string[]): void => {
    let entries: readonly WikiFolderEntry[];
    try {
      entries = readDir(paths.join(memoryDir, ...names));
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        walk([...names, e.name]);
      } else if (e.name.endsWith('.md')) {
        const id = [...names, e.name.slice(0, -3)].join('/');
        if (isWikiPageId(id)) out.push(id);
      }
    }
  };
  walk([]);
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

/**
 * The codes a platform refuses a new file beside `index.md`, or a rename over it, with where a write in place may
 * still go through: a folder that takes no new file while the file in it is writable, or, on Windows, a file another
 * program holds open.
 */
const WRITE_IN_PLACE_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'EBUSY']);

/**
 * Replace `file` with `text` through a new file beside it and a rename, so a reader, in this process or another,
 * finds the old text or the new and never a file emptied for the write: a catalog refresh that read an emptied
 * index.md would drop the text migrated from `MEMORY.md` for good. The new file is named with a leading dot, so no
 * listing of pages takes it, and is made by its own open (`wx`), so nothing already in its place is opened. The rename
 * replaces a symbolic link at `file` rather than writing through it, and the file keeps the permission bits it had.
 * A file this process may not write, or a refusal of the new file or the rename (see {@link WRITE_IN_PLACE_CODES}),
 * falls back to a write of `file` in place, as before, which succeeds or fails as such a write always has.
 *
 * @param file - Absolute path of the file, in a folder already made.
 * @param text - What the file holds, written as UTF-8.
 */
async function replaceFile(file: string, text: string): Promise<void> {
  const prior = await fs.lstat(file).catch(() => null);
  const mode = prior?.isFile() ? prior.mode & 0o777 : 0o666;
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    // A file this process may not write is not replaced: the rename would go through where a write would not.
    if (prior?.isFile()) await fs.access(file, fs.constants.W_OK);
    await fs.writeFile(temp, text, { flag: 'wx', mode });
    await fs.rename(temp, file);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    if (!WRITE_IN_PLACE_CODES.has(String((err as NodeJS.ErrnoException).code))) throw err;
    await fs.writeFile(file, text);
  }
}

/** The slice of the Memory facade the store depends on (injected for testability). */
export interface MemoryIndexPort {
  remember(content: string, options?: Record<string, unknown>): Promise<{ id: string }>;
  /** Kept on the port for hosts that pass one; the store deletes a page's old chunks with {@link deleteTraces}. */
  forget(traceId: string): Promise<void>;
  /** Deletes traces for good: the chunks of a page that was edited, removed or deleted. */
  deleteTraces(ids: readonly string[]): Promise<unknown>;
  chunk(text: string): Array<{ text: string }>;
}

export interface WikiMemoryStoreOptions {
  memoryDir: string;
  port: MemoryIndexPort;
  agentId: string;
}

/**
 * The operator's wiki pages: the hand-written markdown files under `memory/`, shared by everyone the agent talks
 * with. Their chunks are filed for recall under the operator's own conversation key of the agent. A page file a
 * compile wrote (front matter that lists `sources`), and one whose front matter cannot be read, is left on disk as
 * it is and is not listed in `index.md` and not indexed: see {@link WikiMemoryStore.withheldPages}.
 */
export class WikiMemoryStore implements WikiPageStorePort {
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
   * Write a page, then refresh index.md from the full page set. Text migrated from a legacy `MEMORY.md` that
   * index.md holds (see `migratedBlockOf`) is kept, and the catalog is written after it.
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

  /**
   * Write index.md from the operator's pages, after the migrated block the index holds. The index is read never
   * through a symbolic link, as the soul loader reads it, and replaced whole (see `replaceFile`), so a refresh running
   * at the same time in another store over the same folder never reads it half written.
   *
   * @throws Any error reading the index meets other than a missing file, so an index that cannot be read is never
   *   replaced by a catalog without its migrated text.
   */
  async refreshCatalog(): Promise<void> {
    const pages = await this.load();
    const indexPath = path.join(this.memoryDir, 'index.md');
    const read = await readFileOutsideLinks(this.memoryDir, 'index.md');
    // No index yet, or a link or something other than a regular file in its place, which the soul loader does not
    // read either: the catalog alone.
    const migrated = read !== null && typeof read === 'object' ? migratedBlockOf(read.text) : null;
    const catalog = renderCatalog(pages);
    await replaceFile(indexPath, migrated === null ? catalog : withMigratedText(catalog, migrated));
  }

  /** The page ids under memory/ (see `listWikiPageIds`). */
  private async listPageIds(): Promise<string[]> {
    return listWikiPageIds(this.memoryDir, (dir) => fs.readdir(dir, { withFileTypes: true }));
  }

  /**
   * Where page `id` came from, as its file's front matter tells it (see `pageOriginOf`); null when the id has no
   * file that can be read.
   *
   * @throws InvalidWikiPageIdError when the id is refused (see `isWikiPageId`); nothing is read.
   */
  async pageOrigin(id: string): Promise<WikiPageOrigin | null> {
    const file = this.pagePath(id);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      return null;
    }
    return pageOriginOf(raw);
  }

  /**
   * The pages under memory/ that are not the operator's: each page file a compile wrote, and each whose origin
   * cannot be told. They stay on disk as they are, and are in no index, no prompt and no recall.
   */
  async withheldPages(): Promise<Array<{ id: string; origin: 'compiled' | 'uncertain' }>> {
    const withheld: Array<{ id: string; origin: 'compiled' | 'uncertain' }> = [];
    for (const id of await this.listPageIds()) {
      const origin = await this.pageOrigin(id);
      if (origin === 'compiled' || origin === 'uncertain') withheld.push({ id, origin });
    }
    return withheld;
  }

  /**
   * Delete page `id`: its file, then its chunks, for good, with its entry of `.meta/index.json`, then its line of
   * index.md. A page whose file an earlier delete removed before its chunks could be deleted is finished here: its
   * chunks and its entry go.
   *
   * @returns True when the page had a file or chunks left of it; false, with nothing changed, when it had neither.
   * @throws InvalidWikiPageIdError when the id is refused (see `isWikiPageId`); nothing is deleted.
   */
  async deletePage(id: string): Promise<boolean> {
    const file = this.pagePath(id);
    let hadFile = true;
    try {
      await fs.rm(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      hadFile = false;
    }
    const meta = await this.readMeta();
    const entry = meta.keyVersion === META_KEY_VERSION ? meta.pages[id] : undefined;
    if (!hadFile && !entry) return false;
    if (entry) {
      await this._port.deleteTraces(entry.traceIds);
      delete meta.pages[id];
      await this.writeMeta(meta);
    }
    await this.refreshCatalog();
    return true;
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

  /**
   * Index the operator's pages for recall, incrementally: only a page whose body hash changed since the last index
   * is embedded again. Each chunk is filed under the operator's conversation key of the agent, with the tags `wiki`
   * and `page:<id>`. The old chunks of a page that was edited, and the chunks of a page that is gone or is no longer
   * the operator's, are deleted for good. A page a compile wrote, and one whose origin cannot be told, is not indexed.
   *
   * An index written before the operator key existed (no `keyVersion`) names chunks filed under the agent's plain
   * scope: its entries are not used, every operator page is indexed afresh, and those earlier chunks are left where
   * they are. An index whose entries were filed under another operator key (the folder's agent id changed, or another
   * agent opened the folder) is not used either: every operator page is indexed afresh under this agent's key, and
   * the chunks its entries name, which no turn of this agent reads, are deleted.
   */
  async index(opts?: { force?: boolean }): Promise<IndexResult> {
    const pages = (await this.load()).filter((page) => originOfPage(page) === 'operator');
    const { meta, stale } = await this.currentMeta();
    const result: IndexResult = { indexed: [], skipped: [], removed: [] };
    if (stale.length > 0) {
      await this._port.deleteTraces(stale);
      result.removed.push(...stale);
    }

    for (const page of pages) {
      const hash = createHash('sha256').update(page.body).digest('hex');
      const prior = meta.pages[page.id];
      if (!opts?.force && prior && prior.hash === hash) {
        result.skipped.push(page.id);
        continue;
      }
      // Delete the page's prior chunks before re-embedding.
      if (prior) {
        await this._port.deleteTraces(prior.traceIds);
        result.removed.push(...prior.traceIds);
      }
      const traceIds: string[] = [];
      for (const chunk of this._port.chunk(page.body)) {
        const trace = await this._port.remember(chunk.text, {
          type: page.type === 'log' ? 'episodic' : 'semantic',
          scope: CONVERSATION_SCOPE,
          scopeId: this.operatorKey,
          tags: ['wiki', `page:${page.id}`],
          entities: page.links,
        });
        traceIds.push(trace.id);
      }
      meta.pages[page.id] = { hash, traceIds };
      result.indexed.push(page.id);
    }

    // Drop the entries of pages that are gone, or are no longer the operator's, with their chunks.
    const liveIds = new Set(pages.map((p) => p.id));
    for (const id of Object.keys(meta.pages)) {
      if (!liveIds.has(id)) {
        await this._port.deleteTraces(meta.pages[id].traceIds);
        result.removed.push(...meta.pages[id].traceIds);
        delete meta.pages[id];
      }
    }

    await this.writeMeta(meta);
    return result;
  }

  /** Full rebuild: delete every indexed page's chunks, clear the meta map and re-embed everything. */
  async rebuildIndex(): Promise<IndexResult> {
    const { meta, stale } = await this.currentMeta();
    const traceIds = [...stale, ...Object.values(meta.pages).flatMap((entry) => entry.traceIds)];
    if (traceIds.length > 0) await this._port.deleteTraces(traceIds);
    await this.writeMeta({ ...meta, pages: {} });
    return this.index({ force: true });
  }

  /**
   * `.meta/index.json` as an index of chunks filed under this agent's operator key: the file as it is when it carries
   * that key's version and names that key, and otherwise the file with no page entry, marked with the version and the
   * key for its next write.
   *
   * @returns The index, and the chunks of the entries it left out that were filed under another operator key, for the
   *   caller to delete; an index of the agent's plain scope leaves its chunks where they are.
   */
  private async currentMeta(): Promise<{ meta: MetaIndex; stale: string[] }> {
    const meta = await this.readMeta();
    const operatorKey = this.operatorKey;
    if (meta.keyVersion === META_KEY_VERSION && meta.operatorKey === operatorKey) return { meta, stale: [] };
    const stale =
      meta.keyVersion === META_KEY_VERSION ? Object.values(meta.pages).flatMap((entry) => entry.traceIds) : [];
    return {
      meta: { ...meta, keyVersion: META_KEY_VERSION, operatorKey, pages: Object.create(null) as MetaIndex['pages'] },
      stale,
    };
  }

  /** The conversation key the operator's pages are filed under for this store's agent. */
  private get operatorKey(): string {
    return conversationScopeKey(this.agentId, { kind: 'operator' });
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
