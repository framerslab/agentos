import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import { WebSocketStreamTransport, type WebSocketLike } from '../voice-pipeline/WebSocketStreamTransport.js';
import { PlaybackAcknowledgements, PlaybackAcknowledgementSchema } from '../voice-pipeline/PlaybackAcknowledgements.js';
import { inspectPcm16 } from '../voice-pipeline/audioFormat.js';
import type { AudioFrame, EncodedAudioChunk, IPlaybackTransport, PlaybackReceipt, ServerTextMessage, VoiceGeneration } from '../voice-pipeline/types.js';
import type { CallTransportBinding } from './CallTransportBinding.js'; import { MediaAuthenticationSchema } from './contracts/index.js';

/** Public browser media protocol; credentials are sent only after negotiation. */
export const CALL_WEBSOCKET_PROTOCOL = 'agentos.voice.v1';
const authSchema = MediaAuthenticationSchema;
const commandSchema = z.strictObject({ type: z.literal('control'), action: z.strictObject({ type: z.enum(['mute', 'unmute', 'stop']) }) });
const ACK_TIMEOUT = 5000;
/** Host routing only. The returned binding performs durable authentication and slot/dispatch checks. */
export interface WebSocketCallServerOptions {
  maxConnections: number;
  /** Absolute route prefix without a trailing slash. Hosted hosts pass /api/v1/web-calls. */
  pathPrefix?: string;
  /** Lookup of an existing worker binding, rejecting foreign Origin. Must not allocate calls or start inference. */
  resolveCall(callId: string, origin: string): CallTransportBinding | undefined;
}
function bytes(data: RawData): Buffer {
  return Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}
