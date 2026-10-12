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
    await expect(turn).resolves.toMatchObject({ transcript: 'hello there' });
  });
});
