/**
 * @fileoverview souledAgent — first-class factory for a soul-file agent whose
 * long-term memory is kept per subject beside its `memory/` wiki.
 *
 * Composes existing, tested pieces:
 * - {@link loadSoulFromOption} resolves the soul and its `memory/` dir.
 * - {@link Memory.createSqlite} opens the single backing store, in `memory/.store/`.
 * - {@link attachMemoryWiki} wires the wiki write-back loop + the
 *   `read_memory_page` tool + the boot index over the same facade.
 * - {@link agent} runs it; its `buildSystemPrompt` already injects the index of the operator's pages.
 *
 * One `Memory` facade is both the agent's live memory and the wiki store, so the
 * conversation the agent observes lands where the wiki compiler reads it. Each turn is filed under the key of its
 * subject (the session's user, else the session) and recalls that subject's memory and the operator's pages alone.
 *
 * @module agentos/api/souledAgent
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  agent,
  loadSoulFromOption,
  type AgentOptions,
  type Agent,
  type AgentMemoryProvider,
  type AgentSession,
  type MemoryHookContext,
} from './agent.js';
import { generateText } from './generateText.js';
import type { StreamTextResult } from './streamText.js';
import { Memory, type ScoredTrace } from '../cognition/memory/io/facade/Memory.js';
import { conversationScopeKey, parseConversationScopeKey } from '../cognition/memory/retrieval/store/conversationScopeKey.js';
import { encodePlainScopeId } from '../cognition/memory/retrieval/store/scopeIdForm.js';
import { memoryLog } from '../cognition/memory/log.js';
import { soulAgentIdOf } from '../cognition/substrate/personas/SoulLoader.js';
import { attachMemoryWiki } from '../cognition/memory/io/attachMemoryWiki.js';
import { SemanticChunker } from '../cognition/rag/chunking/SemanticChunker.js';
import { estimateTokens } from '../core/utils/text-utils.js';
import { createFileOutsideLinksSync } from '../core/utils/linkFreeWrite.js';
import { errorFields } from '../core/logging/events.js';
import { formatMemoryAge } from '../cognition/memory/core/prompt/MemoryFormatters.js';
import { parseTraceMetadata } from '../cognition/memory/retrieval/store/tracePersistence.js';
import { DEFAULT_MEMORY_TOKEN_BUDGET } from './runtime/memoryProviderHooks.js';
import { messageOf } from './runtime/memoryObserveFailures.js';
import { isAnonymousUserId } from './runtime/memorySubject.js';
import { asSpendBudget } from './runtime/spendBudget.js';
import type { AgentOSUsageLedgerOptions } from './runtime/usageLedger.js';

/** Characters a token is estimated at, as `estimateTokens` counts them. */
const CHARS_PER_TOKEN = 4;

/**
 * How long `close()` waits for the agent's turns still running and for the memory writes of its turns before it
 * compiles, unless an option sets it.
 */
export const DEFAULT_PENDING_WRITES_TIMEOUT_MS = 5_000;

/** The longest delay a timer takes (2^31 - 1 ms, about 24.8 days); a longer one fires at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The usage ledger's source for the model calls of the wiki compile a souled agent runs. */
export const SOULED_AGENT_COMPILE_SOURCE = 'souledAgent.compileWiki';

/**
 * The key of the trace metadata in which the observer records who spoke a trace: `'user'` or `'assistant'`. It is
 * kept out of the trace's text and its tags, which the store's full-text search reads, so a search never matches a
 * trace by who spoke it.
 */
export const SPEAKER_METADATA_KEY = 'speaker';

/** Who spoke a trace, as the observer records it. */
type Speaker = 'user' | 'assistant';

/** Who a turn's memory belongs to: the user its session named, else the session. */
type MemorySubject = MemoryHookContext['subject'];

/** How many traces a turn's recall reads from its subject's memory, and how many from the operator's pages. */
const RECALL_LIMIT = 8;

/** What `sharedMemory` must be, as the rejection of an option that is not says it. */
const SHARED_MEMORY_SHAPE =
  "souledAgent: sharedMemory needs { as: <a user id>, reason: 'one-persons-machine' | 'operators-notes' }";

