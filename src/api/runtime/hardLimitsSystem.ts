/**
 * @file hardLimitsSystem.ts
 * A persona's hard-limits block as the last part of an agent's system prompt on the default runtime, and the split
 * `generateText` makes when it has to send something else before that block.
 *
 * @module api/runtime/hardLimitsSystem
 */
import type { SystemContentBlock } from '../generateText.js';
import { hardLimitsBlock } from '../../cognition/substrate/personas/hardLimits.js';

type SystemPrompt = string | SystemContentBlock[] | undefined;

/**
 * The agent's system prompt with the persona's hard-limits block as its last part: appended to a string after a blank
 * line, or as one more block after the host's blocks, with no cache breakpoint of its own. Unchanged when there are no
 * limits.
 *
 * @param system - The agent's system prompt: a string, the host's blocks, or none.
 * @param hardLimits - The persona's hard limits; blank lines are dropped.
 */
export function withHardLimitsLast(system: SystemPrompt, hardLimits: readonly string[] | undefined): SystemPrompt {
  const block = hardLimitsBlock(hardLimits);
  if (!block) return system;
  if (Array.isArray(system)) return [...system, { text: block, _hardLimits: true }];
  return system ? `${system}\n\n${block}` : block;
}

/**
 * A system prompt apart from the hard-limits block that closes it: blocks whose last one carries the mark
 * `withHardLimitsLast` sets, or a string that ends with `hardLimitsText`. `limits` is undefined, and `head` the prompt
 * as given, when it closes with no such block.
 *
 * @param system - The call's system prompt.
 * @param hardLimitsText - The block's exact text, for a string prompt (`GenerateTextOptions._hardLimitsText`).
 */
export function splitHardLimits(system: SystemPrompt, hardLimitsText: string | undefined): { head: SystemPrompt; limits: string | undefined } {
  if (Array.isArray(system)) {
    const last = system[system.length - 1];
    if (!last?._hardLimits) return { head: system, limits: undefined };
    const rest = system.slice(0, -1);
    return { head: rest.length > 0 ? rest : undefined, limits: last.text };
  }
  if (typeof system === 'string' && hardLimitsText && system.endsWith(hardLimitsText)) {
    const head = system.slice(0, system.length - hardLimitsText.length).trimEnd();
    return { head: head || undefined, limits: hardLimitsText };
  }
  return { head: system, limits: undefined };
}
