/**
 * @fileoverview What crosses into a {@link QuickJSExecutor} guest: host
 * functions that take data and return data (JSON values; bytes travel into
 * the guest as `Uint8Array` and out of it as latin1 strings). The executor
 * installs each as the guest global `__host_<name>`, and the guest prelude
 * (guest-prelude.ts) builds the documented globals over them. Host values
 * never cross.
 *
 * The bindings are built for one call and dropped with it. What they hold on
 * the host is bounded per call: the response bodies of the call's fetches
 * together by the call's memory budget, open hashes by
 * {@link MAX_OPEN_DIGESTS}, built `Intl` services by {@link MAX_INTL_SERVICES}.
 *
 * @module @framers/agentos/emergent/executor/guest-surface
 */

/** A host function the guest calls with data and gets data, or a promise of data, back from. */
export type Binding = (...args: unknown[]) => unknown;

/** The per-call bounds on what the bindings hold on the host. */
export interface GuestSurfaceLimits {
  /** The bytes the response bodies of the call's fetches may hold, together. */
  readonly bodyBytes: number;
  /**
   * Aborted when the call ends, where no broker ends the call's requests (the
   * path without a ceiling): a request still running then is aborted.
   */
  readonly signal?: AbortSignal;
}

/** Hashes and HMACs a call may hold open (created and not yet digested) at once. */
export const MAX_OPEN_DIGESTS = 64;

/** `Intl` services the host keeps built for one call; the oldest is dropped past it. */
export const MAX_INTL_SERVICES = 64;

const MIB = 1_048_576;

interface DigestLike {
  update(data: Buffer): unknown;
  digest(encoding?: string): Buffer | string;
}

interface CryptoLike {
  randomUUID(): string;
  createHash(algorithm: string): DigestLike;
  createHmac(algorithm: string, key: string | Buffer): DigestLike;
}

type IntlServiceName =
  | 'DateTimeFormat'
  | 'NumberFormat'
  | 'Collator'
  | 'PluralRules'
  | 'RelativeTimeFormat'
  | 'ListFormat'
  | 'DisplayNames';

/** The methods the guest may call on each service; the prelude defines the same list. */
const INTL_METHODS: Readonly<Record<IntlServiceName, readonly string[]>> = {
  DateTimeFormat: ['resolvedOptions', 'format', 'formatToParts', 'formatRange', 'formatRangeToParts'],
  NumberFormat: ['resolvedOptions', 'format', 'formatToParts', 'formatRange', 'formatRangeToParts'],
  Collator: ['resolvedOptions', 'compare'],
  PluralRules: ['resolvedOptions', 'select', 'selectRange'],
  RelativeTimeFormat: ['resolvedOptions', 'format', 'formatToParts'],
  ListFormat: ['resolvedOptions', 'format', 'formatToParts'],
  DisplayNames: ['resolvedOptions', 'of'],
};

const DATE_LOCALE_METHODS = ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'] as const;

type IntlService = Record<string, (...args: unknown[]) => unknown>;
type IntlConstructor = {
  new (locales?: unknown, options?: unknown): IntlService;
  supportedLocalesOf(locales?: unknown, options?: unknown): string[];
};

function orUndefined(value: unknown): unknown {
  return value === null ? undefined : value;
}

function intlServiceName(name: unknown): IntlServiceName {
  const kind = String(name);
  if (!Object.prototype.hasOwnProperty.call(INTL_METHODS, kind)) {
    throw new TypeError(`Intl.${kind} is not available`);
  }
  return kind as IntlServiceName;
}

function urlParts(url: URL): Record<string, string> {
  return {
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    username: url.username,
    password: url.password,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
  };
}

/**
 * Reads a response body chunk by chunk against the bytes the call has left;
 * a chunk past them cancels the body and fails the fetch.
 */