/** The tag a wiki page chunk carries for its page: `page:<id>`. */
const PAGE_TAG = 'page:';

/** One recalled trace: the label that opens its line, then its text, and the label's parts as a record's fields. */
interface RecallLine {
  /** `[user, 26 days ago, 2026-10-14] `: who spoke it and when it was stored; ends with a space. Empty when dropped. */
  prefix: string;
  content: string;
  /** Who spoke it, or `note` for a chunk of a wiki page; undefined when no speaker was recorded. */
  speaker?: 'user' | 'assistant' | 'note';
  /** The page id of a chunk of a wiki page. */
  page?: string;
  /** When it was stored, as its label shows it (`26 days ago, 2026-10-14`). */
  when: string;
}

/** The page id of a chunk of a wiki page, from the tags the wiki gives it (`wiki` and `page:<id>`); else undefined. */
function wikiPageOf(trace: { tags: readonly string[] }): string | undefined {
  if (!trace.tags.includes('wiki')) return undefined;
  return trace.tags.find((tag) => tag.startsWith(PAGE_TAG))?.slice(PAGE_TAG.length);
}

/** The speaker recorded in a trace's metadata (`'user'` or `'assistant'`); undefined for any other value or none. */
function speakerIn(metadata: string | undefined): Speaker | undefined {
  const speaker = parseTraceMetadata(metadata)[SPEAKER_METADATA_KEY];
  return speaker === 'user' || speaker === 'assistant' ? speaker : undefined;
}

/**
 * The label a recalled trace's line opens with: who spoke it (`user` or `assistant`, as the observer recorded it, or
 * `note` and the page id for a chunk of a wiki page) and when it was stored, in the memory block's wording
 * (`26 days ago, 2026-10-14`). A trace with no speaker, such as one stored before speakers were recorded, has the date
 * alone.
 */
function recallPrefix(trace: { createdAt: number }, speaker: string | undefined, now: number): string {
  const when = formatMemoryAge(trace.createdAt, now);
  return speaker ? `[${speaker}, ${when}] ` : `[${when}] `;
}

/**
 * A trace's text on one line: its lines, each trimmed, joined by one space, blank ones left out. The text of a trace
 * can then never open a line of the recall block, where only a label opens one. Linear in the text's length.
 */
function onOneLine(text: string): string {
  return text
    .split(/[\n\r\v\f\u0085\u2028\u2029]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ');
}

/**
 * The recalled traces, in rank order, that fit `tokenBudget` when joined one line each (its label, then its text),
 * estimated with `estimateTokens`. Whole lines are kept while they fit; when the first alone is larger, it is kept with
 * its text cut at the last word boundary that fits beside its label (mid-word only when it has none, and never inside a
 * character a surrogate pair encodes), so a matched trace never yields no recall under a positive budget; a label
 * longer than the whole budget is dropped (its `prefix` is then empty). A budget of 0 or less asks for no recall, and
 * one that is not a number is the hooks' default.
 *
 * @param lines - The traces' labels and text, best first.
 * @param tokenBudget - The recall's token ceiling.
 * @returns The kept lines; none when nothing was recalled or the budget is 0 or less.
 */
function fitRecallLines(lines: readonly RecallLine[], tokenBudget: number): RecallLine[] {
  if (tokenBudget <= 0) return [];
  const budget = Number.isNaN(tokenBudget) ? DEFAULT_MEMORY_TOKEN_BUDGET : Math.floor(tokenBudget);
  const recalled = lines.filter((line) => line.content.length > 0);
  if (recalled.length === 0) return [];
  const kept: RecallLine[] = [];
  let block = '';
  for (const line of recalled) {
    const text = `${line.prefix}${line.content}`;
    const next = block ? `${block}\n${text}` : text;
    if (estimateTokens(next) > budget) break;
    block = next;
    kept.push(line);
  }
  if (kept.length > 0) return kept;
  const first = recalled[0];
  const { content } = first;
  const room = budget * CHARS_PER_TOKEN - first.prefix.length;
  const prefix = room >= 1 ? first.prefix : '';
  const maxChars = Math.max(1, room >= 1 ? room : budget * CHARS_PER_TOKEN);
  const head = codePointPrefix(content, maxChars);
  // Cut back to the last whitespace when the cut falls inside a word; text that fits whole is not cut.
  const whole = head.length >= content.length;
  const cut = whole || /\s/.test(content.charAt(maxChars)) ? head : head.replace(/\s+\S*$/, '');
  return [{ ...first, prefix, content: cut.trimEnd() || head }];
}

/**
 * Wait for `pending` to empty, up to `timeoutMs`; a promise added while waiting (a turn's memory write, which its
 * observe hook adds before the turn settles) is waited for too.
 *
 * @returns How many promises are still pending when the wait ends.
 */
async function waitForWrites(pending: Set<Promise<unknown>>, timeoutMs: number): Promise<number> {
  if (pending.size === 0 || timeoutMs <= 0) return pending.size;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    // A timer longer than the longest one fires at once, so a longer wait is held to the longest.
    timer = setTimeout(() => resolve('deadline'), Math.min(timeoutMs, MAX_TIMER_DELAY_MS));
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    while (pending.size > 0) {
      const outcome = await Promise.race([Promise.allSettled([...pending]).then(() => 'settled' as const), deadline]);
      if (outcome === 'deadline') break;
    }
  } finally {
    clearTimeout(timer);
  }
  return pending.size;
}

