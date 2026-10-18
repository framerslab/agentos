/**
 * @file voice-node-real-session.test.ts
 * @description A compiled graph whose conversation node runs over a real `VoicePipelineOrchestrator` the test
 * started, on fake STT, TTS and agent sessions: `VoiceTransportAdapter`, given the started session and its
 * orchestrator, puts the session where the node reads it, and the node hears the turn the session's own endpoint
 * detector completes, exits on `maxTurns: 1` and routes its `turns-exhausted` edge.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentGraph, END, START } from '../builders/AgentGraph.js';
import { voiceNode } from '../builders/VoiceNodeBuilder.js';
import { VoiceNodeExecutor } from '../runtime/VoiceNodeExecutor.js';
import { VoiceTransportAdapter } from '../runtime/VoiceTransportAdapter.js';
import type { GraphEvent } from '../events/GraphEvent.js';
import type { GraphNode, GraphState } from '../ir/types.js';
import { VoicePipelineOrchestrator } from '../../io/voice-pipeline/VoicePipelineOrchestrator.js';
import { HeuristicEndpointDetector } from '../../io/voice-pipeline/HeuristicEndpointDetector.js';
import { HardCutBargeinHandler } from '../../io/voice-pipeline/HardCutBargeinHandler.js';
import type { IStreamTransport, StreamingSTTSession, StreamingTTSSession } from '../../io/voice-pipeline/types.js';

/** A step of the host's own: an extension node, whose output the graph writes to scratch. */
function hostStep(id: string): GraphNode {
  return {
    id,
    type: 'extension',
    executorConfig: { type: 'extension', extensionId: 'call', method: id },
    executionMode: 'single_turn',
    effectClass: 'external',
    checkpoint: 'none',
  };
}

/** A session started as a host starts one before its graph runs: a real orchestrator over fake parts. */
async function startedCall() {
  const transport: IStreamTransport = Object.assign(new EventEmitter(), {
    id: 'transport-1',
    state: 'open' as const,
    sendAudio: async () => undefined,
    sendControl: async () => undefined,
    close: () => undefined,
  });
  const stt: StreamingSTTSession = Object.assign(new EventEmitter(), {
    pushAudio: () => undefined,
    flush: async () => undefined,
    close: () => undefined,
  });
  const tts: StreamingTTSSession = Object.assign(new EventEmitter(), {
    pushTokens: () => undefined,
    flush: async () => undefined,
    cancel: () => undefined,
    close: () => undefined,
  });
  const orchestrator = new VoicePipelineOrchestrator({ stt: 'fake-stt', tts: 'fake-tts' });
  const session = await orchestrator.startSession(
    transport,
    {
      sendText: async function* () {
        yield 'A table for two, at seven.';
      },
    },
    {
      streamingSTT: { providerId: 'fake-stt', isStreaming: true, startSession: async () => stt },
      streamingTTS: { providerId: 'fake-tts', startSession: async () => tts },
      endpointDetector: new HeuristicEndpointDetector(),
      bargeinHandler: new HardCutBargeinHandler(),
    }
  );
  return { transport, stt, orchestrator, session };
}

describe('a voice node on a started session', () => {
  it("hears a spoken turn through the session's own events, exits on maxTurns and routes its turns-exhausted edge", async () => {
    const call = await startedCall();
    const graphEvents: GraphEvent[] = [];
    const voiceExecutor = new VoiceNodeExecutor((event) => {
      graphEvents.push(event);
      // The caller speaks once the node listens: the node subscribes in the same task that reports it started.
      if (event.type === 'voice_session' && event.nodeId === 'listen' && event.action === 'started') {
        setImmediate(() => {
          call.stt.emit('speech_start');
          call.stt.emit('transcript', { text: 'Book a table for two.', confidence: 0.92, words: [], isFinal: true });
          call.stt.emit('speech_end');
        });
      }
    });
    const adapter = new VoiceTransportAdapter({}, call.transport, (event) => graphEvents.push(event), {
      session: call.session,
      orchestrator: call.orchestrator,
    });
    const graph = new AgentGraph({ input: z.object({}), scratch: z.object({}), artifacts: z.object({}) })
      .addNode('connect', hostStep('connect'))
      .addNode('listen', voiceNode('listen', { mode: 'conversation', maxTurns: 1 }).on('turns-exhausted', 'confirm').on('hangup', 'hungUp').build())
      .addNode('confirm', hostStep('confirm'))
      .addNode('hungUp', hostStep('hungUp'))
      .addEdge(START, 'connect')
      .addEdge('connect', 'listen')
      .addEdge('listen', 'confirm')
      .addEdge('listen', 'hungUp')
      .addEdge('confirm', END)
      .addEdge('hungUp', END)
      .compile({
        deps: {
          voiceExecutor,
          // The connect step hands the graph the call: the adapter puts the transport and the started session in the
          // scratch it returns, which the graph writes to its own.
          extensionExecutor: async (_extensionId, method) => {
            if (method !== 'connect') return { success: true, output: { reached: method } };
            const seed: Partial<GraphState> = { scratch: {} };
            await adapter.init(seed);
            return { success: true, output: seed.scratch };
          },
        },
      });

    const events: GraphEvent[] = [];
    try {
      for await (const event of graph.stream({})) events.push(event);
    } finally {
      await adapter.dispose();
    }

    const listened = events.find((event) => event.type === 'node_end' && event.nodeId === 'listen');
    expect(listened).toMatchObject({
      output: { exitReason: 'turns-exhausted', turns: 1, transcript: [{ speaker: 'user', text: 'Book a table for two.' }] },
    });
    const started = events.flatMap((event) => (event.type === 'node_start' ? [event.nodeId] : []));
    expect(started).toEqual(['connect', 'listen', 'confirm']);
    expect(graphEvents).toContainEqual({
      type: 'voice_turn_complete',
      nodeId: 'listen',
      transcript: 'Book a table for two.',
      turnIndex: 1,
      endpointReason: 'punctuation',
    });
    expect(call.orchestrator.state).toBe('closed');
  }, 15_000);
});
