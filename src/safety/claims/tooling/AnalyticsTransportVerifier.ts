/**
 * @module safety/claims/tooling/AnalyticsTransportVerifier
 *
 * Checks analytics delivery against what a page registered and the policy it actually served: each transport's
 * origins in the matching directive with no wildcard, no request and no stored state before consent, after refusal
 * or after withdrawal, every request to a registered endpoint, payloads with allowed keys and bounded values that
 * match no forbidden pattern and carry no query string or fragment, and every observed page a registered route. It
 * reads observations; it sends nothing.
 *
 * The policy is read as a browser enforces it (Content Security Policy Level 3): a directive named twice keeps its
 * first value, a directive that is not ASCII is skipped, and each kind of origin is checked against the first
 * directive of its fallback list that the policy names (`script-src-elem`, `script-src`, `default-src` for scripts;
 * `img-src`, `default-src` for images; `connect-src`, `default-src` for connections; `worker-src`, `child-src`,
 * `script-src`, `default-src` for workers). A wildcard is reported in that directive and in `script-src`, `img-src`,
 * `connect-src` and `worker-src` wherever they appear. A same-origin request to a path no endpoint registers is the
 * page's own and is left alone; one to a registered endpoint's path is checked whatever its method.
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
  /**
   * The payload keys it may send, and the longest value it may send. A value that is not a string is checked as its
   * JSON text, so the keys inside an object value are bounded by its length and the forbidden patterns, not by
   * `allowedKeys`.
   */
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
  /**
   * Patterns no payload value may match. Each value is tested from its start whatever flags a pattern carries, and
   * the patterns given are not changed.
   */
  forbidden: readonly RegExp[];
}

/** A character outside ASCII, which makes a browser skip the directive that holds it. */
const NOT_ASCII = /\P{ASCII}/u;

/**
 * Parses a `Content-Security-Policy` header value as a browser parses one policy (Content Security Policy Level 3,
 * "Parse a serialized CSP"): a directive that holds a character outside ASCII is skipped, and a directive named
 * again is ignored, so the first one stands.
 *
 * @param header - One serialized policy. A value that joins several policies with commas is not split into them.
 * @returns Each directive's source list, by its name in lower case.
 */
export function parseCsp(header: string): CspDirectives {
  const out = new Map<string, string[]>();
  for (const part of header.split(';')) {
    if (NOT_ASCII.test(part)) continue;
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name === undefined || name === '') continue;
    const key = name.toLowerCase();
    if (!out.has(key)) out.set(key, sources);
  }
  return Object.fromEntries(out);
}

/**
 * Each kind of origin a transport registers, the directive named for that kind, and the directives a browser applies
 * to a request of that kind, most specific first (Content Security Policy Level 3, "Get the effective directive for
 * request" and "Get fetch directive fallback list").
 */
const DIRECTIVES = [
  ['script', 'script-src', ['script-src-elem', 'script-src', 'default-src']],
  ['img', 'img-src', ['img-src', 'default-src']],
  ['connect', 'connect-src', ['connect-src', 'default-src']],
  ['worker', 'worker-src', ['worker-src', 'child-src', 'script-src', 'default-src']],
] as const;
const PHASE_WORDS: Readonly<Record<Exclude<ConsentPhase, 'granted'>, string>> = { before_consent: 'before consent', denied: 'after refusal', withdrawn: 'after withdrawal' };
const isWildcard = (source: string): boolean => source === '*' || /^[a-z][a-z0-9+.-]*:$/i.test(source) || source.includes('*');
/** The start of an address: a scheme with `//`, or a `/`, which also begins a protocol-relative address. */
const ADDRESS = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/)/i;

/** The directive a browser applies from a fallback list: the first one the policy names, with its sources. */
function applied(csp: CspDirectives, fallbacks: readonly string[]): { name: string; sources: readonly string[] } | undefined {
  for (const name of fallbacks) {
    const sources = csp[name];
    if (sources !== undefined) return { name, sources };
  }
  return undefined;
}

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
  // A policy problem is said once, however many transports or kinds of origin reach the same directive.
  const policy = new Set<string>();
  for (const transport of input.transports) {
    for (const [field, directive, fallbacks] of DIRECTIVES) {
      const found = applied(input.csp, fallbacks);
      for (const origin of transport[field]) if (!(found?.sources ?? []).includes(origin)) policy.add(`${transport.integration}: ${found?.name ?? directive} lacks ${origin}`);
    }
  }
  const scanned = new Set<string>();
  for (const [, directive, fallbacks] of DIRECTIVES) {
    for (const name of [directive, applied(input.csp, fallbacks)?.name]) {
      if (name === undefined || scanned.has(name)) continue;
      scanned.add(name);
      for (const source of input.csp[name] ?? []) if (isWildcard(source) && source !== 'data:') policy.add(`${name} holds the wildcard ${source}`);
    }
  }
  problems.push(...policy);
  // Copies, so a global or sticky pattern's lastIndex carries nothing from one value to the next or back to the caller.
  const forbidden = input.forbidden.map((re) => new RegExp(re.source, re.flags));
  const isForbidden = (value: string): boolean =>
    forbidden.some((re) => {
      re.lastIndex = 0;
      return re.test(value);
    });
  const endpoints = input.transports.flatMap((t) => t.endpoints.map((e) => ({ transport: t, endpoint: e })));
  for (const request of input.requests) {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      problems.push(`${request.route}: a request to a malformed address`);
      continue;
    }
    if (url.origin === input.pageOrigin && !endpoints.some(({ endpoint }) => endpoint.origin === url.origin && endpoint.path === url.pathname)) continue;
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
    if (values.some(isForbidden)) problems.push(`${request.route}: a payload value matches a forbidden pattern`);
    if (values.some((v) => ADDRESS.test(v) && (v.includes('?') || v.includes('#')))) problems.push(`${request.route}: a payload value carries a query string or a fragment`);
  }
  for (const transport of input.transports) {
    for (const state of input.storage) {
      if (state.phase === 'granted') continue;
      for (const key of state.keys) if (transport.storageKeys.includes(key)) problems.push(`${transport.integration}: ${key} is stored ${PHASE_WORDS[state.phase]}`);
    }
  }
  return problems;
}
