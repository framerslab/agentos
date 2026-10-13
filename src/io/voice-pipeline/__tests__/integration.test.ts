/**
 * @module voice-pipeline/__tests__/integration.spec
 *
 * Full conversational loop integration test for the voice pipeline.
 *
 * Uses real {@link HeuristicEndpointDetector} and {@link HardCutBargeinHandler}
 * wired into the {@link VoicePipelineOrchestrator}. STT, TTS, and the agent
 * session are mocked so no real API calls are made.
 *
 * ## Scenario coverage
 *
 * 1. **Full conversational turn**: LISTENING -> PROCESSING -> SPEAKING -> LISTENING
 *    Verifies the complete happy-path loop including audio forwarding, agent
 *    invocation, TTS token piping, and state restoration.
 *
 * 2. **Barge-in with HardCutBargeinHandler threshold logic**:
 *    - 2a: Speech below minSpeechMs is ignored (TTS continues).
 *    - 2b: Speech at/above minSpeechMs cancels TTS and aborts agent.
 *
 * 3. **Transport disconnect**: Verifies that a WebSocket close event
 *    collapses the pipeline to CLOSED and tears down all sub-sessions.
 *
 * 4. **Multiple sequential turns**: Verifies that the endpoint detector
 *    resets between turns and the agent can handle consecutive interactions.
 *
 * 5. **A client's transcript lines**: a client that transcribes on its own
 *    device sends its lines as `transcript` messages, and the lines of one
 *    turn reach the agent together, whether they are open at once (5a) or the
 *    next opens inside the detector's silence timeout (5b).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

import { VoicePipelineOrchestrator } from '../VoicePipelineOrchestrator.js';
import { HeuristicEndpointDetector } from '../HeuristicEndpointDetector.js';
import { HardCutBargeinHandler } from '../HardCutBargeinHandler.js';

import type {
  AudioFrame,
  EncodedAudioChunk,
  IStreamingSTT,
  IStreamingTTS,
  StreamingSTTSession,
  StreamingTTSSession,
  VoicePipelineConfig,
} from '../types.js';

// ============================================================================
// Mock factories
// ============================================================================

/**
 * Creates a minimal in-process transport mock that fulfils IStreamTransport.
 * Callers may emit `'audio'`, `'close'`, or `'message'` to drive the pipeline.
 */
function createMockTransport() {
  const t = new EventEmitter() as any;
  t.id = 'integration-test';
  t.state = 'open';
  t.sendAudio = vi.fn().mockResolvedValue(undefined);
  t.sendControl = vi.fn().mockResolvedValue(undefined);
  t.close = vi.fn().mockResolvedValue(undefined);
  return t;
}

/**
 * Creates a mock STT session EventEmitter.
 * Callers emit `'transcript'`, `'speech_start'`, or `'speech_end'` to drive state.
 */
function createMockSTTSession(): StreamingSTTSession & EventEmitter {
  const s = new EventEmitter() as any;
  s.pushAudio = vi.fn();
  s.flush = vi.fn().mockResolvedValue(undefined);
  s.close = vi.fn().mockResolvedValue(undefined);
  return s as StreamingSTTSession & EventEmitter;
}

/** Creates a mock STT factory that resolves with the given session. */
function createMockSTT(session: StreamingSTTSession): IStreamingSTT {
  return {
    providerId: 'mock-stt',
    isStreaming: false,
    startSession: vi.fn().mockResolvedValue(session),
  };
}

/**
 * Creates a mock TTS session EventEmitter.
 * Callers emit `'audio'` or `'flush_complete'` to drive state.
 */
function createMockTTSSession(): StreamingTTSSession & EventEmitter {
  const s = new EventEmitter() as any;
  s.pushTokens = vi.fn();
  s.flush = vi.fn().mockResolvedValue(undefined);
  s.cancel = vi.fn();
  s.close = vi.fn().mockResolvedValue(undefined);
  return s as StreamingTTSSession & EventEmitter;
}

/** Creates a mock TTS factory that resolves with the given session. */
function createMockTTS(session: StreamingTTSSession): IStreamingTTS {
  return {
    providerId: 'mock-tts',
    startSession: vi.fn().mockResolvedValue(session),
  };
}

