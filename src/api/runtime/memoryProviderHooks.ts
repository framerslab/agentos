/**
 * @file memoryProviderHooks.ts
 * Shared helper that wires {@link AgentMemoryProvider} recall into
 * {@link GenerateTextOptions}.
 *
 * Used by all four agent call paths (`Agent.generate`, `Agent.stream`,
 * `AgentSession.send`, `AgentSession.stream`): `memory.getContext` runs once
 * for the call, at its first model call, and the same recall goes into every
 * model call of it (its tool steps, its validation attempts and its fallback
 * legs), as a data block in a user-role message right before the turn's own
 * user message. `observe` is the caller's: `agent()` observes after the turn
 * is answered. A hook that fails or times out is a `memory.hook_failed` event.
 * Pure function: returns a new options object without mutating inputs.
 *
 * @module api/runtime/memoryProviderHooks
 */
import type { GenerateTextOptions, GenerationHookContext } from '../generateText.js';
import type { AgentMemoryProvider, MemoryHookContext } from '../agent.js';
import { listedErrorFields } from '../../core/logging/events.js';
import { memoryLog } from '../../cognition/memory/log.js';
import { memoryItemsOf, renderMemoryRecallBlock } from './memoryDataBlock.js';

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
   * Token budget forwarded to `getContext` as the ceiling of the recalled
   * text. The `<memory_recall>` block it is sent in adds its tags, its note,
   * each record's keys and the escapes of `<`, `>` and `&` beyond it.
   * Defaults to {@link DEFAULT_MEMORY_TOKEN_BUDGET}.
   */
  tokenBudget?: number;
}

/** One turn as the memory hooks see it: the user's text and who the turn serves. */
export interface MemoryTurn {
  userText: string;
  context: MemoryHookContext;
}

/** The text of the turn a request sends: its `prompt`, else its last user message. */
export function sentTurnText(ctx: GenerationHookContext): string | undefined {
  if (typeof ctx.prompt === 'string') return ctx.prompt;
  for (let i = ctx.messages.length - 1; i >= 0; i -= 1) {
    const message = ctx.messages[i];
    if (message.role !== 'user') continue;
    const content: unknown = message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return undefined;
    return content
      .filter((p): p is { type: 'text'; text: string } => (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return undefined;
}

/** What a provider's `getContext` resolves to. */
type Recalled = Awaited<ReturnType<NonNullable<AgentMemoryProvider['getContext']>>>;

/** True for an object whose `contextText` is a string or absent and whose `items` is an array or absent. */
function isRecallShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { contextText, items } = value as { contextText?: unknown; items?: unknown };
  return (contextText === undefined || contextText === null || typeof contextText === 'string')
    && (items === undefined || items === null || Array.isArray(items));
}

/**
 * `provider.getContext` for one turn, within the timeout. Null when the provider has no `getContext`, returns
 * nothing, fails, times out or resolves a value that is not a recall (its `items` not a list, its `contextText` not a
 * string); a failure, a timeout or a malformed recall writes one `memory.hook_failed` line and the turn goes on
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
    if (result !== null && result !== undefined && !isRecallShape(result)) {
      // A JavaScript provider can resolve anything: a recall that is not the shape getContext returns fails as a hook.
      memoryLog.warn('memory.hook_failed', { hook: 'getContext', type: 'TypeError', code: 'MEMORY_HOOK_MALFORMED' });
      return null;
    }
    return result ?? null;
  } catch (error) {
    memoryLog.warn('memory.hook_failed', { hook: 'getContext', ...listedErrorFields(error) });
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
  // A call with guards sends its turn as the input stage left it, so recall reads that text: never what a guard took out.
  const guarded = baseOpts.guards !== undefined;
  // One recall for the call: its tool steps, its validation attempts and its fallback legs send the same block.
  let recalled: Promise<Recalled> | undefined;
  /** The rendered block, once there is one. */
  let block: string | undefined;
  /** How far the turn's own user message sits from the end of the leading system messages, read at the first call. */
  let turnOffset: number | undefined;

  const wrappedOnBefore: NonNullable<GenerateTextOptions['onBeforeGeneration']> = async (
    ctx: GenerationHookContext,
  ): Promise<GenerationHookContext | void> => {
    recalled ??= recallForTurn(provider, guarded ? { ...turn, userText: sentTurnText(ctx) ?? turn.userText } : turn, hookOptions);
    const items = memoryItemsOf(await recalled);
    let nextCtx: GenerationHookContext = ctx;
    if (items.length > 0) {
      block ??= renderMemoryRecallBlock(items);
      // Recalled text is data in a user-role message right before the turn's own user message, never a system
      // message: the system prefix and the earlier turns stay as they were, so a cached prefix is still read. The
      // turn's message is the last user message of the call's first request; its distance from the leading system
      // messages is kept, since a later attempt or a fallback leg can carry one system message more or fewer.
      let lead = 0;
      while (lead < ctx.messages.length && ctx.messages[lead].role === 'system') lead += 1;
      if (turnOffset === undefined) {
        let last = ctx.messages.length;
        for (let i = ctx.messages.length - 1; i >= lead; i -= 1) {
          if (ctx.messages[i].role === 'user') {
            last = i;
            break;
          }
        }
        turnOffset = last - lead;
      }
      const at = Math.min(lead + turnOffset, ctx.messages.length);
      nextCtx = { ...ctx, messages: [...ctx.messages.slice(0, at), { role: 'user' as const, content: block }, ...ctx.messages.slice(at)] };
    }
    if (userOnBefore) {
      const userResult = await userOnBefore(nextCtx);
      return userResult ?? nextCtx;
    }
    return nextCtx;
  };

  return { ...baseOpts, onBeforeGeneration: wrappedOnBefore };
}
