/**
 * @fileoverview TwiML and XML generation helpers for telephony providers.
 *
 * Generates provider-specific XML/TwiML response payloads for Twilio, Telnyx,
 * and Plivo. All text content and attribute values are XML-escaped via
 * {@link escapeXml} to prevent injection or malformed markup.
 *
 * ## XSS / injection prevention
 *
 * Every dynamic value (URLs, text content, voice names) passes through
 * {@link escapeXml} before being interpolated into the XML template. This
 * replaces the five XML-sensitive characters with their named entity
 * equivalents:
 *
 * | Character | Entity    |
 * |-----------|-----------|
 * | `<`       | `&lt;`    |
 * | `>`       | `&gt;`    |
 * | `&`       | `&amp;`   |
 * | `"`       | `&quot;`  |
 * | `'`       | `&apos;`  |
 *
 * This ensures that user-controlled input (caller names, agent-generated
 * messages, etc.) cannot break out of an attribute or inject child elements.
 *
 * @module @framers/agentos/voice/twiml
 */

import { escapeXml } from './telephony-audio.js';
import type { CarrierProtocolOptions } from './MediaStreamParser.js';

// ============================================================================
// Twilio TwiML
// ============================================================================

/** Generates bidirectional stream XML; carrier mode carries tokens in custom parameters. */
export function twilioConversationTwiml(streamUrl: string, token?: string, options: CarrierProtocolOptions = {}): string {
  if (options.protocol !== 'carrier') {
    const url = token ? `${streamUrl}?token=${token}` : streamUrl;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Connect><Stream url="${escapeXml(url)}" /></Connect></Response>`;
  }
  const url = new URL(streamUrl);
  if (url.protocol !== 'wss:' || url.search || url.hash || url.username || url.password) throw new Error('invalid carrier stream URL');
  if (token !== undefined && (!token || token.length + 'token'.length >= 500)) throw new Error('invalid carrier parameter length');
  const parameter = token === undefined ? '' : `<Parameter name="token" value="${escapeXml(token)}" />`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Connect><Stream url="${escapeXml(streamUrl)}">${parameter}</Stream></Connect></Response>`;
}

/**
 * Generate TwiML for Twilio notify mode -- synthesise `text` over the call then hang up.
 *
 * Useful for delivering one-shot announcements (e.g. voicemail greetings, error
 * messages, appointment reminders) without establishing a full media stream.
 *
 * @param text - The message to speak to the caller. XML-escaped automatically.
 * @param voice - Optional Twilio voice name (e.g. `'Polly.Joanna'`, `'alice'`).
 * @returns A complete TwiML XML document string.
 *
 * @example
 * ```typescript
 * twilioNotifyTwiml('Your appointment is confirmed.');
 * // => '<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say>Your appointment is confirmed.</Say><Hangup/></Response>'
 *
 * twilioNotifyTwiml('Hello', 'Polly.Joanna');
 * // => '...><Say voice="Polly.Joanna">Hello</Say><Hangup/></Response>'
 * ```
 */
export function twilioNotifyTwiml(text: string, voice?: string): string {
  const voiceAttr = voice ? ` voice="${escapeXml(voice)}"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say${voiceAttr}>${escapeXml(text)}</Say><Hangup/></Response>`;
}

// ============================================================================
// Telnyx XML
// ============================================================================

/**
 * Generate a Telnyx streaming XML response.
 *
 * Telnyx primarily uses a REST API for call control, but this helper produces
 * an XML acknowledgment document wrapping the stream URL for webhook responses
 * that require XML.
 *
 * @param streamUrl - WebSocket URL Telnyx should stream audio to.
 * @returns A complete XML document string.
 *
 * @example
 * ```typescript
 * telnyxStreamXml('wss://api.example.com/telnyx-stream');
 * // => '<?xml version="1.0" encoding="UTF-8"?>\n<Response><Stream url="wss://api.example.com/telnyx-stream" /></Response>'
 * ```
 */
export function telnyxStreamXml(streamUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Stream url="${escapeXml(streamUrl)}" /></Response>`;
}

// ============================================================================
// Plivo XML
// ============================================================================

/** Generates Plivo stream XML; carrier mode explicitly selects the parser's PCMU 8 kHz format. */
export function plivoStreamXml(streamUrl: string, options: CarrierProtocolOptions = {}): string {
  if (options.protocol !== 'carrier') return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Stream bidirectional="true" keepCallAlive="true">${escapeXml(streamUrl)}</Stream></Response>`;
  const url = new URL(streamUrl);
  if (url.protocol !== 'wss:' || url.hash || url.username || url.password) throw new Error('invalid carrier stream URL');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Stream bidirectional="true" keepCallAlive="true" audioTrack="inbound" contentType="audio/x-mulaw;rate=8000">${escapeXml(streamUrl)}</Stream></Response>`;
}

/**
 * Generate Plivo speak + hangup XML.
 *
 * Synthesises `text` to the caller using Plivo's TTS engine and immediately
 * hangs up after playback completes. Equivalent to Twilio's `<Say>...<Hangup/>`
 * but uses Plivo's `<Speak>` element name.
 *
 * @param text - The message to speak to the caller. XML-escaped automatically.
 * @param voice - Optional Plivo voice name (e.g. `'WOMAN'`, `'Polly.Joanna'`).
 * @returns A complete Plivo XML document string.
 *
 * @example
 * ```typescript
 * plivoNotifyXml('Your order has shipped.');
 * // => '<?xml version="1.0" encoding="UTF-8"?>\n<Response><Speak>Your order has shipped.</Speak><Hangup/></Response>'
 *
 * plivoNotifyXml('Hello', 'WOMAN');
 * // => '...><Speak voice="WOMAN">Hello</Speak><Hangup/></Response>'
 * ```
 */
export function plivoNotifyXml(text: string, voice?: string): string {
  const voiceAttr = voice ? ` voice="${escapeXml(voice)}"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Speak${voiceAttr}>${escapeXml(text)}</Speak><Hangup/></Response>`;
}
