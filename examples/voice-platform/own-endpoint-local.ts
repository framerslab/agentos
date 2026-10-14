import { ReasoningProviderResolver, type RegisteredReasoningEndpoint, type ReasoningResolverOptions } from '../../src/io/voice-platform/ReasoningProviderResolver.js';
import { captureVoiceScope, type VoiceScopeContext } from '../../src/io/voice-platform/VoiceScopeContext.js';
import { VoiceToolRegistry } from '../../src/io/voice-platform/reasoning/tools.js';
import { ReasoningConfigSchema, type ReasoningConfig } from '../../src/io/voice-platform/contracts/index.js';
import { CountingAttemptBudget, type IAttemptAuthorizer } from '../../src/safety/runtime/ModelAttemptBudget.js';
/** Explicit local endpoint registration. The caller supplies the tokenizer and native-stop acknowledgement. */
export interface LocalEndpointExample extends Omit<ReasoningResolverOptions, 'registry'> {
  scope: VoiceScopeContext; endpoint: RegisteredReasoningEndpoint; limits: ReasoningConfig['attemptLimits'];
  text: string; prompt: string; onText?(text: string): void;
}
/** Actual usage observed by the protocol, not a fabricated zero on interruption. */
export interface LocalEndpointExampleResult { text: string; usage: Array<{ attemptId: string; quantities: Record<string, number>; final: boolean }> }
/** Runs an explicitly registered local endpoint, including private/loopback destinations under the local policy. */
export async function run(options: LocalEndpointExample): Promise<LocalEndpointExampleResult> {
  const scope = captureVoiceScope(options.scope); const endpoint = structuredClone(options.endpoint);
  if (scope.policy.mode !== 'local' || endpoint.locality !== 'local' || endpoint.scopeId !== scope.scopeId) throw new Error('explicit local endpoint required');
  const config = ReasoningConfigSchema.parse({ provider: 'registered_endpoint', endpointRef: endpoint.endpointRef, endpointRevision: endpoint.revision,
    ...(endpoint.credentialRef ? { credentialRef: endpoint.credentialRef } : {}), modelId: endpoint.modelId, modelRevision: endpoint.modelRevision,
    protocol: endpoint.protocol, usageUnits: endpoint.usageUnits, attemptLimits: options.limits, cancellation: endpoint.cancellation, fallbacks: [] });
  const usage: LocalEndpointExampleResult['usage'] = []; const counter = new CountingAttemptBudget(config.attemptLimits);
  const budget: IAttemptAuthorizer = { authorize: (request) => counter.authorize(request), record: async (attemptId, quantities, final) => {
    await counter.record(attemptId, quantities, final); usage.push({ attemptId, quantities: { ...quantities }, final });
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