async function readBody(response: Response, budget: { left: number; readonly limit: number }): Promise<Uint8Array> {
  const stream = response.body;
  if (!stream) {
    return new Uint8Array(0);
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value.byteLength > budget.left) {
        throw new RangeError(
          `fetch: the response bodies of this call passed its limit of ${Math.round(budget.limit / MIB)} MB`,
        );
      }
      budget.left -= value.byteLength;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** The host functions for one call, from the forge's `globals` for that call. */
export function guestBindings(
  globals: Readonly<Record<string, unknown>>,
  limits: GuestSurfaceLimits,
): Record<string, Binding> {
  const services = new Map<string, IntlService>();
  const intlService = (kind: IntlServiceName, locales: unknown, options: unknown): IntlService => {
    const key = JSON.stringify([kind, locales, options]);
    let service = services.get(key);
    if (!service) {
      const Constructor = (Intl as unknown as Record<IntlServiceName, IntlConstructor>)[kind];
      service = new Constructor(orUndefined(locales), orUndefined(options));
      if (services.size >= MAX_INTL_SERVICES) {
        const oldest = services.keys().next();
        if (!oldest.done) {
          services.delete(oldest.value);
        }
      }
      services.set(key, service);
    }
    return service;
  };

  const bindings: Record<string, Binding> = {
    utf8_encode: (text) => new TextEncoder().encode(String(text)),
    text_decoder_encoding: (label) => new TextDecoder(String(label)).encoding,
    text_decode: (label, fatal, ignoreBOM, latin1) =>
      new TextDecoder(String(label), { fatal: Boolean(fatal), ignoreBOM: Boolean(ignoreBOM) }).decode(
        Buffer.from(String(latin1), 'latin1'),
      ),
    bytes_to_string: (latin1, encoding) =>
      Buffer.from(String(latin1), 'latin1').toString(String(encoding) as BufferEncoding),
    url_parse: (input, base) =>
      urlParts(new URL(String(input), base === null || base === undefined ? undefined : String(base))),
    url_set: (href, part, value) => {
      const url = new URL(String(href));
      (url as unknown as Record<string, string>)[String(part)] = String(value);
      return urlParts(url);
    },
    usp_parse: (text) => {
      const pairs: string[][] = [];
      new URLSearchParams(String(text)).forEach((value, key) => pairs.push([key, value]));
      return pairs;
    },
    usp_serialize: (pairs) => new URLSearchParams(pairs as string[][]).toString(),
    atob: (data) => atob(String(data)),
    btoa: (data) => btoa(String(data)),
    intl_call: (name, locales, options, method, a, b) => {
      const kind = intlServiceName(name);
      const methodName = String(method);
      if (!INTL_METHODS[kind].includes(methodName)) {
        throw new TypeError(`Intl.${kind}.prototype.${methodName} is not available`);
      }
      const service = intlService(kind, locales, options);
      return service[methodName].call(service, a, b);
    },
    intl_supported: (name, locales, options) =>
      (Intl as unknown as Record<IntlServiceName, IntlConstructor>)[intlServiceName(name)].supportedLocalesOf(
        orUndefined(locales),
        orUndefined(options),
      ),
    intl_date: (method, time, locales, options) => {
      const methodName = String(method);
      if (!(DATE_LOCALE_METHODS as readonly string[]).includes(methodName)) {
        throw new TypeError(`Date.prototype.${methodName} is not available`);
      }
      const date = new Date(Number(time)) as unknown as Record<string, (l?: unknown, o?: unknown) => string>;
      return date[methodName](orUndefined(locales), orUndefined(options));
    },
    intl_compare: (a, b, locales, options) =>
      String(a).localeCompare(
        String(b),
        orUndefined(locales) as string | string[] | undefined,
        orUndefined(options) as Intl.CollatorOptions | undefined,
      ),
  };

  const fetchFn = globals.fetch;
  if (typeof fetchFn === 'function') {
    const budget = { left: limits.bodyBytes, limit: limits.bodyBytes };
    bindings.fetch = async (input, init) => {
      let options = init === null || init === undefined ? undefined : (init as Record<string, unknown>);
      // A byte body crosses out of the guest as latin1; fetch is handed the bytes.
      if (options && typeof options.bodyBytes === 'string') {
        const { bodyBytes, ...rest } = options;
        options = { ...rest, body: Buffer.from(bodyBytes as string, 'latin1') };
      }
      const response = (await (fetchFn as (i: unknown, o?: unknown) => Promise<Response>)(
        input,
        limits.signal ? { ...options, signal: limits.signal } : options,
      )) as Response;
      const body = await readBody(response, budget);
      const headers: string[][] = [];
      response.headers.forEach((value, key) => headers.push([key, value]));
      return {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        redirected: response.redirected,
        url: response.url,
        type: response.type,
        headers,
        body,
      };
    };
  }

  const fs = globals.fs as { readFile?: (filePath: unknown) => Promise<string> } | undefined;
  if (fs && typeof fs.readFile === 'function') {
    const readFile = fs.readFile.bind(fs);
    bindings.fs_readFile = (filePath) => readFile(filePath);
  }

  const crypto = globals.crypto as CryptoLike | undefined;
  if (crypto && typeof crypto.randomUUID === 'function') {
    const digests = new Map<number, DigestLike>();
    let next = 1;
    bindings.crypto_randomUUID = () => crypto.randomUUID();
    bindings.crypto_start = (kind, algorithm, key) => {
      if (digests.size >= MAX_OPEN_DIGESTS) {
        throw new RangeError(
          `crypto: ${MAX_OPEN_DIGESTS} hashes are open in this call; call digest() on one before starting another`,
        );
      }
      const k = key as { s?: string; b?: string } | null;
      const digest =
        kind === 'hash'
          ? crypto.createHash(String(algorithm))
          : crypto.createHmac(String(algorithm), k?.s !== undefined ? k.s : Buffer.from(k?.b ?? '', 'latin1'));
      const id = next;
      next += 1;
      digests.set(id, digest);
      return id;
    };
    bindings.crypto_update = (id, chunk) => {
      const digest = digests.get(Number(id));
      if (!digest) {
        throw new Error('Digest already called');
      }
      const c = chunk as { s?: string; enc?: string; b?: string };
      digest.update(
        c.s !== undefined ? Buffer.from(c.s, (c.enc ?? 'utf8') as BufferEncoding) : Buffer.from(c.b ?? '', 'latin1'),
      );
      return null;
    };
    bindings.crypto_digest = (id, encoding) => {
      const digest = digests.get(Number(id));
      if (!digest) {
        throw new Error('Digest already called');
      }
      digests.delete(Number(id));
      const out = encoding === null || encoding === undefined ? digest.digest() : digest.digest(String(encoding));
      return typeof out === 'string' ? out : new Uint8Array(out);
    };
  }

  return bindings;
}
