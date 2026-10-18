/**
 * @module voice-pipeline/LiveKitAudioPublisher
 *
 * The speaking half of `LiveKitStreamTransport`: one LiveKit audio track that
 * the room's local participant publishes, fed with the agent's PCM16 chunks.
 *
 * In native playout, the default, every participant subscribed to the track
 * hears it, a phone caller bridged by LiveKit SIP included, and a chunk counts
 * as played once the track's native queue has played it out. In participant
 * playout, the receipt protocol of an AgentOS page, each chunk is announced to
 * the participant as an `audio` text message and counts as played only once
 * the participant answers with a playback receipt.
 */

import { inspectPcm16, type Pcm16View } from './audioFormat.js';
import { PlaybackAcknowledgements } from './PlaybackAcknowledgements.js';
import { sameVoiceGeneration, type EncodedAudioChunk, type PlaybackReceipt, type VoiceGeneration } from './types.js';
import { loadLiveKitRtc } from '../hearing/LiveKitRoomAudioSource.js';

/** Structural rtc-node frame; buffers passed to the SDK own their complete Int16 allocation. */
export interface PublishedAudioFrame { data: Int16Array; sampleRate: number; channels: number; samplesPerChannel: number }
/** Native capture and queue acknowledgement, not receiver acknowledgement. */
export interface LiveKitPublishingSource {
  captureFrame(frame: PublishedAudioFrame): Promise<void>;
  waitForPlayout(): Promise<void>;
  clearQueue(): void;
  close(): Promise<void>;
}
/** One native local track; source lifetime is owned separately to prevent double disposal. */
export interface LiveKitPublishingTrack { close(closeSource?: boolean): Promise<void> }
/** Narrow SDK surface, injected for tests or dynamically loaded from the optional peer. */
export interface LiveKitPublishingRtc {
  AudioSource: new (sampleRate: number, channels: number, queueSizeMs: number) => LiveKitPublishingSource;
  AudioFrame: new (data: Int16Array, sampleRate: number, channels: number, samplesPerChannel: number) => PublishedAudioFrame;
  AudioResampler: new (inputRate: number, outputRate: number, channels: number) => { push(frame: PublishedAudioFrame): PublishedAudioFrame[]; flush(): PublishedAudioFrame[]; close(): void };
  LocalAudioTrack: { createAudioTrack(name: string, source: LiveKitPublishingSource): LiveKitPublishingTrack };
  TrackPublishOptions: new () => { source: number };
  TrackSource: { SOURCE_MICROPHONE: number };
}
/** A published track, as rtc-node's `LocalTrackPublication`: its id, and the wait for a participant to subscribe to it. */
interface PublishedTrack {
  sid?: string;
  waitForSubscription?(): Promise<void>;
}
interface PublishingParticipant {
  publishTrack(track: LiveKitPublishingTrack, options: { source: number }): Promise<PublishedTrack>;
  unpublishTrack(sid: string, stopOnUnpublish?: boolean): Promise<void>;
}

/**
 * How a speaking LiveKit transport knows that its audio played.
 *
 * - `'native'`: the audio goes out on a LiveKit audio track, which every participant subscribed to it hears, a phone
 *   caller bridged by LiveKit SIP included. A chunk counts as played once the track's native queue has played it out
 *   (rtc-node's `AudioSource.waitForPlayout()`); nothing is sent to or asked of the participant.
 * - `'participant'`: the receipt protocol of an AgentOS page. Each chunk is announced to the participant as an `audio`
 *   text message and counts as played only once the queue has drained and the participant has answered with a
 *   `playback` receipt; a clear waits for the participant's `cleared` answer.
 */
export type LiveKitPlayout = 'native' | 'participant';

/**
 * The participant attribute through which a page asks for participant playout: the value `'participant'` selects
 * the receipt protocol when the host leaves `playout` unset. A page's access token can carry it, so it is set when
 * the page joins.
 */
export const LIVEKIT_PLAYOUT_ATTRIBUTE = 'agentos.playout';

/** rtc-node's `ParticipantKind.SIP`: a phone caller LiveKit SIP brought into the room. */
const SIP_PARTICIPANT_KIND = 3;

