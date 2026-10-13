/**
 * Closed v1 wire contracts. Parsing checks shape, never authorization. Hosts derive scope and
 * principal from authentication; managers enforce revisions, monotonicity and lifecycle transitions.
 * No schema imports storage, money arithmetic, a provider, Node or a native runtime.
 * @module io/voice-platform/contracts
 */
import { z } from 'zod';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const revisionRef = z.string().min(1).max(256);
const token = z.string().min(1).max(8192);
const language = z.string().min(2).max(64).regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/);
const protocol = z.strictObject({ id: z.literal('openai-chat-completions'), version: z.literal(1) });
const prompt = z.string().max(16384)
  .refine((text) => new TextEncoder().encode(text).byteLength <= 16384, 'prompt exceeds 16384 UTF-8 bytes')
  .meta({ 'x-maxUtf8Bytes': 16384, description: 'At most 16384 UTF-8 bytes; servers parse the canonical runtime schema.' });

/** An opaque cursor; the store authenticates its scope, filter and ordering binding. */
export const CursorSchema = z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/);
/** Transport selected explicitly by the server. */
export const CallTransportSchema = z.enum(['livekit', 'websocket']);
/** Durable states owned by the call manager. */
export const VoiceCallStateSchema = z.enum(['prepared', 'connecting', 'connected', 'reconnecting', 'ending', 'ended', 'failed']);
/** Stable terminal reasons. No provider error text or caller content belongs here. */
export const CallEndReasonSchema = z.enum([
  'client_stop', 'agent_completion', 'duration_limit', 'silence_limit', 'budget_exhausted',
  'turn_limit', 'workspace_stopped', 'agent_stopped', 'key_revoked', 'participant_disconnected',
  'setup_timeout', 'provider_failure', 'transport_failure', 'sink_failure', 'worker_lost', 'deployment', 'purged',
]);
/** The immutable authority that initiated a call; issuerRef may remain as an opaque tombstone. */
export const InitiatingPrincipalSchema = z.strictObject({
  kind: z.enum(['member', 'service_key', 'demo']), principalId: id, issuerRef: id.optional(),
});
/** Attempt quantities use the same component names as the credit ledger, without importing it. */
export const AttemptQuantitiesSchema = z.strictObject({
  input_token: count, output_token: count, reasoning_token: count, cached_input_token: count, request: count,
});
/** Explicit aggregate and per-attempt ceilings, with no default allowance. */
export const ModelAttemptLimitsSchema = z.strictObject({ maxAttempts: positive, perAttempt: AttemptQuantitiesSchema });
/** Declared usage units and the rule preventing reasoning tokens from being counted twice. */
export const ReasoningUsageUnitsSchema = z.strictObject({
  input_token: z.literal('token'), output_token: z.literal('token'), reasoning_token: z.literal('token'),
  cached_input_token: z.literal('token'), reasoningInOutput: z.boolean(),
});
const reasoningCommon = {
  modelId: id, modelRevision: revisionRef, protocol,
  usageUnits: ReasoningUsageUnitsSchema, attemptLimits: ModelAttemptLimitsSchema,
  cancellation: z.enum(['native_abort', 'process_exit', 'unsupported']),
};
const localReasoning = z.strictObject({ provider: z.literal('local'), ...reasoningCommon, manifestDigest: revisionRef });
const registeredReasoning = z.strictObject({
  provider: z.literal('registered_endpoint'), ...reasoningCommon,
  endpointRef: id, endpointRevision: positive, credentialRef: id.optional(),
});
/** A fully specified fallback, with its own immutable model and endpoint capability references. */
export const ReasoningFallbackSchema = z.discriminatedUnion('provider', [localReasoning, registeredReasoning]);
/** Local or registered reasoning. Hosted admission verifies references, cancellation and usage support. */
export const ReasoningConfigSchema = z.discriminatedUnion('provider', [
  localReasoning.extend({ fallbacks: z.array(ReasoningFallbackSchema).max(8) }),
  registeredReasoning.extend({ fallbacks: z.array(ReasoningFallbackSchema).max(8) }),
]);
/** Explicit provider policy. The legacy environment-discovery policy cannot cross this boundary. */
export const VoiceProviderPolicySchema = z.strictObject({
  mode: z.enum(['local', 'hosted', 'provider']), providerIds: z.array(id).min(1).max(64),
  purposes: z.array(z.enum(['stt', 'tts', 'vad', 'endpoint', 'reasoning'])).min(1).max(5),
  fallback: z.enum(['none', 'allowlisted']),
});
/** A selected immutable voice. */
export const VoiceSelectionSchema = z.strictObject({ id, revision: revisionRef });
/** Speech configuration declares batch versus streaming honestly. Options are registered references. */
export const SpeechSelectionSchema = z.strictObject({
  providerId: id, modelId: id, modelRevision: revisionRef, mode: z.enum(['streaming', 'batch']),
  sampleRate: z.number().int().min(8000).max(192000), codec: z.enum(['pcm_s16le', 'pcm_f32le', 'opus', 'mp3', 'wav']),
  optionsRef: id.optional(), credentialRef: id.optional(),
});
/** A selected VAD model and threshold, owned as a session by the factory. */
export const VadSelectionSchema = z.strictObject({
  providerId: id, modelId: id, modelRevision: revisionRef, threshold: z.number().min(0).max(1), optionsRef: id.optional(),
});
/** A selected endpoint model; its registered descriptor supplies the bounded audio-window policy. */
export const EndpointSelectionSchema = z.strictObject({ providerId: id, modelId: id, modelRevision: revisionRef, optionsRef: id.optional() });
/** Explicit local policy values. Hosted commercial ceilings are checked by the admitting host. */
export const VoiceCallLimitsSchema = z.strictObject({
  maxDurationSeconds: positive, setupTimeoutMs: positive, reconnectGraceMs: count,
  silenceTimeoutMs: positive, cleanupTimeoutMs: positive, maxTurns: positive,
});
/** Transcript retention or transient delivery, with an explicit lifetime and no audio storage. */
export const TranscriptPolicySchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none') }),
  z.strictObject({ mode: z.literal('delivery'), deliveryTtlSeconds: positive }),
  z.strictObject({ mode: z.literal('retained'), retentionSeconds: positive }),
]);
const editable = {
  name: z.string().min(1).max(128), prompt, language, reasoning: ReasoningConfigSchema,
  voice: VoiceSelectionSchema, stt: SpeechSelectionSchema, tts: SpeechSelectionSchema,
  vad: VadSelectionSchema, endpoint: EndpointSelectionSchema, providerPolicy: VoiceProviderPolicySchema,
  limits: VoiceCallLimitsSchema, allowedToolRefs: z.array(id).max(32),
  transcriptPolicy: TranscriptPolicySchema, webhookRef: id.nullable(),
};
/** Creation accepts editable values only. Scope, id, revision and timestamps come from the host. */
export const CreateAgentSchema = z.strictObject(editable);
/** Partial editable fields, isolated from stored identity and authority. */
export const AgentChangesSchema = z.strictObject(editable).partial();
/** Optimistic update; a mismatch is a conflict and active calls keep their captured revision. */
export const UpdateAgentSchema = z.strictObject({ expectedRevision: positive, changes: AgentChangesSchema });
/** Stored immutable agent revision. Archive changes admission, never an active call's snapshot. */
export const VoiceAgentSchema = z.strictObject({
  version: z.literal(1), agentId: id, scopeId: id, revision: positive, state: z.enum(['active', 'archived']),
  createdAt: count, updatedAt: count, ...editable,
});
/** One authoritative connected interval; null end is open. The meter computes the union. */
export const ConnectionIntervalSchema = z.strictObject({
  intervalId: id, workerGeneration: positive, transportEpoch: positive, startedAt: count, endedAt: count.nullable(),
});
/** Supplier quantity. Missing final usage remains pending; this object never carries a tariff. */
export const SupplierUsageComponentSchema = z.strictObject({
  component: id, unit: z.enum(['second', 'millisecond', 'token', 'character', 'sample', 'request']),
  quantity: count, providerId: id, attemptId: id.optional(), generation: count.optional(),
  status: z.enum(['pending', 'complete', 'cancelled', 'failed']),
});
/** Cumulative quantities. Billable seconds are rounded once from acknowledged connected milliseconds. */
export const CallUsageSchema = z.strictObject({
  connectedMs: count, billableSeconds: count, supplierComponents: z.array(SupplierUsageComponentSchema).max(4096),
});
/** One progressively updated scope/operation usage row, settled once by its owning manager. */
export const UsageRecordSchema = z.strictObject({
  version: z.literal(1), scopeId: id, operationId: id, productKind: z.enum(['voice_call', 'meeting_bot']),
  ...CallUsageSchema.shape, terminalReason: CallEndReasonSchema.nullable(), final: z.boolean(),
});
/** Aggregate attempts survive reconnection; the manager enforces authorizedAttempts <= limits.maxAttempts. */
export const CallAttemptAllowanceSchema = z.strictObject({ limits: ModelAttemptLimitsSchema, authorizedAttempts: count });
/** Content-free retention state; key material and transcript text belong to separate stores. */
export const ContentRetentionSchema = z.strictObject({
  state: z.enum(['none', 'delivery_pending', 'retained', 'revoking', 'purged', 'expired']), expiresAt: count.nullable(),
});
/** Durable call metadata. Authentication and lifecycle guards enforce its immutable relationships. */
export const VoiceCallSchema = z.strictObject({
  version: z.literal(1), callId: id, scopeId: id, initiatingPrincipal: InitiatingPrincipalSchema,
  agentId: id, agentRevision: positive, requestId: id, state: VoiceCallStateSchema,
  createdAt: count, startedAt: count.nullable(), endedAt: count.nullable(),
  connectionTimeline: z.array(ConnectionIntervalSchema).max(4096),
  workerGeneration: count, inferenceGeneration: count, transportEpoch: count,
  attemptAllowance: CallAttemptAllowanceSchema, endReason: CallEndReasonSchema.nullable(),
  usage: CallUsageSchema, rateVersion: id, contentRetention: ContentRetentionSchema,
});
/** A canonical HTTP(S) origin. Local applications may use HTTP; hosted admission applies its origin policy. */
export const ClientOriginSchema = z.string().min(1).max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && value === url.origin && !url.username && !url.password;
  } catch { return false; }
}, 'expected a canonical HTTP(S) origin').meta({ 'x-canonicalOrigin': true });
/** SHA-256 proof-key thumbprint encoded as unpadded base64url. The credential verifier validates the proof. */
export const ProofKeyThumbprintSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** Creation requests carry no scope, principal, pricing or reservation fields. */
export const CreateWebCallSchema = z.strictObject({
  agentId: id, maxDurationSeconds: positive, clientOrigin: ClientOriginSchema,
  proofKeyThumbprint: ProofKeyThumbprintSchema, idempotencyKey: id,
});
/** Narrow control credential. It grants only stop and renewal for its bound call, never account APIs. */
export const CallControlCredentialSchema = z.strictObject({
  kind: z.literal('call_control'), token, expiresAt: count,
  operations: z.tuple([z.literal('stop'), z.literal('renew_control')]),
});
/** Media connection result. Credentials are returned in bodies and never embedded in the URL. */
export const WebCallConnectionSchema = z.strictObject({
  transport: CallTransportSchema,
  url: z.string().min(1).max(2048).refine((value) => {
    try { const u = new URL(value); return ['ws:', 'wss:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }
    catch { return false; }
  }, 'expected a credential-free WebSocket URL').meta({ 'x-mediaUrl': true }),
  token, callId: id, expiresAt: count, transportEpoch: positive, controlCredential: CallControlCredentialSchema,
});
/** A bounded transcript segment for authorized delivery, separate from content-free call metadata. */
export const TranscriptSegmentSchema = z.strictObject({
  turnId: id, role: z.enum(['user', 'assistant']), text: z.string().max(32768),
  startedAt: count, endedAt: count, interrupted: z.boolean(),
});
/** Whether a terminal delivery contains content, references retained content, or has no content. */
export const TranscriptAvailabilitySchema = z.discriminatedUnion('availability', [
  z.strictObject({ availability: z.literal('unavailable'), reason: z.enum(['not_retained', 'purged', 'expired', 'pending']) }),
  z.strictObject({ availability: z.literal('retained'), transcriptRef: id, expiresAt: count }),
  z.strictObject({ availability: z.literal('delivery'), segments: z.array(TranscriptSegmentSchema).max(4096) }),
]);
/** Optional host-supplied monetary extension; the quantity contract does not compute these values. */
export const CallCostBreakdownSchema = z.strictObject({
  currency: z.literal('USD'), rateVersion: id, customerMicro: count, supplierMicro: count,
  components: z.array(z.strictObject({ component: id, customerMicro: count, supplierMicro: count })).max(128),
});
/** Ended and failed calls report actual served quantities, including zero for an unconnected call. */
export const CallEndedPayloadSchema = z.strictObject({
  durationMs: count, connectedSeconds: count, endReason: CallEndReasonSchema,
  transcript: TranscriptAvailabilitySchema, cost: CallCostBreakdownSchema.optional(),
});
/** First media-ready event payload. A reconnect cannot create another started event. */
export const CallStartedPayloadSchema = z.strictObject({ agentId: id, agentRevision: positive, connectedAt: count });
const eventFields = {
  version: z.literal(1), eventId: id, scopeId: id, callId: id,
  workerGeneration: count, inferenceGeneration: count, transportEpoch: count,
  sequence: positive, occurredAt: count,
};
/** Lifecycle events only. Typed transcript/provider events use their own scoped channels. */
export const CallEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...eventFields, type: z.literal('call.started'), payload: CallStartedPayloadSchema }),
  z.strictObject({ ...eventFields, type: z.literal('call.ended'), payload: CallEndedPayloadSchema }),
  z.strictObject({ ...eventFields, type: z.literal('call.failed'), payload: CallEndedPayloadSchema }),
]);

