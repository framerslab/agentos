import { inspectPcm16 } from './audioFormat.js';
import { PlaybackAcknowledgements } from './PlaybackAcknowledgements.js';
import { sameVoiceGeneration, type EncodedAudioChunk, type PlaybackReceipt, type VoiceGeneration } from './types.js';

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
interface PublishingParticipant {
  publishTrack(track: LiveKitPublishingTrack, options: { source: number }): Promise<{ sid?: string }>;
  unpublishTrack(sid: string, stopOnUnpublish?: boolean): Promise<void>;
}
/** Call-scoped publisher options; generation is read afresh at every admission and after awaited native operations. */
export interface LiveKitAudioPublisherOptions {
  scopeId: string; callId: string; generation(): VoiceGeneration;
  sampleRate: 16000 | 24000 | 48000;
  maxBytes: number; maxDurationMs: number; receiptTimeoutMs: number;
  /** Actual optional peer module or a structural fixture; import occurs only when publishing is selected. */
  rtc?: unknown;
}
/** Loads only the optional publishing peer; no native dependency enters browser imports or listen-only construction. */
export async function loadLiveKitPublishingRtc(importer: (name: string) => Promise<unknown> = (name) => import(/* @vite-ignore */ name)): Promise<LiveKitPublishingRtc> {
  return publishingRtc(await importer('@livekit/rtc-node'));
}
function publishingRtc(input: unknown): LiveKitPublishingRtc {
  const rtc = input as Partial<LiveKitPublishingRtc> | undefined;
  if (!rtc || typeof rtc.AudioSource !== 'function' || typeof rtc.AudioFrame !== 'function' || typeof rtc.AudioResampler !== 'function' || typeof rtc.LocalAudioTrack?.createAudioTrack !== 'function' || typeof rtc.TrackPublishOptions !== 'function' || typeof rtc.TrackSource?.SOURCE_MICROPHONE !== 'number') throw new Error('livekit publishing SDK unavailable');
  return rtc as LiveKitPublishingRtc;
}
/** One publication with an awaited single-chunk producer and explicit native plus receiver completion. */
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
  private pending?: PlaybackReceipt;
  constructor(private readonly options: LiveKitAudioPublisherOptions, participant: unknown, private readonly send: (message: Record<string, unknown>) => Promise<void>) {
    const local = participant as Partial<PublishingParticipant> | undefined;
    if (!local || typeof local.publishTrack !== 'function' || typeof local.unpublishTrack !== 'function') throw new Error('livekit publishing participant required');
    this.participant = local as PublishingParticipant;
    if (!options.scopeId || !options.callId || ![16000, 24000, 48000].includes(options.sampleRate) || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 2 || !Number.isSafeInteger(options.maxDurationMs) || options.maxDurationMs <= 0 || options.maxDurationMs > 2000) throw new Error('invalid livekit publisher bound');
    this.acks = new PlaybackAcknowledgements(options.receiptTimeoutMs);
  }
  /** Publishes exactly once, before the host records connected readiness. */
  ready(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('publisher closed'));
    if (this.preparation) return this.preparation;
    this.preparation = (async () => {
      const rtc = this.options.rtc ? publishingRtc(this.options.rtc) : await loadLiveKitPublishingRtc();
      if (this.closed) throw new Error('publisher closed'); this.rtc = rtc;
      this.source = new rtc.AudioSource(this.options.sampleRate, 1, this.options.maxDurationMs);
      this.track = rtc.LocalAudioTrack.createAudioTrack('voice', this.source);
      const options = new rtc.TrackPublishOptions(); options.source = rtc.TrackSource.SOURCE_MICROPHONE;
      const publication = await this.participant.publishTrack(this.track, options);
      if (!publication.sid) throw new Error('publication id missing'); this.publication = publication.sid;
      if (this.closed) throw new Error('publisher closed');
    })(); return this.preparation;
  }
  private live(generation: VoiceGeneration, captured: number): void {
    if (this.closed || captured !== this.cancellation || !sameVoiceGeneration(generation, this.options.generation())) throw new Error('publisher cancelled');
  }
  /** Decodes and resamples once at this boundary, then awaits every capture callback before accepting another chunk. */
  async sendAudio(chunk: EncodedAudioChunk): Promise<void> {
    if (this.closed || this.sending || this.pending || this.clearWork) throw new Error('publisher outstanding or closed');
    if (chunk.scopeId !== this.options.scopeId || chunk.callId !== this.options.callId || !chunk.generation || !chunk.sequence || !sameVoiceGeneration(chunk.generation, this.options.generation())) throw new Error('publisher scope or generation refused');
    const pcm = inspectPcm16(chunk); const expected = Math.ceil(pcm.samples * this.options.sampleRate / pcm.sampleRate);
    if (pcm.durationMs > this.options.maxDurationMs || pcm.pcm.length + expected * 2 > this.options.maxBytes || chunk.audio.length > this.options.maxBytes + 4096) throw new Error('publisher decoded bound');
    const generation = { ...chunk.generation }; const captured = this.cancellation;
    const receipt: PlaybackReceipt = { generation, sequence: chunk.sequence, playedSamples: pcm.samples, sampleRate: pcm.sampleRate };
    this.acks.begin(receipt); this.pending = receipt;
    const work = (async () => {
      await this.ready(); this.live(generation, captured); const rtc = this.rtc!;
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
      await this.send({ type: 'audio', scopeId: this.options.scopeId, callId: this.options.callId, generation, sequence: receipt.sequence,
        publicationId: this.publication, encoding: 'pcm16le', channels: 1, samples: pcm.samples, sampleRate: pcm.sampleRate,
        publishedSamples, publishedSampleRate: this.options.sampleRate });
      for (const output of frames) {
        this.live(generation, captured);
        // AudioFrame.protoInfo reads the full backing allocation; never pass an offset view to it.
        const owned = new rtc.AudioFrame(Int16Array.from(output.data), output.sampleRate, 1, output.samplesPerChannel);
        await this.source!.captureFrame(owned); this.live(generation, captured);
      }
    })(); this.sending = work;
    try { await work; } finally { if (this.sending === work) this.sending = undefined; }
  }
  /** Both acknowledgements are mandatory. clearQueue's local waiter release cannot count as playback. */
  async waitForPlayback(generation: VoiceGeneration, sequence: number, signal: AbortSignal): Promise<PlaybackReceipt> {
    const pending = this.pending; const captured = this.cancellation;
    if (!pending || !sameVoiceGeneration(pending.generation, generation) || pending.sequence !== sequence || !this.source) throw new Error('missing publisher receipt');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('publisher drain timeout')), this.options.receiptTimeoutMs); });
    try {
      const [receipt] = await Promise.race([Promise.all([this.acks.wait(generation, sequence, signal), this.source.waitForPlayout()]), deadline]);
      this.live(generation, captured); if (signal.aborted) throw new Error('publisher cancelled'); return receipt;
    } finally { if (timer) clearTimeout(timer); if (this.pending === pending) this.pending = undefined; }
  }
  /** Only the authenticated intended participant's parsed control stream calls this method. */
  receiveReceipt(input: unknown): boolean { return this.acks.receive(input); }
  /** Invalidates immediately, clears native queue, waits out capture, clears again, then awaits remote discard. */
  clearPlayback(generation: VoiceGeneration): Promise<void> {
    if (this.closed) return this.closing ?? Promise.resolve();
    if (this.clearWork) return this.clearWork;
    if (this.pending && !sameVoiceGeneration(this.pending.generation, generation)) return Promise.resolve();
    this.cancellation++; this.source?.clearQueue(); const sending = this.sending;
    const work = (async () => {
      await sending?.catch(() => {}); this.source?.clearQueue();
      await this.acks.clear(generation, (message) => this.send({ ...message })); this.pending = undefined;
    })(); this.clearWork = work;
    return work.finally(() => { if (this.clearWork === work) this.clearWork = undefined; });
  }
  /** Confirms unpublication and native disposal once. Rejection is incomplete cleanup, never stop evidence. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.cancellation++; this.acks.close();
    const failures: unknown[] = [];
    try { this.source?.clearQueue(); } catch (error) { failures.push(error); }
    this.closing = (async () => {
      await this.preparation?.catch(() => {}); await this.sending?.catch(() => {}); await this.clearWork?.catch(() => {});
      try { this.source?.clearQueue(); } catch (error) { failures.push(error); }
      if (this.publication) try { await this.participant.unpublishTrack(this.publication, false); } catch (error) { failures.push(error); }
      try { await this.track?.close(false); } catch (error) { failures.push(error); }
      try { await this.source?.close(); } catch (error) { failures.push(error); }
      this.pending = undefined;
      if (failures.length) throw new Error('publisher cleanup incomplete');
    })(); return this.closing;
  }
}
