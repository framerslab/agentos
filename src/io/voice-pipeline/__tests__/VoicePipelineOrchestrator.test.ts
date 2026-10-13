/**
 * @module voice-pipeline/__tests__/VoicePipelineOrchestrator.spec
 *
 * Tests for the VoicePipelineOrchestrator state machine. All pipeline
 * components (STT, TTS, endpoint detector, barge-in handler, agent session)
 * are mocked to isolate the orchestrator's wiring and state transition logic.
 *
 * ## What is tested
 *
 * - Initial state is `'idle'`
 * - startSession transitions to `'listening'`
 * - Audio frames are forwarded from transport to STT
 * - Transcript events are forwarded from STT to endpoint detector AND transport
 * - turn_complete triggers LISTENING -> PROCESSING -> SPEAKING transitions
 * - LLM tokens are piped to TTS during SPEAKING
 * - TTS audio chunks are forwarded to transport
 * - flush_complete triggers SPEAKING -> LISTENING
 * - Barge-in (speech_start during SPEAKING) cancels TTS and returns to LISTENING
 * - Transport disconnect transitions to CLOSED
 * - stopSession tears down all components
 * - VAD events are forwarded from STT speech_start/speech_end to endpoint detector
 * - turn_complete is re-emitted on the orchestrator, so waitForUserTurn() resolves
 * - A turn_complete listener that stops the session leaves it closed, and no turn is taken
 * - A turn_complete listener that throws is reported; the listeners after it run and the turn is taken
 * - A transport send that rejects is reported once as 'error' and the turn goes on; with nothing listening
 *   for 'error' it is written as a console warning that names the failure, as is an 'error' listener that
 *   throws or rejects, and the listeners after that one still get the failure
 * - The errorMonitor listeners get each failure first, even when nothing listens for 'error'
 * - A listener's rejection is reported from a promise of another realm or library as from a native one
 * - Of the audio chunks a transport refuses, the first of each reply is reported and the rest of that reply's
 *   are not, whatever order the replies' sends settle in; a refused control message is reported each time
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { VoicePipelineOrchestrator } from '../VoicePipelineOrchestrator.js';
import type {
  AudioFrame,
  BargeinAction,
  EncodedAudioChunk,
  IBargeinHandler,
  IEndpointDetector,
  IStreamTransport,
  IStreamingSTT,
  IStreamingTTS,
  IVoicePipelineAgentSession,
  StreamingSTTSession,
  StreamingTTSSession,
  TurnCompleteEvent,
  VoicePipelineConfig,
} from '../types.js';

// ============================================================================
// Mock factories
// ============================================================================

/** Creates a mock IStreamTransport backed by an EventEmitter. */
function createMockTransport(): IStreamTransport & EventEmitter {
  const emitter = new EventEmitter() as IStreamTransport & EventEmitter;
  Object.defineProperty(emitter, 'id', { value: 'transport-1' });
  Object.defineProperty(emitter, 'state', { value: 'open', writable: true });
  (emitter as any).sendAudio = vi.fn().mockResolvedValue(undefined);
  (emitter as any).sendControl = vi.fn().mockResolvedValue(undefined);
  (emitter as any).close = vi.fn();
  return emitter;
}

/** Creates a mock StreamingSTTSession that can emit transcript/speech events. */
function createMockSTTSession(): StreamingSTTSession & EventEmitter {
  const emitter = new EventEmitter() as StreamingSTTSession & EventEmitter;
  (emitter as any).pushAudio = vi.fn();
  (emitter as any).flush = vi.fn().mockResolvedValue(undefined);
  (emitter as any).close = vi.fn();
  return emitter;
}

/** Creates a mock IStreamingSTT factory that resolves with the given session. */
function createMockSTT(session: StreamingSTTSession): IStreamingSTT {
  return {
    providerId: 'mock-stt',
    isStreaming: false,
    startSession: vi.fn().mockResolvedValue(session),
  };
}

/** Creates a mock StreamingTTSSession that can emit audio/flush_complete. */
function createMockTTSSession(): StreamingTTSSession & EventEmitter {
  const emitter = new EventEmitter() as StreamingTTSSession & EventEmitter;
  (emitter as any).pushTokens = vi.fn();
  (emitter as any).flush = vi.fn().mockResolvedValue(undefined);
  (emitter as any).cancel = vi.fn();
  (emitter as any).close = vi.fn();
  return emitter;
}

