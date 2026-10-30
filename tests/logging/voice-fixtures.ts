/**
 * Small voice peers for diagnostic tests; no sockets or provider credentials.
 *
 * @module
 */
import { EventEmitter } from 'node:events';
import { defaultCapabilities, type HealthyProvider } from '../../src/io/voice-pipeline/HealthyProvider.js';
import type { AudioFrame, IStreamingSTT, IStreamTransport, ITranscriptInputSink, StreamingSTTSession, TranscriptEvent, TranscriptInput, TranscriptTurn } from '../../src/io/voice-pipeline/types.js';

/** Disposable private markers must never reach a diagnostic destination. */
export const PRIVATE = 'spoken private words Private Fixture Person person@example.invalid 203.0.113.7 sk_private_key';
/** A real EventEmitter with every streaming method the session calls. */
export class Source extends EventEmitter {
  /** Audio is held only in the disposable test fixture. */
  readonly frames: AudioFrame[] = [];
  /** Preserve audio delivery for lifecycle assertions. */
  pushAudio(frame: AudioFrame): void { this.frames.push(frame); }
  /** Tests can override this to provide a drain-time final or warning. */
  async flush(): Promise<void> {}
  /** A provider close is a real event, not a removed listener shortcut. */
  close(): void { this.emit('close'); }
}
/** Each start returns a new source so reconnect listener behavior is observable. */
export function provider(): { peer: IStreamingSTT & HealthyProvider; sessions: Source[] } {
  const sessions: Source[] = [];
  const peer: IStreamingSTT & HealthyProvider = {
    providerId: PRIVATE, isStreaming: true, priority: 1, capabilities: defaultCapabilities(),
    /** No network request is made. */
    async healthCheck() { return { ok: true }; },
    /** Record the actual emitter a wrapper attaches. */
    async startSession(): Promise<StreamingSTTSession> { const session = new Source(); sessions.push(session); return session; },
  };
  return { peer, sessions };
}
/** Caller-owned transport with the complete structural methods used by a listen session. */
export function transport(): IStreamTransport {
  return Object.assign(new EventEmitter(), {
    id: 'diagnostic-fixture', state: 'open' as const,
    /** This listen-only fixture sends no audio. */
    async sendAudio(): Promise<void> {},
    /** This listen-only fixture sends no control messages. */
    async sendControl(): Promise<void> {},
    /** A session must never call this caller-owned method. */
    close(): void { throw new Error('caller transport closed'); },
  });
}
/** A sink with actual sequencing and no diagnostic side effects. */
export class Sink implements ITranscriptInputSink {
  /** Stored transcript fixtures prove delivery continues, and are never printed. */
  readonly turns: TranscriptTurn[] = [];
  /** Preserve the base sink contract for already-numbered turns. */
  async append(turn: TranscriptTurn): Promise<void> { this.turns.push(turn); }
  /** Allocate a stable sequence for each accepted input. */
  async appendNext(turn: TranscriptInput): Promise<TranscriptTurn> {
    const seq = this.turns.length + 1;
    const stored: TranscriptTurn = { ...turn, seq, turnId: `${turn.runId}:${seq}` };
    this.turns.push(stored); return stored;
  }
}
/** One final is enough to exercise the speaker path without a detector. */
export function final(): TranscriptEvent { return { text: PRIVATE, confidence: 1, words: [], isFinal: true, startMs: 0, endMs: 20 }; }
/** A warning whose content cannot be read without changing the test outcome. */
export function hostile(): Error {
  return Object.defineProperty(new Error(), 'message', { get() { throw new Error('warning content was read'); } });
}
