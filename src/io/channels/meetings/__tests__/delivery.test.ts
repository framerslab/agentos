import { describe, it, expect } from 'vitest';
import { DestinationRefusedError, httpsSend, isPublicAddress, OutboxDispatcher, type DeliveryRequest } from '../delivery.js';
import { FakeClock, InMemoryOutbox } from '../stores/memory.js';
import { verifyEnvelope } from '../signing.js';

const names = { id: 'acme-hook-id', timestamp: 'acme-hook-ts', signature: 'acme-hook-sig' };

describe('isPublicAddress', () => {
  it('refuses every private, loopback, link-local and mapped form, and takes a public one', () => {
    for (const address of ['10.1.2.3', '127.0.0.1', '169.254.1.1', '100.64.0.9', '192.168.1.1', '172.16.5.5', '::1', '0:0:0:0:0:0:0:1', '::ffff:10.1.2.3', '::ffff:7f00:1', 'fe80::1', 'fd00::5', 'not an address']) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress('142.250.0.1')).toBe(true);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
  });
});

describe('httpsSend', () => {
  it('refuses http, credentials in the address, and a name that resolves to a private address, before any socket', async () => {
    const send = httpsSend({ lookup: async () => [{ address: '10.0.0.7', family: 4 }] });
    const request: DeliveryRequest = { url: 'https://hooks.example.test/in', headers: {}, body: '{}', timeoutMs: 1000 };
    await expect(send({ ...request, url: 'http://hooks.example.test/in' })).rejects.toBeInstanceOf(DestinationRefusedError);
    await expect(send({ ...request, url: 'https://user:pass@hooks.example.test/in' })).rejects.toBeInstanceOf(DestinationRefusedError);
    await expect(send(request)).rejects.toBeInstanceOf(DestinationRefusedError);
    const mixed = httpsSend({ lookup: async () => [{ address: '142.250.0.1', family: 4 }, { address: '10.0.0.1', family: 4 }] });
    await expect(mixed(request)).rejects.toBeInstanceOf(DestinationRefusedError);
    await expect(send({ ...request, url: 'https://127.0.0.1/in' })).rejects.toBeInstanceOf(DestinationRefusedError);
  });

  it("refuses an IPv6 address that carries a private IPv4 one under the network's own NAT64 prefix, before any socket", async () => {
    // A DNS64 resolver on a network whose NAT64 prefix is 3ffe:ffff:64::/96 answers ipv4only.arpa (192.0.0.170 and
    // 192.0.0.171) under that prefix, and writes a name whose only address is 10.0.0.7 as 3ffe:ffff:64::a00:7, which
    // reads as a global address.
    const synthesized = '3ffe:ffff:64::a00:7';
    const asked: string[] = [];
    const send = httpsSend({
      lookup: async (hostname) => {
        asked.push(hostname);
        return hostname === 'ipv4only.arpa'
          ? [{ address: '3ffe:ffff:64::c000:aa', family: 6 }, { address: '3ffe:ffff:64::c000:ab', family: 6 }]
          : [{ address: synthesized, family: 6 }];
      },
    });
    const request: DeliveryRequest = { url: 'https://hooks.example.test/in', headers: {}, body: '{}', timeoutMs: 1000 };
    expect(isPublicAddress(synthesized)).toBe(true);
    await expect(send(request)).rejects.toBeInstanceOf(DestinationRefusedError);
    await expect(send({ ...request, url: `https://[${synthesized}]/in` })).rejects.toBeInstanceOf(DestinationRefusedError);
    expect(asked).toContain('ipv4only.arpa');
    // prefixes that cannot be read clear no IPv6 address
    const unread = httpsSend({
      lookup: async (hostname) => {
        if (hostname === 'ipv4only.arpa') throw new Error('lookup failed');
        return [{ address: '3ffe:ffff:1::1', family: 6 }];
      },
    });
    await expect(unread(request)).rejects.toThrow(/NAT64 prefixes could not be read/);
  });
});

