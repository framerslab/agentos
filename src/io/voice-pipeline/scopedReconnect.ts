/**
 * @module voice-pipeline/scopedReconnect
 *
 * The scoped path of `ReconnectingSTT`: one provider's session, reopened on
 * the same provider when it errors or closes, for a caller that labels its
 * audio with an {@link AudioIdentity}. Replayed frames keep the identity they
 * were admitted with, a reset drops the replay, and a frame or a result of an
 * earlier identity never reaches the provider's new session or the caller.
 */
import { EventEmitter } from 'node:events';
import { sameVoiceGeneration, type AudioIdentity, type IStreamingSTT, type ScopedAudioFrame, type ScopedTranscriptEvent, type ScopedStreamingSTTSession, type StreamingSTTConfig } from './types.js';

/** Bounds inherited from the owning reconnection provider. */
export interface ScopedReconnectOptions {
  /** Milliseconds of audio handed to the provider that are kept for replay. */
  capacityMs: number;
  /** Less kept audio than this is not replayed. */
  minReplayMs: number;
  /** Reconnects allowed in any sixty seconds; past them the session emits `error`, then `close`. */
  maxAttempts: number;
  /** Milliseconds of admitted audio not yet handed to the provider; a frame past it is refused. */
  queueCapacityMs: number;
  /** Milliseconds now, for the attempt window and the gap's length. */
  clock(): number;
}

/**
 * Opens the same registered provider while retaining the identity attached to every admitted frame.
 *
 * The provider's session is opened with `config.call` and reset to it. `pushAudioScoped()` admits a frame only when
 * its scope, call, recognition turn and generation are the session's current identity, no reset is under way and the
 * admitted audio not yet handed over stays within `queueCapacityMs`; a frame that fails a check is refused, never
 * queued. Frames are handed over in order, and each handed frame is kept for replay, up to `capacityMs`. `pushAudio()`
 * throws: this session takes scoped frames alone. `reset(identity)` takes the same scope and call only, drops the kept
 * frames and resets the provider's session; a frame of the earlier identity is refused afterwards.
 *
 * An `error` of the provider's session, or a `close` the caller did not ask for, opens a new session of the same
 * provider, at most `maxAttempts` times in any sixty seconds, reset to the current identity. When at least
 * `minReplayMs` is kept and no reset is under way, the kept frames of the current identity are replayed into it, each
 * with the identity it was admitted with. The session then emits `stt:reconnected` (`{ attempt, replayedMs }`) and
 * `stt:gap` (`{ attempt, lostMs }`, the time the reconnect took). A reconnect whose session fails to open, or one
 * past the bound, emits `error`, then `close`; a failed open is not retried. `transcript` is forwarded unchanged,
 * only from the current provider session, only outside a reset and only when the result carries the current
 * identity; `usage` is forwarded from every provider session. `flush()` waits for the admitted frames and any
 * reconnect, then flushes the current provider session; a close of that session during the flush opens no new one.
 * `close()` drops the kept frames, closes the current provider session and emits `close` once.
 *
 * @param inner - The provider each session opens, again on every reconnect.
 * @param config - Passed to the provider with the identity captured when each session opens.
 * @param options - The replay buffer, the attempt bound, the input bound and the clock.
 * @returns The scoped session.
 * @throws {Error} When the provider's first session fails to open, or lacks `pushAudioScoped()` or `reset()`.
 */
