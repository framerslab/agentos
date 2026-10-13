/**
 * Call-local supervision on a session without a call profile: an error on the
 * STT, TTS or transport session and a reply whose agent stream rejects each
 * end their own call and no other, without an unhandled error, and a pending
 * waitForUserTurn() rejects when its call closes. An audio send that the
 * transport rejects is caught too, and is reported as the orchestrator's
 * 'error' while the turn goes on: a failed send ends neither the turn nor the
 * session here, and only a call profile ends a call on one.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { VoicePipelineOrchestrator } from '../VoicePipelineOrchestrator.js';
import type { IVoicePipelineAgentSession } from '../types.js';

async function fixture(agent?: IVoicePipelineAgentSession) {
  const transport = Object.assign(new EventEmitter(), {
    id: 'transport-a',
    state: 'open' as const,
    sendAudio: vi.fn(async () => {}),
    sendControl: vi.fn(async () => {}),
    close: vi.fn(),
  });
  const stt = Object.assign(new EventEmitter(), { pushAudio() {}, flush: async () => {}, close: vi.fn() });
  const tts = Object.assign(new EventEmitter(), { pushTokens() {}, flush: async () => {}, cancel() {}, close: vi.fn() });
  const endpoint = Object.assign(new EventEmitter(), { mode: 'heuristic' as const, pushVadEvent() {}, pushTranscript() {}, reset() {} });
  const runtime = new VoicePipelineOrchestrator({ stt: 'fake', tts: 'fake' });
  await runtime.startSession(transport, agent ?? { async *sendText() { yield 'hello'; } }, {
    streamingSTT: { providerId: 'fake', isStreaming: true, startSession: async () => stt },
    streamingTTS: { providerId: 'fake', startSession: async () => tts },
    endpointDetector: endpoint,
    bargeinHandler: { mode: 'hard-cut', handleBargein: () => ({ type: 'cancel' }) },
  });
  return { runtime, transport, stt, tts, endpoint };
}

describe('call-local supervision', () => {
  for (const source of ['stt', 'tts', 'transport'] as const) {
    it(`contains ${source} errors and rejects a waiting turn`, async () => {
      const a = await fixture();
      const b = await fixture();
      const waiting = expect(a.runtime.waitForUserTurn()).rejects.toThrow('closed');
      expect(() => a[source].emit('error', new Error('private payload'))).not.toThrow();
      await waiting;
      await vi.waitFor(() => expect(a.runtime.state).toBe('closed'));
      expect(b.runtime.state).toBe('listening');
      await b.runtime.stopSession();
    });
  }

  it('catches an async agent failure and a rejected audio send', async () => {
    const a = await fixture({
      async *sendText() {
        yield 'first';
        throw new Error('private prompt');
      },
    });
    a.endpoint.emit('turn_complete', { transcript: 'hello', confidence: 1, durationMs: 20, reason: 'manual' });
    await vi.waitFor(() => expect(a.runtime.state).toBe('closed'));
    const b = await fixture();
    const errors: unknown[] = [];
    b.runtime.on('error', (error: unknown) => errors.push(error));
    const refused = new Error('send failed');
    b.transport.sendAudio = vi.fn(async () => {
      throw refused;
    });
    b.endpoint.emit('turn_complete', { transcript: 'hello', confidence: 1, durationMs: 20, reason: 'manual' });
    await vi.waitFor(() => expect(b.runtime.state).toBe('speaking'));
    b.tts.emit('audio', { audio: Buffer.alloc(2), format: 'pcm', sampleRate: 16000, durationMs: 1, text: '' });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toBe(refused);
    expect(b.runtime.state).toBe('speaking');
    b.tts.emit('flush_complete');
    expect(b.runtime.state).toBe('listening');
    await b.runtime.stopSession();
  });
});
