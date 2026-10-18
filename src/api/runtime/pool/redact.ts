/**
 * @fileoverview No credential in any record. The secret list of a call holds
 * every key and URL credential the call can send: what seating resolved, what
 * the agency's config writes (the agency level, the pool, the seats, their
 * hops and the chair), what a pre-built seat was built with (its own key, URL
 * and hops; a nested agency's level, pool, seats and chair), every
 * `setDefaultProvider()` value and every provider variable that is set. An
 * error is masked in place where its own strings can
 * be written; an object it only references is replaced, on the error's own
 * property, by a masked copy; where a string cannot be written, a plain Error
 * carries the name, code, httpStatus and the masked message and stack.
 * What a seat answers (its text, its tool calls, its streamed parts) is masked
 * by the listed values alone, so a reply that quotes a URL keeps it. Masking
 * never throws.
 */
import type { AgencyOptions } from '../../types.js';
import { getDefaultProvider } from '../global-default.js';
import { providerEnvSecrets } from '../../model.js';
import { baseUrlCredentials, redactUrlSecrets } from '../../../core/llm/providers/url-secrets.js';

/** A value shorter than this is left out: the redactor replaces literally, and a short placeholder key would shred every message. */
const MIN_SECRET_LENGTH = 8;

/**
 * An error whose object graph is larger than this is not walked: a plain Error
 * stands in for it, which bounds the work an upstream error body can demand.
 */
const MAX_WALKED_OBJECTS = 100_000;

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

/**
 * The redaction list for one call, longest first. Every value is listed
 * whole and, as `ApiKeyPool` splits a comma-separated key, part by part. What
 * the config writes is listed whether or not this call seats it: an agency's
 * calls overlap and share one mask, so an entry this call skips, its
 * key's breaker open, can be the entry an earlier call is sending.
 *
 * @param agency - The agency options.
 * @param seatingSecrets - What seating resolved for the call (`SeatedRoster.secrets`).
 * @returns Every value to mask, each at least 8 characters, longest first.
 */
export function collectCallSecrets(agency: AgencyOptions, seatingSecrets: readonly string[]): string[] {
  const out = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    for (const part of [value, ...value.split(',')]) {
      const trimmed = part.trim();
      if (trimmed.length >= MIN_SECRET_LENGTH) out.add(trimmed);
    }
  };
  // The key and the URL credentials written on the agency, a pool entry, a seat, a hop, the chair or a default.
  const addWritten = (config: unknown): void => {
    if (!isObject(config)) return;
    const { apiKey, baseUrl } = config as { apiKey?: unknown; baseUrl?: unknown };
    add(apiKey);
    if (typeof baseUrl === 'string') add(baseUrlCredentials(baseUrl));
  };
  // A seat or the chair, with the hops of its own chain. A pre-built seat writes none of these on itself.
  const addSeat = (seat: unknown): void => {
    addWritten(seat);
    const hops = isObject(seat) ? (seat as { fallbackProviders?: unknown }).fallbackProviders : undefined;
    if (Array.isArray(hops)) hops.forEach(addWritten);
  };
  // A pre-built seat keeps the config it was built from on `__config` (agent() and agency() define it for the
  // export): its own key, URL and hops, and for a nested agency its agency level, pool, seats and chair, with every
  // pre-built seat among them read the same way. An answer that repeats its own key is then masked like any other.
  const seen: WeakSet<object> = new WeakSet();
  const addPrebuilt = (seat: unknown): void => {
    if (!isObject(seat) || seen.has(seat)) return;
    seen.add(seat);
    let config: unknown;
    try {
      config = (seat as { __config?: unknown }).__config;
    } catch {
      return;
    }
    if (!isObject(config)) return;
    addSeat(config);
    const { modelPool, agents, chair } = config as { modelPool?: unknown; agents?: unknown; chair?: unknown };
    if (isObject(modelPool)) Object.values(modelPool).forEach(addWritten);
    if (isObject(agents)) {
      for (const member of Object.values(agents)) {
        addSeat(member);
        addPrebuilt(member);
      }
    }
    addSeat(chair);
  };
  seatingSecrets.forEach(add);
  addWritten(agency);
  Object.values(agency.modelPool ?? {}).forEach(addWritten);
  for (const seat of Object.values(agency.agents ?? {})) {
    addSeat(seat);
    addPrebuilt(seat);
  }
  addSeat(agency.chair);
  addWritten(getDefaultProvider());
  const env = providerEnvSecrets();
  env.keys.forEach(add);
  env.urlCredentials.forEach(add);
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Replaces every secret in `text` with `[redacted]`, and with them what
 * `redactUrlSecrets` always masks: the credentials of any URL and the value of
 * a `key` query parameter.
 *
 * @param text - An error message, a stack or any other text of a record.
 * @param secrets - The call's redaction list.
 * @returns The text with every secret replaced; `text` itself when the list is empty.
 */
