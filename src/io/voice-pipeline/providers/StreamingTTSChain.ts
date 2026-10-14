/**
 * @module voice-pipeline/providers/StreamingTTSChain
 *
 * Fallback wrapper around several `IStreamingTTS` providers, the outbound
 * counterpart of `StreamingSTTChain`. `startSession()` tries the chain's
 * providers in the order its provider policy gives and returns the first
 * session that opens; under a `ProviderPolicy` each opening is authorized
 * first, and a refused authorization opens nothing.
 *
 * With `enableMidSynthesisFailover`, a session is the chain's facade. It keeps
 * the text admitted since the last `flush_complete` or `cancel()`, at most
 * `maxReplayCharacters` of it, and when the session in use fails it opens the
 * next provider the policy permits and sends that text again; a backup that
 * fails as it takes the text is passed over for the next one. Under a
 * `ProviderPolicy` a request that has already produced audio is never sent
 * again: the facade fails rather than repeat speech the listener may have
 * heard. Under the legacy policy the text is sent again either way.
 */

import { EventEmitter } from 'node:events';
import type { IStreamingTTS, StreamingTTSSession, StreamingTTSConfig, EncodedAudioChunk } from '../types.js';
import type { HealthyProvider } from '../HealthyProvider.js';
import { VoicePipelineError, AggregateVoiceError, type HealthErrorClass } from '../VoicePipelineError.js';
import type { CircuitBreaker } from '../CircuitBreaker.js';
import type { VoiceMetricsReporter, VoiceMetricEvent } from '../VoiceMetricsReporter.js';
import { authorizeProviderOpening, freezeProviderPolicy, legacyProviderPolicy, selectPolicyProviders, type ProviderSelectionPolicy } from '../ProviderPolicy.js';

/** Existing TTS selection event. */
export interface TTSProviderSelectedEvent {
  /** Always `'tts'`. */
  kind: 'tts';
  /** The provider whose session opened. */
  providerId: string;
  /** Its place among the providers tried, from 1. */
  attempt: number;
}

/** Strict policies redact provider errors before metrics. */
export interface TTSProviderFailedEvent {
  /** Always `'tts'`. */
  kind: 'tts';
  /** The provider whose opening failed. */
  providerId: string;
  /** The failure's class, as `VoicePipelineError.classifyError` reads it. */
  errorClass: HealthErrorClass;
  /** The provider's message under the legacy policy; `provider opening failed` under a strict one. */
  message: string;
}

/** Existing switch event, retained beside the policy's scoped tariff event. */
export interface TTSProviderFailoverEvent {
  /** Always `'tts'`. */
  kind: 'tts';
  /** The provider whose session failed. */
  from: string;
  /** The provider that took over. */
  to: string;
  /** The class of the failure that started the switch. */
  reason: HealthErrorClass;
  /** Milliseconds the switch took. */
  lostMs: number;
}

