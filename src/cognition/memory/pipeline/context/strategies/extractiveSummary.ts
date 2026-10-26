/**
 * @fileoverview The parts of an extractive summary, written when a compaction has no summarizer, its call fails or it
 * answers nothing: the summaries an earlier compaction left in the segment, carried forward as far as the window has
 * room for them, and the bounds that keep the summary within the segment it replaces and the window it goes back into.
 * @module agentos/cognition/memory/pipeline/context/strategies/extractiveSummary
 */

import type { CompactionInput, ContextMessage, InfiniteContextConfig } from '../../../core/types.js';

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
 * `text` cut so that it holds at most `maxChars` characters, at the last space when one falls in the second half of
 * that length; whole when it fits.
 */
function withinChars(text: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit / 2 ? cut.slice(0, space) : cut).trimEnd();
}

/**
 * `text` cut at a space so that it estimates at most `maxTokens` tokens, at four characters a token as the strategies
 * estimate them; whole when it fits. A summary cut so takes no more of the window than the segment it replaces.
 *
 * @param text - The summary.
 * @param maxTokens - The most tokens it may estimate.
 */
export function withinTokens(text: string, maxTokens: number): string {
  return withinChars(text, Math.max(0, Math.floor(maxTokens)) * 4);
}

/**
 * The tokens the window has for a compaction's summary: the compaction threshold, less what the compaction keeps (the
 * system prompt and the memory budget the caller counted, and the newest turns) and the summary message's header. A
 * summary within it leaves the window at or under the threshold. It is negative when the kept turns alone reach the
 * threshold.
 *
 * @param input - The compaction's input, with the window's size and the tokens it counted.
 * @param config - The window's settings, with the compaction threshold.
 * @param keptTokens - The tokens of the messages the compaction keeps as they are.
 * @param headerTokens - The tokens the summary message's header takes.
 */
export function summaryRoom(
  input: CompactionInput,
  config: InfiniteContextConfig,
  keptTokens: number,
  headerTokens: number,
): number {
  const conversationTokens = input.messages.reduce((sum, message) => sum + message.tokenEstimate, 0);
  const outsideTokens = Math.max(0, input.currentTokens - conversationTokens);
  return Math.floor(input.maxContextTokens * config.compactionThreshold) - outsideTokens - keptTokens - headerTokens;
}

/**
 * An extractive summary: the strategy's own extract of the segment, cut to `maxTokens`, after the summaries an
 * earlier compaction left in the segment, carried forward as far as the room left within both `maxTokens` and
 * `roomTokens` holds them, cut from their end so that the start of the conversation stays. The own extract is not
 * cut to the room: when it alone fills the room, no earlier summary is carried. A summary so built never grows past
 * the larger of the room and one extract, however many compactions carry it.
 *
 * @param earlier - The bodies of the earlier summaries, oldest first ({@link earlierSummaries}).
 * @param own - The strategy's own extract of the segment; empty when it has none.
 * @param maxTokens - The tokens of the segment the summary replaces, less the summary message's header.
 * @param roomTokens - The tokens the window has for the summary ({@link summaryRoom}).
 */
export function extractiveSummary(
  earlier: readonly string[],
  own: string,
  maxTokens: number,
  roomTokens: number,
): string {
  const ownPart = withinTokens(own, maxTokens);
  const limit = Math.max(0, Math.floor(Math.min(maxTokens, roomTokens))) * 4;
  // The blank line between the carried summaries and the own extract.
  const space = limit - ownPart.length - (ownPart === '' ? 0 : 2);
  const earlierPart = earlier.length > 0 && space > 0 ? withinChars(earlier.join('\n\n'), space) : '';
  return [earlierPart, ownPart].filter((part) => part !== '').join('\n\n');
}
