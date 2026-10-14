import { z } from 'zod';
import { checkedRequest, checkedStream, hostedEgressPolicy, localEgressPolicy, type CheckedResponse, type CheckedStreamResponse } from '../../safety/egress/CheckedEgress.js';
import type { IAttemptAuthorizer, AttemptGrant } from '../../safety/runtime/ModelAttemptBudget.js';
import type { AttemptPurpose } from '../../safety/runtime/CompoundCreditStore.js';
import { captureVoiceScope, requireVoiceScope, type VoiceScopeContext } from '../voice-platform/VoiceScopeContext.js';
import { authorizeProviderOpening, type VoiceProviderPurpose } from '../voice-pipeline/ProviderPolicy.js';
import type { AudioIdentity, VoiceGeneration, IStreamingSTT, IStreamingTTS, IVadSession, IAudioEndpointDetector } from '../voice-pipeline/types.js';
import type { SpeechToTextProvider, TextToSpeechProvider } from './types.js';
import type { HealthyProvider } from '../voice-pipeline/HealthyProvider.js';
import type { VoiceNetworkDependencies, VoiceStopEvidence } from '../voice-platform/reasoning/tools.js';
/** Closed model/voice capability evidence, consumed before a factory is invoked. */
export const VoiceAdapterManifestSchema = z.strictObject({
  providerId: z.string().min(1).max(128), locality: z.enum(['local', 'remote']), modelId: z.string().min(1), modelRevision: z.string().min(1),
  languages: z.array(z.string().min(2)).min(1), sampleRates: z.array(z.number().int().positive()).min(1),
  codecs: z.array(z.enum(['pcm_s16le', 'pcm_f32le', 'wav', 'opus', 'mp3'])).min(1),
  voices: z.array(z.strictObject({ id: z.string().min(1), revision: z.string().min(1) })),
  streaming: z.boolean(), scoped: z.literal(true), boundedRequests: z.literal(true), cancellation: z.enum(['native_abort', 'process_exit']),
  usage: z.literal(true), awaitedOutput: z.boolean(), conformanceRef: z.string().min(1), origin: z.string().url().optional(), credentialRef: z.string().min(1).optional(),
});
/** Inferred immutable manifest. */
export type VoiceAdapterManifest = z.infer<typeof VoiceAdapterManifestSchema>;
/** Typed legacy batch adapters stay distinct from streaming and detector sessions. */
export interface VoiceAdapterValues {
  'streaming-stt': IStreamingSTT & HealthyProvider;
  'streaming-tts': IStreamingTTS & HealthyProvider;
  'batch-stt': SpeechToTextProvider;
  'batch-tts': TextToSpeechProvider;
  'vad-session': IVadSession;
  'audio-endpoint': IAudioEndpointDetector;
}
/** Closed factory kind union. */
export type VoiceAdapterKind = keyof VoiceAdapterValues;
/** Factory output owns positive stop and disposal for every session it produces. */
export interface OpenedVoiceAdapter<K extends VoiceAdapterKind> {
  value: VoiceAdapterValues[K];
  fence(generation: VoiceGeneration): Promise<VoiceStopEvidence>;
  dispose(): Promise<void>;
}
/** Explicit configured values passed to a factory, after registered option parsing. */
export interface VoiceAdapterSelection { modelId: string; modelRevision: string; language: string; sampleRate: number; codec: VoiceAdapterManifest['codecs'][number]; voice?: { id: string; revision: string }; threshold?: number; options: Record<string, unknown> }
/** Scoped factory, separate from a legacy globally constructed provider instance. */
export interface ScopedVoiceAdapter<K extends VoiceAdapterKind = VoiceAdapterKind> {
  voiceAdapterVersion: 1; kind: K; manifest: VoiceAdapterManifest; options: z.ZodObject;
  /** Configuration-only construction; model work is performed through runtime.run by the returned adapter. */
  create(scope: VoiceScopeContext, selection: VoiceAdapterSelection, runtime: VoiceAdapterRuntime): Promise<OpenedVoiceAdapter<K>>;
}
/** Request capabilities valid only inside one authorized run callback. */
export interface VoiceAdapterRequest {
  grant: AttemptGrant; signal: AbortSignal;
  request(path: string, body: string): Promise<CheckedResponse>;
  stream(path: string, body: string): Promise<CheckedStreamResponse>;
}
/** Fixed-origin provider connection settings; mutable client input cannot replace these. */
export interface VoiceAdapterNetwork extends VoiceNetworkDependencies { origin?: string; credentialRef?: string }
/** The single call-scoped boundary below a pack's request/retry loop. */
export class VoiceAdapterRuntime {
  private readonly scope: VoiceScopeContext;
  private readonly active = new Set<Promise<unknown>>();
  private failure = false; private fencedEpoch = 0; private fencedInference = 0; private readonly controllers = new Map<AbortController, VoiceGeneration>();
  constructor(scope: VoiceScopeContext, private readonly providerId: string, private readonly purpose: VoiceProviderPurpose, private readonly budget: IAttemptAuthorizer, private readonly network: VoiceAdapterNetwork = {}) {
    this.scope = captureVoiceScope(scope);
    if (network.origin && new URL(network.origin).origin !== network.origin) throw new Error('adapter origin refused');
  }
  /** Authorizes exactly one provider attempt, including a new request made during an already open session. */
  async run<T>(identity: AudioIdentity, purpose: AttemptPurpose, work: (request: VoiceAdapterRequest) => Promise<{ value: T; usage: Record<string, number>; final: boolean }>, fence: (attemptId: string) => Promise<VoiceStopEvidence>): Promise<T> {
    requireVoiceScope(this.scope, identity.scopeId, identity.callId); if (this.failure) throw new Error('adapter fence incomplete'); identity = { ...identity, generation: { ...identity.generation } };
    await authorizeProviderOpening(this.scope.policy, this.purpose, undefined, this.providerId, 'primary', identity);
    const permission = this.scope.policy.providers.find((p) => p.providerId === this.providerId)!;
    if (this.blocked(identity.generation)) throw new Error('adapter generation fenced'); const abort = new AbortController(); this.controllers.set(abort, { ...identity.generation }); let grant: AttemptGrant; try { grant = await this.budget.authorize({ purpose, rateVersion: permission.priceVersion }); abort.signal.throwIfAborted(); this.scope.signal.throwIfAborted(); } catch (error) { this.controllers.delete(abort); throw error; }
    const signal = AbortSignal.any([this.scope.signal, abort.signal]); let live = true; let usedConnection = false;
    const input = async (path: string, body: string) => {
      if (!live || usedConnection) throw new Error('one connection per attempt'); usedConnection = true; signal.throwIfAborted();
      if (!this.network.origin || !/^\/[A-Za-z0-9/_-]*$/.test(path) || path.includes('//') || Buffer.byteLength(body) > 1048576) throw new Error('adapter path refused');
      const key = this.network.credentialRef ? await this.scope.credentials.resolve({ scopeId: this.scope.scopeId, callId: this.scope.callId, providerId: this.providerId, purpose: this.purpose, credentialRef: this.network.credentialRef, signal }) : undefined;
      if (this.network.credentialRef && !key) throw new Error('adapter credential missing');
      return { url: this.network.origin + path, method: 'POST' as const, body, signal, headers: { 'content-type': 'application/json', 'x-request-id': grant.attemptId, ...(key ? { authorization: `Bearer ${key}` } : {}) },
        policy: (this.scope.policy.mode === 'hosted' ? hostedEgressPolicy : localEgressPolicy)({ timeoutMs: 60000, maxResponseBytes: 1048576 }), lookup: this.network.lookup, connector: this.network.connector };
    };
    const request: VoiceAdapterRequest = { grant, signal, request: async (path, body) => checkedRequest(await input(path, body)), stream: async (path, body) => checkedStream(await input(path, body)) };
    let complete = false;
    const operation = (async () => {
      try {
        signal.throwIfAborted(); const result = await work(request);
        await this.budget.record(grant.attemptId, result.usage, result.final);
        if (Object.entries(result.usage).some(([unit, quantity]) => !Number.isSafeInteger(quantity) || quantity < 0 || quantity > (grant.maxQuantities[unit] ?? -1))) throw new Error('adapter usage bound');
        signal.throwIfAborted(); complete = result.final; return result.value;
      } finally {
        live = false; abort.abort();
        if (!complete) {
          try { const proof = await fence(grant.attemptId); if (proof.stopped !== true || !proof.evidenceRef) throw new Error('adapter fence incomplete'); }
          catch { this.failure = true; throw new Error('adapter fence incomplete'); }
        }
      }
    })(); this.active.add(operation);
    try { return await operation; } finally { this.active.delete(operation); this.controllers.delete(abort); }
  }
  /** Disposal waits for all requests, and never turns a failed fence into a successful idle result. */
  async whenIdle(): Promise<void> { await Promise.allSettled([...this.active]); if (this.failure) throw new Error('adapter fence incomplete'); } private blocked(g: VoiceGeneration): boolean { return g.transportEpoch < this.fencedEpoch || (g.transportEpoch === this.fencedEpoch && g.inferenceGeneration <= this.fencedInference); } /** Fences pending grants as well as active requests before native-stop acknowledgement. */ fenceGeneration(g: VoiceGeneration): void { if (g.workerGeneration !== this.scope.policy.identity.generation.workerGeneration) throw new Error('foreign generation'); if (g.transportEpoch > this.fencedEpoch) { this.fencedEpoch = g.transportEpoch; this.fencedInference = g.inferenceGeneration; } else if (g.transportEpoch === this.fencedEpoch) this.fencedInference = Math.max(this.fencedInference, g.inferenceGeneration); for (const [controller, generation] of this.controllers) if (this.blocked(generation)) controller.abort(); }
}
/** Validates public descriptor payloads read from an untyped extension registry. */
export function isScopedVoiceAdapter(value: unknown): value is ScopedVoiceAdapter {
  if (!value || typeof value !== 'object') return false;
  const a = value as Partial<ScopedVoiceAdapter>;
  return a.voiceAdapterVersion === 1 && ['streaming-stt', 'streaming-tts', 'batch-stt', 'batch-tts', 'vad-session', 'audio-endpoint'].includes(a.kind ?? '') && VoiceAdapterManifestSchema.safeParse(a.manifest).success && a.options instanceof z.ZodObject && typeof a.create === 'function';
}
