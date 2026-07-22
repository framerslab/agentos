/**
 * Lossless session transcript contract (spec 2026-07-20 §1b).
 *
 * The public `Message` type is `{role, content}` only; the generateText tool
 * loop privately records assistant `tool_calls`, thinking blocks, and
 * `tool_call_id` tool messages. Sessions must retain THAT shape verbatim so a
 * replayed conversation satisfies the provider pairing rules: every
 * tool_result follows its tool_use, and signed thinking blocks replay
 * byte-exact (Anthropic rejects edited signatures).
 */

/** One function tool call recorded on an assistant turn. */
export interface TranscriptToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Opaque provider thinking payload; replayed verbatim, never edited. */
export interface TranscriptThinking {
  text: string;
  /** Provider signature for signed-thinking replay. Absent when unsigned. */
  signature?: string;
  /** Redacted-thinking wire payload when the provider substituted one. */
  redacted?: string;
}

export type SessionTranscriptMessage =
  | { role: 'user'; content: unknown }
  | {
      role: 'assistant';
      content: unknown;
      tool_calls?: TranscriptToolCall[];
      thinking?: TranscriptThinking;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export type PairingVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Validates provider-replayable ordering: every tool result pairs with an
 * open tool_call from the nearest preceding assistant turn, and every
 * tool_call is answered before the next user or assistant turn. Reseed
 * rejects snapshots that fail this (spec §1d) — a session must never hold a
 * history the provider will 400 on.
 */
export function validateTranscriptPairing(
  messages: readonly SessionTranscriptMessage[],
): PairingVerdict {
  const open = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant') {
      if (open.size > 0) {
        return {
          ok: false,
          reason: `unanswered tool_call(s) before assistant turn: ${[...open].join(', ')}`,
        };
      }
      for (const tc of m.tool_calls ?? []) open.add(tc.id);
    } else if (m.role === 'tool') {
      if (!open.delete(m.tool_call_id)) {
        return { ok: false, reason: `orphan tool result for id ${m.tool_call_id}` };
      }
    } else {
      if (open.size > 0) {
        return {
          ok: false,
          reason: `unanswered tool_call(s) before user turn: ${[...open].join(', ')}`,
        };
      }
    }
  }
  if (open.size > 0) {
    return { ok: false, reason: `unanswered tool_call(s) at transcript end: ${[...open].join(', ')}` };
  }
  return { ok: true };
}

/** Fixed token-text stand-in per non-text content part (images etc). */
const NON_TEXT_PART_TOKEN_TEXT = ' [media-part] ';

/**
 * Canonical serialization for token estimation (spec §1c(iii)): text content
 * verbatim, tool arguments/results as their JSON strings, thinking text
 * included, multimodal parts as a fixed marker. Deterministic by
 * construction — the eviction ceiling must not flap between identical
 * histories.
 */
export function transcriptTokenText(messages: readonly SessionTranscriptMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      parts.push(m.content);
      continue;
    }
    const c = m.content;
    if (typeof c === 'string') parts.push(c);
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string') {
          parts.push((p as { text: string }).text);
        } else parts.push(NON_TEXT_PART_TOKEN_TEXT);
      }
    } else if (c != null) parts.push(JSON.stringify(c));
    if (m.role === 'assistant') {
      for (const tc of m.tool_calls ?? []) parts.push(tc.function.name, tc.function.arguments);
      if (m.thinking) parts.push(m.thinking.text);
    }
  }
  return parts.join('\n');
}