export function redactText(text: string, secrets: readonly string[]): string {
  return secrets.length === 0 ? text : redactUrlSecrets(text, undefined, secrets);
}

/**
 * Replaces every listed secret in `text` with `[redacted]`, and nothing else:
 * unlike {@link redactText}, no URL pattern is read, so an answer that quotes
 * `https://host/?key=v` or `ssh://git@host` keeps it. For what a model or a
 * tool returns.
 *
 * @param text - A seat's answer, a tool result or any other text it returns.
 * @param secrets - The call's redaction list, longest first.
 * @returns The text with every listed secret replaced; `text` itself when none occurs.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0 && out.includes(secret)) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** Masks text that arrives in pieces, as a stream delivers it. */
export interface ChunkRedactor {
  /**
   * Takes the next piece and returns the masked text that can be released:
   * a tail that could be the start of a secret is held until the next piece
   * shows whether it is, so a secret split between two pieces is masked
   * whole. Returns `''` while everything received is held.
   */
  push(chunk: string): string;
  /** Returns the masked text still held, at the end of the stream. */
  flush(): string;
  /** The tail still held, as it came: text that could start a secret. For a reader that keeps what arrives behind it in order. */
  held(): string;
}

/**
 * A {@link ChunkRedactor} over the list `getSecrets` returns when a piece
 * arrives. It holds only a tail that is the start of a listed secret, so text
 * with no such tail is released as it comes.
 *
 * @param getSecrets - Reads the call's redaction list.
 * @returns A redactor for one stream.
 */
export function createChunkRedactor(getSecrets: () => readonly string[]): ChunkRedactor {
  let pending = '';
  return {
    push(chunk: string): string {
      pending += chunk;
      const secrets = getSecrets();
      // The earliest point from which the rest of `pending` is the start of a
      // secret the next piece could complete.
      let hold = pending.length;
      for (const secret of secrets) {
        if (secret.length < 2) continue;
        const from = Math.max(0, pending.length - secret.length + 1);
        for (let p = pending.indexOf(secret[0], from); p !== -1 && p < hold; p = pending.indexOf(secret[0], p + 1)) {
          if (secret.startsWith(pending.slice(p))) {
            hold = p;
            break;
          }
        }
      }
      // A whole secret that runs across that point is released whole.
      let cut = hold;
      for (const secret of secrets) {
        if (secret.length === 0) continue;
        for (let i = pending.indexOf(secret); i !== -1 && i < cut; i = pending.indexOf(secret, i + 1)) {
          if (i + secret.length > cut) cut = i + secret.length;
        }
      }
      const out = redactSecrets(pending.slice(0, cut), secrets);
      pending = pending.slice(cut);
      return out;
    },
    flush(): string {
      const out = redactSecrets(pending, getSecrets());
      pending = '';
      return out;
    },
    held(): string {
      return pending;
    },
  };
}

/** Whether `text` holds one of `secrets`. */
const holds = (text: string, secrets: readonly string[]): boolean =>
  secrets.some((secret) => secret.length > 0 && text.includes(secret));

