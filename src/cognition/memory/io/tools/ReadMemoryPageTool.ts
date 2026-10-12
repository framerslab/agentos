/** @fileoverview Tool: read a full memory wiki page on demand by id. */
import type {
  ITool,
  ToolExecutionResult,
  ToolExecutionContext,
  JSONSchemaObject,
} from '../../../../core/tools/ITool.js';
import type { WikiPage } from '../../../substrate/memory/wiki/types.js';
import { assertWikiPageId, InvalidWikiPageIdError } from '../../../substrate/memory/wiki/WikiPageId.js';

/** The slice of the wiki store this tool needs (injected for testability). */
export interface ReadMemoryPagePort {
  readPage(id: string): Promise<WikiPage | null>;
}

/** Input arguments for {@link ReadMemoryPageTool}. */
interface ReadMemoryPageInput {
  /** Page id relative to `memory/`, without the `.md` extension. */
  id: string;
}

/** Output payload: the full page, structured. */
interface ReadMemoryPageOutput {
  id: string;
  type: string;
  summary: string;
  body: string;
  links: string[];
}

/**
 * Lets an agent open a full page from its long-term memory wiki by id. Pairs
 * with the `index.md` catalog injected into the system prelude: the agent sees
 * the catalog, then reads the page it needs.
 *
 * An id without the wiki's id form (see `isWikiPageId`) is answered with an
 * error result whose `details.code` is `INVALID_WIKI_PAGE_ID`, and the port is
 * not called for it.
 */
export class ReadMemoryPageTool implements ITool<ReadMemoryPageInput, ReadMemoryPageOutput> {
  readonly id = 'read-memory-page-v1';
  readonly name = 'read_memory_page';
  readonly displayName = 'Read Memory Page';
  readonly description =
    'Read a full page from your long-term memory wiki by id (e.g. "entities/johnny" or "concepts/billing"). ' +
    'Use after seeing a page listed in the memory index to pull its complete contents.';
  readonly category = 'memory';
  readonly hasSideEffects = false;
  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Page id relative to memory/, without the .md extension (e.g. "entities/johnny").',
      },
    },
    required: ['id'],
  };

  constructor(private readonly port: ReadMemoryPagePort) {}

  async execute(
    args: ReadMemoryPageInput,
    _context: ToolExecutionContext,
  ): Promise<ToolExecutionResult<ReadMemoryPageOutput>> {
    const id: unknown = args?.id;
    let page: WikiPage | null;
    try {
      // Checked here as well as in the store, so a port that maps ids to files without the check is covered too.
      assertWikiPageId(id);
      page = await this.port.readPage(id);
    } catch (err) {
      if (!(err instanceof InvalidWikiPageIdError)) throw err;
      return { success: false, error: err.message, details: { code: err.code, problem: err.problem } };
    }
    if (!page) {
      return { success: false, error: `No memory page found with id "${args.id}".` };
    }
    return {
      success: true,
      output: { id: page.id, type: page.type, summary: page.summary, body: page.body, links: page.links },
      contentType: 'application/json',
    };
  }
}
