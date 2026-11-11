/**
 * @fileoverview One subject's wiki pages as rows of the memory store. The pages compiled from one user's (or one
 * session's) conversations live here, under that subject's conversation key, and never as files: the folder
 * `memory/` holds the operator's own pages (`WikiMemoryStore`).
 */
import { sha256 } from '../../../memory/core/util/crossPlatformCrypto.js';
import { parseConversationScopeKey } from '../../../memory/retrieval/store/conversationScopeKey.js';
import { parsePage, serializePage } from './WikiPageCodec.js';
import { assertWikiPageId } from './WikiPageId.js';
import type { IndexResult, WikiPage, WikiPageStorePort } from './types.js';

/** One chunk of a page's body, as the store hands it to the facade to file. */
type PageChunk = { text: string; type: 'episodic' | 'semantic'; entities?: readonly string[] };

/** The slice of the Memory facade the store needs (injected for testability). */
export interface UserWikiPagesPort {
  readPageRow(
    scopeId: string,
    pageId: string,
  ): Promise<{ content: string; contentHash: string; chunkIds: string[] } | null>;
  listPageRows(
    scopeId: string,
  ): Promise<Array<{ pageId: string; content: string; contentHash: string; chunkIds: string[] }>>;
  writePageRow(
    scopeId: string,
    page: {
      pageId: string;
      content: string;
      contentHash: string;
      chunks?: ReadonlyArray<PageChunk>;
      /** Keep the row's chunks when the stored body's hash is `contentHash`, compared at the write itself. */
      keepChunksIfUnchanged?: boolean;
    },
  ): Promise<{ chunkIds: string[] }>;
  /**
   * File a page's chunks again from the text its row holds when the write runs, keeping that text; null when the
   * scope holds no such page or `chunksOf` answers null.
   */
  reindexPageRow(
    scopeId: string,
    pageId: string,
    chunksOf: (content: string) => ReadonlyArray<PageChunk> | null,
  ): Promise<{ chunkIds: string[]; removed: string[] } | null>;
  deletePageRows(scopeId: string, pageId?: string): Promise<{ pages: number; chunks: number }>;
}

export interface UserWikiStoreOptions {
  /** The subject's key: `conversationScopeKey(agentId, { kind: 'user' | 'session', id })`. */
  scopeId: string;
  /** Where the rows live: a `Memory` facade. */
  pages: UserWikiPagesPort;
  /** Splits a page's body into the chunks filed for recall. */
  chunk: (text: string) => Array<{ text: string }>;
}

/**
 * The wiki pages of one subject (a named user, or a session that names none) with one agent. Every read and write
 * goes to the rows filed under the subject's key, matched by equality: no call reaches another subject's pages.
 */
export class UserWikiStore implements WikiPageStorePort {
  private readonly scopeId: string;
  private readonly pages: UserWikiPagesPort;
  private readonly chunk: (text: string) => Array<{ text: string }>;

  /** @throws TypeError when `scopeId` is not the conversation key of a user or of a session. */
  constructor(opts: UserWikiStoreOptions) {
    const kind = parseConversationScopeKey(opts.scopeId)?.subject.kind;
    if (kind !== 'user' && kind !== 'session') {
      throw new TypeError("UserWikiStore: scopeId must be a user's or a session's conversation key");
    }
    this.scopeId = opts.scopeId;
    this.pages = opts.pages;
    this.chunk = opts.chunk;
  }

  /**
   * Read page `id` of this subject, or null when the subject has no such page or its stored text does not parse.
   *
   * @throws InvalidWikiPageIdError when the id is refused (see `isWikiPageId`); nothing is read.
   */
  async readPage(id: string): Promise<WikiPage | null> {
    assertWikiPageId(id);
    const row = await this.pages.readPageRow(this.scopeId, id);
    if (!row) return null;
    try {
      return parsePage(id, row.content);
    } catch {
      return null;
    }
  }

  /**
   * Write a page of this subject. A page whose body changed is chunked again and its old chunks are deleted for good;
   * a page whose body is the one stored keeps its chunks, and only its text (summary, sources, date) is replaced.
   *
   * @throws InvalidWikiPageIdError when the page's id is refused (see `isWikiPageId`); nothing is written.
   */
  async writePage(page: WikiPage): Promise<void> {
    assertWikiPageId(page.id);
    const content = serializePage(page);
    const contentHash = await sha256(page.body);
    // The facade compares the body with the stored row once the scope's earlier writes have settled, so a write made
    // while another one changes the page never keeps the chunks of a body the row no longer holds.
    await this.pages.writePageRow(this.scopeId, {
      pageId: page.id,
      content,
      contentHash,
      chunks: this.chunksOf(page),
      keepChunksIfUnchanged: true,
    });
  }

  /** Every page of this subject, by page id. A row whose text does not parse is left out. */
  async listPages(): Promise<WikiPage[]> {
    const pages: WikiPage[] = [];
    for (const row of await this.pages.listPageRows(this.scopeId)) {
      try {
        pages.push(parsePage(row.pageId, row.content));
      } catch {
        // A row that does not parse has no page to list.
      }
    }
    return pages;
  }

  /**
   * A page's chunks are filed when the page is written, so a plain call indexes nothing and reports every page as
   * skipped. With `force`, each page's chunks are written again from the text its row holds when its write runs, and
   * that text is kept: a page another write changed after the listing is chunked as that write left it, and never
   * written back as it was listed. `removed` lists the old chunk ids. A page deleted after the listing, or whose text
   * does not parse, is listed as skipped.
   */
  async index(opts?: { force?: boolean }): Promise<IndexResult> {
    const result: IndexResult = { indexed: [], skipped: [], removed: [] };
    const rows = await this.pages.listPageRows(this.scopeId);
    if (!opts?.force) {
      result.skipped.push(...rows.map((row) => row.pageId));
      return result;
    }
    for (const row of rows) {
      const written = await this.pages.reindexPageRow(this.scopeId, row.pageId, (content) => {
        try {
          return this.chunksOf(parsePage(row.pageId, content));
        } catch {
          return null;
        }
      });
      if (!written) {
        result.skipped.push(row.pageId);
        continue;
      }
      result.indexed.push(row.pageId);
      result.removed.push(...written.removed);
    }
    return result;
  }

  /**
   * Delete page `id` of this subject with its chunks, for good.
   *
   * @returns True when the subject had the page.
   * @throws InvalidWikiPageIdError when the id is refused (see `isWikiPageId`); nothing is deleted.
   */
  async deletePage(id: string): Promise<boolean> {
    assertWikiPageId(id);
    return (await this.pages.deletePageRows(this.scopeId, id)).pages > 0;
  }

  /** Delete every page of this subject with its chunks, for good, and nothing of any other subject. */
  async deleteAll(): Promise<{ pages: number; chunks: number }> {
    return this.pages.deletePageRows(this.scopeId);
  }

  /** The chunks of a page's body: a log page's as episodic traces, any other page's as semantic ones. */
  private chunksOf(page: WikiPage): PageChunk[] {
    return this.chunk(page.body).map((c) => ({
      text: c.text,
      type: page.type === 'log' ? 'episodic' : 'semantic',
      entities: page.links,
    }));
  }
}
