/**
 * @module voice-pipeline/providers/StreamingSTTChain
 *
 * Priority-ordered fallback wrapper around multiple `IStreamingSTT`
 * providers. On `startSession()` the chain tries providers in priority
 * order; the first one whose `startSession()` resolves wins.
 * Init-failure classification records to the circuit breaker so future
 * sessions skip recently-tripped providers without the retry-latency
 * penalty.
 *
 * This file implements Layer 2 of the resilience plan (init-time
 * fallback). Layer 3 (mid-utterance failover via ring buffer) is added
 * in a later task and plugs into the `wrapSession` seam exposed here.
 */

import { EventEmitter } from 'node:events';
import type {
  IStreamingSTT,
  StreamingSTTSession,
  StreamingSTTConfig,
  AudioFrame,
  TranscriptEvent,
} from '../types.js';
import type { HealthyProvider } from '../HealthyProvider.js';
import {
  VoicePipelineError,
  AggregateVoiceError,
  type HealthErrorClass,
} from '../VoicePipelineError.js';
import type { CircuitBreaker } from '../CircuitBreaker.js';
import type {
  VoiceMetricsReporter,
  VoiceMetricEvent,
} from '../VoiceMetricsReporter.js';
import { AudioRingBuffer } from '../AudioRingBuffer.js';
import { TranscriptDedupe } from '../TranscriptDedupe.js';

export interface ProviderSelectedEvent {
  kind: 'stt' | 'tts';
  providerId: string;
  attempt: number;
}

export interface ProviderFailedEvent {
  kind: 'stt' | 'tts';
  providerId: string;
  errorClass: HealthErrorClass;
  message: string;
}

export interface ProviderFailoverEvent {
  kind: 'stt' | 'tts';
  from: string;
  to: string;
  reason: HealthErrorClass;
  lostMs: number;
}

export interface StreamingSTTChainOptions {
  breaker?: CircuitBreaker;
  metrics?: VoiceMetricsReporter;
  onProviderSelected?: (event: ProviderSelectedEvent) => void;
  onProviderFailed?: (event: ProviderFailedEvent) => void;
  onProviderFailover?: (event: ProviderFailoverEvent) => void;
  /** When true, the chain tracks audio via a ring buffer and re-routes to
   *  the next backup on mid-session failure. The session is then the
   *  chain's facade: it forwards transcripts, speech events, `'usage'` and
   *  `'warning'` from its provider sessions, and has no `flush()`.
   *  Default: false. */
  enableMidUtteranceFailover?: boolean;
  /** Ring buffer capacity in ms for mid-utterance replay. Default 3000. */
  ringBufferCapacityMs?: number;
  /** Don't replay audio fragments shorter than this — just advance the
   *  next utterance to the backup. Default 400. */
  minReplayMs?: number;
}

type STTProvider = IStreamingSTT & HealthyProvider;

export class StreamingSTTChain implements IStreamingSTT {
  readonly providerId = 'chain';
  readonly isStreaming = false;

  private readonly _providers: STTProvider[];
  private readonly opts: StreamingSTTChainOptions;
  private activeProviderId?: string;

  constructor(providers: STTProvider[], opts: StreamingSTTChainOptions = {}) {
    if (providers.length === 0) {
      throw new Error('StreamingSTTChain requires at least one provider');
    }
    this._providers = [...providers].sort((a, b) => a.priority - b.priority);
    this.opts = opts;
  }

  /** Providers in priority order (primary first). Exposed for
   *  introspection by host apps and tests. */
  get providers(): readonly STTProvider[] {
    return this._providers;
  }

  get currentProviderId(): string | undefined {
    return this.activeProviderId;
  }

