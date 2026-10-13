/**
 * @fileoverview Core types for the AgentOS Voice Call System.
 *
 * Voice calls enable agents to make and receive phone calls via telephony
 * providers (Twilio, Telnyx, Plivo). This module defines the call lifecycle
 * state machine, event types, and configuration.
 *
 * ## Call lifecycle state machine
 *
 * ```
 *                   ┌──────────────────────────────────────────────┐
 *                   │             Terminal states                   │
 *                   │  completed | hangup-user | hangup-bot        │
 *                   │  timeout | error | failed | no-answer        │
 *                   │  busy | voicemail                            │
 *                   └───────────────────────────────────────▲──────┘
 *                                                           │ (from any non-terminal)
 *  initiated ──► ringing ──► answered ──► active ──► speaking ◄──► listening
 *       (monotonic forward-only)                    (can cycle)
 * ```
 *
 * Modeled after OpenClaw's voice-call extension architecture with adaptations
 * for the AgentOS extension pack pattern.
 *
 * @module @framers/agentos/voice/types
 */

// ============================================================================
// Provider Identification
// ============================================================================

/**
 * Supported telephony providers.
 *
 * The explicit literals enable autocomplete and exhaustiveness checking while
 * the `(string & {})` arm keeps the type open for future providers without
 * requiring a code change.
 */
export type VoiceProviderName =
  | 'twilio'
  | 'telnyx'
  | 'plivo'
  | 'mock'
  | (string & {});

// ============================================================================
// Call State Machine
// ============================================================================

/**
 * States a voice call can be in.
 *
 * Transitions follow a monotonic order
 * (`initiated` -> `ringing` -> `answered` -> `active` -> `speaking`/`listening`),
 * except `speaking` <-> `listening` which can cycle during conversation turns.
 * Terminal states can be reached from **any** non-terminal state.
 *
 * ## Non-terminal states (forward-only progression)
 * - `initiated` -- Call record created, provider request sent.
 * - `ringing`   -- Provider confirmed the destination phone is ringing.
 * - `answered`  -- Callee picked up; media channel not yet established.
 * - `active`    -- Bidirectional media stream is established.
 *
 * ## Conversation cycling states (can alternate freely)
 * - `speaking`  -- Agent TTS is playing audio to the caller.
 * - `listening` -- Agent STT is listening for caller speech.
 *
 * ## Terminal states (once reached, no further transitions)
 * - `completed`   -- Normal call completion (both parties done).
 * - `hangup-user` -- The remote caller hung up.
 * - `hangup-bot`  -- The agent initiated the hangup.
 * - `timeout`     -- Call exceeded `maxDurationSeconds`.
 * - `error`       -- Unrecoverable error during the call.
 * - `failed`      -- Provider could not place the call at all.
 * - `no-answer`   -- Callee did not pick up within the ring timeout.
 * - `busy`        -- Callee line is busy.
 * - `voicemail`   -- Answering machine / voicemail detected.
 */
export type CallState =
  // Non-terminal (forward-only progression)
  | 'initiated'
  | 'ringing'
  | 'answered'
  | 'active'
  // Conversation cycling (can alternate)
  | 'speaking'
  | 'listening'
  // Terminal states
  | 'completed'
  | 'hangup-user'
  | 'hangup-bot'
  | 'timeout'
  | 'error'
  | 'failed'
  | 'no-answer'
  | 'busy'
  | 'voicemail';

/**
 * Set of terminal call states -- once reached, no further transitions are
 * allowed by the {@link CallManager} state machine.
 *
 * Used for guard checks: `if (TERMINAL_CALL_STATES.has(call.state)) return;`
 */
export const TERMINAL_CALL_STATES = new Set<CallState>([
  'completed',
  'hangup-user',
  'hangup-bot',
  'timeout',
  'error',
  'failed',
  'no-answer',
  'busy',
  'voicemail',
]);

/**
 * States that can cycle during multi-turn conversations.
 *
 * The state machine allows free transitions between these two states so that
 * the agent can alternate between speaking and listening without violating
 * monotonic ordering.
 */
export const CONVERSATION_STATES = new Set<CallState>(['speaking', 'listening']);

/**
 * Non-terminal state order for monotonic transition enforcement.
 *
 * The {@link CallManager} only allows a forward transition when
 * `STATE_ORDER.indexOf(newState) > STATE_ORDER.indexOf(currentState)`.
 * This prevents impossible regressions like `answered` -> `ringing`.
 */
