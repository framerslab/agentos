/**
 * Plivo media parser with an explicit documented carrier profile and a retained legacy profile.
 * Carrier mode requires PCMU 8 kHz mono and preserves carrier timestamps and chunk counters.
 * Legacy mode exists for existing callers and fixtures; it is not a live-carrier conformance claim.
 */

import { parseCarrierMedia, carrierAudio, carrierClear, carrierMark, type CarrierProtocolOptions, type MediaStreamParser, type MediaStreamIncoming } from '../MediaStreamParser.js';

/**
 * Plivo media parser with an explicit documented carrier profile and a retained legacy profile.
 * Carrier mode requires PCMU 8 kHz mono and preserves carrier timestamps and chunk counters.
 * Legacy mode exists for existing callers and fixtures; it is not a live-carrier conformance claim.
 */
export class PlivoMediaStreamParser implements MediaStreamParser {
  /** Selected once; omission preserves the released snake-case parser. */
  readonly protocol: 'legacy' | 'carrier';
  /** Selects explicit PCMU 8 kHz in the documented carrier protocol. */
  constructor(options: CarrierProtocolOptions = {}) { this.protocol = options.protocol ?? 'legacy'; }

  /**
   * Parse a raw WebSocket frame from a Plivo audio stream.
   *
   * The carrier profile ({@link parseCarrierMedia}) reads `start` with the nested
   * `start.callId`, `start.streamId` and `start.mediaFormat`, which must declare
   * PCMU at 8 kHz (one channel when the count is omitted); `media` with its
   * base64 `media.payload`, inbound track only; `dtmf`, `playedStream` (reported
   * as a `mark`) and `stop`. An unsupported start format, an `error` event or
   * an oversized frame throws.
   *
   * The legacy profile keeps the released snake-case mapping: `stream_id` to
   * `streamSid` and `call_uuid` to `callSid`, with `start`, `media` and `stop`
   * alone.
   *
   * @param data - Raw WebSocket frame payload (JSON string or Buffer from Plivo).
   * @returns Normalised {@link MediaStreamIncoming} event, or `null` for
   *   unknown event types or malformed messages.
   */
  parseIncoming(data: Buffer | string): MediaStreamIncoming | null {
    if (this.protocol === 'carrier') return parseCarrierMedia('plivo', data);

    const raw = typeof data === 'string' ? data : data.toString('utf8');

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }

    const event = msg['event'] as string | undefined;
    // The legacy profile reads the snake-case `stream_id`; the carrier profile reads `streamId`.
    const streamSid = msg['stream_id'] as string | undefined;

    if (!event || !streamSid) {
      return null;
    }

    switch (event) {
      case 'start': {
        // The legacy profile reads the snake-case `call_uuid`; the carrier profile reads `start.callId`.
        const callSid = (msg['call_uuid'] as string | undefined) ?? '';
        const result: MediaStreamIncoming = {
          type: 'start',
          streamSid,
          callSid,
        };
        return result;
      }

      case 'media': {
        const media = msg['media'] as Record<string, unknown> | undefined;
        if (!media) return null;

        const payloadB64 = media['payload'] as string | undefined;
        if (!payloadB64) return null;

        const result: MediaStreamIncoming = {
          type: 'audio',
          payload: Buffer.from(payloadB64, 'base64'),
          streamSid,
        };
        return result;
      }

      case 'stop': {
        const result: MediaStreamIncoming = { type: 'stop', streamSid };
        return result;
      }

      default:
        return null;
    }
  }

  /** Carrier output declares codec and numeric rate; legacy output preserves its old shape. */
  formatOutgoing(audio: Buffer, streamSid: string): string {
    return this.protocol === 'carrier' ? carrierAudio('plivo', audio, streamSid) : JSON.stringify({ event: 'playAudio', media: { payload: audio.toString('base64') } });
  }

  /** Clears queued carrier audio. */
  formatClear(streamSid: string): string | null { return this.protocol === 'carrier' ? carrierClear('plivo', streamSid) : null; }
  /** Sends a Plivo checkpoint. */
  formatMark(streamSid: string, name: string): string | null { return this.protocol === 'carrier' ? carrierMark('plivo', streamSid, name) : null; }
}
