/**
 * @file voice-transport-adapter.test.ts
 * @description Unit tests for {@link VoiceTransportAdapter}.
 *
 * Covers the full lifecycle contract:
 *
 * 1. `init()` injects `voiceTransport` into `state.scratch`.
 * 2. `init()` emits a `voice_session` started event.
 * 3. `getNodeInput()` resolves when the transport emits `turn_complete`.
 * 4. `getNodeInput()` emits a `voice_turn_complete` event with the correct `nodeId`.
 * 5. `deliverNodeOutput()` emits a `voice_audio` outbound event.
 * 6. `getNodeInput()` throws when called before `init()`.
 * 7. `dispose()` emits a `voice_session` ended event.
 *
 * All tests use a plain `EventEmitter` as the transport mock.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { VoiceTransportAdapter } from '../runtime/VoiceTransportAdapter.js';

// ---------------------------------------------------------------------------
// Pipeline mock — module-scoped, applies to all tests.
// The pipeline is lazily imported by init(), so all adapters that call init()
// will get a pipeline instance with mocked waitForUserTurn / pushToTTS.
// ---------------------------------------------------------------------------

let lastPipelineMock: any = null;

vi.mock('../../io/voice-pipeline/VoicePipelineOrchestrator.js', () => {
  return {
    // Must be a regular function (not an arrow) so the adapter can `new` it.
    VoicePipelineOrchestrator: vi.fn().mockImplementation(function () {
      lastPipelineMock = {
        startSession: vi.fn().mockResolvedValue(undefined),
        stopSession: vi.fn().mockResolvedValue(undefined),
        pushToTTS: vi.fn().mockResolvedValue(undefined),
        waitForUserTurn: vi.fn().mockResolvedValue({
          transcript: 'mocked turn',
          confidence: 0.95,
          durationMs: 2000,
          reason: 'punctuation',
        }),
        get state() { return 'listening'; },
      };
      return lastPipelineMock;
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh adapter + mock transport + event collector for each test.
 *
 * @returns Object with `transport` (mock EventEmitter), `events` (collected
 *          GraphEvents), and `adapter` (the VoiceTransportAdapter under test).
 */
