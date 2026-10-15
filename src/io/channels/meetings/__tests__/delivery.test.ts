import { describe, it, expect } from 'vitest';
import { DestinationRefusedError, httpsSend, isPublicAddress, OutboxDispatcher, type DeliveryRequest, type MailOutcome } from '../delivery.js';
import { FakeClock, InMemoryOutbox } from '../stores/memory.js';
import { verifyEnvelope } from '../signing.js';
import { harness } from './manager-harness.js';

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

  it('marks a delivery failed when its destination lookup rejects, and goes on to the next in the pass', async () => {
    const outbox = new InMemoryOutbox();
    await outbox.enqueue({ id: 'e1@hook-down', runId: 'r1', destinationRef: 'hook-down', eventId: 'e1', type: 'bot:left', payload: '{}' }, 0);
    await outbox.enqueue({ id: 'e2@hook-1', runId: 'r1', destinationRef: 'hook-1', eventId: 'e2', type: 'bot:left', payload: '{}' }, 0);
    const sent: string[] = [];
    const warned: string[] = [];
    const dispatcher = new OutboxDispatcher({
      outbox,
      clock: new FakeClock(0),
      names,
      resolve: async (ref) => {
        if (ref === 'hook-down') throw new Error('the destinations store is out of reach');
        return { url: 'https://hooks.example.test/in', secret: 'not-a-real-secret' };
      },
      send: async (request) => {
        sent.push(request.headers['acme-hook-id'] ?? '');
        return { status: 204 };
      },
      logger: { warn: (msg) => warned.push(msg) },
    });
    expect(await dispatcher.deliverDue()).toEqual({ delivered: 1, failed: 1 });
    expect(sent).toEqual(['e2@hook-1']);
    expect(warned).toEqual(['[OutboxDispatcher] e1@hook-down: Error']);
    expect((await outbox.listByRun('r1')).find((d) => d.id === 'e1@hook-down')).toMatchObject({ state: 'pending', attempts: 1, nextAt: 5_000 });
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

  it("sends the manager's own bot:purged event with its time, sequence and reason, and a delivery its purge emptied with the ids alone", async () => {
    const h = harness({ destinationsFor: async () => ['hook-1'] });
    const sent = await h.manager.sendBot(h.request);
    if (!sent.ok) throw new Error('send failed');
    const runId = sent.run.runId;
    await h.manager.tick();
    await h.report(runId, 'joining');
    await h.report(runId, 'in_call', { participantCount: 2 });
    await h.report(runId, 'notice_posted');
    await h.report(runId, 'monitor_heartbeat', {}, h.clock.now() + 1);
    await h.report(runId, 'chat_message', { text: 'we start at nine', sender: 'participant-1' });
    await h.manager.purgeRun(runId, 'stopped_by_owner');
    await h.report(runId, 'left', { reason: 'stopped_by_owner', seconds: 20 });
    await h.manager.tick();
    expect((await h.stores.runs.get(runId))?.state).toBe('done');
    const events = await h.stores.events.read(runId, 0);
    const purged = events.find((e) => e.type === 'bot:purged');
    const chat = events.find((e) => e.type === 'bot:chat_message');
    if (!purged || !chat) throw new Error('an event is missing');
    const bodies = new Map<string, unknown>();
    const dispatcher = new OutboxDispatcher({
      outbox: h.stores.outbox,
      clock: h.clock,
      resolve: async () => ({ url: 'https://hooks.example.test/in', secret: 'not-a-real-secret' }),
      send: async (request) => {
        const body = JSON.parse(request.body) as { id: string };
        bodies.set(body.id, body);
        return { status: 204 };
      },
    });
    await dispatcher.deliverDue();
    // the run-level event goes out as every other event does, with what the manager stored, which holds no content
    expect(bodies.get(purged.eventId)).toEqual({ id: purged.eventId, type: 'bot:purged', runId, at: purged.at, seq: purged.seq, data: { reason: 'stopped_by_owner' } });
    // a content delivery the purge emptied sends its ids alone
    expect(bodies.get(chat.eventId)).toEqual({ id: chat.eventId, type: 'bot:purged', runId });
    expect(JSON.stringify([...bodies.values()])).not.toContain('we start at nine');
  });
});

