/**
 * @module voice-pipeline/providers/SttConnectionMeter
 *
 * Identity, authorization and cumulative usage of one hosted transcription
 * socket, shared by the Deepgram and OpenAI streaming adapters. It imports
 * `node:crypto`, so it stays out of the browser entry.
 */

import { randomUUID } from 'node:crypto';
import type { SttConnectionHooks, SttConnectionOpening, SttMeasuredUsageEvent } from '../types.js';
import { SttConnectionAuthorizationError } from '../SttConnectionAuthorizationError.js';

/** Identity and accounting for one socket, including one that fails to open. */
export class SttConnectionMeter {
  /** The socket's identity, fixed before any authorization or network opening. */
  readonly opening: SttConnectionOpening;
  private readonly abort = new AbortController();
  private finished = false;
  private seconds = 0;
  private supplierRequestId: string | undefined;

  /**
   * @param providerId - The adapter's `providerId`.
   * @param entry - The hosted `vendor:model` entry the socket is reserved and priced as.
   * @param model - The model sent on the wire.
   * @param hooks - The host's accounting hooks; without them nothing is awaited or reported to a host.
   */
  constructor(providerId: string, entry: string, model: string, private readonly hooks?: SttConnectionHooks) {
    this.opening = Object.freeze({ connectionId: randomUUID(), providerId, entry, model });
  }

  /**
   * Binds the supplier's request id to this socket's reports.
   *
   * @throws {Error} For an empty id, one over 256 characters, or a second id that differs from the first.
   */
  bindSupplierRequest(id: string): void {
    if (!id || id.length > 256 || (this.supplierRequestId && this.supplierRequestId !== id)) {
      throw new Error('invalid supplier request identity');
    }
    this.supplierRequestId = id;
  }

  /**
   * Awaits host funding before a socket is constructed. Cancellation never opens one.
   *
   * @throws {SttConnectionAuthorizationError} When the host refuses, the wait reaches
   *   `authorizationTimeoutMs`, or {@link cancelAuthorization} ends it; a final zero report precedes the throw.
   * @throws {RangeError} For an `authorizationTimeoutMs` that is not a positive whole number.
   */
  async authorize(): Promise<void> {
    if (!this.hooks) return;
    const timeout = this.hooks.authorizationTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new RangeError('invalid authorization timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => {
          this.abort.signal.throwIfAborted();
          return this.hooks!.authorize(this.opening, this.abort.signal);
        }),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new SttConnectionAuthorizationError());
          if (this.abort.signal.aborted) onAbort();
          else this.abort.signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => this.abort.abort(), timeout);
        }),
      ]);
      this.abort.signal.throwIfAborted();
    } catch {
      this.abort.abort();
      this.report(0, 0, true);
      throw new SttConnectionAuthorizationError();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) this.abort.signal.removeEventListener('abort', onAbort);
    }
  }

  /** Ends an in-flight authorization; callers also close or terminate their socket. */
  cancelAuthorization(): void {
    this.abort.abort();
  }

  /**
   * Returns one immutable cumulative report and notifies the host; reports after the final one are ignored.
   *
   * @param connectionIndex - The provider session's local index of the socket; zero for one it never adopted.
   * @param audioSeconds - Seconds of audio handed to the socket so far.
   * @param final - Whether this is the socket's last report.
   * @returns The report, or `undefined` once the final report has been made.
   * @throws {RangeError} For a total that is not finite, is negative or is below an earlier report's.
   */
  report(connectionIndex: number, audioSeconds: number, final: boolean): SttMeasuredUsageEvent | undefined {
    if (this.finished) return undefined;
    if (!Number.isFinite(audioSeconds) || audioSeconds < this.seconds || audioSeconds < 0) {
      throw new RangeError('invalid cumulative STT usage');
    }
    this.seconds = audioSeconds;
    this.finished = final;
    const event: SttMeasuredUsageEvent = Object.freeze({
      ...this.opening,
      connectionIndex,
      audioSeconds,
      final,
      ...(this.supplierRequestId === undefined ? {} : { supplierRequestId: this.supplierRequestId }),
    });
    this.hooks?.usage(event);
    return event;
  }
}
