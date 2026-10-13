/**
 * @fileoverview Interface for parsing provider-specific WebSocket media stream messages.
 *
 * Each telephony provider (Twilio, Telnyx, Plivo, etc.) sends audio data
 * over WebSocket in its own proprietary JSON or binary format. Implementations
 * of this interface normalise the provider wire format into the shared
 * {@link MediaStreamIncoming} discriminated union so the rest of the voice
 * pipeline never needs to know which provider is in use.
 *
 * ## Implementing a custom parser
 *
 * @example
 * ```typescript
 * import type { MediaStreamParser, MediaStreamIncoming } from './MediaStreamParser.js';
 *
 * class CustomMediaStreamParser implements MediaStreamParser {
 *   parseIncoming(data: Buffer | string): MediaStreamIncoming | null {
 *     const msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
 *     if (msg.type === 'audio') {
 *       return {
 *         type: 'audio',
 *         payload: Buffer.from(msg.audioData, 'base64'),
 *         streamSid: msg.sessionId,
 *       };
 *     }
 *     return null; // Silently ignore unknown message types
 *   }
 *
 *   formatOutgoing(audio: Buffer, streamSid: string): Buffer | string {
 *     return JSON.stringify({
 *       type: 'playback',
 *       sessionId: streamSid,
 *       audioData: audio.toString('base64'),
 *     });
 *   }
 *
 *   formatConnected(streamSid: string): string | null {
 *     return JSON.stringify({ type: 'ready', sessionId: streamSid });
 *   }
 * }
 * ```
 *
 * @module @framers/agentos/voice/MediaStreamParser
 */

/**
 * Contract for parsing and formatting provider-specific WebSocket media
 * stream messages.
 *
 * The interface has three responsibilities:
 *
 * 1. **Inbound normalisation** ({@link parseIncoming}) -- Convert the provider's
 *    proprietary wire format into {@link MediaStreamIncoming} events.
 * 2. **Outbound formatting** ({@link formatOutgoing}) -- Wrap mu-law audio
 *    bytes in whatever envelope the provider expects.
 * 3. **Connection handshake** ({@link formatConnected}) -- Optionally generate
 *    a first-message acknowledgment required by some providers (e.g., Twilio).
 *
 * The built-in parsers take `{ protocol: 'carrier' }` to select each carrier's
 * documented PCMU 8 kHz media messages and playback controls; without it they
 * keep the legacy profile summarised below.
 *
 * @see TwilioMediaStreamParser -- legacy: JSON envelope, base64 audio, `connected` ack.
 * @see TelnyxMediaStreamParser -- legacy: JSON inbound, raw binary outbound, no ack.
 * @see PlivoMediaStreamParser  -- legacy: JSON envelope, `playAudio` outbound, no ack.
 */
export interface MediaStreamParser {
  /**
   * Parse a raw WebSocket message received from the telephony provider.
   *
   * Implementations must handle both `Buffer` (binary frames) and `string`
   * (text frames) inputs, since different providers and WebSocket libraries
   * deliver data in different forms.
   *
   * @param data - Raw message bytes or string as delivered by the WS frame.
   * @returns A normalised {@link MediaStreamIncoming} event, or `null` if the
   *   message should be silently ignored (e.g. unknown event type, outbound
   *   audio track, heartbeat frames, etc.).
   */
  parseIncoming(data: Buffer | string): MediaStreamIncoming | null;

  /**
   * Encode mu-law audio for transmission back to the telephony provider.
   *
   * The returned type varies by provider. In the legacy profile:
   * - **Twilio**: Returns a JSON `string` wrapping base64-encoded audio in a
   *   `{ event: 'media', streamSid, media: { payload } }` envelope.
   * - **Telnyx**: Returns the raw `Buffer` unchanged (binary WS frame).
   * - **Plivo**: Returns a JSON `string` with a `{ event: 'playAudio', media: { payload } }` envelope.
   *
   * In the carrier profile every built-in parser returns a JSON `string` in its
   * carrier's documented media message.
   *
   * @param audio - Raw mu-law PCM bytes to send to the caller.
   * @param streamSid - Provider stream identifier required by some formats.
   * @returns A `Buffer` (for providers that accept raw binary) or a JSON
   *   `string` (for providers that wrap audio in an envelope).
   */
  formatOutgoing(audio: Buffer, streamSid: string): Buffer | string;

