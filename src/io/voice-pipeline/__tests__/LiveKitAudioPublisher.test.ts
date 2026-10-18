import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveKitAudioPublisher, type LiveKitPublishingRtc, type PublishedAudioFrame } from '../LiveKitAudioPublisher.js';
import { LiveKitStreamTransport } from '../LiveKitStreamTransport.js';
import type { AudioFrame, EncodedAudioChunk, VoiceGeneration } from '../types.js';
import { FakeAudioSource, FakeAudioStream, FakeRoom, FakePublication, FakeTrack, fakePublishingRtc, fakeRtc, rtcFrame, settle } from '../../hearing/__tests__/livekit-fakes.js';

/** The host's setting that keeps the receipt protocol: each chunk counts as played once the participant answers for it. */
const receipts = { playout: 'participant' } as const;

function fixture() {
  let generation: VoiceGeneration = { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 };
  let captureGate: Promise<void> | undefined; let drainGate: Promise<void> | undefined;
  const captures: PublishedAudioFrame[] = []; const messages: Record<string, unknown>[] = [];
  const clear = vi.fn(); const sourceClose = vi.fn(async () => {}); const trackClose = vi.fn(async (_closeSource?: boolean) => {});
  const resample = vi.fn(); const flush = vi.fn(); const resamplerClose = vi.fn(); const sources = vi.fn();
  class Frame implements PublishedAudioFrame {
    constructor(readonly data: Int16Array, readonly sampleRate: number, readonly channels: number, readonly samplesPerChannel: number) {}
  }
  const rtc: LiveKitPublishingRtc = {
    AudioFrame: Frame,
    AudioSource: class {
      constructor(rate: number, channels: number, queue: number) { sources(rate, channels, queue); }
      async captureFrame(frame: PublishedAudioFrame) { await captureGate; captures.push(frame); }
      async waitForPlayout() { await drainGate; }
      clearQueue = clear; close = sourceClose;
    },
    AudioResampler: class {
      constructor(private readonly input: number, private readonly output: number, _channels: number) {}
      push(frame: PublishedAudioFrame) { resample(); const size = frame.samplesPerChannel * this.output / this.input; return [new Frame(new Int16Array(size), this.output, 1, size)]; }
      flush() { flush(); return []; }
      close() { resamplerClose(); }
    },
    LocalAudioTrack: { createAudioTrack: vi.fn(() => ({ close: trackClose })) },
    TrackPublishOptions: class { source = 0; }, TrackSource: { SOURCE_MICROPHONE: 2 },
  };
  const participant = { publishTrack: vi.fn(async () => ({ sid: 'track-a' })), unpublishTrack: vi.fn(async () => {}) };
  const publisher = new LiveKitAudioPublisher({ ...receipts, scopeId: 'scope-a', callId: 'call-a', generation: () => generation, sampleRate: 48000, maxBytes: 256000, maxDurationMs: 2000, receiptTimeoutMs: 1000, rtc }, participant, async (message) => { messages.push(message); });
  const chunk = (sampleRate = 16000, sequence = 1): EncodedAudioChunk => ({ scopeId: 'scope-a', callId: 'call-a', generation: { ...generation }, sequence, audio: Buffer.alloc(sampleRate / 50 * 2), format: 'pcm', container: 'raw', sampleRate, durationMs: 20, text: '' });
  const ack = (c: EncodedAudioChunk) => publisher.receiveReceipt({ type: 'playback', generation: c.generation, sequence: c.sequence, playedSamples: c.audio.length / 2, sampleRate: c.sampleRate });
  return { publisher, rtc, participant, chunk, ack, captures, messages, clear, sourceClose, trackClose, sources, resample, flush, resamplerClose,
    nextGeneration: () => { generation = { ...generation, inferenceGeneration: generation.inferenceGeneration + 1 }; },
    capture: (gate?: Promise<void>) => { captureGate = gate; }, drain: (gate?: Promise<void>) => { drainGate = gate; } };
}
beforeEach(() => { FakeAudioStream.opened.length = 0; });
describe('native publishing boundary', () => {
  it('publishes once, converts once, flushes resampling and awaits both native drain and the receiver', async () => {
    const f = fixture(); let drain!: () => void; f.drain(new Promise<void>((resolve) => { drain = resolve; }));
    const chunk = f.chunk(24000); await f.publisher.sendAudio(chunk);
    expect(f.participant.publishTrack).toHaveBeenCalledOnce(); expect(f.resample).toHaveBeenCalledOnce(); expect(f.flush).toHaveBeenCalledOnce(); expect(f.resamplerClose).toHaveBeenCalledOnce();
    expect(f.captures[0]).toMatchObject({ sampleRate: 48000, channels: 1, samplesPerChannel: 960 });
    let finished = false; const playback = f.publisher.waitForPlayback(chunk.generation!, 1, new AbortController().signal).then((receipt) => { finished = true; return receipt; });
    f.ack(chunk); await settle(); expect(finished).toBe(false); drain();
    expect(await playback).toMatchObject({ playedSamples: 480, sampleRate: 24000 });
    const second = f.chunk(48000, 2); await f.publisher.sendAudio(second); f.ack(second); await f.publisher.waitForPlayback(second.generation!, 2, new AbortController().signal);
    expect(f.participant.publishTrack).toHaveBeenCalledOnce(); expect(f.resample).toHaveBeenCalledOnce();
    await f.publisher.close(); await f.publisher.close(); expect(f.participant.unpublishTrack).toHaveBeenCalledOnce(); expect(f.trackClose).toHaveBeenCalledWith(false); expect(f.sourceClose).toHaveBeenCalledOnce();
  });
  it('bounds concurrent producers and clears again after a stalled native capture completes', async () => {
    const f = fixture(); let release!: () => void; f.capture(new Promise<void>((resolve) => { release = resolve; }));
    const chunk = f.chunk(); const sent = expect(f.publisher.sendAudio(chunk)).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(f.messages.some((m) => m.type === 'audio')).toBe(true));
    await expect(f.publisher.sendAudio(f.chunk(16000, 2))).rejects.toThrow('outstanding');
    const cleared = f.publisher.clearPlayback(chunk.generation!); expect(f.clear).toHaveBeenCalled(); release(); await sent;
    await vi.waitFor(() => expect(f.messages.some((m) => m.type === 'clear')).toBe(true));
    const message = f.messages.find((m) => m.type === 'clear')!;
    f.publisher.receiveReceipt({ type: 'cleared', generation: message.generation, clearId: message.clearId }); await cleared;
    expect(f.clear.mock.calls.length).toBeGreaterThanOrEqual(2);
    f.capture(); f.nextGeneration(); const next = f.chunk(); await f.publisher.sendAudio(next); f.ack(next); await f.publisher.waitForPlayback(next.generation!, 1, new AbortController().signal);
    await f.publisher.close();
  });
  it('refuses foreign scope, stale fences, bad containers, wrong lengths and oversized decoded output', async () => {
    const f = fixture();
    const bad: EncodedAudioChunk[] = [
      { ...f.chunk(), scopeId: 'scope-b' }, { ...f.chunk(), callId: 'call-b' },
      { ...f.chunk(), format: 'mp3', container: 'mp3' }, { ...f.chunk(), audio: Buffer.from('RIFFnot-raw') },
      { ...f.chunk(), durationMs: 200 }, { ...f.chunk(), audio: Buffer.alloc(3) },
      { ...f.chunk(), audio: Buffer.alloc(128002), durationMs: 4000.0625 },
    ];
    const old = f.chunk();
    for (const chunk of bad) await expect(f.publisher.sendAudio(chunk)).rejects.toThrow(); f.nextGeneration(); await expect(f.publisher.sendAudio(old)).rejects.toThrow();
    expect(f.captures).toHaveLength(0); expect(f.participant.publishTrack).not.toHaveBeenCalled(); await f.publisher.close();
  });
  it('holds nothing on a pause in participant playout, where the page holds the audio it plays', async () => {
    const f = fixture(); const chunk = f.chunk(); await f.publisher.sendAudio(chunk);
    f.publisher.pause(); expect(f.clear).not.toHaveBeenCalled();
    f.ack(chunk); await f.publisher.waitForPlayback(chunk.generation!, 1, new AbortController().signal);
    await f.publisher.sendAudio(f.chunk(16000, 2)); expect(f.captures).toHaveLength(2);
    await f.publisher.close();
  });
  it('unwraps PCM WAV once and never captures its container header', async () => {
    const f = fixture(); const chunk = f.chunk(48000); const raw = chunk.audio; const wav = Buffer.alloc(44 + raw.length);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(raw.length, 40); raw.copy(wav, 44);
    await f.publisher.sendAudio({ ...chunk, audio: wav, container: 'wav' });
    expect(f.captures[0]!.data.length).toBe(960); expect(f.resample).not.toHaveBeenCalled();
    f.ack(chunk); await f.publisher.waitForPlayback(chunk.generation!, 1, new AbortController().signal); await f.publisher.close();
  });
});
describe('optional transport publisher', () => {
  it.each(['acknowledged', 'rejected'] as const)('waits for native input cancellation to be %s', async (outcome) => {
    let resolve!: () => void; let reject!: (error: Error) => void;
    const gate = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const getReader = FakeAudioStream.prototype.getReader;
    const readerSpy = vi.spyOn(FakeAudioStream.prototype, 'getReader').mockImplementation(function (this: FakeAudioStream) {
      const reader = getReader.call(this); const cancel = reader.cancel.bind(reader);
      reader.cancel = async () => { await cancel(); await gate; }; return reader;
    });
    try {
      const room = new FakeRoom(); room.addParticipant('participant-a', new FakePublication(new FakeTrack('microphone')));
      const transport = new LiveKitStreamTransport({ room, participantIdentity: 'participant-a', sampleRate: 16000, rtc: fakeRtc() });
      await vi.waitFor(() => expect(FakeAudioStream.opened).toHaveLength(1));
      let done = false; transport.close(); const closing = transport.whenClosed();
      void closing.then(() => { done = true; }, () => {}); await settle(); expect(done).toBe(false);
      if (outcome === 'acknowledged') { resolve(); await closing; expect(done).toBe(true); }
      else { const failure = expect(closing).rejects.toThrow(); reject(new Error('native cancellation refused')); await failure; expect(done).toBe(false); }
      expect(FakeAudioStream.opened[0]?.cancelled).toBe(true); expect(room.isConnected).toBe(true);
    } finally { resolve(); readerSpy.mockRestore(); }
  });
  it('retains listen-only refusal and the released bounded input buffer/gap', async () => {
    const room = new FakeRoom(); room.addParticipant('participant-a', new FakePublication(new FakeTrack('microphone')));
    const transport = new LiveKitStreamTransport({ room, participantIdentity: 'participant-a', sampleRate: 16000, bufferMs: 40, rtc: fakeRtc() });
    const frames: AudioFrame[] = []; const gaps: unknown[] = []; transport.on('audio', (f: AudioFrame) => frames.push(f)); transport.on('gap', (g: unknown) => gaps.push(g));
    await expect(transport.sendAudio(fixture().chunk())).rejects.toThrow('does not publish audio');
    await settle(); transport.emit('pause');
    for (let i = 0; i < 4; i++) FakeAudioStream.opened[0]!.push(rtcFrame(new Array(320).fill(0), 16000, 1));
    await settle(); transport.emit('resume'); expect(frames).toHaveLength(2); expect(gaps).toEqual([{ droppedMs: 40, reason: 'paused' }]);
    transport.close(); await transport.whenClosed();
  });
  it('publishes once, requests one input conversion and closes on its participant loss without closing the room', async () => {
    const f = fixture(); const room = new FakeRoom(); Object.assign(room.localParticipant, f.participant);
    room.addParticipant('participant-a', new FakePublication(new FakeTrack('microphone')));
    const transport = new LiveKitStreamTransport({ room, participantIdentity: 'participant-a', sampleRate: 16000, rtc: fakeRtc(),
      publisher: { scopeId: 'scope-a', callId: 'call-a', generation: () => ({ workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 }), sampleRate: 48000, maxBytes: 256000, maxDurationMs: 2000, receiptTimeoutMs: 1000, rtc: f.rtc } });
    await transport.readyForPlayback(); await settle();
    expect(FakeAudioStream.opened[0]!.options).toMatchObject({ sampleRate: 16000, numChannels: 1 });
    const audio: AudioFrame[] = []; transport.on('audio', (frame: AudioFrame) => audio.push(frame));
    FakeAudioStream.opened[0]!.push(rtcFrame([16384, -16384], 16000, 1)); await settle(); expect([...audio[0]!.samples]).toEqual([0.5, -0.5]);
    room.emit('participantDisconnected', { identity: 'foreign' }); expect(transport.state).toBe('open');
    room.emit('participantDisconnected', { identity: 'participant-a' }); expect(transport.state).toBe('closed');
    await transport.whenClosed(); expect(room.isConnected).toBe(true); expect(f.participant.unpublishTrack).toHaveBeenCalledOnce();
  });
  it('reads bounded receiver controls only from the selected participant and rejects oversized streams', async () => {
    const f = fixture(); const room = new FakeRoom(); Object.assign(room.localParticipant, f.participant);
    room.addParticipant('participant-a', new FakePublication(new FakeTrack('microphone')));
    const transport = new LiveKitStreamTransport({ room, participantIdentity: 'participant-a', sampleRate: 16000, rtc: fakeRtc(),
      publisher: { scopeId: 'scope-a', callId: 'call-a', generation: () => ({ workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 }), sampleRate: 48000, maxBytes: 256000, maxDurationMs: 2000, receiptTimeoutMs: 1000, rtc: f.rtc } });
    const errors: Error[] = []; transport.on('error', (error: Error) => errors.push(error)); await transport.readyForPlayback();
    const reader = (text: string) => ({ readAll: vi.fn(async () => text), close: vi.fn(async () => {}), async *[Symbol.asyncIterator]() { yield text; } });
    const foreign = reader('{}'); room.textHandlers.get('agentos.voice')!(foreign, { identity: 'foreign' }); await settle(); expect(foreign.close).toHaveBeenCalled(); expect(foreign.readAll).not.toHaveBeenCalled();
    const large = reader('x'.repeat(4097)); room.textHandlers.get('agentos.voice')!(large, { identity: 'participant-a' }); await settle();
    expect(errors[0]?.message).toBe('livekit control refused'); expect(large.close).toHaveBeenCalled();
    transport.close(); await transport.whenClosed();
  });
});