/**
 * Creates a mock agent session. Each call to sendText returns a new async
 * generator yielding two tokens, supporting multiple sequential turns.
 */
function createMockAgentSession() {
  return {
    sendText: vi.fn().mockImplementation(() =>
      (async function* () {
        yield 'Hello ';
        yield 'back!';
      })(),
    ),
    abort: vi.fn(),
  };
}

/** Minimal pipeline config used throughout all integration tests. */
function makeConfig(overrides?: Partial<VoicePipelineConfig>): VoicePipelineConfig {
  return {
    stt: 'mock-stt',
    tts: 'mock-tts',
    maxTurnDurationMs: 30_000,
    ...overrides,
  };
}

/** Helper to build a minimal AudioFrame for transport injection. */
function makeAudioFrame(): AudioFrame {
  return {
    samples: new Float32Array([0.1, 0.2]),
    sampleRate: 16_000,
    timestamp: Date.now(),
  };
}

/** Helper to build a minimal EncodedAudioChunk for TTS emission. */
function makeAudioChunk(): EncodedAudioChunk {
  return {
    audio: Buffer.from([0xab]),
    format: 'opus',
    sampleRate: 24_000,
    durationMs: 120,
    text: 'Hello back!',
  };
}

// ============================================================================
// Integration test suite
// ============================================================================

