import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { vi } from 'vitest';
import { VoiceAgentSchema } from '../contracts/index.js';
import { contractExamples } from './contractFixtures.js';
import { storedCall } from './callFixtures.js';
import { managerHooks } from './managerFixtures.js';
import { browserIdentity } from './credentialFixtures.js';
import { physicalTransport } from './transportFixtures.js';
import { reasoningFixture } from './ReasoningProviderResolver.test.js';
import { InMemoryVoiceStore } from '../stores/memory.js';
import { VoiceCallManager } from '../VoiceCallManager.js';
import { CallCredentials, exchangeRequestHash } from '../CallCredentials.js';
import { SlotLimiter } from '../SlotLimiter.js';
import { SpeechProviderResolver } from '../../speech/SpeechProviderResolver.js';
import { VoiceAdapterManifestSchema, type ScopedVoiceAdapter } from '../../speech/VoiceAdapter.js';
import { defaultCapabilities } from '../../voice-pipeline/HealthyProvider.js';
import { VoiceSessionFactory } from '../VoiceSessionFactory.js';
import { VoiceToolRegistry } from '../reasoning/tools.js';
import type { AudioIdentity, EncodedAudioChunk, ScopedTranscriptEvent, ScopedStreamingSTTSession, ScopedAudioFrame, StreamingTTSConfig, StreamingTTSSession } from '../../voice-pipeline/types.js';
/** Builds every detector and provider from descriptors; no network or model process runs in this fixture. */
export async function factoryFixture(synthesisLimits = { maxTextCharacters: 8192, maxSynthesisRequests: 96 }) {
  const reasoning = reasoningFixture(); const scope = reasoning.scope; const store = new InMemoryVoiceStore();
  const browser = browserIdentity(); const seed = storedCall(); const now = () => Date.now();
  seed.call.createdAt = now(); seed.acknowledgedAt = now(); seed.call.state = 'connecting';
  seed.call.workerGeneration = 1; seed.call.inferenceGeneration = 1; seed.preparationStep = 3; seed.reservationRef = 'local:call-a';
  seed.call.initiatingPrincipal = scope.principal; seed.proofKeyThumbprint = browser.thumbprint;
  seed.call.attemptAllowance.limits = reasoning.config.attemptLimits;
  const agent = VoiceAgentSchema.parse({ ...contractExamples.VoiceAgent, scopeId: scope.scopeId, agentId: seed.call.agentId, revision: seed.call.agentRevision,
    reasoning: reasoning.config, allowedToolRefs: [], language: 'en', voice: { id: 'voice-a', revision: 'voice-r1' },
    stt: { providerId: 'stt', modelId: 'model-a', modelRevision: 'weights-a', mode: 'streaming', sampleRate: 16000, codec: 'pcm_f32le' },
    tts: { providerId: 'tts', modelId: 'model-a', modelRevision: 'weights-a', mode: 'streaming', sampleRate: 16000, codec: 'pcm_s16le' },
    vad: { providerId: 'vad', modelId: 'model-a', modelRevision: 'weights-a', threshold: 0.5 }, endpoint: { providerId: 'endpoint', modelId: 'model-a', modelRevision: 'weights-a' },
    providerPolicy: { mode: 'local', fallback: 'none', providerIds: scope.policy.providers.map((p) => p.providerId), purposes: scope.policy.purposes } });
  seed.limits = agent.limits; await store.withTransaction(scope.scopeId, (tx) => tx.put('calls', scope.callId, seed, 0));
  const hooks = managerHooks().hooks; const manager = new VoiceCallManager({ store, hooks, now, workerLeaseMs: 15000 });
  const limiter = new SlotLimiter({ store, now }); const credentials = new CallCredentials({ store, now, ttlMs: 120000, proofWindowMs: 30000,
    key: { id: 'fixture', key: new Uint8Array(32).fill(1) }, authorize: async () => {},
    issueMedia: (_binding, token) => ({ token, url: 'wss://media.example.test/web-calls/call-a/media' }) });
  const speech = new SpeechProviderResolver(undefined, {}); let identity: AudioIdentity | undefined;
  const frames: ScopedAudioFrame[] = []; let stopProof = true; let recognizeNext = false;
  const ttsSessions: StreamingTTSSession[] = [];
  const fence = vi.fn(async () => { if (!stopProof) throw new Error('native still alive'); return { stopped: true as const, evidenceRef: 'fixture-native-stopped' }; });
  const dispose = vi.fn(async () => {});
  const vad = Object.assign(new EventEmitter(), { pushAudio: vi.fn(async (frame: ScopedAudioFrame) => { frames.push(frame); }), reset: vi.fn(async () => {}), flush: async () => {}, dispose });
  const endpoint = Object.assign(new EventEmitter(), { mode: 'semantic' as const, pushAudio: vi.fn(async () => {}), pushVadEvent: vi.fn(async () => {}),
    pushTranscript: vi.fn(async (event: ScopedTranscriptEvent) => { if (event.isFinal) endpoint.emit('turn_complete', { ...event, transcript: event.text, durationMs: 20, reason: 'manual' }); }),
    reset: vi.fn(async () => {}), dispose });
  const recognitionSessions: ScopedStreamingSTTSession[] = [];
  const makeRecognitionSession = (): ScopedStreamingSTTSession => {
    const session: ScopedStreamingSTTSession = Object.assign(new EventEmitter(), { pushAudio() {}, pushAudioScoped: vi.fn(async (frame: ScopedAudioFrame) => {
      if (recognizeNext) { recognizeNext = false; session.emit('transcript', { ...frame, text: 'hello', isFinal: true, confidence: 1 }); }
    }), reset: vi.fn(async (next: AudioIdentity) => { identity = next; }), flush: vi.fn(async () => {}), close: vi.fn() });
    recognitionSessions.push(session); return session;
  };
  const stt = makeRecognitionSession();
  const manifest = (providerId: string, streaming: boolean) => VoiceAdapterManifestSchema.parse({ providerId, locality: 'local', modelId: 'model-a', modelRevision: 'weights-a', languages: ['en'], sampleRates: [16000], codecs: ['pcm_f32le', 'pcm_s16le'], voices: [{ id: 'voice-a', revision: 'voice-r1' }], streaming, scoped: true, boundedRequests: true, cancellation: 'native_abort', usage: true, awaitedOutput: true, conformanceRef: 'fixture-a' });
  class RecognitionAdapter implements ScopedVoiceAdapter<'streaming-stt'> {
    readonly voiceAdapterVersion = 1 as const; readonly kind = 'streaming-stt' as const;
    readonly manifest = manifest('stt', true); readonly options = z.strictObject({}); calls = 0;
    constructor(private readonly session: ScopedStreamingSTTSession) {}
    async create() { this.calls++; let opened = false; return { value: { providerId: 'stt', isStreaming: true as const, priority: 0, capabilities: defaultCapabilities(), healthCheck: async () => ({ ok: true }), startSession: async () => { if (opened) return makeRecognitionSession(); opened = true; return this.session; } }, fence, dispose }; }
  }
  const recognitionAdapter = new RecognitionAdapter(stt);
  const descriptors: ScopedVoiceAdapter[] = [
    recognitionAdapter,
    { voiceAdapterVersion: 1, kind: 'streaming-tts', manifest: manifest('tts', true), options: z.strictObject({}), create: async () => ({ value: { providerId: 'tts', priority: 0, capabilities: defaultCapabilities(), healthCheck: async () => ({ ok: true }), startSession: async (config?: StreamingTTSConfig) => {
      if (!config?.call) throw new Error('scoped synthesis required');
      const call = structuredClone(config.call); let sink: ((chunk: EncodedAudioChunk) => Promise<void>) | undefined;
      let acceptedCharacters = 0; let generatedSamples = 0; let closed = false; let final = false;
      const usage = (status: 'running' | 'completed' | 'cancelled') => {
        if (final) return; final = status !== 'running';
        session.emit('usage', { ...call, providerId: 'tts', acceptedCharacters, generatedSamples, sampleRate: 16000, status, final });
      };
      const write = async (text: string): Promise<void> => {
        if (closed || final || !sink) throw new Error('synthesis unavailable');
        acceptedCharacters += text.length; generatedSamples += 320; usage('running');
        await sink({ ...call, audio: Buffer.alloc(640), format: 'pcm', container: 'raw', sampleRate: 16000, durationMs: 20, text });
      };
      const session: StreamingTTSSession = Object.assign(new EventEmitter(), {
        pushTokens(text: string) { void write(text).catch((error) => session.emit('error', error)); },
        writeTokens: write, setAudioSink(next: (chunk: EncodedAudioChunk) => Promise<void>) { sink = next; },
        flush: async () => { if (closed) return; usage('completed'); session.emit('flush_complete'); },
        cancel() { if (!closed) usage('cancelled'); closed = true; }, close() { closed = true; },
      }); ttsSessions.push(session); return session;
    } }, fence, dispose }) },
    { voiceAdapterVersion: 1, kind: 'vad-session', manifest: manifest('vad', false), options: z.strictObject({}), create: async () => ({ value: vad, fence, dispose }) },
    { voiceAdapterVersion: 1, kind: 'audio-endpoint', manifest: manifest('endpoint', false), options: z.strictObject({}), create: async () => ({ value: endpoint, fence, dispose }) },
  ]; for (const descriptor of descriptors) speech.registerVoiceAdapter(descriptor);
  const factory = new VoiceSessionFactory({ store, manager, limiter, credentials, speech, reasoning: reasoning.resolver, options: { read: async () => ({}) }, tools: new VoiceToolRegistry([]),
    now, synthesisLimits, authorizeMedia: async () => {}, onInterrupted: async () => {}, network: {} });
  const request = { scope, agent, funding: { kind: 'local' as const }, slot: { scopeId: scope.scopeId, callId: scope.callId, hostId: 'host-a', holder: 'worker-a', ttlMs: 15000,
    capacity: { version: 'fixture-bench', validUntil: now() + 60000, scopeSlots: 1, hostSlots: 1 } } };
  const attach = async () => {
    const runtime = await factory.startSession(request);
    hooks.abortModelAndTools = () => runtime.abortModelAndTools(); hooks.cancelTts = () => runtime.cancelTts();
    hooks.clearPlayback = () => runtime.clearPlayback(); hooks.drainTranscripts = (c) => runtime.drainTranscripts(c.signal);
    hooks.releaseMedia = () => runtime.releaseMedia(); hooks.confirmStopped = () => runtime.confirmStopped(); hooks.releaseSlots = () => runtime.releaseSlots();
    const grant = await credentials.issueGrant(scope.scopeId, scope.callId, 'grant-a');
    const requestHash = exchangeRequestHash(scope.callId, grant.grantId, 'exchange-a', seed.clientOrigin);
    const connection = await credentials.exchange(scope.scopeId, scope.callId, grant.token, seed.clientOrigin, { exchangeKey: 'exchange-a', requestHash,
      proof: browser.proof({ operation: 'connect', callId: scope.callId, credentialId: grant.grantId, origin: seed.clientOrigin, operationKey: 'exchange-a', requestHash, issuedAt: now(), nonce: 'nonce-a' }) });
    const physical = physicalTransport(); await runtime.binding.reattach({ token: connection.token, origin: seed.clientOrigin, transportEpoch: connection.transportEpoch, participantId: seed.participantId, transport: 'websocket', physical: physical.transport });
    return { runtime, physical: physical.transport, acknowledge: physical.acknowledge };
  };
  return { factory, request, store, manager, limiter, speech, vad, endpoint, stt, frames, attach, fence, dispose, reasoning, hooks, recognitionAdapter, recognitionSessions, ttsSessions,
    recognize: () => { recognizeNext = true; },
    identity: () => identity!, refuseFence: () => { stopProof = false; }, allowFence: () => { stopProof = true; } };
}
