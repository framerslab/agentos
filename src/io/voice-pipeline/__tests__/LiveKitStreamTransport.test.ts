/**
 * Unit tests for LiveKitStreamTransport.
 *
 * Runs over the fake rtc-node room of the hearing tests: audio is pushed into
 * a fake AudioStream, text streams are delivered to the registered handler,
 * and sends are read from the fake local participant.
 * The last test runs the transport under the real VoicePipelineOrchestrator.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LiveKitStreamTransport } from '../LiveKitStreamTransport.js';
import { VoicePipelineOrchestrator } from '../VoicePipelineOrchestrator.js';
import type {
  AudioFrame,
  ClientTextMessage,
  EncodedAudioChunk,
  IBargeinHandler,
  IEndpointDetector,
  IStreamingSTT,
  IStreamingTTS,
  IVoicePipelineAgentSession,
  StreamingSTTSession,
  StreamingTTSSession,
  TurnCompleteEvent,
} from '../types.js';
import {
  FakeAudioStream,
  FakePublication,
  FakeRoom,
  FakeTrack,
  fakeRtc,
  rtcFrame,
  settle,
} from '../../hearing/__tests__/livekit-fakes.js';

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
