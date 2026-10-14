import { z } from 'zod';
import { sameVoiceGeneration, type PlaybackReceipt, type VoiceGeneration } from './types.js';
const integer = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** Closed wire fence shared by both call transports. */
export const PlaybackGenerationSchema = z.strictObject({ workerGeneration: integer, inferenceGeneration: integer, transportEpoch: integer });
/** Receiver-to-publisher control; never interpreted as user commands or quantity reports. */
export const PlaybackAcknowledgementSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('playback'), generation: PlaybackGenerationSchema, sequence: integer, playedSamples: integer, sampleRate: integer }),
  z.strictObject({ type: z.literal('cleared'), generation: PlaybackGenerationSchema, clearId: integer }),
]);
/** Publisher-to-receiver discard fence; acknowledgement is mandatory while the path is open. */
export interface PlaybackClear { type: 'clear'; generation: VoiceGeneration; clearId: number }
interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
function deferred<T>(timeoutMs: number): Deferred<T> {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {});
  const timer = setTimeout(() => reject(new Error('receipt timeout')), timeoutMs);
  return { promise, resolve, reject, timer };
}
/** One audio receipt and one discard handshake, with fixed memory and explicit deadlines. */
export class PlaybackAcknowledgements {
  private audio?: { receipt: PlaybackReceipt; result: Deferred<PlaybackReceipt>; acknowledged: boolean };
  private clearing?: { message: PlaybackClear; result: Deferred<void>; done: Promise<void> };
  private cleared?: VoiceGeneration;
  private clearSequence = 0;
  private closed = false;
  constructor(private readonly timeoutMs: number) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('invalid receipt deadline');
  }
  /** Reserves the sole receipt before any bytes leave, so a fast receiver cannot race registration. */
  begin(receipt: PlaybackReceipt): void {
    if (this.closed || this.audio || this.clearing) throw new Error('playback outstanding or closed');
    PlaybackAcknowledgementSchema.parse({ type: 'playback', ...receipt });
    if (this.cleared && sameVoiceGeneration(this.cleared, receipt.generation)) throw new Error('cancelled generation');
    this.audio = { receipt: { ...receipt, generation: { ...receipt.generation } }, result: deferred(this.timeoutMs), acknowledged: false };
  }
  /** Returns false for stale/duplicate receipts; malformed or inconsistent current receipts fail closed. */
  receive(input: unknown): boolean {
    const event = PlaybackAcknowledgementSchema.parse(input);
    if (event.type === 'cleared') {
      const pending = this.clearing;
      if (!pending || pending.message.clearId !== event.clearId || !sameVoiceGeneration(pending.message.generation, event.generation)) return false;
      clearTimeout(pending.result.timer); pending.result.resolve(); return true;
    }
    const pending = this.audio;
    if (!pending || pending.acknowledged || !sameVoiceGeneration(pending.receipt.generation, event.generation) || pending.receipt.sequence !== event.sequence) return false;
    if (pending.receipt.playedSamples !== event.playedSamples || pending.receipt.sampleRate !== event.sampleRate) throw new Error('receipt mismatch');
    pending.acknowledged = true; clearTimeout(pending.result.timer); pending.result.resolve(pending.receipt); return true;
  }
  /** Resolves a matching receiver acknowledgement, never a socket-send callback. */
  async wait(generation: VoiceGeneration, sequence: number, signal: AbortSignal): Promise<PlaybackReceipt> {
    const pending = this.audio;
    if (!pending || !sameVoiceGeneration(pending.receipt.generation, generation) || pending.receipt.sequence !== sequence) throw new Error('missing playback receipt');
    const abort = (): void => pending.result.reject(new Error('playback cancelled'));
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    try { const receipt = await pending.result.promise; if (signal.aborted || this.closed) throw new Error('playback cancelled'); return receipt; }
    finally { signal.removeEventListener('abort', abort); clearTimeout(pending.result.timer); if (this.audio === pending) this.audio = undefined; }
  }
  /**
   * Cancels before sending discard. Repeated clears of the same generation share one bounded handshake and settle
   * together, only after it has released, so a caller may begin the next generation's audio as soon as its await returns.
   */
  clear(generation: VoiceGeneration, send: (message: PlaybackClear) => Promise<void>): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.clearing) {
      if (!sameVoiceGeneration(this.clearing.message.generation, generation)) return Promise.reject(new Error('clear already outstanding'));
      return this.clearing.done;
    }
    if (this.cleared && sameVoiceGeneration(this.cleared, generation)) return Promise.resolve();
    const audio = this.audio;
    if (audio && !sameVoiceGeneration(audio.receipt.generation, generation)) return Promise.resolve();
    if (audio) { audio.result.reject(new Error('playback cancelled')); clearTimeout(audio.result.timer); this.audio = undefined; }
    const message: PlaybackClear = { type: 'clear', generation: { ...generation }, clearId: ++this.clearSequence };
    const result = deferred<void>(this.timeoutMs);
    const done = result.promise.then(() => { this.cleared = { ...generation }; }).finally(() => { clearTimeout(result.timer); if (this.clearing?.result === result) this.clearing = undefined; });
    this.clearing = { message, result, done };
    // send starts synchronously; its rejection is supervised even if the caller cancels meanwhile.
    try { void send(message).catch(() => result.reject(new Error('playback clear failed'))); }
    catch { result.reject(new Error('playback clear failed')); }
    return done;
  }
  /** Cancels all waits on confirmed physical teardown; no sample is acknowledged by this operation. */
  close(): void {
    this.closed = true;
    if (this.audio) { clearTimeout(this.audio.result.timer); this.audio.result.reject(new Error('playback cancelled')); this.audio = undefined; }
    if (this.clearing) { clearTimeout(this.clearing.result.timer); this.clearing.result.reject(new Error('playback cancelled')); this.clearing = undefined; }
  }
}
