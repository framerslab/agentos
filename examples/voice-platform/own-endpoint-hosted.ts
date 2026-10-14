import { ReasoningProviderResolver, sealedVoiceCredentials, type RegisteredReasoningEndpoint, type ReasoningResolverOptions, type SealedVoiceCredential } from '../../src/io/voice-platform/ReasoningProviderResolver.js';
import { captureVoiceScope, type VoiceScopeContext } from '../../src/io/voice-platform/VoiceScopeContext.js';
import { VoiceToolRegistry } from '../../src/io/voice-platform/reasoning/tools.js';
import { ReasoningConfigSchema, type ReasoningConfig } from '../../src/io/voice-platform/contracts/index.js';
import { ModelAttemptBudget, type IAttemptAuthorizer } from '../../src/safety/runtime/ModelAttemptBudget.js';
import type { ICompoundCreditStore } from '../../src/safety/runtime/CompoundCreditStore.js';
import type { SealingKey } from '../../src/core/llm/auth/sealing.js';
/** Hosted registration references an already reserved hold and encrypted scoped credentials. */
export interface HostedEndpointExample extends Omit<ReasoningResolverOptions, 'registry'> {
  scope: VoiceScopeContext; endpoint: RegisteredReasoningEndpoint; limits: ReasoningConfig['attemptLimits']; text: string; prompt: string;
  store: ICompoundCreditStore; holdId: string; sealingKeys: readonly SealingKey[];
  credentialStore: { read(scopeId: string, credentialRef: string): Promise<SealedVoiceCredential | undefined> };
  onText?(text: string): void;
}
/** Declared protocol usage, retained independently of transport playback. */
export interface HostedEndpointExampleResult { text: string; usage: Array<{ attemptId: string; quantities: Record<string, number>; final: boolean }> }
/** Runs the same resolver with hosted egress, sealed secrets and a real every-attempt ledger authorizer. */
export async function run(options: HostedEndpointExample): Promise<HostedEndpointExampleResult> {
  const scope = captureVoiceScope({ ...options.scope, credentials: sealedVoiceCredentials(options.credentialStore, options.sealingKeys) });
  const endpoint = structuredClone(options.endpoint);
  if (scope.policy.mode !== 'hosted' || endpoint.scopeId !== scope.scopeId || !endpoint.credentialRef) throw new Error('hosted endpoint registration required');
  const hold = await options.store.withTransaction((tx) => tx.getHold(options.holdId));
  if (!hold || hold.scopeId !== scope.scopeId || hold.operationId !== scope.callId || hold.kind !== 'call' || hold.state !== 'held' || hold.expiresAt <= Date.now()) throw new Error('scoped live hold required');
  const config = ReasoningConfigSchema.parse({ provider: 'registered_endpoint', endpointRef: endpoint.endpointRef, endpointRevision: endpoint.revision,
    credentialRef: endpoint.credentialRef, modelId: endpoint.modelId, modelRevision: endpoint.modelRevision, protocol: endpoint.protocol,
    usageUnits: endpoint.usageUnits, attemptLimits: options.limits, cancellation: endpoint.cancellation, fallbacks: [] });
  const heldLimits = JSON.parse(hold.attemptLimits) as { maxAttempts: number; perAttempt: Record<string, number> };
  if (heldLimits.maxAttempts !== config.attemptLimits.maxAttempts || Object.entries(config.attemptLimits.perAttempt).some(([unit, count]) => heldLimits.perAttempt[unit] !== count)) throw new Error('hold attempt limits differ');
  const usage: HostedEndpointExampleResult['usage'] = []; const ledger = new ModelAttemptBudget({ store: options.store, holdId: options.holdId });
  const budget: IAttemptAuthorizer = { authorize: (request) => ledger.authorize(request), record: async (attemptId, quantities, final) => {
    await ledger.record(attemptId, quantities, final); usage.push({ attemptId, quantities: { ...quantities }, final });
  } };
  const resolver = new ReasoningProviderResolver({ lookup: options.lookup, connector: options.connector, countInput: options.countInput, fence: options.fence,
    registry: { get: async (scopeId, ref, revision) => scopeId === scope.scopeId && ref === endpoint.endpointRef && revision === endpoint.revision ? endpoint : undefined, local: async () => undefined } });
  const session = await resolver.resolve(scope, config, budget, options.prompt, new VoiceToolRegistry([])); let text = '';
  try {
    for await (const delta of session.sendText(options.text, { identity: scope.policy.identity, speakers: [], endpointReason: 'manual', speechDurationMs: 0, wasInterrupted: false, transcriptConfidence: 1 })) {
      text += delta; options.onText?.(delta); scope.signal.throwIfAborted();
    }
    await session.whenIdle(); return { text, usage };
  } finally { await session.dispose(); }
}