describe('OutboxDispatcher', () => {
  function setup(status: number | Error) {
    const clock = new FakeClock(1_700_000_000_000);
    const outbox = new InMemoryOutbox();
    const sent: DeliveryRequest[] = [];
    const dispatcher = new OutboxDispatcher({
      outbox,
      clock,
      names,
      resolve: async (ref) => (ref === 'hook-1' ? { url: 'https://hooks.example.test/in', secret: 'not-a-real-secret' } : undefined),
      send: async (request) => {
        sent.push(request);
        if (status instanceof Error) throw status;
        return { status };
      },
    });
    return { clock, outbox, sent, dispatcher };
  }

  it('signs each due delivery with the host\'s header names and marks a 2xx delivered', async () => {
    const t = setup(204);
    await t.outbox.enqueue({ id: 'e1@hook-1', runId: 'r1', destinationRef: 'hook-1', eventId: 'e1', type: 'bot:transcript', payload: '{"text":"we start at nine"}' }, t.clock.now());
    expect(await t.dispatcher.deliverDue()).toEqual({ delivered: 1, failed: 0 });
    expect(t.sent[0]?.body).toBe('{"text":"we start at nine"}');
    expect(verifyEnvelope('not-a-real-secret', t.sent[0]!.headers, t.sent[0]!.body, t.clock.now(), { names })).toEqual({ valid: true });
    expect(t.sent[0]?.headers['acme-hook-id']).toBe('e1@hook-1');
    expect((await t.outbox.listByRun('r1'))[0]?.state).toBe('delivered');
    expect(await t.dispatcher.deliverDue()).toEqual({ delivered: 0, failed: 0 });
  });

  it('marks a refusal, a 3xx and an error failed, and tries again only after the backoff', async () => {
    for (const status of [500, 302, new Error('socket hang up')]) {
      const t = setup(status);
      await t.outbox.enqueue({ id: 'e1@hook-1', runId: 'r1', destinationRef: 'hook-1', eventId: 'e1', type: 'bot:left', payload: '{}' }, t.clock.now());
      expect(await t.dispatcher.deliverDue()).toEqual({ delivered: 0, failed: 1 });
      expect(await t.dispatcher.deliverDue()).toEqual({ delivered: 0, failed: 0 });
      t.clock.advance(5_000);
      expect((await t.dispatcher.deliverDue()).failed).toBe(1);
    }
  });

  it('sends the content-free body for a purged delivery, and fails one whose destination is gone', async () => {
    const t = setup(200);
    await t.outbox.enqueue({ id: 'e2@hook-1', runId: 'r1', destinationRef: 'hook-1', eventId: 'e2', type: 'bot:chat_message', payload: '{"text":"hello","sender":"Sam"}' }, t.clock.now());
    await t.outbox.purgeContent('r1');
    await t.outbox.enqueue({ id: 'e3@hook-9', runId: 'r1', destinationRef: 'hook-9', eventId: 'e3', type: 'bot:left', payload: '{}' }, t.clock.now());
    expect(await t.dispatcher.deliverDue()).toEqual({ delivered: 1, failed: 1 });
    expect(JSON.parse(t.sent[0]!.body)).toEqual({ id: 'e2', type: 'bot:purged', runId: 'r1' });
    expect(t.sent.length).toBe(1);
  });

  it('sends the content-free body for a delivery the outbox purged while its destination resolved', async () => {
    const outbox = new InMemoryOutbox();
    await outbox.enqueue({ id: 'e1@hook-1', runId: 'r1', destinationRef: 'hook-1', eventId: 'e1', type: 'bot:transcript', payload: '{"text":"we start at nine"}' }, 0);
    const bodies: string[] = [];
    const dispatcher = new OutboxDispatcher({
      outbox,
      clock: new FakeClock(0),
      resolve: async () => {
        await outbox.purgeContent('r1');
        return { url: 'https://hooks.example.test/in', secret: 'not-a-real-secret' };
      },
      send: async (request) => {
        bodies.push(request.body);
        return { status: 204 };
      },
    });
    expect(await dispatcher.deliverDue()).toEqual({ delivered: 1, failed: 0 });
    expect(bodies).toEqual([JSON.stringify({ id: 'e1', type: 'bot:purged', runId: 'r1' })]);
  });

  it('aborts a send still waiting to write when the outbox purges its run, and sends the content-free body next', async () => {
    const outbox = new InMemoryOutbox();
    await outbox.enqueue({ id: 'e1@hook-1', runId: 'r1', destinationRef: 'hook-1', eventId: 'e1', type: 'bot:chat_message', payload: '{"text":"hello"}' }, 0);
    const bodies: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    let purgeFirst = true;
    const dispatcher = new OutboxDispatcher({
      outbox,
      clock: new FakeClock(0),
      resolve: async () => ({ url: 'https://hooks.example.test/in', secret: 'not-a-real-secret' }),
      send: async (request) => {
        signals.push(request.signal);
        if (purgeFirst) {
          purgeFirst = false;
          // the purge lands while the send resolves and connects, before its body is written
          await outbox.purgeContent('r1');
          request.signal?.throwIfAborted();
        }
        bodies.push(request.body);
        return { status: 204 };
      },
    });
    expect(await dispatcher.deliverDue()).toEqual({ delivered: 0, failed: 0 });
    expect(signals[0]?.aborted).toBe(true);
    expect(bodies).toEqual([]);
    expect((await outbox.listByRun('r1'))[0]).toMatchObject({ state: 'pending', type: 'bot:purged', payload: '', purged: true });
    expect(await dispatcher.deliverDue()).toEqual({ delivered: 1, failed: 0 });
    expect(bodies).toEqual([JSON.stringify({ id: 'e1', type: 'bot:purged', runId: 'r1' })]);
  });
});
