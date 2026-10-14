/**
 * @module voice-pipeline/providers/StreamingSTTChain
 *
 * Fallback wrapper around several `IStreamingSTT` providers. `startSession()`
 * tries the chain's providers in order and returns the first session that
 * opens; a `CircuitBreaker` in the options skips providers that failed
 * recently, and every failed opening is recorded to it.
 *
 * The chain names each provider by its `providerId` in its breaker, its
 * dedupe and its events, and two providers with the same id, such as two
 * sizes of `MoonshineBrowserSTT` (`moonshine-browser`), by that id and their
 * place among the providers that share it, from 1 in the chain's order
 * (`moonshine-browser#1`, `moonshine-browser#2`), so they keep apart.
 * `currentProviderId` and a `ProviderPolicy` read the provider's own id.
 *
 * The chain's provider policy decides the order and whether the chain may
 * move on. Without a policy, or with `legacyProviderPolicy`, every provider is
 * tried in priority order (lower first). A `ProviderPolicy` keeps the
 * providers it permits for `'stt'`, in its own order: only `local` ones in
 * `local` mode, and only the first under `fallback: 'none'`. Every opening is
 * then authorized first, the first choice, a provider tried after an earlier
 * one failed or was unavailable, and a backup after the open session failed
 * alike, and a refused authorization opens nothing.
 *
 * With `enableMidUtteranceFailover`, a session is the chain's facade: it keeps
 * the last `ringBufferCapacityMs` of audio and, when the session in use fails,
 * or closes before a flush, opens the next provider the policy permits,
 * replays that audio and the frames pushed meanwhile, and goes on.
 */

import { VoiceEventEmitter } from '../VoiceEventEmitter.js';
import type { IStreamingSTT, StreamingSTTSession, ScopedStreamingSTTSession, StreamingSTTConfig, AudioFrame, AudioIdentity, TranscriptEvent } from '../types.js';
import type { HealthyProvider } from '../HealthyProvider.js';
import { VoicePipelineError, AggregateVoiceError, type HealthErrorClass } from '../VoicePipelineError.js';
import type { CircuitBreaker } from '../CircuitBreaker.js';
import type { VoiceMetricsReporter, VoiceMetricEvent } from '../VoiceMetricsReporter.js';
import { AudioRingBuffer } from '../AudioRingBuffer.js';
import { TranscriptDedupe } from '../TranscriptDedupe.js';
import { authorizeProviderOpening, freezeProviderPolicy, legacyProviderPolicy, selectPolicyProviders, type ProviderSelectionPolicy } from '../ProviderPolicy.js';

/** Selected provider notification retained for existing hosts. */
export interface ProviderSelectedEvent {
  /** The chain that opened the session. */
  kind: 'stt' | 'tts';
  /**
   * The provider whose session opened: its `providerId`, or, when another
   * provider in the chain has the same id, that id with `#` and the
   * provider's place among them, from 1 in the chain's order
   * (`'moonshine-browser#2'`).
   */
  providerId: string;
  /** Its place among the providers tried, from 1. */
  attempt: number;
}

/** Failed opening notification; strict policies redact provider messages. */
export interface ProviderFailedEvent {
  /** The chain that tried the provider. */
  kind: 'stt' | 'tts';
  /** The provider whose opening failed, named as in {@link ProviderSelectedEvent.providerId}. */
  providerId: string;
  /** The failure's class, as `VoicePipelineError.classifyError` reads it. */
  errorClass: HealthErrorClass;
  /** The provider's message under the legacy policy; `provider opening failed` under a strict one. */
  message: string;
}

/** Mid-session switch notification retained beside the scoped policy event. */
export interface ProviderFailoverEvent {
  /** The chain that switched. */
  kind: 'stt' | 'tts';
  /** The provider whose session failed, named as in {@link ProviderSelectedEvent.providerId}. */
  from: string;
  /** The provider that took over, named as in {@link ProviderSelectedEvent.providerId}. */
  to: string;
  /** The class of the failure that started the switch. */
  reason: HealthErrorClass;
  /** Milliseconds the switch took, with the audio of any frames dropped while it ran. */
  lostMs: number;
}