function setup() {
  const transport = new EventEmitter();
  const events: any[] = [];
  const adapter = new VoiceTransportAdapter(
    { stt: 'deepgram', tts: 'openai' },
    transport,
    (e) => events.push(e),
  );
  return { transport, events, adapter };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoiceTransportAdapter', () => {
  it('init injects voiceTransport into state.scratch', async () => {
    const { adapter, transport } = setup();
    const state: any = { scratch: {} };
    await adapter.init(state);
    // After init(), the transport reference must be accessible in scratch
    // so that VoiceNodeExecutor can find it.
    expect(state.scratch.voiceTransport).toBe(transport);
  });

  it('init emits voice_session started', async () => {
    const { adapter, events } = setup();
    await adapter.init({ scratch: {} } as any);
    expect(events[0]).toEqual(
      expect.objectContaining({ type: 'voice_session', action: 'started' }),
    );
  });

  it('getNodeInput resolves with transcript from pipeline', async () => {
    const { adapter } = setup();
    await adapter.init({ scratch: {} } as any);
    // With the pipeline mock, getNodeInput delegates to waitForUserTurn()
    // which returns { transcript: 'mocked turn' }.
    const result = await adapter.getNodeInput('greet');
    expect(result).toBe('mocked turn');
  });

  it('getNodeInput emits voice_turn_complete event', async () => {
    const { adapter, events } = setup();
    await adapter.init({ scratch: {} } as any);
    await adapter.getNodeInput('greet');
    // Filter to turn_complete events and verify the nodeId tag.
    const turnEvents = events.filter((e) => e.type === 'voice_turn_complete');
    expect(turnEvents).toHaveLength(1);
    expect(turnEvents[0].nodeId).toBe('greet');
  });

  it('deliverNodeOutput emits voice_audio event', async () => {
    const { adapter, events } = setup();
    await adapter.init({ scratch: {} } as any);
    await adapter.deliverNodeOutput('respond', 'Hello back!');
    const audioEvents = events.filter((e) => e.type === 'voice_audio');
    expect(audioEvents).toHaveLength(1);
    expect(audioEvents[0].direction).toBe('outbound');
  });

  it('throws if not initialized', async () => {
    const { adapter } = setup();
    // Calling getNodeInput before init() must throw to prevent silent failures.
    await expect(adapter.getNodeInput('x')).rejects.toThrow('not initialized');
  });

  it('dispose emits voice_session ended', async () => {
    const { adapter, events } = setup();
    await adapter.init({ scratch: {} } as any);
    await adapter.dispose();
    const endEvents = events.filter(
      (e) => e.type === 'voice_session' && e.action === 'ended',
    );
    expect(endEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pipeline wiring tests (uses module-scoped mock from above)
// ---------------------------------------------------------------------------

describe('VoiceTransportAdapter pipeline wiring', () => {
  it('deliverNodeOutput calls pipeline.pushToTTS with string', async () => {
    lastPipelineMock = null;
    const { adapter } = setup();
    await adapter.init({ scratch: {} } as any);
    await adapter.deliverNodeOutput('greet', 'Hello caller!');
    expect(lastPipelineMock).not.toBeNull();
    expect(lastPipelineMock.pushToTTS).toHaveBeenCalledWith('Hello caller!');
  });

  it('getNodeInput delegates to pipeline.waitForUserTurn', async () => {
    lastPipelineMock = null;
    const { adapter } = setup();
    await adapter.init({ scratch: {} } as any);
    const input = await adapter.getNodeInput('listen');
    expect(input).toBe('mocked turn');
  });

  it('dispose calls pipeline.stopSession', async () => {
    lastPipelineMock = null;
    const { adapter } = setup();
    await adapter.init({ scratch: {} } as any);
    await adapter.dispose();
    expect(lastPipelineMock).not.toBeNull();
    expect(lastPipelineMock.stopSession).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A started session, and the config-only path's warning
// ---------------------------------------------------------------------------

/** A host's logger that records what it is told. */
function recordingLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** A started `VoicePipelineSession` as `startSession()` returns it: an emitter with its id, its transport and `close()`. */
function startedSession(transport: EventEmitter) {
  return Object.assign(new EventEmitter(), { sessionId: 'session-1', state: 'listening', transport, close: async () => undefined });
}

describe('VoiceTransportAdapter on a started session', () => {
  it('puts a session given with its orchestrator in state.scratch.voiceSession, runs node I/O through the orchestrator, and logs nothing', async () => {
    lastPipelineMock = null;
    const transport = new EventEmitter();
    const session = startedSession(transport);
    const orchestrator = {
      waitForUserTurn: vi.fn().mockResolvedValue({ transcript: 'Book a table.', reason: 'punctuation' }),
      pushToTTS: vi.fn().mockResolvedValue(undefined),
      stopSession: vi.fn().mockResolvedValue(undefined),
    };
    const logger = recordingLogger();
    const adapter = new VoiceTransportAdapter({}, transport, vi.fn(), { session, orchestrator, logger });
    const state: any = { scratch: {} };

    await adapter.init(state);

    expect(state.scratch.voiceSession).toBe(session);
    expect(state.scratch.voiceTransport).toBe(transport);
    expect((transport as any)._voiceSession).toBeUndefined();
    await expect(adapter.getNodeInput('greet')).resolves.toBe('Book a table.');
    await adapter.deliverNodeOutput('greet', 'Booked.');
    expect(orchestrator.pushToTTS).toHaveBeenCalledWith('Booked.');
    // No orchestrator was built from the config.
    expect(lastPipelineMock).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
    await adapter.dispose();
    expect(orchestrator.stopSession).toHaveBeenCalledWith('adapter-disposed');
  });

  it('takes a started session given with pipeline alone as a started session, and an emitter of relayed events as before', async () => {
    const pipeline = { waitForUserTurn: vi.fn(), pushToTTS: vi.fn() };
    const transport = new EventEmitter();
    const started = startedSession(transport);
    const startedState: any = { scratch: {} };
    await new VoiceTransportAdapter({}, transport, vi.fn(), { pipeline, session: started }).init(startedState);
    expect(startedState.scratch.voiceSession).toBe(started);
    expect((transport as any)._voiceSession).toBeUndefined();

    const relay = new EventEmitter();
    const relayState: any = { scratch: {} };
    await new VoiceTransportAdapter({}, transport, vi.fn(), { pipeline, session: relay }).init(relayState);
    expect(relayState.scratch.voiceSession).toBeUndefined();
    expect((transport as any)._voiceSession).toBe(relay);
  });

  it('logs one warning through the host logger when it is given no orchestrator, and still builds one from its config', async () => {
    lastPipelineMock = null;
    const logger = recordingLogger();
    const adapter = new VoiceTransportAdapter({ stt: 'deepgram', tts: 'openai' }, new EventEmitter(), vi.fn(), { logger });

    await adapter.init({ scratch: {} } as any);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]![0]).toMatch(/no orchestrator.*starts no session.*\{ session, orchestrator \}/);
    expect(lastPipelineMock).not.toBeNull();
  });

  it('initialises when the host logger throws', async () => {
    const logger = recordingLogger();
    logger.warn.mockImplementation(() => {
      throw new Error('the logger failed');
    });
    const events: any[] = [];
    const adapter = new VoiceTransportAdapter({}, new EventEmitter(), (event) => events.push(event), { logger });

    await expect(adapter.init({ scratch: {} } as any)).resolves.toBeUndefined();
    expect(events).toEqual([expect.objectContaining({ type: 'voice_session', action: 'started' })]);
  });
});
