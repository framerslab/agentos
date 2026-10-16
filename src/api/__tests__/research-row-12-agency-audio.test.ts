import { once } from 'node:events';
import WebSocket from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { agency } from '../agency.js';

async function listenerFixture() {
  const a = agency({ agents: { helper: { provider: 'openai', model: 'fixture' } }, strategy: 'sequential', voice: { enabled: true } });
  const generate = vi.spyOn(a, 'generate').mockResolvedValue({ text: 'fixture reply' } as Awaited<ReturnType<typeof a.generate>>);
  const server = await a.listen!({ port: 0 });
  const client = new WebSocket(server.url); await once(client, 'open');
  return { a, generate, server, client, close: async () => { client.terminate(); await server.close(); await a.close(); } };
}
describe('agency text listener refuses audio', () => {
  it.each([Buffer.alloc(640), Buffer.from('{"text":"binary is still audio"}')])('rejects a binary frame without invoking the agency', async (bytes) => {
    const f = await listenerFixture();
    try {
      const response = once(f.client, 'message'); const closed = once(f.client, 'close');
      f.client.send(bytes); const [raw] = await response;
      expect(JSON.parse(raw.toString())).toMatchObject({ error: { code: 'audio_not_supported' } });
      expect((await closed)[0]).toBe(1003); expect(f.generate).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it('starts no generation for a text frame that follows a refused binary frame', async () => {
    const f = await listenerFixture();
    try {
      const closed = once(f.client, 'close');
      f.client.send(Buffer.alloc(640)); f.client.send('{"text":"sent after the refusal"}');
      expect((await closed)[0]).toBe(1003); expect(f.generate).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it('keeps JSON text requests working and exposes no audio success message', async () => {
    const f = await listenerFixture();
    try {
      const response = once(f.client, 'message'); f.client.send('{"text":"hello"}');
      expect(JSON.parse((await response)[0].toString())).toEqual({ text: 'fixture reply' });
      expect(f.generate).toHaveBeenCalledWith('hello');
    } finally { await f.close(); }
  });
  it('refuses overlapping generation without queuing another request', async () => {
    const f = await listenerFixture(); let finish!: (value: Awaited<ReturnType<typeof f.a.generate>>) => void;
    f.generate.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    try {
      f.client.send('{"text":"first"}'); await vi.waitFor(() => expect(f.generate).toHaveBeenCalledOnce());
      const response = once(f.client, 'message'); f.client.send('{"text":"second"}');
      expect(JSON.parse((await response)[0].toString())).toMatchObject({ error: { code: 'request_in_progress' } });
      expect(f.generate).toHaveBeenCalledOnce(); finish({ text: 'done' } as Awaited<ReturnType<typeof f.a.generate>>);
    } finally { await f.close(); }
  });
  it('does not expose provider errors or accept JSON audio envelopes', async () => {
    const f = await listenerFixture();
    try {
      const bad = once(f.client, 'message'); f.client.send('{"audio":"AA=="}');
      expect(JSON.parse((await bad)[0].toString())).toMatchObject({ error: { code: 'invalid_message' } });
      f.generate.mockRejectedValueOnce(new Error('private provider detail'));
      const response = once(f.client, 'message'); f.client.send('{"text":"hello"}');
      expect(JSON.parse((await response)[0].toString())).toEqual({ error: { code: 'generation_failed', message: 'Text generation failed.' } });
    } finally { await f.close(); }
  });
});