export const STATE_ORDER: readonly CallState[] = [
  'initiated',
  'ringing',
  'answered',
  'active',
  'speaking',
  'listening',
];

// ============================================================================
// Call Modes
// ============================================================================

/**
 * How the agent interacts during a call:
 * - `notify`: Speak a message and hang up (one-way TTS).
 * - `conversation`: Full duplex conversation with STT + LLM + TTS loop.
 */
export type CallMode = 'notify' | 'conversation';

/**
 * Call direction.
 */
export type CallDirection = 'outbound' | 'inbound';

/**
 * Inbound call policy -- how the agent handles incoming calls.
 * - `disabled`: Reject all inbound calls.
 * - `allowlist`: Only accept from allowed numbers.
 * - `pairing`: Accept and pair with agent owner.
 * - `open`: Accept all inbound calls.
 */
export type InboundPolicy = 'disabled' | 'allowlist' | 'pairing' | 'open';

// ============================================================================
// Transcript
// ============================================================================

/** A single entry in a call transcript. */
export interface TranscriptEntry {
  /** Unix timestamp (ms) when this was recorded. */
  timestamp: number;
  /** Who spoke. */
  speaker: 'bot' | 'user';
  /** The spoken text. */
  text: string;
  /** Whether this is a finalized transcript (vs. partial/streaming). */
  isFinal: boolean;
}

// ============================================================================
// Call Record
// ============================================================================

/** Opaque call identifier. */
export type CallId = string;

/**
 * Full record of a voice call -- used for tracking, persistence, and status queries.
 */
