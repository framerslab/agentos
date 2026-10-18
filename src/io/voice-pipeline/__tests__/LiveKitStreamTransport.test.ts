/**
 * Unit tests for LiveKitStreamTransport.
 *
 * Runs over the fake rtc-node room of the hearing tests: audio is pushed into
 * a fake AudioStream, text streams are delivered to the registered handler,
 * sends are read from the fake local participant, and what a speaking
 * transport publishes is read from a fake AudioSource.
 * The listening transport runs once under the real VoicePipelineOrchestrator;
 * the speaking transport runs under it with and without a call profile, for a
 * SIP caller and for a plain LiveKit participant.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LiveKitStreamTransport } from '../LiveKitStreamTransport.js';
import { VoicePipelineOrchestrator, type CallPipelineProfile } from '../VoicePipelineOrchestrator.js';
import { SoftFadeBargeinHandler } from '../SoftFadeBargeinHandler.js';
import type {
  AudioFrame,
  AudioIdentity,
  ClientTextMessage,
  EncodedAudioChunk,
  IAudioEndpointDetector,
  IBargeinHandler,
  IEndpointDetector,
  IStreamingSTT,
  IStreamingTTS,
  IVadSession,
  IVoicePipelineAgentSession,
  ScopedAudioFrame,
  ScopedStreamingSTTSession,
  StreamingSTTSession,
  StreamingTTSConfig,
  StreamingTTSSession,
  TurnCompleteEvent,
  VoiceGeneration,
} from '../types.js';
import {
  FakeAudioSource,
  FakeAudioStream,
  FakePublication,
  FakeRoom,
  FakeTrack,
  capturedSamples,
  fakePublishingRtc,
  fakeRtc,
  rtcFrame,
  settle,
} from '../../hearing/__tests__/livekit-fakes.js';
import { recordSessionEvents } from './session-event-log.js';

function open(room: FakeRoom, topic?: string) {
  room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
  const transport = new LiveKitStreamTransport({
    room,
    participantIdentity: 'user-1',
    sampleRate: 24_000,
    rtc: fakeRtc(),
    ...(topic ? { topic } : {}),
  });
  const audio: AudioFrame[] = [];
  const messages: ClientTextMessage[] = [];
  const errors: Error[] = [];
  let closes = 0;
  transport.on('audio', (frame: AudioFrame) => audio.push(frame));
  transport.on('message', (message: ClientTextMessage) => messages.push(message));
  transport.on('error', (err: Error) => errors.push(err));
  transport.on('close', () => {
    closes += 1;
  });
  return { transport, audio, messages, errors, closes: () => closes };
}

beforeEach(() => {
  FakeAudioStream.opened.length = 0;
});

describe('LiveKitStreamTransport', () => {
  it("emits the participant's audio as Float32 frames", async () => {
    const room = new FakeRoom();
    const { transport, audio } = open(room);
    expect(transport.state).toBe('open');
    await settle();
    FakeAudioStream.opened[0].push(rtcFrame([16384, -16384]));
    await settle();
    expect(audio.map((frame) => Array.from(frame.samples))).toEqual([[0.5, -0.5]]);
    expect(audio[0].sampleRate).toBe(24_000);
    transport.close();
  });

  it('holds frames while paused, up to the buffer, and reports what it dropped as a gap', async () => {
    const room = new FakeRoom();
    room.addParticipant('bot', new FakePublication(new FakeTrack('TR_1')));
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'bot',
      sampleRate: 16_000,
      frameSizeMs: 20,
      bufferMs: 100,
      rtc: fakeRtc(),
    });
    const audio: AudioFrame[] = [];
    const gaps: unknown[] = [];
    transport.on('audio', (f: AudioFrame) => audio.push(f));
    transport.on('gap', (g: unknown) => gaps.push(g));
    await settle(); // the source opens the fake stream on its first read
    const stream = FakeAudioStream.opened[0];
    transport.emit('pause');
    // Ten frames of 20 ms at 16 kHz.
    for (let i = 0; i < 10; i++) stream.push(rtcFrame(new Array(320).fill(0), 16_000, 1));
    await settle();
    expect(audio).toEqual([]);
    transport.emit('resume');
    await settle();
    expect(audio.length).toBe(5); // 100 ms kept, the oldest 100 ms dropped
    expect(gaps).toEqual([{ droppedMs: 100, reason: 'paused' }]);
    transport.close();
  });

  it('never buffers while not paused', async () => {
    const room = new FakeRoom();
    room.addParticipant('bot', new FakePublication(new FakeTrack('TR_1')));
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'bot',
      sampleRate: 16_000,
      bufferMs: 100,
      rtc: fakeRtc(),
    });
    const audio: AudioFrame[] = [];
    transport.on('audio', (f: AudioFrame) => audio.push(f));
    await settle();
    for (let i = 0; i < 20; i++) FakeAudioStream.opened[0].push(rtcFrame(new Array(320).fill(0), 16_000, 1));
    await settle();
    expect(audio.length).toBe(20);
    transport.close();
  });

  it('stops a replay at a renewed pause and keeps the frames it has not emitted, in order', async () => {
    const room = new FakeRoom();
    room.addParticipant('bot', new FakePublication(new FakeTrack('TR_1')));
    const transport = new LiveKitStreamTransport({ room, participantIdentity: 'bot', sampleRate: 16_000, frameSizeMs: 20, rtc: fakeRtc() });
    const heard: number[] = [];
    let pauseAgain = true;
    transport.on('audio', (f: AudioFrame) => {
      heard.push(Math.round(f.samples[0] * 32768));
      if (pauseAgain) {
        pauseAgain = false;
        transport.emit('pause'); // the consumer falls behind again on the first frame replayed
      }
    });
    await settle();
    const stream = FakeAudioStream.opened[0];
    transport.emit('pause');
    for (let i = 1; i <= 5; i++) stream.push(rtcFrame(new Array(320).fill(i), 16_000, 1));
    await settle();
    expect(heard).toEqual([]);
    transport.emit('resume');
    expect(heard).toEqual([1]);
    transport.emit('resume');
    expect(heard).toEqual([1, 2, 3, 4, 5]);
    transport.close();
  });

  it('emits nothing it held once it has closed: a resume after the close replays no audio and reports no gap', async () => {
    const room = new FakeRoom();
    room.addParticipant('bot', new FakePublication(new FakeTrack('TR_1')));
    const transport = new LiveKitStreamTransport({ room, participantIdentity: 'bot', sampleRate: 16_000, frameSizeMs: 20, bufferMs: 40, rtc: fakeRtc() });
    const audio: AudioFrame[] = [];
    const gaps: unknown[] = [];
    transport.on('audio', (f: AudioFrame) => audio.push(f));
    transport.on('gap', (g: unknown) => gaps.push(g));
    await settle();
    const stream = FakeAudioStream.opened[0];
    transport.emit('pause');
    for (let i = 0; i < 5; i++) stream.push(rtcFrame(new Array(320).fill(0), 16_000, 1)); // two held, three dropped
    await settle();
    transport.close();
    transport.emit('resume'); // a session's cleanup releases its pause after the transport closed
    await settle();
    expect(audio).toEqual([]);
    expect(gaps).toEqual([]);
  });

  it('sends control messages as text streams on its topic, to the participant', async () => {
    const room = new FakeRoom();
    const { transport } = open(room);
    await transport.sendControl({ type: 'agent_thinking' });
    expect(room.localParticipant.sendText).toHaveBeenCalledWith('{"type":"agent_thinking"}', {
      topic: 'agentos.voice',
      destinationIdentities: ['user-1'],
    });
    transport.close();
  });

  it('uses the topic it is given, for both directions', async () => {
    const room = new FakeRoom();
    const { transport } = open(room, 'voice.control');
    expect([...room.textHandlers.keys()]).toEqual(['voice.control']);
    await transport.sendControl({ type: 'session_ended', reason: 'done' });
    expect(room.localParticipant.sendText).toHaveBeenCalledWith('{"type":"session_ended","reason":"done"}', {
      topic: 'voice.control',
      destinationIdentities: ['user-1'],
    });
    transport.close();
  });

  it('refuses to send a control message when the room has no local participant', async () => {
    const room = new FakeRoom();
    Object.defineProperty(room, 'localParticipant', { value: undefined });
    const { transport } = open(room);
    await expect(transport.sendControl({ type: 'agent_thinking' })).rejects.toThrow(/no local participant/);
    transport.close();
  });

  it('emits a JSON message the participant sends on its topic, and ignores other senders', async () => {
    const room = new FakeRoom();
    const { transport, messages } = open(room);
    const handler = room.textHandlers.get('agentos.voice')!;
    handler(
      { readAll: async () => JSON.stringify({ type: 'control', action: { type: 'mute' } }) },
      { identity: 'user-1' }
    );
    // Another sender's stream is closed unread, which releases what rtc-node's reader holds.
    const other = {
      readAll: vi.fn(async () => JSON.stringify({ type: 'control', action: { type: 'unmute' } })),
      close: vi.fn(async () => undefined),
    };
    handler(other, { identity: 'someone-else' });
    await settle();
    expect(messages).toEqual([{ type: 'control', action: { type: 'mute' } }]);
    expect(other.readAll).not.toHaveBeenCalled();
    expect(other.close).toHaveBeenCalledTimes(1);
    transport.close();
  });

  it('emits a transcript message the participant sends whole, every field kept', async () => {
    const room = new FakeRoom();
    const { transport, messages } = open(room);
    const transcript = {
      type: 'transcript',
      text: 'Hello there.',
      itemId: '7',
      isFinal: true,
      confidence: 0.8,
      startMs: 1200,
      endMs: 2100,
      language: 'en',
    };
    room.textHandlers.get('agentos.voice')!(
      { readAll: async () => JSON.stringify(transcript) },
      { identity: 'user-1' }
    );
    await settle();
    expect(messages).toEqual([transcript]);
    transport.close();
  });

  it('reports a message that is not JSON as an error and stays open', async () => {
    const room = new FakeRoom();
    const { transport, errors } = open(room);
    room.textHandlers.get('agentos.voice')!({ readAll: async () => 'not json' }, { identity: 'user-1' });
    await settle();
    expect(errors.map((err) => err.message)).toEqual([
      expect.stringContaining('failed to parse inbound text message as JSON'),
    ]);
    expect(transport.state).toBe('open');
    transport.close();
  });

  it('writes an error as a console warning when nothing listens for it, and stays open', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const room = new FakeRoom();
      room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
      const transport = new LiveKitStreamTransport({ room, participantIdentity: 'user-1', sampleRate: 24_000, rtc: fakeRtc() });
      room.textHandlers.get('agentos.voice')!({ readAll: async () => 'not json' }, { identity: 'user-1' });
      await settle();
      expect(warn).toHaveBeenCalledWith(
        '[livekit-stream-transport] error (no listener attached):',
        expect.stringContaining('failed to parse inbound text message as JSON')
      );
      expect(transport.state).toBe('open');
      transport.close();
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses to send audio', async () => {
    const room = new FakeRoom();
    const { transport } = open(room);
    await expect(
      transport.sendAudio({ audio: Buffer.from([0, 0]), format: 'pcm', sampleRate: 24_000, durationMs: 1, text: '' })
    ).rejects.toThrow(/does not publish audio/);
    transport.close();
  });

  it('closes once: it leaves its topic, stops the audio and emits close', async () => {
    const room = new FakeRoom();
    const { transport, closes } = open(room);
    await settle();
    transport.close();
    transport.close();
    await settle();
    expect(closes()).toBe(1);
    expect(transport.state).toBe('closed');
    expect(room.textHandlers.size).toBe(0);
    expect(FakeAudioStream.opened[0].cancelled).toBe(true);
    await expect(transport.sendControl({ type: 'agent_thinking' })).rejects.toThrow(/cannot send while closed/);
  });

  it('closes a text stream still arriving when it closes, and emits nothing from it', async () => {
    const room = new FakeRoom();
    const { transport, messages, errors } = open(room);
    // A stream whose end has not come. As with rtc-node's reader, closing it
    // ends readAll() with the text that arrived.
    let arrived: (text: string) => void = () => undefined;
    const reader = {
      readAll: vi.fn(() => new Promise<string>((resolve) => (arrived = resolve))),
      close: vi.fn(async () => arrived('{"type":"cont')),
    };
    room.textHandlers.get('agentos.voice')!(reader, { identity: 'user-1' });
    await settle();
    expect(reader.close).not.toHaveBeenCalled();
    transport.close();
    await settle();
    expect(reader.close).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('closes when the room disconnects', async () => {
    const room = new FakeRoom();
    const { transport, closes } = open(room);
    await settle();
    room.emit('disconnected', 'ROOM_DELETED');
    await settle();
    expect(closes()).toBe(1);
    expect(transport.state).toBe('closed');
  });

  it("reports a missing @livekit/rtc-node as 'error', then closes", async () => {
    vi.doMock('@livekit/rtc-node', () => {
      throw new Error("Cannot find package '@livekit/rtc-node'");
    });
    try {
      const room = new FakeRoom();
      room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
      // No rtc module is given, so the transport's audio source imports the peer at its first read.
      const transport = new LiveKitStreamTransport({ room, participantIdentity: 'user-1', sampleRate: 24_000 });
      const events: string[] = [];
      transport.on('error', (err: Error) => events.push(`error: ${err.message}`));
      transport.on('close', () => events.push('close'));
      await vi.waitFor(() => expect(transport.state).toBe('closed'), { timeout: 10_000 });
      expect(events).toEqual([
        'error: @livekit/rtc-node is required for the LiveKit room audio source and transport. Install it: npm install @livekit/rtc-node',
        'close',
      ]);
      expect(room.textHandlers.size).toBe(0);
      expect(room.listenerCount('trackSubscribed')).toBe(0);
    } finally {
      vi.doUnmock('@livekit/rtc-node');
    }
  });

  it('throws when its topic is already taken', () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    room.registerTextStreamHandler('agentos.voice', () => undefined);
    expect(
      () => new LiveKitStreamTransport({ room, participantIdentity: 'user-1', sampleRate: 24_000, rtc: fakeRtc() })
    ).toThrow(/already been set/);
    // Its source was built first and never read: nothing listens to the room.
    expect(room.listenerCount('trackSubscribed')).toBe(0);
  });

  it('leaves its topic free when it refuses its options, for a transport with good ones', () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    expect(
      () => new LiveKitStreamTransport({ room, participantIdentity: 'user-1', sampleRate: 0, rtc: fakeRtc() })
    ).toThrow(RangeError);
    expect(room.textHandlers.size).toBe(0);
    const transport = new LiveKitStreamTransport({ room, participantIdentity: 'user-1', sampleRate: 24_000, rtc: fakeRtc() });
    expect([...room.textHandlers.keys()]).toEqual(['agentos.voice']);
    transport.close();
  });

  it("runs under VoicePipelineOrchestrator: the participant's audio reaches its STT, its control messages reach the participant, and its speech raises no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const room = new FakeRoom();
    const { transport } = open(room);
    const heard: AudioFrame[] = [];
    const sttSession: StreamingSTTSession = Object.assign(new EventEmitter(), {
      pushAudio: (frame: AudioFrame) => {
        heard.push(frame);
      },
      flush: async () => undefined,
      close: () => undefined,
    });
    const ttsSession: StreamingTTSSession = Object.assign(new EventEmitter(), {
      pushTokens: (_tokens: string) => undefined,
      flush: async () => undefined,
      cancel: () => undefined,
      close: () => undefined,
    });
    const endpointDetector: IEndpointDetector = Object.assign(new EventEmitter(), {
      mode: 'heuristic' as const,
      pushVadEvent: () => undefined,
      pushTranscript: () => undefined,
      reset: () => undefined,
    });
    const streamingSTT: IStreamingSTT = { providerId: 'fake-stt', isStreaming: true, startSession: async () => sttSession };
    const streamingTTS: IStreamingTTS = { providerId: 'fake-tts', startSession: async () => ttsSession };
    const bargeinHandler: IBargeinHandler = { mode: 'hard-cut', handleBargein: () => ({ type: 'cancel' }) };
    const agentSession: IVoicePipelineAgentSession = {
      sendText: async function* () {
        yield 'Hello';
      },
    };
    const orchestrator = new VoicePipelineOrchestrator({ stt: 'fake-stt', tts: 'fake-tts' });
    try {
      await orchestrator.startSession(transport, agentSession, {
        streamingSTT,
        streamingTTS,
        endpointDetector,
        bargeinHandler,
      });
      await settle();
      FakeAudioStream.opened[0].push(rtcFrame([16384]));
      await settle();
      expect(heard.map((frame) => Array.from(frame.samples))).toEqual([[0.5]]);

      const turn: TurnCompleteEvent = { transcript: 'Hi', confidence: 0.9, durationMs: 500, reason: 'silence_timeout' };
      endpointDetector.emit('turn_complete', turn);
      await settle();
      expect(orchestrator.state).toBe('speaking');
      expect(room.localParticipant.sendText).toHaveBeenCalledWith('{"type":"agent_thinking"}', {
        topic: 'agentos.voice',
        destinationIdentities: ['user-1'],
      });

      // The orchestrator hands each chunk of its speech to sendAudio() and does not wait for the promise.
      const chunk: EncodedAudioChunk = {
        audio: Buffer.from([0, 0]),
        format: 'pcm',
        sampleRate: 24_000,
        durationMs: 20,
        text: 'Hello',
      };
      ttsSession.emit('audio', chunk);
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      await orchestrator.stopSession('done');
      process.off('unhandledRejection', onUnhandled);
    }
    expect(transport.state).toBe('closed');
    expect(room.textHandlers.size).toBe(0);
  });
});

/** A 20 ms chunk of PCM16 as a TTS session without a call profile emits it: no scope, call, generation or sequence. */
function pcmChunk(sampleRate = 24_000): EncodedAudioChunk {
  return { audio: Buffer.alloc((sampleRate / 50) * 2), format: 'pcm', container: 'raw', sampleRate, durationMs: 20, text: 'Hello' };
}

