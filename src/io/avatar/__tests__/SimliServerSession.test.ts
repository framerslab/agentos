/**
 * SimliServerSession — the Node-owned media path over the documented
 * AsyncAPI protocol: wrtc-missing error, offer-first ordering, answer
 * application, BINARY audio passthrough, SKIP/DONE controls, event + error
 * surfacing.
 */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSimliServerSession } from '../providers/SimliServerSession.js';
import type { AvatarSessionHandle } from '../types.js';

const HANDLE: AvatarSessionHandle = {
  sessionToken: 'st-1',
  iceServers: [{ urls: ['turn:x'], username: 'u', credential: 'c' }],
  audioFormat: 'pcm16',
  sampleRate: 16000,
};

class MockWs extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  url: string;
  sent: unknown[] = [];
  close = vi.fn();
  send = vi.fn((payload: unknown) => {
    this.sent.push(payload);
  });
  constructor(url: string) {
    super();
    this.url = url;
    process.nextTick(() => this.emit('open'));
  }
}

function stubWrtc() {
  const pc = {
    localDescription: null as unknown,
    createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' })),
    setLocalDescription: vi.fn(async (d: unknown) => {
      pc.localDescription = d;
    }),
    setRemoteDescription: vi.fn(async () => {}),
    addTransceiver: vi.fn(),
    close: vi.fn(),
    ontrack: null,
  };
  const RTCPeerConnection = vi.fn(() => pc);
  return { module: { RTCPeerConnection }, pc, RTCPeerConnection };
}

const wsFactory = (holder: { ws?: MockWs }) => (url: string) => {
  const ws = new MockWs(url);
  holder.ws = ws;
  return ws as never;
};

describe('createSimliServerSession', () => {
  it('rejects with a helpful error when wrtc is unavailable', async () => {
    await expect(
      createSimliServerSession(HANDLE, {
        loadWrtc: async () => {
          throw new Error("Cannot find module 'wrtc'");
        },
      })
    ).rejects.toThrow(/wrtc/);
  });

  it('sends the RTC offer as the FIRST websocket message', async () => {
    const { module } = stubWrtc();
    const holder: { ws?: MockWs } = {};
    await createSimliServerSession(HANDLE, {
      loadWrtc: async () => module,
      wsFactory: wsFactory(holder),
    });
    const first = JSON.parse(String(holder.ws!.sent[0]));
    expect(first).toEqual({ type: 'offer', sdp: 'offer-sdp' });
    expect(holder.ws!.url).toContain('/compose/webrtc/p2p');
    expect(holder.ws!.url).toContain('st-1');
  });

  it('applies the answer to the peer connection', async () => {
    const { module, pc } = stubWrtc();
    const holder: { ws?: MockWs } = {};
    await createSimliServerSession(HANDLE, {
      loadWrtc: async () => module,
      wsFactory: wsFactory(holder),
    });
    holder.ws!.emit('message', JSON.stringify({ type: 'answer', sdp: 'answer-sdp' }));
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer-sdp' });
  });

  it('passes ICE servers into the peer connection', async () => {
    const { module, RTCPeerConnection } = stubWrtc();
    const holder: { ws?: MockWs } = {};
    await createSimliServerSession(HANDLE, {
      loadWrtc: async () => module,
      wsFactory: wsFactory(holder),
    });
    expect(RTCPeerConnection).toHaveBeenCalledWith({ iceServers: HANDLE.iceServers });
  });

  it('sendAudio ships BINARY frames (raw Buffer, not JSON/base64)', async () => {
    const { module } = stubWrtc();
    const holder: { ws?: MockWs } = {};
    const session = await createSimliServerSession(HANDLE, {
      loadWrtc: async () => module,
      wsFactory: wsFactory(holder),
    });
    const chunk = Buffer.from([0, 1, 2, 3]);
    session.sendAudio(chunk);
    const sent = holder.ws!.sent.at(-1);
    expect(Buffer.isBuffer(sent)).toBe(true);
    expect((sent as Buffer).equals(chunk)).toBe(true);
  });

  it('interrupt sends SKIP; finish sends DONE', async () => {
    const { module } = stubWrtc();
    const holder: { ws?: MockWs } = {};
    const session = await createSimliServerSession(HANDLE, {
      loadWrtc: async () => module,
      wsFactory: wsFactory(holder),
    });
    session.interrupt();
    session.finish();
    expect(holder.ws!.sent).toContain('SKIP');
    expect(holder.ws!.sent).toContain('DONE');
  });

  it('re-emits server events and surfaces terminal errors', async () => {
    const { module } = stubWrtc();
    const holder: { ws?: MockWs } = {};
    const session = await createSimliServerSession(HANDLE, {
      loadWrtc: async () => module,
      wsFactory: wsFactory(holder),
    });
    const events: string[] = [];
    const errors: Error[] = [];
    session.on('event', (e: string) => events.push(e));
    session.on('error', (e: Error) => errors.push(e));
    holder.ws!.emit('message', 'SPEAK');
    holder.ws!.emit('message', 'SILENT');
    holder.ws!.emit('message', 'ERROR: INVALID_API_KEY');
    expect(events).toEqual(['SPEAK', 'SILENT']);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('INVALID_API_KEY');
  });

  it('close tears down the socket and the peer', async () => {
    const { module, pc } = stubWrtc();
    const holder: { ws?: MockWs } = {};
    const session = await createSimliServerSession(HANDLE, {
      loadWrtc: async () => module,
      wsFactory: wsFactory(holder),
    });
    session.close();
    expect(holder.ws!.close).toHaveBeenCalled();
    expect(pc.close).toHaveBeenCalled();
  });

  it('enableSFU rides the query string', async () => {
    const { module } = stubWrtc();
    const holder: { ws?: MockWs } = {};
    await createSimliServerSession(HANDLE, {
      loadWrtc: async () => module,
      wsFactory: wsFactory(holder),
      enableSFU: true,
    });
    expect(holder.ws!.url).toContain('enableSFU=true');
  });
});
