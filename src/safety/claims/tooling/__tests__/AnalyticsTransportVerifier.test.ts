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
});