export async function openScopedReconnect(inner: IStreamingSTT, config: StreamingSTTConfig & { call: AudioIdentity }, options: ScopedReconnectOptions): Promise<ScopedStreamingSTTSession> {
  const facade = new EventEmitter();
  let identity = structuredClone(config.call);
  let closed = false;
  let resetting = false;
  let flushing = false;
  let current: ScopedStreamingSTTSession;
  let reopening: Promise<void> | undefined;
  let tail = Promise.resolve();
  const attempts: number[] = [];
  const history: ScopedAudioFrame[] = [];
  let historyMs = 0;
  let pendingMs = 0;
  const ms = (frame: ScopedAudioFrame) => frame.samples.length * 1000 / frame.sampleRate;
  const matches = (value: AudioIdentity) => value.scopeId === identity.scopeId && value.callId === identity.callId && value.turnId === identity.turnId && sameVoiceGeneration(value.generation, identity.generation);
  // One operation at a time, in call order: a frame, a reset and a flush each wait for the work before them.
  const run = (work: () => Promise<void>): Promise<void> => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
  const fail = (error: unknown): void => {
    if (closed) return;
    closed = true;
    current?.close();
    facade.emit('error', error instanceof Error ? error : new Error('recognition reconnect failed'));
    facade.emit('close');
  };
  const open = async (): Promise<ScopedStreamingSTTSession> => {
    const captured = structuredClone(identity);
    const raw = await inner.startSession({ ...config, call: captured });
    const candidate = raw as Partial<ScopedStreamingSTTSession>;
    if (closed || !candidate.pushAudioScoped || !candidate.reset) {
      raw.close();
      throw new Error('scoped recognition unavailable');
    }
    // A reset while the session opened: open again with the identity in force now.
    if (!matches(captured)) {
      raw.close();
      return open();
    }
    const session = raw as ScopedStreamingSTTSession;
    await session.reset(captured);
    session.on('transcript', (event: ScopedTranscriptEvent) => {
      if (!closed && session === current && !resetting && matches(event)) facade.emit('transcript', event);
    });
    session.on('usage', (event: unknown) => facade.emit('usage', event));
    session.on('error', () => {
      if (!closed && session === current) void reconnect().catch(fail);
    });
    session.on('close', () => {
      if (!closed && !flushing && session === current) void reconnect().catch(fail);
    });
    return session;
  };
  const reconnect = (): Promise<void> => {
    if (closed) return Promise.reject(new Error('recognition closed'));
    if (reopening) return reopening;
    const started = options.clock();
    while (attempts.length && attempts[0] <= started - 60000) attempts.shift();
    if (attempts.length >= options.maxAttempts) return Promise.reject(new Error('recognition reconnect bound'));
    attempts.push(started);
    reopening = Promise.resolve().then(async () => {
      // The replaced session is no longer current before it closes, so its own close starts no second reconnect.
      const old = current;
      current = undefined as unknown as ScopedStreamingSTTSession;
      old?.close();
      const replacement = await open();
      current = replacement;
      const replay = resetting || historyMs < options.minReplayMs ? [] : history.filter(matches).map((frame) => ({ ...frame, samples: frame.samples.slice() }));
      for (const frame of replay) {
        if (!matches(frame) || closed) break;
        await replacement.pushAudioScoped(frame);
      }
      if (!closed) {
        facade.emit('stt:reconnected', { attempt: attempts.length, replayedMs: replay.reduce((sum, frame) => sum + ms(frame), 0) });
        facade.emit('stt:gap', { attempt: attempts.length, lostMs: Math.max(0, options.clock() - started) });
      }
    }).finally(() => {
      reopening = undefined;
    });
    return reopening;
  };
  current = await open();
  return Object.assign(facade, {
    pushAudio(): void {
      throw new Error('scoped audio required');
    },
    pushAudioScoped(frame: ScopedAudioFrame): Promise<void> {
      if (closed || resetting || !matches(frame)) return Promise.reject(new Error('stale recognition frame'));
      const duration = ms(frame);
      if (!Number.isFinite(duration) || duration <= 0 || pendingMs + duration > options.queueCapacityMs) return Promise.reject(new Error('recognition input bound'));
      pendingMs += duration;
      // The frame is copied at admission, so the caller's later writes reach neither the provider nor a replay.
      const owned = { ...structuredClone(frame), samples: frame.samples.slice() };
      return run(async () => {
        if (reopening) await reopening;
        if (closed || !matches(owned)) throw new Error('stale recognition frame');
        await current.pushAudioScoped(owned);
        history.push(owned);
        historyMs += duration;
        while (historyMs > options.capacityMs && history.length) historyMs -= ms(history.shift()!);
      }).finally(() => {
        pendingMs -= duration;
      });
    },
    reset(next: AudioIdentity): Promise<void> {
      if (closed || next.scopeId !== identity.scopeId || next.callId !== identity.callId) return Promise.reject(new Error('recognition reset refused'));
      identity = structuredClone(next);
      resetting = true;
      history.length = 0;
      historyMs = 0;
      return run(async () => {
        if (reopening) await reopening;
        await current.reset(identity);
      }).finally(() => {
        resetting = false;
      });
    },
    flush(): Promise<void> {
      return run(async () => {
        if (reopening) await reopening;
        if (closed) return;
        flushing = true;
        try {
          await current.flush();
        } finally {
          flushing = false;
        }
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      history.length = 0;
      historyMs = 0;
      current?.close();
      facade.emit('close');
    },
  });
}
