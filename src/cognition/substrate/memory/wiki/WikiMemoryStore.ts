/** @fileoverview Markdown-first wiki store: owns memory/, indexes pages into the memory store. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parsePage, serializePage, renderCatalog } from './WikiPageCodec.js';
import type { WikiPage, MetaIndex } from './types.js';

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

  // index() / rebuildIndex() added in Task 5.
  protected get _agentId(): string {
    return this.agentId;
  }
  protected get _port(): MemoryIndexPort {
    return this.port;
  }
}
