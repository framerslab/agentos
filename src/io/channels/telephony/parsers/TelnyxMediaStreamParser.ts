/**
 * Telnyx media parser with an explicit documented carrier profile and a retained legacy profile.
 * Carrier mode requires PCMU 8 kHz mono and preserves carrier timestamps and chunk counters.
 * Legacy mode exists for existing callers and fixtures; it is not a live-carrier conformance claim.
 */

import { parseCarrierMedia, carrierAudio, carrierClear, carrierMark, type MediaStreamParser, type MediaStreamIncoming } from '../MediaStreamParser.js';

/**
 * Telnyx media parser with an explicit documented carrier profile and a retained legacy profile.
 * Carrier mode requires PCMU 8 kHz mono and preserves carrier timestamps and chunk counters.
 * Legacy mode exists for existing callers and fixtures; it is not a live-carrier conformance claim.
 */
export class TelnyxMediaStreamParser<P extends 'legacy' | 'carrier' = 'legacy'> implements MediaStreamParser {
  /** Selected once; omission preserves the old binary-output protocol. */
  readonly protocol: P;
  /** Carrier mode requires Telnyx bidirectional RTP with PCMU configured by the host. */
  constructor(options: { protocol?: P } = {}) { this.protocol = (options.protocol ?? 'legacy') as P; }

  /**
   * Parse a raw WebSocket frame from a Telnyx media stream.
   *
   * The carrier profile ({@link parseCarrierMedia}) reads `start` with the nested
   * `start.call_control_id` and `start.media_format`, which must declare PCMU at
   * 8 kHz mono; `media` with its base64 `media.payload`, inbound track only;
   * `dtmf`, `mark` and `stop`. An unsupported start format, an `error` event or
   * an oversized frame throws.
   *
   * The legacy profile keeps the released mapping: `stream_id` to `streamSid`, a
   * top-level `call_control_id` to `callSid` and the audio in `media.chunk`, with
   * `start`, `media` and `stop` alone.
   *
   * @param data - Raw WebSocket frame payload (JSON string or Buffer from Telnyx).
   * @returns Normalised {@link MediaStreamIncoming} event, or `null` for
   *   outbound audio tracks, unknown event types, or malformed messages.
   */
  parseIncoming(data: Buffer | string): MediaStreamIncoming | null {
    if (this.protocol === 'carrier') return parseCarrierMedia('telnyx', data);

    const raw = typeof data === 'string' ? data : data.toString('utf8');

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }

    const event = msg['event'] as string | undefined;
    // Telnyx uses `stream_id` where Twilio uses `streamSid`.
    const streamSid = msg['stream_id'] as string | undefined;

    if (!event || !streamSid) {
      return null;
    }

    switch (event) {
      case 'start': {
        // Telnyx uses `call_control_id` as the call-leg identifier,
        // equivalent to Twilio's `callSid`.
        const callSid = (msg['call_control_id'] as string | undefined) ?? '';
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

        // Ignore outbound audio echoes from Telnyx to prevent feedback.
        const track = media['track'] as string | undefined;
        if (track === 'outbound') return null;

        // The legacy profile reads the audio from `media.chunk`; the carrier profile reads `media.payload`.
        const chunk = media['chunk'] as string | undefined;
        if (!chunk) return null;

        const result: MediaStreamIncoming = {
          type: 'audio',
          payload: Buffer.from(chunk, 'base64'),
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

  /** Carrier mode sends JSON media; legacy mode returns the original bytes. */
  formatOutgoing(audio: Buffer, streamSid: string): P extends 'carrier' ? string : Buffer {
    return (this.protocol === 'carrier' ? carrierAudio('telnyx', audio, streamSid) : audio) as P extends 'carrier' ? string : Buffer;
  }

  /**
   * No explicit connection acknowledgment is required by Telnyx.
   *
   * Unlike Twilio, Telnyx does not need a `connected` handshake message
   * before it starts sending media events.
   *
   * @param _streamSid - Unused (accepted for interface parity).
   * @returns Always `null`.
   */
  formatConnected(_streamSid: string): null {
    return null;
  }

  /** Stops queued carrier playback. */
  formatClear(streamSid: string): string | null { return this.protocol === 'carrier' ? carrierClear('telnyx', streamSid) : null; }
  /** Marks carrier playback. */
  formatMark(streamSid: string, name: string): string | null { return this.protocol === 'carrier' ? carrierMark('telnyx', streamSid, name) : null; }
}
