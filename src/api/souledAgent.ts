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
import { Memory, type AttachedWiki, type ScoredTrace } from '../cognition/memory/io/facade/Memory.js';
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
import { DEFAULT_MEMORY_TOKEN_BUDGET, MEMORY_TIMEOUT_MS } from './runtime/memoryProviderHooks.js';
import { messageOf } from './runtime/memoryObserveFailures.js';
import { isAnonymousUserId } from './runtime/memorySubject.js';
import { asSpendBudget } from './runtime/spendBudget.js';
import { credentialsGoWith, modelNamesAnotherProvider } from './runtime/credentialOwner.js';
import { resolveCognition, type CognitionInputs } from './runtime/gmiCognition.js';
import { resolveModelOption } from './model.js';
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

/**
 * What a host's memory policy answers for the account a turn serves.
 *
 * - `{ longTerm: 'off' }`: nothing is filed for the account, and its turns recall the operator's pages alone.
 * - `{ longTerm: 'raw' }`: its turns are filed and recalled as traces, and no page is compiled for it.
 * - `{ longTerm: 'compiled' }`: its turns are filed, recalled and compiled into its pages. The default.
 */
export type MemoryPolicy = { longTerm: 'off' } | { longTerm: 'raw' } | { longTerm: 'compiled' };

/** The policy of an agent that names none. */
const COMPILED: MemoryPolicy = { longTerm: 'compiled' };

/** What a turn's memory does: the account's policy, or `'failed'` when the host's policy hook gave no valid answer. */
type TurnPolicy = MemoryPolicy | 'failed';

/** A hook that did not answer within its time. */
const TIMED_OUT = Symbol('timed out');

/** A screen hook that failed: a symbol, so no text a screen answers, and no text a person writes, is read as it. */
const SCREEN_FAILED = Symbol('screen failed');

/** Whether a GMI built from `opts` runs cognitive memory; options that do not resolve are left for agent() to refuse. */
function cognitiveMemoryOf(opts: CognitionInputs): boolean {
  try {
    return Boolean(resolveCognition(opts).memory);
  } catch {
    return false;
  }
}

/** `work`'s result, or {@link TIMED_OUT} when it has not settled within `ms`. A rejection is the caller's to catch. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), Math.min(Math.max(ms, 0), MAX_TIMER_DELAY_MS));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** True for an object whose only key is `longTerm`, holding one of the three words a policy takes. */
function isMemoryPolicy(value: unknown): value is MemoryPolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'longTerm') return false;
  const { longTerm } = value as { longTerm?: unknown };
  return longTerm === 'off' || longTerm === 'raw' || longTerm === 'compiled';
}

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
  /**
   * Where the wiki compile's model calls go. Unset: the agent's own provider and model, on its route, budget and
   * ledger. An object names another provider or model (a local model included): the compile's text then goes to that
   * provider alone, with no fallback and no router, and the agent's own key is sent only to the agent's own provider.
   * `false`: no compile; raw traces only, and no per-user page is ever written.
   */
  compile?: { provider?: string; model?: string; apiKey?: string; baseUrl?: string } | false;
  /**
   * The host's policy for the account a turn serves; asked once a session and kept for it. A hook that throws,
   * rejects, does not answer within the memory hooks' timeout (`memoryProviderOptions.timeoutMs`) or answers anything
   * but one of the three policies fails closed: nothing is filed for that turn, it recalls the operator's pages alone,
   * and the next turn asks again.
   */
  memoryPolicy?: (context: MemoryHookContext) => MemoryPolicy | Promise<MemoryPolicy>;
  /**
   * Screens or redacts text before it is filed (and so embedded) and before it is sent to a compile. Returns the text
   * to use, or null to drop it. A hook that throws, rejects, does not answer within the memory hooks' timeout or
   * answers anything else fails closed: the text is not filed, and a compile that needs it does not run.
   */
  screen?: (text: string, context: MemoryHookContext & { stage: 'file' | 'compile' }) => Promise<string | null>;
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
 * Three options say what is kept and where it goes. {@link SouledAgentOptions.compile} names the provider or model
 * the compile's calls go to, or turns the compile off (`false`: raw traces only, one `memory.compile_skipped` line at
 * open). {@link SouledAgentOptions.memoryPolicy} is asked once a session for the account the turn serves: `off` files
 * nothing and recalls the operator's pages alone, `raw` files and recalls and compiles no page, `compiled` is the
 * default. {@link SouledAgentOptions.screen} is given each text before it is filed and again before it is compiled.
 * Both hooks fail closed: a hook that throws, times out or answers anything else files nothing for that write
 * (`memory.write_refused`), and a compile it fails for does not run (`memory.compile_skipped`), its traces waiting
 * with their watermark where it was. A compile started in a process that served no turn of a subject has no policy
 * answer and no hook context for it: under a policy hook it is not compiled, and under a screen hook neither.
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
 * @throws TypeError when `memoryPolicy`, `screen` or `sharedMemory` is set on an agent whose cognitive memory is on
 *   (`runtime: 'gmi'` with `cognition.memory`, the `full` profile, or the `memory` option): the GMI keeps that memory
 *   in a store of its own, which none of them reaches; nothing is opened.
 */