/** Health, replay and explicit selection controls. */
export interface StreamingTTSChainOptions {
  /** Skips providers it reports unavailable; failed openings and failed sessions are recorded to it. */
  breaker?: CircuitBreaker;
  /** Receives the chain's `provider_selected`, `provider_failed`, `provider_failover` and `provider_unavailable` events. */
  metrics?: VoiceMetricsReporter;
  /** Called when a session opens. */
  onProviderSelected?: (event: TTSProviderSelectedEvent) => void;
  /** Called when a provider's opening fails. */
  onProviderFailed?: (event: TTSProviderFailedEvent) => void;
  /** Called when the facade has moved to a backup during a session. */
  onProviderFailover?: (event: TTSProviderFailoverEvent) => void;
  /**
   * When true, the chain keeps the text admitted since the last
   * `flush_complete` or `cancel()` and re-submits it to the next provider the
   * policy permits when the session in use fails. Under a `ProviderPolicy`
   * that happens only while the text has produced no audio; a failure after
   * audio ends the facade instead. The session is then the chain's facade:
   * it forwards `'audio'` and
   * `'flush_complete'` from the provider session in use and `'usage'` from
   * every provider session it attached. A backup that fails as it takes the
   * text (an `'error'` or a `'close'`, or a write it refuses) is recorded as
   * failed and closed, and the next provider is tried. A provider close after
   * `flush_complete`, after its `flush()` resolved or after `cancel()` ends
   * the facade with one `'close'`; a close while its flush is still under way
   * is a failure like any other. The facade's `flush()` resolves once the
   * session in use has completed its flush, and after a switch it flushes
   * the backup that took the text. A switch no provider can take ends the
   * facade with `'error'` (only to a listener) and then `'close'`; a
   * `flush()` that waited for it rejects with `synthesis failed`, and text
   * pushed after that throws. When the first session implements
   * `setAudioSink()` and `writeTokens()`, so does the facade; a backup that
   * does not is closed, without a recorded failure, and the next provider is
   * tried.
   */
  enableMidSynthesisFailover?: boolean;
  /**
   * The provider policy. Default: `legacyProviderPolicy`, every provider in
   * priority order with no authorization. A `ProviderPolicy` is validated and
   * copied when the chain is built.
   */
  policy?: ProviderSelectionPolicy;
  /** Characters of text the facade keeps for a replay; `pushTokens()` and `writeTokens()` throw past it. Default 65536. */
  maxReplayCharacters?: number;
}

type TTSProvider = IStreamingTTS & HealthyProvider;

/** Existing synthesis chain with awaited authorization and bounded replay. */
export class StreamingTTSChain implements IStreamingTTS {
  /** Always `'chain'`. */
  readonly providerId = 'chain';
  private readonly list: TTSProvider[];
  private readonly policy: ProviderSelectionPolicy;
  private activeProviderId?: string;

  /**
   * @param providers - The configured providers; under a `ProviderPolicy`, one instance for each permitted provider id.
   * @param opts - Health, replay and selection options.
   * @throws {Error} For no provider, a policy `freezeProviderPolicy` refuses or one that does not permit `'tts'`, a
   *   permitted provider with no configured instance or more than one, or a `maxReplayCharacters` that is not a
   *   positive safe integer.
   */
  constructor(providers: TTSProvider[], private readonly opts: StreamingTTSChainOptions = {}) {
    if (!providers.length) throw new Error('StreamingTTSChain requires at least one provider');
    this.policy = freezeProviderPolicy(opts.policy ?? legacyProviderPolicy);
    this.list = selectPolicyProviders(providers, this.policy, 'tts');
    if (!Number.isSafeInteger(opts.maxReplayCharacters ?? 65536) || (opts.maxReplayCharacters ?? 65536) <= 0) throw new Error('invalid synthesis replay bound');
  }

  /** Policy order, or legacy priority order. */
  get providers(): readonly TTSProvider[] {
    return this.list;
  }

  /** Most recently opened provider. */
  get currentProviderId(): string | undefined {
    return this.activeProviderId;
  }

  private metric(event: VoiceMetricEvent): void {
    this.opts.metrics?.emit(event);
  }

