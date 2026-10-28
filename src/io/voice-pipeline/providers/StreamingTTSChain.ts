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
 * fails as it takes the text is passed over for the next one. From the moment
 * the session in use fails, nothing it emits reaches the facade: a provider
 * that completes its flush as it reports a lost connection leaves the text to
 * the backup. A `cancel()` during the switch cuts the request and not the
 * switch: the backup takes the text admitted after it, none of the cut
 * request's, and a `writeTokens()` that waited on the switch when the cancel
 * came admits nothing. Under a `ProviderPolicy` a request that has already
 * produced audio is never sent again: the facade fails rather than repeat
 * speech the listener may have heard. Under the legacy policy the text is
 * sent again either way.
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
   * it forwards `'audio'`, `'flush_complete'` and `'warning'` from the
   * provider session in use (under a `ProviderPolicy` a warning arrives as
   * `Error('provider warning')`, without the provider's text, and one nobody
   * listens for is not printed) and `'usage'` from every provider session it
   * attached. From the moment a failure of the session in use begins a
   * switch, nothing that session emits is forwarded but its `'usage'`, though
   * the switch takes it out of use only in a later promise job: a provider
   * that reports a lost connection as `'error'` and then, in the same call,
   * sends out the frame it held and completes its flush, as
   * `DeepgramAuraStreamingTTS` does, does not end the request, and the backup
   * takes its text. A backup that fails as it takes the
   * text (an `'error'` or a `'close'`, or a write it refuses) is recorded as
   * failed and closed, and the next provider is tried; from the moment its
   * failure is recorded, nothing it emits is forwarded but its `'usage'`, so a
   * backup that reports a lost connection and completes its flush in one call
   * leaves the text to the next provider. An `'error'` carries no request, so
   * the facade reads it by when it arrives. After a `cancel()` an `'error'` of
   * the session in use is the cut request's until the next request's text is
   * admitted; a backup the cancel reached during the switch keeps that until
   * the switch ends or another backup is attached, though the next request's
   * text has come, as a write the cancel cut reports it, and is passed over
   * only when it refuses a write of that text or closes. A backup that really
   * fails in that window, reporting `'error'` with no `'close'` and refusing
   * no write, stays in use, and a `flush()` that waits on its flush may never
   * complete; a host that sees that closes the facade and starts a new
   * session. An `'error'` after that, once the switch has ended and the next
   * request's text has come, is the session's own failure and begins a
   * switch. Text pushed during a
   * switch goes to the backup: the replay sends what comes before the backup
   * has taken it, and what comes after goes straight to it. A `cancel()` cuts
   * the request and not a switch under way, since the facade still needs a
   * provider for the next request: the backup takes the text admitted after
   * the cancel and none of the cut request's, and a `writeTokens()` that
   * waited on the switch when the cancel came admits nothing and resolves, as
   * a write the cancel cut in flight does. A provider close after
   * `flush_complete`, after its `flush()` resolved or after `cancel()` ends
   * the facade with one `'close'`; a close while its flush is still under way
   * is a failure like any other. A `flush()` counts for the request it began
   * alone: the flush of a cut request that settles once the next request has
   * begun ends nothing of that request, and a close during it is a failure.
   * The facade's `flush()` resolves once the session in use has completed its
   * flush: it waits for a switch under way, and for the next one when the
   * backup fails as its switch ends, and then flushes the backup that took
   * the text, without waiting for the failed provider's own flush to settle;
   * the `flush()` of a request a `cancel()` cut ends then and flushes
   * nothing, since the backup's `flush_complete` would end the next request
   * before its text has all come. A switch no provider can take
   * ends the facade with `'error'` (only to a listener) and then `'close'`;
   * a `flush()` that waited for it rejects with `synthesis failed`, and text
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
   * text, or refuses a write of it, is recorded as failed and closed, and the next remaining provider is opened (an
   * error it reports after a `cancel()` reached it, until the switch ends or another backup is attached, is the cut
   * request's and no failure); so is one without the pull contract when the audio goes to a sink, but without a
   * recorded failure. The active session's warnings reach the facade, as `Error('provider warning')` under a
   * `ProviderPolicy`. Audio,
   * `flush_complete`, warnings and errors of a session that is no longer active never reach the facade; its `usage`
   * reports do. A session is no longer active from the moment its failure begins a switch, though the switch takes it
   * out of use only in a later promise job, so what it emits in the same call as its error, as a frame it held and the
   * `flush_complete` of its flush, ends nothing and goes nowhere. `close()` stops a switch under way, and a backup that
   * opens after it is cancelled and closed. `cancel()` cuts the request and not the switch: the switch goes on, the
   * backup takes the text admitted since the cancel, and a replay under way when it comes starts over on that text.
   * `cancel()` and `close()` advance an epoch; a flush ends without flushing once the epoch it began in has passed,
   * so the flush of a cut request completes nothing of the next one, and a `writeTokens()` that waited on a switch
   * admits nothing and resolves once the epoch it was issued in has passed, as a write the cancel cut in flight does,
   * while after `close()` it throws `synthesis closed`. Text pushed during a switch waits while
   * the replay is the backup's to send, and goes straight to the backup once it has taken the replay. With the pull
   * contract (`setAudioSink()` and `writeTokens()`), audio flows only through the sink, and a chunk emitted as
   * `'audio'` as well ends the facade.
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
    // Advanced by cancel() and close(): a flush ends once the epoch it began in has passed, so the flush of a cut
    // request completes nothing of the next one, and a replay under way when a cancel comes starts over on the text
    // admitted since.
    let epoch = 0;
    let flushed = false;
    let switching: Promise<void> | undefined;
    // Set while the switch under way sends the backup the text the facade keeps: text pushed meanwhile is the replay's.
    let replaying = false;
    // The session whose failure began the switch under way. The switch takes it out of use only in a later promise job,
    // so until then it is still `current`, and what it emits from the moment of its failure is not the facade's: a
    // provider that reports a lost connection as 'error' and then, in the same call, sends out the frame it held and
    // completes its flush, as DeepgramAuraStreamingTTS does, would end the request as spoken, and the backup would take
    // none of its text.
    let failed: StreamingTTSSession | undefined;
    // An error or close of the backup a switch has attached, reported before the switch ended; the switch passes over it.
    let lost: Error | undefined;
    // A session is out of use from the moment its failure is recorded: the one whose failure began the switch under way,
    // and the backup that switch attached once a failure of its own is recorded in `lost`, though it is still `current`
    // until the switch passes over it. A backup that reports a lost connection and completes its flush in one call, as it
    // takes text pushed after the replay, would otherwise end the request as spoken and clear the text the next provider
    // takes.
    const failedNow = (session: StreamingTTSSession): boolean =>
      switching !== undefined && (session === failed || (lost !== undefined && session === current));
    // Set when cancel() comes during a switch, once its backup is attached: until the switch ends or attaches another
    // backup, an error that backup reports is the cut request's, as a write the cancel cut reports it, though the next
    // request's text has come. The replay finds a backup that has really failed when it refuses that text's write, or
    // closes; one that fails with an error alone in that window stays in use, the cost of not ending the next request on
    // the cut's error.
    let cutInSwitch = false;
    let sink: ((chunk: EncodedAudioChunk) => Promise<void>) | undefined;
    // A promise the facade settles itself.
    const deferred = (): { promise: Promise<void>; resolve: () => void } => {
      let resolve: () => void = () => {};
      const promise = new Promise<void>((settle) => {
        resolve = () => settle();
      });
      return { promise, resolve };
    };
    // Settles when the facade lets go of the session in use, as a switch starts or the facade ends, and is then
    // replaced: a flush waits on that session's own flush only until then, since a provider whose connection dropped
    // mid-flush may never settle it.
    let leaving = deferred();
    const letGo = (): void => {
      leaving.resolve();
      leaving = deferred();
    };
    const finish = (): void => {
      if (closed) return;
      closed = true;
      tokens = [];
      characters = 0;
      letGo();
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
        if (closed || cancelled || current !== session || failedNow(session)) throw new Error('stale synthesis');
        emittedAudio = true;
        await sink!(chunk);
      });
    };
    const attach = (session: StreamingTTSSession): void => {
      const id = provider.providerId;
      // A failure the session in use goes on after, such as a socket that failed to open for a reply: the caller learns
      // from it that some of the reply may never have been spoken. A provider session prints a warning nobody listens
      // for; the legacy facade does the same, and a strict policy's facade forwards no provider text.
      session.on('warning', (warning: Error) => {
        if (closed || current !== session || failedNow(session)) return;
        if (facade.listenerCount('warning')) facade.emit('warning', this.policy.mode === 'legacy' ? warning : new Error('provider warning'));
        else if (this.policy.mode === 'legacy') console.warn('[' + id + '] ' + warning.message);
      });
      session.on('audio', (chunk: EncodedAudioChunk) => {
        if (closed || cancelled || current !== session || failedNow(session)) return;
        if (sink) {
          fatal(new Error('producer emitted duplicate audio'));
          return;
        }
        emittedAudio = true;
        facade.emit('audio', chunk);
      });
      session.on('usage', (event: unknown) => facade.emit('usage', event));
      session.on('flush_complete', () => {
        if (!closed && !cancelled && current === session && !failedNow(session)) {
          flushed = true;
          tokens = [];
          characters = 0;
          facade.emit('flush_complete');
        }
      });
      // During a switch the active session is the backup taking the replay: its failure is left for the switch.
      session.on('error', (error: Error) => {
        if (closed || cancelled || current !== session) return;
        if (switching) {
          if (!cutInSwitch) lost ??= error;
        } else begin(error);
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
    // A switch stops only when the facade ends. A cancel() cuts the request, not the failure that began the switch: the
    // facade still needs a provider for the next request, whose text the backup takes.
    const failover = async (error: Error): Promise<void> => {
      if (closed) return;
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
        if (closed) return;
        if (this.opts.breaker && !this.opts.breaker.isAvailable(backup.providerId)) continue;
        await authorizeProviderOpening(this.policy, 'tts', from.providerId, backup.providerId, 'mid_session_failure', config?.call);
        if (closed) return;
        let next: StreamingTTSSession;
        try {
          next = await backup.startSession(config);
        } catch (error) {
          const failure = VoicePipelineError.classifyError(error, { kind: 'tts', provider: backup.providerId });
          this.opts.breaker?.recordFailure(backup.providerId, failure.errorClass);
          continue;
        }
        if (closed) {
          discard(next);
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
        // a backup attached after the cut never took its text, so an error it reports is its own
        cutInSwitch = false;
        provider = backup;
        remaining = remaining.filter((p) => p !== backup);
        attach(next);
        // The index observes tokens admitted during opening and during the replay as well; admission remains
        // character-bounded. A cancel() during the replay cuts what the backup took, as the session in use, and the
        // replay starts over on the text admitted since; a write refused after that cancel is the cut's, as a write of
        // the facade's own is, and not the backup's failure.
        replaying = true;
        try {
          for (let i = 0, request = epoch; !closed && !lost; ) {
            if (request !== epoch) {
              request = epoch;
              i = 0;
            }
            if (i >= tokens.length) break;
            const text = tokens[i++]!;
            try {
              if (sink) await next.writeTokens!(text);
              else next.pushTokens(text);
            } catch (error) {
              if (request === epoch) lost ??= error instanceof Error ? error : new Error('TTS write failed');
            }
          }
        } finally {
          replaying = false;
        }
        if (closed) return;
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
    // A failure of the session in use begins a switch, unless the facade has ended, a switch is under way, which takes
    // the failures of the backup it attached, or the request was cut: a failure reported after cancel(), such as a write
    // the cancel refused, is the cut's own.
    const begin = (error: Error): void => {
      if (closed || cancelled || switching) return;
      start(error);
    };
    const start = (error: Error): void => {
      failed = current;
      cutInSwitch = false;
      switching = Promise.resolve().then(() => failover(error)).catch((error: unknown) => fatal(error instanceof Error ? error : new Error('TTS failed'))).finally(() => {
        switching = undefined;
        cutInSwitch = false;
        // The backup failed after its replay, before the switch ended: the next switch starts from it, whatever was cut
        // since, as a backup that fails as it takes the text is passed over. Returned here, that switch keeps this one
        // unsettled until it settles, so flush() and writeTokens(), which wait on the switch, resume only once none is
        // under way.
        const late = lost;
        lost = undefined;
        if (late && current) start(late);
        return switching;
      });
      // The facade lets go of the session that failed: a flush waiting on that session's own flush goes on to the
      // switch.
      letGo();
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
      // During a switch the text waits while the session that failed is still the one in use, while the backup opens and
      // while the replay sends the backup the text the facade keeps, which takes this text too; once the backup has
      // taken the replay, before the switch has ended, the text goes straight to it, as after the switch.
      pushTokens: (text: string): void => {
        admit(text);
        if (!current || replaying || failedNow(current)) return;
        try {
          current.pushTokens(text);
        } catch (error) {
          const failure = error instanceof Error ? error : new Error('TTS write failed');
          // A backup that refuses it before the switch has ended is passed over, as one that fails as it takes the text.
          if (switching) lost ??= failure;
          else begin(failure);
        }
      },
      // The request counts as flushed only once the session in use completed its flush with no switch since; a
      // failure, a close or a refused flush of it switches, and the backup that took the text is flushed instead,
      // without waiting for the failed session's own flush to settle. A switch the flush waited for, here or below,
      // that ended the facade fails the flush. The flush waits only while a switch is under way and does not yield
      // otherwise: a switch that began during a yield would leave it flushing the session that failed, past the signal
      // that lets go of it. A cancel() since the flush began cut its request: the flush ends there, flushing nothing of
      // the next request, whose text may not all have come, and counting none of it as flushed.
      flush: async (): Promise<void> => {
        const request = epoch;
        let waited = false;
        while (switching) {
          waited = true;
          await switching;
        }
        if (closed) {
          if (waited && faulted) throw new Error('synthesis failed');
          return;
        }
        if (cancelled || epoch !== request || !current) return;
        for (;;) {
          const session: StreamingTTSSession = current;
          const left = leaving.promise;
          let failure: Error | undefined;
          try {
            await Promise.race([session.flush(), left]);
          } catch (error) {
            failure = error instanceof Error ? error : new Error('TTS flush failed');
          }
          if (closed) {
            if (faulted) throw new Error('synthesis failed');
            return;
          }
          if (cancelled || epoch !== request) return;
          if (session === current && !switching) {
            if (!failure) {
              flushed = true;
              return;
            }
            begin(failure);
          }
          while (switching) await switching;
          if (closed) {
            if (faulted) throw new Error('synthesis failed');
            return;
          }
          if (cancelled || epoch !== request || !current) return;
        }
      },
      cancel: (): void => {
        if (closed) return;
        cancelled = true;
        // only a backup the switch has attached can have taken text of the request cut here and report its cut
        if (switching && current !== undefined && current !== failed) cutInSwitch = true;
        // The cut request's audio is no request's any more: a switch under way sends none of its text again, so under a
        // ProviderPolicy it repeats nothing the listener heard.
        emittedAudio = false;
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
      // A write that waited on a switch was issued before any cancel() that came meanwhile, so it is the cut request's:
      // it admits nothing and resolves, as a write the cancel cut in flight does; after close() it throws, as any write.
      writeTokens: async (text: string): Promise<void> => {
        const request = epoch;
        await switching;
        if (!closed && epoch !== request) return;
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
