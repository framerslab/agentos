/**
 * Turns the functions a forged tool is granted into what an executor in
 * another realm can carry: host functions that take and return data only
 * (JSON values; bytes travel into the guest as Uint8Array and out of it as
 * latin1 strings), installed in the guest as `__host_<name>`, and the prelude
 * (guest-prelude.cjs) that builds the documented globals over them. A
 * prototype for the evidence run; the library ships none of it.
 */
import { readFileSync } from 'node:fs';

export type Binding = (...args: unknown[]) => unknown;

export interface GuestSurface {
  /** Host functions by name; the executor installs each as the guest global `__host_<name>`. */
  readonly bindings: Readonly<Record<string, Binding>>;
  /** Guest JavaScript evaluated before the forged code. */
  readonly prelude: string;
}

export const GUEST_PRELUDE = readFileSync(new URL('./guest-prelude.cjs', import.meta.url), 'utf8');

interface DigestLike {
  update(data: Buffer): unknown;
  digest(encoding?: string): Buffer | string;
}

interface CryptoLike {
  randomUUID(): string;
  createHash(algorithm: string): DigestLike;
  createHmac(algorithm: string, key: string | Buffer): DigestLike;
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

/** The bindings and prelude for one call, from the forge's `globals` for that call. */
export function guestSurface(globals: Readonly<Record<string, unknown>>): GuestSurface {
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
    usp_parse: (text) => [...new URLSearchParams(String(text))],
    usp_serialize: (pairs) => new URLSearchParams(pairs as string[][]).toString(),
    atob: (data) => atob(String(data)),
    btoa: (data) => btoa(String(data)),
  };

  const fetchFn = globals.fetch;
  if (typeof fetchFn === 'function') {
    bindings.fetch = async (input, init) => {
      const response = (await (fetchFn as (i: unknown, o?: unknown) => Promise<Response>)(
        input,
        init === null ? undefined : init,
      )) as Response;
      const body = new Uint8Array(await response.arrayBuffer());
      return {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        redirected: response.redirected,
        url: response.url,
        type: response.type,
        headers: [...response.headers],
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

  return { bindings, prelude: GUEST_PRELUDE };
}