function send(ws: WebSocket, data: string | Buffer): Promise<void> {
  if (ws.readyState !== ws.OPEN || ws.bufferedAmount + Buffer.byteLength(data) > 65536) return Promise.reject(new Error('socket backpressure'));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('socket send timeout')); }, ACK_TIMEOUT);
    try { ws.send(data, (error) => { clearTimeout(timer); if (error) reject(new Error('socket send failed')); else resolve(); }); }
    catch { clearTimeout(timer); reject(new Error('socket send failed')); }
  });
}
class ValidatedSocket extends EventEmitter implements WebSocketLike {
  constructor(private readonly ws: WebSocket) { super(); }
  get readyState(): number { return this.ws.readyState; }
  readonly OPEN = 1;
  readonly CLOSED = 3;
  send(data: Buffer | string, cb?: (error?: Error) => void): void { void send(this.ws, data).then(() => cb?.(), () => cb?.(new Error('socket send failed'))); }
  close(_code?: number, _reason?: string): void { this.ws.terminate(); }
  audio(pcm: Buffer): void { this.emit('message', pcm, true); }
  command(message: z.infer<typeof commandSchema>): void { this.emit('message', JSON.stringify(message), false); }
  ended(): void { this.emit('close'); }
}
class SocketPlaybackTransport extends EventEmitter implements IPlaybackTransport {
  readonly id: string;
  private readonly base: WebSocketStreamTransport;
  private readonly acks = new PlaybackAcknowledgements(ACK_TIMEOUT);
  private sending = false;
  private controlPending = false;
  private cancelled = 0;
  private receivedSamples = 0;
  private wireSequence = 0;
  constructor(private readonly ws: WebSocket, readonly bridge: ValidatedSocket) {
    super(); this.base = new WebSocketStreamTransport(bridge, { sampleRate: 16000, inboundEncoding: 'linear16' }); this.id = this.base.id;
    this.base.on('audio', (frame: AudioFrame) => {
      const timestamp = this.receivedSamples * 1000 / 16000;
      this.receivedSamples += frame.samples.length;
      this.emit('audio', { ...frame, timestamp, sequence: this.wireSequence });
    });
    this.base.on('message', (message: unknown) => this.emit('message', message));
    this.base.on('close', () => { this.acks.close(); this.emit('close'); });
    this.base.on('error', () => { this.close(); });
  }
  get state(): 'connecting' | 'open' | 'closing' | 'closed' { return this.base.state; }
  /**
   * Sends the chunk's metadata message, then its PCM16 binary message. The pair always leaves whole: the receiver frames
   * each binary message by the metadata before it and discards a pair whose generation it has cleared. A clearPlayback()
   * that lands during the writes rejects the chunk with `audio cancelled` once the pair is out and leaves the connection
   * open; only a write that fails closes it.
   */
  async sendAudio(chunk: EncodedAudioChunk): Promise<void> {
    if (this.sending || !chunk.generation || !chunk.sequence) throw new Error('invalid audio admission');
    const pcm = inspectPcm16(chunk);
    if (pcm.pcm.length > 64000 || pcm.durationMs > 2000) throw new Error('audio bound');
    const receipt = { generation: { ...chunk.generation }, sequence: chunk.sequence, playedSamples: pcm.samples, sampleRate: pcm.sampleRate };
    this.acks.begin(receipt); this.sending = true; const epoch = this.cancelled;
    try {
      await send(this.ws, JSON.stringify({ type: 'audio', scopeId: chunk.scopeId, callId: chunk.callId, generation: receipt.generation, sequence: receipt.sequence, samples: pcm.samples, sampleRate: pcm.sampleRate, encoding: 'pcm16le', channels: 1 }));
      await this.base.sendAudio({ ...chunk, audio: pcm.pcm, container: 'raw' });
    } catch { this.acks.close(); this.close(); throw new Error('audio send failed'); }
    finally { this.sending = false; }
    if (epoch !== this.cancelled) throw new Error('audio cancelled');
  }
  async sendControl(message: ServerTextMessage): Promise<void> {
    if (this.controlPending) throw new Error('control backpressure'); this.controlPending = true;
    try { await this.base.sendControl(message); } finally { this.controlPending = false; }
  }
  waitForPlayback(generation: VoiceGeneration, sequence: number, signal: AbortSignal): Promise<PlaybackReceipt> { return this.acks.wait(generation, sequence, signal); }
  async clearPlayback(generation: VoiceGeneration): Promise<void> {
    this.cancelled++;
    if (this.ws.readyState !== this.ws.OPEN) { this.acks.close(); return; }
    await this.acks.clear(generation, (message) => send(this.ws, JSON.stringify(message)));
  }
  receiveReceipt(value: unknown): void { this.acks.receive(value); }
  receiveAudio(pcm: Buffer, sequence: number): void { this.wireSequence = sequence; this.bridge.audio(pcm); }
  close(_code?: number, _reason?: string): void { this.acks.close(); this.base.close(1000, 'media closed'); }
}
/** Owns only upgrades for the configured route. No inference or billable connection exists before media admission. */
export class WebSocketCallServer {
  private readonly wss: WebSocketServer;
  private readonly prefix: string;
  private closing = false;
  private readonly operations = new Set<Promise<void>>();
  constructor(private readonly options: WebSocketCallServerOptions) {
    if (!Number.isSafeInteger(options.maxConnections) || options.maxConnections < 1) throw new Error('invalid connection bound');
    this.prefix = options.pathPrefix ?? '/web-calls';
    if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(this.prefix)) throw new Error('invalid route prefix');
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false,
      handleProtocols: (protocols) => protocols.size === 1 && protocols.has(CALL_WEBSOCKET_PROTOCOL) ? CALL_WEBSOCKET_PROTOCOL : false });
    this.wss.on('error', () => { /* Per-connection callbacks own safe failure responses. */ });
  }
  /** Pass from the HTTP server's upgrade event; no credential is read from URL or handshake headers. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (): void => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); };
    const origin = request.headers.origin; const url = request.url ?? '';
    if (this.closing || this.wss.clients.size + this.operations.size >= this.options.maxConnections || request.method !== 'GET' || typeof origin !== 'string' || request.headers.authorization || request.headers.cookie || request.headers['sec-websocket-protocol'] !== CALL_WEBSOCKET_PROTOCOL || url.includes('?') || url.includes('#') || head.length > 8192) { refuse(); return; }
    let canonical: URL;
    try { canonical = new URL(origin); } catch { refuse(); return; }
    if (!['https:', 'http:'].includes(canonical.protocol) || canonical.origin !== origin || canonical.username || canonical.password) { refuse(); return; }
    const prefix = `${this.prefix}/`; const suffix = '/media';
    if (!url.startsWith(prefix) || !url.endsWith(suffix)) { refuse(); return; }
    const callId = url.slice(prefix.length, -suffix.length);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callId)) { refuse(); return; }
    let binding: CallTransportBinding | undefined;
    try { binding = this.options.resolveCall(callId, origin); } catch { refuse(); return; }
    if (!binding) { refuse(); return; }
    try { this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws, binding!, origin)); }
    catch { socket.destroy(); }
  }
  private accept(ws: WebSocket, binding: CallTransportBinding, origin: string): void {
    let phase: 'first' | 'authenticating' | 'open' | 'closed' = 'first'; let lastSequence = 0;
    let physical: SocketPlaybackTransport | undefined; let acceptedEpoch = 0;
    const deadline = setTimeout(() => ws.terminate(), 5000);
    const terminate = (): void => { ws.terminate(); };
    // Each notice is written as its generation is recorded, so it reaches the client ahead of every message of that
    // generation, however quickly the next one follows; send() still bounds the buffered bytes and each write's deadline.
    const generation = (value: VoiceGeneration): void => {
      if (phase !== 'open') return;
      void send(ws, JSON.stringify({ type: 'generation', generation: value })).catch(terminate);
    };
    binding.on('generation', generation);
    ws.on('error', terminate);
    ws.on('close', () => { phase = 'closed'; clearTimeout(deadline); binding.off('generation', generation); physical?.bridge.ended(); });
    ws.on('message', (raw, binary) => {
      try {
        const data = bytes(raw);
        if (phase === 'first') {
          if (binary || data.length > 16384) { terminate(); return; }
          const auth = authSchema.parse(JSON.parse(data.toString('utf8'))); if (auth.callId !== binding.callId || auth.transportEpoch > 0xffffffff) { terminate(); return; } phase = 'authenticating';
          const bridge = new ValidatedSocket(ws); physical = new SocketPlaybackTransport(ws, bridge); const admitted = physical;
          const work = (async () => {
            try {
              await binding.reattach({ token: auth.token, origin, participantId: binding.participantId, transportEpoch: auth.transportEpoch, transport: 'websocket', physical: admitted });
              if ((phase as string) === 'closed' || ws.readyState !== ws.OPEN) throw new Error('admission expired');
              acceptedEpoch = auth.transportEpoch;
              await send(ws, JSON.stringify({ type: 'ready', generation: binding.generation, encoding: 'pcm16le', sampleRate: 16000, channels: 1, maxAudioBytes: 3200 }));
              if ((phase as string) === 'closed' || ws.readyState !== ws.OPEN) throw new Error('admission expired');
              clearTimeout(deadline); phase = 'open';
            } catch { terminate(); }
          })();
          this.operations.add(work); void work.finally(() => this.operations.delete(work)); return;
        }
        if (phase !== 'open' || !physical) { terminate(); return; }
        if (binary) {
          if (data.length < 14 || data.length > 3212 || (data.length - 12) % 2 !== 0) { terminate(); return; }
          const worker = data.readUInt32LE(0); const epoch = data.readUInt32LE(4); const sequence = data.readUInt32LE(8);
          // Sequences start at 1: a zero is malformed, not an old packet.
          if (sequence === 0) { terminate(); return; }
          if (worker !== binding.generation.workerGeneration || epoch !== acceptedEpoch || sequence <= lastSequence) return;
          if (sequence !== lastSequence + 1) physical.emit('gap', { lostMs: 0, reason: 'sequence' });
          lastSequence = sequence; physical.receiveAudio(data.subarray(12), sequence); return;
        }
        if (data.length > 4096) { terminate(); return; }
        const value: unknown = JSON.parse(data.toString('utf8'));
        const receipt = PlaybackAcknowledgementSchema.safeParse(value);
        if (receipt.success) { physical.receiveReceipt(receipt.data); return; }
        physical.bridge.command(commandSchema.parse(value));
      } catch { terminate(); }
    });
  }
  /** Stops accepting upgrades, tears down sockets and waits for already admitted host operations to finish. */
  async close(): Promise<void> {
    this.closing = true; for (const ws of this.wss.clients) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await Promise.allSettled([...this.operations]);
  }
}
