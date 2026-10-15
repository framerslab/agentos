/**
 * @module safety/claims/tooling/AnalyticsTransportVerifier
 *
 * Checks analytics delivery against what a page registered and the policy it actually served: each transport's
 * origins in the matching directive with no wildcard, no request and no stored state before consent, after refusal
 * or after withdrawal, every request to a registered endpoint (the page's own origin aside), payloads with allowed
 * keys and bounded values that match no forbidden pattern and carry no query string or fragment, and every observed
 * page a registered route. It reads observations; it sends nothing.
 */

/** A consent phase. */
export type ConsentPhase = 'before_consent' | 'denied' | 'granted' | 'withdrawn';

/** An endpoint a transport may call. */
export interface AnalyticsEndpoint {
  /** The HTTP method the endpoint takes. */
  method: 'GET' | 'POST';
  /** The endpoint's origin, as `URL.origin` writes it. */
  origin: string;
  /** The endpoint's path, as `URL.pathname` writes it. */
  path: string;
}

/** One integration's registration. */
export interface AnalyticsTransport {
  /** The integration's name, which every problem about it starts with. */
  integration: string;
  /** The origins its scripts load from. */
  script: readonly string[];
  /** The origins its images load from. */
  img: readonly string[];
  /** The origins it connects to. */
  connect: readonly string[];
  /** The origins its workers load from. */
  worker: readonly string[];
  /** The endpoints it may call. */
  endpoints: readonly AnalyticsEndpoint[];
  /** The browser-storage keys the integration owns. */
  storageKeys: readonly string[];
  /** The payload keys it may send, and the longest value it may send. */
  payload: { allowedKeys: readonly string[]; maxValueLength: number };
}

/** One observed request. */
export interface ObservedRequest {
  /** The consent phase the request was sent in. */
  phase: ConsentPhase;
  /** The request's HTTP method. */
  method: string;
  /** The request's absolute URL. */
  url: string;
  /** The request's body as text, or `null` when it had none. */
  body: string | null;
  /** The registered route id of the page that sent it, as the test knows it. */
  route: string;
}

/** The storage keys present in a phase. */
export interface ObservedStorage {
  /** The consent phase the keys were read in. */
  phase: ConsentPhase;
  /** The browser-storage keys present. */
  keys: readonly string[];
}

/** A parsed policy: directive name to its source list. */
export type CspDirectives = Readonly<Record<string, readonly string[]>>;

/** What the check reads. */
export interface TransportCheckInput {
  /** Every integration's registration. */
  transports: readonly AnalyticsTransport[];
  /** The policy the page was served with, as `parseCsp` reads it. */
  csp: CspDirectives;
  /** The page's own origin. */
  pageOrigin: string;
  /** The registered public route ids. */
  routeIds: ReadonlySet<string>;
  /** The requests observed. */
  requests: readonly ObservedRequest[];
  /** The storage keys observed, by phase. */
  storage: readonly ObservedStorage[];
  /** Patterns no payload value may match. */
  forbidden: readonly RegExp[];
}

/**
 * Parses a `Content-Security-Policy` header value.
 *
 * @param header - The header's value.
 * @returns Each directive's source list, by its name in lower case.
 */
export function parseCsp(header: string): CspDirectives {
  const out: Record<string, string[]> = {};
  for (const part of header.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name !== undefined && name !== '') out[name.toLowerCase()] = sources;
  }
  return out;
}

const DIRECTIVES = [['script', 'script-src'], ['img', 'img-src'], ['connect', 'connect-src'], ['worker', 'worker-src']] as const;
const PHASE_WORDS: Readonly<Record<Exclude<ConsentPhase, 'granted'>, string>> = { before_consent: 'before consent', denied: 'after refusal', withdrawn: 'after withdrawal' };
const isWildcard = (source: string): boolean => source === '*' || /^[a-z][a-z0-9+.-]*:$/i.test(source) || source.includes('*');

function payloadEntries(body: string | null): [string, string][] | null {
  if (body === null || body === '') return [];
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]);
    return null;
  } catch {
    return [...new URLSearchParams(body).entries()];
  }
}

/**
 * Every way the observations break the registrations and the policy.
 *
 * @param input - The registrations, the policy, the page origin, the routes, and what was observed.
 * @returns One sentence per problem; an empty list when there is none.
 */
export function verifyAnalyticsTransports(input: TransportCheckInput): string[] {
  const problems: string[] = [];
  for (const transport of input.transports) {
    for (const [field, directive] of DIRECTIVES) {
      const sources = input.csp[directive] ?? (directive === 'worker-src' ? input.csp['script-src'] : undefined) ?? input.csp['default-src'] ?? [];
      for (const origin of transport[field]) if (!sources.includes(origin)) problems.push(`${transport.integration}: ${directive} lacks ${origin}`);
    }
  }
  for (const [, directive] of DIRECTIVES) {
    for (const source of input.csp[directive] ?? []) if (isWildcard(source) && source !== 'data:') problems.push(`${directive} holds the wildcard ${source}`);
  }
  const endpoints = input.transports.flatMap((t) => t.endpoints.map((e) => ({ transport: t, endpoint: e })));
  for (const request of input.requests) {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      problems.push(`${request.route}: a request to a malformed address`);
      continue;
    }
    if (url.origin === input.pageOrigin && !endpoints.some(({ endpoint }) => endpoint.origin === url.origin && endpoint.path === url.pathname && endpoint.method === request.method.toUpperCase())) continue;
    const match = endpoints.find(({ endpoint }) => endpoint.origin === url.origin && endpoint.path === url.pathname && endpoint.method === request.method.toUpperCase());
    if (match === undefined) {
      problems.push(`${request.route}: a request to an unregistered destination ${url.origin}${url.pathname}`);
      continue;
    }
    if (request.phase !== 'granted') {
      problems.push(`${request.route}: a request to ${url.origin}${url.pathname} ${PHASE_WORDS[request.phase]}`);
      continue;
    }
    if (!input.routeIds.has(request.route)) problems.push(`${request.route}: the page is not a registered public route`);
    const entries = payloadEntries(request.body) === null ? null : [...(payloadEntries(request.body) ?? []), ...new URLSearchParams(url.search).entries()];
    if (entries === null) {
      problems.push(`${request.route}: a payload that is neither an object nor a form`);
      continue;
    }
    const allowed = new Set(match.transport.payload.allowedKeys);
    for (const [key] of entries) if (!allowed.has(key)) problems.push(`${request.route}: the payload key ${key} is not allowed`);
    const values = entries.map(([, v]) => v);
    if (values.some((v) => v.length > match.transport.payload.maxValueLength)) problems.push(`${request.route}: a payload value is longer than ${match.transport.payload.maxValueLength}`);
    if (values.some((v) => input.forbidden.some((re) => re.test(v)))) problems.push(`${request.route}: a payload value matches a forbidden pattern`);
    if (values.some((v) => /^https?:\/\//.test(v) && (v.includes('?') || v.includes('#')))) problems.push(`${request.route}: a payload value carries a query string or a fragment`);
  }
  for (const transport of input.transports) {
    for (const state of input.storage) {
      if (state.phase === 'granted') continue;
      for (const key of state.keys) if (transport.storageKeys.includes(key)) problems.push(`${transport.integration}: ${key} is stored ${PHASE_WORDS[state.phase]}`);
    }
  }
  return problems;
}
