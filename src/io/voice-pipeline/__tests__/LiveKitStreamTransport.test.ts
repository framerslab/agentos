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
import { LiveKitStreamTransport, type LiveKitStreamTransportOptions } from '../LiveKitStreamTransport.js';
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
  PARTICIPANT_KIND_AGENT,
  PARTICIPANT_KIND_EGRESS,
  PARTICIPANT_KIND_STANDARD,
  capturedSamples,
  fakePublishingRtc,
  fakeRtc,
  rtcFrame,
  settle,
  textReader,
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

  it('sends each message without waiting for one the room has not finished sending', async () => {
    const room = new FakeRoom();
    const { transport } = open(room);
    // The room never finishes sending the first message.
    room.localParticipant.sendText.mockImplementationOnce(() => new Promise<{}>(() => {}));
    void transport.sendControl({ type: 'agent_thinking' });
    const done = transport.sendControl({ type: 'agent_done', text: 'Hello', durationMs: 20 });
    await settle();
    expect(sentTypes(room)).toEqual(['agent_thinking', 'agent_done']);
    await done;
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
 * unless `bargeinHandler` is given. With `conventions`, the transport links the participant with `participant`, so it
 * follows LiveKit Agents' session conventions.
 */
async function converse(
  room: FakeRoom,
  participantIdentity: string,
  { bargeinHandler = cancelAtOnce, conventions = false }: { bargeinHandler?: IBargeinHandler; conventions?: boolean } = {}
) {
  const transport = new LiveKitStreamTransport({
    room,
    ...(conventions ? { participant: participantIdentity } : { participantIdentity }),
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

  it('ends a reply whose track never reports its playout once receiptTimeoutMs plus maxDurationMs pass, and takes the next words as a new turn', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const bargeinHandler: IBargeinHandler = { mode: 'hard-cut', handleBargein: vi.fn(() => ({ type: 'cancel' as const })) };
    const s = await converse(room, 'user-1', { bargeinHandler });
    await s.reply();
    for (let i = 0; i < 3; i++) s.tts.emit('audio', pcmChunk());
    await vi.waitFor(() => expect(capturedSamples()).toBe(3 * 960));
    const source = FakeAudioSource.created[0]!;
    // The track has taken the reply and never reports that it played out.
    source.waitForPlayout = () => new Promise<void>(() => {});
    const clears = source.clears;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      s.tts.emit('flush_complete');
      await settle();
      // receiptTimeoutMs is 1000 and maxDurationMs 2000: a millisecond before the bound the reply is still speaking.
      await vi.advanceTimersByTimeAsync(2_999);
      await settle();
      expect(s.orchestrator.state).toBe('speaking');
      expect(sentTypes(room)).toEqual(['session_started', 'agent_thinking', 'agent_speaking']);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(s.orchestrator.state).toBe('listening');
      expect(sentTypes(room)).toEqual(['session_started', 'agent_thinking', 'agent_speaking', 'agent_done']);
      // What the track had not played is cleared, so none of the stalled reply plays later.
      expect(source.clears).toBe(clears + 1);
    } finally {
      vi.useRealTimers();
    }
    // The caller's next words are a new turn, not a barge-in.
    s.stt.emit('speech_start');
    await settle();
    expect(bargeinHandler.handleBargein).not.toHaveBeenCalled();
    expect(s.tts.cancel).not.toHaveBeenCalled();
    await s.reply();
    await vi.waitFor(() =>
      expect(sentTypes(room)).toEqual(['session_started', 'agent_thinking', 'agent_speaking', 'agent_done', 'agent_thinking', 'agent_speaking'])
    );
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

  it('waits for the track for a chunk sent before the participant joined, once the join has fixed participant playout', async () => {
    const room = new FakeRoom();
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'user-1',
      sampleRate: 16_000,
      rtc: fakeRtc(),
      publisher: { ...receipts, ...speaking, rtc: fakePublishingRtc() },
    });
    // Nobody is in the room: the first chunk plays natively.
    await transport.sendAudio(scopedChunk(1));
    // The page joins, and its first chunk fixes participant playout.
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    await transport.sendAudio(scopedChunk(2));
    expect(transport.playout).toBe('participant');
    // The first chunk keeps the playout it was admitted under: its wait is for the track, and no receipt is asked for it.
    let outcome: unknown;
    void transport.waitForPlayback(firstGeneration, 1, new AbortController().signal).then(
      (receipt) => {
        outcome = receipt;
      },
      (error: Error) => {
        outcome = error.message;
      }
    );
    await settle();
    expect(outcome).toBeUndefined();
    FakeAudioSource.created[0]!.playOut();
    await settle();
    expect(outcome).toEqual({ generation: firstGeneration, sequence: 1, playedSamples: 320, sampleRate: 16_000 });
    expect(sentTypes(room)).toEqual(['audio']);
    transport.close();
    await transport.whenClosed();
  });

  it('clears a chunk sent before the participant joined as native playout clears it, once the join has fixed participant playout', async () => {
    const room = new FakeRoom();
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'user-1',
      sampleRate: 16_000,
      rtc: fakeRtc(),
      publisher: { ...receipts, ...speaking, rtc: fakePublishingRtc() },
    });
    // Published while nobody is in the room, so the mode waits.
    await transport.readyForPlayback();
    const source = FakeAudioSource.created[0]!;
    // What reaches the track and what clears it, in order.
    const events: string[] = [];
    const capture = source.captureFrame.bind(source);
    source.captureFrame = async (frame) => {
      await capture(frame);
      events.push('captured');
    };
    const clearQueue = source.clearQueue.bind(source);
    source.clearQueue = () => {
      events.push('cleared');
      clearQueue();
    };
    let land!: () => void;
    source.gate = new Promise<void>((resolve) => {
      land = resolve;
    });
    // The first chunk plays natively, and its capture waits for room in the queue.
    const first = transport.sendAudio(scopedChunk(1));
    await settle();
    source.gate = undefined;
    // The page joins, and its first chunk fixes participant playout.
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    await transport.sendAudio(scopedChunk(2));
    expect(transport.playout).toBe('participant');
    const clearing = transport.clearPlayback(firstGeneration);
    land();
    await first;
    // The page is asked to discard the generation, and answers.
    await vi.waitFor(() => expect(sentTypes(room)).toContain('clear'));
    const ask = room.localParticipant.sendText.mock.calls
      .map(([text]) => JSON.parse(text) as { type: string; generation: VoiceGeneration; clearId: number })
      .find((message) => message.type === 'clear')!;
    room.textHandlers.get('agentos.voice')!(
      textStream(JSON.stringify({ type: 'cleared', generation: ask.generation, clearId: ask.clearId })),
      { identity: 'user-1' }
    );
    await clearing;
    // The first chunk's frame landed after the clear began, and the queue was cleared again after it.
    expect(events.slice(events.lastIndexOf('captured'))).toContain('cleared');
    transport.close();
    await transport.whenClosed();
  });

  it('sends barge-in controls to the participant in the order they were asked, though a cancel waits for its clear', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'user-1',
      sampleRate: 16_000,
      rtc: fakeRtc(),
      publisher: { ...speaking, rtc: fakePublishingRtc() },
    });
    await transport.readyForPlayback();
    const source = FakeAudioSource.created[0]!;
    let land!: () => void;
    source.gate = new Promise<void>((resolve) => {
      land = resolve;
    });
    // A reply's chunk waits for room in the track's queue.
    const sent = transport.sendAudio(toneChunk(1));
    await settle();
    // The reply is cut: the cancel clears the track at once, and its clear waits for the capture in flight.
    const cancel = transport.sendControl({ type: 'barge_in', action: { type: 'cancel' } });
    expect(source.clears).toBe(1);
    // The next reply is paused and resumed meanwhile: each acts on the track at once.
    const pause = transport.sendControl({ type: 'barge_in', action: { type: 'pause', fadeMs: 200 } });
    expect(source.clears).toBe(2);
    const resume = transport.sendControl({ type: 'barge_in', action: { type: 'resume' } });
    await settle();
    // Nothing reaches the participant before the cancel: the pause and the resume wait for it.
    expect(sentTypes(room)).toEqual([]);
    source.gate = undefined;
    land();
    await Promise.all([sent, cancel, pause, resume]);
    const actions = room.localParticipant.sendText.mock.calls.map(([text]) => (JSON.parse(text) as { action?: { type: string } }).action?.type);
    expect(actions).toEqual(['cancel', 'pause', 'resume']);
    transport.close();
    await transport.whenClosed();
  });

  it('sends a cancel whose clear waits on a capture that never returns, and the messages behind it, before the stalled track closes the transport', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'user-1',
      sampleRate: 16_000,
      rtc: fakeRtc(),
      publisher: { ...speaking, rtc: fakePublishingRtc() },
    });
    await transport.readyForPlayback();
    // The track never takes the chunk: its capture never returns, so the cancel's clear waits for it.
    FakeAudioSource.created[0]!.gate = new Promise<void>(() => {});
    // The capture's own bound starts before the cancel's, so it is the first to pass.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      void transport.sendAudio(toneChunk(1));
      await settle();
      void transport.sendControl({ type: 'barge_in', action: { type: 'cancel' } });
      void transport.sendControl({ type: 'agent_thinking' });
      await settle();
      expect(sentTypes(room)).toEqual([]);
      // receiptTimeoutMs is 1000 and maxDurationMs 2000.
      await vi.advanceTimersByTimeAsync(2_999);
      await settle();
      expect(sentTypes(room)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      // The capture is given up and the track retired: the messages already waiting go out, then the transport closes.
      expect(sentTypes(room)).toEqual(['barge_in', 'agent_thinking']);
      expect(transport.state).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
    await transport.whenClosed();
  });

  it('refuses a fifth message in flight with livekit control bound', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'user-1',
      sampleRate: 16_000,
      rtc: fakeRtc(),
      publisher: { ...speaking, rtc: fakePublishingRtc() },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // The room takes each message and finishes none.
      room.localParticipant.sendText.mockImplementation(() => new Promise<{}>(() => {}));
      for (let i = 0; i < 4; i++) void transport.sendControl({ type: 'agent_thinking' });
      let outcome: string | undefined;
      void transport.sendControl({ type: 'agent_thinking' }).then(
        () => {
          outcome = 'sent';
        },
        (error: Error) => {
          outcome = error.message;
        }
      );
      await settle();
      expect(outcome).toBe('livekit control bound');
      expect(room.localParticipant.sendText).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
    transport.close();
  });

  it('refuses a message with livekit control bound once sixty-four wait, a cancel among them, and a refused pause leaves the track as it is', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'user-1',
      sampleRate: 16_000,
      rtc: fakeRtc(),
      publisher: { ...speaking, rtc: fakePublishingRtc() },
    });
    await transport.readyForPlayback();
    // The cancel's clear waits for a capture that never returns.
    FakeAudioSource.created[0]!.gate = new Promise<void>(() => {});
    void transport.sendAudio(toneChunk(1));
    await settle();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      void transport.sendControl({ type: 'barge_in', action: { type: 'cancel' } });
      for (let i = 0; i < 63; i++) void transport.sendControl({ type: 'agent_thinking' });
      let outcome: string | undefined;
      void transport.sendControl({ type: 'agent_thinking' }).then(
        () => {
          outcome = 'sent';
        },
        (error: Error) => {
          outcome = error.message;
        }
      );
      await settle();
      expect(outcome).toBe('livekit control bound');
      // A pause refused the same way neither clears the track nor holds it.
      const clears = FakeAudioSource.created[0]!.clears;
      await expect(transport.sendControl({ type: 'barge_in', action: { type: 'pause', fadeMs: 200 } })).rejects.toThrow(
        'livekit control bound'
      );
      expect(FakeAudioSource.created[0]!.clears).toBe(clears);
      expect(sentTypes(room)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
    transport.close();
  });

  it('closes the transport when a capture does not return within receiptTimeoutMs plus maxDurationMs, and finishes closing without it', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'user-1',
      sampleRate: 16_000,
      rtc: fakeRtc(),
      publisher: { ...speaking, rtc: fakePublishingRtc() },
    });
    const errors: string[] = [];
    transport.on('error', (error: Error) => errors.push(error.message));
    await transport.readyForPlayback();
    const source = FakeAudioSource.created[0]!;
    // The track never takes the chunk: its capture never returns.
    source.gate = new Promise<void>(() => {});
    let outcome: string | undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      void transport.sendAudio(toneChunk(1));
      await settle();
      void transport.waitForPlayout().then(
        () => {
          outcome = 'played';
        },
        (error: Error) => {
          outcome = error.message;
        }
      );
      await settle();
      // receiptTimeoutMs is 1000 and maxDurationMs 2000.
      await vi.advanceTimersByTimeAsync(3_000);
      await settle();
      expect(outcome).toBe('publisher drain timeout');
      expect(errors).toEqual(['livekit output stalled']);
      expect(transport.state).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
    // Closing does not wait for the capture that never returns: the track is unpublished and its source closed.
    await transport.whenClosed();
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledOnce();
    expect(source.closed).toBe(true);
  });

  it('gives up a capture that never returns after receiptTimeoutMs plus maxDurationMs though only a playback wait waits for it, and the clear and the close then finish', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'user-1',
      sampleRate: 16_000,
      rtc: fakeRtc(),
      publisher: { ...speaking, rtc: fakePublishingRtc() },
    });
    const errors: string[] = [];
    transport.on('error', (error: Error) => errors.push(error.message));
    await transport.readyForPlayback();
    // The track never takes the chunk: its capture never returns.
    FakeAudioSource.created[0]!.gate = new Promise<void>(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let sent: string | undefined;
      let played: string | undefined;
      void transport.sendAudio(scopedChunk(1)).then(
        () => {
          sent = 'sent';
        },
        (error: Error) => {
          sent = error.message;
        }
      );
      void transport.waitForPlayback(firstGeneration, 1, new AbortController().signal).then(
        () => {
          played = 'played';
        },
        (error: Error) => {
          played = error.message;
        }
      );
      await settle();
      // The playback wait gives up at receiptTimeoutMs, 1000; the capture is given up at that plus maxDurationMs, 2000.
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
      expect(played).toBe('publisher drain timeout');
      expect(transport.state).toBe('open');
      await vi.advanceTimersByTimeAsync(2_000);
      await settle();
      expect(sent).toBe('publisher capture stalled');
      expect(errors).toEqual(['livekit output stalled']);
      expect(transport.state).toBe('closed');
      let cleared = false;
      void transport.clearPlayback(firstGeneration).then(() => {
        cleared = true;
      });
      await settle();
      expect(cleared).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    await transport.whenClosed();
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledOnce();
  });

  it('keeps the transport open when a playout wait gives up on an audio announcement that never went out, no capture having begun', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const transport = new LiveKitStreamTransport({
      room,
      participantIdentity: 'user-1',
      sampleRate: 16_000,
      rtc: fakeRtc(),
      publisher: { ...receipts, ...speaking, rtc: fakePublishingRtc() },
    });
    const errors: string[] = [];
    transport.on('error', (error: Error) => errors.push(error.message));
    await transport.readyForPlayback();
    expect(transport.playout).toBe('participant');
    // The room never finishes sending the chunk's audio announcement, so its capture never begins.
    room.localParticipant.sendText.mockImplementation(() => new Promise<{}>(() => {}));
    let outcome: string | undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      void transport.sendAudio(scopedChunk(1));
      void transport.waitForPlayout().then(
        () => {
          outcome = 'played';
        },
        (error: Error) => {
          outcome = error.message;
        }
      );
      await settle();
      // receiptTimeoutMs plus maxDurationMs, 3000, is below the five seconds a control message gets.
      await vi.advanceTimersByTimeAsync(3_000);
      await settle();
      expect(outcome).toBe('publisher drain timeout');
      expect(errors).toEqual([]);
      expect(transport.state).toBe('open');
      expect(FakeAudioSource.created[0]!.captured).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
    transport.close();
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

/** A transport on `room` with the options given, at 16 kHz on the fake rtc-node module, and what it emits. */
function conventions(room: FakeRoom, options: Omit<LiveKitStreamTransportOptions, 'room' | 'sampleRate'>) {
  const transport = new LiveKitStreamTransport({ room, sampleRate: 16_000, rtc: fakeRtc(), ...options });
  const audio: AudioFrame[] = [];
  const messages: ClientTextMessage[] = [];
  const errors: string[] = [];
  let closes = 0;
  transport.on('audio', (frame: AudioFrame) => audio.push(frame));
  transport.on('message', (message: ClientTextMessage) => messages.push(message));
  transport.on('error', (error: Error) => errors.push(error.message));
  transport.on('close', () => {
    closes += 1;
  });
  return { transport, audio, messages, errors, closes: () => closes };
}

/** A speaking transport linked with `participant`, on the fake publishing module, and the errors it emits. */
function speakingTo(room: FakeRoom, participant: string, options: Partial<Omit<LiveKitStreamTransportOptions, 'room' | 'sampleRate'>> = {}) {
  return conventions(room, { participant, publisher: { ...speaking, rtc: fakePublishingRtc() }, ...options });
}

/** The transcription streams the agent sent: each one's text, line id, finality and transcribed track. */
function lines(room: FakeRoom): Array<[string, string | undefined, string | undefined, string | undefined]> {
  return room.sentOn('lk.transcription').map(({ text, attributes }) => [
    text,
    attributes?.['lk.segment_id'],
    attributes?.['lk.transcription_final'],
    attributes?.['lk.transcribed_track_id'],
  ]);
}

/** The types of the control messages the agent sent on its topic, in order. */
function controlTypes(room: FakeRoom): string[] {
  return room.sentOn('agentos.voice').map(({ text }) => (JSON.parse(text) as { type: string }).type);
}

/**
 * A 20 ms `toneChunk()` that ends a sentence segment of the reply, as a streaming TTS adapter attaches the segment's
 * boundary to the segment's last frame; its legacy `text` stays `'Hello'`, which the transport never reads.
 */
function spoken(value: number, segmentId: string, start: number, text: string): EncodedAudioChunk {
  return { ...toneChunk(value), textBoundary: { segmentId, start, end: start + text.length, text, final: true } };
}

/** The stream the fake rtc-node module opened on the track with the SID. */
function streamOn(sid: string): FakeAudioStream | undefined {
  return FakeAudioStream.opened.find((stream) => stream.track.sid === sid);
}

describe("LiveKitStreamTransport follows LiveKit Agents' session conventions", () => {
  beforeEach(() => {
    FakeAudioSource.created.length = 0;
  });

  it("'first' links the first STANDARD or SIP participant already in the room", async () => {
    const room = new FakeRoom();
    room.addParticipant('avatar', new FakePublication(new FakeTrack('TR_AVATAR'))).kind = PARTICIPANT_KIND_AGENT;
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    room.addSipCaller('caller', new FakePublication(new FakeTrack('TR_CALLER')));
    const page = conventions(room, { participant: 'first' });
    expect(page.transport.participantIdentity).toBe('user-1');
    await settle();
    expect(FakeAudioStream.opened.map((stream) => stream.track.sid)).toEqual(['TR_1']);
    await page.transport.sendControl({ type: 'agent_thinking' });
    expect(room.sentOn('agentos.voice').map((stream) => stream.destinationIdentities)).toEqual([['user-1']]);
    // A participant is linked, so nothing waits for one to join.
    expect(room.listenerCount('participantConnected')).toBe(0);
    page.transport.close();

    // A phone caller ahead of a page is the one linked; a recorder is passed over.
    const calls = new FakeRoom();
    calls.addParticipant('recorder').kind = PARTICIPANT_KIND_EGRESS;
    calls.addSipCaller('caller', new FakePublication(new FakeTrack('TR_CALLER')));
    calls.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const call = conventions(calls, { participant: 'first' });
    expect(call.transport.participantIdentity).toBe('caller');
    await settle();
    expect(streamOn('TR_CALLER')).toBeDefined();
    call.transport.close();

    // participantKinds names the kinds 'first' links.
    const agents = new FakeRoom();
    agents.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    agents.addParticipant('avatar', new FakePublication(new FakeTrack('TR_AVATAR'))).kind = PARTICIPANT_KIND_AGENT;
    const relay = conventions(agents, { participant: 'first', participantKinds: [PARTICIPANT_KIND_AGENT] });
    expect(relay.transport.participantIdentity).toBe('avatar');
    relay.transport.close();
    expect([page.errors, call.errors, relay.errors]).toEqual([[], [], []]);
  });

  it("'first' waits for one to join and passes over an AGENT and an EGRESS participant", async () => {
    const room = new FakeRoom();
    const { transport, messages } = conventions(room, { participant: 'first' });
    expect(transport.participantIdentity).toBeUndefined();
    await settle();
    // Nobody is linked: a control message has nobody to go to, and a chat stream is closed unread.
    await transport.sendControl({ type: 'agent_thinking' });
    expect(room.localParticipant.sendText).not.toHaveBeenCalled();
    const early = room.chat('someone', 'Hello?');
    expect(early.close).toHaveBeenCalledOnce();
    expect(early[Symbol.asyncIterator]).not.toHaveBeenCalled();
    room.join('avatar', PARTICIPANT_KIND_AGENT, new FakePublication(new FakeTrack('TR_AVATAR')));
    room.join('recorder', PARTICIPANT_KIND_EGRESS);
    await settle();
    expect(transport.participantIdentity).toBeUndefined();
    expect(FakeAudioStream.opened).toEqual([]);
    room.join('user-1', PARTICIPANT_KIND_STANDARD, new FakePublication(new FakeTrack('TR_1')));
    expect(transport.participantIdentity).toBe('user-1');
    await settle();
    expect(FakeAudioStream.opened.map((stream) => stream.track.sid)).toEqual(['TR_1']);
    // The wait has ended: a later joiner changes nothing.
    expect(room.listenerCount('participantConnected')).toBe(0);
    room.join('user-2', PARTICIPANT_KIND_STANDARD, new FakePublication(new FakeTrack('TR_2')));
    expect(transport.participantIdentity).toBe('user-1');
    await transport.sendControl({ type: 'agent_thinking' });
    expect(room.sentOn('agentos.voice').map((stream) => stream.destinationIdentities)).toEqual([['user-1']]);
    expect(messages).toEqual([]);
    transport.close();
  });

  it('setParticipant() moves audio, text input and transcript attribution to the new identity', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    room.addParticipant('user-2', new FakePublication(new FakeTrack('TR_2')));
    const { transport, audio, messages } = conventions(room, { participant: 'user-1' });
    await settle();
    streamOn('TR_1')!.push(rtcFrame([16384], 16_000));
    await settle();
    transport.setParticipant('user-2');
    expect(transport.participantIdentity).toBe('user-2');
    await settle();
    // The first participant's stream is cancelled, and the second participant's microphone is read.
    expect(FakeAudioStream.opened.map((stream) => [stream.track.sid, stream.cancelled])).toEqual([
      ['TR_1', true],
      ['TR_2', false],
    ]);
    streamOn('TR_2')!.push(rtcFrame([-16384], 16_000));
    await settle();
    expect(audio.map((frame) => [frame.speakerHint, Array.from(frame.samples)])).toEqual([
      ['user-1', [0.5]],
      ['user-2', [-0.5]],
    ]);
    // Text input and the control topic read the new participant alone.
    const ignored = room.chat('user-1', 'Hello?');
    room.chat('user-2', 'Is anyone there?');
    await settle();
    const control = room.textHandlers.get('agentos.voice')!;
    control(textReader(JSON.stringify({ type: 'control', action: { type: 'mute' } })), { identity: 'user-1' });
    control(textReader(JSON.stringify({ type: 'control', action: { type: 'unmute' } })), { identity: 'user-2' });
    await settle();
    expect(messages).toEqual([
      { type: 'text_input', text: 'Is anyone there?' },
      { type: 'control', action: { type: 'unmute' } },
    ]);
    expect(ignored[Symbol.asyncIterator]).not.toHaveBeenCalled();
    expect(ignored.close).toHaveBeenCalledOnce();
    // A transcript carries the new participant's microphone, and control messages go to the new participant.
    await transport.sendControl({ type: 'transcript', text: 'Is anyone there?', isFinal: true, confidence: 0.9 });
    await settle();
    expect(lines(room).map(([, , , track]) => track)).toEqual(['TR_2']);
    expect(room.sentOn('agentos.voice').map((stream) => stream.destinationIdentities)).toEqual([['user-2']]);
    transport.close();
  });

  it("with participant, the linked participant's departure closes a listen-only transport", async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    room.addParticipant('user-2');
    const { transport, closes, errors } = conventions(room, { participant: 'user-1' });
    await settle();
    room.leave('user-2');
    expect(transport.state).toBe('open');
    room.leave('user-1');
    expect(transport.state).toBe('closed');
    expect(closes()).toBe(1);
    // The room is left as the transport found it: its topics free and nothing listening for departures.
    expect(room.textHandlers.size).toBe(0);
    expect(room.listenerCount('participantDisconnected')).toBe(0);
    await transport.whenClosed();
    expect(errors).toEqual([]);
  });

  it('closeOnDisconnect: false keeps it open', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const { transport, audio } = conventions(room, { participant: 'user-1', closeOnDisconnect: false });
    await settle();
    room.leave('user-1');
    await settle();
    expect(transport.state).toBe('open');
    // The same participant rejoins on a new track, and the transport hears them again.
    room.join('user-1', PARTICIPANT_KIND_STANDARD, new FakePublication(new FakeTrack('TR_1B')));
    await settle();
    streamOn('TR_1B')!.push(rtcFrame([16384], 16_000));
    await settle();
    expect(audio.map((frame) => [frame.speakerHint, Array.from(frame.samples)])).toEqual([['user-1', [0.5]]]);
    transport.close();

    // An explicit value wins over a speaking transport's default as well.
    const speakingRoom = new FakeRoom();
    speakingRoom.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const speaker = conventions(speakingRoom, {
      participantIdentity: 'user-1',
      closeOnDisconnect: false,
      publisher: { ...speaking, rtc: fakePublishingRtc() },
    });
    speakingRoom.leave('user-1');
    expect(speaker.transport.state).toBe('open');
    speaker.transport.close();
    await speaker.transport.whenClosed();
  });

  it("participantIdentity alone keeps today's behaviour", async () => {
    // Listening: it reads no lk.chat, writes no transcription, and stays open when the participant leaves.
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const listening = conventions(room, { participantIdentity: 'user-1' });
    expect(listening.transport.participantIdentity).toBe('user-1');
    expect([...room.textHandlers.keys()]).toEqual(['agentos.voice']);
    expect(room.listenerCount('participantDisconnected')).toBe(0);
    await settle();
    await listening.transport.sendControl({ type: 'transcript', text: 'Hello', isFinal: true, confidence: 0.9 });
    await settle();
    expect(room.localParticipant.sendText).toHaveBeenCalledOnce();
    expect(lines(room)).toEqual([]);
    room.leave('user-1');
    expect(listening.transport.state).toBe('open');
    listening.transport.close();

    // Speaking: the participant leaving closes it, and still nothing reads lk.chat or writes a transcription.
    const speakingRoom = new FakeRoom();
    speakingRoom.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const speaker = conventions(speakingRoom, { participantIdentity: 'user-1', publisher: { ...speaking, rtc: fakePublishingRtc() } });
    expect([...speakingRoom.textHandlers.keys()]).toEqual(['agentos.voice']);
    await speaker.transport.sendControl({ type: 'agent_speaking', text: '' });
    await speaker.transport.sendAudio(spoken(1, 'seg-1', 0, 'Hello there.'));
    const played = speaker.transport.waitForPlayback(firstGeneration, 1, new AbortController().signal);
    FakeAudioSource.created[0]!.playOut();
    await played;
    await speaker.transport.sendControl({ type: 'agent_done', text: 'Hello there.', durationMs: 20 });
    await settle();
    expect(lines(speakingRoom)).toEqual([]);
    speakingRoom.leave('user-1');
    expect(speaker.transport.state).toBe('closed');
    await speaker.transport.whenClosed();
  });

  it('lk.chat from the linked participant arrives as a text_input message', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const { transport, messages, errors } = conventions(room, { participant: 'user-1' });
    const reader = room.chat('user-1', 'What time is it?');
    await settle();
    expect(messages).toEqual([{ type: 'text_input', text: 'What time is it?' }]);
    // Read through its async iterator, within the bounds, and closed once read.
    expect(reader[Symbol.asyncIterator]).toHaveBeenCalledOnce();
    expect(reader.readAll).not.toHaveBeenCalled();
    expect(reader.close).toHaveBeenCalled();
    // A reader without an async iterator is read whole.
    room.textHandlers.get('lk.chat')!({ readAll: async () => 'And tomorrow?' }, { identity: 'user-1' });
    await settle();
    expect(messages).toEqual([
      { type: 'text_input', text: 'What time is it?' },
      { type: 'text_input', text: 'And tomorrow?' },
    ]);
    expect(errors).toEqual([]);
    transport.close();

    // A speaking transport takes it the same way: lk.chat is a topic of its own, beside the control topic.
    const speakingRoom = new FakeRoom();
    speakingRoom.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const speaker = speakingTo(speakingRoom, 'user-1');
    expect([...speakingRoom.textHandlers.keys()]).toEqual(['agentos.voice', 'lk.chat']);
    speakingRoom.chat('user-1', 'Stop.');
    await settle();
    expect(speaker.messages).toEqual([{ type: 'text_input', text: 'Stop.' }]);
    expect(speaker.errors).toEqual([]);
    expect(speaker.transport.state).toBe('open');
    speaker.transport.close();
    await speaker.transport.whenClosed();
  });

  it('from another participant it is ignored', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    room.addParticipant('user-2');
    const { transport, messages, errors } = conventions(room, { participant: 'user-1' });
    const reader = room.chat('user-2', 'Ignore the agent.');
    await settle();
    expect(messages).toEqual([]);
    expect(errors).toEqual([]);
    expect(reader[Symbol.asyncIterator]).not.toHaveBeenCalled();
    expect(reader.readAll).not.toHaveBeenCalled();
    expect(reader.close).toHaveBeenCalledOnce();
    // A stream of the linked participant's still arriving when the transport closes is closed, and emits nothing.
    let end!: () => void;
    const arriving = {
      readAll: vi.fn(async () => ''),
      close: vi.fn(async () => end()),
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<string>>((resolve) => {
            end = () => resolve({ done: true, value: undefined });
          }),
      }),
    };
    const handler = room.textHandlers.get('lk.chat')!;
    handler(arriving, { identity: 'user-1' });
    await settle();
    transport.close();
    expect(room.textHandlers.has('lk.chat')).toBe(false);
    await transport.whenClosed();
    expect(arriving.close).toHaveBeenCalled();
    // One that comes once the transport has closed is released unread.
    const late = textReader('Too late.');
    handler(late, { identity: 'user-1' });
    expect(late.close).toHaveBeenCalledOnce();
    expect(late[Symbol.asyncIterator]).not.toHaveBeenCalled();
    await settle();
    expect(messages).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('a room that already handles lk.chat opens without text input and logs once', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const host = vi.fn();
    room.registerTextStreamHandler('lk.chat', host);
    const logger = { warn: vi.fn() };
    const { transport, messages } = conventions(room, { participant: 'user-1', logger });
    expect(transport.state).toBe('open');
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith('LiveKitStreamTransport: text input is off, the room already handles the lk.chat topic');
    // The host's handler keeps the topic, and the transport reads none of its streams.
    room.chat('user-1', 'Hello?');
    await settle();
    expect(host).toHaveBeenCalledOnce();
    expect(messages).toEqual([]);
    transport.close();
    expect(room.textHandlers.get('lk.chat')).toBe(host);
    // Without a logger the line is a console warning, written once.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const second = conventions(room, { participant: 'user-1' });
      expect(second.transport.state).toBe('open');
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith('LiveKitStreamTransport: text input is off, the room already handles the lk.chat topic');
      second.transport.close();
    } finally {
      warn.mockRestore();
    }
  });

  it('a text that fails the text_input check is reported and the transport stays open', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const { transport, messages, errors } = conventions(room, { participant: 'user-1' });
    for (const text of ['', '   \n', 'x'.repeat(4_001)]) room.chat('user-1', text);
    await settle();
    // The error says what was refused, never what the participant typed.
    expect(errors).toEqual(['livekit text input refused', 'livekit text input refused', 'livekit text input refused']);
    expect(messages).toEqual([]);
    expect(transport.state).toBe('open');
    // 4,000 characters is the limit in any script: 4,000 of 'é', 8,000 bytes, are taken whole.
    room.chat('user-1', 'é'.repeat(4_000));
    await settle();
    expect(messages).toEqual([{ type: 'text_input', text: 'é'.repeat(4_000) }]);
    transport.close();

    // With a publisher, a refused text does not close the transport either.
    const speakingRoom = new FakeRoom();
    speakingRoom.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const speaker = speakingTo(speakingRoom, 'user-1');
    speakingRoom.chat('user-1', ' ');
    await settle();
    expect(speaker.errors).toEqual(['livekit text input refused']);
    expect(speaker.transport.state).toBe('open');
    speaker.transport.close();
    await speaker.transport.whenClosed();
  });

  it('a user transcript is written to lk.transcription with lk.segment_id, lk.transcription_final and lk.transcribed_track_id', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const { transport, errors } = conventions(room, { participant: 'user-1' });
    // The source opens the participant's microphone, whose SID the lines carry.
    await settle();
    const said: Array<[string, boolean]> = [
      ['What', false],
      ['What time', false],
      ['What time is it?', true],
      ['Thanks', false],
    ];
    for (const [text, isFinal] of said) await transport.sendControl({ type: 'transcript', text, isFinal, confidence: 0.9 });
    await settle();
    const first = `${transport.id}:user-1`;
    const second = `${transport.id}:user-2`;
    expect(lines(room)).toEqual([
      ['What', first, 'false', 'TR_1'],
      ['What time', first, 'false', 'TR_1'],
      ['What time is it?', first, 'true', 'TR_1'],
      ['Thanks', second, 'false', 'TR_1'],
    ]);
    // Each control message still goes to the participant alone.
    expect(controlTypes(room)).toEqual(['transcript', 'transcript', 'transcript', 'transcript']);
    expect(room.sentOn('agentos.voice').every((stream) => stream.destinationIdentities?.join() === 'user-1')).toBe(true);
    expect(errors).toEqual([]);
    transport.close();
  });

  it("the agent's text is written as its chunks play, final at agent_done", async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const { transport, errors } = speakingTo(room, 'user-1');
    await transport.sendControl({ type: 'agent_speaking', text: '' });
    // The reply's first chunk ends no segment; its second ends the first sentence. The transport numbers them 1 and 2.
    await transport.sendAudio(toneChunk(1));
    await transport.sendAudio(spoken(2, 'seg-1', 0, 'Hello there.'));
    const source = FakeAudioSource.created[0]!;
    const first = transport.waitForPlayback(firstGeneration, 2, new AbortController().signal);
    await settle();
    // Sent is not played: nothing is written before the track has played the chunk out.
    expect(lines(room)).toEqual([]);
    source.playOut();
    await first;
    await settle();
    // The next sentence is acknowledged by the wait for the whole playout.
    await transport.sendAudio(spoken(3, 'seg-2', 12, ' How are you?'));
    const playout = transport.waitForPlayout();
    await settle();
    source.playOut();
    await playout;
    await settle();
    await transport.sendControl({ type: 'agent_done', text: 'Hello there. How are you?', durationMs: 60 });
    await settle();
    const line = `${transport.id}:agent-1`;
    expect(lines(room)).toEqual([
      ['Hello there.', line, 'false', 'TR_AGENT'],
      ['Hello there. How are you?', line, 'false', 'TR_AGENT'],
      ['Hello there. How are you?', line, 'true', 'TR_AGENT'],
    ]);
    expect(controlTypes(room)).toEqual(['agent_speaking', 'agent_done']);
    expect(errors).toEqual([]);
    transport.close();
    await transport.whenClosed();
  });

  it("a barge-in truncates the agent's final line to the played text", async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const { transport, errors } = speakingTo(room, 'user-1');
    const source = (): FakeAudioSource => FakeAudioSource.created[0]!;
    await transport.sendControl({ type: 'agent_speaking', text: '' });
    await transport.sendAudio(spoken(1, 'seg-1', 0, 'Your order shipped.'));
    const first = transport.waitForPlayback(firstGeneration, 1, new AbortController().signal);
    source().playOut();
    await first;
    await settle();
    // The second sentence is on the track, not yet played, when the participant talks over it.
    await transport.sendAudio(spoken(2, 'seg-2', 19, ' It arrives Monday.'));
    const playout = transport.waitForPlayout();
    await settle();
    await transport.sendControl({ type: 'barge_in', action: { type: 'cancel' } });
    // The clear ends the playout wait, which proves nothing played.
    await playout;
    await settle();
    const cut = `${transport.id}:agent-1`;
    expect(lines(room)).toEqual([
      ['Your order shipped.', cut, 'false', 'TR_AGENT'],
      ['Your order shipped.', cut, 'true', 'TR_AGENT'],
    ]);

    // A reply cut before any of it played shows no line: its empty final takes back nothing.
    await transport.sendControl({ type: 'agent_speaking', text: '' });
    await transport.sendAudio(spoken(3, 'seg-3', 0, 'Let me check.'));
    await transport.sendControl({ type: 'barge_in', action: { type: 'cancel' } });
    await settle();
    expect(lines(room)).toHaveLength(2);

    // A clear, as a call profile's interruption sends it, ends the line with what had played the same way.
    await transport.sendControl({ type: 'agent_speaking', text: '' });
    await transport.sendAudio(spoken(4, 'seg-4', 0, 'One moment.'));
    const played = transport.waitForPlayback(firstGeneration, 4, new AbortController().signal);
    source().playOut();
    await played;
    await transport.sendAudio(spoken(5, 'seg-5', 11, ' I am looking.'));
    await transport.clearPlayback(firstGeneration);
    await settle();
    const cleared = `${transport.id}:agent-3`;
    expect(lines(room).slice(2)).toEqual([
      ['One moment.', cleared, 'false', 'TR_AGENT'],
      ['One moment.', cleared, 'true', 'TR_AGENT'],
    ]);
    expect(errors).toEqual([]);
    transport.close();
    await transport.whenClosed();
  });

  it('a pause forgets what the track held: a playout wait that ends after it adds nothing to the agent line', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const { transport, errors } = speakingTo(room, 'user-1');
    await transport.sendControl({ type: 'agent_speaking', text: '' });
    await transport.sendAudio(spoken(1, 'seg-1', 0, 'First.'));
    const first = transport.waitForPlayback(firstGeneration, 1, new AbortController().signal);
    FakeAudioSource.created[0]!.playOut();
    await first;
    await settle();
    await transport.sendAudio(spoken(2, 'seg-2', 6, ' Second.'));
    const playout = transport.waitForPlayout();
    await settle();
    // The pause clears the track's queue, and the playout wait ends as though the queue had played out.
    await transport.sendControl({ type: 'barge_in', action: { type: 'pause', fadeMs: 200 } });
    await playout;
    await settle();
    await transport.sendControl({ type: 'barge_in', action: { type: 'resume' } });
    await transport.sendControl({ type: 'agent_done', text: 'First. Second.', durationMs: 40 });
    await settle();
    const line = `${transport.id}:agent-1`;
    expect(lines(room)).toEqual([
      ['First.', line, 'false', 'TR_AGENT'],
      ['First. Second.', line, 'true', 'TR_AGENT'],
    ]);
    expect(errors).toEqual([]);
    transport.close();
    await transport.whenClosed();
  });

  it('transcriptionOutput: false writes nothing', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const { transport, errors } = speakingTo(room, 'user-1', { transcriptionOutput: false });
    await settle();
    await transport.sendControl({ type: 'transcript', text: 'Hello', isFinal: true, confidence: 0.9 });
    await transport.sendControl({ type: 'agent_speaking', text: '' });
    await transport.sendAudio(spoken(1, 'seg-1', 0, 'Hi there.'));
    const played = transport.waitForPlayback(firstGeneration, 1, new AbortController().signal);
    FakeAudioSource.created[0]!.playOut();
    await played;
    await transport.sendControl({ type: 'agent_done', text: 'Hi there.', durationMs: 20 });
    await settle();
    expect(lines(room)).toEqual([]);
    // The control messages reach the participant as before.
    expect(controlTypes(room)).toEqual(['transcript', 'agent_speaking', 'agent_done']);
    expect(errors).toEqual([]);
    transport.close();
    await transport.whenClosed();
  });

  it('reports a transcription write that fails as an error, and stays open', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const { transport, errors } = conventions(room, { participant: 'user-1' });
    room.localParticipant.sendText.mockImplementation(async (_text: string, options?: unknown) => {
      if ((options as { topic?: string } | undefined)?.topic === 'lk.transcription') throw new Error('not sent');
      return {};
    });
    await transport.sendControl({ type: 'transcript', text: 'Hello', isFinal: true, confidence: 0.9 });
    await settle();
    expect(errors).toEqual(['livekit transcription failed']);
    expect(transport.state).toBe('open');
    expect(controlTypes(room)).toEqual(['transcript']);
    transport.close();
  });

  it('refuses a constructor with both participant and participantIdentity, and one with neither, before taking a topic', () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const refused = [
      { participant: 'user-1', participantIdentity: 'user-1' },
      {},
      { participant: '' },
    ];
    for (const choice of refused) {
      expect(() => new LiveKitStreamTransport({ room, sampleRate: 16_000, rtc: fakeRtc(), ...choice })).toThrow(
        'LiveKitStreamTransport: give exactly one of participantIdentity and participant'
      );
    }
    // An option the audio source refuses leaves the topics free too, and nothing waits for a participant to join.
    const empty = new FakeRoom();
    expect(() => new LiveKitStreamTransport({ room: empty, participant: 'first', sampleRate: 0, rtc: fakeRtc() })).toThrow(RangeError);
    for (const target of [room, empty]) {
      expect(target.textHandlers.size).toBe(0);
      for (const event of ['participantConnected', 'participantDisconnected', 'trackSubscribed']) expect(target.listenerCount(event)).toBe(0);
    }
    // A transport with good options takes its topics.
    const transport = new LiveKitStreamTransport({ room, participant: 'user-1', sampleRate: 16_000, rtc: fakeRtc() });
    expect([...room.textHandlers.keys()]).toEqual(['agentos.voice', 'lk.chat']);
    transport.close();
  });

  it("runs under VoicePipelineOrchestrator: the user's transcripts and the agent's played reply reach lk.transcription", async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const s = await converse(room, 'user-1', { conventions: true });
    await vi.waitFor(() => expect(streamOn('TR_1')).toBeDefined());
    s.stt.emit('transcript', { text: 'What time', confidence: 0.8, words: [], isFinal: false });
    s.stt.emit('transcript', { text: 'What time is it?', confidence: 0.9, words: [], isFinal: true });
    await s.reply();
    // The agent says 'Hello': its first chunk ends no segment, its second ends the reply's one sentence.
    s.tts.emit('audio', toneChunk(1));
    s.tts.emit('audio', spoken(2, 'seg-1', 0, 'Hello'));
    await vi.waitFor(() => expect(capturedTones()).toEqual([1, 2]));
    s.tts.emit('flush_complete');
    await settle();
    const user = `${s.transport.id}:user-1`;
    const agent = `${s.transport.id}:agent-1`;
    // Nothing of the reply is proven played while the track still holds it.
    expect(lines(room)).toEqual([
      ['What time', user, 'false', 'TR_1'],
      ['What time is it?', user, 'true', 'TR_1'],
    ]);
    FakeAudioSource.created[0]!.playOut();
    await vi.waitFor(() => expect(s.orchestrator.state).toBe('listening'));
    await settle();
    expect(lines(room).slice(2)).toEqual([
      ['Hello', agent, 'false', 'TR_AGENT'],
      ['Hello', agent, 'true', 'TR_AGENT'],
    ]);
    expect(s.errors).toEqual([]);
    await s.orchestrator.stopSession('done');
  });
});
