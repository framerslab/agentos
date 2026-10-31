/**
 * @fileoverview Finds the tool rounds of a message list, so a cut through the list (a summary's boundary, a trim to a
 * token budget) can keep each round on one side: providers refuse a tool call without its result and a tool result
 * without its call.
 */

/** The fields of a conversation or chat message that place it in a tool round. */
export interface ToolRoundMessage {
  role: string;
  tool_calls?: ReadonlyArray<{ id?: string | null } | null | undefined> | null;
  tool_call_id?: string | null;
}

/** For each message of a list, the index of the first and of the last message of its tool round. */
export interface ToolRoundBounds {
  /** `start[i]` is the index of the first message of the round message `i` belongs to, or `i` outside every round. */
  start: number[];
  /** `end[i]` is the index of the last message of the round message `i` belongs to, or `i` outside every round. */
  end: number[];
}

/**
 * Finds the tool rounds of `messages`. A round is an assistant message that names tool calls, the tool messages after
 * it that answer them, and every message between them. A tool message answers the nearest assistant message before it
 * that names its call id, so a provider that gives calls of different turns the same id is read right. Rounds that
 * overlap count as one. A tool message that answers no call before it belongs to no round.
 *
 * A list cut after index `i` splits no round exactly when `end[i] === i`, and a cut before index `i` splits none
 * exactly when `start[i] === i`.
 *
 * @param messages - The messages, oldest first.
 * @returns The first and last index of each message's round.
 */
export function toolRoundBounds(messages: ReadonlyArray<ToolRoundMessage>): ToolRoundBounds {
  const start = messages.map((_message, index) => index);
  const end = messages.map((_message, index) => index);
  // [first, last] of each assistant message that names calls, in the order of the messages
  const spans: Array<[number, number]> = [];
  const spanOfCall = new Map<string, [number, number]>();

  messages.forEach((message, index) => {
    const calls = message.role === 'assistant' ? message.tool_calls : undefined;
    if (Array.isArray(calls) && calls.length > 0) {
      const span: [number, number] = [index, index];
      spans.push(span);
      for (const call of calls) {
        const callId = call?.id;
        if (typeof callId === 'string' && callId) spanOfCall.set(callId, span);
      }
    } else if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      const span = spanOfCall.get(message.tool_call_id);
      if (span) span[1] = index;
    }
  });

  let merged: [number, number] | undefined;
  const fill = (span: [number, number]) => {
    for (let index = span[0]; index <= span[1]; index += 1) {
      start[index] = span[0];
      end[index] = span[1];
    }
  };
  for (const span of spans) {
    if (merged && span[0] <= merged[1]) {
      merged[1] = Math.max(merged[1], span[1]);
      continue;
    }
    if (merged) fill(merged);
    merged = [span[0], span[1]];
  }
  if (merged) fill(merged);

  return { start, end };
}
