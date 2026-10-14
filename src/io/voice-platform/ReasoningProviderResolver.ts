import { z } from 'zod';
import { sealSecret, openSecret, type SealingKey } from '../../core/llm/auth/sealing.js';
import { ReasoningConfigSchema, type ReasoningConfig } from './contracts/index.js';
import { captureVoiceScope, requireVoiceScope, type VoiceScopeContext, type VoiceCredentialResolver } from './VoiceScopeContext.js';
import { authorizeProviderOpening } from '../voice-pipeline/ProviderPolicy.js';
import type { IVoicePipelineAgentSession, VoiceTurnMetadata, AudioIdentity } from '../voice-pipeline/types.js';
import type { IAttemptAuthorizer } from '../../safety/runtime/ModelAttemptBudget.js';
import type { AttemptPurpose } from '../../safety/runtime/CompoundCreditStore.js';
import { checkDestination, hostedEgressPolicy, localEgressPolicy } from '../../safety/egress/CheckedEgress.js';
import { openaiChatCompletions, type ReasoningMessage, type ReasoningToolCall } from './reasoning/openaiChatCompletions.js';
import { VoiceToolRegistry, type VoiceNetworkDependencies, type VoiceStopEvidence } from './reasoning/tools.js';
/** Immutable endpoint revision, stored without a plaintext credential. */
export interface RegisteredReasoningEndpoint {
  scopeId: string; endpointRef: string; revision: number; providerId: string; origin: string;
  protocol: { id: 'openai-chat-completions'; version: 1 }; modelId: string; modelRevision: string;
  locality: 'local' | 'remote'; manifestDigest?: string; credentialRef?: string;
  streaming: boolean; tools: boolean; cancellation: 'native_abort' | 'process_exit' | 'unsupported';
  usageUnits: ReasoningConfig['usageUnits']; rateVersion: string; conformanceRef: string;
  maxRequestBytes: number; maxResponseBytes: number; timeoutMs: number; reasoningEnabled: boolean;
}
/** Revision reads are scope-bound; implementations insert a new revision rather than overwrite one. */
export interface ReasoningEndpointRegistry {
  get(scopeId: string, ref: string, revision: number): Promise<RegisteredReasoningEndpoint | undefined>;
  local(scopeId: string, modelId: string, modelRevision: string, manifestDigest: string): Promise<RegisteredReasoningEndpoint | undefined>;
}
/** Tokenizer and native-control bindings are trusted host implementations verified with their endpoint revision. */
export interface ReasoningResolverOptions extends VoiceNetworkDependencies {
  registry: ReasoningEndpointRegistry;
  countInput(endpoint: Readonly<RegisteredReasoningEndpoint>, messages: readonly ReasoningMessage[], tools: readonly object[], scope: VoiceScopeContext): Promise<number>;
  fence(scope: VoiceScopeContext, endpoint: Readonly<RegisteredReasoningEndpoint>, attemptId: string, identity: AudioIdentity): Promise<VoiceStopEvidence>;
}
/** Stored recoverable secret; row substitution across scope/provider/reference fails authenticated decryption. */
export interface SealedVoiceCredential { scopeId: string; providerId: string; credentialRef: string; sealed: string; revoked: boolean }
const credentialContext = (scope: string, provider: string, ref: string): string => JSON.stringify(['voice-credential-v1', scope, provider, ref]);
/** Seals a newly registered credential using the existing AES-GCM primitive. */
export function sealVoiceCredential(scopeId: string, providerId: string, credentialRef: string, plain: string, key: SealingKey): SealedVoiceCredential {
  if (!scopeId || !providerId || !credentialRef || !plain) throw new Error('credential required');
  return { scopeId, providerId, credentialRef, revoked: false, sealed: sealSecret(plain, key.key, key.id, credentialContext(scopeId, providerId, credentialRef)) };
}
/** Supplies a scope-checking resolver over a host's credential store; no environment fallback. */
export function sealedVoiceCredentials(store: { read(scopeId: string, ref: string): Promise<SealedVoiceCredential | undefined> }, keys: readonly SealingKey[]): VoiceCredentialResolver {
  return { resolve: async (request) => {
    request.signal.throwIfAborted(); const row = await store.read(request.scopeId, request.credentialRef); request.signal.throwIfAborted();
    if (!row || row.revoked || row.scopeId !== request.scopeId || row.providerId !== request.providerId || row.credentialRef !== request.credentialRef) throw new Error('credential refused');
    const bytes = openSecret(row.sealed, keys, credentialContext(row.scopeId, row.providerId, row.credentialRef));
    try { return Buffer.from(bytes).toString('utf8'); } finally { bytes.fill(0); }
  } };
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
/** Resolve and freeze before provider I/O. There is no inline endpoint or secret in ReasoningConfig. */
export class ReasoningProviderResolver {
  constructor(private readonly options: ReasoningResolverOptions) {}
  /** Resolves one call's primary and explicitly allowed fallback revisions through the same local/hosted path. */
  async resolve(rawScope: VoiceScopeContext, rawConfig: ReasoningConfig, budget: IAttemptAuthorizer, prompt: string, tools: VoiceToolRegistry): Promise<ResolvedReasoningSession> {
    const scope = captureVoiceScope(rawScope); const config = ReasoningConfigSchema.parse(rawConfig);
    if (Buffer.byteLength(z.string().parse(prompt)) > 16384 || !config.usageUnits.reasoningInOutput || config.cancellation === 'unsupported') throw new Error('reasoning admission refused');
    if (config.fallbacks.length && scope.policy.fallback !== 'allowlisted') throw new Error('reasoning fallback refused');
    const endpoints: RegisteredReasoningEndpoint[] = [];
    for (const selection of [config, ...config.fallbacks]) {
      const found = selection.provider === 'registered_endpoint' ? await this.options.registry.get(scope.scopeId, selection.endpointRef, selection.endpointRevision)
        : await this.options.registry.local(scope.scopeId, selection.modelId, selection.modelRevision, selection.manifestDigest);
      if (!found) throw new Error('reasoning endpoint missing'); const endpoint = freeze(clone(found));
      const permission = scope.policy.providers.find((p) => p.providerId === endpoint.providerId && p.purposes.includes('reasoning'));
      const origin = new URL(endpoint.origin);
      if (!permission || !scope.policy.purposes.includes('reasoning') || permission.locality !== endpoint.locality || permission.priceVersion !== endpoint.rateVersion || endpoint.scopeId !== scope.scopeId || !endpoint.streaming || !endpoint.conformanceRef || endpoint.cancellation !== selection.cancellation || endpoint.cancellation === 'unsupported' || endpoint.modelId !== selection.modelId || endpoint.modelRevision !== selection.modelRevision || endpoint.protocol.id !== selection.protocol.id || endpoint.protocol.version !== selection.protocol.version || JSON.stringify(endpoint.usageUnits) !== JSON.stringify(selection.usageUnits) || !endpoint.usageUnits.reasoningInOutput || origin.origin !== endpoint.origin || (scope.policy.mode === 'local' && endpoint.locality !== 'local') || (scope.allowedToolRefs.length > 0 && !endpoint.tools)) throw new Error('reasoning endpoint refused');
      if (selection.provider === 'registered_endpoint' && (endpoint.endpointRef !== selection.endpointRef || endpoint.revision !== selection.endpointRevision || endpoint.credentialRef !== selection.credentialRef)) throw new Error('reasoning revision refused');
      if (selection.provider === 'local' && (endpoint.locality !== 'local' || endpoint.manifestDigest !== selection.manifestDigest)) throw new Error('reasoning manifest refused');
      if (![endpoint.maxRequestBytes, endpoint.maxResponseBytes, endpoint.timeoutMs].every((n) => Number.isSafeInteger(n) && n > 0) || endpoint.maxRequestBytes > 1048576 || endpoint.maxResponseBytes > 1048576 || endpoint.timeoutMs > 60000) throw new Error('reasoning bounds refused');
      await checkDestination(`${endpoint.origin}/v1/chat/completions`, (scope.policy.mode === 'hosted' ? hostedEgressPolicy : localEgressPolicy)(), this.options.lookup);
      endpoints.push(endpoint);
    }
    tools.definitions(scope); requireVoiceScope(scope, scope.scopeId, scope.callId);
    return new ResolvedReasoningSession(scope, freeze(config), endpoints, budget, prompt, tools, this.options);
  }
}
/** One call's bounded conversation. Abort cancels transport and whenIdle awaits positive provider/tool stop evidence. */
export class ResolvedReasoningSession implements IVoicePipelineAgentSession {
  private history: ReasoningMessage[];
  private controller?: AbortController;
  private idle: Promise<void> = Promise.resolve();
  private poisoned = false;
  constructor(private readonly scope: VoiceScopeContext, private readonly config: ReasoningConfig, private readonly endpoints: readonly RegisteredReasoningEndpoint[],
    private readonly budget: IAttemptAuthorizer, prompt: string, private readonly tools: VoiceToolRegistry, private readonly options: ReasoningResolverOptions) { this.history = [{ role: 'system', content: prompt }]; }
  /** Captures the pipeline's current identity; callers cannot replace policy, tools, endpoint or attempt budget. */
  async *sendText(text: string, metadata: VoiceTurnMetadata): AsyncIterable<string> {
    const identity = metadata.identity;
    requireVoiceScope(this.scope, identity?.scopeId ?? '', identity?.callId ?? '');
    if (!identity || this.controller || this.poisoned || Buffer.byteLength(text) > 32768 || identity.generation.workerGeneration !== this.scope.policy.identity.generation.workerGeneration) throw new Error('reasoning request refused');
    const controller = new AbortController(); this.controller = controller; const signal = AbortSignal.any([this.scope.signal, controller.signal]);
    let resolveIdle!: () => void; let rejectIdle!: (error: Error) => void;
    this.idle = new Promise<void>((resolve, reject) => { resolveIdle = resolve; rejectIdle = reject; }); this.idle.catch(() => {});
    const messages = clone([...this.history, { role: 'user' as const, content: text }]); let endpointIndex = 0; let purpose: AttemptPurpose = 'initial'; let prior: string | undefined;
    let escaped = false; let allComplete = false;
    try {
      for (;;) {
        signal.throwIfAborted(); const endpoint = this.endpoints[endpointIndex]!; const definitions = this.tools.definitions(this.scope);
        if (messages.length > 256 || Buffer.byteLength(JSON.stringify(messages)) > endpoint.maxRequestBytes) throw new Error('conversation bound');
        const inputTokens = await this.options.countInput(endpoint, messages, definitions, this.scope);
        if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || inputTokens > this.config.attemptLimits.perAttempt.input_token) throw new Error('reasoning input bound');
        const key = endpoint.credentialRef ? await this.scope.credentials.resolve({ ...this.scope, providerId: endpoint.providerId, purpose: 'reasoning', credentialRef: endpoint.credentialRef, signal }) : undefined;
        if (endpoint.credentialRef && !key) throw new Error('reasoning credential missing');
        await authorizeProviderOpening(this.scope.policy, 'reasoning', prior, endpoint.providerId, prior ? 'initialization_failed' : 'primary', identity);
        signal.throwIfAborted();
        const grant = await this.budget.authorize({ purpose, rateVersion: endpoint.rateVersion });
        const max = grant.maxQuantities;
        if (inputTokens > (max.input_token ?? -1) || (max.request ?? 0) < 1) throw new Error('reasoning grant bound');
        const outputCap = Math.min(this.config.attemptLimits.perAttempt.output_token, max.output_token ?? 0,
          endpoint.reasoningEnabled ? Math.min(this.config.attemptLimits.perAttempt.reasoning_token, max.reasoning_token ?? 0) : Number.MAX_SAFE_INTEGER);
        if (outputCap < 1) throw new Error('reasoning output bound');
        const body = JSON.stringify({ model: endpoint.modelId, messages, tools: definitions.length ? definitions : undefined, stream: true, stream_options: { include_usage: true }, max_completion_tokens: outputCap, n: 1 });
        if (Buffer.byteLength(body) > endpoint.maxRequestBytes) throw new Error('reasoning request bound');
        const attemptAbort = new AbortController(); const requestSignal = AbortSignal.any([signal, attemptAbort.signal]); let completed = false; let emitted = ''; let toolCalls: ReasoningToolCall[] = []; let failure: unknown;
        try {
          for await (const event of openaiChatCompletions({ url: `${endpoint.origin}/v1/chat/completions`, method: 'POST', body, signal: requestSignal,
            headers: { 'content-type': 'application/json', 'x-request-id': grant.attemptId, ...(key ? { authorization: `Bearer ${key}` } : {}) },
            policy: (this.scope.policy.mode === 'hosted' ? hostedEgressPolicy : localEgressPolicy)({ timeoutMs: endpoint.timeoutMs, maxResponseBytes: endpoint.maxResponseBytes }), lookup: this.options.lookup, connector: this.options.connector })) {
            signal.throwIfAborted();
            if (event.type === 'text') { emitted += event.text; if (Buffer.byteLength(emitted) > 32768) throw new Error('reasoning text bound'); escaped = true; yield event.text; }
            else {
              await this.budget.record(grant.attemptId, event.usage, true);
              if ((!endpoint.reasoningEnabled && event.usage.reasoning_token !== 0) || Object.entries(event.usage).some(([name, quantity]) => quantity > (max[name] ?? -1)) || event.usage.input_token! + event.usage.cached_input_token! > inputTokens) throw new Error('reasoning measured bound exceeded');
              completed = true; toolCalls = event.tools;
            }
          }
        } catch (error) { failure = error; }
        finally {
          attemptAbort.abort(); if (!completed) {
            try { const evidence = await this.options.fence(this.scope, endpoint, grant.attemptId, identity); if (evidence.stopped !== true || !evidence.evidenceRef) throw new Error('reasoning fence incomplete'); }
            catch { this.poisoned = true; throw new Error('reasoning fence incomplete'); }
          }
        }
        if (failure) {
          if (!escaped && !signal.aborted && endpointIndex + 1 < this.endpoints.length && this.scope.policy.fallback === 'allowlisted') { prior = endpoint.providerId; endpointIndex++; purpose = 'fallback'; continue; }
          throw new Error('reasoning request failed');
        }
        if (!completed) throw new Error('reasoning incomplete');
        messages.push({ role: 'assistant', content: emitted, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
        if (!toolCalls.length) { this.history = messages; allComplete = true; return; }
        for (const call of toolCalls) {
          signal.throwIfAborted(); escaped = true;
          const result = await this.tools.execute(this.scope, call.function.name, JSON.parse(call.function.arguments), `${grant.attemptId}:${call.id}`, signal);
          messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
        purpose = 'tool_continuation'; prior = undefined;
      }
    } catch (error) { if (error instanceof Error && error.message.includes('fence incomplete')) this.poisoned = true; throw error; }
    finally {
      controller.abort(); this.controller = undefined;
      if (!allComplete) messages.length = 0;
      if (this.poisoned) rejectIdle(new Error('reasoning fence incomplete')); else resolveIdle();
    }
  }
  /** Synchronous cancellation propagates to actual HTTP and tool work. */
  abort(): void { this.controller?.abort(); }
  /** Cleanup must await this promise; rejection is unresolved inference, never a released hold. */
  whenIdle(): Promise<void> { return this.idle; }
  /** Discards the call's bounded conversation after inference is fenced. */
  async dispose(): Promise<void> { this.abort(); await this.whenIdle(); this.history.length = 0; }
}
