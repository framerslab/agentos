/**
 * @file memoryProviderHooks.ts
 * Shared helper that wires {@link AgentMemoryProvider} recall into
 * {@link GenerateTextOptions}.
 *
 * Used by all four agent call paths (`Agent.generate`, `Agent.stream`,
 * `AgentSession.send`, `AgentSession.stream`): `memory.getContext` runs once
 * for the call, at its first model call, and the same recall goes into every
 * model call of it (its tool steps, its validation attempts and its fallback
 * legs). `observe` is the caller's: `agent()` observes after the turn is
 * answered. A hook that fails or times out is a `memory.hook_failed` event.
 * Pure function: returns a new options object without mutating inputs.
 *
 * @module api/runtime/memoryProviderHooks
 */
import type { GenerateTextOptions, GenerationHookContext } from '../generateText.js';
import type { AgentMemoryProvider, MemoryHookContext } from '../agent.js';
import { errorFields } from '../../core/logging/events.js';
import { memoryLog } from '../../cognition/memory/log.js';

/** Timeout applied to memory.getContext calls to prevent hangs. */
export const MEMORY_TIMEOUT_MS = 5000;

/** Default token budget forwarded to memory.getContext. */
export const DEFAULT_MEMORY_TOKEN_BUDGET = 2000;

/**
 * Optional caller overrides for the memory-hook budget guards.
 * Both fields default to the module constants when omitted, preserving the
 * historical behavior for existing callers.
 */
export interface MemoryProviderHookOptions {
  /**
   * Timeout (ms) applied to each `getContext` call. When the provider loses
   * the race the turn ships without memory context and a `memory.hook_failed`
   * event is written.
   * Defaults to {@link MEMORY_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  /**
   * Token budget forwarded to `getContext` as the recall ceiling.
   * Defaults to {@link DEFAULT_MEMORY_TOKEN_BUDGET}.
   */
  tokenBudget?: number;
}

/** One turn as the memory hooks see it: the user's text and who the turn serves. */
export interface MemoryTurn {
  userText: string;
  context: MemoryHookContext;
}

/** What a provider's `getContext` resolves to. */
type Recalled = Awaited<ReturnType<NonNullable<AgentMemoryProvider['getContext']>>>;

/**
 * `provider.getContext` for one turn, within the timeout. Null when the provider has no `getContext`, returns
 * nothing, fails or times out; a failure or a timeout writes one `memory.hook_failed` line and the turn goes on
 * without recall.
 *
 * @param provider - The memory provider.
 * @param turn - The turn's text and who it serves.
 * @param hookOptions - The timeout and the token budget; the module defaults when omitted.
 */
export async function recallForTurn(
  provider: AgentMemoryProvider,
  turn: MemoryTurn,
  hookOptions?: MemoryProviderHookOptions,
): Promise<Recalled> {
  if (!provider.getContext) return null;
  const timeoutMs = hookOptions?.timeoutMs ?? MEMORY_TIMEOUT_MS;
  const tokenBudget = hookOptions?.tokenBudget ?? DEFAULT_MEMORY_TOKEN_BUDGET;
  const TIMED_OUT = Symbol('timed out');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      provider.getContext(turn.userText, { tokenBudget, context: turn.context }),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (result === TIMED_OUT) {
      // The provider lost the race: the turn goes without the recall block, whatever the provider logs later.
      memoryLog.warn('memory.hook_failed', { hook: 'getContext', type: 'TimeoutError', code: 'MEMORY_HOOK_TIMEOUT' });
      return null;
    }
    return result ?? null;
  } catch (error) {
    memoryLog.warn('memory.hook_failed', { hook: 'getContext', ...errorFields(error) });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Apply a memory provider's recall to an options object.
 *
 * @param baseOpts - The GenerateTextOptions object to wrap.
 * @param provider - Memory provider. When undefined or without `getContext`,
 *   returns baseOpts unchanged.
 * @param turn - The user input text for this turn, passed to getContext, and
 *   who the turn serves.
 * @param hookOptions - Optional overrides for the getContext timeout and
 *   token budget. Defaults to {@link MEMORY_TIMEOUT_MS} and
 *   {@link DEFAULT_MEMORY_TOKEN_BUDGET} when omitted.
 * @returns A new options object whose onBeforeGeneration recalls once for the
 *   call and inserts the recall on every model call. An existing
 *   onBeforeGeneration is chained AFTER the memory wiring so the caller's hook
 *   sees the memory-augmented context. onAfterGeneration stays the caller's.
 */
export function applyMemoryProvider(
  baseOpts: Partial<GenerateTextOptions>,
  provider: AgentMemoryProvider | undefined,
  turn: MemoryTurn,
  hookOptions?: MemoryProviderHookOptions,
): Partial<GenerateTextOptions> {
  if (!provider?.getContext) return baseOpts;
  const userOnBefore = baseOpts.onBeforeGeneration;
  // One recall for the call: its tool steps, its validation attempts and its fallback legs send the same block.
  let recalled: Promise<Recalled> | undefined;

  const wrappedOnBefore: NonNullable<GenerateTextOptions['onBeforeGeneration']> = async (
    ctx: GenerationHookContext,
  ): Promise<GenerationHookContext | void> => {
    recalled ??= recallForTurn(provider, turn, hookOptions);
    const memCtx = await recalled;
    let nextCtx: GenerationHookContext = ctx;
    if (memCtx?.contextText) {
      // Insert AFTER the leading system message(s), never at index 0.
      // Providers derive the prompt-cache key from the request prefix
      // in order, so a per-turn recall block prepended at the front
      // rewrites the prefix on every call — a cache-marked system
      // prompt gets WRITTEN fresh each turn (cache-write premium) but
      // never read back (hit rate 0). Placed after the caller's system
      // content, recall keeps system authority while the cacheable
      // prefix stays byte-stable across turns.
      let insertAt = 0;
      while (insertAt < ctx.messages.length && ctx.messages[insertAt].role === 'system') {
        insertAt += 1;
      }
      nextCtx = {
        ...ctx,
        messages: [
          ...ctx.messages.slice(0, insertAt),
          { role: 'system' as const, content: memCtx.contextText },
          ...ctx.messages.slice(insertAt),
        ],
      };
    }
    if (userOnBefore) {
      const userResult = await userOnBefore(nextCtx);
      return userResult ?? nextCtx;
    }
    return nextCtx;
  };

  return { ...baseOpts, onBeforeGeneration: wrappedOnBefore };
}
