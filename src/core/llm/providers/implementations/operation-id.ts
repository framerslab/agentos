/**
 * @module core/llm/providers/implementations/operation-id
 *
 * The operation id a provider sends with a call, in a header the host names.
 * A server in front of the provider (a metering proxy) reads it to tell a
 * retry of one call from a new call: the provider takes the call's
 * `operationId` option, or makes one id, before a call's first attempt and
 * sends that value on every attempt of the call (a
 * retry after a 429, a 5xx, a network failure or a stream that ended early,
 * and a hop to another key of the pool). A request sent again with a changed
 * body, such as `generateObject`'s request with a raised token budget, is a
 * new call and gets a new id.
 *
 * The header's name comes from the provider's `operationIdHeader` option, else
 * from {@link OPERATION_ID_HEADER_ENV} in the environment. With neither, no
 * header is sent and the request is what it was without this module.
 */
import { generateUUID } from '../../../utils/uuid.js';

/** The environment variable that names the header when the provider's config names none. */
export const OPERATION_ID_HEADER_ENV = 'AGENTOS_OPERATION_ID_HEADER';

/** An HTTP field name: a token of RFC 9110, section 5.6.2. */
const FIELD_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Headers the providers set themselves, or the transport does, which an
 * operation id may not replace (compared lowercased).
 */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'content-type',
  'content-length',
  'host',
  'connection',
  'user-agent',
  'anthropic-version',
  'anthropic-beta',
  'openai-organization',
  'http-referer',
  'x-title',
]);

/**
 * The name of the header a call's operation id goes in: `configured` (the
 * provider's `operationIdHeader`), else `AGENTOS_OPERATION_ID_HEADER`, else
 * none. A blank value counts as unset.
 *
 * @param configured The provider's `operationIdHeader` option.
 * @returns The header name, or `undefined` when neither names one.
 * @throws {RangeError} When the name is not an HTTP field name, or names a header the provider or the transport sets
 *   (`Authorization`, `x-api-key`, `Content-Type`, ...). Nothing is sent.
 */
export function resolveOperationIdHeader(configured: string | undefined): string | undefined {
  const fromEnv = typeof process !== 'undefined' ? process.env?.[OPERATION_ID_HEADER_ENV] : undefined;
  const name = configured?.trim() || fromEnv?.trim();
  if (!name) return undefined;
  if (!FIELD_NAME.test(name)) {
    throw new RangeError(`The operation id header "${name}" is not an HTTP header name.`);
  }
  if (RESERVED_HEADERS.has(name.toLowerCase())) {
    throw new RangeError(`The operation id header may not be "${name}", a header the provider sets itself.`);
  }
  return name;
}

/**
 * The header one call sends on each of its attempts: the resolved name with
 * the call's own id (`id`, the call's `operationId` option) or else a new UUID,
 * or no header when neither the option nor the variable names one. Call it
 * once per call, before the first attempt, and send the same object on every
 * attempt.
 *
 * @param configured The provider's `operationIdHeader` option.
 * @param id The id the call names (`ModelCompletionOptions.operationId`); a blank one counts as unset.
 * @throws {RangeError} As {@link resolveOperationIdHeader}.
 */
export function operationIdHeaders(configured: string | undefined, id?: string): Record<string, string> {
  return operationIdHeaderNamed(resolveOperationIdHeader(configured), id);
}

/**
 * An operation id under `name`, a name {@link resolveOperationIdHeader}
 * returned: `id` when the call names one, else a new one; no header when
 * `name` is `undefined`. For a caller that resolves the name once, outside its
 * own error handling, and makes an id for each of its requests: a key probe,
 * whose catch turns a failed request into an answer, resolves the name before
 * it so a refused name rejects.
 *
 * @param name The resolved header name.
 * @param id The id the call names; a blank one counts as unset.
 */
export function operationIdHeaderNamed(name: string | undefined, id?: string): Record<string, string> {
  if (!name) return {};
  return { [name]: typeof id === 'string' && id.trim() !== '' ? id : generateUUID() };
}

/**
 * Sets a call's operation id header ({@link operationIdHeaders}) on `headers`,
 * first removing any header there of the same name in another case, such as a
 * host's `customHeaders` entry. Fetch joins two such keys into one field
 * (`host-value, <id>`); after this the request carries one value, the id.
 * Every other header is kept.
 *
 * @param headers The request's headers, changed in place.
 * @param operationHeaders The call's operation id header, or `{}` for none.
 * @returns `headers`.
 */
export function setOperationIdHeaders(
  headers: Record<string, string>,
  operationHeaders: Record<string, string>,
): Record<string, string> {
  for (const [name, value] of Object.entries(operationHeaders)) {
    const lowered = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lowered) delete headers[key];
    }
    headers[name] = value;
  }
  return headers;
}