/** What the publisher reads of the participant it speaks to; rtc-node's `RemoteParticipant` satisfies it as it is. */
export interface LiveKitPlayoutParticipant {
  /** rtc-node's `ParticipantKind`; `3` (`SIP`) for a phone caller. */
  readonly kind?: number;
  /** The participant's attributes. LiveKit SIP sets `sip.callID` and the other `sip.` keys on every SIP participant. */
  readonly attributes?: Readonly<Record<string, string>>;
}

/**
 * Whether a participant is a phone caller bridged by LiveKit SIP: of kind `SIP`, or carrying the `sip.callID`
 * attribute LiveKit SIP sets on every SIP participant. Such a participant runs no client code and reads no text
 * streams; it hears the room's audio tracks.
 *
 * @param participant - The participant, or `undefined` when it is not in the room.
 * @returns `true` for a SIP participant.
 */
export function isLiveKitSipParticipant(participant: LiveKitPlayoutParticipant | undefined): boolean {
  return participant?.kind === SIP_PARTICIPANT_KIND || typeof participant?.attributes?.['sip.callID'] === 'string';
}

/** Options of {@link LiveKitAudioPublisher}: the playout mode, the call identity, the track's rate and the bounds. */
export interface LiveKitAudioPublisherOptions {
  /**
   * How playback is acknowledged ({@link LiveKitPlayout}). Unset, the publisher plays natively unless the participant
   * declares {@link LIVEKIT_PLAYOUT_ATTRIBUTE} as `'participant'` and these options carry the call identity. A SIP
   * participant is always played natively. `'participant'` requires `scopeId`, `callId` and `generation`. The mode is
   * fixed once the participant is in the room; a chunk sent before then plays natively, and its playback wait and its
   * clear stay native once the mode is fixed.
   */
  playout?: LiveKitPlayout;
  /**
   * The call's scope: required for participant playout; in native playout, a chunk that carries a scope must carry
   * this one, and without it a chunk that carries a scope is refused.
   */
  scopeId?: string;
  /**
   * The call: required for participant playout; in native playout, a chunk that carries a call must carry this one,
   * and without it a chunk that carries a call is refused.
   */
  callId?: string;
  /**
   * The call's current generation, read at every admission and after each native step: required for participant
   * playout; in native playout, a chunk that carries a generation must carry this one and stops playing when it
   * changes, and without this reader a chunk that carries a generation is refused.
   */
  generation?(): VoiceGeneration;
  /** The published track's rate. */
  sampleRate: 16000 | 24000 | 48000;
  /** A chunk's most PCM bytes plus the bytes it is resampled to. */
  maxBytes: number;
  /** A chunk's longest audio and the length of the track's native queue, in milliseconds; at most 2000. */
  maxDurationMs: number;
  /**
   * The deadline of a playback wait, and in participant playout of a receipt and a clear, from 1 to 30000 milliseconds;
   * also the longest the track waits, once published, for a participant to subscribe to it before it plays.
   */
  receiptTimeoutMs: number;
  /**
   * The `@livekit/rtc-node` module, or a structural one. A transport passes its own `rtc` when this is omitted; with
   * neither, the module is imported when the track is first published.
   */
  rtc?: unknown;
}
/** What a transport hands its publisher besides the host's options. */
export interface LiveKitPublisherBinding {
  /** The transport's `@livekit/rtc-node` module; the publisher's own `rtc` option comes first. */
  rtc?: unknown;
  /**
   * Reads the participant the transport speaks to, or `undefined` while it is not in the room, until the playout mode
   * is fixed: the mode waits for the participant.
   */
  participant?(): LiveKitPlayoutParticipant | undefined;
}
/**
 * Loads the optional publishing peer through {@link loadLiveKitRtc}, so a missing package is named with how to install
 * it; no native dependency enters browser imports or listen-only construction.
 *
 * @param importer - How to import a module; the default is {@link loadLiveKitRtc}'s dynamic `import()`.
 * @returns The module's publishing parts.
 * @throws {Error} Naming `@livekit/rtc-node` and how to install it when the import fails, or
 *   `livekit publishing SDK unavailable` when the module lacks a publishing part.
 */