  async startSession(config?: StreamingSTTConfig): Promise<StreamingSTTSession> {
    const candidates = this.filterCandidates();
    if (candidates.length === 0) {
      this.emitMetric({
        type: 'provider_unavailable',
        kind: 'stt',
        checkedProviders: this._providers.map((p) => p.providerId),
      });
      throw new Error('No STT providers available (all tripped or filtered)');
    }

    const attempts: VoicePipelineError[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const provider = candidates[i];
      try {
        const session = await provider.startSession(config);
        this.activeProviderId = provider.providerId;
        const evt: ProviderSelectedEvent = {
          kind: 'stt',
          providerId: provider.providerId,
          attempt: i + 1,
        };
        this.opts.onProviderSelected?.(evt);
        this.emitMetric({ type: 'provider_selected', ...evt });
        this.opts.breaker?.recordSuccess(provider.providerId);
        return this.wrapSession(
          session,
          provider,
          candidates.slice(i + 1),
          config
        );
      } catch (err) {
        const classified = VoicePipelineError.classifyError(err, {
          kind: 'stt',
          provider: provider.providerId,
        });
        attempts.push(classified);
        const failEvt: ProviderFailedEvent = {
          kind: 'stt',
          providerId: provider.providerId,
          errorClass: classified.errorClass,
          message: classified.message,
        };
        this.opts.onProviderFailed?.(failEvt);
        this.emitMetric({ type: 'provider_failed', ...failEvt });
        this.opts.breaker?.recordFailure(
          provider.providerId,
          classified.errorClass
        );
      }
    }

    this.emitMetric({
      type: 'provider_unavailable',
      kind: 'stt',
      checkedProviders: candidates.map((p) => p.providerId),
    });
    throw new AggregateVoiceError(attempts);
  }

  private filterCandidates(): STTProvider[] {
    if (!this.opts.breaker) return this._providers;
    return this._providers.filter((p) =>
      this.opts.breaker!.isAvailable(p.providerId)
    );
  }