/** Explicit selection plus the existing health and replay options. */
export interface StreamingSTTChainOptions {
  /**
   * Skips providers it reports unavailable; failed openings and failed sessions are recorded to it, each provider
   * under the name the chain's events give it ({@link ProviderSelectedEvent.providerId}).
   */
  breaker?: CircuitBreaker;
  /** Receives the chain's `provider_selected`, `provider_failed`, `provider_failover` and `provider_unavailable` events. */
  metrics?: VoiceMetricsReporter;
  /** Called when a session opens. */
  onProviderSelected?: (event: ProviderSelectedEvent) => void;
  /** Called when a provider's opening fails. */
  onProviderFailed?: (event: ProviderFailedEvent) => void;
  /** Called when the facade has moved to a backup during a session. */
  onProviderFailover?: (event: ProviderFailoverEvent) => void;
  /**
   * When true, the chain tracks audio in a ring buffer and re-routes to the
   * next provider the policy permits when the session in use fails. The
   * session is then the chain's facade: it forwards transcripts, speech
   * events and `'warning'` from the provider session in use (under a
   * `ProviderPolicy` a warning arrives as `Error('provider warning')`, without
   * the provider's text, and one nobody listens for is not printed), `'usage'`
   * from every provider session it attached, a failed one too, and, once a
   * backup has taken over, `'stt:gap'` (`{ lostMs, attempt }`) when frames
   * pushed during the switch were dropped past `maxPendingFrames`. Its
   * `flush()` waits for a switch in progress and drains the provider session
   * in use. The transcripts a provider session emits as the facade closes it,
   * such as the empty finals with which the Moonshine browser provider
   * retracts an open line's interim text, still reach the facade's listeners:
   * on a switch, before the backup's; when the facade ends, before its
   * `'close'`. A provider close after flush and before the next frame emits one
   * facade close; later audio is ignored. A frame whose duration (samples
   * over sample rate) is not above zero and at most `ringBufferCapacityMs`
   * ends the facade, and so does a switch no provider can take: the facade
   * emits `'error'` (only to a listener) and then `'close'`. Default: false.
   */
  enableMidUtteranceFailover?: boolean;
  /** Ring buffer capacity in ms for mid-utterance replay, and the longest frame the facade accepts. Default 3000. */
  ringBufferCapacityMs?: number;
  /** Don't replay audio fragments shorter than this; just advance the next utterance to the backup. Default 400. */
  minReplayMs?: number;
  /**
   * The provider policy. Default: `legacyProviderPolicy`, every provider in
   * priority order with no authorization. A `ProviderPolicy` is validated and
   * copied when the chain is built.
   */
  policy?: ProviderSelectionPolicy;
  /** Live input during an opening is bounded independently of replay. */
  maxPendingFrames?: number;
}

type STTProvider = IStreamingSTT & HealthyProvider;

/**
 * Each provider's name in the chain's breaker, dedupe and events: its `providerId`, or, when other providers in the
 * list have the same id, that id with `#` and the provider's place among them, from 1 in the list's order. No
 * built-in provider's id holds a `#`, and a `ProviderPermission` id may not.
 */
function instanceNames(providers: readonly STTProvider[]): Map<STTProvider, string> {
  const sharing = new Map<string, number>();
  for (const p of providers) sharing.set(p.providerId, (sharing.get(p.providerId) ?? 0) + 1);
  const seen = new Map<string, number>();
  const names = new Map<STTProvider, string>();
  for (const p of providers) {
    if (sharing.get(p.providerId) === 1) {
      names.set(p, p.providerId);
      continue;
    }
    const place = (seen.get(p.providerId) ?? 0) + 1;
    seen.set(p.providerId, place);
    names.set(p, `${p.providerId}#${place}`);
  }
  return names;
}

/** Provider chain with authorization below both initialization and mid-session routing loops. */
export class StreamingSTTChain implements IStreamingSTT {
  /** Always `'chain'`. */
  readonly providerId = 'chain';
  /** Always `false`: the chain itself holds no session. */
  readonly isStreaming = false;
  private readonly list: STTProvider[];
  private readonly policy: ProviderSelectionPolicy;
  /** Each provider's name in the breaker, the dedupe and the events, by `instanceNames`. */
  private readonly names: ReadonlyMap<STTProvider, string>;
  private activeProviderId?: string;

  /**
   * @param providers - The configured providers; under a `ProviderPolicy`, one instance for each permitted provider id.
   * @param opts - Health, replay and selection options.
   * @throws {Error} For no provider, a policy `freezeProviderPolicy` refuses or one that does not permit `'stt'`, a
   *   permitted provider with no configured instance or more than one, or a `maxPendingFrames` or
   *   `ringBufferCapacityMs` that is not positive.
   */
  constructor(providers: STTProvider[], private readonly opts: StreamingSTTChainOptions = {}) {
    if (!providers.length) throw new Error('StreamingSTTChain requires at least one provider');
    this.policy = freezeProviderPolicy(opts.policy ?? legacyProviderPolicy);
    this.list = selectPolicyProviders(providers, this.policy, 'stt');
    this.names = instanceNames(this.list);
    if (!Number.isSafeInteger(opts.maxPendingFrames ?? 100) || (opts.maxPendingFrames ?? 100) <= 0 || !Number.isFinite(opts.ringBufferCapacityMs ?? 3000) || (opts.ringBufferCapacityMs ?? 3000) <= 0) throw new Error('invalid STT buffer bound');
  }

