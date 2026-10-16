import { describe, expect, it } from 'vitest';
import { parseCsp, verifyAnalyticsTransports, type AnalyticsTransport, type TransportCheckInput } from '../AnalyticsTransportVerifier.js';

const transport: AnalyticsTransport = {
  integration: 'example-analytics',
  script: ['https://cdn.example.test'],
  img: [],
  connect: ['https://collect.example.test'],
  worker: [],
  endpoints: [{ method: 'POST', origin: 'https://collect.example.test', path: '/event' }],
  storageKeys: ['_ex_id'],
  payload: { allowedKeys: ['name', 'route'], maxValueLength: 64 },
};
const input = (overrides: Partial<TransportCheckInput> = {}): TransportCheckInput => ({
  transports: [transport],
  csp: parseCsp("default-src 'self'; script-src 'self' 'nonce-x' https://cdn.example.test; connect-src 'self' https://collect.example.test; img-src 'self' data:"),
  pageOrigin: 'https://site.example.test',
  routeIds: new Set(['home', 'pricing']),
  requests: [{ phase: 'granted', method: 'POST', url: 'https://collect.example.test/event', body: JSON.stringify({ name: 'pageview', route: 'home' }), route: 'home' }],
  storage: [{ phase: 'before_consent', keys: [] }, { phase: 'granted', keys: ['_ex_id'] }, { phase: 'withdrawn', keys: [] }],
  forbidden: [/@/, /\d{6,}/],
  ...overrides,
});

