import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { CallTransportBinding } from '../CallTransportBinding.js';
import { CallCredentials, exchangeRequestHash } from '../CallCredentials.js';
import { VoiceCallManager } from '../VoiceCallManager.js';
import { SlotLimiter } from '../SlotLimiter.js';
import { InMemoryVoiceStore } from '../stores/memory.js';
import { VoicePipelineOrchestrator } from '../../voice-pipeline/VoicePipelineOrchestrator.js';
import type { AudioIdentity, EncodedAudioChunk, IPlaybackTransport, ScopedStreamingSTTSession, StreamingTTSSession, VoiceGeneration } from '../../voice-pipeline/types.js';
import { storedCall } from './callFixtures.js';
import { managerHooks } from './managerFixtures.js';
import { browserIdentity } from './credentialFixtures.js';

/** One physical socket/room stand-in with controllable acknowledged playback. */
export function physicalTransport() {
  const emitter = new EventEmitter(); let closed = false; let acknowledge: (() => void) | undefined;
  const transport: IPlaybackTransport = Object.assign(emitter, {
    id: 'physical-a', get state() { return closed ? 'closed' as const : 'open' as const; },
    sendAudio: vi.fn(async (_chunk: EncodedAudioChunk) => {}), sendControl: vi.fn(async () => {}),
    close: vi.fn(() => { closed = true; emitter.emit('close'); }),
    clearPlayback: vi.fn(async () => {}),
    waitForPlayback: vi.fn(async (generation: VoiceGeneration, sequence: number, signal: AbortSignal) => new Promise<{ generation: VoiceGeneration; sequence: number; playedSamples: number; sampleRate: number }>((resolve, reject) => {
      acknowledge = () => resolve({ generation, sequence, playedSamples: 320, sampleRate: 16000 });
      if (signal.aborted) reject(new Error('cancelled')); else signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    })),
  });
  return { transport, acknowledge: () => acknowledge?.() };
}
/** Runs the actual pipeline, credential service, slot store, binding and durable manager together. */
export async function transportFixture(phase: 'recognition' | 'reasoning' | 'playback' = 'recognition') {
  const store = new InMemoryVoiceStore(); let now = 1000; const browser = browserIdentity(); const seed = storedCall();
  seed.call.state = 'connecting'; seed.call.workerGeneration = 1; seed.call.inferenceGeneration = 1;
  seed.preparationStep = 3; seed.reservationRef = 'reservation-a'; seed.proofKeyThumbprint = browser.thumbprint;
  await store.withTransaction('scope-a', (tx) => tx.put('calls', 'call-a', seed, 0));
  const effects = managerHooks();
  const manager = new VoiceCallManager({ store, now: () => now, hooks: effects.hooks, workerLeaseMs: 15000 });
  const limiter = new SlotLimiter({ store, now: () => now });
  const admitted = await limiter.acquire({ scopeId: 'scope-a', callId: 'call-a', hostId: 'host-a', holder: 'worker-a', ttlMs: 15000,
    capacity: { version: 'bench-a', validUntil: 100000, scopeSlots: 1, hostSlots: 1 } });
  if (!admitted.ok) throw new Error('fixture admission failed');
  const credentials = new CallCredentials({ store, now: () => now, ttlMs: 120000, proofWindowMs: 30000,
    key: { id: 'test', key: new Uint8Array(32).fill(1) }, authorize: async () => {},
    issueMedia: (_binding, token) => ({ url: 'wss://media.example.test/web-calls/call-a/media', token }) });
  let grantSequence = 0;
  const grant = async () => {
    const key = `exchange-${++grantSequence}`; const g = await credentials.issueGrant('scope-a', 'call-a', key);
    const requestHash = exchangeRequestHash('call-a', g.grantId, key, seed.clientOrigin);
    return credentials.exchange('scope-a', 'call-a', g.token, seed.clientOrigin, { exchangeKey: key, requestHash,
      proof: browser.proof({ operation: 'connect', callId: 'call-a', credentialId: g.grantId, origin: seed.clientOrigin, operationKey: key, requestHash, issuedAt: now, nonce: key }) });
  };
  let identity: AudioIdentity | undefined; let finishReasoning: (() => void) | undefined;
  let fence: () => Promise<void> = async () => {}; let agentAborted = false; const interrupted: AudioIdentity[] = []; const agentAbort = vi.fn(() => { agentAborted = true; finishReasoning?.(); });
  const runtime = new VoicePipelineOrchestrator({ stt: 'fake', tts: 'fake' });
  const endpoint = Object.assign(new EventEmitter(), { mode: 'semantic' as const, pushAudio: vi.fn(async () => {}), pushVadEvent: vi.fn(async () => {}), pushTranscript: vi.fn(async () => {}), reset: vi.fn(async () => {}), dispose: vi.fn(async () => {}) });
  const vad = Object.assign(new EventEmitter(), { pushAudio: vi.fn(async () => {}), reset: vi.fn(async () => {}), flush: async () => {}, dispose: vi.fn(async () => {}) });
  const stt: ScopedStreamingSTTSession = Object.assign(new EventEmitter(), { pushAudio() {}, pushAudioScoped: vi.fn(async () => {}), reset: vi.fn(async (next: AudioIdentity) => { identity = next; }), flush: async () => {}, close() {} });
  const binding = new CallTransportBinding({ scopeId: 'scope-a', callId: 'call-a', participantId: seed.participantId, workerGeneration: 1,
    store, manager, credentials, slot: admitted.lease, now: () => now, authorize: async () => {},
    pipeline: {
      start: async (generation) => { await runtime.startSession(binding, { abort: agentAbort, async *sendText() {
        if (phase === 'reasoning' && !agentAborted) await new Promise<void>((resolve) => { finishReasoning = resolve; });
        yield 'hello';
      } }, { streamingSTT: { providerId: 'fake', isStreaming: true, startSession: async () => stt },
        streamingTTS: { providerId: 'fake', startSession: async (config) => {
          let sink: ((chunk: EncodedAudioChunk) => Promise<void>) | undefined;
          const t: StreamingTTSSession = Object.assign(new EventEmitter(), { pushTokens() {}, setAudioSink(fn: (chunk: EncodedAudioChunk) => Promise<void>) { sink = fn; },
            async writeTokens() { await sink!({ scopeId: 'scope-a', callId: 'call-a', generation: config!.call!.generation, audio: Buffer.alloc(640), format: 'pcm', container: 'raw', sampleRate: 16000, durationMs: 20, text: '' }); },
            async flush() { t.emit('usage', { ...config!.call!, providerId: 'fake', acceptedCharacters: 5, generatedSamples: 320, sampleRate: 16000, final: true, status: 'completed' }); t.emit('flush_complete'); }, cancel() {}, close() {},
          }); return t;
        } }, callProfile: { identity: { scopeId: 'scope-a', callId: 'call-a', turnId: 'turn-a', generation }, vadSession: vad, audioEndpointDetector: endpoint,
          maxInputFrames: 32, maxInputSamples: 10240, playback: { maxBytes: 64000, maxDurationMs: 2000 }, minSpeechMs: 120, maxTextCharacters: 4096, maxSynthesisRequests: 64,
          onGeneration: (g) => binding.recordGeneration(g), onInterrupted: (i) => { interrupted.push(i); }, onFailure: () => {}, fenceInference: () => fence() } }); },
      detach: (reason, epoch) => runtime.detach(reason, epoch), reattach: (generation) => runtime.reattach(generation),
    } });
  const recordMediaRelease = effects.hooks.releaseMedia;
  effects.hooks.releaseMedia = async (context) => { await recordMediaRelease(context); await runtime.stopSession(); await binding.releaseMedia(); };
  const connect = async (physical = physicalTransport().transport) => {
    const connection = await grant();
    await binding.reattach({ token: connection.token, origin: seed.clientOrigin, transportEpoch: connection.transportEpoch, participantId: seed.participantId, transport: 'websocket', physical });
    return { connection, physical };
  };
  return { binding, manager, store, credentials, seed, grant, connect, runtime, endpoint, vad, stt, interrupted, agentAbort, effects,
    setFence: (next: () => Promise<void>) => { fence = next; }, identity: () => identity!, time: (at: number) => { now = at; },
    turn: () => endpoint.emit('turn_complete', { ...identity!, transcript: 'hello', confidence: 1, durationMs: 20, reason: 'manual' }),
  };
}
