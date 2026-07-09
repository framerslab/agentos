/**
 * @module io/avatar/providers/SimliServerSession
 *
 * Server-driven media path for Simli: Node owns the WebRTC peer connection
 * and drives the avatar over Simli's documented AsyncAPI websocket protocol
 * (`wss …/compose/webrtc/p2p` — Simli renamed the address from
 * `peer_to_peer`; their served asyncapi.yaml lagged the rename and the old
 * path 403s every token, live-probed 2026-07-09).
 *
 * Protocol (verified 2026-07-08 against api.simli.ai/asyncapi.yaml):
 * - Session token rides the query string; optional `enableSFU=true` relays
 *   traffic through Cloudflare for reliability.
 * - The FIRST websocket message must be an RTC offer (`{type:'offer',sdp}`)
 *   within 30 seconds; the server replies `{type:'answer',sdp}`.
 * - Upstream audio is BINARY frames (pcm16 chunks as raw bytes — never
 *   base64/JSON).
 * - Control strings: `"SKIP"` (avatar stops speaking immediately and drops
 *   all buffered audio — the barge-in primitive) and `"DONE"` (close after
 *   playing out remaining audio).
 * - Server events arrive as text (`START|ACK|STOP|SPEAK|SILENT`); terminal
 *   strings matching `ERROR|RATE|CLOSING …` surface as errors.
 *
 * The native `wrtc` dependency is dynamically imported inside
 * {@link createSimliServerSession} (mirroring `createWebRTCTransport()`), so
 * importing this module never requires the native dep — only USING the
 * server-driven mode does. Client-delegated consumers never touch this file.
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { AvatarSessionHandle } from '../types.js';

/** Server event strings the protocol documents. */
const SERVER_EVENTS = new Set(['START', 'ACK', 'STOP', 'SPEAK', 'SILENT']);

/** Terminal error prefixes per the AsyncAPI error message contract. */
const ERROR_PREFIX = /^(ERROR|RATE|CLOSING)\b/i;

/** Options for {@link createSimliServerSession}. */
export interface SimliServerSessionOptions {
  /** Relay traffic through Cloudflare's network (AsyncAPI `enableSFU`). */
  enableSFU?: boolean;
  /** Websocket base. @default 'wss://api.simli.ai' */
  wsBaseUrl?: string;
  /** Injectable wrtc loader for tests. @default dynamic `import('wrtc')` */
  loadWrtc?: () => Promise<unknown>;
  /** Injectable websocket factory for tests. */
  wsFactory?: (url: string) => WebSocket;
}

/**
 * One live server-driven Simli session: an owned RTCPeerConnection (media
 * downlink) plus the control/audio websocket (uplink).
 *
 * Events: `'event'` (protocol strings SPEAK/SILENT/…), `'track'` (inbound
 * media track from the peer), `'error'`, `'close'`.
 */
export class SimliServerSession extends EventEmitter {
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly pc: {
      setRemoteDescription(desc: unknown): Promise<void>;
      close(): void;
    }
  ) {
    super();
    ws.on('message', (raw: unknown, isBinary?: boolean) => this.onMessage(raw, isBinary));
    ws.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        this.emit('close');
      }
    });
    ws.on('error', (err: Error) => {
      if (!this.closed) this.emit('error', err);
    });
  }

  private onMessage(raw: unknown, isBinary?: boolean): void {
    if (this.closed || isBinary) return;
    const text = String(raw);
    // Answer to our offer → apply to the peer.
    if (text.startsWith('{')) {
      try {
        const msg = JSON.parse(text) as { type?: string; sdp?: string };
        if (msg.type === 'answer' && typeof msg.sdp === 'string') {
          void this.pc
            .setRemoteDescription({ type: 'answer', sdp: msg.sdp })
            .catch((err: Error) => this.emit('error', err));
        }
      } catch {
        /* non-JSON braces — not part of the documented surface */
      }
      return;
    }
    if (SERVER_EVENTS.has(text)) {
      this.emit('event', text);
      return;
    }
    if (ERROR_PREFIX.test(text)) {
      this.emit('error', new Error(`Simli session terminated: ${text}`));
      this.close();
    }
  }

  /**
   * Ship one pcm16 audio chunk for the avatar to lip-sync — BINARY frame,
   * exactly as the AsyncAPI documents (UInt8Array/octet-stream).
   */
  sendAudio(chunk: Buffer): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(chunk);
  }

  /** Barge-in: avatar stops speaking NOW and drops all buffered audio. */
  interrupt(): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send('SKIP');
  }

  /** Final segment sent — server closes after playing out the remainder. */
  finish(): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send('DONE');
  }

  /** Tear down the socket and the peer connection (idempotent). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
    try {
      this.pc.close();
    } catch {
      /* already gone */
    }
    this.emit('close');
  }
}

/**
 * Open a server-driven Simli session: dynamically load `wrtc`, create the
 * peer, connect the websocket, send the offer as the FIRST message, and
 * return the live session. The 30-second offer budget is comfortably met by
 * sending it on socket open.
 *
 * @throws Error with install guidance when the optional `wrtc` native
 *   dependency is not available.
 */
export async function createSimliServerSession(
  handle: AvatarSessionHandle,
  opts: SimliServerSessionOptions = {}
): Promise<SimliServerSession> {
  const loadWrtc = opts.loadWrtc ?? (() => import('wrtc' as string));
  let wrtcModule: unknown;
  try {
    wrtcModule = await loadWrtc();
  } catch (err) {
    throw new Error(
      'Simli server-driven mode requires the optional `wrtc` package ' +
        '(npm install wrtc, or a compatible polyfill). Client-delegated mode ' +
        `needs no native deps. Underlying error: ${(err as Error).message}`
    );
  }
  const { RTCPeerConnection } = wrtcModule as {
    RTCPeerConnection: new (config: { iceServers: unknown[] }) => {
      createOffer(): Promise<{ type: string; sdp: string }>;
      setLocalDescription(desc: unknown): Promise<void>;
      setRemoteDescription(desc: unknown): Promise<void>;
      addTransceiver?: (kind: string, init?: unknown) => unknown;
      close(): void;
      ontrack: unknown;
    };
  };

  const pc = new RTCPeerConnection({ iceServers: handle.iceServers });
  // Receive-only media: the avatar's audio+video come DOWN the peer; our
  // audio goes UP the websocket as binary chunks.
  pc.addTransceiver?.('video', { direction: 'recvonly' });
  pc.addTransceiver?.('audio', { direction: 'recvonly' });

  const base = opts.wsBaseUrl ?? 'wss://api.simli.ai';
  const url =
    `${base}/compose/webrtc/p2p?session_token=${encodeURIComponent(handle.sessionToken)}` +
    (opts.enableSFU ? '&enableSFU=true' : '');
  const ws = opts.wsFactory ? opts.wsFactory(url) : new WebSocket(url);

  const session = new SimliServerSession(ws, pc);
  (pc as { ontrack: unknown }).ontrack = (ev: unknown) => session.emit('track', ev);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    ws.once('error', onError);
    if ((ws as { readyState: number }).readyState === WebSocket.OPEN) {
      ws.off('error', onError);
      resolve();
    } else {
      ws.once('open', () => {
        ws.off('error', onError);
        resolve();
      });
    }
  });
  // FIRST message on the wire must be the offer (30s budget per AsyncAPI).
  ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));

  return session;
}
