/**
 * The session events of the call-profile runtime: the call's parts as `research-r12-call-profile.test.ts` builds them,
 * a scoped STT session, a VAD session, an audio endpoint detector, a pull-contract TTS session and a transport that
 * acknowledges each chunk's playback. One turn, one barge-in and one close emit the same events, in the same order,
 * as a session without a call profile, on the orchestrator from before `startSession()` returns and on the call's
 * own session; a failure keeps its `Error` on `'error'` and `errorMonitor` and adds `session_error` before `close`;
 * and an orchestrator listener that closes the call ends the event it was handed: no listener after it gets it.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { VoicePipelineOrchestrator, type CallPipelineProfile } from '../VoicePipelineOrchestrator.js';
import { recordSessionEvents } from './session-event-log.js';
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
  VoiceSessionEventMap,
} from '../types.js';

/** A call over fake parts, its session started with a log of the orchestrator's session events taken from before. */
async function call() {
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
    waitForPlayback: vi.fn(
      async (generation: AudioIdentity['generation'], sequence: number, signal: AbortSignal) =>
        new Promise<{ generation: AudioIdentity['generation']; sequence: number; playedSamples: number; sampleRate: number }>((resolve, reject) => {
          ack = () => resolve({ generation, sequence, playedSamples: 320, sampleRate: 16000 });
          if (signal.aborted) reject(new Error('aborted'));
          else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })
    ),
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
  const log = recordSessionEvents(runtime);
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
            const scoped = config!.call!;
            t.emit('usage', { ...scoped, providerId: 'fake', acceptedCharacters: 5, generatedSamples: 320, sampleRate: 16000, status: 'running', final: false });
            await sink!({
              scopeId: scoped.scopeId,
              callId: scoped.callId,
              audio: Buffer.alloc(640),
              format: 'pcm',
              container: 'raw',
              sampleRate: 16000,
              durationMs: 20,
              text: 'hello',
              generation: { ...scoped.generation },
            });
          },
          async flush() {
            t.emit('usage', { ...config!.call!, providerId: 'fake', acceptedCharacters: 5, generatedSamples: 320, sampleRate: 16000, status: 'completed', final: true });
            t.emit('flush_complete');
          },
          cancel: vi.fn(),
          close: vi.fn(),
        });
        return t;
      },
    },
    callProfile: profile,
  });
  const turn = () => endpoint.emit('turn_complete', { ...identity, transcript: 'hello', confidence: 1, durationMs: 20, reason: 'manual' });
  const final = () => stt.emit('transcript', { ...identity, text: 'hello', confidence: 1, words: [], isFinal: true });
  const audio = () => transport.emit('audio', { samples: new Float32Array(320), sampleRate: 16000, channels: 1, timestamp: ++sampleSequence * 20 });
  return { runtime, session, log, turn, final, audio, ack: () => ack(), transport, profile, endpoint, stt, agent };
}

