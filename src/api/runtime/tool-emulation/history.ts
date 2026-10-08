import type { EmulatedLoopMessage } from './loop';

/**
 * Renders a chat history for the prompt-tool shim, which sends plain
 * role/content text. An assistant turn's native tool calls become
 * `<tool_call>` blocks after its text, and each run of tool results becomes
 * one user turn of `<tool_response>` blocks, the shape the shim records for
 * its own rounds. A history that holds native tool turns (a session
 * transcript, or a failover that continues after completed tool rounds)
 * otherwise reaches the model as `tool` messages with nothing to pair with,
 * which OpenAI-compatible APIs reject.
 *
 * @param messages Request messages in the native chat shape.
 * @returns The same conversation as shim messages.
 */
export function toShimMessages(
  messages: ReadonlyArray<Record<string, unknown>>,
): EmulatedLoopMessage[] {
  const out: EmulatedLoopMessage[] = [];
  // Tool names by call id, so a result without a name still names its call.
  const toolNameByCallId = new Map<string, string>();
  let openToolResponses: EmulatedLoopMessage | undefined;
  for (const m of messages) {
    const text = contentText(m.content);
    if (m.role === 'tool') {
      const callId = typeof m.tool_call_id === 'string' ? m.tool_call_id : undefined;
      const name =
        (typeof m.name === 'string' && m.name) || (callId ? toolNameByCallId.get(callId) : undefined) || '';
      // The call id and name travel in the envelope, so results that arrive
      // in a different order than their calls stay matched.
      const block = `<tool_response>${JSON.stringify({ id: callId, name, output: parsedOrText(text) })}</tool_response>`;
      if (openToolResponses) {
        openToolResponses.content += `\n${block}`;
      } else {
        openToolResponses = { role: 'user', content: block };
        out.push(openToolResponses);
      }
      continue;
    }
    openToolResponses = undefined;
    const toolCalls = m.role === 'assistant' && Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (toolCalls.length > 0) {
      const blocks = toolCalls.map((tc) => {
        const payload = toolCallPayload(tc);
        if (payload.id) toolNameByCallId.set(payload.id, payload.name);
        return `<tool_call>${JSON.stringify(payload)}</tool_call>`;
      });
      out.push({ role: 'assistant', content: [text, ...blocks].filter(Boolean).join('\n') });
      continue;
    }
    out.push({ role: String(m.role), content: text });
  }
  return out;
}

/** Text of a message's content: strings as they are, other values as JSON. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

/**
 * The `{name, arguments, id}` payload of a native tool call, arguments parsed
 * when they are JSON. The shim's parser reads `name` and `arguments`; `id`
 * pairs the call with its result.
 */
function toolCallPayload(toolCall: unknown): { name: string; arguments: unknown; id?: string } {
  const tc = toolCall as { id?: unknown; function?: { name?: unknown; arguments?: unknown } } | null;
  const fn = tc?.function;
  const name = typeof fn?.name === 'string' ? fn.name : '';
  let args: unknown = fn?.arguments ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      // Keep the raw argument text; the model still sees what was called.
    }
  }
  return { name, arguments: args, ...(typeof tc?.id === 'string' ? { id: tc.id } : {}) };
}

/** A tool result's JSON value when its text is JSON, else the text. */
function parsedOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
