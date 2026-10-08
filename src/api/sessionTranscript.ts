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

import type { ThinkingBlock } from '../core/llm/providers/IProvider.js';

/** One function tool call recorded on an assistant turn. */
export interface TranscriptToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /**
   * Gemini thought signature for this call, recorded with the call so a
   * checkpoint and `reseed` keep it. Gemini 3 requires the signature back when
   * the call is replayed to it.
   */
  thoughtSignature?: string;
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
      /**
       * Provider thinking blocks as `generateText` recorded them (Anthropic
       * extended thinking, signatures intact). Replayed verbatim; takes
       * precedence over `thinking` when both are present.
       */
      thinkingBlocks?: ThinkingBlock[];
      /**
       * Set on the last message of a turn that failed after these steps
       * completed (GMI path, `agent({ runtime: 'gmi' })`). Never sent to a
       * provider.
       */
      partial?: true;
    }
  | {
      role: 'tool';
      tool_call_id: string;
      content: string;
      /** As on the assistant message: the last message of a turn that failed. Never sent to a provider. */
      partial?: true;
    };

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
      if (m.thinkingBlocks?.length) {
        for (const b of m.thinkingBlocks) if (b.type === 'thinking') parts.push(b.thinking);
      } else if (m.thinking) parts.push(m.thinking.text);
    }
  }
  return parts.join('\n');
}

/**
 * Builds the provider request message for one caller-supplied history entry.
 *
 * `generateText` and `streamText` copy caller messages into the request. A
 * session replays its transcript through that path, so the copy must keep the
 * fields that pair a tool result with its call: the assistant turn's
 * `tool_calls` (each with its Gemini `thoughtSignature`), the tool turn's
 * `tool_call_id`, and the assistant turn's thinking. Without them the request
 * after a tool round holds an orphaned tool result, which OpenAI, Anthropic
 * and Gemini reject with HTTP 400.
 *
 * Thinking arrives in one of two shapes. A transcript recorded by
 * `generateText` carries the provider's `thinkingBlocks` array, which is
 * copied as is. A caller-built snapshot (for `reseed`) uses the documented
 * {@link TranscriptThinking}: a `redacted` payload becomes a
 * `redacted_thinking` block, and signed text becomes a `thinking` block.
 * Unsigned thinking is dropped, because Anthropic only accepts thinking it
 * signed and the other providers ignore it.
 *
 * @param message - A public `Message` or a {@link SessionTranscriptMessage}.
 * @returns The request message, with replay fields present only when the
 *   entry carried them.
 */
export function toProviderReplayMessage(message: {
  role: string;
  content?: unknown;
}): Record<string, unknown> {
  const m = message as Record<string, unknown>;
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (typeof m.name === 'string') out.name = m.name;
  if (typeof m.tool_call_id === 'string') out.tool_call_id = m.tool_call_id;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) out.tool_calls = m.tool_calls;
  if (Array.isArray(m.thinkingBlocks) && m.thinkingBlocks.length > 0) {
    out.thinkingBlocks = m.thinkingBlocks;
  } else {
    const blocks = thinkingToBlocks(m.thinking);
    if (blocks) out.thinkingBlocks = blocks;
  }
  return out;
}

/** Maps a documented {@link TranscriptThinking} to replayable thinking blocks. */
function thinkingToBlocks(thinking: unknown): ThinkingBlock[] | undefined {
  if (!thinking || typeof thinking !== 'object') return undefined;
  const t = thinking as Partial<TranscriptThinking>;
  if (typeof t.redacted === 'string' && t.redacted) {
    return [{ type: 'redacted_thinking', data: t.redacted }];
  }
  if (typeof t.text === 'string' && typeof t.signature === 'string' && t.signature) {
    return [{ type: 'thinking', thinking: t.text, signature: t.signature }];
  }
  return undefined;
}