/** A property's value; undefined when its getter throws. */
function read(holder: object, key: PropertyKey): unknown {
  try {
    return (holder as Record<PropertyKey, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Assigns through the property as it stands: a setter runs, a locked property refuses. The caller checks the outcome. */
function write(holder: object, key: PropertyKey, value: unknown): void {
  try {
    (holder as Record<PropertyKey, unknown>)[key] = value;
  } catch {
    // Frozen, read-only or an accessor with no setter: the check after the pass finds the secret still there.
  }
}

/** Defines `key` on a copy as a data property. No setter runs, so a `__proto__` key stays a key. */
function define(copy: object, key: PropertyKey, value: unknown, enumerable: boolean): void {
  Object.defineProperty(copy, key, { value, writable: true, enumerable, configurable: true });
}

/**
 * Everything `node` holds that a secret could sit in: the values of its own
 * properties, symbol-keyed and non-enumerable ones included, the entries of a
 * Map or a Set, and the message and stack of an Error, which a class may
 * serve from its prototype over a private field. A typed array's bytes are
 * not read.
 */
function valuesOf(node: object): unknown[] {
  const values: unknown[] = [];
  try {
    if (ArrayBuffer.isView(node)) return values;
    for (const key of Reflect.ownKeys(node)) values.push(read(node, key));
    if (node instanceof Error) values.push(read(node, 'message'), read(node, 'stack'));
    else if (node instanceof Map) node.forEach((value, key) => values.push(key, value));
    else if (node instanceof Set) node.forEach((value) => values.push(value));
  } catch {
    // A proxy that refuses to list its keys, or a Map whose methods were replaced: what was read stands.
  }
  return values;
}

/** Stops a walk that has grown past {@link MAX_WALKED_OBJECTS}. */
function countWalked(walked: number): void {
  if (walked > MAX_WALKED_OBJECTS) throw new RangeError('error graph too large to mask in place');
}

/** Whether a secret can be reached from `root`, at any depth. A visited set guards against cycles. */
function containsSecret(root: object, secrets: readonly string[]): boolean {
  const seen = new WeakSet<object>([root]);
  const pending: object[] = [root];
  let walked = 0;
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    countWalked(++walked);
    for (const value of valuesOf(node)) {
      if (typeof value === 'string') {
        if (holds(value, secrets)) return true;
      } else if (isObject(value) && !seen.has(value)) {
        seen.add(value);
        pending.push(value);
      }
    }
  }
  return false;
}

/**
 * One walk over everything `root` references, at any depth and safe against
 * cycles. `dirty` holds every object from which a secret can be reached
 * without passing through `root`; `root` is in it when an object it
 * references is. `rootHolds` says whether one of `root`'s own values is a
 * string with a secret, which is written in place and so makes nothing else
 * dirty.
 */
function findSecrets(root: object, secrets: readonly string[]): { dirty: Set<object>; rootHolds: boolean } {
  const parents = new Map<object, object[]>([[root, []]]);
  const dirty = new Set<object>();
  const pending: object[] = [root];
  let rootHolds = false;
  let walked = 0;
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    countWalked(++walked);
    for (const value of valuesOf(node)) {
      if (typeof value === 'string') {
        if (!holds(value, secrets)) continue;
        if (node === root) rootHolds = true;
        else dirty.add(node);
      } else if (isObject(value)) {
        const known = parents.get(value);
        if (known) known.push(node);
        else {
          parents.set(value, [node]);
          pending.push(value);
        }
      }
    }
  }
  // Whatever references a dirty object is dirty. The climb stops at the root: its
  // own property is where the masked copy goes, so what references the root stays clean.
  const climbing = [...dirty];
  for (let node = climbing.pop(); node !== undefined; node = climbing.pop()) {
    if (node === root) continue;
    for (const parent of parents.get(node) ?? []) {
      if (dirty.has(parent)) continue;
      dirty.add(parent);
      climbing.push(parent);
    }
  }
  return { dirty, rootHolds };
}

/**
 * A plain Error standing in for an object that cannot be written or copied as
 * it is. It carries the source's name, code and httpStatus and its masked
 * message and stack, and nothing the source references. Never
 * `Object.create(prototype)`: the getters of a host error (a `DOMException`)
 * read per-instance state and throw on such a copy.
 */
function plainErrorCopy(source: object, secrets: readonly string[]): Error {
  const message = read(source, 'message');
  const out = new Error(typeof message === 'string' ? redactText(message, secrets) : 'error');
  const name = read(source, 'name');
  if (typeof name === 'string' && name !== out.name) out.name = redactText(name, secrets);
  for (const key of ['code', 'httpStatus']) {
    const value = read(source, key);
    if (typeof value === 'string') define(out, key, redactText(value, secrets), true);
    else if (typeof value === 'number') define(out, key, value, true);
  }
  const stack = read(source, 'stack');
  if (typeof stack === 'string') out.stack = redactText(stack, secrets);
  return out;
}

/** An empty array or plain object to copy `value` into; undefined when `value` is neither. */
function shellOf(value: object): object | undefined {
  if (Array.isArray(value)) return [];
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === Object.prototype) return {};
  return proto === null ? (Object.create(null) as object) : undefined;
}