export async function souledAgent(opts: SouledAgentOptions): Promise<SouledAgent> {
  const { pendingWritesTimeoutMs, sharedMemory, compile, memoryPolicy, screen, ...rest } = opts;
  /** The ids the agent itself reads as naming nobody, beside the built-in ones. */
  const anonymousUserIds =
    typeof rest.learning === 'object' && rest.learning !== null ? rest.learning.anonymousUserIds : undefined;
  if (sharedMemory !== undefined) assertSharedMemory(sharedMemory, anonymousUserIds);
  // The two hooks and sharedMemory act on this agent's own store. A GMI's cognitive memory files and recalls in a store
  // of its own, which none of them reaches: an account the policy turns off would still be remembered there, and
  // sessions sharedMemory runs as one user would not share it. They are refused together, before the soul is loaded:
  // an inline soul, or an optional one that does not load, builds a plain agent that keeps cognitive memory too.
  if ((memoryPolicy || screen || sharedMemory !== undefined) && rest.runtime === 'gmi' && cognitiveMemoryOf(rest as CognitionInputs)) {
    throw new TypeError(
      "souledAgent: memoryPolicy, screen and sharedMemory act on the souled agent's own memory, and cognitive memory (runtime: 'gmi' with cognition memory on) keeps a store none of them reaches; turn cognitive memory off, or leave them out",
    );
  }
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

  /** The key the operator's own pages are indexed under; an id no key can be built from is refused before any store is made. */
  const operatorKey = conversationScopeKey(agentId, { kind: 'operator' });

  // The operator's pages under memory/ are markdown files; what people said to the agent lives in the store.
  const storeDir = path.join(loaded.memoryDir, '.store');
  await fs.mkdir(storeDir, { recursive: true });
  // The store holds what people said: it stays out of version control. A .gitignore already there is left as it is.
  createFileOutsideLinksSync(path.join(storeDir, '.gitignore'), '*\n');
  const memory = await Memory.createSqlite(path.join(storeDir, 'memory.sqlite'), {
    graph: true,
    selfImprove: true,
  });
  /** Runs a step of the open; a step that throws closes the store first, so a failed open leaves no handle open. */
  const closingOnThrow = async <T>(step: () => T | Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (err) {
      await memory.close().catch(() => undefined);
      throw err;
    }
  };

  /** The user every session that names none, and every one-shot call, runs as; undefined without `sharedMemory`. */
  const sharedUser = sharedMemory?.as;
  if (sharedUser !== undefined) {
    // One person's memory: a store that holds another user's, or a session's, is not opened as theirs.
    const others = (await closingOnThrow(() => memory.listScopes())).filter((row) => {
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
  const earlierTraces = await closingOnThrow(
    async () =>
      (await memory.countScope('persona', agentId)) +
      (encodedAgentId !== agentId ? await memory.countScope('persona', encodedAgentId) : 0),
  );
  if (earlierTraces > 0) memoryLog.warn('memory.legacy_traces', { count: earlierTraces });

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

  /** How long the host's policy hook and its screen hook may take: the memory hooks' own timeout. */
  const hookTimeoutMs = rest.memoryProviderOptions?.timeoutMs ?? MEMORY_TIMEOUT_MS;
  /** The context a host's hook is given: the turn's, with the subject its memory is kept under and that subject's user. */
  const hookContextOf = (context: MemoryHookContext, subject: MemorySubject): MemoryHookContext => ({
    ...context,
    subject,
    ...(subject.kind === 'user' ? { userId: subject.id } : {}),
  });
  /**
   * The policy the host answered for each subject of a session, by session id then by the subject's key, kept until
   * the session closes: a session id opened again for another user never reads the answer given for the first.
   */
  const sessionPolicies = new Map<string, Map<string, MemoryPolicy>>();
  /** How many times each session id has been closed: an answer asked for before a close is kept for nothing. */
  const sessionCloses = new Map<string, number>();
  /**
   * What each turn decided, from its first hook to its reply's write, by the context the turn's hooks share: a turn
   * of the default runtime and a one-shot call have one of their own, and a GMI session one for its turns, which run
   * one at a time. Two turns of one session that overlap never read each other's decision.
   */
  const turnDecisions = new WeakMap<MemoryHookContext, Promise<TurnPolicy>>();
  /**
   * The host's latest answer for each subject this process asked about, a failure among them: what the page tool and
   * the compile read, so an earlier answer one session keeps never outlasts a later one.
   */
  const latestAnswers = new Map<string, TurnPolicy>();
  /** How many times the host's policy has been asked for, in this process: each ask's place in that order. */
  let asks = 0;
  /**
   * For each subject, the place of the ask whose answer {@link latestAnswers} and {@link served} hold: an answer asked
   * for before it, which the host gives after it, decides its own turn and nothing for the subject.
   */
  const answeredAsk = new Map<string, number>();
  /** The sessions whose `off` policy has been said. */
  const offSaid = new Set<string>();
  /** For each scope a turn of this process served under a policy that keeps memory: the policy and the turn's context. */
  const served = new Map<string, { policy: MemoryPolicy; context: MemoryHookContext }>();

  /**
   * Asks the host's policy for the account a turn serves. A throw, a rejection, no answer in time or any answer but
   * one of the three policies is a failure: one `memory.hook_failed` line, and `'failed'`.
   */
  const askPolicy = async (context: MemoryHookContext): Promise<TurnPolicy> => {
    if (!memoryPolicy) return COMPILED;
    try {
      const answer = await within(Promise.resolve().then(() => memoryPolicy(context)), hookTimeoutMs);
      if (answer === TIMED_OUT) {
        memoryLog.warn('memory.hook_failed', { hook: 'memoryPolicy', type: 'TimeoutError', code: 'MEMORY_HOOK_TIMEOUT' });
        return 'failed';
      }
      if (!isMemoryPolicy(answer)) {
        memoryLog.warn('memory.hook_failed', { hook: 'memoryPolicy', type: 'TypeError', code: 'MEMORY_HOOK_MALFORMED' });
        return 'failed';
      }
      return answer;
    } catch (err) {
      memoryLog.warn('memory.hook_failed', { hook: 'memoryPolicy', ...errorFields(err) });
      return 'failed';
    }
  };
  /**
   * What one turn's memory does, decided once a turn: the answer kept for its session, else the host's answer now. A
   * valid answer of a session turn is kept for the session; a failure is kept for nothing, so the next turn asks again.
   */
  const decide = async (context: MemoryHookContext, subject: MemorySubject, scopeId: string): Promise<TurnPolicy> => {
    const hookContext = hookContextOf(context, subject);
    const session = context.call === 'session' ? context.sessionId : undefined;
    const closesBefore = session !== undefined ? (sessionCloses.get(session) ?? 0) : 0;
    const kept = session !== undefined ? sessionPolicies.get(session)?.get(scopeId) : undefined;
    const ask = kept === undefined ? ++asks : 0;
    const policy = kept ?? (await askPolicy(hookContext));
    // The subject's answer is the one asked for last, whenever the host gives it: an answer to an earlier ask that
    // comes after a later one's decides this turn alone.
    const latest = kept === undefined && ask > (answeredAsk.get(scopeId) ?? 0);
    if (latest) {
      answeredAsk.set(scopeId, ask);
      latestAnswers.set(scopeId, policy);
    }
    if (policy === 'failed') {
      // A failed answer is the latest: no compile reads an earlier permission for the subject.
      if (latest) served.delete(scopeId);
      return policy;
    }
    // Kept only where a hook reads it later: the session's answer for its next turns, the scope's for its compile. An
    // answer that came after its session closed is not kept for the session's next opening.
    if (memoryPolicy && session !== undefined && (sessionCloses.get(session) ?? 0) === closesBefore) {
      const ofSession = sessionPolicies.get(session) ?? new Map<string, MemoryPolicy>();
      ofSession.set(scopeId, policy);
      sessionPolicies.set(session, ofSession);
    }
    // The compile reads the host's latest answer for the subject: an `off` answer takes back an earlier permission,
    // and neither an answer a session keeps from before nor one to an earlier ask is a new one.
    if ((memoryPolicy || screen) && latest) {
      if (policy.longTerm === 'off') served.delete(scopeId);
      else served.set(scopeId, { policy, context: hookContext });
    }
    return policy;
  };
  /**
   * The decision of the turn a hook call belongs to. A turn's recall opens it; the write of its reply closes it, so
   * the whole turn recalls and files under one answer, and a hook that failed is not asked a second time in the turn.
   */
  const turnPolicyOf = (
    context: MemoryHookContext,
    subject: MemorySubject,
    scopeId: string,
    at: 'recall' | 'user' | 'assistant',
  ): Promise<TurnPolicy> => {
    const open = at === 'recall' ? undefined : turnDecisions.get(context);
    const decision = open ?? decide(context, subject, scopeId);
    if (at === 'assistant') turnDecisions.delete(context);
    else turnDecisions.set(context, decision);
    return decision;
  };
  /**
   * Whether the page tool serves a subject its own pages: always without a policy hook; under one, only when the
   * host's latest answer for the subject keeps memory. An `off` answer, a failed hook and a subject this process has
   * not asked about read the operator's pages alone.
   */
  const ownPagesServed = (scopeId: string): boolean => {
    if (!memoryPolicy) return true;
    const answer = latestAnswers.get(scopeId);
    return answer !== undefined && answer !== 'failed' && answer.longTerm !== 'off';
  };
  /**
   * `text` through the host's screen hook: the text to use, null when the hook drops it, or {@link SCREEN_FAILED}
   * (with one `memory.hook_failed` line) when it throws, rejects, does not answer in time or answers anything else.
   */
  const screened = async (
    text: string,
    context: MemoryHookContext,
    stage: 'file' | 'compile',
  ): Promise<string | null | typeof SCREEN_FAILED> => {
    if (!screen) return text;
    try {
      const answer = await within(Promise.resolve().then(() => screen(text, { ...context, stage })), hookTimeoutMs);
      if (answer === TIMED_OUT) {
        memoryLog.warn('memory.hook_failed', { hook: 'screen', type: 'TimeoutError', code: 'MEMORY_HOOK_TIMEOUT' });
        return SCREEN_FAILED;
      }
      if (answer === null) return null;
      if (typeof answer !== 'string') {
        memoryLog.warn('memory.hook_failed', { hook: 'screen', type: 'TypeError', code: 'MEMORY_HOOK_MALFORMED' });
        return SCREEN_FAILED;
      }
      return answer;
    } catch (err) {
      memoryLog.warn('memory.hook_failed', { hook: 'screen', ...errorFields(err) });
      return SCREEN_FAILED;
    }
  };
  /**
   * Files one side of a turn under its subject's key, when the account's policy keeps memory and the screen hook
   * lets the text through. Each write that is not made says why in one `memory.write_refused` line, except under an
   * `off` policy, the host's standing choice for the account, which is said once a session.
   */
  const fileTurn = async (role: Speaker, text: string, context: MemoryHookContext): Promise<void> => {
    const subject = turnSubjectOf(context);
    if (!subject) return;
    // An id no key can be built from rejects the write: the runtime logs the hook's failure and the turn goes on.
    const scopeId = conversationScopeKey(agentId, subject);
    const policy = await turnPolicyOf(context, subject, scopeId, role);
    if (policy === 'failed') {
      memoryLog.warn('memory.write_refused', { reason: 'policy_failed' });
      return;
    }
    if (policy.longTerm === 'off') {
      if (context.call !== 'session' || !offSaid.has(context.sessionId)) {
        if (context.call === 'session') offSaid.add(context.sessionId);
        memoryLog.warn('memory.write_refused', { reason: 'policy_off' });
      }
      return;
    }
    const filed = await screened(text, hookContextOf(context, subject), 'file');
    if (filed === SCREEN_FAILED) {
      memoryLog.warn('memory.write_refused', { reason: 'screen_failed' });
      return;
    }
    if (filed === null || filed === '') {
      memoryLog.warn('memory.write_refused', { reason: 'screened' });
      return;
    }
    written.add(scopeId);
    // The user's message and the reply alike go under the subject's key. Who spoke goes in the trace's metadata:
    // outside its text and its tags, which full-text search reads.
    await memory.remember(filed, {
      type: 'episodic',
      scope: 'conversation',
      scopeId,
      metadata: {
        [SPEAKER_METADATA_KEY]: role,
        subject: { kind: subject.kind, id: subject.id },
        ...(subject.kind === 'user' ? { turnUserId: subject.id } : {}),
      },
    });
  };
  /**
   * Asked before a scope's traces are compiled. Under a policy hook, a scope no turn of this process was served for,
   * or whose account keeps raw traces only, is not compiled. Under a screen hook, a scope with no turn of this process
   * has no context to screen with, and is not compiled; otherwise each trace's text goes through the hook again: what
   * it returns is what is compiled, a trace it drops is left out, and a failure stops the scope's compile. The
   * account's latest answer is read again once the screen has answered, so an `off` answer given meanwhile stops the
   * compile.
   */
  const beforeScopeCompile: NonNullable<AttachedWiki['beforeScopeCompile']> = async (scopeId, traces) => {
    const turn = served.get(scopeId);
    if (memoryPolicy && turn?.policy.longTerm !== 'compiled') return { skip: 'policy_raw' };
    if (!screen) return { traces };
    if (!turn) return { skip: 'screen_failed' };
    const kept: typeof traces = [];
    let dropped = false;
    for (const trace of traces) {
      const text = await screened(trace.content, turn.context, 'compile');
      if (text === SCREEN_FAILED) return { skip: 'screen_failed' };
      if (text === null || text === '') {
        dropped = true;
        continue;
      }
      kept.push(text === trace.content ? trace : { ...trace, content: text });
    }
    // The host may have answered again while the screen ran: the compile goes on only under the latest answer.
    if (memoryPolicy && served.get(scopeId)?.policy.longTerm !== 'compiled') return { skip: 'policy_raw' };
    if (dropped) memoryLog.warn('memory.write_refused', { reason: 'screened' });
    return { traces: kept };
  };

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
      // The whole write, its policy and its screening with it, is what close() waits for.
      return awaitedOnClose(fileTurn(role, text, context));
    },
    getContext: async (text, options) => {
      // Two reads, each of one key, by equality: the turn's own subject, and the operator's pages. Nothing a caller
      // passes widens them. A turn with no subject, one whose id no key can be built from, and one whose account
      // keeps no memory (or whose policy hook failed) read the operator's pages alone.
      const context = options?.context;
      const subject = context ? turnSubjectOf(context) : undefined;
      let own: ScoredTrace[] = [];
      if (context && subject) {
        let scopeId: string | undefined;
        try {
          scopeId = conversationScopeKey(agentId, subject);
        } catch (err) {
          // An id no key can be built from has no memory to read: the turn goes on with the operator's pages.
          memoryLog.warn('memory.hook_failed', { hook: 'getContext', ...errorFields(err) });
        }
        if (scopeId !== undefined) {
          const policy = await turnPolicyOf(context, subject, scopeId, 'recall');
          if (policy !== 'failed' && policy.longTerm !== 'off') {
            own = await memory.recall(text, { scope: 'conversation', scopeId, limit: RECALL_LIMIT });
          }
        }
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
  // refusal skips that subject's compile, and its watermark stays where it was), and its usage ledger. A compile
  // target the host named takes them instead: that provider and model alone, with no fallback and no router, so a
  // compile's text goes nowhere else; the agent's own key and base URL go with it only to the agent's own provider.
  const target = typeof compile === 'object' && compile !== null ? compile : undefined;
  // A target that names a model alone, whose `provider:` prefix names another provider than the agent's, does not take
  // the agent's provider. The agent's key and base URL go with the compile only when its call resolves to the
  // provider they were set for, whether the agent names it or only its model does.
  const compileProvider =
    target === undefined
      ? rest.provider
      : (target.provider ??
        (rest.provider !== undefined && target.model !== undefined && modelNamesAnotherProvider(rest.provider, target.model)
          ? undefined
          : rest.provider));
  // A target that names a provider alone runs on that provider's default model, unless it is the agent's own provider:
  // the agent's model belongs to the agent's provider.
  const agentProvider = (() => {
    if (rest.provider !== undefined) return rest.provider;
    if (rest.model === undefined) return undefined;
    try {
      return resolveModelOption({ model: rest.model }, 'text').providerId;
    } catch {
      return undefined;
    }
  })();
  const compileModel =
    target?.model ?? (target?.provider === undefined || target.provider === agentProvider ? rest.model : undefined);
  const agentCredentialsGo =
    target === undefined ||
    credentialsGoWith({ provider: rest.provider, model: rest.model }, { provider: compileProvider, model: compileModel });
  const llm = async (prompt: string): Promise<string> =>
    (
      await generateText({
        provider: compileProvider,
        model: compileModel,
        prompt,
        maxTokens: rest.maxTokens ?? rest.controls?.maxTotalTokens,
        apiKey: target?.apiKey ?? (agentCredentialsGo ? rest.apiKey : undefined),
        baseUrl: target?.baseUrl ?? (agentCredentialsGo ? rest.baseUrl : undefined),
        ...(target
          ? { fallbackProviders: [] }
          : {
              fallbackProviders: rest.fallbackProviders,
              onFallback: rest.onFallback,
              router: rest.router,
              hostPolicy: rest.hostPolicy,
              routerParams: rest.routerParams,
              policyTier: rest.policyTier,
            }),
        ...(budget ? { budget } : {}),
        ...(rest.accountIdOf ? { accountIdOf: rest.accountIdOf } : {}),
        usageLedger: { ...(ledger ?? {}), source: SOULED_AGENT_COMPILE_SOURCE },
      })
    ).text;

  const chunker = new SemanticChunker();
  const priorTools = rest.tools;
  const memoryDir = loaded.memoryDir;
  const { tools: augmentedTools } = await closingOnThrow(() => attachMemoryWiki({
    memory,
    memoryDir,
    agentId,
    llm,
    chunk: (t) => chunker.chunk(t).map((c) => ({ text: c.text })),
    tools: Array.isArray(priorTools) ? [...priorTools] : undefined,
    // The page tool reads the key the observer writes, and serves a subject's own pages only under a policy that
    // keeps memory.
    subjectOf,
    ownPagesServed,
    // A subject whose compile the budget refuses is skipped: its traces wait, and the other subjects compile.
    compileSkipReasonOf: (error) => (isBudgetRefusal(error) ? 'budget' : undefined),
    ...(memoryPolicy || screen ? { beforeScopeCompile } : {}),
    // No compile at all: raw traces only, and no page is ever written.
    ...(compile === false ? { compile: false as const } : {}),
  }));
  if (compile === false) memoryLog.warn('memory.compile_skipped', { reason: 'compile_off' });

  // attachMemoryWiki appends read_memory_page to an array. Use the augmented
  // array when tools were an array (or absent); pass map/registry inputs through
  // unchanged (the rare non-array AdaptableToolInput shapes).
  const tools = (
    priorTools && !Array.isArray(priorTools) ? priorTools : augmentedTools
  ) as AgentOptions['tools'];

  const built = (await closingOnThrow(() =>
    agent({ ...rest, ...(budget ? { budget } : {}), memoryProvider: provider, tools }),
  )) as SouledAgent;

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
      // A closed session keeps nothing of its account's policy: its next opening asks again.
      const closeSession = (session as { close?: (...args: unknown[]) => Promise<unknown> }).close?.bind(session);
      if (closeSession) {
        (session as { close: (...args: unknown[]) => Promise<unknown> }).close = (...args: unknown[]) => {
          sessionPolicies.delete(session.id);
          offSaid.delete(session.id);
          sessionCloses.set(session.id, (sessionCloses.get(session.id) ?? 0) + 1);
          return closeSession(...args);
        };
      }
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
        // The subjects this agent's turns wrote to; a trace stored another way waits for memory.compileWiki(). With
        // `compile: false` no wiki is attached, and this compiles nothing.
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