describe('mail deliveries', () => {
  const mail = (id: string, ref: string, expiresAt = 10_000_000) => ({ id, runId: 'r1', destinationRef: ref, eventId: 'r1:notes', type: 'bot:done' as const, payload: 'sealed', kind: 'mail' as const, expiresAt });

  it('hands a mail delivery to the mail option and records each outcome', async () => {
    const outbox = new InMemoryOutbox();
    const clock = new FakeClock(1_000);
    const answers: Record<string, MailOutcome> = { 'mail:1': { outcome: 'sent' }, 'mail:2': { outcome: 'dead' }, 'mail:3': { outcome: 'hold', notBefore: 50_000 }, 'mail:4': { outcome: 'retry' } };
    const dispatcher = new OutboxDispatcher({ outbox, clock, resolve: async () => undefined, send: async () => ({ status: 500 }), mail: async (d) => answers[d.destinationRef]! });
    for (const ref of ['mail:1', 'mail:2', 'mail:3', 'mail:4']) await outbox.enqueue(mail(ref, ref), 1_000);
    expect(await dispatcher.deliverDue()).toEqual({ delivered: 1, failed: 2 });
    const byRef = Object.fromEntries((await outbox.listByRun('r1')).map((d) => [d.destinationRef, d]));
    expect(byRef['mail:1']?.state).toBe('delivered');
    expect(byRef['mail:2']?.state).toBe('dead');
    expect(byRef['mail:3']).toMatchObject({ state: 'pending', nextAt: 50_000, attempts: 0 });
    expect(byRef['mail:4']).toMatchObject({ state: 'pending', attempts: 1 });
  });

  it('a mail delivery with no mail option, or one whose option throws, is marked failed for the backoff, and the warning names the id alone', async () => {
    const outbox = new InMemoryOutbox();
    const warned: string[] = [];
    const none = new OutboxDispatcher({ outbox, resolve: async () => undefined, logger: { warn: (m) => warned.push(m) } });
    await outbox.enqueue(mail('m1', 'mail:1'), 1_000);
    await none.deliverDue();
    expect((await outbox.listByRun('r1'))[0]?.attempts).toBe(1);
    const throwing = new OutboxDispatcher({ outbox, resolve: async () => undefined, mail: async () => { throw new Error('the address is secret'); }, logger: { warn: (m) => warned.push(m) } });
    await outbox.replay('m1', 2_000);
    await outbox.enqueue(mail('m2', 'mail:2'), 2_000);
    await throwing.deliverDue();
    expect((await outbox.listByRun('r1')).find((d) => d.id === 'm2')?.attempts).toBe(1);
    expect(warned.length).toBeGreaterThanOrEqual(2);
    expect(warned.every((m) => !m.includes('secret'))).toBe(true);
  });

  it('a mail that expired since the pass began is ended without a send, and the outcome is recorded inside the claim', async () => {
    const outbox = new InMemoryOutbox();
    const clock = new FakeClock(1_000);
    const sent: string[] = [];
    const dispatcher = new OutboxDispatcher({
      outbox, clock, resolve: async () => undefined,
      mail: async (d) => {
        sent.push(d.destinationRef);
        clock.advance(10_000); // the first send takes long enough for the second mail to expire
        return { outcome: 'sent' };
      },
    });
    await outbox.enqueue(mail('m1', 'mail:1', 100_000), 1_000);
    await outbox.enqueue(mail('m2', 'mail:2', 5_000), 1_000);
    expect(await dispatcher.deliverDue()).toEqual({ delivered: 1, failed: 1 });
    expect(sent).toEqual(['mail:1']);
    const byRef = Object.fromEntries((await outbox.listByRun('r1')).map((d) => [d.destinationRef, d.state]));
    expect(byRef).toEqual({ 'mail:1': 'delivered', 'mail:2': 'dead' });
  });
});
