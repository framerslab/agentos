import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { isPublicAddress } from '../addresses.js';
import {
  checkDestination,
  checkedRequest,
  checkedStream,
  connectionOptions,
  EgressRefusedError,
  hostedEgressPolicy,
  localEgressPolicy,
  type EgressConnector,
} from '../CheckedEgress.js';

const PUBLIC_V4 = '142.250.0.1';
const PUBLIC_V6 = '2606:4700::1111';
const resolvesTo = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('isPublicAddress', () => {
  it('refuses every special-purpose block of both families, mapped and translated forms included', () => {
    for (const address of [
      '0.1.2.3', '10.1.2.3', '100.64.0.9', '127.0.0.1', '169.254.169.254', '172.16.5.5', '192.0.0.8', '192.0.2.1', '192.31.196.1',
      '192.52.193.1', '192.88.99.2', '192.168.1.1', '192.175.48.1', '198.18.0.1', '198.51.100.7', '203.0.113.7', '224.0.0.1', '240.0.0.1', '255.255.255.255',
      '::', '::1', '::7f00:1', '::ffff:10.1.2.3', '::ffff:142.250.0.1', '64:ff9b::a01:203', '64:ff9b:1::1', '100::1', '2001::1', '2001:db8::5',
      '2002:a01:203::1', '2620:4f:8000::1', '3fff::1', '5f00::1', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'fec0::1', 'ff02::1', 'not an address', 'fe80::1%eth0',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress(PUBLIC_V4)).toBe(true);
    expect(isPublicAddress(PUBLIC_V6)).toBe(true);
  });
});

describe('checkDestination', () => {
  const hosted = hostedEgressPolicy();
  it('in the hosted profile takes https on 443 to a name whose every address is public, pinned to the first', async () => {
    const checked = await checkDestination('https://hooks.example.test/in', hosted, resolvesTo(PUBLIC_V4, PUBLIC_V6));
    expect(checked).toMatchObject({ hostname: 'hooks.example.test', port: 443, address: PUBLIC_V4, family: 4 });
  });

  it('refuses http, another port, userinfo, an address literal, a name with any private address, and a name with none', async () => {
    const refusal = (url: string, lookup = resolvesTo(PUBLIC_V4)) => checkDestination(url, hosted, lookup).then(() => 'accepted', (e) => (e instanceof EgressRefusedError ? e.reason : String(e)));
    expect(await refusal('http://hooks.example.test/in')).toBe('scheme');
    expect(await refusal('https://hooks.example.test:8443/in')).toBe('port');
    expect(await refusal('https://user:pass@hooks.example.test/in')).toBe('userinfo');
    expect(await refusal(`https://${PUBLIC_V4}/in`)).toBe('address_literal');
    expect(await refusal('https://[2606:4700::1111]/in')).toBe('address_literal');
    expect(await refusal('https://hooks.example.test/in', resolvesTo(PUBLIC_V4, '10.0.0.7'))).toBe('private_address');
    expect(await refusal('https://hooks.example.test/in', resolvesTo('::ffff:127.0.0.1'))).toBe('private_address');
    expect(await refusal('https://hooks.example.test/in', resolvesTo())).toBe('unresolved');
    expect(await refusal('not a url')).toBe('scheme');
  });

  it('in the local profile takes the developer\'s own loopback endpoint over http on any port', async () => {
    const checked = await checkDestination('http://127.0.0.1:8080/v1', localEgressPolicy(), resolvesTo());
    expect(checked).toMatchObject({ address: '127.0.0.1', port: 8080, family: 4 });
  });
});

describe('connectionOptions', () => {
  it('pins the checked address and keeps TLS hostname validation on the name', () => {
    const options = connectionOptions({ url: new URL('https://hooks.example.test/in'), hostname: 'hooks.example.test', port: 443, address: PUBLIC_V4, family: 4 }, 'POST', {}, 1_000);
    expect(options.servername).toBe('hooks.example.test');
    expect(options.rejectUnauthorized).toBeUndefined();
    const answers: unknown[] = [];
    options.lookup!('anything.else', { all: true }, (...args: unknown[]) => answers.push(args));
    options.lookup!('anything.else', {}, (...args: unknown[]) => answers.push(args));
    expect(answers).toEqual([[null, [{ address: PUBLIC_V4, family: 4 }]], [null, PUBLIC_V4, 4]]);
  });
});

describe('checkedRequest', () => {
  const policy = hostedEgressPolicy({ timeoutMs: 200, maxResponseBytes: 16 });
  const answering = (status: number, body: string, headers: Record<string, string> = {}): EgressConnector => async () => ({ status, headers, body: (async function* () { yield Buffer.from(body); })() });

  it('connects to the checked address and reads a bounded answer', async () => {
    const seen: string[] = [];
    const connector: EgressConnector = async (req) => {
      seen.push(req.destination.address);
      return answering(200, '{"ok":true}')(req);
    };
    const answer = await checkedRequest({ url: 'https://hooks.example.test/in', method: 'POST', body: '{}', policy, lookup: resolvesTo(PUBLIC_V4), connector });
    expect(answer.status).toBe(200);
    expect(answer.body.toString()).toBe('{"ok":true}');
    expect(seen).toEqual([PUBLIC_V4]);
  });

  it('refuses a redirect without following it, an answer past the size bound, and an answer past the time bound', async () => {
    const reason = (connector: EgressConnector) =>
      checkedRequest({ url: 'https://hooks.example.test/in', method: 'POST', body: '{}', policy, lookup: resolvesTo(PUBLIC_V4), connector }).then(() => 'accepted', (e) => (e instanceof EgressRefusedError ? e.reason : String(e)));
    expect(await reason(answering(302, '', { location: 'http://169.254.169.254/' }))).toBe('redirect');
    expect(await reason(answering(200, 'x'.repeat(17)))).toBe('too_large');
    expect(await reason(() => new Promise(() => {}))).toBe('timeout');
    const report = await checkedRequest({ url: 'https://hooks.example.test/in', method: 'POST', body: '{}', policy, lookup: resolvesTo(PUBLIC_V4), connector: answering(307, ''), onRedirect: 'return' });
    expect(report.status).toBe(307);
  });

  it('checks the name again on every request, so a rebinding to a private address is refused', async () => {
    const answers = [[PUBLIC_V4], ['10.0.0.9']];
    const lookup = async () => (answers.shift() ?? []).map((address) => ({ address, family: 4 }));
    const first = await checkedRequest({ url: 'https://hooks.example.test/in', method: 'GET', policy, lookup, connector: answering(204, '') });
    expect(first.status).toBe(204);
    await expect(checkedRequest({ url: 'https://hooks.example.test/in', method: 'GET', policy, lookup, connector: answering(204, '') })).rejects.toMatchObject({ reason: 'private_address' });
  });

  it('bounds stalled DNS and body reads and cancels a refused redirect without reading it', async () => {
    let connected = 0;
    const stalled = () => new Promise<never>(() => {});
    const connector: EgressConnector = async () => { connected += 1; return answering(200, '')({} as never); };
    await expect(checkedRequest({ url: 'https://hooks.example.test', method: 'GET', policy, lookup: stalled, connector }))
      .rejects.toMatchObject({ reason: 'timeout' });
    expect(connected).toBe(0);
    const controller = new AbortController();
    const request = checkedRequest({ url: 'https://hooks.example.test', method: 'GET', policy, lookup: stalled, connector, signal: controller.signal });
    const rejection = expect(request).rejects.toThrow('cancelled lookup');
    controller.abort(new Error('cancelled lookup'));
    await rejection;
    expect(connected).toBe(0);
    let cancelled = 0;
    let reads = 0;
    const body: AsyncIterable<Buffer> = { [Symbol.asyncIterator]: () => ({ next: () => { reads += 1; return stalled(); } }) };
    await expect(checkedRequest({ url: 'https://hooks.example.test', method: 'GET', policy, lookup: resolvesTo(PUBLIC_V4),
      connector: async () => ({ status: 302, headers: {}, body, cancel: () => { cancelled += 1; } }) }))
      .rejects.toMatchObject({ reason: 'redirect' });
    expect({ cancelled, reads }).toEqual({ cancelled: 1, reads: 0 });
    await expect(checkedRequest({ url: 'https://hooks.example.test', method: 'GET', policy, lookup: resolvesTo(PUBLIC_V4),
      connector: async () => ({ status: 200, headers: {}, body }) })).rejects.toMatchObject({ reason: 'timeout' });
    await expect(checkedRequest({ url: 'https://hooks.example.test', method: 'GET', policy, lookup: resolvesTo(PUBLIC_V4),
      connector: answering(302, 'x'.repeat(17)) })).rejects.toMatchObject({ reason: 'too_large' });
  });
});

describe('the default connector, over the local profile', () => {
  async function server(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; close: () => Promise<void> }> {
    const s: Server = createServer(handler);
    s.listen(0, '127.0.0.1');
    await once(s, 'listening');
    const address = s.address() as { port: number };
    return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve) => s.close(() => resolve())) };
  }

  it('reads an answer and refuses a redirect it does not follow', async () => {
    let followed = 0;
    const s = await server((req, res) => {
      if (req.url === '/moved') {
        res.writeHead(302, { location: '/target' });
        res.end();
      } else if (req.url === '/target') {
        followed += 1;
        res.end('target');
      } else {
        res.end('hello');
      }
    });
    try {
      const policy = localEgressPolicy({ timeoutMs: 2_000 });
      expect((await checkedRequest({ url: `${s.url}/`, method: 'GET', policy })).body.toString()).toBe('hello');
      await expect(checkedRequest({ url: `${s.url}/moved`, method: 'GET', policy })).rejects.toMatchObject({ reason: 'redirect' });
      expect(followed).toBe(0);
    } finally {
      await s.close();
    }
  });

  it('streams an answer and stops it at the size bound', async () => {
    const s = await server((_req, res) => {
      res.write('data: one\n\n');
      res.write('data: two\n\n');
      res.end('x'.repeat(100));
    });
    try {
      const stream = await checkedStream({ url: `${s.url}/events`, method: 'GET', policy: localEgressPolicy({ timeoutMs: 2_000, maxResponseBytes: 30 }) });
      expect(stream.status).toBe(200);
      const chunks: string[] = [];
      await expect((async () => { for await (const chunk of stream.body) chunks.push(chunk.toString()); })()).rejects.toMatchObject({ reason: 'too_large' });
      expect(chunks.join('')).toContain('data: one');
    } finally {
      await s.close();
    }
  });
});