export async function loadLiveKitPublishingRtc(importer?: (name: string) => Promise<unknown>): Promise<LiveKitPublishingRtc> {
  return publishingRtc(await loadLiveKitRtc(importer));
}
function publishingRtc(input: unknown): LiveKitPublishingRtc {
  const rtc = input as Partial<LiveKitPublishingRtc> | undefined;
  if (!rtc || typeof rtc.AudioSource !== 'function' || typeof rtc.AudioFrame !== 'function' || typeof rtc.AudioResampler !== 'function' || typeof rtc.LocalAudioTrack?.createAudioTrack !== 'function' || typeof rtc.TrackPublishOptions !== 'function' || typeof rtc.TrackSource?.SOURCE_MICROPHONE !== 'number') throw new Error('livekit publishing SDK unavailable');
  return rtc as LiveKitPublishingRtc;
}
/**
 * A chunk native playout admitted: the playout it was admitted under, what its receipt reports, the clear count it was
 * admitted under, the hold count under which the track began to take it, and its capture.
 */
interface NativeChunk {
  /**
   * The playout the chunk was admitted under, which its playback wait and its clear go through: a chunk sent before
   * the participant was in the room stays native once a later chunk has fixed participant playout.
   */
  playout: 'native';
  generation?: VoiceGeneration;
  sequence: number;
  playedSamples: number;
  sampleRate: number;
  /** A clear or a close after admission increments the count and discards the chunk. */
  cancellation: number;
  /**
   * The hold count as the track began to take the chunk's first frame; unset until then. A pause since then cleared
   * what the queue held of the chunk, so the chunk does not count as played, whenever the pause came.
   */
  holds?: number;
  /** Settles once the chunk's frames are captured, or once the chunk was discarded. */
  captured: Promise<void>;
}
/** A chunk participant playout admitted: the playout it was admitted under, and what the participant's receipt reports. */
interface ParticipantChunk {
  /** The playout the chunk was admitted under, which its playback wait and its clear go through. */
  playout: 'participant';
  receipt: PlaybackReceipt;
}
/**
 * One published track of the agent's speech. In native playout chunks queue on the track in order, as fast as its
 * native queue takes them, and play out on the track's own timing; in participant playout one chunk is outstanding at
 * a time and the participant acknowledges each.
 */
