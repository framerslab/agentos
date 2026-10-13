/**
 * @fileoverview Interface for telephony providers (Twilio, Telnyx, Plivo, etc.).
 *
 * Each provider implements this interface to normalize platform-specific
 * call control, webhook handling, and audio streaming APIs into a common
 * contract consumed by the {@link CallManager}.
 *
 * @module @framers/agentos/voice/IVoiceCallProvider
 */

import type {
  CallId,
  CallMode,
  NormalizedCallEvent,
  VoiceProviderName,
  WebhookContext,
  WebhookParseResult,
  WebhookVerificationResult,
} from './types.js';

// ============================================================================
// Input Types
// ============================================================================

/** Parameters for initiating an outbound call. */
export interface InitiateCallInput {
  /** Internal call ID assigned by CallManager. */
  callId: CallId;
  /** E.164 phone number to call from. */
  fromNumber: string;
  /** E.164 phone number to call. */
  toNumber: string;
  /** Call interaction mode. */
  mode: CallMode;
  /** Pre-composed message (for 'notify' mode). */
  message?: string;
  /** TTS voice to use for notify-mode messages. */
  notifyVoice?: string;
  /** Webhook URL the provider should call back to. */
  webhookUrl: string;
  /** Status callback URL for call state changes. */
  statusCallbackUrl?: string;
  /** Media stream WebSocket URL (for 'conversation' mode). */
  mediaStreamUrl?: string;
  /** Host-issued stream credential; carrier-specific XML determines its transport, including Twilio custom parameters. */
  mediaStreamToken?: string;
}

/** Result of initiating a call. */
export interface InitiateCallResult {
  /** Provider-assigned call ID. */
  providerCallId: string;
  /** Creation request identity when distinct from the actual call leg. */
  providerRequestId?: string;
  /** Whether the call was accepted by the provider. */
  success: boolean;
  /** Error message if not successful. */
  error?: string;
}

/** Parameters for hanging up a call. */
export interface HangupCallInput {
  /** Provider-assigned call ID. */
  providerCallId: string;
}

/** Parameters for playing TTS into a call. */
export interface PlayTtsInput {
  /** Provider-assigned call ID. */
  providerCallId: string;
  /** Text to speak. */
  text: string;
  /** TTS voice name/ID. */
  voice?: string;
}

/** Parameters for starting STT listening on a call. */
export interface StartListeningInput {
  /** Provider-assigned call ID. */
  providerCallId: string;
  /** Language hint. */
  language?: string;
}

/** Parameters for stopping STT listening on a call. */
export interface StopListeningInput {
  /** Provider-assigned call ID. */
  providerCallId: string;
}

// ============================================================================
// Provider Interface
// ============================================================================

/**
 * Core interface for telephony providers.
 *
 * Implementations wrap provider-specific SDKs (Twilio REST API, Telnyx Call
 * Control v2, Plivo Voice API) and normalize all interactions to this contract.
 *
 * @example
 * ```typescript
 * class TwilioProvider implements IVoiceCallProvider {
 *   readonly name = 'twilio';
 *
 *   async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
 *     const call = await this.client.calls.create({
 *       to: input.toNumber,
 *       from: input.fromNumber,
 *       url: input.webhookUrl,
 *       statusCallback: input.statusCallbackUrl,
 *     });
 *     return { providerCallId: call.sid, success: true };
 *   }
 *   // ...
 * }
 * ```
 */
export interface IVoiceCallProvider {
  /** Provider identifier. */
  readonly name: VoiceProviderName;

  /** Stable normalized identity contract required by durable callback processing. */
  readonly webhookIdentity?: 'legacy' | 'stable-v1';

  // ── Webhook Processing ──

  /**
   * Verify the authenticity of an incoming webhook request.
   * Each provider has its own signature scheme:
   * - Twilio: HMAC-SHA1 signature header
   * - Telnyx: Ed25519 public key verification
   * - Plivo: HMAC-SHA256 verification
   */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult;

  /**
   * Parse a verified webhook payload into normalized call events.
   * Transforms provider-specific event formats into the common
   * {@link NormalizedCallEvent} discriminated union.
   */
  parseWebhookEvent(ctx: WebhookContext): WebhookParseResult;

  // ── Call Control ──

  /**
   * Initiate an outbound phone call.
   * For 'notify' mode, the provider generates TwiML/SSML to speak the
   * message and hang up. For 'conversation' mode, the provider sets up
   * a bidirectional media stream.
   */
  initiateCall(input: InitiateCallInput): Promise<InitiateCallResult>;

  /**
   * Hang up an active call.
   */
  hangupCall(input: HangupCallInput): Promise<void>;

  /**
   * Play TTS audio into an active call (non-streaming).
   * Used by providers that support in-call TTS via their API
   * (e.g., Twilio's <Say> verb, Telnyx speak command).
   */
  playTts?(input: PlayTtsInput): Promise<void>;

  /**
   * Start STT listening on an active call (non-streaming).
   * Used by providers that support in-call speech recognition.
   */
  startListening?(input: StartListeningInput): Promise<void>;

  /**
   * Stop STT listening on an active call.
   */
  stopListening?(input: StopListeningInput): Promise<void>;
}