describe('session events under a call profile', () => {
  it('emits the events of one turn, one barge-in and one close in the order a session without a profile does', async () => {
    const f = await call();
    // The call has opened by the time startSession() resolves.
    expect(f.log).toEqual(['agent initializing>listening']);
    const own = recordSessionEvents(f.session);

    // One turn: its final, the turn, the reply's first word, and its audio's acknowledged playback.
    f.final();
    await vi.waitFor(() => expect(f.log).toContain('transcribed final hello'));
    f.turn();
    await vi.waitFor(() => expect(f.transport.waitForPlayback).toHaveBeenCalledOnce());
    expect(f.runtime.state).toBe('speaking');
    f.ack();
    await vi.waitFor(() => expect(f.runtime.state).toBe('listening'));

    // One barge-in: six 20 ms frames of speech over the next reply cut it.
    f.turn();
    await vi.waitFor(() => expect(f.transport.waitForPlayback).toHaveBeenCalledTimes(2));
    for (let i = 0; i < 6; i++) {
      f.audio();
      await vi.waitFor(() => expect(f.endpoint.pushAudio).toHaveBeenCalledTimes(i + 1));
    }
    await vi.waitFor(() => expect(f.log).toContain('barge_in cancel'));
    await vi.waitFor(() => expect(f.runtime.state).toBe('listening'));

    // One close.
    await f.runtime.stopSession('done');

    const expected = [
      'agent initializing>listening',
      'transcribed final hello',
      'item user speech hello',
      'agent listening>thinking',
      'speech reply false',
      'agent thinking>speaking',
      'item assistant played hello|hello',
      'agent speaking>listening',
      'item user speech hello',
      'agent listening>thinking',
      'speech reply false',
      'agent thinking>speaking',
      'user listening>speaking',
      'barge_in cancel',
      // Which of its words were heard is not known: playedText says none rather than guess.
      'item assistant interrupted hello|',
      'agent speaking>listening',
      'close done',
    ];
    expect(f.log).toEqual(expected);
    // The call's own session emits the same events from the moment it is returned.
    expect(own).toEqual(expected.slice(1));
    expect(f.profile.onFailure).not.toHaveBeenCalled();
  });

  it('a text_input while the agent speaks cancels the reply and the agent receives the text', async () => {
    const f = await call();
    const cut: Array<VoiceSessionEventMap['barge_in']> = [];
    f.session.on('barge_in', (event) => cut.push(event));

    // The reply's audio waits for the transport's acknowledgement when the user types.
    f.turn();
    await vi.waitFor(() => expect(f.transport.waitForPlayback).toHaveBeenCalledOnce());
    expect(f.runtime.state).toBe('speaking');
    f.transport.emit('message', { type: 'text_input', text: 'hello' });
    // The text's reply plays to its end.
    await vi.waitFor(() => expect(f.transport.waitForPlayback).toHaveBeenCalledTimes(2));
    f.ack();
    await vi.waitFor(() => expect(f.runtime.state).toBe('listening'));

    expect(f.log).toEqual([
      'agent initializing>listening',
      'item user speech hello',
      'agent listening>thinking',
      'speech reply false',
      'agent thinking>speaking',
      'barge_in cancel',
      // Which of its words were heard is not known: playedText says none rather than guess.
      'item assistant interrupted hello|',
      'agent speaking>listening',
      'item user text hello',
      'agent listening>thinking',
      'speech reply false',
      'agent thinking>speaking',
      'item assistant played hello|hello',
      'agent speaking>listening',
    ]);
    // No speech cut the reply.
    expect(cut).toEqual([expect.objectContaining({ speechDurationMs: 0, interruptedText: 'hello', action: 'cancel' })]);
    expect(f.agent.sendText).toHaveBeenCalledTimes(2);
    expect(f.agent.sendText).toHaveBeenLastCalledWith(
      'hello',
      expect.objectContaining({ speakers: [], endpointReason: 'manual', speechDurationMs: 0, wasInterrupted: false, transcriptConfidence: 1 })
    );
    expect(f.profile.onFailure).not.toHaveBeenCalled();
    await f.runtime.stopSession();
  });

  it('a text_input while listening starts a turn', async () => {
    const f = await call();
    const turns = vi.fn();
    f.runtime.on('turn_complete', turns);

    f.transport.emit('message', { type: 'text_input', text: 'hello' });
    await vi.waitFor(() => expect(f.transport.waitForPlayback).toHaveBeenCalledOnce());
    f.ack();
    await vi.waitFor(() => expect(f.runtime.state).toBe('listening'));

    expect(f.log).toEqual([
      'agent initializing>listening',
      'item user text hello',
      'agent listening>thinking',
      'speech reply false',
      'agent thinking>speaking',
      'item assistant played hello|hello',
      'agent speaking>listening',
    ]);
    expect(turns).not.toHaveBeenCalled();
    expect(f.agent.sendText).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ speakers: [], endpointReason: 'manual', speechDurationMs: 0, wasInterrupted: false, transcriptConfidence: 1 })
    );
    expect(f.profile.onFailure).not.toHaveBeenCalled();
    await f.runtime.stopSession();
  });

  it('drops a text_input the check refuses, and the call goes on', async () => {
    const f = await call();

    f.transport.emit('message', { type: 'text_input', text: '   ' });
    f.transport.emit('message', { type: 'text_input', text: 'x'.repeat(4_001) });
    // The call still takes the next spoken turn.
    f.turn();
    await vi.waitFor(() => expect(f.transport.waitForPlayback).toHaveBeenCalledOnce());

    expect(f.log).toEqual(['agent initializing>listening', 'item user speech hello', 'agent listening>thinking', 'speech reply false', 'agent thinking>speaking']);
    expect(f.agent.sendText).toHaveBeenCalledOnce();
    expect(f.profile.onFailure).not.toHaveBeenCalled();
    await f.runtime.stopSession();
  });

  it("reports no reply's text when speech interrupts a turn the agent has yet to answer", async () => {
    const f = await call();
    const cut: string[] = [];
    f.session.on('barge_in', (event) => cut.push(event.interruptedText));

    // One turn, whose reply plays to its end.
    f.turn();
    await vi.waitFor(() => expect(f.transport.waitForPlayback).toHaveBeenCalledOnce());
    f.ack();
    await vi.waitFor(() => expect(f.runtime.state).toBe('listening'));

    // The next turn holds at its agent_thinking, before its reply has a word, and six 20 ms frames of speech cut it.
    let thinking!: () => void;
    vi.mocked(f.transport.sendControl).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          thinking = resolve;
        })
    );
    f.turn();
    await vi.waitFor(() => expect(thinking).toBeDefined());
    expect(f.runtime.state).toBe('processing');
    for (let i = 0; i < 6; i++) {
      f.audio();
      await vi.waitFor(() => expect(f.endpoint.pushAudio).toHaveBeenCalledTimes(i + 1));
    }
    await vi.waitFor(() => expect(f.log).toContain('barge_in cancel'));
    thinking();
    await vi.waitFor(() => expect(f.runtime.state).toBe('listening'));

    // The speech cut no words: the reply that played before it is not reported as interrupted.
    expect(cut).toEqual(['']);
    expect(f.log.filter((line) => line.startsWith('item assistant'))).toEqual(['item assistant played hello|hello']);
    await f.runtime.stopSession();
  });

  it('adds a reply whose playback was acknowledged as heard, though speech comes while its agent_done goes out', async () => {
    const f = await call();
    const cut: string[] = [];
    f.session.on('barge_in', (event) => cut.push(event.interruptedText));
    // The reply's agent_done is still going out when the user speaks.
    let sent!: () => void;
    const held = new Promise<void>((resolve) => {
      sent = resolve;
    });
    vi.mocked(f.transport.sendControl).mockImplementation(async (message) => {
      if (message.type === 'agent_done') await held;
    });

    f.turn();
    await vi.waitFor(() => expect(f.transport.waitForPlayback).toHaveBeenCalledOnce());
    f.ack();
    await vi.waitFor(() => expect(f.transport.sendControl).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_done' })));
    for (let i = 0; i < 6; i++) {
      f.audio();
      await vi.waitFor(() => expect(f.endpoint.pushAudio).toHaveBeenCalledTimes(i + 1));
    }
    await vi.waitFor(() => expect(f.log).toContain('barge_in cancel'));
    sent();
    await vi.waitFor(() => expect(f.runtime.state).toBe('listening'));

    // Its whole playback was acknowledged: the reply was heard, and the speech after it cut none of its text.
    expect(f.log).toContain('item assistant played hello|hello');
    expect(f.log).not.toContain('item assistant interrupted hello|');
    expect(cut).toEqual(['']);
    await f.runtime.stopSession();
  });

  it('speaks a prompt as speech the host created', async () => {
    const f = await call();
    const prompt = f.runtime.pushToTTS('Thanks for calling.');
    await vi.waitFor(() => expect(f.transport.waitForPlayback).toHaveBeenCalledOnce());
    f.ack();
    await prompt;
    await vi.waitFor(() => expect(f.runtime.state).toBe('listening'));
    expect(f.log).toEqual([
      'agent initializing>listening',
      'agent listening>thinking',
      'speech say true',
      'agent thinking>speaking',
      'item assistant played Thanks for calling.|Thanks for calling.',
      'agent speaking>listening',
    ]);
    await f.runtime.stopSession();
  });

  it('preserves Error on error and emits metadata on session_error before close', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const f = await call();
      const log: string[] = [];
      const delivered: unknown[] = [];
      f.session.on(EventEmitter.errorMonitor, (error: unknown) => {
        log.push('errorMonitor');
        delivered.push(error);
      });
      f.session.on('error', () => {
        throw new Error('a listener failed');
      });
      f.session.on('error', (error: Error) => {
        log.push(`error ${error instanceof Error} ${error.message} ${typeof error.stack}`);
        delivered.push(error);
      });
      f.session.on('session_error', (event) => {
        log.push(`session_error ${event.source} ${event.recoverable}`);
        delivered.push(event.error);
      });
      f.session.on('close', (event) => {
        log.push(`close ${event.reason}`);
        delivered.push(event.error);
      });

      f.stt.emit('error', new Error('what the caller said'));
      await vi.waitFor(() => expect(f.runtime.state).toBe('closed'));

      expect(log).toEqual([
        'errorMonitor',
        'error true voice call failed (provider_failure) string',
        'session_error stt false',
        'close provider_failure',
      ]);
      // One Error, the same object for every listener, which carries the content-free code alone.
      expect(new Set(delivered).size).toBe(1);
      expect(f.profile.onFailure).toHaveBeenCalledWith('provider_failure');
      // The listener that threw is written as a console warning, and the listener after it still got the failure.
      expect(warn.mock.calls.map((args) => args.join(' '))).toEqual([expect.stringMatching(/the call failed.*a listener failed/)]);
    } finally {
      warn.mockRestore();
    }
  });

  it('hands a failure to a call that listens with errorMonitor alone, and writes no warning for it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const f = await call();
      const monitored: unknown[] = [];
      f.session.on(EventEmitter.errorMonitor, (error: unknown) => monitored.push(error));

      f.stt.emit('error', new Error('what the caller said'));
      await vi.waitFor(() => expect(f.runtime.state).toBe('closed'));

      expect(monitored).toEqual([expect.any(Error)]);
      expect((monitored[0] as Error).message).toBe('voice call failed (provider_failure)');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("emits session_error before close though an 'error' listener closes the call", async () => {
    const f = await call();
    f.session.on('error', () => {
      void f.session.close('stopped');
    });
    const log = recordSessionEvents(f.session);

    f.stt.emit('error', new Error('what the caller said'));
    await vi.waitFor(() => expect(f.runtime.state).toBe('closed'));

    expect(log).toEqual(['session_error stt false', 'close stopped']);
    // The orchestrator's listeners get the session_error too: the call reads 'closed' before it goes out.
    expect(f.log).toEqual(['agent initializing>listening', 'session_error stt false', 'close stopped']);
  });

  it("hands an event to none of the orchestrator's later listeners once one of them closes the call", async () => {
    const f = await call();
    f.runtime.on('agent_state_changed', ({ newState }: VoiceSessionEventMap['agent_state_changed']) => {
      if (newState === 'thinking') void f.runtime.stopSession('done');
    });
    const later = recordSessionEvents(f.runtime);
    const own = recordSessionEvents(f.session);

    f.turn();
    await vi.waitFor(() => expect(f.runtime.state).toBe('closed'));

    // The agent's move to thinking reached the listener that closed the call, and no listener after it.
    expect(f.log).toEqual(['agent initializing>listening', 'item user speech hello', 'agent listening>thinking', 'close done']);
    expect(later).toEqual(['item user speech hello', 'close done']);
    expect(own).toEqual(['item user speech hello', 'close done']);
    // A later stop has the first one's outcome: the call's cleanup finished.
    await f.runtime.stopSession();
  });

  it('hands the deprecated turn_complete to no listener after one of them closes the call', async () => {
    const f = await call();
    const heard: string[] = [];
    f.runtime.on('turn_complete', () => {
      heard.push('the listener that closes');
      void f.runtime.stopSession('bye');
    });
    f.runtime.on('turn_complete', () => heard.push('a later orchestrator listener'));
    f.session.on('turn_complete', () => heard.push('a call listener'));

    f.turn();
    await vi.waitFor(() => expect(f.runtime.state).toBe('closed'));
    await f.runtime.stopSession();

    expect(heard).toEqual(['the listener that closes']);
  });

  it('takes the turn no further once a listener of the agent thinking closes the call', async () => {
    const f = await call();
    f.runtime.on('agent_state_changed', ({ newState }: VoiceSessionEventMap['agent_state_changed']) => {
      if (newState === 'thinking') void f.runtime.stopSession('done');
    });

    f.turn();
    await vi.waitFor(() => expect(f.runtime.state).toBe('closed'));
    await f.runtime.stopSession();

    // The start fenced the call's first generation; the closed call fences none for a turn it did not take.
    expect(f.profile.onGeneration).toHaveBeenCalledOnce();
    expect(f.transport.sendControl).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_thinking' }));
  });

  it('speaks no prompt once a listener of the agent thinking closes the call', async () => {
    const f = await call();
    f.runtime.on('agent_state_changed', ({ newState }: VoiceSessionEventMap['agent_state_changed']) => {
      if (newState === 'thinking') void f.runtime.stopSession('done');
    });

    await f.runtime.pushToTTS('Thanks for calling.');
    await vi.waitFor(() => expect(f.runtime.state).toBe('closed'));
    await f.runtime.stopSession();

    // The start fenced the call's first generation; the closed call fences none for a prompt it did not speak.
    expect(f.profile.onGeneration).toHaveBeenCalledOnce();
    expect(f.transport.sendControl).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_speaking' }));
  });

  it('emits close once, and cleans up once, though a listener of the close stops the session again', async () => {
    const f = await call();
    const reasons: string[] = [];
    // A host's "make sure it stopped" handler. Capped, so a close that goes out again and again ends.
    f.runtime.on('close', ({ reason }: VoiceSessionEventMap['close']) => {
      reasons.push(reason);
      if (reasons.length < 3) void f.runtime.stopSession();
    });
    const own: string[] = [];
    f.session.on('close', ({ reason }) => own.push(reason));

    await f.runtime.stopSession('done');
    await f.runtime.stopSession();

    expect(reasons).toEqual(['done']);
    expect(own).toEqual(['done']);
    expect(f.profile.fenceInference).toHaveBeenCalledOnce();
    expect(f.transport.close).toHaveBeenCalledOnce();
  });

  it('emits no second close when a stop follows a cleanup that failed, and cleans up again', async () => {
    const f = await call();
    const reasons: string[] = [];
    f.session.on('close', ({ reason }) => reasons.push(reason));
    vi.mocked(f.profile.fenceInference).mockRejectedValueOnce(new Error('the fence failed'));

    await expect(f.runtime.stopSession('done')).rejects.toThrow('the fence failed');
    expect(f.transport.close).not.toHaveBeenCalled();
    await f.runtime.stopSession('again');

    // The call closed once, as the first stop said; the second stop ran the cleanup the first could not finish.
    expect(reasons).toEqual(['done']);
    expect(f.profile.fenceInference).toHaveBeenCalledTimes(2);
    expect(f.transport.close).toHaveBeenCalledOnce();
  });

  it("names the session, not the agent, for a host prompt stream that fails, and rejects the host's call with its own error", async () => {
    const f = await call();
    const failures: Array<[string, boolean]> = [];
    f.session.on('session_error', (event) => failures.push([event.source, event.recoverable]));
    // The host's own stream of a prompt's text, which fails before its first word.
    const prompt = (async function* () {
      throw new Error('the prompt source failed');
    })();

    await expect(f.runtime.pushToTTS(prompt)).rejects.toThrow('the prompt source failed');
    await vi.waitFor(() => expect(f.runtime.state).toBe('closed'));

    expect(failures).toEqual([['session', false]]);
  });

  it("writes a session event listener's failure as a console warning by its type, never by what its error quotes", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const f = await call();
      // A listener whose own error quotes the transcript it was handed.
      f.session.on('user_input_transcribed', ({ transcript }) => {
        throw new Error(`could not read ${transcript}`);
      });

      f.final();
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());

      expect(warn.mock.calls.map((args) => args.join(' '))).toEqual(['[voice-pipeline-orchestrator] a user_input_transcribed listener failed: Error']);
      await f.runtime.stopSession();
    } finally {
      warn.mockRestore();
    }
  });

  it('names the transport as the source of a reply whose audio the transport refuses', async () => {
    const f = await call();
    f.transport.sendAudio = vi.fn(async () => {
      throw new Error('send failed');
    });
    const failures: Array<[string, boolean]> = [];
    f.session.on('session_error', (event) => failures.push([event.source, event.recoverable]));

    f.turn();
    await vi.waitFor(() => expect(f.runtime.state).toBe('closed'));

    expect(failures).toEqual([['transport', false]]);
    expect(f.profile.onFailure).toHaveBeenCalledWith('provider_failure');
  });

  it("reports the acknowledged prefix as the interrupted reply's played text", async () => {
    const f = await callWithBoundaries();

    // The reply has two sentence segments, one chunk each; the transport acknowledges the first.
    f.turn();
    await vi.waitFor(() => expect(f.transport.waitForPlayback).toHaveBeenCalledOnce());
    f.ack();
    await vi.waitFor(() => expect(f.transport.waitForPlayback).toHaveBeenCalledTimes(2));
    // Six 20 ms frames of speech cut the reply while its second segment waits to be heard.
    for (let i = 0; i < 6; i++) {
      f.audio();
      await vi.waitFor(() => expect(f.endpoint.pushAudio).toHaveBeenCalledTimes(i + 1));
    }
    await vi.waitFor(() => expect(f.log).toContain('barge_in cancel'));
    await vi.waitFor(() => expect(f.runtime.state).toBe('listening'));

    // The first segment's last frame was acknowledged and the second's was not: the played text is the first
    // segment, exactly, and nothing of the second.
    expect(f.log.filter((line) => line.startsWith('item assistant'))).toEqual([
      'item assistant interrupted Hello there. How are you|Hello there.',
    ]);
    expect(f.profile.onFailure).not.toHaveBeenCalled();
    await f.runtime.stopSession();
  });

  /**
   * A call over the same fake parts as `call()`, whose agent answers in two sentence segments and whose TTS session
   * ends each segment with one chunk that carries the segment's boundary, as the streaming adapters do.
   */
  async function callWithBoundaries() {
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
      id: 'transport-b',
      state: 'open' as const,
      sendAudio: vi.fn(async () => {}),
      sendControl: vi.fn(async () => {}),
      close: vi.fn(),
      waitForPlayback: vi.fn(
        async (generation: AudioIdentity['generation'], sequence: number, signal: AbortSignal) =>
          new Promise<{ generation: AudioIdentity['generation']; sequence: number; playedSamples: number; sampleRate: number }>((resolve, reject) => {
            ack = () => resolve({ generation, sequence, playedSamples: 320, sampleRate: 16000 });
            if (signal.aborted) reject(new Error('aborted'));
            else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          })
      ),
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
    const agent = {
      sendText: vi.fn(async function* () {
        yield 'Hello there.';
        yield ' How are you';
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
    const log = recordSessionEvents(runtime);
    const session = await runtime.startSession(transport, agent, {
      streamingSTT: { providerId: 'fake', isStreaming: true, startSession: async () => stt },
      streamingTTS: {
        providerId: 'fake',
        startSession: async (config?: StreamingTTSConfig) => {
          let sink: ((chunk: EncodedAudioChunk) => Promise<void>) | undefined;
          let offset = 0;
          let segments = 0;
          const t: StreamingTTSSession = Object.assign(new EventEmitter(), {
            pushTokens() {},
            setAudioSink(fn: (chunk: EncodedAudioChunk) => Promise<void>) {
              sink = fn;
            },
            // Each token is one segment: its one chunk is the segment's last frame and carries its boundary.
            async writeTokens(tokens: string) {
              const scoped = config!.call!;
              const textBoundary: NonNullable<EncodedAudioChunk['textBoundary']> = {
                segmentId: `seg-${++segments}`,
                start: offset,
                end: offset + tokens.length,
                text: tokens,
                final: true,
              };
              offset += tokens.length;
              t.emit('usage', { ...scoped, providerId: 'fake', acceptedCharacters: tokens.length, generatedSamples: 320 * segments, sampleRate: 16000, status: 'running', final: false });
              await sink!({
                scopeId: scoped.scopeId,
                callId: scoped.callId,
                audio: Buffer.alloc(640),
                format: 'pcm',
                container: 'raw',
                sampleRate: 16000,
                durationMs: 20,
                text: tokens,
                generation: { ...scoped.generation },
                textBoundary,
              });
            },
            async flush() {
              t.emit('usage', { ...config!.call!, providerId: 'fake', acceptedCharacters: offset, generatedSamples: 320 * segments, sampleRate: 16000, status: 'completed', final: true });
              t.emit('flush_complete');
            },
            cancel: vi.fn(),
            close: vi.fn(),
          });
          return t;
        },
      },
      callProfile: profile,
    });
    const turn = () => endpoint.emit('turn_complete', { ...identity, transcript: 'hello', confidence: 1, durationMs: 20, reason: 'manual' });
    const audio = () => transport.emit('audio', { samples: new Float32Array(320), sampleRate: 16000, channels: 1, timestamp: ++sampleSequence * 20 });
    return { runtime, session, log, turn, audio, ack: () => ack(), transport, profile, endpoint };
  }
});
