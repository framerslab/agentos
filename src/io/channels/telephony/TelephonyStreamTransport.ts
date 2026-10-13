/**
 * Telephony transport with retained compatibility construction and an explicit carrier profile.
 * Carrier mode authenticates start before audio, accepts PCM16 raw or WAV at declared rates,
 * converts to PCMU once, waits for carrier playback checkpoints and clears pending output on
 * interruption. It forwards no pipeline JSON to a carrier. This is a direct-carrier transport,
 * separate from room publishing and the hosted web-call transport.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { MediaStreamParser, MediaStreamIncoming } from './MediaStreamParser.js';
import { convertPcmToMulaw8k, convertMulawToPcm16 } from './telephony-audio.js';
import type {
  AudioFrame,
  EncodedAudioChunk,
  IStreamTransport,
  ServerTextMessage,
} from '../../voice-pipeline/types.js';

// ============================================================================
// TelephonyStreamTransport
// ============================================================================

/**
 * Optional construction-time configuration for {@link TelephonyStreamTransport}.
 */
export interface TelephonyStreamTransportConfig {
  /**
   * Sample rate the pipeline expects for inbound `AudioFrame` events.
   * Incoming 8 kHz telephony audio is upsampled to this rate. Carrier mode
   * accepts 8000 or 16000.
   * @defaultValue 16000
   */
  outputSampleRate?: number;
  /** Omission retains the original transport; carrier mode requires a carrier parser. */
  protocol?: 'legacy' | 'carrier';
  /** Validates the call and custom parameters against the already verified upgrade. Must be synchronous. */
  authorizeStart?: (start: Extract<MediaStreamIncoming, { type: 'start' }>) => boolean;
  /** Deadline for one write plus playback checkpoint; default 10000 ms, maximum 30000 ms. */
  playbackTimeoutMs?: number;
}

/**
 * The legacy compatibility implementation: {@link TelephonyStreamTransport}
 * constructs and delegates to it when no carrier protocol is selected. The
 * description below is this legacy behavior.
 *
 * Adapts a telephony provider WebSocket media stream to the
 * `IStreamTransport` interface consumed by the AgentOS voice pipeline.
 *
 * ## Inbound path (phone -> pipeline)
 * 1. Provider WebSocket frames arrive as raw `Buffer` or JSON `string`.
 * 2. {@link MediaStreamParser.parseIncoming} normalises them to
 *    {@link MediaStreamIncoming} events.
 * 3. `'audio'` events: mu-law 8 kHz -> Int16 PCM -> resample -> Float32 -> `'audio'` emit.
 * 4. `'dtmf'` / `'mark'` events are re-emitted as-is for higher-layer handling.
 * 5. `'start'` transitions the transport to `'open'` and sends the optional
 *    connection acknowledgment from the parser.
 * 6. `'stop'` or WebSocket close transitions to `'closed'` and emits `'close'`.
 *
 * ## Outbound path (pipeline -> phone)
 * 1. `sendAudio()` receives an `EncodedAudioChunk` (PCM Int16 format assumed).
 * 2. Chunk is resampled from `chunk.sampleRate` -> 8 kHz via linear interpolation.
 * 3. Resampled PCM is mu-law encoded via {@link convertPcmToMulaw8k}.
 * 4. {@link MediaStreamParser.formatOutgoing} wraps the bytes for the provider.
 * 5. The formatted payload is sent over the WebSocket.
 *
 * ## Events emitted
 * - `'audio'` (`AudioFrame`) -- inbound decoded audio for STT / VAD.
 * - `'dtmf'` (`{ digit: string; durationMs?: number }`) -- caller key-press.
 * - `'mark'` (`{ name: string }`) -- named stream marker.
 * - `'close'` () -- transport has been fully closed.
 * - `'error'` (Error) -- unrecoverable WebSocket or parsing error.
 *
 * @example
 * ```typescript
 * const parser = new TwilioMediaStreamParser();
 * const transport = new TelephonyStreamTransport(ws, parser, { outputSampleRate: 16000 });
 *
 * transport.on('audio', (frame: AudioFrame) => {
 *   // Feed to STT engine
 *   sttEngine.pushAudio(frame.samples, frame.sampleRate);
 * });
 *
 * transport.on('dtmf', ({ digit }) => {
 *   console.log(`Caller pressed: ${digit}`);
 * });
 * ```
 */
