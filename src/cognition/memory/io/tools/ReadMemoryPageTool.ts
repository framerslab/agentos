/** @fileoverview Tool: read a full memory wiki page on demand by id, or list the pages the asker can read. */
import type {
  ITool,
  ToolExecutionResult,
  ToolExecutionContext,
  JSONSchemaObject,
} from '../../../../core/tools/ITool.js';
import { DEFAULT_ANONYMOUS_USER_IDS } from '../../../learning/types.js';
import type { WikiPage } from '../../../substrate/memory/wiki/types.js';
import { assertWikiPageId, InvalidWikiPageIdError } from '../../../substrate/memory/wiki/WikiPageId.js';
import { memoryLog } from '../../log.js';

/** Who asks for a page: the subject of the turn the call runs in, or nobody (the operator running the agent itself). */
export interface ReadMemoryPageAsker {
  subject?: { kind: 'user' | 'session'; id: string };
}

/** One line of the listing: a page the asker can read, and whose it is. */
export interface ReadMemoryPageListing {
  id: string;
  summary: string;
  /** `own` for a page kept for the asker, `operator` for a page shared by everyone the agent talks with. */
  owner: 'own' | 'operator';
}

/** The slice of the wiki this tool needs (injected for testability). */
export interface ReadMemoryPagePort {
  /**
   * The page for `asker`: the asker's own page of that id first, then the operator's; null for neither, for another
   * subject's page, and for a page an earlier version compiled when a user asks.
   */
  readPage(id: string, asker: ReadMemoryPageAsker): Promise<WikiPage | null>;
  /** The asker's own pages and the operator's; with no user, the operator's alone, earlier compiled pages among them. */
  listPages(asker: ReadMemoryPageAsker): Promise<ReadMemoryPageListing[]>;
}

/** Input arguments for {@link ReadMemoryPageTool}: a page id, or `list: true`. */
interface ReadMemoryPageInput {
  /** Page id, without the `.md` extension. */
  id?: string;
  /** True to list the pages the asker can read. */
  list?: true;
}

/** Output payload: the full page, structured. */
interface ReadMemoryPageContent {
  id: string;
  type: string;
  summary: string;
  body: string;
  links: string[];
}

/** Output payload: one page, or the listing. */
type ReadMemoryPageOutput = ReadMemoryPageContent | { pages: ReadMemoryPageListing[] };

/**
 * The arguments that would name whose memory to read. The tool takes none of them: the asker is the runtime's, so a
 * call that carries one is refused whole rather than read with the argument dropped.
 */
const CALLER_FILTERS = ['scope', 'scopeId', 'userId', 'turnUserId', 'subject'] as const;

const INVALID_ARGS_ERROR =
  'read_memory_page takes { "id": "<page id>" } or { "list": true } and no scope or user argument.';

/**
 * The asker of a tool call, from the context the runtime built; never from the call's arguments.
 *
 * The subject the runtime put in `context.userContext.memorySubject`, when it holds a kind of `user` or `session` and
 * a non-empty id, is the asker, whatever `context.userContext.userId` holds: the subject is the key the turn's memory
 * is filed under, so a session whose id, or whose user id, is one of the anonymous words reads its own pages and is
 * never read as nobody. With no such subject the user is `context.userContext.userId`: an id that names nobody (`''`,
 * `anonymous_user`, `anonymous`, `system`, `guest`), or no id at all, is nobody, and the result has no subject; any
 * other id is the user of that id, so a context that names a user and no subject is never read as nobody.
 *
 * @param context - The execution context the tool was called with.
 */
export function memoryAskerOf(context: ToolExecutionContext | undefined): ReadMemoryPageAsker {
  const given: unknown = context?.userContext;
  const userContext = given !== null && typeof given === 'object' ? (given as Record<string, unknown>) : undefined;
  const subject = userContext?.memorySubject;
  if (subject !== null && typeof subject === 'object') {
    const { kind, id } = subject as { kind?: unknown; id?: unknown };
    if ((kind === 'user' || kind === 'session') && typeof id === 'string' && id !== '') {
      return { subject: { kind, id } };
    }
  }
  const userId = typeof userContext?.userId === 'string' ? userContext.userId : '';
  if (DEFAULT_ANONYMOUS_USER_IDS.includes(userId)) return {};
  return { subject: { kind: 'user', id: userId } };
}

/**
 * Lets an agent open a full page from its long-term memory wiki by id, or list the pages it can read: the pages kept
 * for the person it is talking with, and the operator's shared pages.
 *
 * Whose pages a call reads is decided by the turn it runs in ({@link memoryAskerOf}), never by its arguments: a call
 * that carries `scope`, `scopeId`, `userId`, `turnUserId` or `subject` is answered with an error result whose
 * `details.code` is `INVALID_ARGS`, the port is not called, and one `memory.page_read_refused` line is logged with
 * the reason `caller_filter`. A page the asker may not read answers exactly as a page that does not exist.
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
    'Read a page from your long-term memory by id (e.g. "concepts/billing"), or pass { "list": true } to list the ' +
    'pages you can read: the notes kept for the person you are talking with, and the shared pages.';
  readonly category = 'memory';
  readonly hasSideEffects = false;
  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Page id, without the .md extension (e.g. "entities/johnny").',
      },
      list: {
        type: 'boolean',
        description: 'Pass true to list the pages you can read.',
      },
    },
  };

  constructor(private readonly port: ReadMemoryPagePort) {}

  async execute(
    args: ReadMemoryPageInput,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult<ReadMemoryPageOutput>> {
    const raw: unknown = args;
    const given: Record<string, unknown> = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    if (CALLER_FILTERS.some((name) => Object.prototype.hasOwnProperty.call(given, name))) {
      memoryLog.warn('memory.page_read_refused', { reason: 'caller_filter' });
      return invalidArgs();
    }
    const asker = memoryAskerOf(context);

    const id = given.id;
    if (id !== undefined) {
      let page: WikiPage | null;
      try {
        // Checked here as well as in the store, so a port that maps ids to files without the check is covered too.
        assertWikiPageId(id);
        page = await this.port.readPage(id, asker);
      } catch (err) {
        if (!(err instanceof InvalidWikiPageIdError)) throw err;
        return { success: false, error: err.message, details: { code: err.code, problem: err.problem } };
      }
      if (!page) {
        return { success: false, error: `No memory page found with id "${id}".` };
      }
      return {
        success: true,
        output: { id: page.id, type: page.type, summary: page.summary, body: page.body, links: page.links },
        contentType: 'application/json',
      };
    }

    if (given.list === true) {
      return {
        success: true,
        output: { pages: await this.port.listPages(asker) },
        contentType: 'application/json',
      };
    }
    return invalidArgs();
  }
}

/** The result for a call that gives neither an id nor the list, or that names whose memory to read. */
function invalidArgs(): ToolExecutionResult<ReadMemoryPageOutput> {
  return { success: false, error: INVALID_ARGS_ERROR, details: { code: 'INVALID_ARGS' } };
}