/** Creates a mock IStreamingTTS factory that resolves with the given session. */
function createMockTTS(session: StreamingTTSSession): IStreamingTTS {
  return {
    providerId: 'mock-tts',
    startSession: vi.fn().mockResolvedValue(session),
  };
}

/** Creates a mock IEndpointDetector backed by an EventEmitter. */
function createMockEndpoint(): IEndpointDetector & EventEmitter {
  const emitter = new EventEmitter() as IEndpointDetector & EventEmitter;
  Object.defineProperty(emitter, 'mode', { value: 'heuristic' });
  (emitter as any).pushVadEvent = vi.fn();
  (emitter as any).pushTranscript = vi.fn();
  (emitter as any).reset = vi.fn();
  return emitter;
}

/** Creates a mock IBargeinHandler that returns the specified action. */
function createMockBargeinHandler(action: BargeinAction = { type: 'cancel' }): IBargeinHandler {
  return {
    mode: 'hard-cut',
    handleBargein: vi.fn().mockReturnValue(action),
  };
}

/** Creates a mock agent session that yields the given tokens from sendText. */
function createMockAgentSession(tokens: string[] = ['Hello', ' world']): IVoicePipelineAgentSession {
  return {
    sendText: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        for (const t of tokens) yield t;
      },
    }),
    abort: vi.fn(),
  };
}

/** Creates a minimal VoicePipelineConfig with sensible test defaults. */
function makeConfig(overrides?: Partial<VoicePipelineConfig>): VoicePipelineConfig {
  return {
    stt: 'mock-stt',
    tts: 'mock-tts',
    maxTurnDurationMs: 30_000,
    ...overrides,
  };
}

/** Creates a minimal AudioFrame for injection tests. */
function makeFrame(): AudioFrame {
  return {
    samples: new Float32Array([0.1, 0.2]),
    sampleRate: 16000,
    timestamp: Date.now(),
  };
}

/** Creates a minimal TurnCompleteEvent for triggering turn processing. */
function makeTurnComplete(): TurnCompleteEvent {
  return {
    transcript: 'Hello there',
    confidence: 0.95,
    durationMs: 1200,
    reason: 'silence_timeout',
  };
}

