/**
 * @module voice-pipeline/speechEdgeItem
 *
 * Reads the provider input item a streaming STT session passes with its
 * `'speech_start'` or `'speech_end'` ({@link SttSpeechEdge}), for the VAD
 * event that carries the edge to an endpoint detector.
 */

import type { SttSpeechEdge, VadEvent } from './types.js';

/**
 * The item a speech edge names: the `itemId` of the event's argument when it
 * is a non-empty string, else `undefined` (a provider that knows no item
 * emits the event with no argument).
 *
 * @param edge - What the session passed with the event.
 * @returns The item id, or `undefined`.
 */
export function speechEdgeItem(edge: unknown): string | undefined {
  if (edge === null || typeof edge !== 'object') return undefined;
  const itemId = (edge as SttSpeechEdge).itemId;
  return typeof itemId === 'string' && itemId !== '' ? itemId : undefined;
}

/**
 * A VAD event for a transcriber's speech edge, carrying the item it named.
 *
 * @param type - `'speech_start'` or `'speech_end'`.
 * @param itemId - The item the edge named, if any.
 * @returns The event, with `source: 'stt'` and the current time.
 */
export function sttSpeechEvent(type: 'speech_start' | 'speech_end', itemId?: string): VadEvent {
  const event: VadEvent = { type, timestamp: Date.now(), source: 'stt' };
  if (itemId !== undefined) event.itemId = itemId;
  return event;
}