/** A 20 ms chunk of 48 kHz PCM16, the speaking track's rate, whose every sample is `value`, so the track's frames name it. */
function toneChunk(value: number): EncodedAudioChunk {
  const audio = Buffer.alloc(960 * 2);
  for (let i = 0; i < 960; i++) audio.writeInt16LE(value, i * 2);
  return { audio, format: 'pcm', container: 'raw', sampleRate: 48_000, durationMs: 20, text: 'Hello' };
}

/** The `toneChunk()` values the track captured, in order. */
function capturedTones(): number[] {
  return FakeAudioSource.created.flatMap((source) => source.captured.map((frame) => frame.data[0]!));
}

/** The fences the call below starts with. */
const firstGeneration: VoiceGeneration = { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 };

/** A 20 ms chunk of 16 kHz PCM16 as a call profile's playback queue sends it: the call's scope, fences and a sequence. */
function scopedChunk(sequence: number): EncodedAudioChunk {
  return {
    scopeId: 'scope-a',
    callId: 'call-a',
    generation: { ...firstGeneration },
    sequence,
    audio: Buffer.alloc(640),
    format: 'pcm',
    container: 'raw',
    sampleRate: 16_000,
    durationMs: 20,
    text: '',
  };
}

/** A speaking transport's publisher: the call identity the receipt protocol needs, the track's rate and the bounds. */
const speaking = {
  scopeId: 'scope-a',
  callId: 'call-a',
  generation: () => firstGeneration,
  sampleRate: 48_000 as const,
  maxBytes: 256_000,
  maxDurationMs: 2_000,
  receiptTimeoutMs: 1_000,
};