  /** Policy order, or legacy priority order. */
  get providers(): readonly STTProvider[] {
    return this.list;
  }

  /**
   * The `providerId` of the most recently opened provider, for existing introspection callers. Two providers with the
   * same id read the same here; the chain's events tell them apart.
   */
  get currentProviderId(): string | undefined {
    return this.activeProviderId;
  }

  private metric(event: VoiceMetricEvent): void {
    this.opts.metrics?.emit(event);
  }

  /** The provider's name in the breaker, the dedupe and the chain's events. */
  private nameOf(provider: STTProvider): string {
    return this.names.get(provider) ?? provider.providerId;
  }

  /**
   * Opens the first authorized available provider. A denied authorization is never retried as a provider failure.
   *
   * @param config - Passed to each provider tried; its `call` identity is the identity each opening is authorized for.
   * @returns The provider's own session, or the chain's facade with `enableMidUtteranceFailover`.
   * @throws {Error} The policy's refusal, which opens no provider and tries no other; `No STT providers available
   *   (all tripped or filtered)` when the breaker skips every provider; an `AggregateVoiceError` when every provider
   *   tried failed to open.
   */
  async startSession(config?: StreamingSTTConfig): Promise<StreamingSTTSession> {
    const candidates = this.list.filter((p) => !this.opts.breaker || this.opts.breaker.isAvailable(this.nameOf(p)));
    const errors: VoicePipelineError[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const provider = candidates[i]!;
      const from = i ? candidates[i - 1]!.providerId : (provider !== this.list[0] ? this.list[0]?.providerId : undefined);
      await authorizeProviderOpening(this.policy, 'stt', from, provider.providerId, i ? 'initialization_failed' : from ? 'unavailable' : 'primary', config?.call);
      try {
        const session = await provider.startSession(config);
        this.activeProviderId = provider.providerId;
        const selected: ProviderSelectedEvent = { kind: 'stt', providerId: this.nameOf(provider), attempt: i + 1 };
        this.opts.onProviderSelected?.(selected);
        this.metric({ type: 'provider_selected', ...selected });
        this.opts.breaker?.recordSuccess(this.nameOf(provider));
        return this.wrap(session, provider, candidates.slice(i + 1), config);
      } catch (error) {
        const failure = VoicePipelineError.classifyError(error, { kind: 'stt', provider: provider.providerId });
        errors.push(failure);
        const event: ProviderFailedEvent = { kind: 'stt', providerId: this.nameOf(provider), errorClass: failure.errorClass, message: this.policy.mode === 'legacy' ? failure.message : 'provider opening failed' };
        this.opts.onProviderFailed?.(event);
        this.metric({ type: 'provider_failed', ...event });
        this.opts.breaker?.recordFailure(this.nameOf(provider), failure.errorClass);
      }
    }
    this.metric({ type: 'provider_unavailable', kind: 'stt', checkedProviders: this.list.map((p) => this.nameOf(p)) });
    if (!errors.length) throw new Error('No STT providers available (all tripped or filtered)');
    throw new AggregateVoiceError(errors);
  }

