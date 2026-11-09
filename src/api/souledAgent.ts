/**
 * @fileoverview souledAgent — first-class factory for a soul-file agent whose
 * long-term memory is the markdown `memory/` wiki.
 *
 * Composes existing, tested pieces:
 * - {@link loadSoulFromOption} resolves the soul and its `memory/` dir.
 * - {@link Memory.createSqlite} opens the single backing store (the rebuildable
 *   index; the markdown stays source of truth).
 * - {@link attachMemoryWiki} wires the wiki write-back loop + the
 *   `read_memory_page` tool + the boot index over the same facade.
 * - {@link agent} runs it; its `buildSystemPrompt` already injects `index.md`.
 *
 * One `Memory` facade is both the agent's live memory and the wiki store, so the
 * conversation the agent observes lands where the wiki compiler reads it.
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
} from './agent.js';
import { generateText } from './generateText.js';
import { Memory } from '../cognition/memory/io/facade/Memory.js';
import { attachMemoryWiki } from '../cognition/memory/io/attachMemoryWiki.js';
import { SemanticChunker } from '../cognition/rag/chunking/SemanticChunker.js';
import { estimateTokens } from '../core/utils/text-utils.js';
import { formatMemoryAge } from '../cognition/memory/core/prompt/MemoryFormatters.js';
import { DEFAULT_MEMORY_TOKEN_BUDGET } from './runtime/memoryProviderHooks.js';
import { messageOf } from './runtime/memoryObserveFailures.js';
import { asSpendBudget } from './runtime/spendBudget.js';
import type { AgentOSUsageLedgerOptions } from './runtime/usageLedger.js';

/** Characters a token is estimated at, as `estimateTokens` counts them. */
const CHARS_PER_TOKEN = 4;

/** How long `close()` waits for the memory writes of the agent's turns before it compiles, unless an option sets it. */
export const DEFAULT_PENDING_WRITES_TIMEOUT_MS = 5_000;

/** The usage ledger's source for the model calls of the wiki compile a souled agent runs. */
export const SOULED_AGENT_COMPILE_SOURCE = 'souledAgent.compileWiki';

/** The tag a trace the observer stores carries for who spoke it: `speaker:user` or `speaker:assistant`. */
const SPEAKER_TAG = 'speaker:';

/** The tag a wiki page chunk carries for its page: `page:<id>`. */
const PAGE_TAG = 'page:';

/** One recalled trace: the label that opens its line, then its text. */
interface RecallLine {
  /** `[user, 26 days ago, 2026-10-14] `: who spoke it and when it was stored; ends with a space. */
  prefix: string;
  content: string;
}

/**
 * The label a recalled trace's line opens with: who spoke it (`user` or `assistant`, from the tag the observer gave it,
 * or `note` and the page id for a chunk of a wiki page) and when it was stored, in the memory block's wording
 * (`26 days ago, 2026-10-14`). A trace with no speaker, such as one stored before speakers were recorded, has the date
 * alone.
 */
function recallPrefix(trace: { tags: readonly string[]; createdAt: number }, now: number): string {
  const when = formatMemoryAge(trace.createdAt, now);
  const pageTag = trace.tags.includes('wiki') ? trace.tags.find((tag) => tag.startsWith(PAGE_TAG)) : undefined;
  const speakerTag = trace.tags.find((tag) => tag.startsWith(SPEAKER_TAG));
  const speaker = pageTag ? `note ${pageTag.slice(PAGE_TAG.length)}` : speakerTag?.slice(SPEAKER_TAG.length);
  return speaker ? `[${speaker}, ${when}] ` : `[${when}] `;
}

/**
 * Join recalled traces, in rank order, one line each (its label, then its text), into a recall block that fits
 * `tokenBudget` (estimated with `estimateTokens`). Whole lines are added while they fit; when the first alone is
 * larger, its text is cut at the last word boundary that fits beside its label (mid-word only when it has none, and
 * never inside a character a surrogate pair encodes), so a matched trace never yields an empty block under a positive
 * budget; a label longer than the whole budget is dropped. A budget of 0 or less asks for no recall, and one that is
 * not a number is the hooks' default.
 *
 * @param lines - The traces' labels and text, best first.
 * @param tokenBudget - The block's token ceiling.
 * @returns The block, or '' when nothing was recalled or the budget is 0 or less.
 */
function recallWithinBudget(lines: readonly RecallLine[], tokenBudget: number): string {
  if (tokenBudget <= 0) return '';
  const budget = Number.isNaN(tokenBudget) ? DEFAULT_MEMORY_TOKEN_BUDGET : Math.floor(tokenBudget);
  const recalled = lines.filter((line) => line.content.length > 0);
  if (recalled.length === 0) return '';
  let block = '';
  for (const line of recalled) {
    const text = `${line.prefix}${line.content}`;
    const next = block ? `${block}\n${text}` : text;
    if (estimateTokens(next) > budget) break;
    block = next;
  }
  if (block) return block;
  const { content } = recalled[0];
  const room = budget * CHARS_PER_TOKEN - recalled[0].prefix.length;
  const prefix = room >= 1 ? recalled[0].prefix : '';
  const maxChars = Math.max(1, room >= 1 ? room : budget * CHARS_PER_TOKEN);
  const head = codePointPrefix(content, maxChars);
  // Cut back to the last whitespace when the cut falls inside a word.
  const cut = /\s/.test(content.charAt(maxChars)) ? head : head.replace(/\s+\S*$/, '');
  return prefix + (cut.trimEnd() || head);
}

/**
 * Wait for `pending` to empty, up to `timeoutMs`; a write added while waiting is waited for too.
 *
 * @returns How many writes are still pending when the wait ends.
 */