describe('voice pipeline -- full conversational loop integration', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let sttSession: StreamingSTTSession & EventEmitter;
  let ttsSession: StreamingTTSSession & EventEmitter;
  let agentSession: ReturnType<typeof createMockAgentSession>;
  let orchestrator: VoicePipelineOrchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = createMockTransport();
    sttSession = createMockSTTSession();
    ttsSession = createMockTTSSession();
    agentSession = createMockAgentSession();
    orchestrator = new VoicePipelineOrchestrator(makeConfig());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Start the orchestrator with real HeuristicEndpointDetector and
   * real HardCutBargeinHandler. All other components are mocked.
   */
  async function startSession(
    detectorOptions?: ConstructorParameters<typeof HeuristicEndpointDetector>[0],
    bargeinOptions?: ConstructorParameters<typeof HardCutBargeinHandler>[0],
  ) {
    const endpointDetector = new HeuristicEndpointDetector(detectorOptions);
    const bargeinHandler = new HardCutBargeinHandler(bargeinOptions);

    const session = await orchestrator.startSession(transport, agentSession, {
      streamingSTT: createMockSTT(sttSession),
      streamingTTS: createMockTTS(ttsSession),
      endpointDetector,
      bargeinHandler,
    });

    return { session, endpointDetector, bargeinHandler };
  }

  /**
   * Drive a full conversational turn through the pipeline:
   * 1. Emit a final transcript with terminal punctuation.
   * 2. Emit speech_end so the HeuristicEndpointDetector fires turn_complete.
   * 3. Flush the async token loop (agent -> TTS).
   * 4. Emit flush_complete to finish TTS and return to LISTENING.
   */
  async function driveFullTurn(transcript = 'Hello.') {
    // Simulate STT producing a final transcript ending with terminal punctuation.
    sttSession.emit('transcript', {
      text: transcript,
      confidence: 0.93,
      words: [],
      isFinal: true,
    });

    // Simulate speech_end -- the heuristic detector will fire turn_complete
    // immediately because of the terminal punctuation (fast path).
    sttSession.emit('speech_end');

    // Yield control so the async turn_complete handler and token loop run.
    await vi.advanceTimersByTimeAsync(0);

    // Emit an audio chunk from TTS (wired through to transport).
    ttsSession.emit('audio', makeAudioChunk());

    // Emit flush_complete -> orchestrator transitions back to LISTENING.
    ttsSession.emit('flush_complete');
  }

  // ============================================================================
  // Scenario 1: Full conversational turn
  // ============================================================================

  it('scenario 1: full turn cycle (LISTENING -> PROCESSING -> SPEAKING -> LISTENING)', async () => {
    await startSession();

    // Verify initial state after session start
    expect(orchestrator.state).toBe('listening');

    // Simulate transport delivering an audio frame -> STT should receive it
    const frame = makeAudioFrame();
    transport.emit('audio', frame);
    expect((sttSession as any).pushAudio).toHaveBeenCalledWith(frame);

    // Collect state transitions for verification
    const states: string[] = [];
    orchestrator.on('state_changed', (evt: { from: string; to: string }) =>
      states.push(evt.to),
    );

    // Drive the full turn
    await driveFullTurn('Hello.');

    // Verify the expected state progression
    expect(states).toContain('processing');
    expect(states).toContain('speaking');
    expect(states).toContain('listening');

    // Agent session must have been called with the recognised transcript
    // and the correct endpoint reason ('punctuation' because of the period)
    expect(agentSession.sendText).toHaveBeenCalledWith(
      'Hello.',
      expect.objectContaining({ endpointReason: 'punctuation' }),
    );

    // TTS session must have received both token chunks from the agent
    expect((ttsSession as any).pushTokens).toHaveBeenCalledWith('Hello ');
    expect((ttsSession as any).pushTokens).toHaveBeenCalledWith('back!');

    // Transport must have received the TTS audio chunk
    expect(transport.sendAudio).toHaveBeenCalledWith(expect.objectContaining({ format: 'opus' }));

    // Final state: back to LISTENING, ready for next turn
    expect(orchestrator.state).toBe('listening');
  });

  // ============================================================================
  // Scenario 2: Barge-in interruption
  // ============================================================================

  /**
   * With minSpeechMs=300, the orchestrator passes speechDurationMs=0 (instant
   * detection), which is below the threshold. The handler returns 'ignore'
   * and TTS continues uninterrupted.
   */
  it('scenario 2a: barge-in below threshold is ignored (TTS continues)', async () => {
    await startSession({ silenceTimeoutMs: 500 }, { minSpeechMs: 300 });

    // Advance to SPEAKING state
    sttSession.emit('transcript', {
      text: 'Tell me a story.',
      confidence: 0.9,
      words: [],
      isFinal: true,
    });
    sttSession.emit('speech_end');
    await vi.advanceTimersByTimeAsync(0);

    expect(orchestrator.state).toBe('speaking');

    // Simulate speech_start during SPEAKING -- speechDurationMs: 0 < 300 ms -> 'ignore'
    sttSession.emit('speech_start');
    await vi.advanceTimersByTimeAsync(0);

    // TTS should NOT have been cancelled
    expect((ttsSession as any).cancel).not.toHaveBeenCalled();
    // State must remain SPEAKING
    expect(orchestrator.state).toBe('speaking');
  });

  /**
   * With minSpeechMs=0, ANY detection triggers cancel. The orchestrator passes
   * speechDurationMs=0 which equals the threshold, so the handler returns
   * 'cancel'. TTS is stopped, agent is aborted, state returns to LISTENING.
   */
  it('scenario 2b: barge-in at/above threshold cancels TTS and returns to LISTENING', async () => {
    await startSession({ silenceTimeoutMs: 500 }, { minSpeechMs: 0 });

    // Advance to SPEAKING state
    sttSession.emit('transcript', {
      text: 'Tell me a story.',
      confidence: 0.9,
      words: [],
      isFinal: true,
    });
    sttSession.emit('speech_end');
    await vi.advanceTimersByTimeAsync(0);

    expect(orchestrator.state).toBe('speaking');

    // Simulate speech_start with speechDurationMs: 0 >= minSpeechMs: 0 -> 'cancel'
    sttSession.emit('speech_start');
    await vi.advanceTimersByTimeAsync(0);

    expect((ttsSession as any).cancel).toHaveBeenCalled();
    expect(agentSession.abort).toHaveBeenCalled();
    expect(transport.sendControl).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'barge_in' }),
    );
    expect(orchestrator.state).toBe('listening');
  });

  // ============================================================================
  // Scenario 3: Transport disconnect
  // ============================================================================

  it('scenario 3: transport disconnect collapses pipeline to CLOSED', async () => {
    await startSession();
    expect(orchestrator.state).toBe('listening');

    // Simulate the transport closing (e.g. WebSocket disconnect)
    transport.emit('close');

    expect(orchestrator.state).toBe('closed');
    // Sub-sessions must have been torn down
    expect((sttSession as any).close).toHaveBeenCalled();
    expect((ttsSession as any).close).toHaveBeenCalled();
  });

  // ============================================================================
  // Scenario 4: Multiple sequential turns
  // ============================================================================

  /**
   * Verifies that the endpoint detector is properly reset between turns,
   * allowing the pipeline to handle consecutive user interactions without
   * stale state from previous turns affecting detection.
   */
  it('scenario 4: multiple sequential turns with endpoint detector resets', async () => {
    const { endpointDetector } = await startSession();
    const resetSpy = vi.spyOn(endpointDetector, 'reset');

    // ----- First turn -----
    await driveFullTurn('First question.');
    await vi.advanceTimersByTimeAsync(0);

    // After a turn, reset() is called twice: once internally by the detector
    // (inside _emitTurnComplete) and once by the orchestrator after flush_complete.
    expect(resetSpy).toHaveBeenCalledTimes(2);
    expect(orchestrator.state).toBe('listening');
    expect(agentSession.sendText).toHaveBeenCalledTimes(1);

    // ----- Second turn -----
    sttSession.emit('transcript', {
      text: 'Second question!',
      confidence: 0.87,
      words: [],
      isFinal: true,
    });
    sttSession.emit('speech_end');
    await vi.advanceTimersByTimeAsync(0);

    // Agent must have been called a second time with the new transcript
    expect(agentSession.sendText).toHaveBeenCalledTimes(2);
    expect(agentSession.sendText).toHaveBeenNthCalledWith(
      2,
      'Second question!',
      expect.objectContaining({ endpointReason: 'punctuation' }),
    );

    // Complete the second turn
    ttsSession.emit('flush_complete');
    expect(orchestrator.state).toBe('listening');

    // After two full turns: 2 resets per turn = 4 total
    expect(resetSpy).toHaveBeenCalledTimes(4);
  });

  // ============================================================================
  // Scenario 5: A client's transcript lines
  // ============================================================================

  /** A client transcript message, as a transport delivers it. */
  function clientLine(itemId: string, text: string, isFinal: boolean) {
    return { type: 'transcript', text, itemId, isFinal };
  }

  it('scenario 5a: two client lines open at once make one turn, and the agent receives both', async () => {
    await startSession();

    transport.emit('message', clientLine('1', 'Book a table', false));
    transport.emit('message', clientLine('2', 'for two', false));
    transport.emit('message', clientLine('1', 'Book a table', true));
    transport.emit('message', clientLine('2', 'for two.', true));
    await vi.advanceTimersByTimeAsync(0);

    expect(agentSession.sendText).toHaveBeenCalledTimes(1);
    expect(agentSession.sendText).toHaveBeenCalledWith(
      'Book a table for two.',
      expect.objectContaining({ endpointReason: 'punctuation' }),
    );
  });

  /**
   * A pause inside a sentence completes a Moonshine line. The first line has
   * no terminal punctuation, so its speech end starts the detector's silence
   * timeout; the next line opens inside it, and the turn holds both.
   */
  it('scenario 5b: a line that opens inside the silence timeout joins the turn, and the next turn starts empty', async () => {
    await startSession({ silenceTimeoutMs: 1_500 });

    transport.emit('message', clientLine('3', 'I was thinking', false));
    transport.emit('message', clientLine('3', 'I was thinking', true));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(agentSession.sendText).not.toHaveBeenCalled();

    transport.emit('message', clientLine('4', 'about Lisbon.', true));
    await vi.advanceTimersByTimeAsync(0);

    expect(agentSession.sendText).toHaveBeenCalledWith(
      'I was thinking about Lisbon.',
      expect.objectContaining({ endpointReason: 'punctuation' }),
    );

    // The agent's reply ends; the next turn holds its own line alone.
    ttsSession.emit('flush_complete');
    transport.emit('message', clientLine('5', 'Thanks.', true));
    await vi.advanceTimersByTimeAsync(0);

    expect(agentSession.sendText).toHaveBeenCalledTimes(2);
    expect(agentSession.sendText).toHaveBeenNthCalledWith(
      2,
      'Thanks.',
      expect.objectContaining({ endpointReason: 'punctuation' }),
    );
  });
});
