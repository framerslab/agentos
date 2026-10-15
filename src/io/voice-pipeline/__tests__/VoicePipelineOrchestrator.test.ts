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
 * - A send refused with a value String() cannot print (an object without a prototype, a revoked proxy) is
 *   reported, as is an 'error' listener that throws one, and nothing is left unhandled
 * - A session takes speech from the first source it receives, the transport's audio or a client's transcripts;
 *   what arrives from the other is dropped, and the drop is reported once
 * - A session started on a detector an earlier session used hands its first final to the agent: no late final of
 *   the earlier session's last turn is awaited
 * - A detector the host hands to one session after another loses each session's listeners as it stops, and as a
 *   start fails, with no listener-limit warning
 * - On the HeuristicEndpointDetector, a backchannel is dropped only while the agent holds the floor: said while the
 *   agent speaks, keyed by an item or not and whatever its trailing punctuation, or after the user's turn completed
 *   and before the reply has a word; while the agent listens a lone one is the user's turn, after a statement as
 *   after a question; a client's lone backchannel said while the agent speaks reaches the detector on its own, and
 *   a detector without isBackchannel() gets every client final joined
 * - A lone final that ends with a question mark, such as "Right?" after a statement, is the user's turn; the session
 *   tells the detector the agent listens as it starts, so a lone "sure" as its first utterance is the user's turn
 * - On the HeuristicEndpointDetector, a transcriber that sends each keyed final before its end of speech, as Deepgram
 *   does and marks with beforeSpeechEnd, has every turn handed to the agent, the second one included
 * - With the stock handlers, barge-in follows the user's speech as it grows: the handler is asked at its start and
 *   every 100 ms while it lasts, with the speech so far, the reply's text and the audio sent. HardCut cancels once the
 *   speech reaches minSpeechMs and lets a shorter sound go. SoftFade's pause holds the reply's audio, and the speech's
 *   end decides: a final with words cancels the reply and becomes the user's turn, from the STT session or a client's
 *   line, whether it comes before or after the end of speech, keyed by an item or not; a backchannel or no final
 *   within 1,500 ms resumes the reply where it paused, and a reply whose synthesis completed during the pause ends
 *   after the resume; a final with words that comes after the resume, while the reply plays, cuts it and becomes the
 *   user's turn, and speech that starts after the resume pauses the reply again and resumes it on its own final.
 *   SoftFade cancels at cancelMs before any final, and a stop during a pause leaves no timer behind.
 *   falseInterruptionMs sets how long a pause waits for the final, from the end of speech: a final with words within
 *   it cuts the reply though the handler answers it late, and the constructor refuses one that is not a finite number
 *   of zero or more
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { VoicePipelineOrchestrator } from '../VoicePipelineOrchestrator.js';
import { HeuristicEndpointDetector } from '../HeuristicEndpointDetector.js';
import { HardCutBargeinHandler } from '../HardCutBargeinHandler.js';
import { SoftFadeBargeinHandler } from '../SoftFadeBargeinHandler.js';
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

  it('asks a transport that has readyForPlayback() to get ready as the session starts, and starts though that fails', async () => {
    const readyForPlayback = vi.fn().mockRejectedValue(new Error('track not published'));
    (transport as any).readyForPlayback = readyForPlayback;
    await startSession();
    expect(readyForPlayback).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(orchestrator.state).toBe('listening');
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

  it('stays SPEAKING after flush_complete until a transport that reports its playout has played the reply out, and ends a reply whose wait fails', async () => {
    let played!: () => void;
    let failed!: (error: Error) => void;
    (transport as any).waitForPlayout = vi
      .fn()
      .mockReturnValueOnce(new Promise<void>((resolve) => { played = resolve; }))
      .mockReturnValueOnce(new Promise<void>((_resolve, reject) => { failed = reject; }));
    await startSession();
    endpoint.emit('turn_complete', makeTurnComplete());
    await vi.advanceTimersByTimeAsync(0);

    ttsSession.emit('flush_complete');
    await vi.advanceTimersByTimeAsync(0);
    expect(orchestrator.state).toBe('speaking');
    expect(transport.sendControl).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_done' }));
    played();
    await vi.advanceTimersByTimeAsync(0);
    expect(orchestrator.state).toBe('listening');
    expect(transport.sendControl).toHaveBeenLastCalledWith({ type: 'agent_done', text: 'Hello world', durationMs: 0 });

    // A wait that rejects ends the reply as one that resolves: the transport can no longer say when its audio stops.
    endpoint.emit('turn_complete', makeTurnComplete());
    await vi.advanceTimersByTimeAsync(0);
    ttsSession.emit('flush_complete');
    failed(new Error('track closed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(orchestrator.state).toBe('listening');
    expect(transport.sendControl).toHaveBeenCalledTimes(6); // agent_thinking, agent_speaking and agent_done, twice
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
    expect(endpoint.reset).toHaveBeenCalledWith('session'); // as the session started
    vi.mocked(endpoint.reset).mockClear();
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

  /**
   * A transport can refuse a send with any value, and String() throws for some: an object without a prototype, and a
   * revoked proxy, whose prototype cannot even be read. The refusal is still reported, as an Error that names the
   * value's type, and so is an 'error' listener that throws such a value; neither becomes an unhandled rejection.
   */
  it.each([
    ['an object without a prototype', (): unknown => Object.create(null)],
    [
      'a revoked proxy',
      (): unknown => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return proxy;
      },
    ],
  ])('reports a send refused with %s, and an error listener that throws one, leaving nothing unhandled', async (_kind, unprintable) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      vi.mocked(transport.sendControl).mockRejectedValueOnce(unprintable());
      await startSession();
      const seen: Error[] = [];
      orchestrator.on('error', () => {
        throw unprintable();
      });
      orchestrator.on('error', (err: Error) => seen.push(err));

      sttSession.emit('transcript', { text: 'hello', confidence: 0.9, words: [], isFinal: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(seen).toHaveLength(1);
      expect(seen[0]).toBeInstanceOf(Error);
      expect(seen[0].message).toBe('an unprintable object');
      expect(warn.mock.calls.map((args) => args.join(' '))).toEqual([
        expect.stringMatching(/an unprintable object.*an 'error' listener failed: an unprintable object/),
      ]);
      expect(orchestrator.state).toBe('listening');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      warn.mockRestore();
    }
  });

  // --------------------------------------------------------------------------
  // Client transcripts: a client that transcribes on its own device
  // --------------------------------------------------------------------------

  /** Records the endpoint detector's calls, in order, as one log. */
  function logDetector(): string[] {
    const log: string[] = [];
    vi.mocked(endpoint.pushVadEvent).mockImplementation((event) => {
      log.push(`vad ${event.type}`);
    });
    vi.mocked(endpoint.pushTranscript).mockImplementation((event) => {
      log.push(`${event.isFinal ? 'final' : 'interim'} ${event.text}`);
    });
    vi.mocked(endpoint.reset).mockImplementation(() => {
      log.push('reset');
    });
    return log;
  }

  /** A client transcript message, as a transport delivers it. */
  function clientTranscript(itemId: string, text: string, isFinal: boolean, extra: Record<string, unknown> = {}) {
    return { type: 'transcript', text, itemId, isFinal, ...extra };
  }

  it('should hand client transcripts to the endpoint detector between a speech start and a speech end', async () => {
    await startSession();
    const log = logDetector();
    transport.emit('message', clientTranscript('7', 'Hello', false, { startMs: 0, endMs: 400, language: 'en' }));
    transport.emit(
      'message',
      clientTranscript('7', 'Hello there.', true, { confidence: 0.8, startMs: 0, endMs: 900, language: 'en' })
    );
    transport.emit('message', clientTranscript('8', 'Bye.', true));
    await vi.advanceTimersByTimeAsync(0);

    // The mock detector completes no turn, so line 8's final carries the turn's
    // finals so far: the detector keeps one final per turn.
    expect(log).toEqual([
      'vad speech_start',
      'interim Hello',
      'final Hello there.',
      'vad speech_end',
      'vad speech_start',
      'final Hello there. Bye.',
      'vad speech_end',
    ]);
    expect(endpoint.pushVadEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'speech_start', source: 'stt' }),
    );
    // A final carries the turn's text so far, not one line's, so it reaches the detector
    // without the line's itemId.
    expect(endpoint.pushTranscript).toHaveBeenCalledWith({
      text: 'Hello there.',
      confidence: 0.8,
      words: [],
      isFinal: true,
      durationMs: 900,
      startMs: 0,
      endMs: 900,
      language: 'en',
    });
    expect(transport.sendControl).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'transcript' }));
  });

  it("should keep speech open while any client line is open, each final joined with the turn's earlier ones", async () => {
    await startSession();
    const log = logDetector();
    transport.emit('message', clientTranscript('1', 'one', false));
    transport.emit('message', clientTranscript('2', 'two', false));
    transport.emit('message', clientTranscript('1', 'one.', true));
    transport.emit('message', clientTranscript('2', 'two.', true));
    await vi.advanceTimersByTimeAsync(0);

    expect(log).toEqual([
      'vad speech_start',
      'interim one',
      'interim two',
      'final one.',
      'final one. two.',
      'vad speech_end',
    ]);
  });

  it("should take a client's first line while the agent speaks as barge-in, before the line's text", async () => {
    await startSession();
    endpoint.emit('turn_complete', makeTurnComplete());
    await vi.advanceTimersByTimeAsync(0);
    expect(orchestrator.state).toBe('speaking');
    const log = logDetector();

    transport.emit('message', clientTranscript('9', 'Wait', false));
    await vi.advanceTimersByTimeAsync(0);

    expect(ttsSession.cancel).toHaveBeenCalled();
    expect(agentSession.abort).toHaveBeenCalled();
    expect(transport.sendControl).toHaveBeenCalledWith(expect.objectContaining({ type: 'barge_in' }));
    expect(orchestrator.state).toBe('listening');
    expect(log).toEqual(['vad speech_start', 'reset', 'interim Wait']);
  });

  it('should close a client line on an empty final without its text, and ignore an empty line that never opened', async () => {
    await startSession();
    const log = logDetector();
    transport.emit('message', clientTranscript('3', 'Um', false));
    transport.emit('message', clientTranscript('3', '', true));
    transport.emit('message', clientTranscript('4', '', true));
    transport.emit('message', clientTranscript('5', ' ', false));
    await vi.advanceTimersByTimeAsync(0);

    expect(log).toEqual(['vad speech_start', 'interim Um', 'vad speech_end']);
  });

  it('should ignore malformed and other client messages, and client transcripts once closed', async () => {
    await startSession();
    const log = logDetector();
    transport.emit('message', { type: 'transcript', text: 42, itemId: '6', isFinal: true });
    transport.emit('message', { type: 'transcript', text: 'No id.', isFinal: true });
    transport.emit('message', { type: 'control', action: { type: 'mute' } });
    transport.emit('close');
    transport.emit('message', clientTranscript('6', 'Too late.', true));
    await vi.advanceTimersByTimeAsync(0);

    // The close resets the detector, as every stop does; no client message reaches it.
    expect(log).toEqual(['reset']);
  });

  it('should close a client line that gets no message for five seconds, so a later line still starts and ends speech', async () => {
    await startSession();
    const log = logDetector();
    // Line 41's final never comes: the device session that made it failed.
    transport.emit('message', clientTranscript('41', 'Turn the', false));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(log).toEqual(['vad speech_start', 'interim Turn the']);

    await vi.advanceTimersByTimeAsync(1);
    transport.emit('message', clientTranscript('57', 'Lights on.', false));
    transport.emit('message', clientTranscript('57', 'Lights on.', true));
    await vi.advanceTimersByTimeAsync(0);

    expect(log).toEqual([
      'vad speech_start',
      'interim Turn the',
      'vad speech_end',
      'vad speech_start',
      'interim Lights on.',
      'final Lights on.',
      'vad speech_end',
    ]);
  });

  it('should hold at most eight client lines open, and stop a turn at 16,000 characters', async () => {
    await startSession();
    const log = logDetector();
    // Nine lines open, so the first gives way; the other eight close with long finals.
    for (let i = 1; i <= 9; i++) transport.emit('message', clientTranscript(String(i), 'open', false));
    for (let i = 2; i <= 9; i++) transport.emit('message', clientTranscript(String(i), 'x'.repeat(4_000), true));
    await vi.advanceTimersByTimeAsync(0);

    expect(log.filter((entry) => entry.startsWith('vad'))).toEqual(['vad speech_start', 'vad speech_end']);
    const finals = vi
      .mocked(endpoint.pushTranscript)
      .mock.calls.map(([event]) => event)
      .filter((event) => event.isFinal);
    expect(finals.map((event) => event.text.length)).toEqual([
      4_000, 8_001, 12_002, 16_000, 16_000, 16_000, 16_000, 16_000,
    ]);
  });

  it.each(['stopSession()', 'a transport close'] as const)(
    "should clear every open client line's timer on %s, so none fires after the session",
    async (stop) => {
      await startSession();
      transport.emit('message', clientTranscript('1', 'one', false));
      transport.emit('message', clientTranscript('2', 'two', false));
      await vi.advanceTimersByTimeAsync(0);
      // The watchdog's timer, and one timer for each open line.
      expect(vi.getTimerCount()).toBe(3);

      if (stop === 'stopSession()') await orchestrator.stopSession('done');
      else transport.emit('close');

      expect(orchestrator.state).toBe('closed');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  /**
   * A session takes speech from one source, the first it receives: the transport's audio, which its STT session
   * transcribes, or a client's transcript messages. With both, the endpoint detector would get two sets of speech
   * edges and finals, and a client's final would replace the finals the STT session's transcripts hold. What arrives
   * from the other source is dropped, and the first drop is reported.
   */
  it("should drop a client's transcripts in a session that received audio first, and report the drop once", async () => {
    await startSession();
    const errors: Error[] = [];
    orchestrator.on('error', (err: Error) => errors.push(err));
    const log = logDetector();

    transport.emit('audio', makeFrame());
    transport.emit('message', clientTranscript('1', 'Hello there.', true));
    transport.emit('message', clientTranscript('2', 'Bye.', true));
    transport.emit('audio', makeFrame());
    await vi.advanceTimersByTimeAsync(0);

    expect(sttSession.pushAudio).toHaveBeenCalledTimes(2);
    expect(log).toEqual([]); // no client line reached the detector
    expect(errors.map((err) => err.message)).toEqual([expect.stringMatching(/^a client transcript was dropped/)]);
    expect(orchestrator.state).toBe('listening');
  });

  it('should drop audio in a session that received a client transcript first, and report the drop once', async () => {
    await startSession();
    const errors: Error[] = [];
    orchestrator.on('error', (err: Error) => errors.push(err));
    const log = logDetector();

    transport.emit('message', clientTranscript('1', 'Hello there.', true));
    transport.emit('audio', makeFrame());
    transport.emit('audio', makeFrame());
    transport.emit('message', clientTranscript('2', 'Bye.', true));
    await vi.advanceTimersByTimeAsync(0);

    expect(sttSession.pushAudio).not.toHaveBeenCalled();
    expect(log).toEqual([
      'vad speech_start',
      'final Hello there.',
      'vad speech_end',
      'vad speech_start',
      'final Hello there. Bye.',
      'vad speech_end',
    ]);
    expect(errors.map((err) => err.message)).toEqual([expect.stringMatching(/^audio was dropped/)]);
    expect(orchestrator.state).toBe('listening');
  });

  /**
   * A host can hand one endpoint detector to one session after another. After a turn in which speech started, the
   * heuristic detector drops the late final of that turn until speech ends again; the next session's STT session
   * sends no final of the earlier session's turns, so its first final, which comes before its end of speech as one
   * does under client commits, is an ordinary final of its own turn.
   */
  it("should hand a session's first final to its agent when an earlier session's last turn on the same detector had speech", async () => {
    const detector = new HeuristicEndpointDetector();
    const late = vi.fn();
    detector.on('late_final', late);
    const start = async (stt: ReturnType<typeof createMockSTTSession>, agent: IVoicePipelineAgentSession) => {
      const pipeline = new VoicePipelineOrchestrator(makeConfig());
      await pipeline.startSession(createMockTransport(), agent, {
        streamingSTT: createMockSTT(stt),
        streamingTTS: createMockTTS(createMockTTSSession()),
        endpointDetector: detector,
        bargeinHandler: createMockBargeinHandler(),
      });
      return pipeline;
    };

    const firstStt = createMockSTTSession();
    const firstAgent = createMockAgentSession();
    const first = await start(firstStt, firstAgent);
    firstStt.emit('speech_start');
    firstStt.emit('speech_end');
    firstStt.emit('transcript', { text: 'Book a table for two.', confidence: 0.9, words: [], isFinal: true, itemId: 'item_A' });
    await vi.advanceTimersByTimeAsync(0);
    expect(firstAgent.sendText).toHaveBeenCalledWith('Book a table for two.', expect.objectContaining({ endpointReason: 'punctuation' }));
    await first.stopSession();

    const secondStt = createMockSTTSession();
    const secondAgent = createMockAgentSession();
    const second = await start(secondStt, secondAgent);
    secondStt.emit('transcript', { text: 'What about Friday?', confidence: 0.9, words: [], isFinal: true, itemId: 'item_B' });
    secondStt.emit('speech_end');
    await vi.advanceTimersByTimeAsync(0);

    expect(late).not.toHaveBeenCalled();
    expect(secondAgent.sendText).toHaveBeenCalledWith('What about Friday?', expect.objectContaining({ endpointReason: 'punctuation' }));
    await second.stopSession();
  });

  /**
   * A host can hand one endpoint detector to one session after another. Each session removes the listeners it added
   * to the detector when it stops, by `stopSession()` or by its transport closing, and when its start fails, so no
   * closed session stays reachable from the detector and the detector's listeners do not pile up past Node's limit.
   */
  it('should remove the listeners it added to a detector the host hands to one session after another', async () => {
    const detector = new HeuristicEndpointDetector();
    const hostTurns = vi.fn();
    detector.on('turn_complete', hostTurns);
    const counts = () =>
      Object.fromEntries(
        ['turn_complete', 'error', 'backchannel_detected', 'late_final'].map((event) => [event, detector.listenerCount(event)]),
      );
    const before = counts();
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', onWarning);
    try {
      for (let session = 0; session < 5; session++) {
        const sessionTransport = createMockTransport();
        const pipeline = new VoicePipelineOrchestrator(makeConfig());
        await pipeline.startSession(sessionTransport, createMockAgentSession(), {
          streamingSTT: createMockSTT(createMockSTTSession()),
          streamingTTS: createMockTTS(createMockTTSSession()),
          endpointDetector: detector,
          bargeinHandler: createMockBargeinHandler(),
        });
        // A session stops by the host's call or by its transport closing.
        if (session % 2 === 0) await pipeline.stopSession();
        else sessionTransport.emit('close');
        expect(pipeline.state).toBe('closed');
      }
      const failing = new VoicePipelineOrchestrator(makeConfig());
      await expect(
        failing.startSession(createMockTransport(), createMockAgentSession(), {
          streamingSTT: { providerId: 'mock-stt', isStreaming: false, startSession: vi.fn().mockRejectedValue(new Error('no connection')) },
          streamingTTS: createMockTTS(createMockTTSSession()),
          endpointDetector: detector,
          bargeinHandler: createMockBargeinHandler(),
        }),
      ).rejects.toThrow('no connection');
      // Node hands a listener-limit warning to process 'warning' on the next tick.
      await new Promise<void>((resolve) => process.nextTick(resolve));

      expect(counts()).toEqual(before);
      expect(detector.listeners('turn_complete')).toEqual([hostTurns]);
      expect(warnings.map((warning) => warning.name)).not.toContain('MaxListenersExceededWarning');
    } finally {
      process.off('warning', onWarning);
    }
  });

  // --------------------------------------------------------------------------
  // Backchannels: the HeuristicEndpointDetector, told what the agent is doing
  // --------------------------------------------------------------------------

  /**
   * Starts a session on a real HeuristicEndpointDetector, with an agent that answers every turn with `reply` and a
   * barge-in handler that lets a reply go on while the user speaks. Gives the texts the agent is handed and the
   * backchannels the detector reports.
   */
  async function startWithDetector(reply: string) {
    const detector = new HeuristicEndpointDetector();
    const backchannels: string[] = [];
    detector.on('backchannel_detected', (event: { text: string }) => backchannels.push(event.text));
    agentSession = createMockAgentSession([reply]);
    await orchestrator.startSession(transport, agentSession, {
      streamingSTT: createMockSTT(sttSession),
      streamingTTS: createMockTTS(ttsSession),
      endpointDetector: detector,
      bargeinHandler: createMockBargeinHandler({ type: 'ignore' }),
    });
    const turns = (): string[] => vi.mocked(agentSession.sendText).mock.calls.map(([text]) => text);
    return { detector, backchannels, turns };
  }

  /**
   * The user says `text`, as the STT session reports it: a start of speech, then the final and the end of speech, the
   * end first for a final keyed by an item (OpenAI Realtime sends an utterance's final after its end of speech).
   */
  async function say(text: string, itemId?: string): Promise<void> {
    const final = { text, confidence: 0.9, words: [], isFinal: true, ...(itemId ? { itemId } : {}) };
    sttSession.emit('speech_start');
    if (itemId) {
      sttSession.emit('speech_end');
      sttSession.emit('transcript', final);
    } else {
      sttSession.emit('transcript', final);
      sttSession.emit('speech_end');
    }
    await vi.advanceTimersByTimeAsync(0);
  }

  it('should drop an item-keyed backchannel said while the agent speaks, whatever its trailing punctuation', async () => {
    const { detector, backchannels, turns } = await startWithDetector('It is booked.');
    const detectorTurns = vi.fn();
    detector.on('turn_complete', detectorTurns);
    await say('Book a table for two.');
    expect(orchestrator.state).toBe('speaking');

    await say('Uh huh.', 'item_A');
    ttsSession.emit('flush_complete');
    await vi.advanceTimersByTimeAsync(1_500);

    expect(backchannels).toEqual(['Uh huh.']);
    expect(detectorTurns).toHaveBeenCalledOnce(); // the first turn: none ended on the backchannel
    expect(turns()).toEqual(['Book a table for two.']);
  });

  it("should drop a backchannel said while the agent speaks, though the agent's last reply asked a question", async () => {
    const { backchannels, turns } = await startWithDetector('Shall I book it?');
    await say('Book a table for two.');
    ttsSession.emit('flush_complete');
    await say('Yes, for seven.');
    expect(orchestrator.state).toBe('speaking');

    await say('Sure.');
    ttsSession.emit('flush_complete');
    await vi.advanceTimersByTimeAsync(1_500);

    expect(backchannels).toEqual(['Sure.']);
    expect(turns()).toEqual(['Book a table for two.', 'Yes, for seven.']);
  });

  it("should drop a lone 'yeah' said after the user's turn completes and before the reply has a word, though the agent's last reply asked a question", async () => {
    const { backchannels, turns } = await startWithDetector('Shall I book it?');
    await say('Book a table for two.');
    ttsSession.emit('flush_complete');
    // The agent thinks before the first word of its next reply.
    let speak = (): void => {};
    const thinking = new Promise<void>((resolve) => {
      speak = resolve;
    });
    vi.mocked(agentSession.sendText).mockReturnValueOnce({
      [Symbol.asyncIterator]: async function* () {
        await thinking;
        yield 'It is booked.';
      },
    });
    await say('Yes, for seven.');

    // The floor is the agent's from the moment the user's turn completes.
    await say('yeah');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(backchannels).toEqual(['yeah']);

    speak();
    await vi.advanceTimersByTimeAsync(0);
    ttsSession.emit('flush_complete');
    expect(turns()).toEqual(['Book a table for two.', 'Yes, for seven.']);
  });

  it("should hand the agent a lone 'yeah' that answers a reply ending in a question", async () => {
    const { backchannels, turns } = await startWithDetector('Shall I book it?');
    await say('Book a table for two.');
    ttsSession.emit('flush_complete');

    await say('yeah');
    // No terminal punctuation: the silence timeout ends the turn.
    await vi.advanceTimersByTimeAsync(1_500);

    expect(turns()).toEqual(['Book a table for two.', 'yeah']);
    expect(backchannels).toEqual([]);
  });

  /**
   * A backchannel is a response made while the other party holds the floor. Once the agent's reply has ended the user
   * holds it, so a lone "okay" after a statement is the user's turn, a minimal one: what to answer is the agent's call.
   */
  it.each([
    { said: 'okay', itemId: undefined },
    { said: 'Uh huh.', itemId: 'item_A' },
  ])('should hand the agent a lone $said said while it listens after a statement', async ({ said, itemId }) => {
    const { backchannels, turns } = await startWithDetector('It is booked.');
    await say('Book a table for two.');
    ttsSession.emit('flush_complete');

    await say(said, itemId);
    // "okay" has no terminal punctuation: the silence timeout ends its turn.
    await vi.advanceTimersByTimeAsync(1_500);

    expect(turns()).toEqual(['Book a table for two.', said]);
    expect(backchannels).toEqual([]);
  });

  it("should hand the agent a lone 'Right?' after a reply that asked no question: a question mark is never a backchannel", async () => {
    const { backchannels, turns } = await startWithDetector('It is booked.');
    await say('Book a table for two.');
    ttsSession.emit('flush_complete');

    await say('Right?');

    expect(turns()).toEqual(['Book a table for two.', 'Right?']);
    expect(backchannels).toEqual([]);
  });

  it("should read a backchannel by the agent's context from the session's first utterance", async () => {
    const { backchannels, turns } = await startWithDetector('It is booked.');

    // The session tells the detector the agent listens as it starts: a lone "sure" is the user's turn, which a
    // detector told nothing would drop by its exact phrase.
    await say('sure');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(backchannels).toEqual([]);
    expect(turns()).toEqual(['sure']);
  });

  it.each([
    { after: 'a statement', reply: 'It is booked.' },
    { after: 'a question', reply: 'Shall I book it?' },
  ])(
    "after $after, should hand the agent a client's lines 'I think we should', 'yeah' and 'go ahead' as one turn, its 'yeah' kept",
    async ({ reply }) => {
      const { backchannels, turns } = await startWithDetector(reply);
      transport.emit('message', clientTranscript('1', 'Book a table for two.', true));
      await vi.advanceTimersByTimeAsync(0);
      ttsSession.emit('flush_complete');

      // The agent listens: the user holds the floor, so a "yeah" in the user's own turn is words of that turn.
      transport.emit('message', clientTranscript('2', 'I think we should', true));
      transport.emit('message', clientTranscript('3', 'yeah', true));
      transport.emit('message', clientTranscript('4', 'go ahead', true));
      await vi.advanceTimersByTimeAsync(1_500);

      expect(turns()).toEqual(['Book a table for two.', 'I think we should yeah go ahead']);
      expect(backchannels).toEqual([]);
    },
  );

  it("should drop a client's lone 'uh huh' line said while the agent speaks, and leave the agent's turns as they were", async () => {
    const { backchannels, turns } = await startWithDetector('It is booked.');
    transport.emit('message', clientTranscript('1', 'Book a table for two.', true));
    await vi.advanceTimersByTimeAsync(0);
    expect(orchestrator.state).toBe('speaking');

    transport.emit('message', clientTranscript('2', 'uh huh', true));
    await vi.advanceTimersByTimeAsync(1_500);
    ttsSession.emit('flush_complete');

    expect(backchannels).toEqual(['uh huh']);
    expect(turns()).toEqual(['Book a table for two.']);
  });

  it('should join every client final for a detector without isBackchannel() or setAgentContext(), as before', async () => {
    await startSession(); // the mock detector has neither
    const log = logDetector();
    endpoint.emit('turn_complete', makeTurnComplete());
    await vi.advanceTimersByTimeAsync(0);
    ttsSession.emit('flush_complete');

    transport.emit('message', clientTranscript('2', 'I think we should', true));
    transport.emit('message', clientTranscript('3', 'yeah', true));
    transport.emit('message', clientTranscript('4', 'go ahead', true));
    await vi.advanceTimersByTimeAsync(0);

    expect(log).toEqual([
      'reset',
      'vad speech_start',
      'final I think we should',
      'vad speech_end',
      'vad speech_start',
      'final I think we should yeah',
      'vad speech_end',
      'vad speech_start',
      'final I think we should yeah go ahead',
      'vad speech_end',
    ]);
  });

  // --------------------------------------------------------------------------
  // Turns: a transcriber that sends each final before its end of speech
  // --------------------------------------------------------------------------

  /**
   * The user says `text` as DeepgramStreamingSTT reports it: a start of speech, then the final, keyed by an item and
   * marked `beforeSpeechEnd`, then the end of speech. Deepgram sends a segment's final before the end of speech of its
   * utterance (`speech_final`), the other order from OpenAI Realtime's.
   */
  async function sayFinalFirst(text: string, itemId: string): Promise<void> {
    sttSession.emit('speech_start');
    sttSession.emit('transcript', { text, confidence: 0.9, words: [], isFinal: true, itemId, beforeSpeechEnd: true });
    sttSession.emit('speech_end');
    await vi.advanceTimersByTimeAsync(0);
  }

  it('should hand the agent each turn of a transcriber that sends its keyed finals before their end of speech, as Deepgram does', async () => {
    const { detector, turns } = await startWithDetector('It is booked.');
    const late = vi.fn();
    detector.on('late_final', late);

    await sayFinalFirst('Book a table for two.', 'dg:1');
    ttsSession.emit('flush_complete');
    await sayFinalFirst('At seven tonight.', 'dg:2');

    expect(turns()).toEqual(['Book a table for two.', 'At seven tonight.']);
    expect(late).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Barge-in: the stock handlers, asked as the user's speech grows
  // --------------------------------------------------------------------------

  /** One 100 ms chunk of the reply's audio, named by its text. */
  function replyChunk(text: string): EncodedAudioChunk {
    return { audio: Buffer.from([0]), format: 'opus', sampleRate: 24000, durationMs: 100, text };
  }

  /**
   * A final transcript from the STT session, keyed by an item when `itemId` is given, and marked `beforeSpeechEnd` when
   * `beforeSpeechEnd` is, as DeepgramStreamingSTT marks the finals it sends before their end of speech.
   */
  function sttFinal(text: string, itemId?: string, beforeSpeechEnd = false) {
    return { text, confidence: 0.9, words: [], isFinal: true, ...(itemId ? { itemId } : {}), ...(beforeSpeechEnd ? { beforeSpeechEnd } : {}) };
  }

  /**
   * Starts a session on a real HeuristicEndpointDetector and `handler`, hands the agent the user's turn "Book a table
   * for two." and leaves it speaking its reply, "It is booked for two at seven.", whose first 100 ms chunk has been
   * sent. The user speaks through the STT session's events, or, with `client`, through a client's transcript lines.
   * Gives one log of the barge-in controls and the audio the transport was sent, the states the pipeline moves through
   * from here, the user turns the orchestrator re-emitted and the backchannels the detector reported. The fake timers
   * `beforeEach` installs fake `Date` too, the clock the orchestrator measures the user's speech with.
   */
  async function speakingWith(
    handler: IBargeinHandler,
    { config = {}, client = false }: { config?: Partial<VoicePipelineConfig>; client?: boolean } = {},
  ) {
    const detector = new HeuristicEndpointDetector();
    const backchannels: string[] = [];
    detector.on('backchannel_detected', (event: { text: string }) => backchannels.push(event.text));
    const sent: string[] = [];
    vi.mocked(transport.sendAudio).mockImplementation(async (chunk) => {
      sent.push(`audio ${chunk.text}`);
    });
    vi.mocked(transport.sendControl).mockImplementation(async (message) => {
      if (message.type === 'barge_in') sent.push(`barge_in ${message.action.type}`);
    });
    orchestrator = new VoicePipelineOrchestrator(makeConfig(config));
    agentSession = createMockAgentSession(['It is booked for two at seven.']);
    await orchestrator.startSession(transport, agentSession, {
      streamingSTT: createMockSTT(sttSession),
      streamingTTS: createMockTTS(ttsSession),
      endpointDetector: detector,
      bargeinHandler: handler,
    });
    const turns: string[] = [];
    orchestrator.on('turn_complete', (event: TurnCompleteEvent) => turns.push(event.transcript));
    if (client) {
      transport.emit('message', clientTranscript('1', 'Book a table for two.', true));
    } else {
      sttSession.emit('speech_start');
      sttSession.emit('transcript', sttFinal('Book a table for two.'));
      sttSession.emit('speech_end');
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(orchestrator.state).toBe('speaking');
    ttsSession.emit('audio', replyChunk('one'));
    const states: string[] = [];
    orchestrator.on('state_changed', (change: { to: string }) => states.push(change.to));
    return { sent, states, turns, backchannels };
  }

  it('cancels the reply once the user has spoken over it for minSpeechMs, asking a stock HardCutBargeinHandler as the speech grows', async () => {
    const handler = new HardCutBargeinHandler();
    const asked = vi.spyOn(handler, 'handleBargein');
    const { sent, states, turns } = await speakingWith(handler);

    sttSession.emit('speech_start');
    await vi.advanceTimersByTimeAsync(299);
    expect(ttsSession.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(201); // 500 ms of speech
    sttSession.emit('transcript', sttFinal('Make it three.'));
    sttSession.emit('speech_end');
    await vi.advanceTimersByTimeAsync(0);

    // Asked at the start and every 100 ms as the speech grew, each time with the speech so far, the reply's text and
    // the audio sent, until the handler cancelled at its 300 ms.
    expect(asked.mock.calls.map(([context]) => context)).toEqual(
      [0, 100, 200, 300].map((speechDurationMs) => ({
        speechDurationMs,
        interruptedText: 'It is booked for two at seven.',
        playedDurationMs: 100,
      })),
    );
    expect(transport.sendControl).toHaveBeenCalledWith({ type: 'barge_in', action: { type: 'cancel', injectMarker: '[interrupted]' } });
    expect(ttsSession.cancel).toHaveBeenCalledOnce();
    expect(agentSession.abort).toHaveBeenCalledOnce();
    expect(states.slice(0, 2)).toEqual(['interrupting', 'listening']);
    expect(sent).toEqual(['audio one', 'barge_in cancel']);
    // What the user said after the cancel is the user's turn.
    expect(turns).toEqual(['Book a table for two.', 'Make it three.']);
  });

  it('lets the reply go on when the user speaks over it for less than minSpeechMs', async () => {
    const { sent, states } = await speakingWith(new HardCutBargeinHandler());

    sttSession.emit('speech_start');
    await vi.advanceTimersByTimeAsync(100);
    ttsSession.emit('audio', replyChunk('two'));
    await vi.advanceTimersByTimeAsync(50);
    sttSession.emit('speech_end'); // 150 ms of speech
    await vi.advanceTimersByTimeAsync(0);
    ttsSession.emit('audio', replyChunk('three'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sent).toEqual(['audio one', 'audio two', 'audio three']);
    expect(ttsSession.cancel).not.toHaveBeenCalled();
    expect(states).toEqual([]);
  });

  it('holds the reply on a pause, and resumes it where it paused when the speech was a backchannel', async () => {
    const handler = new SoftFadeBargeinHandler();
    const asked = vi.spyOn(handler, 'handleBargein');
    const { sent, states, turns, backchannels } = await speakingWith(handler);

    sttSession.emit('speech_start');
    await vi.advanceTimersByTimeAsync(100); // the handler pauses at its 100 ms
    ttsSession.emit('audio', replyChunk('two'));
    await vi.advanceTimersByTimeAsync(300);
    ttsSession.emit('audio', replyChunk('three'));
    // The pause holds the audio that arrives: none of it is sent.
    expect(sent).toEqual(['audio one', 'barge_in pause']);

    sttSession.emit('transcript', sttFinal('uh huh'));
    sttSession.emit('speech_end'); // 400 ms of speech
    await vi.advanceTimersByTimeAsync(0);
    ttsSession.emit('audio', replyChunk('four'));

    expect(sent).toEqual(['audio one', 'barge_in pause', 'barge_in resume', 'audio two', 'audio three', 'audio four']);
    expect(transport.sendControl).toHaveBeenCalledWith({ type: 'barge_in', action: { type: 'pause', fadeMs: 200 } });
    expect(transport.sendControl).toHaveBeenCalledWith({ type: 'barge_in', action: { type: 'resume' } });
    // The audio held during the pause was not played when the speech ended.
    expect(asked.mock.lastCall?.[0]).toEqual({ speechDurationMs: 400, interruptedText: 'It is booked for two at seven.', playedDurationMs: 100 });
    expect(states).toEqual([]); // speaking throughout
    expect(backchannels).toEqual(['uh huh']);
    expect(turns).toEqual(['Book a table for two.']);
    ttsSession.emit('flush_complete');
    expect(transport.sendControl).toHaveBeenLastCalledWith({ type: 'agent_done', text: 'It is booked for two at seven.', durationMs: 400 });
  });

  it('reports and drops a chunk the transport cannot play while a pause holds the reply, and resumes with the chunks it can play', async () => {
    Object.defineProperty(transport, 'playbackFormat', { value: 'opus', configurable: true });
    const handler = new SoftFadeBargeinHandler();
    const { sent } = await speakingWith(handler);
    const errors: Error[] = [];
    orchestrator.on('error', (error: Error) => errors.push(error));

    sttSession.emit('speech_start');
    await vi.advanceTimersByTimeAsync(100); // the handler pauses at its 100 ms
    ttsSession.emit('audio', replyChunk('two'));
    ttsSession.emit('audio', { ...replyChunk('wrong'), format: 'mp3' });
    ttsSession.emit('audio', replyChunk('three'));
    // The pause holds what the transport can play; the chunk it cannot play is reported once and never held.
    expect(sent).toEqual(['audio one', 'barge_in pause']);
    expect(errors.map((error) => error.message)).toEqual(["the TTS provider 'mock-tts' sent mp3 audio, and the transport plays opus only"]);

    sttSession.emit('transcript', sttFinal('uh huh'));
    sttSession.emit('speech_end');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['audio one', 'barge_in pause', 'barge_in resume', 'audio two', 'audio three']);
  });

  it('resumes the reply held on a pause when no final comes within 1,500 ms of the end of speech', async () => {
    const { sent, states, turns } = await speakingWith(new SoftFadeBargeinHandler());

    sttSession.emit('speech_start');
    await vi.advanceTimersByTimeAsync(400);
    ttsSession.emit('audio', replyChunk('two'));
    sttSession.emit('speech_end'); // a sound with no words: no final comes
    await vi.advanceTimersByTimeAsync(1_499);
    expect(sent).toEqual(['audio one', 'barge_in pause']);

    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['audio one', 'barge_in pause', 'barge_in resume', 'audio two']);
    expect(states).toEqual([]);
    expect(turns).toEqual(['Book a table for two.']);
  });

  it('resumes the reply held on a pause after the falseInterruptionMs it is given when no final comes', async () => {
    const { sent } = await speakingWith(new SoftFadeBargeinHandler(), { config: { falseInterruptionMs: 500 } });

    sttSession.emit('speech_start');
    await vi.advanceTimersByTimeAsync(400);
    ttsSession.emit('audio', replyChunk('two'));
    sttSession.emit('speech_end');
    await vi.advanceTimersByTimeAsync(499);
    expect(sent).toEqual(['audio one', 'barge_in pause']);

    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['audio one', 'barge_in pause', 'barge_in resume', 'audio two']);
  });

  /** SoftFadeBargeinHandler's answers, each 10 ms after the ask, as a handler that awaits something answers. */
  function lateSoftFade(): IBargeinHandler {
    const softFade = new SoftFadeBargeinHandler();
    return {
      mode: 'soft-fade',
      handleBargein: (context) =>
        new Promise<BargeinAction>((resolve) => setTimeout(() => resolve(softFade.handleBargein(context)), 10)),
    };
  }

  it('counts the wait for the final from the end of speech, however long the handler takes to answer', async () => {
    const { sent } = await speakingWith(lateSoftFade());

    sttSession.emit('speech_start');
    await vi.advanceTimersByTimeAsync(400);
    sttSession.emit('speech_end'); // answered 20 ms later
    await vi.advanceTimersByTimeAsync(1_499);
    expect(sent).toEqual(['audio one', 'barge_in pause']);

    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['audio one', 'barge_in pause', 'barge_in resume']);
  });

  it('cuts the reply held on a pause when a final with words comes within falseInterruptionMs, though the handler answers late', async () => {
    const { sent, turns } = await speakingWith(lateSoftFade());

    sttSession.emit('speech_start');
    await vi.advanceTimersByTimeAsync(400);
    sttSession.emit('speech_end'); // the wait for its final ends 1,500 ms from now
    await vi.advanceTimersByTimeAsync(1_495);
    // The final's ask is still in flight when the wait ends.
    sttSession.emit('transcript', sttFinal('Make it three.'));
    await vi.advanceTimersByTimeAsync(20);

    expect(sent).toEqual(['audio one', 'barge_in pause', 'barge_in cancel']);
    expect(turns).toEqual(['Book a table for two.', 'Make it three.']);
  });

  it.each([
    { order: 'without an item', itemId: undefined },
    { order: 'keyed by an item', itemId: 'item_B' },
  ])(
    "cuts a reply that resumed when no final came within falseInterruptionMs, once the speech's final with words comes $order, and hands the words to the agent",
    async ({ itemId }) => {
      const { sent, states, turns } = await speakingWith(new SoftFadeBargeinHandler());

      sttSession.emit('speech_start');
      await vi.advanceTimersByTimeAsync(400);
      ttsSession.emit('audio', replyChunk('two')); // held by the pause
      sttSession.emit('speech_end');
      await vi.advanceTimersByTimeAsync(1_600); // no final within 1,500 ms: the reply resumes
      expect(sent).toEqual(['audio one', 'barge_in pause', 'barge_in resume', 'audio two']);

      // The final comes late, while the resumed reply plays.
      ttsSession.emit('audio', replyChunk('three'));
      sttSession.emit('transcript', sttFinal('No, Tuesday.', itemId));
      await vi.advanceTimersByTimeAsync(0);

      expect(sent).toEqual(['audio one', 'barge_in pause', 'barge_in resume', 'audio two', 'audio three', 'barge_in cancel']);
      expect(ttsSession.cancel).toHaveBeenCalledOnce();
      expect(agentSession.abort).toHaveBeenCalledOnce();
      expect(states.slice(0, 2)).toEqual(['interrupting', 'listening']);
      expect(turns).toEqual(['Book a table for two.', 'No, Tuesday.']);
      expect(agentSession.sendText).toHaveBeenLastCalledWith('No, Tuesday.', expect.objectContaining({ endpointReason: 'punctuation' }));
    },
  );

  it("pauses a resumed reply again when the user speaks again, and resumes it on that speech's own final", async () => {
    const { sent, states } = await speakingWith(new SoftFadeBargeinHandler());

    sttSession.emit('speech_start');
    await vi.advanceTimersByTimeAsync(400);
    sttSession.emit('speech_end'); // a sound with no words: no final comes
    await vi.advanceTimersByTimeAsync(1_600); // the reply resumes, and listens on for that final
    expect(sent).toEqual(['audio one', 'barge_in pause', 'barge_in resume']);

    sttSession.emit('speech_start'); // the user speaks again
    await vi.advanceTimersByTimeAsync(100);
    ttsSession.emit('audio', replyChunk('two')); // held by the new pause
    expect(sent).toEqual(['audio one', 'barge_in pause', 'barge_in resume', 'barge_in pause']);

    sttSession.emit('transcript', sttFinal('uh huh'));
    sttSession.emit('speech_end');
    await vi.advanceTimersByTimeAsync(0);
    // The backchannel is this speech's final: the reply resumes at once, without waiting for the first sound's.
    expect(sent).toEqual(['audio one', 'barge_in pause', 'barge_in resume', 'barge_in pause', 'barge_in resume', 'audio two']);
    expect(states).toEqual([]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('refuses a falseInterruptionMs of %s', (falseInterruptionMs) => {
    expect(() => new VoicePipelineOrchestrator(makeConfig({ falseInterruptionMs }))).toThrow(RangeError);
  });

  it.each([
    { order: 'before its end of speech', text: 'wait, change that to three', itemId: undefined, finalFirst: true },
    { order: 'before its end of speech, punctuated', text: 'Wait, change that to three.', itemId: undefined, finalFirst: true },
    { order: 'before its end of speech, keyed by an item', text: 'wait, change that to three', itemId: 'item_B', finalFirst: true },
    { order: 'after its end of speech, keyed by an item', text: 'wait, change that to three', itemId: 'item_B', finalFirst: false },
  ])(
    "cancels the reply held on a pause when the speech had words, its final $order, and hands them to the agent as the user's turn",
    async ({ text, itemId, finalFirst }) => {
      const { sent, states, turns } = await speakingWith(new SoftFadeBargeinHandler());

      sttSession.emit('speech_start');
      await vi.advanceTimersByTimeAsync(900);
      ttsSession.emit('audio', replyChunk('two')); // held by the pause
      if (finalFirst) {
        // Deepgram sends a keyed final before the end of speech of its utterance, and marks it so.
        sttSession.emit('transcript', sttFinal(text, itemId, itemId !== undefined));
        sttSession.emit('speech_end');
      } else {
        // OpenAI Realtime sends an utterance's final after its end of speech.
        sttSession.emit('speech_end');
        sttSession.emit('transcript', sttFinal(text, itemId));
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(sent).toEqual(['audio one', 'barge_in pause', 'barge_in cancel']);
      expect(ttsSession.cancel).toHaveBeenCalledOnce();
      expect(agentSession.abort).toHaveBeenCalledOnce();
      expect(states.slice(0, 2)).toEqual(['interrupting', 'listening']);
      // Without terminal punctuation, the detector's silence timeout ends the user's turn.
      await vi.advanceTimersByTimeAsync(1_500);
      expect(turns).toEqual(['Book a table for two.', text]);
      expect(agentSession.sendText).toHaveBeenLastCalledWith(text, expect.objectContaining({ endpointReason: text.endsWith('.') ? 'punctuation' : 'silence_timeout' }));
      // The audio held by the pause was never sent.
      expect(sent).toEqual(['audio one', 'barge_in pause', 'barge_in cancel']);
    },
  );

  it('cancels the reply held on a pause once the speech reaches cancelMs, before its final', async () => {
    const { sent, states, turns } = await speakingWith(new SoftFadeBargeinHandler());

    sttSession.emit('speech_start');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sent).toEqual(['audio one', 'barge_in pause']);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['audio one', 'barge_in pause', 'barge_in cancel']);
    expect(transport.sendControl).toHaveBeenCalledWith({ type: 'barge_in', action: { type: 'cancel', injectMarker: '[interrupted]' } });
    expect(states).toEqual(['interrupting', 'listening']);

    await vi.advanceTimersByTimeAsync(500);
    sttSession.emit('transcript', sttFinal('No, I said a table for three.'));
    sttSession.emit('speech_end'); // 2,500 ms of speech
    await vi.advanceTimersByTimeAsync(0);
    expect(turns).toEqual(['Book a table for two.', 'No, I said a table for three.']);
  });

  it('ends a reply whose synthesis completed during a pause after the resume has sent its held audio', async () => {
    const { sent, states } = await speakingWith(new SoftFadeBargeinHandler());

    sttSession.emit('speech_start');
    await vi.advanceTimersByTimeAsync(200);
    ttsSession.emit('audio', replyChunk('two'));
    ttsSession.emit('flush_complete'); // the last of the reply's audio is held by the pause
    expect(orchestrator.state).toBe('speaking');

    sttSession.emit('transcript', sttFinal('Mm hmm.'));
    sttSession.emit('speech_end');
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toEqual(['audio one', 'barge_in pause', 'barge_in resume', 'audio two']);
    expect(states).toEqual(['listening']);
    expect(transport.sendControl).toHaveBeenLastCalledWith({ type: 'agent_done', text: 'It is booked for two at seven.', durationMs: 200 });
  });

  it("measures a client's line said over the reply, and hands its words to the agent when they cancel the reply", async () => {
    const { sent, turns } = await speakingWith(new SoftFadeBargeinHandler(), { client: true });

    transport.emit('message', clientTranscript('9', 'wait', false));
    await vi.advanceTimersByTimeAsync(600);
    ttsSession.emit('audio', replyChunk('two')); // held by the pause
    transport.emit('message', clientTranscript('9', 'Wait, change that to three.', true));
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toEqual(['audio one', 'barge_in pause', 'barge_in cancel']);
    expect(turns).toEqual(['Book a table for two.', 'Wait, change that to three.']);
  });

  it.each(['stopSession()', 'a transport close'] as const)(
    'leaves no timer of a pause behind on %s, and sends nothing after it',
    async (stop) => {
      const { sent } = await speakingWith(new SoftFadeBargeinHandler());
      sttSession.emit('speech_start');
      await vi.advanceTimersByTimeAsync(400);
      ttsSession.emit('audio', replyChunk('two'));
      sttSession.emit('speech_end'); // the pause waits for the speech's final
      await vi.advanceTimersByTimeAsync(0);

      if (stop === 'stopSession()') await orchestrator.stopSession('done');
      else transport.emit('close');

      expect(orchestrator.state).toBe('closed');
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sent).toEqual(['audio one', 'barge_in pause']);
    },
  );
});