  /**
   * Wraps the session a provider opened. With failover off the session is returned as it is. Otherwise the facade
   * tees audio into a ring buffer and, on the active session's error, or its close before a flush, closes it and
   * opens the next remaining provider (authorized first under a `ProviderPolicy`), replays the buffered audio when
   * there is at least `minReplayMs` of it, then the frames pushed during the switch, and goes on. Only the active
   * session's transcripts, speech events and warnings reach the facade, and the transcripts a session emits as the
   * facade closes it, which go out before anything that follows. A final that repeats one another provider already
   * gave for the same audio is dropped; an empty final, which retracts its own provider's interim text, is never
   * taken for a repeat. A close the caller asks for ends the session: it starts no
   * backup, and a backup still opening then is closed when it opens. When the session was opened with
   * `config.call`, every frame goes to the provider session's `pushAudioScoped()`, and the facade has
   * `pushAudioScoped()` and `reset()` when the first session has them. The facade is a `VoiceEventEmitter`, so the
   * chain imports nothing from `node:events`.
   */
  private wrap(initial: StreamingSTTSession, first: STTProvider, candidates: STTProvider[], config?: StreamingSTTConfig): StreamingSTTSession {
    if (!this.opts.enableMidUtteranceFailover) return initial;
    const facade = new VoiceEventEmitter();
    const ring = new AudioRingBuffer({ capacityMs: this.opts.ringBufferCapacityMs ?? 3000, sampleRate: 16000 });
    const dedupe = new TranscriptDedupe();
    let current: StreamingSTTSession | undefined = initial;
    let provider = first;
    let remaining = [...candidates];
    let closed = false;
    // The provider session the facade is closing: the transcripts it emits as it closes still go out.
    let retiring: StreamingSTTSession | undefined;
    let flushed = false;
    let switching: Promise<void> | undefined;
    const pending: AudioFrame[] = [];
    let lostMs = 0;
    // A scoped session takes each frame with its identity; a frame without one, or a provider session that cannot
    // take it, fails the delivery rather than reaching the legacy pushAudio.
    const deliver = async (session: StreamingSTTSession, frame: AudioFrame): Promise<void> => {
      const scoped = session as Partial<ScopedStreamingSTTSession>;
      if (config?.call) {
        if (!scoped.pushAudioScoped || !('scopeId' in frame) || !('turnId' in frame) || !frame.generation) throw new Error('scoped STT input required');
        await scoped.pushAudioScoped(frame as Parameters<ScopedStreamingSTTSession['pushAudioScoped']>[0]);
      } else await session.pushAudio(frame);
    };
    // Closes a provider session the facade lets go of. The transcripts it emits as it closes, such as the empty finals
    // with which a provider retracts interim text it showed, go out first.
    const retire = (session: StreamingSTTSession | undefined): void => {
      if (!session) return;
      retiring = session;
      try {
        session.close();
      } finally {
        retiring = undefined;
      }
    };
    // Ends the facade once: the session it last used is closed, its last transcripts going out, then 'close' is
    // emitted. A throw from that session's close() reaches the caller after 'close', unless `quiet`.
    const finish = (last?: StreamingSTTSession, quiet = false): void => {
      if (closed) return;
      closed = true;
      pending.length = 0;
      ring.clear();
      try {
        retire(last);
      } catch (error) {
        if (!quiet) throw error;
      } finally {
        facade.emit('close');
      }
    };
    const fatal = (error: Error): void => {
      if (closed) return;
      try {
        if (facade.listenerCount('error')) facade.emit('error', error);
      } finally {
        const old = current;
        current = undefined;
        // Terminal cleanup goes on though the session's close() throws.
        finish(old, true);
      }
    };
    const attach = (session: StreamingSTTSession, id: string): void => {
      session.on('transcript', (event: TranscriptEvent) => {
        if (session !== retiring && (closed || session !== current)) return;
        // An empty final retracts interim text its own provider showed and repeats no one's words, so it is never
        // a duplicate.
        if (event.isFinal && event.text.trim() !== '' && event.startMs !== undefined && event.endMs !== undefined && dedupe.evaluate({ provider: id, text: event.text, audioStartMs: event.startMs, audioEndMs: event.endMs, isFinal: true }).isDuplicate) return;
        facade.emit('transcript', event);
      });
      for (const name of ['vad', 'speech_start', 'speech_end'] as const) session.on(name, (...args: unknown[]) => {
        if (!closed && session === current) facade.emit(name, ...args);
      });
      session.on('warning', (warning: Error) => {
        if (closed || session !== current) return;
        // A provider session prints a warning nobody listens for; the legacy facade does the same, and a strict
        // policy's facade forwards no provider text.
        if (facade.listenerCount('warning')) facade.emit('warning', this.policy.mode === 'legacy' ? warning : new Error('provider warning'));
        else if (this.policy.mode === 'legacy') console.warn('[' + id + '] ' + warning.message);
      });
      // Supplier usage is not output: a retired session's final quantities still belong to its request.
      session.on('usage', (event: unknown) => facade.emit('usage', event));
      session.on('error', (error: Error) => {
        if (!closed && session === current && !switching) begin(error);
      });
      session.on('close', () => {
        if (closed || session !== current || switching) return;
        // A provider may end its stream once flushed, as the session contract has it (a final, then 'close').
        if (flushed) {
          current = undefined;
          finish();
        } else begin(new Error('provider closed'));
      });
    };
    const failover = async (error: Error): Promise<void> => {
      const from = provider;
      const failure = VoicePipelineError.classifyError(error, { kind: 'stt', provider: from.providerId });
      this.opts.breaker?.recordFailure(this.nameOf(from), failure.errorClass);
      const replay = ring.snapshot();
      const replayMs = ring.durationMs();
      const started = Date.now();
      const old = current;
      current = undefined;
      retire(old);
      for (const backup of remaining) {
        if (closed) return;
        if (this.opts.breaker && !this.opts.breaker.isAvailable(this.nameOf(backup))) continue;
        if (this.policy.mode !== 'legacy') await authorizeProviderOpening(this.policy, 'stt', from.providerId, backup.providerId, 'mid_session_failure', config?.call);
        if (closed) return;
        let next: StreamingSTTSession;
        try {
          next = await backup.startSession(config);
        } catch (error) {
          const failed = VoicePipelineError.classifyError(error, { kind: 'stt', provider: backup.providerId });
          this.opts.breaker?.recordFailure(this.nameOf(backup), failed.errorClass);
          continue;
        }
        if (closed) {
          next.close();
          return;
        }
        current = next;
        provider = backup;
        remaining = remaining.filter((p) => p !== backup);
        attach(next, this.nameOf(backup));
        if (replayMs >= (this.opts.minReplayMs ?? 400)) for (const frame of replay) {
          if (closed) return;
          await deliver(next, frame);
        }
        while (pending.length && !closed) {
          const frame = pending.shift()!;
          ring.push(frame);
          await deliver(next, frame);
        }
        if (closed) return;
        this.activeProviderId = backup.providerId;
        this.opts.breaker?.recordSuccess(this.nameOf(backup));
        const event: ProviderFailoverEvent = { kind: 'stt', from: this.nameOf(from), to: this.nameOf(backup), reason: failure.errorClass, lostMs: Date.now() - started + lostMs };
        this.opts.onProviderFailover?.(event);
        this.metric({ type: 'provider_failover', ...event });
        if (lostMs) {
          facade.emit('stt:gap', { lostMs, attempt: 1 });
          lostMs = 0;
        }
        return;
      }
      throw new AggregateVoiceError([failure]);
    };
    const begin = (error: Error): void => {
      if (closed || switching) return;
      // Set before failover runs: its synchronous part closes the old session, whose events must find a switch under way.
      switching = Promise.resolve();
      switching = failover(error).catch((failure: unknown) => fatal(failure instanceof Error ? failure : new Error('STT failed'))).finally(() => {
        switching = undefined;
      });
    };
    attach(initial, this.nameOf(first));
    const wrapped: StreamingSTTSession = Object.assign(facade, {
      pushAudio: async (frame: AudioFrame): Promise<void> => {
        if (closed) return;
        flushed = false;
        const ms = frame.samples.length / frame.sampleRate * 1000;
        if (!Number.isFinite(ms) || ms <= 0 || ms > (this.opts.ringBufferCapacityMs ?? 3000)) {
          fatal(new Error('STT input bound'));
          return;
        }
        if (switching) {
          // Held for the backup, newest kept; what overflows is counted as lost audio and reported as a gap.
          pending.push({ ...frame, samples: frame.samples.slice() });
          while (pending.length > (this.opts.maxPendingFrames ?? 100)) {
            const dropped = pending.shift()!;
            lostMs += dropped.samples.length / dropped.sampleRate * 1000;
          }
          return;
        }
        if (!current) return;
        ring.push(frame);
        try {
          await deliver(current, frame);
        } catch (error) {
          begin(error instanceof Error ? error : new Error('STT push failed'));
        }
      },
      flush: async (): Promise<void> => {
        await switching;
        if (closed || !current) return;
        flushed = true;
        await current.flush();
      },
      close: (): void => {
        if (closed) return;
        const old = current;
        current = undefined;
        finish(old);
      },
    });
    const scoped = initial as Partial<ScopedStreamingSTTSession>;
    if (scoped.pushAudioScoped && scoped.reset) {
      Object.assign(wrapped, {
        pushAudioScoped: async (frame: Parameters<ScopedStreamingSTTSession['pushAudioScoped']>[0]): Promise<void> => {
          await wrapped.pushAudio(frame);
        },
        reset: async (identity: AudioIdentity): Promise<void> => {
          await switching;
          ring.clear();
          dedupe.reset();
          pending.length = 0;
          config = { ...config, call: identity };
          if (closed) return;
          const active = current as Partial<ScopedStreamingSTTSession> | undefined;
          if (!active?.reset || !active.pushAudioScoped) throw new Error('scoped STT fallback required');
          await active.reset(identity);
        },
      });
    }
    return wrapped;
  }
}