export class LiveKitAudioPublisher {
  private readonly participant: PublishingParticipant;
  private readonly acks: PlaybackAcknowledgements;
  private rtc?: LiveKitPublishingRtc;
  private source?: LiveKitPublishingSource;
  private track?: LiveKitPublishingTrack;
  private publication?: string;
  private preparation?: Promise<void>;
  private sending?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private cancellation = 0;
  private clearWork?: Promise<void>;
  /** Participant playout: the chunk announced last, until its playback wait settles or a clear has finished. */
  private pending?: ParticipantChunk;
  /** The playout mode, fixed at the first readiness or admission that finds the participant in the room. */
  private mode?: LiveKitPlayout;
  /** Native playout: the end of the queue of chunks being captured, and of a clear; it never rejects. */
  private queued: Promise<void> = Promise.resolve();
  /** Native playout: the last chunk admitted, until a playback wait for it settles or a clear discards it. */
  private latest?: NativeChunk;
  /** Native playout: the sequence the next chunk without one takes. */
  private nextSequence = 1;
  /** Native playout: the hold a barge-in pause put on the track, until a resume, a clear or a close releases it. */
  private hold?: { released: Promise<void>; release: () => void };
  /**
   * Native playout: how many holds have begun, so that a frame captured while one began is cleared as it lands, and a
   * chunk the track had begun to take when one began does not count as played.
   */
  private holds = 0;
  /** Ends the wait for the first subscription, so that a close does not wait it out. */
  private stopWaiting?: () => void;
  /**
   * @param options - The host's options: the playout mode, the call identity, the track's rate and the bounds.
   * @param participant - The room's local participant, which publishes the track.
   * @param send - Sends one JSON message to the participant on the transport's topic; participant playout only.
   * @param binding - What the transport hands over besides the options: its rtc module and the participant it speaks to.
   * @throws {Error} `livekit publishing participant required` when `participant` cannot publish a track, and
   *   `invalid livekit publisher bound` when an option is refused, `playout: 'participant'` without the call identity
   *   among them.
   */
  constructor(private readonly options: LiveKitAudioPublisherOptions, participant: unknown, private readonly send: (message: Record<string, unknown>) => Promise<void>, private readonly binding: LiveKitPublisherBinding = {}) {
    const local = participant as Partial<PublishingParticipant> | undefined;
    if (!local || typeof local.publishTrack !== 'function' || typeof local.unpublishTrack !== 'function') throw new Error('livekit publishing participant required');
    this.participant = local as PublishingParticipant;
    if ((options.playout !== undefined && options.playout !== 'native' && options.playout !== 'participant') || (options.playout === 'participant' && !this.identified()) || ![16000, 24000, 48000].includes(options.sampleRate) || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 2 || !Number.isSafeInteger(options.maxDurationMs) || options.maxDurationMs <= 0 || options.maxDurationMs > 2000) throw new Error('invalid livekit publisher bound');
    this.acks = new PlaybackAcknowledgements(options.receiptTimeoutMs);
  }
  /**
   * The playout mode once {@link ready} or {@link sendAudio} has fixed it, which waits for the participant to be in the
   * room; `undefined` before.
   */
  get playout(): LiveKitPlayout | undefined { return this.mode; }
  /** Whether the options carry the call identity participant playout needs. */
  private identified(): boolean { return !!this.options.scopeId && !!this.options.callId && typeof this.options.generation === 'function'; }
  /**
   * Fixes the mode once: native for a SIP participant, else the host's setting, else what the participant declares.
   * While the participant the binding reads is not in the room nothing is fixed, and the chunk being admitted plays
   * natively: nobody is there to announce it to, and a phone caller who joins later is played natively too.
   */
  private fixMode(): LiveKitPlayout {
    if (this.mode) return this.mode;
    const participant = this.binding.participant?.();
    if (typeof this.binding.participant === 'function' && !participant) return 'native';
    if (isLiveKitSipParticipant(participant)) this.mode = 'native';
    else if (this.options.playout) this.mode = this.options.playout;
    else this.mode = this.identified() && participant?.attributes?.[LIVEKIT_PLAYOUT_ATTRIBUTE] === 'participant' ? 'participant' : 'native';
    return this.mode;
  }
  /**
   * Fixes the playout mode when the participant is in the room, then publishes exactly once and waits for a participant
   * to subscribe to the track, at most `receiptTimeoutMs`, before the host records connected readiness.
   */
  ready(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('publisher closed'));
    if (!this.preparation) this.fixMode();
    return this.prepare();
  }
  /**
   * Publishes the track exactly once, then waits for a participant to subscribe to it, at most `receiptTimeoutMs`, so
   * that nothing is captured before anyone hears it; later calls share that work. The mode is fixed by the caller.
   */
  private prepare(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('publisher closed'));
    if (this.preparation) return this.preparation;
    this.preparation = (async () => {
      const rtc = publishingRtc(this.options.rtc ?? this.binding.rtc ?? (await loadLiveKitRtc()));
      if (this.closed) throw new Error('publisher closed'); this.rtc = rtc;
      this.source = new rtc.AudioSource(this.options.sampleRate, 1, this.options.maxDurationMs);
      this.track = rtc.LocalAudioTrack.createAudioTrack('voice', this.source);
      const options = new rtc.TrackPublishOptions(); options.source = rtc.TrackSource.SOURCE_MICROPHONE;
      const publication = await this.participant.publishTrack(this.track, options);
      if (!publication.sid) throw new Error('publication id missing'); this.publication = publication.sid;
      if (this.closed) throw new Error('publisher closed');
      // A participant that subscribes after a capture misses what played before it; LiveKit's own publish-wav example
      // waits for the subscription before its first capture too.
      await this.subscription(publication);
      if (this.closed) throw new Error('publisher closed');
    })(); return this.preparation;
  }
  /**
   * Waits for a participant to subscribe to the published track (rtc-node's
   * `LocalTrackPublication.waitForSubscription()`), at most `receiptTimeoutMs` and no longer than the publisher is open.
   * A publication without the method, or whose wait fails, is not waited for: the track plays as it is.
   */
  private async subscription(publication: PublishedTrack): Promise<void> {
    if (typeof publication.waitForSubscription !== 'function') return;
    const subscribed = (async () => { await publication.waitForSubscription!(); })().catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.options.receiptTimeoutMs); this.stopWaiting = resolve; });
    try { await Promise.race([subscribed, bounded]); } finally { clearTimeout(timer); this.stopWaiting = undefined; }
  }
  /** Whether work admitted at `captured` with `generation` may still play: open, not cleared since, of the call's generation. */
  private current(generation: VoiceGeneration | undefined, captured: number): boolean {
    if (this.closed || captured !== this.cancellation) return false;
    const call = this.options.generation?.();
    return !generation || !call || sameVoiceGeneration(generation, call);
  }
  private live(generation: VoiceGeneration, captured: number): void {
    if (!this.current(generation, captured)) throw new Error('publisher cancelled');
  }
  /**
   * Whether a native chunk has not all played on account of the track: a pause came since the track began to take it,
   * clearing what the queue held of it, or the track never took it.
   */
  private emptied(entry: NativeChunk): boolean { return entry.holds !== this.holds; }
  /** Inspects and bounds one chunk before any native call, so a refused chunk publishes nothing. */
  private decode(chunk: EncodedAudioChunk): Pcm16View {
    const pcm = inspectPcm16(chunk); const expected = Math.ceil(pcm.samples * this.options.sampleRate / pcm.sampleRate);
    if (pcm.durationMs > this.options.maxDurationMs || pcm.pcm.length + expected * 2 > this.options.maxBytes || chunk.audio.length > this.options.maxBytes + 4096) throw new Error('publisher decoded bound');
    return pcm;
  }
  /** Converts the samples to 16-bit integers once and, when the rates differ, resamples them once to the track's rate. */
  private convert(rtc: LiveKitPublishingRtc, pcm: Pcm16View): { frames: PublishedAudioFrame[]; publishedSamples: number } {
    const samples = new Int16Array(pcm.samples);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.pcm.readInt16LE(i * 2);
    const frame = new rtc.AudioFrame(samples, pcm.sampleRate, 1, samples.length);
    let frames: PublishedAudioFrame[];
    if (pcm.sampleRate === this.options.sampleRate) frames = [frame];
    else {
      const resampler = new rtc.AudioResampler(pcm.sampleRate, this.options.sampleRate, 1);
      try { frames = [...resampler.push(frame), ...resampler.flush()]; } finally { resampler.close(); }
    }
    const publishedSamples = frames.reduce((sum, f) => sum + f.samplesPerChannel, 0);
    if (!frames.length || Math.abs(publishedSamples - pcm.samples * this.options.sampleRate / pcm.sampleRate) > 1 || publishedSamples * 2 + pcm.pcm.length > this.options.maxBytes || frames.some((f) => f.sampleRate !== this.options.sampleRate || f.channels !== 1 || f.data.length !== f.samplesPerChannel || !Number.isSafeInteger(f.samplesPerChannel) || f.samplesPerChannel <= 0)) throw new Error('resampled audio refused');
    return { frames, publishedSamples };
  }
  /** Captures one frame on an allocation of its own: AudioFrame.protoInfo reads the full backing allocation, so an offset view is never passed. */
  private capture(rtc: LiveKitPublishingRtc, output: PublishedAudioFrame): Promise<void> {
    return this.source!.captureFrame(new rtc.AudioFrame(Int16Array.from(output.data), output.sampleRate, 1, output.samplesPerChannel));
  }
  /**
   * Admits one raw or WAV PCM16 chunk, decoded and resampled once at this boundary.
   *
   * In native playout chunks queue in order. A chunk may carry no call identity; one that carries a scope, a call or
   * a generation must carry the publisher's, so a publisher without them refuses it. A chunk without a sequence takes
   * the next of the publisher's own, from 1.
   * The send resolves once the chunk's frames are on the track's native queue, which waits while the queue is full,
   * or once a clear, a close or a newer generation has discarded it.
   *
   * In participant playout the chunk must carry the publisher's scope, call and generation and a sequence, it is
   * announced to the participant first, and another chunk is refused until its playback wait has settled or a clear
   * has finished.
   */
  async sendAudio(chunk: EncodedAudioChunk): Promise<void> {
    return this.fixMode() === 'native' ? this.sendNative(chunk) : this.sendForReceipt(chunk);
  }
  private async sendNative(chunk: EncodedAudioChunk): Promise<void> {
    if (this.closed) throw new Error('publisher closed');
    const { scopeId, callId } = this.options; const call = chunk.generation ? this.options.generation?.() : undefined;
    // A scope, a call or a generation the chunk carries must be the publisher's, which a publisher without one lacks.
    if ((chunk.scopeId !== undefined && chunk.scopeId !== scopeId) || (chunk.callId !== undefined && chunk.callId !== callId) || (chunk.generation && (!call || !sameVoiceGeneration(chunk.generation, call))) || (chunk.sequence !== undefined && (!Number.isSafeInteger(chunk.sequence) || chunk.sequence < 1))) throw new Error('publisher scope or generation refused');
    const pcm = this.decode(chunk);
    const entry: NativeChunk = { playout: 'native', generation: chunk.generation ? { ...chunk.generation } : undefined, sequence: chunk.sequence ?? this.nextSequence++, playedSamples: pcm.samples, sampleRate: pcm.sampleRate, cancellation: this.cancellation, captured: Promise.resolve() };
    const previous = this.queued;
    entry.captured = (async () => {
      await previous;
      if (!this.current(entry.generation, entry.cancellation)) return;
      try { await this.prepare(); } catch (error) { if (!this.current(entry.generation, entry.cancellation)) return; throw error; }
      const rtc = this.rtc!;
      for (const output of this.convert(rtc, pcm).frames) {
        // A pause holds the track: no frame is captured until it is released.
        while (this.hold) await this.hold.released;
        if (!this.current(entry.generation, entry.cancellation)) return;
        const holds = this.holds; entry.holds ??= holds;
        await this.capture(rtc, output);
        // A pause that began while the frame was captured cleared the queue before the frame reached it, so the frame
        // is cleared as it lands, even when a resume came first: what the queue held at the pause is not heard.
        if (this.holds !== holds) this.source?.clearQueue();
      }
    })();
    this.queued = entry.captured.catch(() => {}); this.latest = entry;
    await entry.captured;
  }
  /** Participant playout: decodes and resamples once, then awaits every capture callback before accepting another chunk. */
  private async sendForReceipt(chunk: EncodedAudioChunk): Promise<void> {
    if (this.closed || this.sending || this.pending || this.clearWork) throw new Error('publisher outstanding or closed');
    if (chunk.scopeId !== this.options.scopeId || chunk.callId !== this.options.callId || !chunk.generation || !chunk.sequence || !this.current(chunk.generation, this.cancellation)) throw new Error('publisher scope or generation refused');
    const pcm = this.decode(chunk);
    const generation = { ...chunk.generation }; const captured = this.cancellation;
    const receipt: PlaybackReceipt = { generation, sequence: chunk.sequence, playedSamples: pcm.samples, sampleRate: pcm.sampleRate };
    this.acks.begin(receipt); this.pending = { playout: 'participant', receipt };
    const work = (async () => {
      await this.prepare(); this.live(generation, captured); const rtc = this.rtc!;
      const { frames, publishedSamples } = this.convert(rtc, pcm);
      await this.send({ type: 'audio', scopeId: this.options.scopeId, callId: this.options.callId, generation, sequence: receipt.sequence,
        publicationId: this.publication, encoding: 'pcm16le', channels: 1, samples: pcm.samples, sampleRate: pcm.sampleRate,
        publishedSamples, publishedSampleRate: this.options.sampleRate });
      for (const output of frames) {
        this.live(generation, captured);
        await this.capture(rtc, output); this.live(generation, captured);
      }
    })(); this.sending = work;
    try { await work; } finally { if (this.sending === work) this.sending = undefined; }
  }
  /**
   * Resolves with the chunk's receipt once it has played, within `receiptTimeoutMs` (`publisher drain timeout`);
   * an aborted `signal`, a clear, a close or a newer generation rejects it with `publisher cancelled`.
   *
   * In native playout the wait is for the last chunk admitted: once its frames are captured, the track's native queue
   * must play out (`AudioSource.waitForPlayout()`), and the receipt is the publisher's own, with the chunk's samples
   * and rate. A queue that a clear emptied does not count as played, nor does a chunk the track had begun to take when
   * a pause came, whether the pause came before this wait or during it. In participant playout both the native drain
   * and the participant's receipt are required; the native drain alone does not count.
   *
   * The wait goes through the playout the chunk was admitted under: a chunk sent natively before the participant was
   * in the room waits for the track, also once a later chunk has fixed participant playout.
   */
  async waitForPlayback(generation: VoiceGeneration, sequence: number, signal: AbortSignal): Promise<PlaybackReceipt> {
    const chunk = this.admitted(generation, sequence);
    if (!chunk) throw new Error('missing publisher receipt');
    return chunk.playout === 'participant' ? this.waitForReceipt(chunk, generation, sequence, signal) : this.waitForTrack(chunk, generation, sequence, signal);
  }
  /**
   * The outstanding chunk with this generation and sequence, under the playout it was admitted under: the one
   * participant playout announced last, else the last one native playout admitted.
   */
  private admitted(generation: VoiceGeneration, sequence: number): NativeChunk | ParticipantChunk | undefined {
    const pending = this.pending;
    if (pending && pending.receipt.sequence === sequence && sameVoiceGeneration(pending.receipt.generation, generation)) return pending;
    const entry = this.latest;
    if (entry && entry.sequence === sequence && (!entry.generation || sameVoiceGeneration(entry.generation, generation))) return entry;
    return undefined;
  }
  private async waitForTrack(entry: NativeChunk, generation: VoiceGeneration, sequence: number, signal: AbortSignal): Promise<PlaybackReceipt> {
    let timer: ReturnType<typeof setTimeout> | undefined; let abort: (() => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('publisher drain timeout')), this.options.receiptTimeoutMs);
      abort = () => reject(new Error('publisher cancelled'));
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
    const played = (async () => {
      await entry.captured;
      // A pause since the track began to take the chunk cleared what the queue held of it, even one before this wait.
      if (!this.current(entry.generation, entry.cancellation) || this.emptied(entry)) throw new Error('publisher cancelled');
      await this.source!.waitForPlayout();
      // A pause emptied the queue meanwhile, and what it held has not played.
      if (this.emptied(entry)) throw new Error('publisher cancelled');
    })();
    played.catch(() => {});
    try {
      await Promise.race([played, stopped]);
      if (signal.aborted || !this.current(entry.generation, entry.cancellation) || this.emptied(entry)) throw new Error('publisher cancelled');
      return { generation: { ...(entry.generation ?? generation) }, sequence, playedSamples: entry.playedSamples, sampleRate: entry.sampleRate };
    } finally {
      if (timer) clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort);
      if (this.latest === entry) this.latest = undefined;
    }
  }
  /** Participant playout: both acknowledgements are mandatory. clearQueue's local waiter release cannot count as playback. */
  private async waitForReceipt(pending: ParticipantChunk, generation: VoiceGeneration, sequence: number, signal: AbortSignal): Promise<PlaybackReceipt> {
    const captured = this.cancellation;
    if (!this.source) throw new Error('missing publisher receipt');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('publisher drain timeout')), this.options.receiptTimeoutMs); });
    try {
      const [receipt] = await Promise.race([Promise.all([this.acks.wait(generation, sequence, signal), this.source.waitForPlayout()]), deadline]);
      this.live(generation, captured); if (signal.aborted) throw new Error('publisher cancelled'); return receipt;
    } finally { if (timer) clearTimeout(timer); if (this.pending === pending) this.pending = undefined; }
  }
  /**
   * Resolves once what the publisher was handed has left the track: every chunk admitted so far, and any admitted while
   * it waits, has been captured or discarded, and the track's native queue has played out
   * (`AudioSource.waitForPlayout()`). A pause holds it while chunks wait for the track; a queue that a clear, a pause
   * or a close emptied counts as played out, and in participant playout the participant's receipt is not waited for.
   * It rejects only when the native wait does.
   */
  async waitForPlayout(): Promise<void> {
    for (;;) {
      const queued = this.queued; const sending = this.sending;
      await queued; await sending?.catch(() => {});
      // A chunk admitted meanwhile is waited for too.
      if (queued !== this.queued || sending !== this.sending) continue;
      await this.source?.waitForPlayout();
      if (queued === this.queued && sending === this.sending) return;
    }
  }
  /**
   * Only the authenticated intended participant's parsed control stream calls this method. A receipt counts in
   * participant playout alone; in native playout it is ignored.
   */
  receiveReceipt(input: unknown): boolean { return this.mode === 'participant' ? this.acks.receive(input) : false; }
  /**
   * Holds the track, as a barge-in `pause` asks, outside participant playout: what its native queue holds is cleared
   * at once, a frame whose capture was under way is cleared as it lands, even when a resume came first, and nothing
   * more is captured until {@link resume}, a clear or a close. The chunks handed over meanwhile wait, in order, and a
   * resume plays them from the first the track had not taken; the audio the queue held when the pause came is not
   * heard, and a chunk the track had begun to take does not count as played ({@link waitForPlayback}). A hold already
   * in place stays as it is, and in participant playout nothing is held: the page holds the audio it plays.
   */
  pause(): void {
    if (this.closed || this.mode === 'participant' || this.hold) return;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.hold = { released, release }; this.holds++;
    this.source?.clearQueue();
  }
  /** Releases the hold of {@link pause}: the chunks it held are captured, in order. Without a hold it does nothing. */
  resume(): void { this.release(); }
  /** Ends the hold of a pause, if one is in place. */
  private release(): void {
    const hold = this.hold; this.hold = undefined; hold?.release();
  }
  /**
   * Discards what is queued: invalidates at once, clears the native queue, ends a pause's hold, waits for a capture in
   * flight to return and clears it again. In native playout, and before the mode is fixed, that is all, with no answer
   * asked, and without a `generation` it clears whatever the track holds; a clear of another generation than the last
   * chunk's does nothing. In participant playout it then sends `clear` and waits for the participant's `cleared`
   * answer; it needs the `generation`. A chunk sent natively before participant playout was fixed is cleared as native
   * playout clears it: its capture in flight is waited out before the queue is cleared again and `clear` is sent.
   */
  clearPlayback(generation?: VoiceGeneration): Promise<void> {
    if (this.closed) return this.closing ?? Promise.resolve();
    if (this.clearWork) return this.clearWork;
    if (this.mode === 'participant') return generation ? this.clearForReceipt(generation) : Promise.resolve();
    const latest = this.latest;
    if (generation && latest?.generation && !sameVoiceGeneration(latest.generation, generation)) return Promise.resolve();
    this.cancellation++; this.source?.clearQueue(); this.release(); const queued = this.queued;
    const work = (async () => {
      await queued; this.source?.clearQueue();
      if (this.latest === latest) this.latest = undefined;
    })(); this.clearWork = work; this.queued = work.catch(() => {});
    return work.finally(() => { if (this.clearWork === work) this.clearWork = undefined; });
  }
  /**
   * Participant playout: invalidates immediately, clears the native queue, waits out capture, clears again, then awaits
   * remote discard. A chunk native playout admitted before the mode was fixed is cleared as native playout clears it:
   * its capture in flight is waited out too, before the queue is cleared again.
   */
  private clearForReceipt(generation: VoiceGeneration): Promise<void> {
    if (this.pending && !sameVoiceGeneration(this.pending.receipt.generation, generation)) return Promise.resolve();
    this.cancellation++; this.source?.clearQueue(); this.release(); const sending = this.sending; const queued = this.queued;
    const work = (async () => {
      await sending?.catch(() => {}); await queued; this.source?.clearQueue(); this.latest = undefined;
      await this.acks.clear(generation, (message) => this.send({ ...message })); this.pending = undefined;
    })(); this.clearWork = work;
    return work.finally(() => { if (this.clearWork === work) this.clearWork = undefined; });
  }
  /** Confirms unpublication and native disposal once. Rejection is incomplete cleanup, never stop evidence. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.cancellation++; this.acks.close(); this.release(); this.stopWaiting?.();
    const failures: unknown[] = [];
    try { this.source?.clearQueue(); } catch (error) { failures.push(error); }
    this.closing = (async () => {
      await this.preparation?.catch(() => {}); await this.sending?.catch(() => {}); await this.queued; await this.clearWork?.catch(() => {});
      try { this.source?.clearQueue(); } catch (error) { failures.push(error); }
      if (this.publication) try { await this.participant.unpublishTrack(this.publication, false); } catch (error) { failures.push(error); }
      try { await this.track?.close(false); } catch (error) { failures.push(error); }
      try { await this.source?.close(); } catch (error) { failures.push(error); }
      this.pending = undefined; this.latest = undefined;
      if (failures.length) throw new Error('publisher cleanup incomplete');
    })(); return this.closing;
  }
}
