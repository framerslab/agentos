/**
 * @file voice-node-executor.test.ts
 * @description Unit tests for {@link VoiceNodeExecutor}.
 *
 * Covers the following execution paths:
 *
 * 1. **Normal turn completion** -- exits on `turns-exhausted` when `maxTurns` is reached.
 * 2. **Route resolution** -- maps exitReason to `routeTarget` via node edges.
 * 3. **Hangup detection** -- transport `close` event triggers `hangup` exit.
 * 4. **Keyword detection** -- `final_transcript` containing an exit keyword resolves the node.
 * 5. **Missing transport** -- returns `{ success: false }` with a descriptive error.
 * 6. **Checkpoint storage** -- `scratchUpdate` contains the voice node checkpoint.
 * 7. **Event emission** -- `voice_session` started and ended events are emitted.
 * 8. **Checkpoint restore** -- `initialTurnCount` resumes from a persisted value.
 * 9. **Non-voice node rejection** -- returns error for nodes with wrong executor type.
 * 10. **Disconnected event** -- `disconnected` (alternative to `close`) triggers hangup.
 * 11. **A started session** -- `scratch.voiceSession`'s own events: a final `user_input_transcribed`
 *     is a transcript and a keyword, a user item of `conversation_item_added` is a turn, and the
 *     session's `close` is a hangup; its transport stands in for `voiceTransport`.
 * 12. **Release** -- twenty runs of one node on one session and one transport, on a started session
 *     or on relayed events, leave every listener count as it was, no timer and no abort listener.
 *
 * All tests use plain `EventEmitter` instances as transport/session mocks -- no real
 * audio hardware, STT, or TTS provider is needed.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter, getEventListeners } from 'events';
import { VoiceNodeExecutor } from '../runtime/VoiceNodeExecutor.js';
import type { GraphNode, GraphState } from '../ir/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal voice `GraphNode` with the given config overrides and edge map.
 *
 * The returned node has `type: 'voice'` and all mandatory fields set to
 * voice-compatible defaults (`react_bounded`, `external`, `before`).
 *
 * @param config - Partial `VoiceNodeConfig` merged onto defaults.
 * @param edges  - Maps exit reason strings to target node ids.
 * @returns A `GraphNode` suitable for `VoiceNodeExecutor.execute()`.
 */
function createVoiceNode(
  config: Record<string, unknown> = {},
  edges: Record<string, string> = {},
): GraphNode {
  return {
    id: 'voice-1',
    type: 'voice',
    executorConfig: { type: 'voice', voiceConfig: { mode: 'conversation', ...config } },
    executionMode: 'react_bounded',
    effectClass: 'external',
    checkpoint: 'before',
    edges,
  } as any;
}

/**
 * Creates a partial `GraphState` with a voice transport and session wired up.
 *
 * The transport has a `_voiceSession` property pointing to a plain `EventEmitter`
 * so tests can simulate session events (final_transcript, turn_complete, etc.)
 * without a real voice pipeline.
 *
 * @param overrides - Extra fields merged into `scratch`. Used to inject
 *                    checkpoint data for restore tests.
 * @returns A partial `GraphState` ready for `VoiceNodeExecutor.execute()`.
 */