class LegacyTelephonyStreamTransport extends EventEmitter implements IStreamTransport {
  // ---------------------------------------------------------------------------
  // IStreamTransport -- identity & state
  // ---------------------------------------------------------------------------

  /** Stable UUID for this transport connection. */
  readonly id: string = randomUUID();

  /** Internal state -- not directly assignable from outside. */
  private _state: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';

  /**
   * Current connection lifecycle state.
   *
   * - `connecting` -- WebSocket is open but the provider's `start` event has not arrived yet.
   * - `open`       -- Stream is active; audio can be sent and received.
   * - `closing`    -- {@link close} was called; waiting for WS to finish closing.
   * - `closed`     -- Stream is fully terminated; no further I/O.
   */
  get state(): 'connecting' | 'open' | 'closing' | 'closed' {
    return this._state;
  }

  // ---------------------------------------------------------------------------
  // Private fields
  // ---------------------------------------------------------------------------

  /** Provider-assigned stream identifier; populated on the 'start' event. */
  private streamSid: string | null = null;

  /** Target sample rate for emitted AudioFrames (pipeline input requirement). */
  private readonly outputSampleRate: number;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  /**
   * Create a new telephony stream transport.
   *
   * Wires up WebSocket event handlers immediately. The transport starts in
   * `'connecting'` state and transitions to `'open'` when the provider sends
   * its `start` event through the media stream.
   *
   * @param ws - WebSocket-like object (must emit `'message'`, `'close'`, `'error'`
   *   and expose `send(data)` and `close(code?, reason?)` methods).
   * @param parser - Provider-specific message parser/formatter.
   * @param config - Optional configuration overrides.
   */
  constructor(
    private readonly ws: any, // WebSocket-like; typed `any` to avoid hard dep on ws package
    private readonly parser: MediaStreamParser,
    config?: TelephonyStreamTransportConfig
  ) {
    super();
    this.outputSampleRate = config?.outputSampleRate ?? 16000;

    this.ws.on('message', (data: Buffer | string) => {
      const parsed = this.parser.parseIncoming(data);
      if (!parsed) return;

      switch (parsed.type) {
        case 'start': {
          this.streamSid = parsed.streamSid;
          this._state = 'open';
          // Send connection acknowledgment if the provider requires one.
          // Twilio expects a { event: 'connected' } message; Telnyx/Plivo do not.
          const connMsg = this.parser.formatConnected?.(parsed.streamSid);
          if (connMsg) this.ws.send(connMsg);
          break;
        }

        case 'audio': {
          // Step 1: mu-law 8 kHz -> Int16 PCM buffer (2 bytes per sample).
          const pcm16Buf = convertMulawToPcm16(parsed.payload);

          // Step 2: Reinterpret the Node.js Buffer as a typed Int16Array.
          // Uses the same underlying ArrayBuffer (zero-copy) thanks to
          // Buffer's offset/length alignment guarantees.
          const int16 = new Int16Array(
            pcm16Buf.buffer,
            pcm16Buf.byteOffset,
            pcm16Buf.byteLength / 2
          );

          // Step 3: Resample 8 kHz -> outputSampleRate (typically 16 kHz).
          // Linear interpolation is good enough for narrow-band telephony voice.
          const resampled = this.resample(int16, 8000, this.outputSampleRate);

          // Step 4: Normalise Int16 range [-32768, 32767] to Float32 [-1.0, 1.0].
          // Division by 32768 (not 32767) matches the WebAudio / Whisper convention.
          const float32 = new Float32Array(resampled.length);
          for (let i = 0; i < resampled.length; i++) {
            float32[i] = resampled[i] / 32768;
          }

          const frame: AudioFrame = {
            samples: float32,
            sampleRate: this.outputSampleRate,
            timestamp: Date.now(),
          };
          this.emit('audio', frame);
          break;
        }

        case 'dtmf':
          // Relay DTMF as a separate event so higher-layer IVR/menu logic
          // can react without parsing audio frames.
          this.emit('dtmf', { digit: parsed.digit, durationMs: parsed.durationMs });
          break;

        case 'stop':
          this._state = 'closed';
          this.emit('close');
          break;

        case 'mark':
          // Marks correlate outbound audio playback with application events
          // (e.g., "TTS utterance finished playing to the caller").
          this.emit('mark', { name: parsed.name });
          break;
      }
    });

    // Handle unexpected WS closure (network drop, server-side disconnect).
    // Guard against double-firing if we already processed a 'stop' event.
    this.ws.on('close', () => {
      if (this._state !== 'closed') {
        this._state = 'closed';
        this.emit('close');
      }
    });

    this.ws.on('error', (err: Error) => this.emit('error', err));
  }

