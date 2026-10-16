/** Neutral, deterministic wire examples shared by schema and OpenAPI tests. */
export const reasoning = {
  provider: 'registered_endpoint', endpointRef: 'endpoint-a', endpointRevision: 1,
  credentialRef: 'credential-a', modelId: 'model-a', modelRevision: 'sha256:fixture-a',
  protocol: { id: 'openai-chat-completions', version: 1 },
  usageUnits: { input_token: 'token', output_token: 'token', reasoning_token: 'token', cached_input_token: 'token', reasoningInOutput: true },
  attemptLimits: { maxAttempts: 4, perAttempt: { input_token: 1024, output_token: 128, reasoning_token: 0, cached_input_token: 1024, request: 1 } },
  cancellation: 'native_abort', fallbacks: [],
};
/** An agent creation request, with every editable field explicit. */
export const createAgent = {
  name: 'Test agent', prompt: 'Answer briefly.', language: 'en', reasoning,
  voice: { id: 'voice-a', revision: 'sha256:voice-a' },
  stt: { providerId: 'stt-a', modelId: 'stt-model-a', modelRevision: 'sha256:stt-a', mode: 'streaming', sampleRate: 16000, codec: 'pcm_s16le' },
  tts: { providerId: 'tts-a', modelId: 'tts-model-a', modelRevision: 'sha256:tts-a', mode: 'streaming', sampleRate: 24000, codec: 'pcm_s16le' },
  vad: { providerId: 'vad-a', modelId: 'vad-model-a', modelRevision: 'sha256:vad-a', threshold: 0.5 },
  endpoint: { providerId: 'endpoint-a', modelId: 'endpoint-model-a', modelRevision: 'sha256:endpoint-a' },
  providerPolicy: { mode: 'hosted', providerIds: ['stt-a', 'tts-a', 'vad-a', 'endpoint-a'], purposes: ['stt', 'tts', 'vad', 'endpoint', 'reasoning'], fallback: 'none' },
  limits: { maxDurationSeconds: 600, setupTimeoutMs: 30000, reconnectGraceMs: 15000, silenceTimeoutMs: 30000, cleanupTimeoutMs: 30000, maxTurns: 64 },
  allowedToolRefs: [], transcriptPolicy: { mode: 'none' }, webhookRef: null,
};
/** A prepared call, with a durable initiating principal and no served usage. */
export const voiceCall = {
  version: 1, callId: 'call-a', scopeId: 'scope-a',
  initiatingPrincipal: { kind: 'service_key', principalId: 'key-a', issuerRef: 'principal-a' },
  agentId: 'agent-a', agentRevision: 1, requestId: 'request-a', state: 'prepared',
  createdAt: 1000, startedAt: null, endedAt: null, connectionTimeline: [],
  workerGeneration: 0, inferenceGeneration: 0, transportEpoch: 0,
  attemptAllowance: { limits: reasoning.attemptLimits, authorizedAttempts: 0 },
  endReason: null, usage: { connectedMs: 0, billableSeconds: 0, supplierComponents: [] },
  rateVersion: 'rates-a', contentRetention: { state: 'none', expiresAt: null },
};
/** A terminal event payload without transcript content or cost. */
export const ended = {
  durationMs: 61000, connectedSeconds: 60, endReason: 'client_stop',
  transcript: { availability: 'unavailable', reason: 'not_retained' },
};
/** One valid example for each named schema; none contains a real credential. */
export const contractExamples = {
  VoiceAgent: { version: 1, agentId: 'agent-a', scopeId: 'scope-a', revision: 1, state: 'active', createdAt: 1000, updatedAt: 1000, ...createAgent },
  CreateAgent: createAgent,
  UpdateAgent: { expectedRevision: 1, changes: { name: 'Renamed agent' } },
  VoiceCall: voiceCall,
  CreateWebCall: { agentId: 'agent-a', maxDurationSeconds: 600, clientOrigin: 'https://client.example.test', proofKeyThumbprint: 'a'.repeat(43), idempotencyKey: 'create-a' },
  WebCallConnection: { transport: 'websocket', url: 'wss://media.example.test/web-calls/call-a/media', token: 'not-a-real-media-token', callId: 'call-a', expiresAt: 121000, transportEpoch: 1, controlCredential: { kind: 'call_control', token: 'not-a-real-control-token', expiresAt: 121000, operations: ['stop', 'renew_control'] } },
  CallEvent: { version: 1, eventId: 'event-a', scopeId: 'scope-a', callId: 'call-a', workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1, sequence: 1, type: 'call.started', occurredAt: 1000, payload: { agentId: 'agent-a', agentRevision: 1, connectedAt: 1000 } },
  UsageRecord: { version: 1, scopeId: 'scope-a', operationId: 'call-a', productKind: 'voice_call', connectedMs: 60000, billableSeconds: 60, supplierComponents: [{ component: 'input_token', unit: 'token', quantity: 25, providerId: 'model-provider-a', attemptId: 'attempt-a', status: 'complete' }], terminalReason: 'client_stop', final: true },
  CallEndedPayload: ended,
  ReasoningConfig: reasoning,
};