/** Creates a minimal EncodedAudioChunk for TTS audio emission tests. */
function makeAudioChunk(): EncodedAudioChunk {
  return {
    audio: Buffer.from([0]),
    format: 'opus',
    sampleRate: 24000,
    durationMs: 100,
    text: 'Hello',
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('VoicePipelineOrchestrator', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let sttSession: ReturnType<typeof createMockSTTSession>;
  let ttsSession: ReturnType<typeof createMockTTSSession>;
  let endpoint: ReturnType<typeof createMockEndpoint>;
  let bargein: IBargeinHandler;
  let agentSession: IVoicePipelineAgentSession;
  let orchestrator: VoicePipelineOrchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = createMockTransport();
    sttSession = createMockSTTSession();
    ttsSession = createMockTTSSession();
    endpoint = createMockEndpoint();
    bargein = createMockBargeinHandler();
    agentSession = createMockAgentSession();
    orchestrator = new VoicePipelineOrchestrator(makeConfig());
  });

  /** Helper to start a session with all mock components wired up. */
  async function startSession() {
    return orchestrator.startSession(transport, agentSession, {
      streamingSTT: createMockSTT(sttSession),
      streamingTTS: createMockTTS(ttsSession),
      endpointDetector: endpoint,
      bargeinHandler: bargein,
    });
  }

  it('should start in idle state before any session is created', () => {
    expect(orchestrator.state).toBe('idle');
  });

  it('should transition to listening when startSession is called', async () => {
    await startSession();
    expect(orchestrator.state).toBe('listening');
  });

  it('should forward audio frames from transport to STT session', async () => {
    await startSession();
    const frame = makeFrame();
    transport.emit('audio', frame);
    expect(sttSession.pushAudio).toHaveBeenCalledWith(frame);
  });

  it('should forward transcript events from STT to endpoint detector', async () => {
    await startSession();
    const transcript = { text: 'hello', confidence: 0.9, words: [], isFinal: false };
    sttSession.emit('transcript', transcript);
    expect(endpoint.pushTranscript).toHaveBeenCalledWith(transcript);
  });

  it('should relay transcript events to transport as control messages', async () => {
    await startSession();
    const transcript = { text: 'hello', confidence: 0.9, words: [], isFinal: true };
    sttSession.emit('transcript', transcript);
    expect(transport.sendControl).toHaveBeenCalledWith({
      type: 'transcript',
      text: 'hello',
      isFinal: true,
      confidence: 0.9,
    });
  });

  /**
   * Validates the core state machine progression on turn_complete:
   * LISTENING -> PROCESSING (agent thinking) -> SPEAKING (tokens streaming).
   */
  it('should transition LISTENING -> PROCESSING -> SPEAKING when turn_complete fires', async () => {
    await startSession();
    const states: string[] = [];
    orchestrator.on('state_changed', (evt: { from: string; to: string }) => states.push(evt.to));

    endpoint.emit('turn_complete', makeTurnComplete());
    // Allow the async token iteration to complete
    await vi.advanceTimersByTimeAsync(0);

    expect(states).toContain('processing');
    expect(states).toContain('speaking');
  });

  it('should pipe LLM tokens to the TTS session during SPEAKING', async () => {
    await startSession();
    endpoint.emit('turn_complete', makeTurnComplete());
    await vi.advanceTimersByTimeAsync(0);

    expect(ttsSession.pushTokens).toHaveBeenCalledWith('Hello');
    expect(ttsSession.pushTokens).toHaveBeenCalledWith(' world');
  });

  it('should forward TTS audio chunks to the transport during SPEAKING', async () => {
    await startSession();
    endpoint.emit('turn_complete', makeTurnComplete());
    await vi.advanceTimersByTimeAsync(0);

    const chunk = makeAudioChunk();
    ttsSession.emit('audio', chunk);
    expect(transport.sendAudio).toHaveBeenCalledWith(chunk);
  });

  it('should transition SPEAKING -> LISTENING when TTS flush_complete fires', async () => {
    await startSession();
    endpoint.emit('turn_complete', makeTurnComplete());
    await vi.advanceTimersByTimeAsync(0);

    expect(orchestrator.state).toBe('speaking');
    ttsSession.emit('flush_complete');
    expect(orchestrator.state).toBe('listening');
  });

  it('should send agent_done control message when TTS flush_complete fires', async () => {
    await startSession();
    endpoint.emit('turn_complete', makeTurnComplete());
    await vi.advanceTimersByTimeAsync(0);

    ttsSession.emit('flush_complete');
    expect(transport.sendControl).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agent_done' }),
    );
  });

  /**
   * Validates barge-in: when speech_start is detected during SPEAKING,
   * the handler returns 'cancel', TTS is stopped, agent is aborted,
   * and state returns to LISTENING.
   */
  it('should cancel TTS and return to LISTENING on barge-in during SPEAKING', async () => {
    await startSession();
    endpoint.emit('turn_complete', makeTurnComplete());
    await vi.advanceTimersByTimeAsync(0);

    expect(orchestrator.state).toBe('speaking');

    // Simulate speech_start during SPEAKING (barge-in trigger)
    sttSession.emit('speech_start');
    await vi.advanceTimersByTimeAsync(0);

    expect(ttsSession.cancel).toHaveBeenCalled();
    expect(agentSession.abort).toHaveBeenCalled();
    expect(orchestrator.state).toBe('listening');
    expect(transport.sendControl).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'barge_in' }),
    );
  });

  it('should transition to CLOSED when transport disconnects', async () => {
    await startSession();
    transport.emit('close');
    expect(orchestrator.state).toBe('closed');
    expect(sttSession.close).toHaveBeenCalled();
    expect(ttsSession.close).toHaveBeenCalled();
  });

  it('should tear down all components when stopSession is called', async () => {
    await startSession();
    await orchestrator.stopSession('test teardown');
    expect(orchestrator.state).toBe('closed');
    expect(sttSession.close).toHaveBeenCalled();
    expect(ttsSession.close).toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalledWith(1000, 'test teardown');
  });

  it('should reset endpoint detector after flush_complete to prepare for next turn', async () => {
    await startSession();
    endpoint.emit('turn_complete', makeTurnComplete());
    await vi.advanceTimersByTimeAsync(0);

    ttsSession.emit('flush_complete');
    expect(endpoint.reset).toHaveBeenCalled();
  });

  /**
   * Validates that the orchestrator synthesises VAD events from STT
   * speech_start/speech_end signals and forwards them to the endpoint
   * detector, enabling endpoint detection even without a dedicated VAD.
   */
  it('should forward synthetic VAD events from STT speech_start/speech_end to endpoint detector', async () => {
    await startSession();
    sttSession.emit('speech_start');
    await vi.advanceTimersByTimeAsync(0);
    expect(endpoint.pushVadEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'speech_start', source: 'stt' }),
    );

    sttSession.emit('speech_end');
    expect(endpoint.pushVadEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'speech_end', source: 'stt' }),
    );
  });

  it('re-emits the detector\'s turn_complete, so waitForUserTurn() resolves', async () => {
    const transport = createMockTransport();
    const sttSession = createMockSTTSession();
    const ttsSession = createMockTTSSession();
    const detector = createMockEndpoint();
    const orchestrator = new VoicePipelineOrchestrator({ stt: 'mock', tts: 'mock' } as VoicePipelineConfig);
    await orchestrator.startSession(transport, createMockAgentSession(), {
      streamingSTT: createMockSTT(sttSession),
      streamingTTS: createMockTTS(ttsSession),
      endpointDetector: detector,
      bargeinHandler: createMockBargeinHandler(),
    });
    const turn = orchestrator.waitForUserTurn();
    const event: TurnCompleteEvent = { transcript: 'hello there', confidence: 0.9, durationMs: 800, reason: 'punctuation' };
    detector.emit('turn_complete', event);
    await expect(turn).resolves.toBe(event); // the detector's own event, handed on as it is
  });

  /**
   * A listener on the orchestrator's turn_complete runs inside the handler of
   * the detector's event. One that stops the session must leave it closed: no
   * state after CLOSED, no agent_thinking and no call to the agent.
   */
  it('takes no turn when a turn_complete listener stops the session', async () => {
    await startSession();
    const states: string[] = [];
    orchestrator.on('state_changed', (evt: { from: string; to: string }) => states.push(evt.to));
    orchestrator.on('turn_complete', () => {
      void orchestrator.stopSession('ended by a listener');
    });

    endpoint.emit('turn_complete', makeTurnComplete());
    await vi.advanceTimersByTimeAsync(0);

    expect(orchestrator.state).toBe('closed');
    expect(states).toEqual(['closed']);
    expect(agentSession.sendText).not.toHaveBeenCalled();
    expect(transport.sendControl).not.toHaveBeenCalledWith({ type: 'agent_thinking' });
  });

  it('runs every turn_complete listener and still takes the turn when one of them throws', async () => {
    await startSession();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const errors: Error[] = [];
      orchestrator.on('error', (err: Error) => errors.push(err));
      orchestrator.on('turn_complete', () => {
        throw new Error('a listener failed');
      });
      const turn = orchestrator.waitForUserTurn(); // registered after the listener that throws
      const event = makeTurnComplete();
      endpoint.emit('turn_complete', event);
      await vi.advanceTimersByTimeAsync(0);
      await expect(turn).resolves.toBe(event);
      expect(errors.map((err) => err.message)).toEqual(['a listener failed']);
      expect(agentSession.sendText).toHaveBeenCalledWith('Hello there', expect.objectContaining({ endpointReason: 'silence_timeout' }));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  /**
   * The orchestrator does not wait for its sends, and a transport's send can reject: the WebSocket
   * transport rejects with the error ws.send() reports for a socket that is closing, and the LiveKit
   * transport rejects a control message its room cannot send while it disconnects. Each rejection is
   * reported once as 'error', with the rejection itself, and the turn goes on.
   */
  it('reports each transport send that rejects as error, once, and goes on with the turn', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const thinkingFailed = new Error('agent_thinking was not sent');
      const speakingFailed = new Error('agent_speaking was not sent');
      const audioFailed = new Error('the first chunk was not sent');
      vi.mocked(transport.sendControl).mockRejectedValueOnce(thinkingFailed).mockRejectedValueOnce(speakingFailed);
      vi.mocked(transport.sendAudio).mockRejectedValueOnce(audioFailed);
      await startSession();
      const errors: unknown[] = [];
      orchestrator.on('error', (err: unknown) => errors.push(err));

      endpoint.emit('turn_complete', makeTurnComplete());
      await vi.advanceTimersByTimeAsync(0);
      const second = makeAudioChunk();
      ttsSession.emit('audio', makeAudioChunk());
      ttsSession.emit('audio', second);
      await vi.advanceTimersByTimeAsync(0);
      ttsSession.emit('flush_complete');
      await vi.advanceTimersByTimeAsync(0);

      const failures = [thinkingFailed, speakingFailed, audioFailed];
      expect(errors).toEqual(failures);
      errors.forEach((err, i) => expect(err).toBe(failures[i])); // the rejection itself, not a copy
      // The sends after the failed ones go out, and the turn ends as a turn without a failure does.
      expect(transport.sendAudio).toHaveBeenLastCalledWith(second);
      expect(transport.sendControl).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'agent_done', text: 'Hello world' }),
      );
      expect(orchestrator.state).toBe('listening');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('writes a failed send as a console warning when nothing listens for error, or when the error listener throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      vi.mocked(transport.sendControl).mockRejectedValue(new Error('the socket is closing'));
      await startSession();
      const transcript = { text: 'hello', confidence: 0.9, words: [], isFinal: true };

      sttSession.emit('transcript', transcript); // nothing listens for 'error' yet
      await vi.advanceTimersByTimeAsync(0);
      orchestrator.on('error', () => {
        throw new Error('the error listener failed');
      });
      sttSession.emit('transcript', transcript);
      await vi.advanceTimersByTimeAsync(0);

      expect(warn.mock.calls.map((args) => args.join(' '))).toEqual([
        expect.stringContaining('the socket is closing'),
        expect.stringMatching(/the socket is closing.*the error listener failed/), // both failures
      ]);
      expect(orchestrator.state).toBe('listening');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      warn.mockRestore();
    }
  });

  /**
   * A transport that does not publish audio, as LiveKitStreamTransport does not, refuses every chunk of every
   * reply. The orchestrator reports the first refused chunk of each reply and not the rest of that reply's
   * chunks, while each refused control message is still reported.
   */
  it('reports the first refused audio chunk of each reply, and each refused control message', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const audioRefused = new Error('this transport does not publish audio');
      const doneFailed = new Error('agent_done was not sent');
      vi.mocked(transport.sendAudio).mockRejectedValue(audioRefused);
      vi.mocked(transport.sendControl).mockImplementation(async (message) => {
        if (message.type === 'agent_done') throw doneFailed;
      });
      await startSession();
      const errors: unknown[] = [];
      orchestrator.on('error', (err: unknown) => errors.push(err));

      // Two replies of three chunks each, every chunk refused.
      for (let reply = 0; reply < 2; reply++) {
        endpoint.emit('turn_complete', makeTurnComplete());
        await vi.advanceTimersByTimeAsync(0);
        for (let chunk = 0; chunk < 3; chunk++) ttsSession.emit('audio', makeAudioChunk());
        await vi.advanceTimersByTimeAsync(0);
        ttsSession.emit('flush_complete');
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(transport.sendAudio).toHaveBeenCalledTimes(6);
      expect(errors).toEqual([audioRefused, doneFailed, audioRefused, doneFailed]);
      expect(orchestrator.state).toBe('listening');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  /**
   * Each reply keeps its own record of the refusal it reported, so the order in which the sends of different replies
   * settle does not matter: a chunk of an earlier reply that is refused after a later reply's refusal was reported is
   * still the earlier reply's first refused chunk, and is reported.
   */
  it("reports an earlier reply's first refused audio chunk when it is refused after a later reply's", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const firstRefused = new Error("the first reply's chunk was not sent");
      const secondRefused = new Error("the second reply's chunk was not sent");
      let refuseFirst: (err: Error) => void = () => undefined;
      vi.mocked(transport.sendAudio)
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              refuseFirst = reject;
            }),
        )
        .mockRejectedValueOnce(secondRefused);
      await startSession();
      const errors: unknown[] = [];
      orchestrator.on('error', (err: unknown) => errors.push(err));

      // Two replies of one chunk each; the first reply's chunk is still being sent when the second's is refused.
      for (let reply = 0; reply < 2; reply++) {
        endpoint.emit('turn_complete', makeTurnComplete());
        await vi.advanceTimersByTimeAsync(0);
        ttsSession.emit('audio', makeAudioChunk());
        await vi.advanceTimersByTimeAsync(0);
        ttsSession.emit('flush_complete');
        await vi.advanceTimersByTimeAsync(0);
      }
      refuseFirst(firstRefused);
      await vi.advanceTimersByTimeAsync(0);

      expect(transport.sendAudio).toHaveBeenCalledTimes(2);
      expect(errors).toEqual([secondRefused, firstRefused]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  /**
   * The failures are reported from an async event handler or a promise's rejection handler, where an 'error'
   * listener's throw or rejection would become an unhandled rejection. Each is written as a console warning instead,
   * and the listeners after it still get the failure.
   */
  it("hands a failed send to every 'error' listener and writes one that throws or rejects as a console warning", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const refused = new Error('the socket is closing');
      vi.mocked(transport.sendControl).mockRejectedValue(refused);
      await startSession();
      const seen: unknown[] = [];
      orchestrator.on('error', () => {
        throw new Error('the first listener threw');
      });
      orchestrator.on('error', async () => {
        throw new Error('the second listener rejected');
      });
      orchestrator.on('error', (err: unknown) => seen.push(err));

      sttSession.emit('transcript', { text: 'hello', confidence: 0.9, words: [], isFinal: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(seen).toEqual([refused]);
      expect(warn.mock.calls.map((args) => args.join(' '))).toEqual([
        expect.stringMatching(/the socket is closing.*the first listener threw/),
        expect.stringMatching(/the socket is closing.*the second listener rejected/),
      ]);
      expect(orchestrator.state).toBe('listening');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      warn.mockRestore();
    }
  });

  /**
   * As emit('error') does, the orchestrator hands each failure to the errorMonitor listeners first, even when nothing
   * listens for 'error'; a monitor that rejects is written as a console warning too.
   */
  it("hands a failed send to the errorMonitor listeners, even when nothing listens for 'error'", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const refused = new Error('the socket is closing');
      vi.mocked(transport.sendControl).mockRejectedValue(refused);
      await startSession();
      const monitored: unknown[] = [];
      orchestrator.on(EventEmitter.errorMonitor, (err: unknown) => monitored.push(err));
      orchestrator.on(EventEmitter.errorMonitor, async () => {
        throw new Error('the monitor rejected');
      });

      sttSession.emit('transcript', { text: 'hello', confidence: 0.9, words: [], isFinal: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(monitored).toEqual([refused]);
      expect(warn.mock.calls.map((args) => args.join(' '))).toEqual([
        expect.stringMatching(/the socket is closing$/), // nothing listens for 'error'
        expect.stringMatching(/the socket is closing.*the monitor rejected/),
      ]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      warn.mockRestore();
    }
  });

  /**
   * A listener can return a promise of another realm, such as a node:vm context, or of another promise library, which
   * is not an instance of this realm's Promise. Its rejection is reported as a native promise's is.
   */
  it('reports a rejection from a promise of another library returned by a turn_complete or an error listener', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await startSession();
      // A promise-compatible value that is not a Promise of this realm, and rejects.
      const rejecting = (message: string) => ({
        then(_resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
          reject(new Error(message));
        },
      });
      orchestrator.on('turn_complete', () => rejecting('the turn_complete listener rejected'));
      orchestrator.on('error', () => rejecting('the error listener rejected'));

      endpoint.emit('turn_complete', makeTurnComplete());
      await vi.advanceTimersByTimeAsync(0);

      expect(warn.mock.calls.map((args) => args.join(' '))).toEqual([
        expect.stringMatching(/the turn_complete listener rejected.*the error listener rejected/),
      ]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      warn.mockRestore();
    }
  });
});