  /**
   * Generate the initial connection acknowledgment message, if the provider
   * requires one immediately after the WebSocket handshake.
   *
   * - **Twilio**: Returns `{ event: 'connected', protocol: 'Call', version: '1.0.0' }`
   *   in the legacy profile and `null` in the carrier profile.
   * - **Telnyx**: Returns `null` (no handshake needed).
   * - **Plivo**: Not defined (no handshake needed).
   *
   * @param streamSid - The stream identifier established during the handshake.
   * @returns A JSON string to send as the first WS message, or `null` if the
   *   provider does not need an explicit acknowledgment.
   */
  formatConnected?(streamSid: string): string | null;

  /** Explicit wire profile; omission denotes the released compatibility protocol. */
  readonly protocol?: 'legacy' | 'carrier';
  /** Encodes cancellation of queued carrier playback, or null when unavailable. */
  formatClear?(streamSid: string): string | null;
  /** Encodes a named playback checkpoint, or null when unavailable. */
  formatMark?(streamSid: string, name: string): string | null;
}

/**
 * Discriminated union of all normalised events that can arrive on a media
 * stream WebSocket connection, regardless of the underlying telephony provider.
 *
 * ## Variant summary
 *
 * | `type`   | When it fires                                | Key payload fields          |
 * |----------|----------------------------------------------|-----------------------------|
 * | `audio`  | Each inbound audio chunk (~20ms intervals)   | `payload` (mu-law Buffer)   |
 * | `dtmf`   | Caller presses a phone keypad button         | `digit`, `durationMs?`      |
 * | `start`  | Stream session begins (metadata available)   | `callSid`, `metadata?`      |
 * | `stop`   | Stream session ends / call disconnects       | (none beyond `streamSid`)   |
 * | `mark`   | Named sync point injected into audio stream  | `name`                      |
 *
 * All variants carry a `streamSid` field to identify which stream the event
 * belongs to (important when a single server handles multiple concurrent calls).
 */
export type MediaStreamIncoming =
  | {
      /**
       * Inbound audio chunk encoded as mu-law 8-bit 8 kHz PCM.
       *
       * Audio arrives as small chunks (typically 20ms / 160 bytes) at regular
       * intervals for the duration of the call. The pipeline must decode
       * mu-law -> PCM Int16 -> resample -> Float32 before feeding to STT/VAD.
       */
      type: 'audio';
      /** Raw mu-law bytes decoded from whatever encoding the provider uses. */
      payload: Buffer;
      /** Provider-assigned stream identifier. */
      streamSid: string;
      /** Monotonically increasing sequence number, when provided. */
      sequenceNumber?: number;
      /** Carrier's per-track chunk counter, distinct from its all-event sequence. */
      mediaChunk?: number;
      /** Carrier media timestamp in milliseconds, preserved without treating it as wall time. */
      timestampMs?: number;
    }
  | {
      /**
       * DTMF tone detected by the provider during the call.
       *
       * In the legacy profile only the Twilio parser reports DTMF from the media
       * stream; the Telnyx and Plivo carrier profiles also parse their carriers'
       * `dtmf` media events. Key presses can also arrive through the provider's
       * HTTP webhooks.
       */
      type: 'dtmf';
      /** Single character digit pressed by the caller (0-9, *, #, A-D). */
      digit: string;
      /** Provider-assigned stream identifier. */
      streamSid: string;
      /** Duration the key was held, in milliseconds, when reported. */
      durationMs?: number;
    }
  | {
      /**
       * Stream successfully started; metadata about the call is available.
       *
       * This is always the first meaningful event on a new stream connection.
       * The {@link TelephonyStreamTransport} transitions from `connecting` to
       * `open` upon receiving this event and sends the optional
       * {@link MediaStreamParser.formatConnected} acknowledgment.
       */
      type: 'start';
      /** Provider-assigned stream identifier. */
      streamSid: string;
      /** Provider call-leg identifier (e.g. Twilio CallSid, Telnyx call_control_id). */
      callSid: string;
      /** Additional provider-specific metadata attached to the start event. */
      metadata?: Record<string, unknown>;
    }
  | {
      /**
       * Call ended or stream was explicitly stopped.
       *
       * The {@link TelephonyStreamTransport} transitions to `closed` and
       * emits a `'close'` event upon receiving this.
       */
      type: 'stop';
      /** Provider-assigned stream identifier. */
      streamSid: string;
    }
  | {
      /**
       * Named marker injected into the audio stream for synchronisation.
       *
       * Marks are used to correlate outbound audio playback completion with
       * application logic (e.g., knowing when a TTS utterance finished playing
       * so the agent can transition from `speaking` to `listening`).
       */
      type: 'mark';
      /** The label assigned to this mark point. */
      name: string;
      /** Provider-assigned stream identifier. */
      streamSid: string;
    };