async function waitForWrites(pending: Set<Promise<unknown>>, timeoutMs: number): Promise<number> {
  if (pending.size === 0 || timeoutMs <= 0) return pending.size;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), timeoutMs);
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

/** Options for {@link souledAgent}: those of {@link AgentOptions}, with `soul` required. */
export interface SouledAgentOptions extends AgentOptions {
  soul: NonNullable<AgentOptions['soul']>;
  /**
   * How long `close()` waits, in milliseconds, for the memory writes of the agent's turns before it compiles the wiki.
   * Default {@link DEFAULT_PENDING_WRITES_TIMEOUT_MS} (5 seconds); 0 waits for none. When the wait ends with writes
   * still pending, the compile takes what is stored and one `console.warn` line gives their number.
   */
  pendingWritesTimeoutMs?: number;
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
 * Each stored turn carries who spoke it, as a `speaker:user` or `speaker:assistant` tag, and each recalled trace is
 * rendered with its speaker and its date. The wiki compile's model calls go on the agent's route with its fallback
 * settings, are checked against and charged to its spend budget, and are written to its usage ledger under the source
 * {@link SOULED_AGENT_COMPILE_SOURCE}.
 *
 * `close()` first closes the agent (running turns end and sessions shut down), then waits for the memory writes of
 * its turns (see {@link SouledAgentOptions.pendingWritesTimeoutMs}), then compiles the wiki, then closes the store.
 *
 * @param opts - Agent options with a required `soul`.
 * @returns A fully-wired {@link Agent}.
 */
export async function souledAgent(opts: SouledAgentOptions): Promise<SouledAgent> {
  const { pendingWritesTimeoutMs, ...rest } = opts;
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
  const waitMs =
    typeof pendingWritesTimeoutMs === 'number' && pendingWritesTimeoutMs >= 0
      ? pendingWritesTimeoutMs
      : DEFAULT_PENDING_WRITES_TIMEOUT_MS;
  // One budget for the agent and the compile, so both draw on the same total.
  const budget = asSpendBudget(rest.budget);
  const ledger = (rest.observability?.usageLedger as AgentOSUsageLedgerOptions | undefined) ?? rest.usageLedger;

  const agentId = loaded.frontmatter.agentId ?? opts.name ?? 'agent';

  // The markdown memory/ is source of truth; the sqlite is the rebuildable index.
  const storeDir = path.join(loaded.memoryDir, '.store');
  await fs.mkdir(storeDir, { recursive: true });
  const memory = await Memory.createSqlite(path.join(storeDir, 'memory.sqlite'), {
    graph: true,
    selfImprove: true,
  });

  // The writes the observer has started and that have not settled: close() waits for them before it compiles. The
  // turn itself never waits for them.
  const pendingWrites = new Set<Promise<unknown>>();

  // Adapt the Memory facade directly to the provider contract. AgentMemory's own
  // getContext/observe signatures don't match AgentMemoryProvider, so wrap the
  // facade's remember/recall here.
  const provider: AgentMemoryProvider = {
    observe: (role, text) => {
      // Who spoke goes on the trace as a tag, outside its text.
      const write = memory.remember(text, {
        type: 'episodic',
        scope: 'persona',
        scopeId: agentId,
        tags: [`${SPEAKER_TAG}${role}`],
      });
      pendingWrites.add(write);
      const settle = () => {
        pendingWrites.delete(write);
      };
      void write.then(settle, settle);
      return write.then(() => undefined);
    },
    getContext: async (text, options) => {
      const scored = await memory.recall(text, { limit: 8 });
      const now = Date.now();
      const contextText = recallWithinBudget(
        scored.map((s) => ({ prefix: recallPrefix(s.trace, now), content: s.trace.content })),
        options?.tokenBudget ?? DEFAULT_MEMORY_TOKEN_BUDGET,
      );
      return contextText ? { contextText } : null;
    },
  };

  // The compile's model calls: the agent's route and fallback settings, its budget (checked before each call and
  // charged after it; a refusal fails the compile, and the watermark stays where it was), and its usage ledger.
  const llm = async (prompt: string): Promise<string> =>
    (
      await generateText({
        provider: rest.provider,
        model: rest.model,
        prompt,
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
  });

  // attachMemoryWiki appends read_memory_page to an array. Use the augmented
  // array when tools were an array (or absent); pass map/registry inputs through
  // unchanged (the rare non-array AdaptableToolInput shapes).
  const tools = (
    priorTools && !Array.isArray(priorTools) ? priorTools : augmentedTools
  ) as AgentOptions['tools'];

  const built = agent({ ...rest, ...(budget ? { budget } : {}), memoryProvider: provider, tools }) as SouledAgent;

  // On teardown: close the agent, so its running turns end and their sessions shut down; wait for the memory writes
  // of those turns; fold the conversation into the wiki; then close the backing store. The compile is best-effort (a
  // failed LLM merge must never block teardown) and a failure is logged; closing prevents leaked SQLite handles in
  // long-lived hosts. An error from the agent's own close is thrown once the store is closed.
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
      const stillPending = await waitForWrites(pendingWrites, waitMs);
      if (stillPending > 0) {
        console.warn(
          `[agentos] souledAgent: close() waited ${waitMs} ms for the memory writes of its turns; ` +
            `writes still pending: ${stillPending}. The wiki compile takes what is stored, and the pending writes may ` +
            'not be stored once the store closes.',
        );
      }
      try {
        await memory.compileWiki({ reason: 'session-end' });
      } catch (err) {
        // The watermark moves only past compiled traces, so the next compile takes these up again.
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