/** The host's setting that keeps the receipt protocol. */
const receipts = { playout: 'participant' } as const;

/** The types of the JSON text streams the agent sent, in order. */
function sentTypes(room: FakeRoom): string[] {
  return room.localParticipant.sendText.mock.calls.map(([text]) => (JSON.parse(text) as { type: string }).type);
}

/** One message as a text stream, read whole or through its async iterator. */
function textStream(text: string) {
  return {
    readAll: async () => text,
    close: async () => undefined,
    async *[Symbol.asyncIterator]() {
      yield text;
    },
  };
}

/** A barge-in handler that cancels the reply as soon as the participant speaks over it. */
const cancelAtOnce: IBargeinHandler = { mode: 'hard-cut', handleBargein: () => ({ type: 'cancel' }) };

/**
 * A session without a call profile on a speaking transport to `participantIdentity`, whose TTS session the test
 * drives: `reply()` completes a user turn and waits for the agent to speak. The barge-in handler is `cancelAtOnce`
 * unless `bargeinHandler` is given.
 */
async function converse(room: FakeRoom, participantIdentity: string, { bargeinHandler = cancelAtOnce }: { bargeinHandler?: IBargeinHandler } = {}) {
  const transport = new LiveKitStreamTransport({
    room,
    participantIdentity,
    sampleRate: 16_000,
    rtc: fakeRtc(),
    publisher: { ...speaking, rtc: fakePublishingRtc() },
  });
  const stt: StreamingSTTSession = Object.assign(new EventEmitter(), {
    pushAudio: () => undefined,
    flush: async () => undefined,
    close: () => undefined,
  });
  const tts: StreamingTTSSession = Object.assign(new EventEmitter(), {
    pushTokens: () => undefined,
    flush: async () => undefined,
    cancel: vi.fn(),
    close: () => undefined,
  });
  const endpointDetector: IEndpointDetector = Object.assign(new EventEmitter(), {
    mode: 'heuristic' as const,
    pushVadEvent: () => undefined,
    pushTranscript: () => undefined,
    reset: () => undefined,
  });
  const ttsConfigs: StreamingTTSConfig[] = [];
  const errors: Error[] = [];
  const orchestrator = new VoicePipelineOrchestrator({ stt: 'fake-stt', tts: 'fake-tts' });
  orchestrator.on('error', (error: Error) => errors.push(error));
  await orchestrator.startSession(
    transport,
    {
      sendText: async function* () {
        yield 'Hello';
      },
    },
    {
      streamingSTT: { providerId: 'fake-stt', isStreaming: true, startSession: async () => stt },
      streamingTTS: {
        providerId: 'fake-tts',
        startSession: async (config?: StreamingTTSConfig) => {
          ttsConfigs.push({ ...config });
          return tts;
        },
      },
      endpointDetector,
      bargeinHandler,
    }
  );
  const reply = async (): Promise<void> => {
    const turn: TurnCompleteEvent = { transcript: 'Hi', confidence: 0.9, durationMs: 500, reason: 'silence_timeout' };
    endpointDetector.emit('turn_complete', turn);
    await vi.waitFor(() => expect(orchestrator.state).toBe('speaking'));
  };
  return { transport, orchestrator, stt, tts, ttsConfigs, errors, reply };
}