describe('native playout', () => {
  const generation: VoiceGeneration = { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 };
  /** A chunk as a session without a call profile sends it: no scope, call, generation or sequence. */
  const unscoped = (sampleRate = 16000): EncodedAudioChunk => ({ audio: Buffer.alloc(sampleRate / 50 * 2), format: 'pcm', container: 'raw', sampleRate, durationMs: 20, text: '' });
  /** A publisher left to its default playout, with no participant that declares receipts. */
  function native(receiptTimeoutMs = 1000) {
    const messages: Record<string, unknown>[] = [];
    const participant = { publishTrack: vi.fn(async () => ({ sid: 'track-a' })), unpublishTrack: vi.fn(async () => {}) };
    const publisher = new LiveKitAudioPublisher({ scopeId: 'scope-a', callId: 'call-a', generation: () => generation, sampleRate: 48000, maxBytes: 256000, maxDurationMs: 2000, receiptTimeoutMs, rtc: fakePublishingRtc() }, participant, async (message) => { messages.push(message); });
    return { publisher, messages, participant, source: () => FakeAudioSource.created[0]! };
  }
  beforeEach(() => { FakeAudioSource.created.length = 0; });
  it('plays chunks without a call identity, announces none of them, and acknowledges one once the track has played it out', async () => {
    const f = native();
    await f.publisher.sendAudio(unscoped(24000)); await f.publisher.sendAudio(unscoped(16000));
    expect(f.source().capturedSamples).toBe(1920); expect(f.messages).toEqual([]); expect(f.participant.publishTrack).toHaveBeenCalledOnce();
    let played = false; const playback = f.publisher.waitForPlayback(generation, 2, new AbortController().signal).then((receipt) => { played = true; return receipt; });
    await settle(); expect(played).toBe(false);
    f.source().playOut();
    expect(await playback).toEqual({ generation, sequence: 2, playedSamples: 320, sampleRate: 16000 });
    await f.publisher.close(); expect(f.participant.unpublishTrack).toHaveBeenCalledOnce();
  });
  it('clears the track without asking the participant, and a cleared chunk never counts as played', async () => {
    const f = native();
    await f.publisher.sendAudio(unscoped());
    const failed = expect(f.publisher.waitForPlayback(generation, 1, new AbortController().signal)).rejects.toThrow('cancelled');
    await f.publisher.clearPlayback(generation); await failed;
    expect(f.source().clears).toBe(2); expect(f.messages).toEqual([]);
    await f.publisher.sendAudio(unscoped()); const next = f.publisher.waitForPlayback(generation, 2, new AbortController().signal);
    f.source().playOut(); expect(await next).toMatchObject({ sequence: 2, playedSamples: 320, sampleRate: 16000 });
    await f.publisher.close();
  });
  it('resolves each send a clear cuts short, and captures nothing it discarded', async () => {
    const f = native(); await f.publisher.ready();
    let release!: () => void; f.source().gate = new Promise<void>((resolve) => { release = resolve; });
    const first = f.publisher.sendAudio(unscoped()); const second = f.publisher.sendAudio(unscoped());
    await settle(); const cleared = f.publisher.clearPlayback(generation); release();
    await expect(first).resolves.toBeUndefined(); await expect(second).resolves.toBeUndefined(); await cleared;
    expect(f.source().capturedSamples).toBe(960); expect(f.source().clears).toBe(2); expect(f.messages).toEqual([]);
    await f.publisher.close();
  });
  it('needs no call identity, and refuses participant playout without one', async () => {
    const participant = { publishTrack: vi.fn(async () => ({ sid: 'track-a' })), unpublishTrack: vi.fn(async () => {}) };
    const bounds = { sampleRate: 48000 as const, maxBytes: 256000, maxDurationMs: 2000, receiptTimeoutMs: 1000, rtc: fakePublishingRtc() };
    expect(() => new LiveKitAudioPublisher({ ...bounds, playout: 'participant' }, participant, async () => {})).toThrow('invalid livekit publisher bound');
    const publisher = new LiveKitAudioPublisher(bounds, participant, async () => {});
    expect(publisher.playout).toBeUndefined();
    await publisher.sendAudio(unscoped()); expect(publisher.playout).toBe('native');
    const playback = publisher.waitForPlayback(generation, 1, new AbortController().signal); FakeAudioSource.created[0]!.playOut();
    expect(await playback).toMatchObject({ sequence: 1, playedSamples: 320, sampleRate: 16000 });
    await publisher.close();
  });
  it('waits for the track to play out no longer than receiptTimeoutMs', async () => {
    const f = native(20);
    await f.publisher.sendAudio(unscoped());
    await expect(f.publisher.waitForPlayback(generation, 1, new AbortController().signal)).rejects.toThrow('publisher drain timeout');
    await f.publisher.close();
  });
  it('ends a playout wait at once on a clear or a close, though the track never reports its playout', async () => {
    const f = native(); await f.publisher.sendAudio(unscoped());
    f.source().waitForPlayout = () => new Promise<void>(() => {});
    let ended = 0;
    void f.publisher.waitForPlayout().then(() => { ended++; });
    await settle(); expect(ended).toBe(0);
    await f.publisher.clearPlayback(generation); await settle(); expect(ended).toBe(1);
    await f.publisher.sendAudio(unscoped());
    void f.publisher.waitForPlayout().then(() => { ended++; });
    await settle(); expect(ended).toBe(1);
    await f.publisher.close(); await settle(); expect(ended).toBe(2);
  });
  it('gives a playout wait up when a capture stalls for receiptTimeoutMs plus maxDurationMs, and clears the stalled frame as it lands', async () => {
    const f = native(); await f.publisher.ready();
    let land!: () => void; f.source().gate = new Promise<void>((resolve) => { land = resolve; });
    // The first chunk's capture does not return while the gate holds, and the second waits behind it.
    const first = f.publisher.sendAudio(unscoped()); const second = f.publisher.sendAudio(unscoped());
    await settle();
    let outcome: string | undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      void f.publisher.waitForPlayout().then(() => { outcome = 'played'; }, (error: Error) => { outcome = error.message; });
      await settle();
      // receiptTimeoutMs is 1000 and maxDurationMs 2000.
      await vi.advanceTimersByTimeAsync(2_999); await settle(); expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1); await settle(); expect(outcome).toBe('publisher drain timeout');
      expect(f.source().clears).toBe(1);
    } finally { vi.useRealTimers(); }
    // The stalled frame lands later and is cleared as it lands; the chunk queued behind it is never captured.
    f.source().gate = undefined; land(); await first; await second;
    expect(f.source().capturedSamples).toBe(960); expect(f.source().clears).toBe(2);
    await f.publisher.close();
  });
  it('starts the playout bound once the track is published, so a first publish slower than the bound drops nothing', async () => {
    let publish!: () => void;
    const participant = { publishTrack: vi.fn(() => new Promise<{ sid: string }>((resolve) => { publish = () => resolve({ sid: 'track-a' }); })), unpublishTrack: vi.fn(async () => {}) };
    const publisher = new LiveKitAudioPublisher({ scopeId: 'scope-a', callId: 'call-a', generation: () => generation, sampleRate: 48000, maxBytes: 256000, maxDurationMs: 2000, receiptTimeoutMs: 1000, rtc: fakePublishingRtc() }, participant, async () => {});
    let outcome: string | undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const sent = publisher.sendAudio(unscoped());
      void publisher.waitForPlayout().then(() => { outcome = 'played'; }, (error: Error) => { outcome = error.message; });
      await settle();
      // The publish takes longer than receiptTimeoutMs plus maxDurationMs, and the wait does not give up meanwhile.
      await vi.advanceTimersByTimeAsync(5_000); await settle(); expect(outcome).toBeUndefined();
      publish(); await sent;
      expect(FakeAudioSource.created[0]!.capturedSamples).toBe(960);
      FakeAudioSource.created[0]!.playOut(); await settle(); expect(outcome).toBe('played');
    } finally { vi.useRealTimers(); }
    await publisher.close();
  });
  it('holds the track on a pause: clears its queue, captures nothing until the resume, then the held chunks in order', async () => {
    const f = native(); await f.publisher.ready();
    let free!: () => void; f.source().gate = new Promise<void>((resolve) => { free = resolve; });
    const first = f.publisher.sendAudio(unscoped()); const second = f.publisher.sendAudio(unscoped(24000));
    await settle(); f.publisher.pause(); expect(f.source().clears).toBe(1);
    f.source().gate = undefined; free(); await first;
    // The frame whose capture was under way as the pause came landed after the clear, and is cleared as well.
    expect(f.source().capturedSamples).toBe(960); expect(f.source().clears).toBe(2);
    await settle(); expect(f.source().capturedSamples).toBe(960);
    f.publisher.resume(); await second;
    expect(f.source().capturedSamples).toBe(1920); expect(f.messages).toEqual([]);
    await f.publisher.close();
  });
  it('ends a hold at a clear or a close, and discards what it held', async () => {
    const f = native(); await f.publisher.sendAudio(unscoped());
    f.publisher.pause(); const held = f.publisher.sendAudio(unscoped());
    await settle(); expect(f.source().capturedSamples).toBe(960);
    await f.publisher.clearPlayback(generation); await expect(held).resolves.toBeUndefined();
    f.publisher.pause(); const closed = f.publisher.sendAudio(unscoped());
    await f.publisher.close(); await expect(closed).resolves.toBeUndefined();
    expect(f.source().capturedSamples).toBe(960);
  });
  it('does not count a chunk whose queue a pause emptied as played', async () => {
    const f = native(); await f.publisher.sendAudio(unscoped());
    const playback = expect(f.publisher.waitForPlayback(generation, 1, new AbortController().signal)).rejects.toThrow('publisher cancelled');
    await settle(); f.publisher.pause(); await playback;
    await f.publisher.close();
  });
  it('does not count a chunk as played when a pause cleared it before its playback wait began', async () => {
    const f = native(); await f.publisher.sendAudio(unscoped());
    // The pause comes after the send resolved and before the wait begins; a resume does not bring the audio back.
    f.publisher.pause(); f.publisher.resume();
    await expect(f.publisher.waitForPlayback(generation, 1, new AbortController().signal)).rejects.toThrow('publisher cancelled');
    // A chunk the track takes after the resume counts once it has played out.
    await f.publisher.sendAudio(unscoped()); const next = f.publisher.waitForPlayback(generation, 2, new AbortController().signal);
    f.source().playOut(); expect(await next).toMatchObject({ sequence: 2, playedSamples: 320, sampleRate: 16000 });
    await f.publisher.close();
  });
  it('clears a frame whose capture was under way as a pause came, even when a resume came before it landed', async () => {
    const f = native(); await f.publisher.ready();
    let free!: () => void; f.source().gate = new Promise<void>((resolve) => { free = resolve; });
    const sent = f.publisher.sendAudio(unscoped());
    // A false interruption: the pause and the resume both come while the frame's capture waits for room in the queue.
    await settle(); f.publisher.pause(); f.publisher.resume(); expect(f.source().clears).toBe(1);
    f.source().gate = undefined; free(); await sent;
    // The frame landed after the pause's clear and is cleared as it lands, so nothing from before the pause plays after it.
    expect(f.source().clears).toBe(2);
    let drained = false; void f.source().waitForPlayout().then(() => { drained = true; }); await settle(); expect(drained).toBe(true);
    // The track takes the next chunk as usual.
    await f.publisher.sendAudio(unscoped()); const next = f.publisher.waitForPlayback(generation, 2, new AbortController().signal);
    f.source().playOut(); expect(await next).toMatchObject({ sequence: 2, playedSamples: 320, sampleRate: 16000 });
    await f.publisher.close();
  });
  /** A publisher left to its default playout and without a call identity, published by `room`'s local participant. */
  const unidentified = (room: FakeRoom, receiptTimeoutMs = 1000) => new LiveKitAudioPublisher({ sampleRate: 48000, maxBytes: 256000, maxDurationMs: 2000, receiptTimeoutMs, rtc: fakePublishingRtc() }, room.localParticipant, async () => {});
  it('captures nothing until a participant has subscribed to the track', async () => {
    const room = new FakeRoom(); let subscribe!: () => void;
    room.subscription = new Promise<void>((resolve) => { subscribe = resolve; });
    const publisher = unidentified(room);
    const sent = publisher.sendAudio(unscoped()); await settle();
    expect(room.localParticipant.publishTrack).toHaveBeenCalledOnce(); expect(FakeAudioSource.created[0]!.capturedSamples).toBe(0);
    subscribe(); await sent;
    expect(FakeAudioSource.created[0]!.capturedSamples).toBe(960);
    await publisher.close();
  });
  it('waits for a subscription no longer than receiptTimeoutMs, then plays', async () => {
    const room = new FakeRoom(); room.subscription = new Promise<void>(() => {});
    const publisher = unidentified(room, 20);
    await publisher.sendAudio(unscoped());
    expect(FakeAudioSource.created[0]!.capturedSamples).toBe(960);
    await publisher.close();
  });
  it('stops waiting for a subscription when it closes, and plays nothing', async () => {
    const room = new FakeRoom(); room.subscription = new Promise<void>(() => {});
    const publisher = unidentified(room, 30000);
    const sent = publisher.sendAudio(unscoped()); await settle();
    await publisher.close(); await expect(sent).resolves.toBeUndefined();
    expect(FakeAudioSource.created[0]!.capturedSamples).toBe(0); expect(room.localParticipant.unpublishTrack).toHaveBeenCalledOnce();
  });
  it('refuses a chunk that carries a scope, a call or a generation when the publisher has none of its own', async () => {
    const room = new FakeRoom(); const publisher = unidentified(room);
    for (const chunk of [{ ...unscoped(), scopeId: 'scope-b' }, { ...unscoped(), callId: 'call-b' }, { ...unscoped(), generation }]) {
      await expect(publisher.sendAudio(chunk)).rejects.toThrow('publisher scope or generation refused');
    }
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    // A chunk that carries none still plays.
    await publisher.sendAudio(unscoped());
    expect(FakeAudioSource.created[0]!.capturedSamples).toBe(960);
    await publisher.close();
  });
});
describe('loading @livekit/rtc-node', () => {
  const generation: VoiceGeneration = { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 };
  /** Any import of the peer fails, as when it is not installed. */
  const missing = () => vi.doMock('@livekit/rtc-node', () => { throw new Error("Cannot find package '@livekit/rtc-node'"); });
  beforeEach(() => { FakeAudioSource.created.length = 0; });
  it('names the package and how to install it when the peer is missing', async () => {
    missing();
    try {
      const participant = { publishTrack: vi.fn(async () => ({ sid: 'track-a' })), unpublishTrack: vi.fn(async () => {}) };
      const publisher = new LiveKitAudioPublisher({ scopeId: 'scope-a', callId: 'call-a', generation: () => generation, sampleRate: 48000, maxBytes: 256000, maxDurationMs: 2000, receiptTimeoutMs: 1000 }, participant, async () => {});
      await expect(publisher.ready()).rejects.toThrow('@livekit/rtc-node is required for the LiveKit room audio source and transport. Install it: npm install @livekit/rtc-node');
      expect(participant.publishTrack).not.toHaveBeenCalled(); await publisher.close();
    } finally { vi.doUnmock('@livekit/rtc-node'); }
  });
  it("publishes through the transport's rtc module, so one module serves input and output and nothing is imported", async () => {
    missing();
    try {
      const room = new FakeRoom(); room.addParticipant('participant-a', new FakePublication(new FakeTrack('microphone')));
      const transport = new LiveKitStreamTransport({ room, participantIdentity: 'participant-a', sampleRate: 16000, rtc: { ...fakeRtc(), ...fakePublishingRtc() },
        publisher: { scopeId: 'scope-a', callId: 'call-a', generation: () => generation, sampleRate: 48000, maxBytes: 256000, maxDurationMs: 2000, receiptTimeoutMs: 1000 } });
      await transport.readyForPlayback();
      expect(room.localParticipant.publishTrack).toHaveBeenCalledOnce(); expect(FakeAudioSource.created).toHaveLength(1);
      await vi.waitFor(() => expect(FakeAudioStream.opened).toHaveLength(1));
      transport.close(); await transport.whenClosed();
    } finally { vi.doUnmock('@livekit/rtc-node'); }
  });
});