/** Copies the listed properties of `source` onto `copy`, each value through `copyOf`, each as enumerable as it was. */
function fill(source: object, copy: object, keys: readonly PropertyKey[], copyOf: (item: unknown) => unknown): void {
  for (const key of keys) {
    define(copy, key, copyOf(read(source, key)), Object.prototype.propertyIsEnumerable.call(source, key));
  }
  if (Array.isArray(source)) (copy as unknown[]).length = source.length;
}

/**
 * A masked copy of an object the error only references. Every object on the
 * way down to a secret is copied and nothing else: an object that holds no
 * secret is shared with the original. A plain object, an array and a plain
 * Error are copied member by member; anything else becomes a plain Error
 * ({@link plainErrorCopy}).
 *
 * @param value - A dirty object, as {@link findSecrets} found it.
 * @param secrets - The call's redaction list.
 * @param dirty - The objects that hold a secret, from {@link findSecrets}.
 * @param copies - Copies already made for this error, so a shared or cyclic reference maps to one copy.
 */
function copyMasked(value: object, secrets: readonly string[], dirty: ReadonlySet<object>, copies: WeakMap<object, object>): unknown {
  const pending: Array<[source: object, copy: object, keys: PropertyKey[]]> = [];
  const copyOf = (item: unknown): unknown => {
    if (typeof item === 'string') return redactText(item, secrets);
    if (!isObject(item) || !dirty.has(item)) return item;
    const known = copies.get(item);
    if (known) return known;
    let copy = shellOf(item);
    let keys: PropertyKey[] = [];
    if (copy) keys = Object.keys(item);
    else if (item instanceof Error && Object.getPrototypeOf(item) === Error.prototype) {
      // A plain Error keeps its own properties; its message and stack are set here, masked.
      const message = read(item, 'message');
      const stack = read(item, 'stack');
      const error = new Error(typeof message === 'string' ? redactText(message, secrets) : undefined);
      if (typeof stack === 'string') error.stack = redactText(stack, secrets);
      copy = error;
      keys = Reflect.ownKeys(item).filter((key) => key !== 'message' && key !== 'stack');
    } else copy = plainErrorCopy(item, secrets);
    copies.set(item, copy);
    if (keys.length > 0) pending.push([item, copy, keys]);
    return copy;
  };
  const root = copyOf(value);
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) fill(next[0], next[1], next[2], copyOf);
  return root;
}

/**
 * Writes the masked form of every own property of `target` that holds a
 * secret: a string in place, a referenced object as a masked copy. The message
 * and stack of an Error are tried even when its prototype serves them.
 *
 * @returns Whether `target` holds no secret afterwards.
 */