describe('LiveKitStreamTransport speaking in the room', () => {
  beforeEach(() => {
    FakeAudioSource.created.length = 0;
  });

  it('speaks to a SIP caller on the track alone: every chunk of a reply is captured, and no text stream reaches the caller', async () => {
    const room = new FakeRoom();
    room.addSipCaller('sip_caller', new FakePublication(new FakeTrack('TR_CALLER')));
    const s = await converse(room, 'sip_caller');
    await s.reply();
    for (let i = 0; i < 3; i++) s.tts.emit('audio', pcmChunk());
    // Each 20 ms chunk at 24 kHz is 480 samples, 960 on the 48 kHz track.
    await vi.waitFor(() => expect(capturedSamples()).toBe(3 * 960));
    expect(s.transport.playout).toBe('native');
    expect(room.localParticipant.sendText).not.toHaveBeenCalled();
    expect(s.errors).toEqual([]);
    await s.orchestrator.stopSession('done');
    await s.transport.whenClosed();
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledOnce();
  });

  it('speaks to a plain LiveKit participant on the track the same way: no audio message, no receipt asked', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const s = await converse(room, 'user-1');
    await s.reply();
    for (let i = 0; i < 3; i++) s.tts.emit('audio', pcmChunk());
    await vi.waitFor(() => expect(capturedSamples()).toBe(3 * 960));
    // The page still gets the control messages it can show; nothing per chunk.
    expect(sentTypes(room)).toEqual(['session_started', 'agent_thinking', 'agent_speaking']);
    expect(s.errors).toEqual([]);
    await s.orchestrator.stopSession('done');
  });

  it('clears what the track holds at a barge-in, with no answer from the participant', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const s = await converse(room, 'user-1');
    await s.reply();
    s.tts.emit('audio', pcmChunk());
    s.tts.emit('audio', pcmChunk());
    await vi.waitFor(() => expect(capturedSamples()).toBe(2 * 960));
    s.stt.emit('speech_start');
    await vi.waitFor(() => expect(FakeAudioSource.created[0]?.clears).toBe(2));
    await vi.waitFor(() => expect(sentTypes(room)).toContain('barge_in'));
    expect(s.orchestrator.state).toBe('listening');
    expect(s.tts.cancel).toHaveBeenCalledOnce();
    // A chunk of the cut reply that arrives late is not played.
    s.tts.emit('audio', pcmChunk());
    await settle();
    expect(capturedSamples()).toBe(2 * 960);
    expect(s.errors).toEqual([]);
    await s.orchestrator.stopSession('done');
  });

  it('asks its TTS for PCM, and reports a chunk in another format once, naming the provider', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const s = await converse(room, 'user-1');
    expect(s.ttsConfigs).toEqual([expect.objectContaining({ format: 'pcm' })]);
    await s.reply();
    const mp3: EncodedAudioChunk = { audio: Buffer.from('ID3 not pcm'), format: 'mp3', sampleRate: 44_100, durationMs: 20, text: 'Hello' };
    s.tts.emit('audio', mp3);
    s.tts.emit('audio', mp3);
    await settle();
    expect(s.errors.map((error) => error.message)).toEqual([expect.stringMatching(/fake-tts.*mp3/)]);
    expect(capturedSamples()).toBe(0);
    await s.orchestrator.stopSession('done');
  });

  it("keeps the receipt protocol for a participant that declares it with the 'agentos.playout' attribute", async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1'))).attributes = { 'agentos.playout': 'participant' };
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'user-1',
      sampleRate: 16_000,
      rtc: fakeRtc(),
      publisher: { ...speaking, rtc: fakePublishingRtc() },
    });
    await transport.sendAudio(scopedChunk(1));
    expect(transport.playout).toBe('participant');
    expect(sentTypes(room)).toEqual(['audio']);
    let played = false;
    const playback = transport.waitForPlayback(firstGeneration, 1, new AbortController().signal).then((receipt) => {
      played = true;
      return receipt;
    });
    // The track's drain alone does not count: the participant's receipt does.
    FakeAudioSource.created[0]!.playOut();
    await settle();
    expect(played).toBe(false);
    const receipt = { type: 'playback', generation: firstGeneration, sequence: 1, playedSamples: 320, sampleRate: 16_000 };
    room.textHandlers.get('agentos.voice')!(textStream(JSON.stringify(receipt)), { identity: 'user-1' });
    expect(await playback).toMatchObject({ sequence: 1, playedSamples: 320, sampleRate: 16_000 });
    transport.close();
    await transport.whenClosed();
  });

  it("plays natively to a SIP caller even when the host asks for 'participant' playout", async () => {
    const room = new FakeRoom();
    room.addSipCaller('sip_caller', new FakePublication(new FakeTrack('TR_CALLER')));
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'sip_caller',
      sampleRate: 16_000,
      rtc: fakeRtc(),
      publisher: { ...receipts, ...speaking, rtc: fakePublishingRtc() },
    });
    await transport.sendAudio(scopedChunk(1));
    expect(transport.playout).toBe('native');
    const playback = transport.waitForPlayback(firstGeneration, 1, new AbortController().signal);
    FakeAudioSource.created[0]!.playOut();
    expect(await playback).toMatchObject({ sequence: 1, playedSamples: 320, sampleRate: 16_000 });
    expect(room.localParticipant.sendText).not.toHaveBeenCalled();
    transport.close();
    await transport.whenClosed();
  });

  it('hands a transcript message from the participant on as a message, and stays open', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'user-1',
      sampleRate: 16_000,
      rtc: fakeRtc(),
      publisher: { ...speaking, rtc: fakePublishingRtc() },
    });
    const messages: ClientTextMessage[] = [];
    const errors: Error[] = [];
    transport.on('message', (message: ClientTextMessage) => messages.push(message));
    transport.on('error', (error: Error) => errors.push(error));
    const line = { type: 'transcript', text: 'Hello there.', itemId: '7', isFinal: true, confidence: 0.8 };
    room.textHandlers.get('agentos.voice')!(textStream(JSON.stringify(line)), { identity: 'user-1' });
    await settle();
    expect(messages).toEqual([line]);
    expect(errors).toEqual([]);
    expect(transport.state).toBe('open');
    transport.close();
    await transport.whenClosed();
  });

  it('runs a call profile with a SIP caller: a prompt plays from the track, a barge-in clear needs no answer, and no text stream reaches the caller', async () => {
    const room = new FakeRoom();
    room.addSipCaller('sip_caller', new FakePublication(new FakeTrack('TR_CALLER')));
    const identity: AudioIdentity = { scopeId: 'scope-a', callId: 'call-a', turnId: 'turn-a', generation: { ...firstGeneration } };
    let generation: VoiceGeneration = { ...firstGeneration };
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'sip_caller',
      sampleRate: 16_000,
      rtc: fakeRtc(),
      publisher: { ...speaking, generation: () => generation, rtc: fakePublishingRtc() },
    });
    const stt: ScopedStreamingSTTSession = Object.assign(new EventEmitter(), {
      pushAudio() {},
      pushAudioScoped: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      flush: async () => {},
      close: vi.fn(),
    });
    // Every frame is speech, so six 20 ms frames reach the profile's 120 ms and interrupt the agent.
    const vad: IVadSession = Object.assign(new EventEmitter(), {
      pushAudio: async (frame: ScopedAudioFrame) => {
        vad.emit('vad', { ...frame, source: 'vad', type: 'speech_start', speech: true, durationMs: frame.samples.length / 16 });
      },
      reset: vi.fn(async () => {}),
      flush: async () => {},
      dispose: vi.fn(async () => {}),
    });
    const endpoint: IAudioEndpointDetector = Object.assign(new EventEmitter(), {
      mode: 'semantic' as const,
      pushAudio: vi.fn(async () => {}),
      pushVadEvent: vi.fn(async () => {}),
      pushTranscript: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    });
    const profile: CallPipelineProfile = {
      identity,
      vadSession: vad,
      audioEndpointDetector: endpoint,
      maxInputFrames: 32,
      maxInputSamples: 10240,
      playback: { maxBytes: 64000, maxDurationMs: 2000 },
      minSpeechMs: 120,
      maxTextCharacters: 4096,
      maxSynthesisRequests: 64,
      onGeneration: vi.fn(async () => {}),
      onInterrupted: vi.fn(),
      onFailure: vi.fn(),
      fenceInference: vi.fn(async () => {}),
    };
    // A pull-contract synthesis: each write hands one 20 ms chunk of 16 kHz PCM to the sink.
    const streamingTTS: IStreamingTTS = {
      providerId: 'fake-tts',
      startSession: async (config?: StreamingTTSConfig) => {
        const call = config!.call!;
        let sink: ((chunk: EncodedAudioChunk) => Promise<void>) | undefined;
        const usage = { ...call, providerId: 'fake-tts', acceptedCharacters: 5, generatedSamples: 320, sampleRate: 16000 };
        const session: StreamingTTSSession = Object.assign(new EventEmitter(), {
          pushTokens() {},
          setAudioSink(fn: (chunk: EncodedAudioChunk) => Promise<void>) {
            sink = fn;
          },
          async writeTokens() {
            session.emit('usage', { ...usage, status: 'running', final: false });
            await sink!({ scopeId: call.scopeId, callId: call.callId, generation: { ...call.generation }, audio: Buffer.alloc(640), format: 'pcm', container: 'raw', sampleRate: 16000, durationMs: 20, text: 'hello' });
          },
          async flush() {
            session.emit('usage', { ...usage, status: 'completed', final: true });
            session.emit('flush_complete');
          },
          cancel: vi.fn(),
          close: vi.fn(),
        });
        return session;
      },
    };
    const runtime = new VoicePipelineOrchestrator({ stt: 'fake-stt', tts: 'fake-tts' });
    runtime.on('generation', (next: VoiceGeneration) => {
      generation = next;
    });
    const agent: IVoicePipelineAgentSession = {
      sendText: async function* () {
        yield 'hello';
      },
      abort: vi.fn(),
    };
    await runtime.startSession(transport, agent, {
      streamingSTT: { providerId: 'fake-stt', isStreaming: true, startSession: async () => stt },
      streamingTTS,
      callProfile: profile,
    });
    const source = (): FakeAudioSource | undefined => FakeAudioSource.created[0];

    // The prompt's chunk reaches the track, and the prompt completes once the track has played it out.
    const prompt = runtime.pushToTTS('Thanks for calling.');
    await vi.waitFor(() => expect(source()?.capturedSamples).toBe(960));
    source()!.playOut();
    await prompt;
    expect(runtime.state).toBe('listening');

    // The caller talks over the next reply: the track is cleared with no answer from the caller.
    const cut = runtime.pushToTTS('Your balance is').then(
      () => 'played',
      () => 'cut'
    );
    await vi.waitFor(() => expect(source()?.capturedSamples).toBe(1920));
    await vi.waitFor(() => expect(FakeAudioStream.opened).toHaveLength(1));
    for (let i = 0; i < 6; i++) FakeAudioStream.opened[0]!.push(rtcFrame(new Array(320).fill(1000), 16_000, 1));
    expect(await cut).toBe('cut');
    await vi.waitFor(() => expect(runtime.state).toBe('listening'));
    expect(source()!.clears).toBe(2);
    expect(profile.onFailure).not.toHaveBeenCalled();
    expect(room.localParticipant.sendText).not.toHaveBeenCalled();
    await runtime.stopSession();
    await transport.whenClosed();
  });

  it('stays speaking until the track has played the reply out, and only then sends agent_done', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const s = await converse(room, 'user-1');
    await s.reply();
    for (let i = 0; i < 3; i++) s.tts.emit('audio', pcmChunk());
    await vi.waitFor(() => expect(capturedSamples()).toBe(3 * 960));
    s.tts.emit('flush_complete');
    await settle();
    // The synthesis is complete, and the track still holds the reply.
    expect(s.orchestrator.state).toBe('speaking');
    expect(sentTypes(room)).toEqual(['session_started', 'agent_thinking', 'agent_speaking']);
    FakeAudioSource.created[0]!.playOut();
    await vi.waitFor(() => expect(s.orchestrator.state).toBe('listening'));
    expect(sentTypes(room)).toEqual(['session_started', 'agent_thinking', 'agent_speaking', 'agent_done']);
    expect(s.errors).toEqual([]);
    await s.orchestrator.stopSession('done');
  });

  it('takes speech over the rest of the reply, after its synthesis completed, as a barge-in that clears the track', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const bargeinHandler: IBargeinHandler = { mode: 'hard-cut', handleBargein: vi.fn(() => ({ type: 'cancel' as const })) };
    const s = await converse(room, 'user-1', { bargeinHandler });
    await s.reply();
    for (let i = 0; i < 3; i++) s.tts.emit('audio', pcmChunk());
    await vi.waitFor(() => expect(capturedSamples()).toBe(3 * 960));
    s.tts.emit('flush_complete');
    await settle();
    // The participant says "stop" while the track still plays the reply.
    s.stt.emit('speech_start');
    await vi.waitFor(() => expect(bargeinHandler.handleBargein).toHaveBeenCalled());
    await vi.waitFor(() => expect(s.orchestrator.state).toBe('listening'));
    expect(FakeAudioSource.created[0]!.clears).toBeGreaterThan(0);
    expect(s.tts.cancel).toHaveBeenCalledOnce();
    // The track's playout, which the clear ended, does not report the cut reply as done.
    await settle();
    expect(sentTypes(room)).toEqual(['session_started', 'agent_thinking', 'agent_speaking', 'barge_in']);
    expect(s.errors).toEqual([]);
    await s.orchestrator.stopSession('done');
  });

  it('holds the track on a pause: nothing more is captured until the reply resumes, and the rest then plays in order', async () => {
    const room = new FakeRoom();
    const { s, source } = await pausedReply(room);
    // The queue was cleared at the pause, and only the chunk whose capture was under way then reached the track.
    expect(capturedTones()).toEqual([1, 2]);
    expect(source.clears).toBeGreaterThan(0);
    // The speech ends with no words: a false interruption, and the reply resumes.
    s.stt.emit('transcript', { text: '', confidence: 0, words: [], isFinal: true });
    s.stt.emit('speech_end');
    await vi.waitFor(() => expect(capturedTones()).toEqual([1, 2, 3, 4, 5]));
    expect(sentTypes(room).filter((type) => type === 'barge_in')).toHaveLength(2);
    expect(s.orchestrator.state).toBe('speaking');
    expect(s.errors).toEqual([]);
    await s.orchestrator.stopSession('done');
  });

  it('discards what a pause held when the speech cuts the reply, and captures nothing more of it', async () => {
    const room = new FakeRoom();
    const { s } = await pausedReply(room);
    // The participant's words cut the reply.
    s.stt.emit('transcript', { text: 'Stop there.', confidence: 0.9, words: [], isFinal: true });
    s.stt.emit('speech_end');
    await vi.waitFor(() => expect(s.orchestrator.state).toBe('listening'));
    await settle();
    expect(capturedTones()).toEqual([1, 2]);
    expect(s.tts.cancel).toHaveBeenCalledOnce();
    expect(sentTypes(room).filter((type) => type === 'barge_in')).toHaveLength(2);
    expect(s.errors).toEqual([]);
    await s.orchestrator.stopSession('done');
  });

  it('publishes the track as a session starts, and plays its first reply once the participant has subscribed', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    let subscribe!: () => void;
    room.subscription = new Promise<void>((resolve) => {
      subscribe = resolve;
    });
    const s = await converse(room, 'user-1');
    // Published before the first reply, so the participant can subscribe while it speaks its first turn.
    await vi.waitFor(() => expect(room.localParticipant.publishTrack).toHaveBeenCalledOnce());
    await s.reply();
    s.tts.emit('audio', pcmChunk());
    await settle();
    expect(capturedSamples()).toBe(0);
    subscribe();
    await vi.waitFor(() => expect(capturedSamples()).toBe(960));
    expect(room.localParticipant.publishTrack).toHaveBeenCalledOnce();
    expect(s.errors).toEqual([]);
    await s.orchestrator.stopSession('done');
  });

  it("plays natively to a phone caller who joins after readyForPlayback(), though the host asks for 'participant' playout", async () => {
    const room = new FakeRoom();
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'sip_caller',
      sampleRate: 16_000,
      rtc: fakeRtc(),
      publisher: { ...receipts, ...speaking, rtc: fakePublishingRtc() },
    });
    // An outbound call gets the track ready before the callee answers.
    await transport.readyForPlayback();
    room.addSipCaller('sip_caller', new FakePublication(new FakeTrack('TR_CALLER')));
    await transport.sendAudio(scopedChunk(1));
    expect(transport.playout).toBe('native');
    const playback = transport.waitForPlayback(firstGeneration, 1, new AbortController().signal);
    FakeAudioSource.created[0]!.playOut();
    expect(await playback).toMatchObject({ sequence: 1, playedSamples: 320, sampleRate: 16_000 });
    expect(room.localParticipant.sendText).not.toHaveBeenCalled();
    transport.close();
    await transport.whenClosed();
  });

  it('holds the track for a phone caller on a barge-in pause, sending the caller nothing, and releases it on resume', async () => {
    const room = new FakeRoom();
    room.addSipCaller('sip_caller', new FakePublication(new FakeTrack('TR_CALLER')));
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'sip_caller',
      sampleRate: 16_000,
      rtc: fakeRtc(),
      publisher: { ...speaking, rtc: fakePublishingRtc() },
    });
    await transport.sendAudio(toneChunk(1));
    await transport.sendControl({ type: 'barge_in', action: { type: 'pause', fadeMs: 200 } });
    expect(FakeAudioSource.created[0]!.clears).toBe(1);
    const held = transport.sendAudio(toneChunk(2));
    await settle();
    expect(capturedTones()).toEqual([1]);
    await transport.sendControl({ type: 'barge_in', action: { type: 'resume' } });
    await held;
    expect(capturedTones()).toEqual([1, 2]);
    expect(room.localParticipant.sendText).not.toHaveBeenCalled();
    transport.close();
    await transport.whenClosed();
  });

  it('plays a chunk sent before the participant joins natively, and fixes the mode once the participant is in the room', async () => {
    const room = new FakeRoom();
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'user-1',
      sampleRate: 16_000,
      rtc: fakeRtc(),
      publisher: { ...receipts, ...speaking, rtc: fakePublishingRtc() },
    });
    // Nobody is there to announce the chunk to: it plays on the track, and the mode waits.
    await transport.sendAudio(scopedChunk(1));
    expect(transport.playout).toBeUndefined();
    const playback = transport.waitForPlayback(firstGeneration, 1, new AbortController().signal);
    FakeAudioSource.created[0]!.playOut();
    expect(await playback).toMatchObject({ sequence: 1, playedSamples: 320, sampleRate: 16_000 });
    expect(room.localParticipant.sendText).not.toHaveBeenCalled();
    // The page joins: the host's participant playout holds from its first chunk.
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    await transport.sendAudio(scopedChunk(2));
    expect(transport.playout).toBe('participant');
    expect(sentTypes(room)).toEqual(['audio']);
    transport.close();
    await transport.whenClosed();
  });

  it('holds the floor until the room source has played the reply, and adds the reply to the conversation then', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const s = await converse(room, 'user-1');
    const log = recordSessionEvents(s.orchestrator);
    await s.reply();
    for (let i = 0; i < 3; i++) s.tts.emit('audio', pcmChunk());
    await vi.waitFor(() => expect(capturedSamples()).toBe(3 * 960));
    s.tts.emit('flush_complete');
    await settle();

    // Synthesis is complete, and the track still holds the reply: the agent still speaks.
    expect(s.orchestrator.state).toBe('speaking');
    expect(log).toEqual(['item user speech Hi', 'agent listening>thinking', 'speech reply false', 'agent thinking>speaking']);
    FakeAudioSource.created[0]!.playOut();
    await vi.waitFor(() => expect(s.orchestrator.state).toBe('listening'));
    expect(log.slice(4)).toEqual(['item assistant played Hello|Hello', 'agent speaking>listening']);
    expect(s.errors).toEqual([]);
    await s.orchestrator.stopSession('done');
  });

  it("ends a playout wait at once when its signal is aborted, though the track still holds the reply", async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const s = await converse(room, 'user-1');
    await s.reply();
    s.tts.emit('audio', pcmChunk());
    await vi.waitFor(() => expect(capturedSamples()).toBe(960));

    const controller = new AbortController();
    const wait = s.transport.waitForPlayout(controller.signal).then(
      () => 'played',
      (error: Error) => error.message
    );
    await settle();
    controller.abort();
    expect(await wait).toBe('publisher playout wait aborted');

    // The session's own wait ends with the session, and no agent_done follows.
    s.tts.emit('flush_complete');
    await settle();
    expect(s.orchestrator.state).toBe('speaking');
    await s.orchestrator.stopSession('done');
    await settle();
    expect(sentTypes(room)).not.toContain('agent_done');
    expect(s.errors).toEqual([]);
  });
});

/**
 * A reply to a plain participant, paused by SoftFadeBargeinHandler while the track's native queue is full: the track
 * captured the first chunk, the second waited for room in the queue as the pause came, the third and fourth follow it,
 * and the fifth arrived during the pause, which the session holds. The queue then has room again.
 */
async function pausedReply(room: FakeRoom) {
  room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
  const s = await converse(room, 'user-1', { bargeinHandler: new SoftFadeBargeinHandler() });
  await s.reply();
  s.tts.emit('audio', toneChunk(1));
  await vi.waitFor(() => expect(capturedTones()).toEqual([1]));
  const source = FakeAudioSource.created[0]!;
  let free!: () => void;
  source.gate = new Promise<void>((resolve) => {
    free = resolve;
  });
  for (const value of [2, 3, 4]) s.tts.emit('audio', toneChunk(value));
  await settle();
  // The participant speaks over the reply, and SoftFadeBargeinHandler pauses it at 100 ms of speech.
  s.stt.emit('speech_start');
  await vi.waitFor(() => expect(sentTypes(room)).toContain('barge_in'));
  s.tts.emit('audio', toneChunk(5));
  source.gate = undefined;
  free();
  await settle();
  return { s, source };
}