  /**
   * Wraps the session returned by a healthy provider. In init-time-only
   * mode (enableMidUtteranceFailover=false) this is a pass-through. In
   * failover mode the session is replaced with a facade that tees audio
   * into a ring buffer, dedupes transcripts across providers, and on
   * session error re-routes to the next candidate. A close the caller asks
   * for ends the session: it starts no backup, and a backup still starting
   * then is closed when it opens. The facade forwards `'transcript'`,
   * `'vad'`, `'speech_start'`, `'speech_end'`, `'usage'` and `'warning'`
   * from its sessions, and has `pushAudio()` and `close()` but no `flush()`:
   * a caller that ends turns with `flush()` runs the chain with failover
   * off, where the session is the provider's own.
   */
  private wrapSession(
    initial: StreamingSTTSession,
    initialProvider: STTProvider,
    candidates: STTProvider[],
    config?: StreamingSTTConfig
  ): StreamingSTTSession {
    if (!this.opts.enableMidUtteranceFailover) return initial;

    const ring = new AudioRingBuffer({
      capacityMs: this.opts.ringBufferCapacityMs ?? 3000,
      sampleRate: 16000,
    });
    const dedupe = new TranscriptDedupe();
    const minReplayMs = this.opts.minReplayMs ?? 400;
    const facade = new EventEmitter();

    let currentSession = initial;
    let currentProvider = initialProvider;
    let remaining = [...candidates];
    let isFailingOver = false;
    // Set by the facade's close(). Every session emits 'close' when it is
    // closed, so a 'close' after this is the end the caller asked for, not a
    // provider failure.
    let closedByCaller = false;

    const attach = (session: StreamingSTTSession, providerId: string) => {
      session.on('transcript', (evt: TranscriptEvent) => {
        const r = dedupe.evaluate({
          provider: providerId,
          text: evt.text,
          audioStartMs: (evt as unknown as { audioStartMs?: number }).audioStartMs ?? 0,
          audioEndMs: (evt as unknown as { audioEndMs?: number }).audioEndMs ?? 0,
          isFinal: evt.isFinal,
        });
        if (r.isDuplicate) return;
        facade.emit('transcript', evt);
      });
      // 'usage' is forwarded from every session attached, a failed one too:
      // a session reports the audio of its connections as it closes.
      for (const passthrough of ['vad', 'speech_start', 'speech_end', 'usage'] as const) {
        session.on(passthrough, (...args: unknown[]) => {
          facade.emit(passthrough, ...args);
        });
      }
      session.on('warning', (warning: Error) => {
        // A provider session prints a warning nobody listens for. Listening
        // here must not silence it, so the facade prints it when its own
        // consumer does not listen either.
        if (facade.listenerCount('warning') > 0) facade.emit('warning', warning);
        else console.warn(`[${providerId}] ${warning.message}`);
      });
      session.on('error', (err: Error) => {
        void tryFailover(err);
      });
      session.on('close', () => {
        // Natural close on the active session is a failover trigger so the
        // user doesn't silently lose voice mid-turn. The close the facade's
        // close() asks for is not: tryFailover returns once closedByCaller
        // is set.
        if (!isFailingOver && currentSession === session) {
          void tryFailover(undefined);
        }
      });
    };

    const tryFailover = async (err?: Error) => {
      if (isFailingOver || closedByCaller) return;
      isFailingOver = true;
      const startedAt = Date.now();
      const classified = VoicePipelineError.classifyError(
        err ?? new Error('session ended'),
        { kind: 'stt', provider: currentProvider.providerId }
      );
      this.opts.breaker?.recordFailure(
        currentProvider.providerId,
        classified.errorClass
      );

      const bufferedFrames = ring.snapshot();
      const bufferedMs = ring.durationMs();

      for (const backup of remaining) {
        if (closedByCaller) break;
        if (
          this.opts.breaker &&
          !this.opts.breaker.isAvailable(backup.providerId)
        ) {
          continue;
        }
        try {
          const session = await backup.startSession(config);
          if (closedByCaller) {
            // The caller closed the session while this backup was starting.
            session.close();
            break;
          }
          attach(session, backup.providerId);
          if (bufferedMs >= minReplayMs) {
            for (const f of bufferedFrames) {
              try {
                await session.pushAudio(f);
              } catch {
                /* tolerate frame-level push failures during replay */
              }
            }
          }
          if (closedByCaller) {
            // The caller closed the session during the replay.
            session.close();
            break;
          }
          currentSession = session;
          currentProvider = backup;
          remaining = remaining.filter((c) => c !== backup);
          this.activeProviderId = backup.providerId;
          const lostMs = Date.now() - startedAt;
          const evt: ProviderFailoverEvent = {
            kind: 'stt',
            from: initialProvider.providerId,
            to: backup.providerId,
            reason: classified.errorClass,
            lostMs,
          };
          this.opts.onProviderFailover?.(evt);
          this.emitMetric({ type: 'provider_failover', ...evt });
          isFailingOver = false;
          return;
        } catch (backupErr) {
          const backClass = VoicePipelineError.classifyError(backupErr, {
            kind: 'stt',
            provider: backup.providerId,
          });
          this.opts.breaker?.recordFailure(
            backup.providerId,
            backClass.errorClass
          );
        }
      }

      if (closedByCaller) {
        isFailingOver = false;
        return;
      }
      // All backups exhausted — propagate to the facade consumer.
      facade.emit('error', new AggregateVoiceError([classified]));
      isFailingOver = false;
    };

    attach(initial, initialProvider.providerId);

    // The returned object must conform to StreamingSTTSession (EventEmitter
    // with pushAudio + close). We build that explicitly so TS sees the
    // right shape.
    const wrapped = Object.assign(facade, {
      providerId: 'chain',
      pushAudio: async (frame: AudioFrame) => {
        ring.push(frame);
        try {
          await currentSession.pushAudio(frame);
        } catch (pushErr) {
          void tryFailover(pushErr as Error);
        }
      },
      close: async () => {
        closedByCaller = true;
        await currentSession.close();
      },
    }) as unknown as StreamingSTTSession;

    return wrapped;
  }

  private emitMetric(event: VoiceMetricEvent): void {
    this.opts.metrics?.emit(event);
  }
}
