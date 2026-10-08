/**
 * @fileoverview The guest prelude of {@link QuickJSExecutor}: JavaScript the
 * executor evaluates inside each call's QuickJS context before the forged
 * code. Node never runs it.
 *
 * It takes the host functions the executor installed as globals named
 * `__host_<name>` (see guest-surface.ts), removes those globals, and builds
 * what forged code is documented to have: the built-ins the in-process
 * context hands it that QuickJS lacks (`TextEncoder`, `TextDecoder`, `URL`,
 * `URLSearchParams`, `structuredClone`, `atob`, `btoa`, `Intl` and the
 * locale methods, a console that discards) and the granted capabilities
 * (`fetch`, `fs.readFile`, `crypto`). Names the in-process context sets to
 * undefined are undefined here too, and string code generation is refused
 * as the in-process context refuses it.
 *
 * The source is a string so that it ships inside the compiled package; it
 * holds no template interpolation and no backslash.
 *
 * @module @framers/agentos/emergent/executor/guest-prelude
 */

export const GUEST_PRELUDE = String.raw`(() => {
  'use strict';
  const g = globalThis;
  const host = {};
  for (const name of Object.getOwnPropertyNames(g)) {
    if (name.startsWith('__host_')) {
      host[name.slice('__host_'.length)] = g[name];
      delete g[name];
    }
  }

  const toBytes = (data) => {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError('Expected a string, an ArrayBuffer or a typed array');
  };
  const bytesToLatin1 = (bytes) => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return out;
  };
  // What Node's digest() returns without an encoding is a Buffer; forged code
  // calls toString('hex') on it. Bytes is the nearest the guest can hold.
  class Bytes extends Uint8Array {
    toString(encoding) {
      return host.bytes_to_string(bytesToLatin1(this), encoding === undefined ? 'utf8' : String(encoding));
    }
  }

  class TextEncoder {
    get encoding() {
      return 'utf-8';
    }
    encode(input = '') {
      return new Uint8Array(host.utf8_encode(String(input)));
    }
  }

  class TextDecoder {
    constructor(label = 'utf-8', options = {}) {
      this._label = String(label);
      this._fatal = Boolean(options && options.fatal);
      this._ignoreBOM = Boolean(options && options.ignoreBOM);
      this._encoding = host.text_decoder_encoding(this._label);
    }
    get encoding() {
      return this._encoding;
    }
    get fatal() {
      return this._fatal;
    }
    get ignoreBOM() {
      return this._ignoreBOM;
    }
    decode(input) {
      if (input === undefined) return '';
      return host.text_decode(this._label, this._fatal, this._ignoreBOM, bytesToLatin1(toBytes(input)));
    }
  }

  class URLSearchParams {
    constructor(init) {
      this._pairs = [];
      this._url = null;
      if (init === undefined || init === null) return;
      if (init instanceof URLSearchParams) {
        this._pairs = init._pairs.map(([k, v]) => [k, v]);
      } else if (typeof init === 'object' && typeof init[Symbol.iterator] === 'function') {
        for (const pair of init) {
          const items = Array.from(pair);
          if (items.length !== 2) throw new TypeError('Each query pair must be an iterable [name, value] tuple');
          this._pairs.push([String(items[0]), String(items[1])]);
        }
      } else if (typeof init === 'object') {
        for (const key of Object.keys(init)) this._pairs.push([key, String(init[key])]);
      } else {
        this._pairs = host.usp_parse(String(init));
      }
    }
    _changed() {
      if (this._url) this._url._setSearch(this.toString());
    }
    get size() {
      return this._pairs.length;
    }
    append(name, value) {
      this._pairs.push([String(name), String(value)]);
      this._changed();
    }
    delete(name, value) {
      const n = String(name);
      this._pairs = this._pairs.filter(([k, v]) => !(k === n && (value === undefined || v === String(value))));
      this._changed();
    }
    get(name) {
      const n = String(name);
      const pair = this._pairs.find(([k]) => k === n);
      return pair ? pair[1] : null;
    }
    getAll(name) {
      const n = String(name);
      return this._pairs.filter(([k]) => k === n).map(([, v]) => v);
    }
    has(name, value) {
      const n = String(name);
      return this._pairs.some(([k, v]) => k === n && (value === undefined || v === String(value)));
    }
    set(name, value) {
      const n = String(name);
      const v = String(value);
      const first = this._pairs.findIndex(([k]) => k === n);
      if (first < 0) {
        this._pairs.push([n, v]);
      } else {
        this._pairs[first] = [n, v];
        this._pairs = this._pairs.filter(([k], i) => k !== n || i === first);
      }
      this._changed();
    }
    sort() {
      this._pairs = this._pairs
        .map((pair, index) => ({ pair, index }))
        .sort((a, b) => (a.pair[0] < b.pair[0] ? -1 : a.pair[0] > b.pair[0] ? 1 : a.index - b.index))
        .map(({ pair }) => pair);
      this._changed();
    }
    forEach(callback, thisArg) {
      for (const [k, v] of this._pairs) callback.call(thisArg, v, k, this);
    }
    keys() {
      return this._pairs.map(([k]) => k)[Symbol.iterator]();
    }
    values() {
      return this._pairs.map(([, v]) => v)[Symbol.iterator]();
    }
    entries() {
      return this._pairs.map(([k, v]) => [k, v])[Symbol.iterator]();
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    toString() {
      return host.usp_serialize(this._pairs);
    }
  }

  const URL_PARTS = ['href', 'origin', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];
  class URL {
    constructor(input, base) {
      this._parts = host.url_parse(String(input), base === undefined ? null : String(base));
      this._params = new URLSearchParams(this._parts.search);
      this._params._url = this;
    }
    _setSearch(search) {
      this._parts = host.url_set(this._parts.href, 'search', search);
    }
    get searchParams() {
      return this._params;
    }
    toString() {
      return this._parts.href;
    }
    toJSON() {
      return this._parts.href;
    }
    static canParse(input, base) {
      try {
        new URL(input, base);
        return true;
      } catch {
        return false;
      }
    }
  }
  for (const part of URL_PARTS) {
    Object.defineProperty(URL.prototype, part, {
      configurable: true,
      enumerable: true,
      get() {
        return this._parts[part];
      },
      set:
        part === 'origin'
          ? undefined
          : function (value) {
              this._parts = host.url_set(this._parts.href, part, String(value));
              this._params._pairs = host.usp_parse(this._parts.search);
            },
    });
  }

  const cloneError = (text) => {
    const error = new Error(text);
    error.name = 'DataCloneError';
    return error;
  };
  const structuredClone = (value) => {
    const seen = new Map();
    const clone = (v) => {
      if (typeof v === 'function' || typeof v === 'symbol') throw cloneError(String(v) + ' could not be cloned.');
      if (v === null || typeof v !== 'object') return v;
      if (seen.has(v)) return seen.get(v);
      let out;
      if (Array.isArray(v)) {
        out = [];
        seen.set(v, out);
        for (let i = 0; i < v.length; i++) out[i] = clone(v[i]);
        return out;
      }
      if (v instanceof Date) {
        out = new Date(v.getTime());
      } else if (v instanceof RegExp) {
        out = new RegExp(v.source, v.flags);
      } else if (v instanceof Map) {
        out = new Map();
        seen.set(v, out);
        for (const [k, x] of v) out.set(clone(k), clone(x));
        return out;
      } else if (v instanceof Set) {
        out = new Set();
        seen.set(v, out);
        for (const x of v) out.add(clone(x));
        return out;
      } else if (v instanceof ArrayBuffer) {
        out = v.slice(0);
      } else if (v instanceof DataView) {
        out = new DataView(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
      } else if (ArrayBuffer.isView(v)) {
        out = v.slice();
      } else if (v instanceof Error) {
        out = new Error(v.message);
        out.name = v.name;
      } else {
        out = {};
        seen.set(v, out);
        for (const key of Object.keys(v)) out[key] = clone(v[key]);
        return out;
      }
      seen.set(v, out);
      return out;
    };
    return clone(value);
  };

  const atob = (data) => host.atob(String(data));
  const btoa = (data) => host.btoa(String(data));
  const discard = () => undefined;
  const console = Object.freeze({ log: discard, error: discard, warn: discard, info: discard });

  // Intl. QuickJS has none: each service formats through the host's Intl,
  // data in and data out, built on the host from the locales and options the
  // guest gave (the host keeps the services it built for the call).
  const INTL_SERVICES = {
    DateTimeFormat: ['format', 'formatToParts', 'formatRange', 'formatRangeToParts'],
    NumberFormat: ['format', 'formatToParts', 'formatRange', 'formatRangeToParts'],
    Collator: ['compare'],
    PluralRules: ['select', 'selectRange'],
    RelativeTimeFormat: ['format', 'formatToParts'],
    ListFormat: ['format', 'formatToParts'],
    DisplayNames: ['of'],
  };
  // As the real ones, format and compare are getters that return a bound function.
  const BOUND_METHODS = ['format', 'compare'];
  const localesArg = (locales) =>
    locales === undefined || locales === null
      ? null
      : typeof locales === 'string'
        ? locales
        : Array.from(locales, String);
  const optionsArg = (options) => {
    if (options === undefined || options === null) return null;
    const out = {};
    for (const key of Object.keys(options)) {
      const value = options[key];
      if (value === undefined) continue;
      out[key] = typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
    }
    return out;
  };
  const intlValue = (value) => {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'bigint') return String(value);
    if (value !== null && typeof value === 'object' && typeof value[Symbol.iterator] === 'function') {
      return Array.from(value, String);
    }
    return value;
  };
  const Intl = {};
  for (const service of Object.keys(INTL_SERVICES)) {
    const Service = class {
      constructor(locales, options) {
        this._locales = localesArg(locales);
        this._options = optionsArg(options);
        // The host builds the service here, so bad locales or options throw here, as they would there.
        this._resolved = host.intl_call(service, this._locales, this._options, 'resolvedOptions');
        this._bound = {};
      }
      resolvedOptions() {
        return JSON.parse(JSON.stringify(this._resolved));
      }
      static supportedLocalesOf(locales, options) {
        return host.intl_supported(service, localesArg(locales), optionsArg(options));
      }
    };
    Object.defineProperty(Service, 'name', { value: service });
    for (const method of INTL_SERVICES[service]) {
      const call = function (a, b) {
        return host.intl_call(service, this._locales, this._options, method, intlValue(a), intlValue(b));
      };
      if (BOUND_METHODS.includes(method)) {
        Object.defineProperty(Service.prototype, method, {
          configurable: true,
          get() {
            const self = this;
            return self._bound[method] || (self._bound[method] = (a, b) => call.call(self, a, b));
          },
        });
      } else {
        Object.defineProperty(Service.prototype, method, { configurable: true, writable: true, value: call });
      }
    }
    Intl[service] = Service;
  }
  Object.freeze(Intl);

  const define = (target, name, value) =>
    Object.defineProperty(target, name, { configurable: true, writable: true, enumerable: false, value });
  for (const method of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
    define(Date.prototype, method, function (locales, options) {
      return host.intl_date(method, this.getTime(), localesArg(locales), optionsArg(options));
    });
  }
  define(Number.prototype, 'toLocaleString', function (locales, options) {
    return host.intl_call('NumberFormat', localesArg(locales), optionsArg(options), 'format', Number(this));
  });
  if (typeof BigInt === 'function') {
    define(BigInt.prototype, 'toLocaleString', function (locales, options) {
      return host.intl_call('NumberFormat', localesArg(locales), optionsArg(options), 'format', String(this));
    });
  }
  define(String.prototype, 'localeCompare', function (that, locales, options) {
    return host.intl_compare(String(this), String(that), localesArg(locales), optionsArg(options));
  });
  // QuickJS calls each element's toLocaleString with no arguments; the
  // in-process context passes the locales and options on.
  define(Array.prototype, 'toLocaleString', function (locales, options) {
    const parts = [];
    for (let i = 0; i < this.length; i += 1) {
      const item = this[i];
      parts.push(item === undefined || item === null ? '' : String(item.toLocaleString(locales, options)));
    }
    return parts.join(',');
  });

  if (host.fetch) {
    class Headers {
      constructor(pairs) {
        this._pairs = pairs.map(([k, v]) => [String(k).toLowerCase(), String(v)]);
      }
      get(name) {
        const n = String(name).toLowerCase();
        const values = this._pairs.filter(([k]) => k === n).map(([, v]) => v);
        return values.length === 0 ? null : values.join(', ');
      }
      has(name) {
        const n = String(name).toLowerCase();
        return this._pairs.some(([k]) => k === n);
      }
      forEach(callback, thisArg) {
        for (const [k, v] of this._pairs) callback.call(thisArg, v, k, this);
      }
      keys() {
        return this._pairs.map(([k]) => k)[Symbol.iterator]();
      }
      values() {
        return this._pairs.map(([, v]) => v)[Symbol.iterator]();
      }
      entries() {
        return this._pairs.map(([k, v]) => [k, v])[Symbol.iterator]();
      }
      [Symbol.iterator]() {
        return this.entries();
      }
    }
    class Response {
      constructor(data) {
        this.status = data.status;
        this.statusText = data.statusText;
        this.ok = data.ok;
        this.redirected = data.redirected;
        this.url = data.url;
        this.type = data.type;
        this.headers = new Headers(data.headers);
        this.bodyUsed = false;
        this._body = new Uint8Array(data.body);
      }
      _take() {
        if (this.bodyUsed) throw new TypeError('Body is unusable: Body has already been read');
        this.bodyUsed = true;
        return this._body;
      }
      async arrayBuffer() {
        const body = this._take();
        return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      }
      async bytes() {
        return new Uint8Array(await this.arrayBuffer());
      }
      async text() {
        return host.text_decode('utf-8', false, false, bytesToLatin1(this._take()));
      }
      async json() {
        return JSON.parse(await this.text());
      }
      clone() {
        if (this.bodyUsed) throw new TypeError('Response.clone: Body has already been consumed.');
        return new Response({
          status: this.status,
          statusText: this.statusText,
          ok: this.ok,
          redirected: this.redirected,
          url: this.url,
          type: this.type,
          headers: [...this.headers],
          body: this._body.slice().buffer,
        });
      }
    }
    const headerPairs = (headers) => {
      if (headers === undefined || headers === null) return undefined;
      if (headers instanceof Headers) return [...headers];
      if (typeof headers[Symbol.iterator] === 'function') return Array.from(headers, (pair) => Array.from(pair, String));
      return Object.keys(headers).map((k) => [k, String(headers[k])]);
    };
    g.fetch = async (input, init) => {
      const target =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input !== null && typeof input === 'object' && 'url' in input
              ? { url: String(input.url) }
              : String(input);
      let options;
      if (init !== undefined && init !== null) {
        options = {};
        if (init.method !== undefined) options.method = String(init.method);
        const headers = headerPairs(init.headers);
        if (headers !== undefined) options.headers = headers;
        if (typeof init.body === 'string') options.body = init.body;
        if (init.redirect !== undefined) options.redirect = String(init.redirect);
      }
      return new Response(await host.fetch(target, options));
    };
  }

  if (host.fs_readFile) {
    g.fs = Object.freeze({ readFile: (filePath) => host.fs_readFile(String(filePath)) });
  }

  if (host.crypto_randomUUID) {
    class Digest {
      constructor(id) {
        this._id = id;
      }
      update(data, inputEncoding) {
        host.crypto_update(
          this._id,
          typeof data === 'string'
            ? { s: data, enc: inputEncoding === undefined ? 'utf8' : String(inputEncoding) }
            : { b: bytesToLatin1(toBytes(data)) },
        );
        return this;
      }
      digest(encoding) {
        const out = host.crypto_digest(this._id, encoding === undefined ? null : String(encoding));
        return typeof out === 'string' ? out : new Bytes(out);
      }
    }
    g.crypto = Object.freeze({
      randomUUID: () => host.crypto_randomUUID(),
      createHash: (algorithm) => new Digest(host.crypto_start('hash', String(algorithm), null)),
      createHmac: (algorithm, key) =>
        new Digest(
          host.crypto_start('hmac', String(algorithm), typeof key === 'string' ? { s: key } : { b: bytesToLatin1(toBytes(key)) }),
        ),
    });
  }

  // String code generation is refused, as the in-process context refuses it
  // (codeGeneration: { strings: false }): every Function constructor and eval
  // throw EvalError for source text. The host evaluates the forged code itself.
  const refusal = () => new EvalError('Code generation from strings disallowed for this context');
  const refusingConstructor = (name, prototype) => {
    const ctor = {
      [name]: function () {
        throw refusal();
      },
    }[name];
    Object.defineProperty(ctor, 'prototype', { value: prototype });
    Object.defineProperty(prototype, 'constructor', { value: ctor, writable: false, enumerable: false, configurable: false });
    return ctor;
  };
  const SafeFunction = refusingConstructor('Function', Function.prototype);
  refusingConstructor('AsyncFunction', Object.getPrototypeOf(async function () {}));
  refusingConstructor('GeneratorFunction', Object.getPrototypeOf(function* () {}));
  refusingConstructor('AsyncGeneratorFunction', Object.getPrototypeOf(async function* () {}));
  const evalRefusing = function (source) {
    if (typeof source === 'string') throw refusal();
    return source;
  };

  const absent = [
    'process', 'global', 'require', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout',
    'clearInterval', 'clearImmediate', 'queueMicrotask', 'Reflect', 'Proxy', 'WebAssembly',
    'SharedArrayBuffer', 'Atomics',
  ];
  if (!host.fetch) absent.push('fetch');
  for (const name of absent) g[name] = undefined;
  Object.assign(g, {
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    structuredClone,
    atob,
    btoa,
    console,
    Intl,
    Function: SafeFunction,
    eval: evalRefusing,
  });
  g.globalThis = undefined;
})();
`;