function maskInPlace(target: object, secrets: readonly string[]): boolean {
  const { dirty, rootHolds } = findSecrets(target, secrets);
  if (!rootHolds && !dirty.has(target)) return true;
  // A reference back to the error stays a reference to the error.
  const copies = new WeakMap<object, object>([[target, target]]);
  const keys: PropertyKey[] = Reflect.ownKeys(target);
  if (target instanceof Error) {
    for (const key of ['message', 'stack']) if (!keys.includes(key)) keys.push(key);
  }
  for (const key of keys) {
    const value = read(target, key);
    if (typeof value === 'string') {
      if (holds(value, secrets)) write(target, key, redactText(value, secrets));
    } else if (isObject(value) && value !== target && dirty.has(value)) {
      write(target, key, copyMasked(value, secrets, dirty, copies));
    }
  }
  // One check for every write: a locked property, a setter that kept its value, a message only the prototype serves.
  return !containsSecret(target, secrets);
}

/**
 * Masks `error` against `secrets`. A string comes back redacted. An object's
 * own strings are written in place, and each object it references that holds
 * a secret, at any depth, is replaced on the error's own property by a masked
 * copy: the error keeps its class, its shape and the marks a failover walker
 * reads, the referenced objects are left as they were, and the same object is
 * returned. Where a string cannot be written (a frozen error, an accessor with
 * no setter, a message a class serves from a private field), or the error's
 * object graph is too large to walk, a plain Error with the original's name,
 * code and httpStatus and the masked message and stack is returned instead.
 * Never throws.
 *
 * @param error - What was thrown, or an error text.
 * @param secrets - The call's redaction list ({@link collectCallSecrets}).
 * @returns The masked error: the same object, a plain Error, or the redacted string.
 */
export function maskError(error: unknown, secrets: readonly string[]): unknown {
  try {
    if (typeof error === 'string') return redactText(error, secrets);
    if (!isObject(error) || secrets.length === 0) return error;
    let masked = false;
    try {
      masked = maskInPlace(error, secrets);
    } catch {
      // Too large to walk, or a proxy that refuses: the plain Error below references none of it.
    }
    return masked ? error : plainErrorCopy(error, secrets);
  } catch {
    return new Error('error masked: the original could not be read');
  }
}

/**
 * A masked stand-in for `error` that never writes `error` or anything it
 * references: `error` itself when no secret can be reached from it, else a
 * plain Error with its name, code and httpStatus and its masked message and
 * stack. A string comes back redacted. For an error that belongs to someone
 * else, such as a HITL handler's, which {@link maskError} would write in
 * place. Never throws.
 *
 * @param error - What was thrown, or an error text.
 * @param secrets - The call's redaction list ({@link collectCallSecrets}).
 * @returns `error` itself, a plain Error, or the redacted string.
 */
export function maskedCopyOf(error: unknown, secrets: readonly string[]): unknown {
  try {
    if (typeof error === 'string') return redactText(error, secrets);
    if (!isObject(error) || secrets.length === 0) return error;
    let clean = false;
    try {
      clean = !containsSecret(error, secrets);
    } catch {
      // Too large to walk, or a proxy that refuses: the plain Error below references none of it.
    }
    return clean ? error : plainErrorCopy(error, secrets);
  } catch {
    return new Error('error masked: the original could not be read');
  }
}

/**
 * The mask of an agency's calls: called on an error it is {@link maskError};
 * its members mask what a seat answers by the same list, read when they run.
 */
export interface CallMask {
  (error: unknown): unknown;
  /** `text` with every listed secret replaced ({@link redactSecrets}). */
  text(text: string): string;
  /** A copy of a record of plain objects and arrays with every string masked as {@link CallMask.text} masks it. */
  strings<T>(value: T): T;
  /** A {@link ChunkRedactor} for one stream of text. */
  chunks(): ChunkRedactor;
}

