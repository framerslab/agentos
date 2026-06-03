/** @fileoverview Markdown-first wiki store: owns memory/, indexes pages into the memory store. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { parsePage, serializePage, renderCatalog } from './WikiPageCodec.js';
import type { WikiPage, MetaIndex, IndexResult } from './types.js';

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

  private pagePath(id: string): string {
    return path.join(this.memoryDir, `${id}.md`);
  }

  /** Read every page file under memory/ (excluding index.md and .meta/). */
  async load(): Promise<WikiPage[]> {
    const ids = await this.listPageIds();
    const pages: WikiPage[] = [];
    for (const id of ids) {
      const page = await this.readPage(id);
      if (page) pages.push(page);
    }
    return pages;
  }

  async readPage(id: string): Promise<WikiPage | null> {
    try {
      const raw = await fs.readFile(this.pagePath(id), 'utf8');
      return parsePage(id, raw);
    } catch {
      return null;
    }
  }

  /** Write a page, then refresh index.md from the full page set. */
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

  /** Recursively list page ids (relative path, no extension), skipping index.md and .meta/. */
  private async listPageIds(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (relDir: string): Promise<void> => {
      const abs = path.join(this.memoryDir, relDir);
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const rel = relDir ? path.join(relDir, e.name) : e.name;
        if (e.isDirectory()) {
          if (e.name === '.meta') continue;
          await walk(rel);
        } else if (e.name.endsWith('.md') && rel !== 'index.md') {
          out.push(rel.slice(0, -3));
        }
      }
    };
    await walk('');
    return out.sort();
  }

  protected async readMeta(): Promise<MetaIndex> {
    try {
      const raw = await fs.readFile(path.join(this.memoryDir, '.meta', 'index.json'), 'utf8');
      return JSON.parse(raw) as MetaIndex;
    } catch {
      return { lastCompiledAt: null, pages: {} };
    }
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