/** Agent revision parsed from VoiceAgentSchema. */
export type VoiceAgent = z.infer<typeof VoiceAgentSchema>;
/** Editable creation request. */
export type CreateAgent = z.infer<typeof CreateAgentSchema>;
/** Optimistic update request. */
export type UpdateAgent = z.infer<typeof UpdateAgentSchema>;
/** Durable call metadata. */
export type VoiceCall = z.infer<typeof VoiceCallSchema>;
/** Server-authorized call creation request. */
export type CreateWebCall = z.infer<typeof CreateWebCallSchema>;
/** Media and control exchange result. */
export type WebCallConnection = z.infer<typeof WebCallConnectionSchema>;
/** Scoped lifecycle event union. */
export type CallEvent = z.infer<typeof CallEventSchema>;
/** Quantity-only usage record. */
export type UsageRecord = z.infer<typeof UsageRecordSchema>;
/** Terminal delivery payload. */
export type CallEndedPayload = z.infer<typeof CallEndedPayloadSchema>;
/** Local or registered reasoning selection. */
export type ReasoningConfig = z.infer<typeof ReasoningConfigSchema>;
/** Durable principal reference. */
export type InitiatingPrincipal = z.infer<typeof InitiatingPrincipalSchema>;
/** Stable terminal reason. */
export type CallEndReason = z.infer<typeof CallEndReasonSchema>;
/** Durable call state. */
export type VoiceCallState = z.infer<typeof VoiceCallStateSchema>;
/** Selected transport. */
export type CallTransport = z.infer<typeof CallTransportSchema>;
/** One acknowledged connection interval. */
export type ConnectionInterval = z.infer<typeof ConnectionIntervalSchema>;
/** Cumulative quantities. */
export type CallUsage = z.infer<typeof CallUsageSchema>;
/** A supplier component's measured quantity. */
export type SupplierUsageComponent = z.infer<typeof SupplierUsageComponentSchema>;
/** Explicit attempt limits. */
export type ModelAttemptLimits = z.infer<typeof ModelAttemptLimitsSchema>;
/** One permitted reasoning fallback. */
export type ReasoningFallback = z.infer<typeof ReasoningFallbackSchema>;
/** Provider selection policy. */
export type VoiceProviderPolicy = z.infer<typeof VoiceProviderPolicySchema>;
/** Explicit call policy limits. */
export type VoiceCallLimits = z.infer<typeof VoiceCallLimitsSchema>;
/** Narrow HTTP control authority. */
export type CallControlCredential = z.infer<typeof CallControlCredentialSchema>;
/** Transcript storage/delivery policy. */
export type TranscriptPolicy = z.infer<typeof TranscriptPolicySchema>;
/** Content-free retention marker. */
export type ContentRetention = z.infer<typeof ContentRetentionSchema>;
/** One authorized transcript segment. */
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

/** Named top-level contract schemas, consumed directly by tests and the OpenAPI builder. */
export const VOICE_CONTRACT_SCHEMAS = {
  VoiceAgent: VoiceAgentSchema, CreateAgent: CreateAgentSchema, UpdateAgent: UpdateAgentSchema,
  VoiceCall: VoiceCallSchema, CreateWebCall: CreateWebCallSchema, WebCallConnection: WebCallConnectionSchema,
  CallEvent: CallEventSchema, UsageRecord: UsageRecordSchema, CallEndedPayload: CallEndedPayloadSchema,
  ReasoningConfig: ReasoningConfigSchema,
} as const;
