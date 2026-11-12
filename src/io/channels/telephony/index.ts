/**
 * Barrel exports for the AgentOS voice call system.
 *
 * @module @framers/agentos/io/channels/telephony
 */

export * from './types.js';
export type {
  IVoiceCallProvider,
  InitiateCallInput,
  InitiateCallResult,
  HangupCallInput,
  CallAnsweredInput,
  AnswerCallInput,
  PlayTtsInput,
  StartListeningInput,
  StopListeningInput,
} from './IVoiceCallProvider.js';
export { CallManager } from './CallManager.js';
export type {
  CallManagerEventType,
  CallManagerEvent,
  CallManagerEventHandler,
} from './CallManager.js';
export {
  convertPcmToMulaw8k,
  convertMulawToPcm16,
  escapeXml,
  validateE164,
} from './telephony-audio.js';

// ── Media stream parsers ──────────────────────────────────────────────────────
export type { MediaStreamParser, MediaStreamIncoming } from './MediaStreamParser.js';
export { TwilioMediaStreamParser } from './parsers/TwilioMediaStreamParser.js';
export { TelnyxMediaStreamParser } from './parsers/TelnyxMediaStreamParser.js';
export { PlivoMediaStreamParser } from './parsers/PlivoMediaStreamParser.js';

// ── Telephony stream transport ────────────────────────────────────────────────
export { TelephonyStreamTransport } from './TelephonyStreamTransport.js';
export type { TelephonyStreamTransportConfig } from './TelephonyStreamTransport.js';

// ── Voice call providers ──────────────────────────────────────────────────────
export { TwilioVoiceProvider } from './providers/twilio.js';
export { TelnyxVoiceProvider } from './providers/telnyx.js';
export { PlivoVoiceProvider } from './providers/plivo.js';

// ── TwiML / XML helpers ───────────────────────────────────────────────────────
export {
  twilioConversationTwiml,
  twilioNotifyTwiml,
  telnyxStreamXml,
  plivoStreamXml,
  plivoNotifyXml,
} from './twiml.js';
