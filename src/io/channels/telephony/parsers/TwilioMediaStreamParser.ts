/**
 * Twilio media parser with an explicit documented carrier profile and a retained legacy profile.
 * Carrier mode requires PCMU 8 kHz mono and preserves carrier timestamps and chunk counters.
 * Legacy mode exists for existing callers and fixtures; it is not a live-carrier conformance claim.
 */

import { parseCarrierMedia, carrierAudio, carrierClear, carrierMark, type MediaStreamParser, type MediaStreamIncoming } from '../MediaStreamParser.js';

/**
 * Twilio media parser with an explicit documented carrier profile and a retained legacy profile.
 * Carrier mode requires PCMU 8 kHz mono and preserves carrier timestamps and chunk counters.
 * Legacy mode exists for existing callers and fixtures; it is not a live-carrier conformance claim.
 */
export class TwilioMediaStreamParser<P extends 'legacy' | 'carrier' = 'legacy'> implements MediaStreamParser {
  /** Selected once; the no-argument constructor preserves released behavior. */
  readonly protocol: P;
  /** Selects documented carrier messages explicitly. */
  constructor(options: { protocol?: P } = {}) { this.protocol = (options.protocol ?? 'legacy') as P; }

  /**
   * Parse a raw WebSocket frame from Twilio's media stream.
   *
   * Supported Twilio event types:
   * - `start`  -- stream established, includes callSid and media format metadata.
   * - `media`  -- audio chunk (inbound track only; outbound echoes are discarded
   *   to prevent feedback loops).
   * - `dtmf`   -- DTMF keypress detected on the audio stream.
   * - `stop`   -- stream ended (call hangup or stream disconnect).
   * - `mark`   -- named synchronisation marker confirming playback reached a point.
   *
   * Messages with missing `event` or `streamSid` fields, malformed JSON,
   * or unrecognised event types are silently dropped (return `null`).
   *
   * In the carrier profile ({@link parseCarrierMedia}) a `start` must declare
   * PCMU at 8 kHz mono, the numeric strings `sequenceNumber`, `media.chunk` and
   * `media.timestamp` are read as integers, and a malformed payload is dropped;
   * an unsupported start format, an `error` event or an oversized frame throws.
   *
   * @param data - Raw WebSocket frame payload (always a JSON string from Twilio).
   * @returns Normalised {@link MediaStreamIncoming} event, or `null` for
   *   outbound audio tracks, unknown event types, or malformed messages.
   */
  parseIncoming(data: Buffer | string): MediaStreamIncoming | null {
    if (this.protocol === 'carrier') return parseCarrierMedia('twilio', data);

    const raw = typeof data === 'string' ? data : data.toString('utf8');

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }

    const event = msg['event'] as string | undefined;
    const streamSid = msg['streamSid'] as string | undefined;

    // Both fields are required on every Twilio media stream message.
    if (!event || !streamSid) {
      return null;
    }

    switch (event) {
      case 'start': {
        const startPayload = msg['start'] as Record<string, unknown> | undefined;
        // callSid identifies the Twilio call leg this stream belongs to.
        const callSid = (startPayload?.['callSid'] as string | undefined) ?? '';
        const result: MediaStreamIncoming = {
          type: 'start',
          streamSid,
          callSid,
          metadata: startPayload as Record<string, unknown> | undefined,
        };
        return result;
      }

      case 'media': {
        const media = msg['media'] as Record<string, unknown> | undefined;
        if (!media) return null;

        // Twilio sends both inbound and outbound audio on the same stream.
        // Outbound echoes must be discarded to prevent feedback loops where
        // the agent hears its own TTS output.
        const track = media['track'] as string | undefined;
        if (track === 'outbound') return null;

        const payloadB64 = media['payload'] as string | undefined;
        if (!payloadB64) return null;

        const sequenceNumber = typeof msg['sequenceNumber'] === 'number'
          ? (msg['sequenceNumber'] as number)
          : undefined;

        const result: MediaStreamIncoming = {
          type: 'audio',
          payload: Buffer.from(payloadB64, 'base64'),
          streamSid,
          ...(sequenceNumber !== undefined ? { sequenceNumber } : {}),
        };
        return result;
      }

      case 'dtmf': {
        const dtmf = msg['dtmf'] as Record<string, unknown> | undefined;
        if (!dtmf) return null;

        const digit = dtmf['digit'] as string | undefined;
        if (!digit) return null;

        // The legacy profile keeps a numeric `dtmf.duration` when one is present;
        // the documented Twilio `dtmf` message carries only `track` and `digit`.
        const duration = typeof dtmf['duration'] === 'number'
          ? (dtmf['duration'] as number)
          : undefined;

        const result: MediaStreamIncoming = {
          type: 'dtmf',
          digit,
          streamSid,
          ...(duration !== undefined ? { durationMs: duration } : {}),
        };
        return result;
      }

      case 'stop': {
        const result: MediaStreamIncoming = { type: 'stop', streamSid };
        return result;
      }

      case 'mark': {
        const mark = msg['mark'] as Record<string, unknown> | undefined;
        if (!mark) return null;

        const name = mark['name'] as string | undefined;
        if (!name) return null;

        const result: MediaStreamIncoming = { type: 'mark', name, streamSid };
        return result;
      }

      default:
        // Twilio may add new event types in the future; silently ignore them
        // rather than throwing so existing deployments remain forward-compatible.
        return null;
    }
  }

  /** Formats media for either the retained JSON protocol or the documented carrier profile. */
  formatOutgoing(audio: Buffer, streamSid: string): string {
    if (this.protocol === 'carrier') return carrierAudio('twilio', audio, streamSid);
    return JSON.stringify({ event: 'media', streamSid, media: { payload: audio.toString('base64') } });
  }
  /** Carrier Twilio sends connected to us; only legacy clients receive the old acknowledgement. */
  formatConnected(_streamSid: string): P extends 'carrier' ? null : string {
    return (this.protocol === 'carrier' ? null : JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' })) as P extends 'carrier' ? null : string;
  }

  /** Clears carrier output; compatibility clients have no mapped clear operation. */
  formatClear(streamSid: string): string | null { return this.protocol === 'carrier' ? carrierClear('twilio', streamSid) : null; }
  /** Marks carrier playback; compatibility clients have no mapped checkpoint operation. */
  formatMark(streamSid: string, name: string): string | null { return this.protocol === 'carrier' ? carrierMark('twilio', streamSid, name) : null; }
}
