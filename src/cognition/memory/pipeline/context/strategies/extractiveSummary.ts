/**
 * @fileoverview The parts of an extractive summary, written when a compaction has no summarizer, its call fails or it
 * answers nothing: the summaries an earlier compaction left in the segment, carried forward, and a bound that keeps
 * the summary within the segment it replaces.
 * @module agentos/cognition/memory/pipeline/context/strategies/extractiveSummary
 */

import type { ContextMessage } from '../../../core/types.js';

/** The header lines a summary message opens with: `[Conversation summary — ...]`, `[Hybrid compaction — ...]`. */
const HEADER_LINES = /^(?:\[[^\n]*\]\n)+/;

/**
 * The bodies of the summaries an earlier compaction left in a segment, in order, each without the header lines its
 * message opens with. From the second compaction on, the segment opens with the first one's summary, so an extractive
 * summary that leaves it out drops the earlier condensed history from the window's own messages.
 *
 * @param messages - The messages of the segment being compacted.
 */
export function earlierSummaries(messages: readonly ContextMessage[]): string[] {
  return messages
    .filter((message) => message.compacted === true)
    .map((message) => message.content.replace(HEADER_LINES, '').trim())
    .filter((body) => body !== '');
}

/**
 * `text` cut at a space so that it estimates at most `maxTokens` tokens, at four characters a token as the strategies
 * estimate them; whole when it fits. A summary cut so takes no more of the window than the segment it replaces.
 *
 * @param text - The summary.
 * @param maxTokens - The most tokens it may estimate.
 */
export function withinTokens(text: string, maxTokens: number): string {
  const limit = Math.max(0, Math.floor(maxTokens)) * 4;
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit / 2 ? cut.slice(0, space) : cut).trimEnd();
}