  /**
   * Authorizes every initialization attempt, including an otherwise healthy fallback.
   *
   * @param config - Passed to each provider tried; its `call` identity is the identity each opening is authorized for.
   * @returns The provider's own session, or the chain's facade with `enableMidSynthesisFailover`.
   * @throws {Error} The policy's refusal, which opens no provider and tries no other; `No TTS providers available
   *   (all tripped or filtered)` when the breaker skips every provider; an `AggregateVoiceError` when every provider
   *   tried failed to open.
   */
  async startSession(config?: StreamingTTSConfig): Promise<StreamingTTSSession> {
    const candidates = this.list.filter((p) => !this.opts.breaker || this.opts.breaker.isAvailable(p.providerId));
    const errors: VoicePipelineError[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const provider = candidates[i]!;
      const from = i ? candidates[i - 1]!.providerId : (provider !== this.list[0] ? this.list[0]?.providerId : undefined);
      await authorizeProviderOpening(this.policy, 'tts', from, provider.providerId, i ? 'initialization_failed' : from ? 'unavailable' : 'primary', config?.call);
      try {
        const session = await provider.startSession(config);
        this.activeProviderId = provider.providerId;
        const event: TTSProviderSelectedEvent = { kind: 'tts', providerId: provider.providerId, attempt: i + 1 };
        this.opts.onProviderSelected?.(event);
        this.metric({ type: 'provider_selected', ...event });
        this.opts.breaker?.recordSuccess(provider.providerId);
        return this.wrap(session, provider, candidates.slice(i + 1), config);
      } catch (error) {
        const failure = VoicePipelineError.classifyError(error, { kind: 'tts', provider: provider.providerId });
        errors.push(failure);
        const event: TTSProviderFailedEvent = { kind: 'tts', providerId: provider.providerId, errorClass: failure.errorClass, message: this.policy.mode === 'legacy' ? failure.message : 'provider opening failed' };
        this.opts.onProviderFailed?.(event);
        this.metric({ type: 'provider_failed', ...event });
        this.opts.breaker?.recordFailure(provider.providerId, failure.errorClass);
      }
    }
    this.metric({ type: 'provider_unavailable', kind: 'tts', checkedProviders: this.list.map((p) => p.providerId) });
    if (!errors.length) throw new Error('No TTS providers available (all tripped or filtered)');
    throw new AggregateVoiceError(errors);
  }