/** Supported direct-carrier wire implementations. */
export type CarrierName = 'twilio' | 'telnyx' | 'plivo';
/** Omission preserves compatibility; carrier mode uses the documented PCMU protocol. */
export interface CarrierProtocolOptions { protocol?: 'legacy' | 'carrier' }
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string | undefined => typeof v === 'string' && v.length > 0 && v.length <= 512 ? v : undefined;
const integer = (v: unknown): number | undefined => {
  if (typeof v !== 'number' && (typeof v !== 'string' || !/^\d+$/.test(v))) return undefined;
  const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
};
/** Parses one bounded documented carrier frame; unsupported start formats are explicit errors. */
export function parseCarrierMedia(carrier: CarrierName, input: Buffer | string): MediaStreamIncoming | null {
  if (Buffer.byteLength(input) > 262144) throw new Error('carrier frame bound');
  let msg: Record<string, unknown>;
  try { msg = record(JSON.parse(input.toString())); } catch { return null; }
  const event = text(msg.event); const start = record(msg.start);
  const streamSid = text(carrier === 'twilio' ? msg.streamSid : carrier === 'telnyx' ? msg.stream_id : msg.streamId ?? start.streamId);
  if (!event || !streamSid) return null;
  if (event === 'start') {
    const callSid = text(carrier === 'twilio' ? start.callSid : carrier === 'telnyx' ? start.call_control_id : start.callId);
    if (!callSid) return null;
    const format = record(carrier === 'telnyx' ? start.media_format : start.mediaFormat);
    const encoding = carrier === 'telnyx' ? 'PCMU' : 'audio/x-mulaw';
    const rate = integer(carrier === 'telnyx' ? format.sample_rate : format.sampleRate);
    const channels = carrier === 'plivo' && format.channels === undefined ? 1 : integer(format.channels);
    if (format.encoding !== encoding || rate !== 8000 || channels !== 1) throw new Error('carrier media format');
    return { type: 'start', callSid, streamSid, metadata: start };
  }
  if (event === 'media') {
    const media = record(msg.media);
    if (media.track !== undefined && media.track !== 'inbound') return null;
    const payload = media.payload;
    if (typeof payload !== 'string' || !payload || payload.length > 21848 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) return null;
    const bytes = Buffer.from(payload, 'base64');
    if (!bytes.length || bytes.length > 16000 || bytes.toString('base64') !== payload) return null;
    return { type: 'audio', streamSid, payload: bytes, sequenceNumber: integer(carrier === 'telnyx' ? msg.sequence_number : msg.sequenceNumber), mediaChunk: integer(media.chunk), timestampMs: integer(media.timestamp) };
  }
  if (event === 'dtmf') {
    const dtmf = record(msg.dtmf); const digit = text(dtmf.digit);
    if (!digit || !/^[0-9*#A-D]$/.test(digit)) return null;
    return { type: 'dtmf', streamSid, digit, durationMs: integer(dtmf.duration) };
  }
  if (event === 'mark' || (carrier === 'plivo' && event === 'playedStream')) {
    const name = text(carrier === 'plivo' ? msg.name : record(msg.mark).name);
    return name ? { type: 'mark', streamSid, name } : null;
  }
  if (event === 'stop') return { type: 'stop', streamSid };
  if (event === 'error') throw new Error('carrier reported media error');
  return null;
}
/** Carrier media output is headerless PCMU, never a raw binary WebSocket message. */
export function carrierAudio(carrier: CarrierName, audio: Buffer, streamSid: string): string {
  if (audio.length < 1 || audio.length > 16000) throw new Error('carrier audio bound');
  const payload = audio.toString('base64');
  if (carrier === 'twilio') return JSON.stringify({ event: 'media', streamSid, media: { payload } });
  if (carrier === 'plivo') return JSON.stringify({ event: 'playAudio', media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload } });
  return JSON.stringify({ event: 'media', media: { payload } });
}
/** Encodes only the cancellation operation supported by the selected carrier. */
export function carrierClear(carrier: CarrierName, streamSid: string): string {
  if (carrier === 'twilio') return JSON.stringify({ event: 'clear', streamSid });
  if (carrier === 'plivo') return JSON.stringify({ event: 'clearAudio', streamId: streamSid });
  return JSON.stringify({ event: 'clear' });
}
/** Encodes a checkpoint echoed after playback; a clear echo is not proof that audio played. */
export function carrierMark(carrier: CarrierName, streamSid: string, name: string): string {
  if (!text(name)) throw new Error('invalid playback mark');
  if (carrier === 'twilio') return JSON.stringify({ event: 'mark', streamSid, mark: { name } });
  if (carrier === 'plivo') return JSON.stringify({ event: 'checkpoint', streamId: streamSid, name });
  return JSON.stringify({ event: 'mark', mark: { name } });
}
