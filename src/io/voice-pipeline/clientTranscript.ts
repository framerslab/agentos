/**
 * @module voice-pipeline/clientTranscript
 *
 * The client transcript message's helpers, with no run-time import, so a
 * browser bundle takes them from `@framers/agentos/io/voice-pipeline/browser`.
 *
 * A client that transcribes on its own device (for example with
 * `MoonshineBrowserSTT`) sends each of its transcripts to the server as a
 * {@link ClientTranscriptMessage} in place of audio, and a server reads them
 * from its transport's `'message'` event:
 *
 * ```typescript
 * // In the browser:
 * sttSession.on('transcript', (event) => socket.send(JSON.stringify(toClientTranscriptMessage(event))));
 *
 * // On the server:
 * transport.on('message', (message) => {
 *   if (isClientTranscriptMessage(message)) handle(transcriptEventFromClient(message));
 * });
 * ```
 *
 * `VoicePipelineOrchestrator` does the server's part itself for the transport
 * it runs on.
 */

import type { ClientTranscriptMessage, TranscriptEvent } from './types.js';

/** The longest `text` {@link isClientTranscriptMessage} accepts. */
const MAX_TEXT_LENGTH = 4_000;

/** The longest `itemId` {@link isClientTranscriptMessage} accepts. */
const MAX_ITEM_ID_LENGTH = 128;

/** The longest `language` {@link isClientTranscriptMessage} accepts. */
const MAX_LANGUAGE_LENGTH = 64;

/**
 * Makes the message a client sends for one of its transcripts.
 *
 * @param event - A transcript from any streaming STT session.
 * @param itemId - The line's id when the event has none; `event.itemId` by default.
 * @returns The message, with `confidence` and whichever of `startMs`, `endMs`
 *   and `language` the event carries.
 * @throws {RangeError} When neither the event nor the caller gives a line id.
 */
export function toClientTranscriptMessage(
  event: TranscriptEvent,
  itemId: string | undefined = event.itemId
): ClientTranscriptMessage {
  if (!itemId) {
    throw new RangeError(
      'toClientTranscriptMessage: the transcript has no itemId; pass the line id as the second argument'
    );
  }
  const message: ClientTranscriptMessage = {
    type: 'transcript',
    text: event.text,
    itemId,
    isFinal: event.isFinal,
    confidence: event.confidence,
  };
  if (event.startMs !== undefined) message.startMs = event.startMs;
  if (event.endMs !== undefined) message.endMs = event.endMs;
  if (event.language !== undefined) message.language = event.language;
  return message;
}

/**
 * Whether a value a server received is a well-formed
 * {@link ClientTranscriptMessage}. A client's message is untrusted input, so
 * this refuses a field of the wrong type, an empty `itemId`, a `confidence`
 * outside 0 to 1, a negative or non-finite offset, an `endMs` before its
 * `startMs`, and a `text` over 4,000 characters, an `itemId` over 128 or a
 * `language` over 64.
 *
 * @param value - A parsed message, as a transport emits it.
 */
export function isClientTranscriptMessage(value: unknown): value is ClientTranscriptMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { type, text, itemId, isFinal, confidence, startMs, endMs, language } = value as Record<string, unknown>;
  if (type !== 'transcript' || typeof text !== 'string' || typeof isFinal !== 'boolean') return false;
  if (text.length > MAX_TEXT_LENGTH) return false;
  if (typeof itemId !== 'string' || itemId.length === 0 || itemId.length > MAX_ITEM_ID_LENGTH) return false;
  if (confidence !== undefined && !(isFiniteNumber(confidence) && confidence >= 0 && confidence <= 1)) return false;
  if (startMs !== undefined && !isOffset(startMs)) return false;
  if (endMs !== undefined && !isOffset(endMs)) return false;
  if (typeof startMs === 'number' && typeof endMs === 'number' && endMs < startMs) return false;
  if (language !== undefined && (typeof language !== 'string' || language.length > MAX_LANGUAGE_LENGTH)) return false;
  return true;
}

/**
 * Turns a client's transcript message into the {@link TranscriptEvent} a
 * server's endpoint detector and listeners take: `confidence` 1 when the
 * message has none (as providers report for a service that gives no score),
 * no word timings, and `durationMs` on a final that carries both offsets.
 *
 * @param message - A message {@link isClientTranscriptMessage} accepted.
 */
export function transcriptEventFromClient(message: ClientTranscriptMessage): TranscriptEvent {
  const event: TranscriptEvent = {
    text: message.text,
    confidence: message.confidence ?? 1,
    words: [],
    isFinal: message.isFinal,
    itemId: message.itemId,
  };
  if (message.isFinal && message.startMs !== undefined && message.endMs !== undefined) {
    event.durationMs = message.endMs - message.startMs;
  }
  if (message.startMs !== undefined) event.startMs = message.startMs;
  if (message.endMs !== undefined) event.endMs = message.endMs;
  if (message.language !== undefined) event.language = message.language;
  return event;
}

/** A finite number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A finite, non-negative number of milliseconds. */
function isOffset(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}
