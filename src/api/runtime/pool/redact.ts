/**
 * @fileoverview No credential in any record. The secret list of a call holds
 * every key and URL credential the call can send: what seating resolved, what
 * the agency's config writes (the agency level, the pool, the seats, their
 * hops and the chair), every `setDefaultProvider()` value and every provider
 * variable that is set. An error is masked in place where its own strings can
 * be written; an object it only references is replaced, on the error's own
 * property, by a masked copy; where a string cannot be written, a plain Error
 * carries the name, code, httpStatus and the masked message and stack.
 * Masking never throws.
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
 * provider's breaker open, can be the entry an earlier call is sending.
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
  // A seat or the chair, with the hops of its own chain. A pre-built seat writes none of these and adds nothing.
  const addSeat = (seat: unknown): void => {
    addWritten(seat);
    const hops = isObject(seat) ? (seat as { fallbackProviders?: unknown }).fallbackProviders : undefined;
    if (Array.isArray(hops)) hops.forEach(addWritten);
  };
  seatingSecrets.forEach(add);
  addWritten(agency);
  Object.values(agency.modelPool ?? {}).forEach(addWritten);
  Object.values(agency.agents ?? {}).forEach(addSeat);
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
 * A mask that reads its secret list from `holder` when it is called, so one
 * function serves every call of an agency.
 *
 * @param holder - Where the agency keeps the list of the call under way.
 * @returns A function that applies {@link maskError} with the list `holder` holds at that moment.
 */
export function createErrorMask(holder: { list: readonly string[] }): (error: unknown) => unknown {
  return (error) => maskError(error, holder.list);
}

/**
 * A copy of `value` with every string redacted, at any depth of plain objects
 * and arrays (a conversation delta, a tool-call list). Anything else, a class
 * instance or a typed array, comes back as it is. Finalization uses it where
 * the tool loops cannot mask: on what a pre-built seat returns.
 *
 * @param value - A record made of plain objects, arrays and strings.
 * @param secrets - The call's redaction list.
 * @returns The redacted copy; `value` itself when the list is empty.
 */
export function redactStrings<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value;
  const copies = new WeakMap<object, object>();
  const pending: Array<[source: object, copy: object]> = [];
  const copyOf = (item: unknown): unknown => {
    if (typeof item === 'string') return redactText(item, secrets);
    if (!isObject(item)) return item;
    const known = copies.get(item);
    if (known) return known;
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