/**
 * The first `maxUnits` UTF-16 units of `text`, one fewer when the last would be the first half of a surrogate pair,
 * so no character is cut in two; the whole first character when it alone is longer than `maxUnits`.
 */
function codePointPrefix(text: string, maxUnits: number): string {
  const splitsPair = /[\uD800-\uDBFF]/.test(text.charAt(maxUnits - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(maxUnits));
  const end = splitsPair ? maxUnits - 1 : maxUnits;
  return end > 0 ? text.slice(0, end) : String.fromCodePoint(text.codePointAt(0) ?? 0);
}

/**
 * Throws unless `sharedMemory` is `{ as, reason }` with a user id that names someone, which a conversation key can be
 * built from, and one of the two reasons.
 *
 * @param sharedMemory - The option as the caller gave it.
 * @param anonymousUserIds - The ids the agent itself reads as naming nobody, beside the built-in ones.
 * @throws TypeError naming the shape the option must have.
 */
function assertSharedMemory(sharedMemory: unknown, anonymousUserIds: readonly string[] | null | undefined): void {
  const given = (sharedMemory !== null && typeof sharedMemory === 'object' ? sharedMemory : {}) as Record<string, unknown>;
  const user = given.as;
  const reason = given.reason;
  if (typeof user !== 'string' || isAnonymousUserId(user, anonymousUserIds)) throw new TypeError(SHARED_MEMORY_SHAPE);
  if (reason !== 'one-persons-machine' && reason !== 'operators-notes') throw new TypeError(SHARED_MEMORY_SHAPE);
  try {
    // An id that is not well-formed text has no key.
    conversationScopeKey('agent', { kind: 'user', id: user });
  } catch {
    throw new TypeError(SHARED_MEMORY_SHAPE);
  }
}

/**
 * True for the errors a spend budget's refusal throws, by name as the runtime reads them: `CostCapExceededError`,
 * `UnpricedModelError`, and `SpendMeterUnavailableError` when the budget's meter could not answer.
 */
function isBudgetRefusal(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'CostCapExceededError' || name === 'UnpricedModelError' || name === 'SpendMeterUnavailableError';
}

/** Options for {@link souledAgent}: those of {@link AgentOptions}, with `soul` required. */
export interface SouledAgentOptions extends AgentOptions {
  soul: NonNullable<AgentOptions['soul']>;
  /**
   * How long `close()` waits, in milliseconds, for the agent's turns still running and then for the memory writes of
   * its turns, one deadline for both, before it compiles the wiki. Default {@link DEFAULT_PENDING_WRITES_TIMEOUT_MS}
   * (5 seconds); 0 waits for none, and `Infinity` (or any wait past the longest timer, about 24.8 days) waits for them
   * all. When the wait ends with turns or writes still pending, the compile takes what is stored and one `console.warn`
   * line gives their number.
   */
  pendingWritesTimeoutMs?: number;
  /**
   * For one person's own machine, or an operator's own notes: every session that names no user, and every one-shot
   * `generate()` or `stream()`, runs as the user `as`, so they share one memory. A session that names another user is
   * refused, and so is opening a store that already holds the memory of another user or session.
   */
  sharedMemory?: { as: string; reason: 'one-persons-machine' | 'operators-notes' };
}

/**
 * Return type of {@link souledAgent}: an {@link Agent} with its backing
 * {@link Memory} store exposed as `memory`, so callers can fold conversation
 * into the wiki mid-session via `await agent.memory.compileWiki()`. `memory` is
 * present whenever the soul resolves to a workspace directory; it is absent for
 * inline souls that fall back to a plain agent.
 */
export type SouledAgent = Agent & { memory?: Memory };

/**
 * Create an agent whose long-term memory is its soul-file `memory/` wiki.
 *
 * When the soul resolves to a workspace directory, the wiki is wired end to end
 * (store + write-back + `read_memory_page` tool + prelude `index.md`). For inline
 * souls (`{ content }`) there is no workspace, so this falls back to a plain
 * {@link agent} and says so in one `console.warn` line.
 *
 * Memory is kept per subject. A session turn is filed under the key of its subject, the user the session named or
 * else the session itself, the user's message and the reply alike, and it recalls that subject's memory and the
 * operator's pages, and nobody else's. A one-shot `generate()` or `stream()` names no user: nothing is filed for it,
 * it recalls the operator's pages alone, and one `memory.one_shot_unfiled` line an agent says so. With
 * {@link SouledAgentOptions.sharedMemory} every session that names no user, and every one-shot call, runs as one
 * user. Traces an earlier version filed under the agent's plain id stay in the store, are read by no turn, and are
 * counted in one `memory.legacy_traces` line at open. The store's folder, `memory/.store/`, gets a `.gitignore` that
 * keeps it out of version control.
 *
 * Each stored turn records who spoke it in the trace's metadata ({@link SPEAKER_METADATA_KEY}), outside its text and
 * its tags, so recall never matches a trace by its speaker; each recalled trace is sent as one record, with its
 * speaker and its date, in a data block. The wiki compile's model calls go on the agent's route with its fallback
 * settings, are checked against and charged to its spend budget, and are written to its usage ledger under the source
 * {@link SOULED_AGENT_COMPILE_SOURCE}.
 *
 * The wiki is compiled once a subject, from that subject's traces alone, into pages that are rows of the store and
 * never files under `memory/`; each subject has its own watermark. `close()` compiles the subjects its turns wrote
 * to, and `agent.memory.compileWiki()` every subject with new traces. A subject whose compile the spend budget
 * refuses is skipped with one `memory.compile_skipped` line: its traces wait for the next compile, and the other
 * subjects compile.
 *
 * `close()` first closes the agent (with `runtime: 'gmi'` that stops its session turns), then waits, within one
 * deadline (see {@link SouledAgentOptions.pendingWritesTimeoutMs}), for the turns still running (a `generate()`, a
 * `stream()`, a session's `send()` or `stream()`, on either runtime; a stream whose signal aborted before anything was
 * read from it is not waited for, and on the default runtime a stream nobody reads and nobody aborts keeps the wait
 * until the deadline) and for the memory writes of its turns, then compiles the wiki, then closes the store. A turn or a write
 * still pending when the deadline passes is left out of the compile, and a write that reaches the store after it is
 * closed is not stored.
 *
 * @param opts - Agent options with a required `soul`.
 * @returns A fully-wired {@link Agent}.
 * @throws TypeError when `sharedMemory` is not `{ as, reason }` with a user id that names someone and one of the two
 *   reasons; nothing is opened.
 * @throws Error when `sharedMemory` is set and the store already holds the memory of another user or session; the
 *   store is closed first.
 */
export async function souledAgent(opts: SouledAgentOptions): Promise<SouledAgent> {
  const { pendingWritesTimeoutMs, sharedMemory, ...rest } = opts;
  /** The ids the agent itself reads as naming nobody, beside the built-in ones. */
  const anonymousUserIds =
    typeof rest.learning === 'object' && rest.learning !== null ? rest.learning.anonymousUserIds : undefined;
  if (sharedMemory !== undefined) assertSharedMemory(sharedMemory, anonymousUserIds);
  const loaded = loadSoulFromOption(rest.soul);
  if (!loaded) {
    // The soul failed to load, and loadSoulFromOption has warned: a plain agent without it, which loads it no
    // second time and so does not warn again.
    return agent({ ...rest, soul: undefined });
  }
  if (!loaded.memoryDir) {
    // Inline soul: no workspace dir, so no wiki. A plain agent, and a line that says so.
    console.warn(
      '[agentos] souledAgent: the soul has no workspace folder (an inline { content } soul), so no wiki memory is ' +
        'wired: no memory index, no read_memory_page tool and no compile on close. Pass the folder that holds ' +
        'SOUL.md to have them.',
    );
    return agent(rest);
  }
  // NaN, a negative number or none is the default; Infinity is held to the longest timer when the wait starts.
  const waitMs =
    typeof pendingWritesTimeoutMs === 'number' && pendingWritesTimeoutMs >= 0
      ? pendingWritesTimeoutMs
      : DEFAULT_PENDING_WRITES_TIMEOUT_MS;
  // One budget for the agent and the compile, so both draw on the same total.
  const budget = asSpendBudget(rest.budget);
  const ledger = (rest.observability?.usageLedger as AgentOSUsageLedgerOptions | undefined) ?? rest.usageLedger;

  // The soul's one id: the wiki files under it, and nothing files under a shared fallback id.
  const agentId = soulAgentIdOf(loaded.frontmatter, opts.name);
  if (!agentId) {
    throw new Error(
      "souledAgent: the soul has no agentId and no name, and the agent has no name; set agentId in SOUL.md's front matter so the agent's memory has one stable id",
    );
  }

  // The operator's pages under memory/ are markdown files; what people said to the agent lives in the store.
  const storeDir = path.join(loaded.memoryDir, '.store');
  await fs.mkdir(storeDir, { recursive: true });
  // The store holds what people said: it stays out of version control. A .gitignore already there is left as it is.
  createFileOutsideLinksSync(path.join(storeDir, '.gitignore'), '*\n');
  const memory = await Memory.createSqlite(path.join(storeDir, 'memory.sqlite'), {
    graph: true,
    selfImprove: true,
  });

  /** The user every session that names none, and every one-shot call, runs as; undefined without `sharedMemory`. */
  const sharedUser = sharedMemory?.as;
  if (sharedUser !== undefined) {
    // One person's memory: a store that holds another user's, or a session's, is not opened as theirs.
    const others = (await memory.listScopes()).filter((row) => {
      if (row.kind === 'operator') return false;
      const subject = parseConversationScopeKey(row.scopeId)?.subject;
      return !(subject?.kind === 'user' && subject.id === sharedUser);
    });
    if (others.length > 0) {
      await memory.close();
      throw new Error(
        "souledAgent: sharedMemory runs one person's memory, and this store already holds memory of another user or session",
      );
    }
  }

  // Traces an earlier version filed under the agent's plain id, in either form it was written in: no turn reads
  // them, and nothing here deletes, moves or rewrites them.
  const encodedAgentId = encodePlainScopeId('persona', agentId);
  const earlierTraces =
    (await memory.countScope('persona', agentId)) +
    (encodedAgentId !== agentId ? await memory.countScope('persona', encodedAgentId) : 0);
  if (earlierTraces > 0) memoryLog.warn('memory.legacy_traces', { count: earlierTraces });

  /** The key the operator's own pages are indexed under. */
  const operatorKey = conversationScopeKey(agentId, { kind: 'operator' });
  /** The subject a turn's memory is kept under: the one user of `sharedMemory` for a subject that names none. */
  const subjectOf = (subject: MemorySubject): MemorySubject =>
    sharedUser !== undefined && subject.kind === 'session' ? { kind: 'user', id: sharedUser } : subject;
  let oneShotNoted = false;
  /**
   * The subject one turn is filed and recalled under, from the context its hooks were given. A one-shot call that
   * names no user has none: nothing is filed for it and it recalls the operator's pages alone, which one line an
   * agent says.
   */
  const turnSubjectOf = (context: MemoryHookContext): MemorySubject | undefined => {
    const subject = subjectOf(context.subject);
    if (context.call !== 'one-shot' || subject.kind === 'user') return subject;
    if (!oneShotNoted) {
      oneShotNoted = true;
      memoryLog.warn('memory.one_shot_unfiled', {});
    }
    return undefined;
  };
  /** The key of every scope a turn of this agent wrote to. */
  const written = new Set<string>();

  // The turns still running and the memory writes the observer has started, until each settles: close() waits for
  // them before it compiles. A turn never waits for its writes.
  const pending = new Set<Promise<unknown>>();
  /** Adds `work` to what close() waits for, until it settles; returns it unchanged. */
  const awaitedOnClose = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    const settle = () => {
      pending.delete(work);
    };
    void work.then(settle, settle);
    return work;
  };
  /**
   * A stream is settled once its usage and its text are known; its text settles after its observation has started.
   * On the default runtime a stream runs only once a consumer reads it, so one whose `signal` aborts before anything
   * was read from it would never settle: its entry is released on that abort instead. An abort after the first read
   * ends the stream on either runtime, which settles its usage.
   */
  const awaitStreamOnClose = (result: StreamTextResult, signal: AbortSignal | undefined): StreamTextResult => {
    const settled = Promise.allSettled([result.usage, result.text]).then(() => undefined);
    if (!signal) {
      awaitedOnClose(settled);
      return result;
    }
    let read = false;
    const abortedUnread = new Promise<void>((resolve) => {
      const onAbort = () => {
        if (!read) resolve();
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        void settled.then(() => signal.removeEventListener('abort', onAbort));
      }
    });
    awaitedOnClose(Promise.race([settled, abortedUnread]));
    const onRead = <T>(iterable: AsyncIterable<T>): AsyncIterable<T> => ({
      [Symbol.asyncIterator](): AsyncIterator<T> {
        const inner = iterable[Symbol.asyncIterator]();
        return {
          next: (...args: [] | [undefined]) => {
            read = true;
            return inner.next(...args);
          },
          ...(inner.return ? { return: inner.return.bind(inner) } : {}),
          ...(inner.throw ? { throw: inner.throw.bind(inner) } : {}),
        };
      },
    });
    result.textStream = onRead(result.textStream);
    result.fullStream = onRead(result.fullStream);
    return result;
  };

  // Adapt the Memory facade directly to the provider contract. AgentMemory's own
  // getContext/observe signatures don't match AgentMemoryProvider, so wrap the
  // facade's remember/recall here.
  const provider: AgentMemoryProvider = {
    observe: (role, text, context) => {
      // Nothing is ever filed without the subject of its turn.
      if (!context) return Promise.reject(new TypeError('souledAgent: a memory write needs the hook context of its turn'));
      const subject = turnSubjectOf(context);
      if (!subject) return Promise.resolve();
      let scopeId: string;
      try {
        scopeId = conversationScopeKey(agentId, subject);
      } catch (err) {
        // An id no key can be built from: the hook's failure is logged by the runtime and the turn goes on.
        return Promise.reject(err);
      }
      written.add(scopeId);
      // The user's message and the reply alike go under the subject's key. Who spoke goes in the trace's metadata:
      // outside its text and its tags, which full-text search reads.
      const write = awaitedOnClose(
        memory.remember(text, {
          type: 'episodic',
          scope: 'conversation',
          scopeId,
          metadata: {
            [SPEAKER_METADATA_KEY]: role,
            subject: { kind: subject.kind, id: subject.id },
            ...(subject.kind === 'user' ? { turnUserId: subject.id } : {}),
          },
        }),
      );
      return write.then(() => undefined);
    },
    getContext: async (text, options) => {
      // Two reads, each of one key, by equality: the turn's own subject, and the operator's pages. Nothing a caller
      // passes widens them. A turn with no subject, or one whose id no key can be built from, reads the operator's.
      const subject = options?.context ? turnSubjectOf(options.context) : undefined;
      let own: ScoredTrace[] = [];
      if (subject) {
        let scopeId: string | undefined;
        try {
          scopeId = conversationScopeKey(agentId, subject);
        } catch (err) {
          // An id no key can be built from has no memory to read: the turn goes on with the operator's pages.
          memoryLog.warn('memory.hook_failed', { hook: 'getContext', ...errorFields(err) });
        }
        if (scopeId !== undefined) own = await memory.recall(text, { scope: 'conversation', scopeId, limit: RECALL_LIMIT });
      }
      const shared = await memory.recall(text, { scope: 'conversation', scopeId: operatorKey, limit: RECALL_LIMIT });
      // Best match first across the two reads; a score that is not a number ranks last.
      const rank = (score: number): number => (Number.isFinite(score) ? score : 0);
      const scored = [...own, ...shared].sort((a, b) => rank(b.score) - rank(a.score));
      const now = Date.now();
      // A recalled trace carries no metadata, so each one's speaker is read from its stored record.
      const lines: RecallLine[] = await Promise.all(
        scored.map(async ({ trace }) => {
          const page = wikiPageOf(trace);
          const speaker = page ? ('note' as const) : speakerIn((await memory.readTrace(trace.id))?.metadata);
          const label = page ? `note ${page}` : speaker;
          return {
            prefix: recallPrefix(trace, label, now),
            content: onOneLine(trace.content),
            ...(speaker ? { speaker } : {}),
            ...(page ? { page } : {}),
            when: formatMemoryAge(trace.createdAt, now),
          };
        }),
      );
      const kept = fitRecallLines(lines, options?.tokenBudget ?? DEFAULT_MEMORY_TOKEN_BUDGET);
      if (kept.length === 0) return null;
      return {
        contextText: kept.map((line) => `${line.prefix}${line.content}`).join('\n'),
        // The same lines as records: a line whose label was dropped for the budget keeps its text alone.
        items: kept.map((line) => ({
          ...(line.prefix && line.speaker ? { speaker: line.speaker } : {}),
          ...(line.prefix && line.page ? { page: line.page } : {}),
          ...(line.prefix ? { when: line.when } : {}),
          text: line.content,
        })),
      };
    },
  };

  // The compile's model calls: the agent's route and fallback settings, its completion cap (the budget's check
  // estimates a call without one at 4,096 output tokens), its budget (checked before each call and charged after it; a
  // refusal skips that subject's compile, and its watermark stays where it was), and its usage ledger.
  const llm = async (prompt: string): Promise<string> =>
    (
      await generateText({
        provider: rest.provider,
        model: rest.model,
        prompt,
        maxTokens: rest.maxTokens ?? rest.controls?.maxTotalTokens,
        apiKey: rest.apiKey,
        baseUrl: rest.baseUrl,
        fallbackProviders: rest.fallbackProviders,
        onFallback: rest.onFallback,
        router: rest.router,
        hostPolicy: rest.hostPolicy,
        routerParams: rest.routerParams,
        policyTier: rest.policyTier,
        ...(budget ? { budget } : {}),
        ...(rest.accountIdOf ? { accountIdOf: rest.accountIdOf } : {}),
        usageLedger: { ...(ledger ?? {}), source: SOULED_AGENT_COMPILE_SOURCE },
      })
    ).text;

  const chunker = new SemanticChunker();
  const priorTools = rest.tools;
  const { tools: augmentedTools } = await attachMemoryWiki({
    memory,
    memoryDir: loaded.memoryDir,
    agentId,
    llm,
    chunk: (t) => chunker.chunk(t).map((c) => ({ text: c.text })),
    tools: Array.isArray(priorTools) ? [...priorTools] : undefined,
    // The page tool reads the key the observer writes.
    subjectOf,
    // A subject whose compile the budget refuses is skipped: its traces wait, and the other subjects compile.
    compileSkipReasonOf: (error) => (isBudgetRefusal(error) ? 'budget' : undefined),
  });

  // attachMemoryWiki appends read_memory_page to an array. Use the augmented
  // array when tools were an array (or absent); pass map/registry inputs through
  // unchanged (the rare non-array AdaptableToolInput shapes).
  const tools = (
    priorTools && !Array.isArray(priorTools) ? priorTools : augmentedTools
  ) as AgentOptions['tools'];

  const built = agent({ ...rest, ...(budget ? { budget } : {}), memoryProvider: provider, tools }) as SouledAgent;

  // Every turn joins what close() waits for: its promise, or a stream's settled usage. The default runtime's own close
  // does not wait for a running turn, and the GMI runtime's does not wait for a one-shot call.
  const generateTurn = built.generate.bind(built);
  built.generate = (prompt, extra) => awaitedOnClose(generateTurn(prompt, extra));
  const streamTurn = built.stream.bind(built);
  built.stream = (prompt, extra) => awaitStreamOnClose(streamTurn(prompt, extra), extra?.abortSignal);
  const openSession = built.session.bind(built);
  const trackedSessions = new WeakSet<AgentSession>();
  built.session = (id, sessionOptions) => {
    if (sharedUser !== undefined) {
      // One person's memory: a session runs as that user, by name or by naming nobody.
      const asked: unknown = sessionOptions?.userId;
      if (typeof asked === 'string' && asked !== sharedUser && !isAnonymousUserId(asked, anonymousUserIds)) {
        throw new Error('souledAgent: sharedMemory runs every session as one user; this session named another');
      }
    }
    const session = openSession(id, sessionOptions);
    // A runtime that hands the same session object back is wrapped once.
    if (!trackedSessions.has(session)) {
      trackedSessions.add(session);
      const send = session.send.bind(session) as (...args: unknown[]) => Promise<unknown>;
      session.send = ((...args: unknown[]) => awaitedOnClose(send(...args))) as AgentSession['send'];
      const streamSession = session.stream.bind(session);
      session.stream = (input, streamOpts) => awaitStreamOnClose(streamSession(input, streamOpts), streamOpts?.abortSignal);
    }
    return session;
  };

  // On teardown: close the agent (with runtime: 'gmi' that stops its running session turns and shuts its sessions
  // down); wait, within one deadline, for the turns still running and then for the memory writes of its turns; fold
  // the conversation into the wiki; then close the backing store. The compile is best-effort (a failed LLM merge must
  // never block teardown) and a failure is logged; closing prevents leaked SQLite handles in long-lived hosts. An
  // error from the agent's own close is thrown once the store is closed.
  const originalClose = built.close.bind(built);
  built.close = async () => {
    let closeFailed = false;
    let closeError: unknown;
    try {
      await originalClose();
    } catch (err) {
      closeFailed = true;
      closeError = err;
    }
    try {
      const stillPending = await waitForWrites(pending, waitMs);
      if (stillPending > 0) {
        console.warn(
          `[agentos] souledAgent: close() waited ${waitMs} ms for its turns still running and the memory writes of ` +
            `its turns; still pending: ${stillPending}. The wiki compile takes what is stored, and a write that ` +
            'reaches the store once it is closed is not stored.',
        );
      }
      try {
        // The subjects this agent's turns wrote to; a trace stored another way waits for memory.compileWiki().
        await memory.compileWiki({ reason: 'session-end', scopes: [...written] });
      } catch (err) {
        // A subject's watermark moves only past compiled traces, so the next compile takes these up again.
        // The reason goes in as text alone: the console's inspection of an error can throw, and close must go on.
        console.warn(
          `[agentos] souledAgent: the memory wiki compile on close failed (${messageOf(err)}); ` +
            'the conversation traces stay in the store for the next compile.',
        );
      }
    } finally {
      await memory.close();
    }
    if (closeFailed) throw closeError;
  };

  // Expose the store so callers can fold conversation into the wiki mid-session
  // (`await agent.memory.compileWiki()`) without waiting for close().
  built.memory = memory;

  return built;
}