export interface CallRecord {
  /** Unique call identifier (UUID). */
  callId: CallId;
  /** Provider-assigned call ID (e.g., Twilio CallSid). */
  providerCallId?: string;
  /** Creation request identity when distinct from the actual call leg. */
  providerRequestId?: string;
  /** Which provider is handling this call. */
  provider: VoiceProviderName;
  /** Current state in the call lifecycle. */
  state: CallState;
  /** Call direction. */
  direction: CallDirection;
  /** Call interaction mode. */
  mode: CallMode;
  /** E.164 phone number of the caller. */
  fromNumber: string;
  /** E.164 phone number being called. */
  toNumber: string;
  /** Agent seed ID (if bound to a specific agent). */
  seedId?: string;
  /** Conversation transcript. */
  transcript: TranscriptEntry[];
  /** IDs of webhook events already processed (idempotency). */
  processedEventIds: string[];
  /** Stream SID for media streams (Twilio-specific). */
  streamSid?: string;
  /** Unix timestamp (ms) when the call was created. */
  createdAt: number;
  /** Unix timestamp (ms) when the call reached a terminal state. */
  endedAt?: number;
  /** Error message if state is 'error' or 'failed'. */
  errorMessage?: string;
  /** Provider-specific metadata. */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Normalized Events (from providers)
// ============================================================================

/**
 * Normalized webhook event from any telephony provider.
 *
 * Uses a discriminated union on the `kind` field so consumers can narrow
 * with a `switch (event.kind)` and get full type safety for each variant's
 * payload.
 *
 * Provider-specific webhook formats (Twilio form-encoded, Telnyx JSON,
 * Plivo URL-encoded/JSON) are all mapped into these canonical shapes by
 * each provider's {@link IVoiceCallProvider.parseWebhookEvent} implementation.
 */
export type NormalizedCallEvent =
  | NormalizedCallRinging
  | NormalizedCallAnswered
  | NormalizedCallCompleted
  | NormalizedCallFailed
  | NormalizedCallBusy
  | NormalizedCallNoAnswer
  | NormalizedCallVoicemail
  | NormalizedCallHangupUser
  | NormalizedCallError
  | NormalizedTranscript
  | NormalizedSpeechStart
  | NormalizedMediaStreamConnected
  | NormalizedDtmfReceived;

/**
 * Common fields shared by every normalized event variant.
 *
 * These fields enable idempotent processing ({@link eventId}), call record
 * lookup ({@link providerCallId}), and chronological ordering ({@link timestamp}).
 */
interface NormalizedEventBase {
  /** Provider-assigned event ID for idempotency. */
  eventId: string;
  /** Provider-assigned call ID. */
  providerCallId: string;
  /** Unix timestamp (ms). */
  timestamp: number;
  /** Provider namespace attached by stable carrier parsing. */
  provider?: VoiceProviderName;
  /** Creation request identity when distinct from the actual call leg. */
  providerRequestId?: string;
}

/** The destination phone is ringing. */
export interface NormalizedCallRinging extends NormalizedEventBase {
  kind: 'call-ringing';
}

/** The callee answered the call. */
export interface NormalizedCallAnswered extends NormalizedEventBase {
  kind: 'call-answered';
}

/** The call completed normally. */
export interface NormalizedCallCompleted extends NormalizedEventBase {
  kind: 'call-completed';
  /** Call duration in seconds, if reported by the provider. */
  duration?: number;
}

/** The provider could not place or maintain the call. */
export interface NormalizedCallFailed extends NormalizedEventBase {
  kind: 'call-failed';
  /** Human-readable failure reason from the provider. */
  reason?: string;
}

/** The callee's line is busy. */
export interface NormalizedCallBusy extends NormalizedEventBase {
  kind: 'call-busy';
}

/** The callee did not answer within the ring timeout. */
export interface NormalizedCallNoAnswer extends NormalizedEventBase {
  kind: 'call-no-answer';
}

/** Voicemail / answering machine detected (via AMD or similar). */
export interface NormalizedCallVoicemail extends NormalizedEventBase {
  kind: 'call-voicemail';
}

/** The remote caller (user) hung up the call. */
export interface NormalizedCallHangupUser extends NormalizedEventBase {
  kind: 'call-hangup-user';
}

/** An unrecoverable error occurred during the call. */
export interface NormalizedCallError extends NormalizedEventBase {
  kind: 'call-error';
  /** Error description. */
  error: string;
}

/** A speech-to-text transcript segment (partial or final). */
export interface NormalizedTranscript extends NormalizedEventBase {
  kind: 'transcript';
  /** The transcribed text. */
  text: string;
  /** Whether this is a finalized transcript (vs. in-progress partial). */
  isFinal: boolean;
}

/** The caller started speaking (voice activity detection trigger). */
export interface NormalizedSpeechStart extends NormalizedEventBase {
  kind: 'speech-start';
}

/** A bidirectional media stream WebSocket has connected successfully. */
export interface NormalizedMediaStreamConnected extends NormalizedEventBase {
  kind: 'media-stream-connected';
  /** Provider-assigned stream identifier for routing audio frames. */
  streamSid: string;
}

/**
 * DTMF (Dual-Tone Multi-Frequency) digit received during a call.
 *
 * DTMF events do NOT trigger a call state transition -- the call remains in
 * its current state (typically `listening` or `active`). They are relayed as
 * informational events so higher-level logic (e.g., IVR menus, PIN entry)
 * can react to caller key-presses.
 *
 * ## Delivery paths
 * All three carriers have webhook and media-stream DTMF paths. A webhook
 * occurrence identity and a media-stream sequence belong to their own
 * delivery channels; hosts choose one input path for an IVR action.
 *
 * @example
 * ```typescript
 * if (event.kind === 'call-dtmf') {
 *   console.log(`User pressed ${event.digit} for ${event.durationMs}ms`);
 * }
 * ```
 */
export interface NormalizedDtmfReceived extends NormalizedEventBase {
  kind: 'call-dtmf';
  /**
   * The digit pressed by the caller.
   *
   * Standard DTMF digits: `'0'`-`'9'`, `'*'`, `'#'`.
   * Extended DTMF (rarely supported): `'A'`-`'D'`.
   */
  digit: string;
  /**
   * How long the key was pressed in milliseconds, when the message carries it.
   *
   * Most messages omit it: Twilio's documented media-stream `dtmf` message
   * carries only the track and the digit, and Telnyx and Plivo webhook
   * payloads typically omit it.
   */
  durationMs?: number;
}

// ============================================================================
// Webhook Verification
// ============================================================================

/**
 * Raw webhook context passed to provider verification.
 *
 * Encapsulates everything a provider needs to verify a webhook's authenticity
 * and parse its payload, without coupling to any specific HTTP framework
 * (Express, Fastify, Koa, etc.).
 */
export interface WebhookContext {
  /** HTTP method (usually POST). */
  method: string;
  /** Full request URL (used for signature verification). */
  url: string;
  /** HTTP headers. */
  headers: Record<string, string | string[] | undefined>;
  /** Raw request body (string or Buffer). */
  body: string | Buffer;
  /** Parsed body (for providers that need form-encoded data). */
  parsedBody?: Record<string, string>;
}

/** Result of webhook signature verification. */
export interface WebhookVerificationResult {
  /** Whether the webhook signature is valid. */
  valid: boolean;
  /** Error message if verification failed. */
  error?: string;
}

/** Result of parsing a provider webhook into normalized events. */
export interface WebhookParseResult {
  /** Normalized events extracted from the webhook. */
  events: NormalizedCallEvent[];
  /** Provider-specific raw data for debugging. */
  rawData?: unknown;
}

// ============================================================================
// TTS Configuration (for telephony audio)
// ============================================================================

/** TTS provider for phone audio. */
export type TelephonyTtsProvider = 'openai' | 'elevenlabs' | (string & {});

/** TTS configuration overrides for voice calls. */
export interface VoiceCallTtsConfig {
  /** TTS provider to use. */
  provider?: TelephonyTtsProvider;
  /** Voice ID / name. */
  voice?: string;
  /** Speed multiplier. */
  speed?: number;
  /** Provider-specific options. */
  options?: Record<string, unknown>;
}

/** STT configuration for voice calls. */
export interface VoiceCallSttConfig {
  /** STT provider (currently only 'openai-realtime' supported). */
  provider?: 'openai-realtime' | 'whisper' | (string & {});
  /** Language hint for STT. */
  language?: string;
  /** Provider-specific options. */
  options?: Record<string, unknown>;
}

// ============================================================================
// Voice Call Configuration
// ============================================================================

/** Provider-specific configuration. */
export interface TwilioProviderConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export interface TelnyxProviderConfig {
  apiKey: string;
  connectionId: string;
  publicKey?: string;
  fromNumber: string;
}

export interface PlivoProviderConfig {
  authId: string;
  authToken: string;
  fromNumber: string;
}

/** Union of all provider configs. */
export type ProviderConfig =
  | { provider: 'twilio'; config: TwilioProviderConfig }
  | { provider: 'telnyx'; config: TelnyxProviderConfig }
  | { provider: 'plivo'; config: PlivoProviderConfig }
  | { provider: 'mock'; config?: Record<string, unknown> };

/** Full voice call system configuration. */
export interface VoiceCallConfig {
  /** Active telephony provider. */
  provider: ProviderConfig;
  /** TTS settings for phone audio. */
  tts?: VoiceCallTtsConfig;
  /** STT settings for phone audio. */
  stt?: VoiceCallSttConfig;
  /** Inbound call policy. */
  inboundPolicy?: InboundPolicy;
  /** Allowlist of E.164 numbers (for 'allowlist' policy). */
  allowedNumbers?: string[];
  /** Default call mode for outbound calls. */
  defaultMode?: CallMode;
  /** Maximum call duration in seconds (default: 300 = 5 min). */
  maxDurationSeconds?: number;
  /** Webhook base URL for receiving provider callbacks. */
  webhookBaseUrl?: string;
  /** Media stream configuration. */
  streaming?: {
    /** Whether to use bidirectional media streams. */
    enabled: boolean;
    /** WebSocket path for media streams (default: /voice/media-stream). */
    wsPath?: string;
  };
  /** Opt-in in-process transition repair; durable callbacks use the repaired reducer regardless. */
  eventHandling?: 'legacy' | 'carrier';
}

/** One provider/account partition's locked call state and alias index. */
export interface TelephonyCallTransaction {
  /** Reads a detached record by its internal id. */
  get(callId: string): Promise<CallRecord | undefined>;
  /** Finds by call id or the namespaced request alias. */
  find(providerIdentity: string): Promise<CallRecord | undefined>;
  /** Atomically stores state, processed ids and unique request/call aliases. */
  put(call: CallRecord): Promise<void>;
}
/**
 * Rolls back all writes on rejection and serializes the provider partition across instances.
 * A store instance belongs to one configured carrier account namespace. Retain terminal state
 * and processed ids through the host's callback retention window; this API never evicts them.
 */
export interface ITelephonyCallStore {
  /** Holds the transaction until work returns; work performs no network I/O or event delivery. */
  withProvider<T>(provider: VoiceProviderName, work: (tx: TelephonyCallTransaction) => Promise<T>): Promise<T>;
}