  /**
   * Wraps the session a provider opened. With failover off the session is returned as it is. Otherwise the facade
   * admits text within `maxReplayCharacters` and, on the active session's error, or its close before its flush
   * completed or `cancel()`, cancels and closes it, opens the next remaining provider (authorized first under a
   * `ProviderPolicy`) and sends it the admitted text. A backup that reports an error or a close while it takes that
   * text, or refuses a write of it, is recorded as failed and closed, and the next remaining provider is opened; so
   * is one without the pull contract when the audio goes to a sink, but without a recorded failure. Audio,
   * `flush_complete` and errors of a session that is no longer active never reach the facade; its `usage` reports
   * do. `cancel()` and `close()` advance an epoch, so a switch begun before them stops, and a backup that opens after
   * them is cancelled and closed. With the pull contract (`setAudioSink()` and `writeTokens()`), audio flows only
   * through the sink, and a chunk emitted as `'audio'` as well ends the facade.
   */
  private wrap(initial: StreamingTTSSession, first: TTSProvider, candidates: TTSProvider[], config?: StreamingTTSConfig): StreamingTTSSession {
    if (!this.opts.enableMidSynthesisFailover) return initial;
    const facade = new EventEmitter();
    let current: StreamingTTSSession | undefined = initial;
    let provider = first;
    let remaining = [...candidates];
    let tokens: string[] = [];
    let characters = 0;
    let emittedAudio = false;
    let closed = false;
    // The facade ended on a failure (fatal), not on a close the caller asked for or one after a completed flush.
    let faulted = false;
    let cancelled = false;
    let epoch = 0;
    let flushed = false;
    let switching: Promise<void> | undefined;
    // An error or close of the backup a switch has attached, reported before the switch ended; the switch passes over it.
    let lost: Error | undefined;
    let sink: ((chunk: EncodedAudioChunk) => Promise<void>) | undefined;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      tokens = [];
      characters = 0;
      facade.emit('close');
    };
    const fatal = (error: Error): void => {
      if (closed) return;
      faulted = true;
      try {
        if (facade.listenerCount('error')) facade.emit('error', error);
      } finally {
        const old = current;
        current = undefined;
        finish();
        try {
          old?.cancel();
          old?.close();
        } catch {
          /* terminal cleanup continues */
        }
      }
    };
    // Each session's chunks pass through the caller's sink; one from a session that is no longer the active one is refused.
    const bindSink = (session: StreamingTTSSession): void => {
      if (!sink) return;
      if (!session.setAudioSink || !session.writeTokens) throw new Error('fallback lacks awaited producer');
      session.setAudioSink(async (chunk) => {
        if (closed || cancelled || current !== session) throw new Error('stale synthesis');
        emittedAudio = true;
        await sink!(chunk);
      });
    };
    const attach = (session: StreamingTTSSession): void => {
      session.on('audio', (chunk: EncodedAudioChunk) => {
        if (closed || cancelled || current !== session) return;
        if (sink) {
          fatal(new Error('producer emitted duplicate audio'));
          return;
        }
        emittedAudio = true;
        facade.emit('audio', chunk);
      });
      session.on('usage', (event: unknown) => facade.emit('usage', event));
      session.on('flush_complete', () => {
        if (!closed && !cancelled && current === session) {
          flushed = true;
          tokens = [];
          characters = 0;
          facade.emit('flush_complete');
        }
      });
      // During a switch the active session is the backup taking the replay: its failure is left for the switch.
      session.on('error', (error: Error) => {
        if (closed || cancelled || current !== session) return;
        if (switching) lost ??= error;
        else begin(error);
      });
      session.on('close', () => {
        if (closed || current !== session) return;
        if (switching) {
          lost ??= new Error('provider closed');
          return;
        }
        if (flushed || cancelled) {
          current = undefined;
          finish();
        } else begin(new Error('provider closed'));
      });
      bindSink(session);
    };
    // Cancels and closes a backup the switch passes over; a throw there does not stop the switch.
    const discard = (session: StreamingTTSSession): void => {
      try {
        session.cancel();
        session.close();
      } catch {
        /* the switch goes on to the next provider */
      }
    };
    const failover = async (error: Error, capturedEpoch: number): Promise<void> => {
      if (closed || cancelled || capturedEpoch !== epoch) return;
      const from = provider;
      const failure = VoicePipelineError.classifyError(error, { kind: 'tts', provider: from.providerId });
      this.opts.breaker?.recordFailure(from.providerId, failure.errorClass);
      if (this.policy.mode !== 'legacy' && emittedAudio) throw new Error('partial synthesis cannot be replayed');
      const started = Date.now();
      const old = current;
      current = undefined;
      lost = undefined;
      old?.cancel();
      old?.close();
      for (const backup of remaining) {
        if (closed || cancelled || capturedEpoch !== epoch) return;
        if (this.opts.breaker && !this.opts.breaker.isAvailable(backup.providerId)) continue;
        await authorizeProviderOpening(this.policy, 'tts', from.providerId, backup.providerId, 'mid_session_failure', config?.call);
        if (closed || cancelled || capturedEpoch !== epoch) return;
        let next: StreamingTTSSession;
        try {
          next = await backup.startSession(config);
        } catch (error) {
          const failure = VoicePipelineError.classifyError(error, { kind: 'tts', provider: backup.providerId });
          this.opts.breaker?.recordFailure(backup.providerId, failure.errorClass);
          continue;
        }
        if (closed || cancelled || capturedEpoch !== epoch) {
          next.cancel();
          next.close();
          return;
        }
        // Audio that goes to a sink needs a backup with the pull contract. One without it opened and did nothing
        // wrong, so no failure is recorded: it is closed and left out of this facade's later switches.
        if (sink && (!next.setAudioSink || !next.writeTokens)) {
          remaining = remaining.filter((p) => p !== backup);
          discard(next);
          continue;
        }
        current = next;
        provider = backup;
        remaining = remaining.filter((p) => p !== backup);
        attach(next);
        // The index observes tokens admitted during opening as well; admission remains character-bounded.
        try {
          for (let i = 0; i < tokens.length && !lost; i++) {
            if (closed || cancelled || capturedEpoch !== epoch) return;
            if (sink) await next.writeTokens!(tokens[i]!);
            else next.pushTokens(tokens[i]!);
          }
        } catch (error) {
          lost ??= error instanceof Error ? error : new Error('TTS write failed');
        }
        if (closed || cancelled || capturedEpoch !== epoch) return;
        if (lost) {
          // The backup failed as it took the text: it is recorded and closed, and the next provider is tried, unless
          // what it already played may not be repeated.
          const failed = VoicePipelineError.classifyError(lost, { kind: 'tts', provider: backup.providerId });
          this.opts.breaker?.recordFailure(backup.providerId, failed.errorClass);
          lost = undefined;
          current = undefined;
          discard(next);
          if (this.policy.mode !== 'legacy' && emittedAudio) throw new Error('partial synthesis cannot be replayed');
          continue;
        }
        this.activeProviderId = backup.providerId;
        this.opts.breaker?.recordSuccess(backup.providerId);
        const event: TTSProviderFailoverEvent = { kind: 'tts', from: from.providerId, to: backup.providerId, reason: failure.errorClass, lostMs: Date.now() - started };
        this.opts.onProviderFailover?.(event);
        this.metric({ type: 'provider_failover', ...event });
        return;
      }
      throw new AggregateVoiceError([failure]);
    };
    const begin = (error: Error): void => {
      if (closed || cancelled || switching) return;
      const capturedEpoch = epoch;
      switching = Promise.resolve().then(() => failover(error, capturedEpoch)).catch((error: unknown) => fatal(error instanceof Error ? error : new Error('TTS failed'))).finally(() => {
        switching = undefined;
        // The backup failed after its replay, before the switch ended: the next switch starts from it.
        const late = lost;
        lost = undefined;
        if (late && current) begin(late);
      });
    };
    // A request starts anew after a cancel or a completed flush: its text has produced no audio yet.
    const admit = (text: string): void => {
      if (closed) throw new Error('synthesis closed');
      if (cancelled) {
        cancelled = false;
        emittedAudio = false;
      }
      if (flushed) {
        emittedAudio = false;
        flushed = false;
      }
      if (characters + text.length > (this.opts.maxReplayCharacters ?? 65536)) throw new Error('synthesis replay bound');
      characters += text.length;
      tokens.push(text);
    };
    attach(initial);
    const wrapped: StreamingTTSSession = Object.assign(facade, {
      pushTokens: (text: string): void => {
        admit(text);
        if (switching || !current) return;
        try {
          current.pushTokens(text);
        } catch (error) {
          begin(error instanceof Error ? error : new Error('TTS write failed'));
        }
      },
      // The request counts as flushed only once the session in use completed its flush with no switch since; a
      // failure, a close or a refused flush of it switches, and the backup that took the text is flushed instead.
      flush: async (): Promise<void> => {
        await switching;
        if (closed || cancelled || !current) return;
        for (;;) {
          const session: StreamingTTSSession = current;
          let failure: Error | undefined;
          try {
            await session.flush();
          } catch (error) {
            failure = error instanceof Error ? error : new Error('TTS flush failed');
          }
          if (closed) {
            if (faulted) throw new Error('synthesis failed');
            return;
          }
          if (cancelled) return;
          if (session === current && !switching) {
            if (!failure) {
              flushed = true;
              return;
            }
            begin(failure);
          }
          await switching;
          if (closed) {
            if (faulted) throw new Error('synthesis failed');
            return;
          }
          if (cancelled || !current) return;
        }
      },
      cancel: (): void => {
        if (closed) return;
        cancelled = true;
        epoch++;
        tokens = [];
        characters = 0;
        current?.cancel();
      },
      close: (): void => {
        if (closed) return;
        epoch++;
        const old = current;
        current = undefined;
        finish();
        old?.close();
      },
    });
    if (initial.setAudioSink && initial.writeTokens) Object.assign(wrapped, {
      setAudioSink: (nextSink: (chunk: EncodedAudioChunk) => Promise<void>): void => {
        sink = nextSink;
        if (current) bindSink(current);
      },
      writeTokens: async (text: string): Promise<void> => {
        await switching;
        admit(text);
        if (!current) throw new Error('synthesis unavailable');
        try {
          if (!current.writeTokens) throw new Error('awaited producer required');
          await current.writeTokens(text);
        } catch (error) {
          begin(error instanceof Error ? error : new Error('TTS write failed'));
          await switching;
          if (closed) throw new Error('synthesis failed');
        }
        await switching;
        if (closed) throw new Error('synthesis failed');
      },
    });
    return wrapped;
  }
}
