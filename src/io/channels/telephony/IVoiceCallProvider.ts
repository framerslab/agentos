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
  CallDirection,
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

/** A call the carrier reports answered, as {@link IVoiceCallProvider.onCallAnswered} receives it. */
export interface CallAnsweredInput {
  /** Internal call ID assigned by CallManager. */
  callId: CallId;
  /** Provider-assigned call ID of the answered call. */
  providerCallId: string;
  /** Whether the manager placed the call or admitted it. */
  direction: CallDirection;
  /** Call interaction mode. */
  mode: CallMode;
  /** The message a notify call speaks, when one was given. */
  message?: string;
  /** TTS voice for the message (the manager's `tts.voice`). */
  voice?: string;
}

/** An inbound call to answer, as {@link IVoiceCallProvider.answerCall} receives it. */
export interface AnswerCallInput {
  /** Internal call ID assigned by CallManager. */
  callId: CallId;
  /** Provider-assigned call ID of the inbound call. */
  providerCallId: string;
  /** Media stream WebSocket URL, when the manager's `streaming.enabled` is set. */
  mediaStreamUrl?: string;
  /** Host-issued stream credential, as for {@link InitiateCallInput.mediaStreamToken}. */
  mediaStreamToken?: string;
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
   * Set up a call the carrier reports answered, for a carrier controlled by
   * commands rather than by the answer XML the host serves (Telnyx Call
   * Control). `CallManager` calls it once per call, when an event first moves
   * the call to `answered`; in `processWebhookDurable` that is after the event
   * commits. It does not wait for the returned promise: a rejection is
   * written to the console. Twilio and Plivo leave it unimplemented, since the
   * host's answer XML sets their calls up.
   */
  onCallAnswered?(input: CallAnsweredInput): Promise<void>;

  /**
   * Answer an inbound call the host has admitted, for a carrier that answers
   * by command rather than by the answer XML the host serves (Telnyx Call
   * Control). `CallManager.answerInboundCall` calls it and waits for it; a
   * rejection reaches the host. Twilio and Plivo leave it unimplemented, since
   * the host's answer XML answers their calls.
   */
  answerCall?(input: AnswerCallInput): Promise<void>;

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