describe('analytics transports', () => {
  it('passes a registered transport that sends after consent only, with an allowed payload', () => {
    expect(verifyAnalyticsTransports(input())).toEqual([]);
  });

  it('fails a missing origin, a wildcard, a request before consent, an unregistered destination and storage after withdrawal', () => {
    expect(verifyAnalyticsTransports(input({ csp: parseCsp("script-src 'self' https://cdn.example.test; connect-src *") }))).toEqual([
      'example-analytics: connect-src lacks https://collect.example.test',
      'connect-src holds the wildcard *',
    ]);
    expect(verifyAnalyticsTransports(input({ requests: [{ phase: 'before_consent', method: 'POST', url: 'https://collect.example.test/event', body: '{}', route: 'home' }] }))).toEqual(['home: a request to https://collect.example.test/event before consent']);
    expect(verifyAnalyticsTransports(input({ requests: [{ phase: 'granted', method: 'GET', url: 'https://other.example.test/pixel.gif', body: null, route: 'home' }] }))).toEqual(['home: a request to an unregistered destination https://other.example.test/pixel.gif']);
    expect(verifyAnalyticsTransports(input({ storage: [{ phase: 'withdrawn', keys: ['_ex_id'] }] }))).toEqual(['example-analytics: _ex_id is stored after withdrawal']);
  });

  it('fails a payload key outside the list, a value with an address, a URL with a query and an unregistered route', () => {
    const body = JSON.stringify({ name: 'pageview', route: 'home', email: 'person@example.test', page: 'https://site.example.test/?q=1' });
    expect(verifyAnalyticsTransports(input({ requests: [{ phase: 'granted', method: 'POST', url: 'https://collect.example.test/event', body, route: 'account' }] }))).toEqual([
      'account: the page is not a registered public route',
      'account: the payload key email is not allowed',
      'account: the payload key page is not allowed',
      'account: a payload value matches a forbidden pattern',
      'account: a payload value carries a query string or a fragment',
    ]);
  });

  it('reads the policy as a browser does: a repeated directive keeps its first value, a directive that is not ASCII is skipped', () => {
    expect(parseCsp('connect-src *; connect-src https://collect.example.test')).toEqual({ 'connect-src': ['*'] });
    expect(parseCsp("default-src *; img-src 'self' https://pi\u00f1a.example.test")).toEqual({ 'default-src': ['*'] });
    expect(verifyAnalyticsTransports(input({ csp: parseCsp('script-src https://cdn.example.test; connect-src *; connect-src https://collect.example.test') }))).toEqual([
      'example-analytics: connect-src lacks https://collect.example.test',
      'connect-src holds the wildcard *',
    ]);
  });

  it('checks each kind of origin against the directive a browser applies to it, and still reports a wildcard in a directive a more specific one shadows', () => {
    expect(verifyAnalyticsTransports(input({ csp: parseCsp('default-src *; script-src https://cdn.example.test; connect-src https://collect.example.test') }))).toEqual([
      'default-src holds the wildcard *',
    ]);
    expect(verifyAnalyticsTransports(input({ csp: parseCsp('script-src https://cdn.example.test; connect-src https://collect.example.test; child-src *') }))).toEqual([
      'child-src holds the wildcard *',
    ]);
    expect(verifyAnalyticsTransports(input({ csp: parseCsp("script-src https://cdn.example.test; script-src-elem 'self'; connect-src https://collect.example.test") }))).toEqual([
      'example-analytics: script-src-elem lacks https://cdn.example.test',
    ]);
    expect(verifyAnalyticsTransports(input({ csp: parseCsp("script-src *; script-src-elem 'self' https://cdn.example.test; connect-src https://collect.example.test") }))).toEqual([
      'script-src holds the wildcard *',
    ]);
  });

  it('checks a request to a same-origin endpoint whatever its method, and leaves the page its own requests', () => {
    const relay: AnalyticsTransport = { ...transport, integration: 'example-relay', script: [], connect: [], endpoints: [{ method: 'POST', origin: 'https://site.example.test', path: '/api/event' }] };
    expect(verifyAnalyticsTransports(input({ transports: [relay], requests: [{ phase: 'before_consent', method: 'GET', url: 'https://site.example.test/api/event?name=pageview', body: null, route: 'home' }] }))).toEqual([
      'home: a request to an unregistered destination https://site.example.test/api/event',
    ]);
    expect(verifyAnalyticsTransports(input({ transports: [relay], requests: [{ phase: 'before_consent', method: 'GET', url: 'https://site.example.test/pricing', body: null, route: 'pricing' }] }))).toEqual([]);
  });

  it('tests every value against a forbidden pattern from its start, whatever flags the pattern carries', () => {
    const pattern = /@/g;
    const body = JSON.stringify({ name: 'person@example.test', route: 'home' });
    const sent = (route: string) => ({ phase: 'granted' as const, method: 'POST', url: 'https://collect.example.test/event', body, route });
    expect(verifyAnalyticsTransports(input({ forbidden: [pattern], requests: [sent('home'), sent('pricing')] }))).toEqual([
      'home: a payload value matches a forbidden pattern',
      'pricing: a payload value matches a forbidden pattern',
    ]);
    expect(pattern.lastIndex).toBe(0);
  });

  it('finds a query string or a fragment in a path and in a protocol-relative address', () => {
    const sent = (route: string, name: string) => ({ phase: 'granted' as const, method: 'POST', url: 'https://collect.example.test/event', body: JSON.stringify({ name, route }), route });
    expect(verifyAnalyticsTransports(input({ requests: [sent('home', '/pricing?ref=mail'), sent('pricing', '//site.example.test/#top')] }))).toEqual([
      'home: a payload value carries a query string or a fragment',
      'pricing: a payload value carries a query string or a fragment',
    ]);
  });

  it('reports a page that is not a registered route whatever else is wrong with its request, and leaves the page its own requests', () => {
    expect(verifyAnalyticsTransports(input({ requests: [{ phase: 'before_consent', method: 'POST', url: 'https://collect.example.test/event', body: '{}', route: 'account' }] }))).toEqual([
      'account: the page is not a registered public route',
      'account: a request to https://collect.example.test/event before consent',
    ]);
    expect(verifyAnalyticsTransports(input({ requests: [{ phase: 'granted', method: 'GET', url: 'https://other.example.test/pixel.gif', body: null, route: 'account' }] }))).toEqual([
      'account: the page is not a registered public route',
      'account: a request to an unregistered destination https://other.example.test/pixel.gif',
    ]);
    expect(verifyAnalyticsTransports(input({ requests: [{ phase: 'granted', method: 'GET', url: 'not an address', body: null, route: 'account' }] }))).toEqual([
      'account: the page is not a registered public route',
      'account: a request to a malformed address',
    ]);
    expect(verifyAnalyticsTransports(input({ requests: [{ phase: 'before_consent', method: 'GET', url: 'https://site.example.test/account/settings', body: null, route: 'account' }] }))).toEqual([]);
  });
});
