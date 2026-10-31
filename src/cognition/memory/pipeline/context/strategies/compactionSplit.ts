/**
 * Where a compaction splits a conversation, shared by the three strategies.
 */

/**
 * The index of the first message a compaction keeps as it is; the messages
 * before it are summarized.
 *
 * The newest `preserveRecentTurns` turns (two messages a turn) are kept while
 * older messages remain to summarize. A conversation shorter than that, over
 * its threshold all the same, gives up its two oldest messages. The newest
 * message, the one the next model call answers, is never summarized.
 *
 * @param messageCount - How many messages the conversation holds.
 * @param preserveRecentTurns - Turns to keep as they are.
 * @returns The split index; 0 when nothing can be summarized.
 */
export function compactionSplitIndex(messageCount: number, preserveRecentTurns: number): number {
  const keep = Math.max(1, Math.min(preserveRecentTurns * 2, messageCount - 2));
  return Math.max(0, messageCount - keep);
}
