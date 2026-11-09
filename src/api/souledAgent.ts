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
import { DEFAULT_MEMORY_TOKEN_BUDGET } from './runtime/memoryProviderHooks.js';
import { messageOf } from './runtime/memoryObserveFailures.js';

/** Characters a token is estimated at, as `estimateTokens` counts them. */
const CHARS_PER_TOKEN = 4;

/**
 * Join recalled traces, in rank order, into a recall block that fits `tokenBudget` (estimated with
 * `estimateTokens`). Whole traces are added while they fit; when the first alone is larger, it is cut at the last
 * word boundary that fits (mid-word only when it has none), so a matched trace never yields an empty block. A
 * budget that is not a positive number is the hooks' default.
 *
 * @param contents - The traces' text, best first.
 * @param tokenBudget - The block's token ceiling.
 * @returns The block, or '' when nothing was recalled.
 */
function recallWithinBudget(contents: readonly string[], tokenBudget: number): string {
  const budget = Number.isFinite(tokenBudget) && tokenBudget > 0 ? Math.floor(tokenBudget) : DEFAULT_MEMORY_TOKEN_BUDGET;
  const texts = contents.filter((c) => c.length > 0);
  if (texts.length === 0) return '';
  let block = '';
  for (const text of texts) {
    const next = block ? `${block}\n${text}` : text;
    if (estimateTokens(next) > budget) break;
    block = next;
  }
  if (block) return block;
  const maxChars = Math.max(1, budget * CHARS_PER_TOKEN);
  const head = texts[0].slice(0, maxChars);
  // Cut back to the last whitespace when the cut falls inside a word.
  const cut = /\s/.test(texts[0].charAt(maxChars)) ? head : head.replace(/\s+\S*$/, '');
  return cut.trimEnd() || head;
}

/** Options for {@link souledAgent}. Identical to {@link AgentOptions}, but `soul` is required. */
export interface SouledAgentOptions extends AgentOptions {
  soul: NonNullable<AgentOptions['soul']>;
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
 * {@link agent}.
 *
 * @param opts - Agent options with a required `soul`.
 * @returns A fully-wired {@link Agent}.
 */
export async function souledAgent(opts: SouledAgentOptions): Promise<SouledAgent> {
  const loaded = loadSoulFromOption(opts.soul);
  if (!loaded) {
    // The soul failed to load, and loadSoulFromOption has warned: a plain agent without it, which loads it no
    // second time and so does not warn again.
    return agent({ ...opts, soul: undefined });
  }
  if (!loaded.memoryDir) {
    // Inline soul: no workspace dir → no wiki. Plain agent.
    return agent(opts);
  }

  const agentId = loaded.frontmatter.agentId ?? opts.name ?? 'agent';

  // The markdown memory/ is source of truth; the sqlite is the rebuildable index.
  const storeDir = path.join(loaded.memoryDir, '.store');
  await fs.mkdir(storeDir, { recursive: true });
  const memory = await Memory.createSqlite(path.join(storeDir, 'memory.sqlite'), {
    graph: true,
    selfImprove: true,
  });

  // Adapt the Memory facade directly to the provider contract. AgentMemory's own
  // getContext/observe signatures don't match AgentMemoryProvider, so wrap the
  // facade's remember/recall here.
  const provider: AgentMemoryProvider = {
    observe: async (_role, text) => {
      await memory.remember(text, { type: 'episodic', scope: 'persona', scopeId: agentId });
    },
    getContext: async (text, options) => {
      const scored = await memory.recall(text, { limit: 8 });
      const contextText = recallWithinBudget(
        scored.map((s) => s.trace.content),
        options?.tokenBudget ?? DEFAULT_MEMORY_TOKEN_BUDGET,
      );
      return contextText ? { contextText } : null;
    },
  };

  const llm = async (prompt: string): Promise<string> =>
    (
      await generateText({
        provider: opts.provider,
        model: opts.model,
        prompt,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
      })
    ).text;

  const chunker = new SemanticChunker();
  const priorTools = opts.tools;
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

  const built = agent({ ...opts, memoryProvider: provider, tools }) as SouledAgent;

  // On teardown: fold the session's conversation into the wiki, then close the
  // backing store. The compile is best-effort (a failed LLM merge must never
  // block teardown) and a failure is logged; closing prevents leaked SQLite
  // handles in long-lived hosts.
  const originalClose = built.close.bind(built);
  built.close = async () => {
    try {
      await memory.compileWiki({ reason: 'session-end' });
    } catch (err) {
      // The watermark moves only past compiled traces, so the next compile takes these up again.
      console.warn(
        `[agentos] souledAgent: the memory wiki compile on close failed (${messageOf(err)}); ` +
          'the conversation traces stay in the store for the next compile.',
        err,
      );
    }
    try {
      await originalClose();
    } finally {
      await memory.close();
    }
  };

  // Expose the store so callers can fold conversation into the wiki mid-session
  // (`await agent.memory.compileWiki()`) without waiting for close().
  built.memory = memory;

  return built;
}