  // ---------------------------------------------------------------------------
  // IStreamTransport -- outbound methods
  // ---------------------------------------------------------------------------

  /**
   * Send synthesised audio to the caller.
   *
   * Assumes `chunk.format === 'pcm'` and that `chunk.audio` contains raw
   * signed 16-bit little-endian PCM samples at `chunk.sampleRate`. The audio
   * is resampled to 8 kHz, mu-law encoded, and forwarded via the parser.
   *
   * No-op if the transport is not in the `'open'` state (e.g., before the
   * provider's `start` event or after the stream has closed).
   *
   * @param chunk - Encoded audio chunk from the TTS pipeline.
   */
  async sendAudio(chunk: EncodedAudioChunk): Promise<void> {
    if (!this.streamSid || this._state !== 'open') return;

    // Interpret raw bytes as Int16 samples.
    const int16 = new Int16Array(
      chunk.audio.buffer,
      chunk.audio.byteOffset,
      chunk.audio.byteLength / 2
    );

    // Resample to 8 kHz first, then encode to mu-law.
    // We pre-resample so convertPcmToMulaw8k's internal resampler sees 8 kHz
    // input and acts as a no-op, avoiding a redundant second pass.
    const resampled8k = this.resample(int16, chunk.sampleRate, 8000);
    const pcm8kBuf = Buffer.from(
      resampled8k.buffer,
      resampled8k.byteOffset,
      resampled8k.byteLength
    );

    // Encode to mu-law (ITU G.711). Pass sampleRate=8000 so the function's
    // internal resampler is a no-op.
    const mulaw = convertPcmToMulaw8k(pcm8kBuf, 8000);

    const formatted = this.parser.formatOutgoing(mulaw, this.streamSid);
    this.ws.send(formatted);
  }

