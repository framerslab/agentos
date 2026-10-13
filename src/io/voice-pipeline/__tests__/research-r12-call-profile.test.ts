/**
 * The opt-in call profile: synthesis output of another scope is refused
 * before playback; an audio send the transport refuses ends the call, as no
 * failed send does on a session without the profile; a reply stays speaking
 * until the transport acknowledges
 * its playback, and real PCM reaches both detector seams; a short click does
 * not interrupt while six successive 20 ms speech frames do, cancelling the
 * model, synthesis and playback behind the inference fence; and a transient
 * detach keeps the call open, refuses results of the detached generation and
 * reattaches only with a newer transport epoch.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { VoicePipelineOrchestrator, type CallPipelineProfile } from '../VoicePipelineOrchestrator.js';
import type {
  AudioIdentity,
  EncodedAudioChunk,
  IAudioEndpointDetector,
  IPlaybackTransport,
  IVadSession,
  ScopedAudioFrame,
  ScopedStreamingSTTSession,
  StreamingTTSConfig,
  StreamingTTSSession,
} from '../types.js';

async function fixture(foreignOutput = false) {
  const initial: AudioIdentity = {
    scopeId: 'scope-a',
    callId: 'call-a',
    turnId: 'turn-a',
    generation: { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 },
  };
  let identity = initial;
  let sampleSequence = 0;
  let ack!: () => void;
  const transport: IPlaybackTransport = Object.assign(new EventEmitter(), {
    id: 'transport-a',
    state: 'open' as const,
    sendAudio: vi.fn(async () => {}),
    sendControl: vi.fn(async () => {}),
    close: vi.fn(),
    waitForPlayback: vi.fn(async (generation: AudioIdentity['generation'], sequence: number, signal: AbortSignal) => new Promise<{ generation: AudioIdentity['generation']; sequence: number; playedSamples: number; sampleRate: number }>((resolve, reject) => {
      ack = () => resolve({ generation, sequence, playedSamples: 320, sampleRate: 16000 });
      if (signal.aborted) reject(new Error('aborted'));
      else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })),
    clearPlayback: vi.fn(async () => {}),
  });
  const stt: ScopedStreamingSTTSession = Object.assign(new EventEmitter(), {
    pushAudio() {},
    pushAudioScoped: vi.fn(async () => {}),
    reset: vi.fn(async (next: AudioIdentity) => {
      identity = next;
    }),
    flush: async () => {},
    close: vi.fn(),
  });
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
  const sessions: StreamingTTSSession[] = [];
  const agent = {
    sendText: vi.fn(async function* () {
      yield 'hello';
    }),
    abort: vi.fn(),
  };
  const profile: CallPipelineProfile = {
    identity: initial,
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
  const runtime = new VoicePipelineOrchestrator({ stt: 'fake', tts: 'fake' });
  const session = await runtime.startSession(transport, agent, {
    streamingSTT: { providerId: 'fake', isStreaming: true, startSession: async () => stt },
    streamingTTS: {
      providerId: 'fake',
      startSession: async (config?: StreamingTTSConfig) => {
        let sink: ((chunk: EncodedAudioChunk) => Promise<void>) | undefined;
        const t: StreamingTTSSession = Object.assign(new EventEmitter(), {
          pushTokens() {},
          setAudioSink(fn: (chunk: EncodedAudioChunk) => Promise<void>) {
            sink = fn;
          },
          async writeTokens() {
            const call = config!.call!;
            t.emit('usage', { ...call, providerId: 'fake', acceptedCharacters: 5, generatedSamples: 320, sampleRate: 16000, status: 'running', final: false });
            await sink!({
              scopeId: foreignOutput ? 'scope-b' : call.scopeId,
              callId: call.callId,
              audio: Buffer.alloc(640),
              format: 'pcm',
              container: 'raw',
              sampleRate: 16000,
              durationMs: 20,
              text: 'hello',
              generation: { ...call.generation },
            });
          },
          async flush() {
            t.emit('usage', { ...config!.call!, providerId: 'fake', acceptedCharacters: 5, generatedSamples: 320, sampleRate: 16000, status: 'completed', final: true });
            t.emit('flush_complete');
          },
          cancel: vi.fn(),
          close: vi.fn(),
        });
        sessions.push(t);
        return t;
      },
    },
    callProfile: profile,
  });
  const turn = () => endpoint.emit('turn_complete', { ...identity, transcript: 'hello', confidence: 1, durationMs: 20, reason: 'manual' });
  const audio = () => transport.emit('audio', { samples: new Float32Array(320), sampleRate: 16000, channels: 1, timestamp: ++sampleSequence * 20 });
  return { runtime, session, turn, audio, ack: () => ack(), transport, profile, vad, endpoint, stt, agent, sessions, identity: () => identity };
}

describe('call profile', () => {
  it('refuses foreign output before playback', async () => {
    const f = await fixture(true);
    f.turn();
    await vi.waitFor(() => expect(f.runtime.state).toBe('closed'));
    expect(f.transport.sendAudio).not.toHaveBeenCalled();
    await f.runtime.stopSession();
  });

  it('ends the call when the transport refuses its audio', async () => {
    const f = await fixture();
    f.transport.sendAudio = vi.fn(async () => {
      throw new Error('send failed');
    });
    f.turn();
    await vi.waitFor(() => expect(f.runtime.state).toBe('closed'));
    expect(f.profile.onFailure).toHaveBeenCalledOnce();
    expect(f.transport.waitForPlayback).not.toHaveBeenCalled();
    expect(f.transport.sendControl).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_done' }));
    await f.runtime.stopSession();
  });

  it('stays speaking through playback, reports real PCM arrival and completes only on acknowledgement', async () => {
    const f = await fixture();
    f.audio();
    await vi.waitFor(() => expect(f.endpoint.pushAudio).toHaveBeenCalledOnce());
    f.turn();
    await vi.waitFor(() => expect(f.transport.waitForPlayback).toHaveBeenCalledOnce());
    expect(f.runtime.state).toBe('speaking');
    expect(f.transport.sendControl).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_done' }));
    f.ack();
    await vi.waitFor(() => expect(f.runtime.state).toBe('listening'));
    expect(f.transport.sendControl).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_done', durationMs: 20 }));
    await f.runtime.stopSession();
    expect(f.vad.dispose).toHaveBeenCalledOnce();
  });

  it('ignores a short click and cancels at six successive twenty-millisecond speech frames', async () => {
    const f = await fixture();
    f.turn();
    await vi.waitFor(() => expect(f.runtime.state).toBe('speaking'));
    f.audio();
    await vi.waitFor(() => expect(f.endpoint.pushVadEvent).toHaveBeenCalledOnce());
    expect(f.agent.abort).not.toHaveBeenCalled();
    for (let i = 0; i < 5; i++) {
      f.audio();
      await vi.waitFor(() => expect(f.endpoint.pushAudio).toHaveBeenCalledTimes(i + 2));
    }
    await vi.waitFor(() => expect(f.agent.abort).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.runtime.state).toBe('listening'));
    expect(f.sessions[0]!.cancel).toHaveBeenCalledOnce();
    expect(f.transport.clearPlayback).toHaveBeenCalled();
    expect(f.profile.fenceInference).toHaveBeenCalled();
    await f.runtime.stopSession();
  });

  it('detaches without close, fences old results and requires a newer epoch', async () => {
    const f = await fixture();
    const closed = vi.fn();
    f.session.on('close', closed);
    const old = f.identity();
    await f.runtime.detach('socket_lost', 1);
    expect(closed).not.toHaveBeenCalled();
    f.endpoint.emit('turn_complete', { ...old, transcript: 'stale', confidence: 1, durationMs: 20, reason: 'manual' });
    expect(f.agent.sendText).not.toHaveBeenCalled();
    await expect(f.runtime.reattach({ workerGeneration: 1, inferenceGeneration: 2, transportEpoch: 1 })).rejects.toThrow();
    await f.runtime.reattach({ workerGeneration: 1, inferenceGeneration: 2, transportEpoch: 2 });
    const waiting = expect(f.runtime.waitForUserTurn()).rejects.toThrow('closed');
    await f.runtime.stopSession();
    await waiting;
    expect(closed).toHaveBeenCalledOnce();
  });
});