function createState(overrides: Record<string, unknown> = {}): Partial<GraphState> {
  const session = new EventEmitter();
  const transport = new EventEmitter();
  (transport as any)._voiceSession = session;
  return {
    scratch: { voiceTransport: transport, ...overrides },
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoiceNodeExecutor', () => {
  it('returns success with transcript on normal turn completion', async () => {
    const events: any[] = [];
    const executor = new VoiceNodeExecutor((e) => events.push(e));
    const node = createVoiceNode({ maxTurns: 1 }, { 'turns-exhausted': 'next' });
    const state = createState();

    // Simulate a turn completing after a short delay so the executor has
    // time to wire up its event listeners before the events fire.
    const transport = (state.scratch as any).voiceTransport;
    const session = transport._voiceSession;
    setTimeout(() => {
      session.emit('final_transcript', { text: 'Hello', speaker: 'user', confidence: 0.9 });
      session.emit('turn_complete', { transcript: 'Hello', reason: 'punctuation' });
    }, 10);

    const result = await executor.execute(node, state);
    expect(result.success).toBe(true);
    expect(result.routeTarget).toBe('next');
    expect((result.output as any).exitReason).toBe('turns-exhausted');
  });

  it('resolves routeTarget from node edges based on exitReason', async () => {
    const executor = new VoiceNodeExecutor(vi.fn());
    const node = createVoiceNode(
      { maxTurns: 1 },
      { 'turns-exhausted': 'summarize', 'hangup': 'end' },
    );
    const state = createState();
    const session = ((state.scratch as any).voiceTransport)._voiceSession;
    setTimeout(() => session.emit('turn_complete', { transcript: 'Done', reason: 'silence' }), 10);

    const result = await executor.execute(node, state);
    // The exitReason 'turns-exhausted' should map to 'summarize' in the edge map.
    expect(result.routeTarget).toBe('summarize');
  });

  it('exits on hangup when transport disconnects', async () => {
    const executor = new VoiceNodeExecutor(vi.fn());
    const node = createVoiceNode({}, { hangup: 'end' });
    const state = createState();
    const transport = (state.scratch as any).voiceTransport;
    // Simulate transport closing (e.g. WebSocket close).
    setTimeout(() => transport.emit('close'), 10);

    const result = await executor.execute(node, state);
    expect(result.success).toBe(true);
    expect((result.output as any).exitReason).toBe('hangup');
    expect(result.routeTarget).toBe('end');
  });

  it('exits on keyword detection', async () => {
    const executor = new VoiceNodeExecutor(vi.fn());
    const node = createVoiceNode(
      { exitOn: 'keyword', exitKeywords: ['goodbye'] },
      { 'keyword:goodbye': 'farewell' },
    );
    const state = createState();
    const session = ((state.scratch as any).voiceTransport)._voiceSession;
    // The keyword 'goodbye' is embedded in a longer utterance to verify
    // substring matching works correctly.
    setTimeout(() => {
      session.emit('final_transcript', { text: 'Okay goodbye then', confidence: 0.9 });
    }, 10);

    const result = await executor.execute(node, state);
    expect((result.output as any).exitReason).toBe('keyword:goodbye');
  });

  it('returns error when no transport in state', async () => {
    const executor = new VoiceNodeExecutor(vi.fn());
    const node = createVoiceNode();
    // Pass a state with scratch but no voiceTransport to trigger the guard.
    const result = await executor.execute(node, { scratch: {} } as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('voiceTransport');
  });

  it('stores checkpoint in scratchUpdate', async () => {
    const executor = new VoiceNodeExecutor(vi.fn());
    const node = createVoiceNode({ maxTurns: 1 });
    const state = createState();
    const session = ((state.scratch as any).voiceTransport)._voiceSession;
    setTimeout(() => session.emit('turn_complete', { transcript: 'Hi', reason: 'silence' }), 10);

    const result = await executor.execute(node, state);
    // The checkpoint is keyed by the node id in scratchUpdate.
    expect(result.scratchUpdate).toBeDefined();
    expect((result.scratchUpdate as any)['voice-1']).toBeDefined();
    expect((result.scratchUpdate as any)['voice-1'].turnIndex).toBe(1);
  });

  it('emits voice_session started and ended events', async () => {
    const events: any[] = [];
    const executor = new VoiceNodeExecutor((e) => events.push(e));
    const node = createVoiceNode({ maxTurns: 1 });
    const state = createState();
    const session = ((state.scratch as any).voiceTransport)._voiceSession;
    setTimeout(() => session.emit('turn_complete', { transcript: 'X', reason: 'silence' }), 10);

    await executor.execute(node, state);
    // Filter to voice_session events only.
    const sessionEvents = events.filter((e) => e.type === 'voice_session');
    expect(sessionEvents).toHaveLength(2);
    expect(sessionEvents[0].action).toBe('started');
    expect(sessionEvents[1].action).toBe('ended');
  });

  it('restores from checkpoint with initial turn count', async () => {
    const executor = new VoiceNodeExecutor(vi.fn());
    // maxTurns is 6, checkpoint has 5 turns already completed.
    // One more turn should exhaust the limit.
    const node = createVoiceNode({ maxTurns: 6 });
    const state = createState({
      'voice-1': {
        turnIndex: 5,
        transcript: [{ speaker: 'user', text: 'Previous', timestamp: 0 }],
      },
    });
    const session = ((state.scratch as any).voiceTransport)._voiceSession;
    setTimeout(() => session.emit('turn_complete', { transcript: 'Last turn', reason: 'silence' }), 10);

    const result = await executor.execute(node, state);
    // 5 (restored) + 1 (new) = 6 -> exits on turns-exhausted.
    expect((result.output as any).turns).toBe(6);
  });

  it('returns error for non-voice node', async () => {
    const executor = new VoiceNodeExecutor(vi.fn());
    const node: GraphNode = {
      id: 'tool-1',
      type: 'tool',
      executorConfig: { type: 'tool', toolName: 'test' },
      executionMode: 'single_turn',
      effectClass: 'external',
      checkpoint: 'none',
    };
    // A non-voice node should be rejected immediately.
    const result = await executor.execute(node, {} as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('non-voice');
  });

  it('exits on transport disconnected event (alternative to close)', async () => {
    const executor = new VoiceNodeExecutor(vi.fn());
    const node = createVoiceNode({}, { hangup: 'end' });
    const state = createState();
    const transport = (state.scratch as any).voiceTransport;
    // Telephony transports emit 'disconnected' instead of 'close'.
    setTimeout(() => transport.emit('disconnected'), 10);

    const result = await executor.execute(node, state);
    expect(result.success).toBe(true);
    expect((result.output as any).exitReason).toBe('hangup');
    expect(result.routeTarget).toBe('end');
  });
});

// ---------------------------------------------------------------------------
// A started session, and what a settled node leaves behind
// ---------------------------------------------------------------------------

/** A started `VoicePipelineSession` as a node meets it: an emitter with its id, its transport and `close()`. */
function startedSession() {
  const transport = new EventEmitter();
  const session = Object.assign(new EventEmitter(), {
    sessionId: 'session-1',
    state: 'listening',
    transport,
    close: async () => undefined,
  });
  return { session, transport };
}

describe('VoiceNodeExecutor on a started session', () => {
  it("reads scratch.voiceSession's own events: its final transcripts and its user items, and needs no voiceTransport", async () => {
    const events: any[] = [];
    const executor = new VoiceNodeExecutor((e) => events.push(e));
    const node = createVoiceNode({ maxTurns: 1 }, { 'turns-exhausted': 'next' });
    const { session } = startedSession();
    const state = { scratch: { voiceSession: session } } as any;

    const run = executor.execute(node, state);
    session.emit('user_input_transcribed', { transcript: 'Book a table.', isFinal: true, speakerId: 'Speaker_1', createdAt: 1 });
    // An agent reply is no turn of the user's; the user's item is.
    session.emit('conversation_item_added', { item: { role: 'assistant', text: 'Hello.', playedText: 'Hello.', interrupted: false }, createdAt: 2 });
    session.emit('conversation_item_added', { item: { role: 'user', text: 'Book a table.', source: 'speech', endpointReason: 'punctuation' }, createdAt: 3 });
    const result = await run;

    expect(result.success).toBe(true);
    expect(result.routeTarget).toBe('next');
    expect(result.output).toMatchObject({
      exitReason: 'turns-exhausted',
      turns: 1,
      lastSpeaker: 'Speaker_1',
      transcript: [{ speaker: 'Speaker_1', text: 'Book a table.' }],
    });
    expect(events).toContainEqual({ type: 'voice_turn_complete', nodeId: 'voice-1', transcript: 'Book a table.', turnIndex: 1, endpointReason: 'punctuation' });
  });

  it("exits on a keyword in a started session's final transcript, and on the session's close", async () => {
    const executor = new VoiceNodeExecutor(vi.fn());
    const keyword = createVoiceNode({ exitOn: 'keyword', exitKeywords: ['goodbye'] }, { 'keyword:goodbye': 'farewell' });
    const hangup = createVoiceNode({}, { hangup: 'end' });
    const { session, transport } = startedSession();
    const state = { scratch: { voiceSession: session, voiceTransport: transport } } as any;

    const said = executor.execute(keyword, state);
    // An interim that holds the keyword is no exit: only a final is.
    session.emit('user_input_transcribed', { transcript: 'okay goodbye', isFinal: false, createdAt: 1 });
    session.emit('user_input_transcribed', { transcript: 'Okay, goodbye then.', isFinal: true, createdAt: 2 });
    expect((await said).routeTarget).toBe('farewell');

    const closed = executor.execute(hangup, state);
    session.emit('close', { reason: 'transport_closed', createdAt: 3 });
    const result = await closed;
    expect((result.output as any).exitReason).toBe('hangup');
    expect(result.routeTarget).toBe('end');
  });

  it('keeps every listener count and leaves no timer after twenty runs of one node on one transport', async () => {
    vi.useFakeTimers();
    try {
      const executor = new VoiceNodeExecutor(vi.fn());
      const node = createVoiceNode({ maxTurns: 1, exitOn: 'silence-timeout' }, { 'turns-exhausted': 'next' });
      const { session, transport } = startedSession();
      const parent = new AbortController();
      const state = { scratch: { voiceSession: session, voiceTransport: transport, abortSignal: parent.signal } } as any;
      const names = ['close', 'disconnected', 'user_input_transcribed', 'conversation_item_added', 'user_state_changed', 'barge_in', 'speech_start', 'turn_complete', 'final_transcript', 'interim_transcript'];
      const counts = () => names.map((name) => `${name} ${session.listenerCount(name)} ${transport.listenerCount(name)}`);
      const before = counts();

      for (let run = 0; run < 20; run++) {
        const result = executor.execute(node, state);
        session.emit('user_state_changed', { oldState: 'listening', newState: 'speaking', createdAt: run });
        session.emit('user_input_transcribed', { transcript: 'Book a table.', isFinal: true, createdAt: run });
        session.emit('conversation_item_added', { item: { role: 'user', text: 'Book a table.', source: 'speech' }, createdAt: run });
        expect((await result).routeTarget).toBe('next');
        expect(counts()).toEqual(before);
        expect(vi.getTimerCount()).toBe(0);
        expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
      }
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it('keeps every listener count after twenty runs on relayed events, and exits on silence with no timer left', async () => {
    vi.useFakeTimers();
    try {
      const executor = new VoiceNodeExecutor(vi.fn());
      const node = createVoiceNode({ maxTurns: 1, exitOn: 'silence-timeout' }, { 'turns-exhausted': 'next', 'silence-timeout': 'quiet' });
      const state = createState();
      const transport = (state.scratch as any).voiceTransport as EventEmitter;
      const session = (transport as any)._voiceSession as EventEmitter;
      const names = ['close', 'disconnected', 'speech_start', 'turn_complete', 'final_transcript', 'interim_transcript', 'barge_in'];
      const counts = () => names.map((name) => `${name} ${session.listenerCount(name)} ${transport.listenerCount(name)}`);
      const before = counts();

      for (let run = 0; run < 20; run++) {
        const result = executor.execute(node, state);
        session.emit('speech_start');
        session.emit('turn_complete', { transcript: 'Book a table.', reason: 'punctuation' });
        expect((await result).routeTarget).toBe('next');
        expect(counts()).toEqual(before);
        expect(vi.getTimerCount()).toBe(0);
      }

      // Thirty seconds without speech end the node, and its timer goes with it.
      const quiet = executor.execute(node, state);
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await quiet).routeTarget).toBe('quiet');
      expect(counts()).toEqual(before);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
