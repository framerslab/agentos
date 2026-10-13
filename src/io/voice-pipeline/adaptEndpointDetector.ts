/**
 * @module voice-pipeline/adaptEndpointDetector
 *
 * Lifecycle compatibility for an existing event-only {@link IEndpointDetector}
 * injected explicitly where an {@link IAudioEndpointDetector} is expected. The
 * adapter consumes no audio model: audio is accepted and ignored, and each
 * reset replaces the underlying instance, so a delayed completion of an old
 * instance cannot complete a new turn.
 */

import { EventEmitter } from 'node:events';
import {
  copyAudioIdentity,
  sameVoiceGeneration,
  type AudioIdentity,
  type IAudioEndpointDetector,
  type IEndpointDetector,
  type ScopedTranscriptEvent,
  type TurnCompleteEvent,
  type VadFrameEvent,
} from './types.js';

/**
 * Adapts an event-only detector for explicit injection. A fresh instance per reset fences delayed completions.
 *
 * @param make - Creates one detector instance; called at construction and on every reset.
 * @param initial - The identity results are labelled with until the first reset.
 * @returns An audio endpoint detector whose `turn_complete` events carry the identity in force when the current instance was made.
 */
export function adaptEndpointDetector(make: () => IEndpointDetector, initial: AudioIdentity): IAudioEndpointDetector {
  const out = new EventEmitter();
  let identity = copyAudioIdentity(initial);
  let inner = make();
  let disposed = false;
  const matches = (event: AudioIdentity): boolean =>
    !disposed &&
    event.scopeId === identity.scopeId &&
    event.callId === identity.callId &&
    event.turnId === identity.turnId &&
    sameVoiceGeneration(event.generation, identity.generation);
  const attach = (source: IEndpointDetector, captured: AudioIdentity): void => {
    // A replaced instance stays subscribed, but only the current one is heard.
    source.on('error', () => {
      if (source === inner && !disposed) out.emit('error', new Error('endpoint failed'));
    });
    source.on('turn_complete', (event: TurnCompleteEvent) => {
      if (source === inner && !disposed) out.emit('turn_complete', { ...event, ...captured });
    });
  };
  attach(inner, identity);
  return Object.assign(out, {
    mode: inner.mode,
    async pushAudio() {},
    async pushVadEvent(event: VadFrameEvent) {
      if (matches(event)) inner.pushVadEvent(event);
    },
    async pushTranscript(event: ScopedTranscriptEvent) {
      if (matches(event)) inner.pushTranscript(event);
    },
    async reset(next: AudioIdentity) {
      if (disposed) return;
      const previous = inner;
      identity = copyAudioIdentity(next);
      inner = make();
      previous.reset();
      attach(inner, identity);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      inner.reset();
    },
  });
}
