import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketCallServer, CALL_WEBSOCKET_PROTOCOL } from '../WebSocketCallServer.js';
import { transportFixture } from './transportFixtures.js';

async function fixture() {
  const call = await transportFixture(); const http = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const server = new WebSocketCallServer({ maxConnections: 4, resolveCall: (id, origin) => id === 'call-a' && origin === call.seed.clientOrigin ? call.binding : undefined });
  http.on('upgrade', (request, socket, head) => server.handleUpgrade(request, socket, head));
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/web-calls/call-a/media`;
  const sockets: WebSocket[] = [];
  const open = async (suffix = '', origin = call.seed.clientOrigin, protocol = CALL_WEBSOCKET_PROTOCOL) => {
    const ws = new WebSocket(url + suffix, protocol, { origin }); sockets.push(ws); await once(ws, 'open'); return ws;
  };
  const authenticate = async (ws: WebSocket) => {
    const c = await call.grant(); const received = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'authenticate', callId: 'call-a', token: c.token, transportEpoch: c.transportEpoch }));
    const [data] = await received; const ready = JSON.parse(String(data)); expect(ready.type).toBe('ready'); return { c, ready };
  };
  const close = async () => { for (const ws of sockets) ws.terminate(); await server.close(); await call.runtime.stopSession(); await new Promise<void>((resolve) => http.close(() => resolve())); };
  return { call, open, authenticate, close };
}
function pcm(epoch: number, sequence: number, bytes = 640): Buffer {
  const frame = Buffer.alloc(12 + bytes); frame.writeUInt32LE(1, 0); frame.writeUInt32LE(epoch, 4); frame.writeUInt32LE(sequence, 8); return frame;
}
describe('authenticated WebSocket media over HTTP upgrade', () => {
  it('starts no inference or billing before the one-use first frame and rejects binary-first', async () => {
    const f = await fixture(); try {
      const ws = await f.open(); expect(f.call.runtime.state).toBe('idle'); expect((await f.call.manager.get('scope-a', 'call-a'))!.startedAt).toBeNull();
      const closed = once(ws, 'close'); ws.send(pcm(1, 1)); await closed;
      expect(f.call.runtime.state).toBe('idle'); expect((await f.call.manager.get('scope-a', 'call-a'))!.usage.connectedMs).toBe(0);
      const next = await f.open(); await f.authenticate(next); next.send(pcm(1, 1));
      await vi.waitFor(() => expect(f.call.stt.pushAudioScoped).toHaveBeenCalledOnce());
    } finally { await f.close(); }
  });
  it('rejects absent, foreign or token-bearing handshake authority', async () => {
    const f = await fixture(); try {
      await expect(f.open('?token=not-a-real-secret')).rejects.toThrow();
      await expect(f.open('', 'https://foreign.example.test')).rejects.toThrow();
      await expect(f.open('', f.call.seed.clientOrigin, 'other.protocol')).rejects.toThrow();
      expect(f.call.runtime.state).toBe('idle');
    } finally { await f.close(); }
  });
  it('keeps a sample timeline for a same-millisecond socket burst', async () => {
    const f = await fixture();
    const wallClock = vi.spyOn(Date, 'now');
    try {
      const ws = await f.open(); await f.authenticate(ws);
      wallClock.mockReturnValue(42_000);
      ws.send(pcm(1, 1)); ws.send(pcm(1, 2)); ws.send(pcm(1, 3));
      await vi.waitFor(() => expect(f.call.stt.pushAudioScoped).toHaveBeenCalledTimes(3));
      const push = vi.mocked(f.call.stt.pushAudioScoped);
      expect(push.mock.calls.map(([frame]) => frame.timestamp)).toEqual([0, 20, 40]);
      expect(push.mock.calls.map(([frame]) => frame.sequence)).toEqual([1, 2, 3]);
      expect(f.call.interrupted).toEqual([]);
    } finally { wallClock.mockRestore(); await f.close(); }
  });
  it('enforces the five-second first-frame deadline', async () => {
    const f = await fixture(); try {
      const ws = await f.open(); await once(ws, 'close');
      expect(f.call.runtime.state).toBe('idle'); expect((await f.call.manager.get('scope-a', 'call-a'))!.startedAt).toBeNull();
    } finally { await f.close(); }
  }, 10000);
  it('reattaches the existing call, rejects old packets and refuses a consumed media token', async () => {
    const f = await fixture(); try {
      const a = await f.open(); const first = await f.authenticate(a); const detached = once(f.call.runtime, 'detached'); a.terminate(); await detached;
      await vi.waitFor(() => expect(f.call.binding.state).toBe('connecting'));
      await vi.waitFor(async () => expect((await f.call.manager.get('scope-a', 'call-a'))!.state).toBe('reconnecting'));
      const b = await f.open(); const second = await f.authenticate(b); expect(second.c.transportEpoch).toBe(2);
      b.send(pcm(1, 1)); b.send(pcm(2, 1)); b.send(pcm(2, 1));
      await vi.waitFor(() => expect(f.call.stt.pushAudioScoped).toHaveBeenCalledOnce());
      const replay = await f.open(); const closed = once(replay, 'close');
      replay.send(JSON.stringify({ type: 'authenticate', callId: 'call-a', token: first.c.token, transportEpoch: 1 })); await closed;
      expect(f.call.binding.state).toBe('open'); expect((await f.call.manager.events('scope-a', 'call-a')).filter((e) => e.type === 'call.started')).toHaveLength(1);
    } finally { await f.close(); }
  });
  it('requires receiver playback, clears before a new generation and rejects config/oversized input', async () => {
    const f = await fixture(); try {
      const ws = await f.open(); await f.authenticate(ws);
      let audio: { generation: { workerGeneration: number; inferenceGeneration: number; transportEpoch: number }; sequence: number; samples: number; sampleRate: number } | undefined;
      ws.on('message', (data, binary) => {
        if (binary) return; const message = JSON.parse(String(data));
        if (message.type === 'audio') audio = message;
        if (message.type === 'clear') ws.send(JSON.stringify({ type: 'cleared', generation: message.generation, clearId: message.clearId }));
      });
      f.call.turn(); await vi.waitFor(() => expect(audio).toBeDefined());
      expect(f.call.runtime.state).toBe('speaking');
      ws.send(JSON.stringify({ type: 'playback', generation: audio!.generation, sequence: audio!.sequence, playedSamples: audio!.samples, sampleRate: audio!.sampleRate }));
      await vi.waitFor(() => expect(f.call.runtime.state).toBe('listening'));
      const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'config', tenant: 'foreign' })); await closed;
      const c = await f.open(); const oversized = once(c, 'close'); c.send(Buffer.alloc(8193)); await oversized;
    } finally { await f.close(); }
  });
  it('clears a chunk whose socket writes are still pending and keeps the connection open', async () => {
    const f = await fixture(); try {
      const ws = await f.open(); await f.authenticate(ws);
      const received: string[] = [];
      ws.on('message', (data, binary) => {
        if (binary) { received.push('pcm'); return; }
        const message = JSON.parse(String(data)); received.push(message.type);
        if (message.type === 'clear') ws.send(JSON.stringify({ type: 'cleared', generation: message.generation, clearId: message.clearId }));
      });
      const generation = f.call.binding.generation;
      // A barge-in's clear arrives before the chunk's metadata write has completed.
      const sending = f.call.binding.sendAudio({ scopeId: 'scope-a', callId: 'call-a', generation, sequence: 1, audio: Buffer.alloc(640), format: 'pcm', container: 'raw', sampleRate: 16000, durationMs: 20, text: '' });
      const clearing = f.call.binding.clearPlayback(generation);
      const [sent, cleared] = await Promise.allSettled([sending, clearing]);
      await expect(f.call.binding.sendControl(Object.assign({ type: 'agent_thinking' as const }, { scopeId: 'scope-a', callId: 'call-a', generation }))).resolves.toBeUndefined();
      expect(cleared.status).toBe('fulfilled');
      expect(sent).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'audio cancelled' }) });
      // The metadata and its PCM leave as a pair; the receiver discards the pair by its cleared generation.
      await vi.waitFor(() => expect(received).toEqual(['audio', 'clear', 'pcm', 'agent_thinking']));
      expect(f.call.binding.state).toBe('open');
    } finally { await f.close(); }
  });
  it('writes every generation notice in order when the next comes before the last write completes', async () => {
    const f = await fixture(); try {
      const ws = await f.open(); await f.authenticate(ws);
      const notices: number[] = [];
      ws.on('message', (data, binary) => {
        if (binary) return; const message = JSON.parse(String(data));
        if (message.type === 'generation') notices.push(message.generation.inferenceGeneration);
      });
      const g = f.call.binding.generation;
      // A turn and the interruption right after it record two generations within one socket write.
      await f.call.binding.recordGeneration({ ...g, inferenceGeneration: g.inferenceGeneration + 1 });
      await f.call.binding.recordGeneration({ ...g, inferenceGeneration: g.inferenceGeneration + 2 });
      await vi.waitFor(() => expect(notices).toEqual([g.inferenceGeneration + 1, g.inferenceGeneration + 2]));
      expect(ws.readyState).toBe(WebSocket.OPEN); expect(f.call.binding.state).toBe('open');
    } finally { await f.close(); }
  });
  it('closes a socket whose audio packet carries sequence 0', async () => {
    const f = await fixture(); try {
      const ws = await f.open(); await f.authenticate(ws);
      let closed = false; ws.on('close', () => { closed = true; });
      ws.send(pcm(1, 0));
      await vi.waitFor(() => expect(closed).toBe(true));
      expect(f.call.stt.pushAudioScoped).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});