/** Whether `mask` is a {@link CallMask}, as an agency's seating writes it, and not a bare error mask. */
export function isCallMask(mask: unknown): mask is CallMask {
  const m = mask as Partial<CallMask> | undefined;
  return typeof mask === 'function' && typeof m?.text === 'function' && typeof m.strings === 'function' && typeof m.chunks === 'function';
}

/**
 * A mask that reads its secret list from `holder` when it is called, so one
 * function serves every call of an agency.
 *
 * @param holder - Where the agency keeps the list of the call under way.
 * @returns A {@link CallMask}: {@link maskError} with the list `holder` holds at that moment, and the text forms over the same list.
 */
export function createErrorMask(holder: { list: readonly string[] }): CallMask {
  const mask = ((error: unknown) => maskError(error, holder.list)) as CallMask;
  mask.text = (text) => redactSecrets(text, holder.list);
  mask.strings = (value) => maskStrings(value, holder.list);
  mask.chunks = () => createChunkRedactor(() => holder.list);
  return mask;
}

/**
 * A copy of `value` with every string redacted, at any depth of plain objects
 * and arrays (a conversation delta, a tool-call list), and every number whose
 * digits hold a secret replaced by the string `[redacted]`. An Error inside it from
 * which a secret can be reached (one a tool returned as its output, its
 * message or cause holding a key) is replaced by its masked stand-in
 * ({@link maskedCopyOf}); a clean Error, any other class instance and a typed
 * array come back as they are. Finalization uses it where the tool loops
 * cannot mask: on what a pre-built seat returns.
 *
 * @param value - A record made of plain objects, arrays and strings.
 * @param secrets - The call's redaction list.
 * @returns The redacted copy; `value` itself when the list is empty.
 */
export function redactStrings<T>(value: T, secrets: readonly string[]): T {
  return secrets.length === 0 ? value : copyStrings(value, secrets, (text) => redactText(text, secrets));
}

/**
 * {@link redactStrings} with the listed values alone ({@link redactSecrets})
 * for its strings: for what a seat answers, its result and its tool calls,
 * where a URL in a reply is the reply's own. An Error inside it is replaced
 * as {@link redactStrings} replaces it, the error mask's URL patterns
 * included, as a failed tool's error is masked.
 *
 * @param value - A record made of plain objects, arrays and strings.
 * @param secrets - The call's redaction list.
 * @returns The masked copy; `value` itself when the list is empty.
 */
export function maskStrings<T>(value: T, secrets: readonly string[]): T {
  return secrets.length === 0 ? value : copyStrings(value, secrets, (text) => redactSecrets(text, secrets));
}

/**
 * A copy of `value` with every string passed through `redact`, at any depth
 * of plain objects and arrays, every number whose digits hold a secret
 * replaced by the string `[redacted]`, and every Error from which a secret can
 * be reached replaced by its masked stand-in, one copy per Error.
 */
function copyStrings<T>(value: T, secrets: readonly string[], redact: (text: string) => string): T {
  const copies = new WeakMap<object, object>();
  const pending: Array<[source: object, copy: object]> = [];
  const copyOf = (item: unknown): unknown => {
    if (typeof item === 'string') return redact(item);
    // A number whose digits hold a listed value (a tool that returns a numeric key) comes back as the string
    // `[redacted]`: left as it is, its serialized form would be masked into no JSON.
    if (typeof item === 'number') return holds(String(item), secrets) ? '[redacted]' : item;
    if (!isObject(item)) return item;
    const known = copies.get(item);
    if (known) return known;
    if (item instanceof Error) {
      // Not a plain object, so no shell copies it member by member: the error mask's stand-in carries its name, code,
      // httpStatus and masked message and stack, and nothing it referenced; a clean error is itself.
      const stood = maskedCopyOf(item, secrets) as object;
      copies.set(item, stood);
      return stood;
    }
    const copy = shellOf(item);
    if (!copy) return item;
    copies.set(item, copy);
    pending.push([item, copy]);
    return copy;
  };
  const root = copyOf(value);
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) fill(next[0], next[1], Object.keys(next[0]), copyOf);
  return root as T;
}