  /**
   * Send a JSON control message over the WebSocket.
   *
   * No-op if the transport is not in the `'open'` state.
   *
   * @param message - Server-to-client pipeline protocol message.
   */
  async sendControl(message: ServerTextMessage): Promise<void> {
    if (this._state !== 'open') return;
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Initiate graceful closure of the transport.
   *
   * Sets state to `'closing'` and delegates to the underlying WebSocket's
   * `close()` method. The actual transition to `'closed'` happens when the
   * WebSocket's `'close'` event fires.
   *
   * @param code - Optional WebSocket close code (default 1000).
   * @param reason - Optional human-readable close reason.
   */
  close(code?: number, reason?: string): void {
    this._state = 'closing';
    this.ws.close(code, reason);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Linear interpolation resampler for 16-bit signed PCM.
   *
   * Not studio-quality but sufficient for narrow-band voice telephony where
   * the source material is already limited to ~3.4 kHz bandwidth by the PSTN.
   * A higher-quality sinc interpolator would add latency and complexity with
   * negligible perceptual improvement at telephone bandwidths.
   *
   * The output length is computed as `round(input.length * toRate / fromRate)`
   * to avoid cumulative rounding drift across many small frames.
   *
   * @param input - Source samples as a signed 16-bit integer array.
   * @param fromRate - Sample rate of the input, in Hz.
   * @param toRate - Desired sample rate of the output, in Hz.
   * @returns A new Int16Array at `toRate`.
   */
  private resample(input: Int16Array, fromRate: number, toRate: number): Int16Array {
    // No-op fast path: avoid allocation when rates match.
    if (fromRate === toRate) return input;

    const ratio = fromRate / toRate;
    const outputLen = Math.round(input.length / ratio);
    const output = new Int16Array(outputLen);

    for (let i = 0; i < outputLen; i++) {
      const srcIdx = i * ratio;
      const idx = Math.floor(srcIdx);
      const frac = srcIdx - idx;
      // Linear interpolation between adjacent samples.
      const a = input[idx] ?? 0;
      const b = input[Math.min(idx + 1, input.length - 1)] ?? 0;
      output[i] = Math.round(a + frac * (b - a));
    }

    return output;
  }
}

/** Optional generation stamp, structurally compatible with the voice pipeline generation. */
export interface TelephonyPlaybackGeneration { workerGeneration: number; inferenceGeneration: number; transportEpoch: number }
/** Telephone output accepts declared PCM16 containers; compression is explicitly refused. */
export type TelephonyAudioChunk = EncodedAudioChunk & { container?: 'raw' | 'wav'; generation?: TelephonyPlaybackGeneration };
/** Audio with carrier timing kept separate from the transport's monotonic relative clock. */
export interface TelephonyAudioFrame extends AudioFrame { sourceTimestampMs?: number; mediaChunk?: number; sequenceNumber?: number }
/** Narrow WebSocket adapter used in carrier mode. send's callback means written, not played. */
export interface TelephonySocket {
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(data: Buffer | string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount?: number;
}
/** Returns the chunk's PCM16 samples, reading a WAV container once; refuses anything else before output. */
function telephonePcm(chunk: TelephonyAudioChunk): Buffer {
  const fail = (): never => { throw new Error('unsupported or inconsistent telephony audio format'); };
  if (chunk.format !== 'pcm' || ![8000, 16000, 24000, 48000].includes(chunk.sampleRate) || chunk.audio.length > 196608) return fail();
  const bytes = chunk.audio; let pcm = bytes;
  if (chunk.container === 'wav') {
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) return fail();
    let fmt = false; let data = false; let at = 12;
    while (at < bytes.length) {
      if (at + 8 > bytes.length) return fail();
      const kind = bytes.toString('ascii', at, at + 4); const length = bytes.readUInt32LE(at + 4); const begin = at + 8; const end = begin + length;
      if (end > bytes.length) return fail();
      if (kind === 'fmt ') {
        if (fmt || length < 16 || bytes.readUInt16LE(begin) !== 1 || bytes.readUInt16LE(begin + 2) !== 1 || bytes.readUInt32LE(begin + 4) !== chunk.sampleRate || bytes.readUInt32LE(begin + 8) !== chunk.sampleRate * 2 || bytes.readUInt16LE(begin + 12) !== 2 || bytes.readUInt16LE(begin + 14) !== 16) return fail();
        fmt = true;
      } else if (kind === 'data') { if (data) return fail(); data = true; pcm = bytes.subarray(begin, end); }
      at = end + length % 2;
    }
    if (!fmt || !data || at !== bytes.length) return fail();
  } else if ((chunk.container !== undefined && chunk.container !== 'raw') || ['RIFF', 'OggS'].includes(bytes.toString('ascii', 0, 4)) || bytes.toString('ascii', 0, 3) === 'ID3') return fail();
  const stride = chunk.sampleRate / 8000;
  if (!pcm.length || pcm.length % (2 * stride) !== 0) return fail();
  const duration = pcm.length / 2 / chunk.sampleRate * 1000;
  if (!Number.isFinite(chunk.durationMs) || Math.abs(duration - chunk.durationMs) > 1 || duration < 20 || duration > 2000) return fail();
  return pcm;
}
/** Orders generations by worker, then transport epoch, then inference; negative means `a` is older. */
function generationCompare(a: TelephonyPlaybackGeneration, b: TelephonyPlaybackGeneration): number {
  return a.workerGeneration - b.workerGeneration || a.transportEpoch - b.transportEpoch || a.inferenceGeneration - b.inferenceGeneration;
}
/** The one chunk awaiting its carrier checkpoint, with the clear epoch it was sent in. */
interface PendingCarrierPlayback {
  name: string; epoch: number; samples: number; sampleRate: number;
  resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>;
}
/** Opt-in carrier transport; the no-option construction retains the original transport behavior. */
export class TelephonyStreamTransport extends EventEmitter implements IStreamTransport {
  /** Stable connection identifier. */
  readonly id: string;
  private readonly legacy?: LegacyTelephonyStreamTransport;
  private current: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  private streamSid?: string;
  private readonly rate: number;
  private readonly timeoutMs: number;
  private pending?: PendingCarrierPlayback; private sending = false; private clearing = false;
  private epoch = 0;
  private serial = 0;
  private latestGeneration?: TelephonyPlaybackGeneration;
  private fencedGeneration?: TelephonyPlaybackGeneration;
  private lastChunk?: number;
  private lastSourceEnd?: number;
  private inputClock = 0;
  private startTimer?: ReturnType<typeof setTimeout>;
  private readonly ws: TelephonySocket;
  /**
   * Delegates compatibility construction, or installs bounded carrier I/O.
   *
   * @param ws - The provider's WebSocket, an object with the {@link TelephonySocket} shape.
   *   Typed loosely, as the released constructor was, so every existing caller keeps compiling.
   */
  constructor(ws: unknown, private readonly parser: MediaStreamParser, private readonly config: TelephonyStreamTransportConfig = {}) {
    super(); this.ws = ws as TelephonySocket; this.rate = config.outputSampleRate ?? 16000; this.timeoutMs = config.playbackTimeoutMs ?? 10000;
    if (config.protocol !== 'carrier') {
      this.legacy = new LegacyTelephonyStreamTransport(ws, parser, config); this.id = this.legacy.id;
      for (const event of ['audio', 'dtmf', 'mark', 'close', 'error']) this.legacy.on(event, (...args: unknown[]) => this.emit(event, ...args));
      return;
    }
    this.id = randomUUID();
    if (parser.protocol !== 'carrier' || !config.authorizeStart || !parser.formatClear || !parser.formatMark || ![8000, 16000].includes(this.rate) || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30000) throw new Error('invalid carrier transport configuration');
    this.startTimer = setTimeout(() => this.fail(new Error('carrier start timeout')), this.timeoutMs);
    this.ws.on('message', (raw: Buffer | string) => {
      if (this.current === 'closed' || this.current === 'closing') return;
      try { const frame = parser.parseIncoming(raw); if (frame) this.receive(frame); }
      catch (error) { this.fail(error instanceof Error ? error : new Error('carrier input failed')); }
    });
    this.ws.on('close', () => this.finish(new Error('carrier closed')));
    this.ws.on('error', (error: Error) => this.fail(error));
  }
  /** The physical transport state, with start authority required before carrier mode opens. */
  get state(): 'connecting' | 'open' | 'closing' | 'closed' { return this.legacy?.state ?? this.current; }
  private receive(frame: MediaStreamIncoming): void {
    if (frame.type === 'start') {
      if (this.current !== 'connecting' || this.config.authorizeStart!(frame) !== true) throw new Error('carrier start refused');
      clearTimeout(this.startTimer); this.startTimer = undefined; this.streamSid = frame.streamSid; this.current = 'open'; this.emit('start', { callSid: frame.callSid, streamSid: frame.streamSid }); return;
    }
    if (this.current !== 'open' || frame.streamSid !== this.streamSid) return;
    if (frame.type === 'stop') { this.close(); return; }
    if (frame.type === 'dtmf') { this.emit('dtmf', { digit: frame.digit, durationMs: frame.durationMs }); return; }
    if (frame.type === 'mark') {
      const p = this.pending;
      if (!p || p.epoch !== this.epoch || p.name !== frame.name) return;
      this.pending = undefined; clearTimeout(p.timer);
      this.emit('mark', { name: frame.name }); this.emit('playback', { name: frame.name, playedSamples: p.samples, sampleRate: p.sampleRate }); p.resolve(); return;
    }
    if (frame.mediaChunk !== undefined && this.lastChunk !== undefined && frame.mediaChunk <= this.lastChunk) return;
    const missing = frame.mediaChunk !== undefined && this.lastChunk !== undefined ? Math.max(0, frame.mediaChunk - this.lastChunk - 1) : 0;
    const gap = frame.timestampMs !== undefined && this.lastSourceEnd !== undefined ? Math.max(0, frame.timestampMs - this.lastSourceEnd) : 0;
    if (missing || gap) { this.emit('gap', { reason: 'carrier-media-gap', droppedMs: gap, missingChunks: missing }); this.inputClock += gap; }
    if (frame.mediaChunk !== undefined) this.lastChunk = frame.mediaChunk;
    const pcm = convertMulawToPcm16(frame.payload); const ratio = this.rate / 8000;
    const samples = new Float32Array(frame.payload.length * ratio);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(Math.floor(i / ratio) * 2) / 32768;
    const timestamp = this.inputClock; const duration = frame.payload.length / 8; this.inputClock += duration;
    if (frame.timestampMs !== undefined) this.lastSourceEnd = frame.timestampMs + duration;
    const audio: TelephonyAudioFrame = { samples, sampleRate: this.rate, timestamp, sourceTimestampMs: frame.timestampMs, mediaChunk: frame.mediaChunk, sequenceNumber: frame.sequenceNumber };
    this.emit('audio', audio);
  }
  private write(data: Buffer | string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.current !== 'open' || (this.ws.bufferedAmount ?? 0) > 65536) { reject(new Error('carrier output unavailable')); return; }
      const timer = setTimeout(() => { reject(new Error('carrier write timeout')); this.fail(new Error('carrier write timeout')); }, this.timeoutMs);
      try { this.ws.send(data, (error) => { clearTimeout(timer); if (error) reject(error); else resolve(); }); }
      catch (error) { clearTimeout(timer); reject(error); }
    });
  }
  /** One producer at a time; completion means its carrier mark was received before cancellation. */
  async sendAudio(chunk: TelephonyAudioChunk): Promise<void> {
    if (this.legacy) return this.legacy.sendAudio(chunk);
    if (this.current !== 'open' || !this.streamSid) throw new Error('carrier output unavailable');
    if (this.pending || this.sending || this.clearing) throw new Error('concurrent producer');
    const pcm = telephonePcm(chunk); const generation = chunk.generation;
    if (generation) {
      if (![generation.workerGeneration, generation.inferenceGeneration, generation.transportEpoch].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('invalid generation');
      if ((this.fencedGeneration && generationCompare(generation, this.fencedGeneration) <= 0) || (this.latestGeneration && generationCompare(generation, this.latestGeneration) < 0)) throw new Error('stale generation');
      this.latestGeneration = { ...generation };
    } else if (this.latestGeneration || this.epoch > 0) throw new Error('missing generation');
    const name = `audio-${this.epoch}-${++this.serial}`; const epoch = this.epoch;
    let resolve!: () => void; let reject!: (error: Error) => void;
    const played = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void played.catch(() => undefined);
    const timer = setTimeout(() => this.fail(new Error('carrier playback timeout')), this.timeoutMs);
    this.sending = true; this.pending = { name, epoch, samples: pcm.length / 2, sampleRate: chunk.sampleRate, resolve, reject, timer };
    try {
      const mulaw = convertPcmToMulaw8k(pcm, chunk.sampleRate);
      await this.write(this.parser.formatOutgoing(mulaw, this.streamSid));
      if (epoch !== this.epoch || this.current !== 'open') throw new Error('carrier playback cleared');
      const mark = this.parser.formatMark!(this.streamSid, name);
      if (!mark) throw new Error('carrier mark unavailable');
      await this.write(mark); await played;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('carrier output failed');
      if (epoch === this.epoch) this.fail(failure);
      throw failure; } finally { this.sending = false;
    }
  }
  /** Cancels pending playback before sending clear. All other pipeline controls remain local. */
  async sendControl(message: ServerTextMessage): Promise<void> {
    if (this.legacy) return this.legacy.sendControl(message);
    if (message.type !== 'barge_in' || (message.action.type !== 'cancel' && message.action.type !== 'pause') || this.current !== 'open' || !this.streamSid) return;
    if (this.clearing) throw new Error("concurrent clear"); this.clearing = true; this.epoch += 1; if (this.latestGeneration) this.fencedGeneration = { ...this.latestGeneration };
    const p = this.pending; this.pending = undefined; if (p) { clearTimeout(p.timer); p.reject(new Error('carrier playback cleared')); }
    try { const clear = this.parser.formatClear!(this.streamSid); if (!clear) throw new Error('carrier clear unavailable'); await this.write(clear); }
    catch (error) { this.fail(error instanceof Error ? error : new Error('carrier clear failed')); throw error; } finally { this.clearing = false; }
  }
  private fail(error: Error): void {
    if (this.current === 'closed') return;
    this.finish(error);
    try { this.ws.close(1011, 'carrier stream failed'); } catch { /* State and pending work are already closed. */ }
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }
  private finish(error: Error): void {
    if (this.current === 'closed') return;
    this.current = 'closed'; this.epoch += 1; clearTimeout(this.startTimer); this.startTimer = undefined;
    const p = this.pending; this.pending = undefined; if (p) { clearTimeout(p.timer); p.reject(error); }
    this.emit('close');
  }
  /** Stops admission and pending output once; subsequent socket-close events are harmless. */
  close(code?: number, reason?: string): void {
    if (this.legacy) { this.legacy.close(code, reason); return; }
    if (this.current === 'closed') return;
    this.finish(new Error('carrier closed')); this.ws.close(code ?? 1000, reason ?? 'closed');
  }
}
