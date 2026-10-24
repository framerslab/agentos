/**
 * @module voice-pipeline/clientTextInput
 *
 * The text input message's check, with no run-time import, so a browser
 * bundle takes it from `@framers/agentos/io/voice-pipeline/browser`.
 *
 * A user who types instead of speaking sends the server a
 * {@link ClientTextInputMessage}: a WebSocket client sends it as JSON, and
 * `LiveKitStreamTransport` makes one from each `lk.chat` text stream of its
 * linked participant. `VoicePipelineOrchestrator` takes one as a user turn
 * and, while the agent speaks, interrupts the reply first.
 *
 * ```typescript
 * // In the browser:
 * socket.send(JSON.stringify({ type: 'text_input', text: input.value }));
 *
 * // On the server:
 * transport.on('message', (message) => {
 *   if (isClientTextInputMessage(message)) takeTurn(message.text);
 * });
 * ```
 */

import type { ClientTextInputMessage } from './types.js';

/** The longest `text` {@link isClientTextInputMessage} accepts. */
export const MAX_TEXT_INPUT_LENGTH = 4_000;

/**
 * Whether a value a server received is a well-formed
 * {@link ClientTextInputMessage}. A client's message is untrusted input, so
 * this refuses a `text` that is not a string, one of whitespace alone, and one
 * over 4,000 characters.
 *
 * @param value - A parsed message, as a transport emits it.
 */
export function isClientTextInputMessage(value: unknown): value is ClientTextInputMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { type, text } = value as Record<string, unknown>;
  if (type !== 'text_input' || typeof text !== 'string') return false;
  return text.trim().length > 0 && text.length <= MAX_TEXT_INPUT_LENGTH;
}
