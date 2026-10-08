/**
 * @fileoverview Plivo telephony provider for AgentOS voice calls.
 *
 * Implements {@link IVoiceCallProvider} using the Plivo Voice REST API v1.
 *
 * ## REST API contract
 *
 * | Operation      | Method | Endpoint                                     | Body format |
 * |----------------|--------|----------------------------------------------|-------------|
 * | Initiate call  | POST   | `/v1/Account/{authId}/Call/`                 | JSON        |
 * | Hangup call    | DELETE | `/v1/Account/{authId}/Call/{callUuid}/`       | (none)      |
 * | Play TTS       | POST   | `/v1/Account/{authId}/Call/{callUuid}/Speak/` | JSON       |
 *
 * All requests use HTTP Basic authentication: `Authorization: Basic base64(authId:authToken)`.
 *
 * ### Hangup uses DELETE (not POST)
 *
 * Unlike Twilio (which POSTs `Status=completed`) and Telnyx (which POSTs to
 * an `/actions/hangup` endpoint), Plivo uses the HTTP `DELETE` method on the
 * Call resource to terminate an active call. This is a RESTful design choice
 * where "deleting" the call resource means terminating the call.
 *
 * ## Webhook verification: HMAC-SHA256 + nonce (v3 scheme)
 *
 * Plivo's v3 signature covers the method, the URL, its query and the POST
 * fields (see {@link computePlivoV3Signature}). The nonce arrives in
 * `X-Plivo-Signature-V3-Nonce` and the signature in `X-Plivo-Signature-V3`
 * (or `X-Plivo-Signature-Ma-V3`, signed with the main account's token), which
 * may list several signatures separated by commas.
 *
 * Plivo's SDKs build the signed text differently in three places:
 * plivo-python (`plivo/utils/signature_v3.py`) decodes the query one
 * character per byte, writes JSON values with Python's `str()` and sorts by
 * code point; plivo-node decodes the query as UTF-8, writes JSON values with
 * `String()` and sorts by UTF-16 code unit. Plivo does not document which its
 * servers match, so a signature over either text is accepted (see
 * {@link PlivoCanonicalStyle}). For ASCII callbacks with string fields the two
 * texts are the same.
 *
 * ## DTMF via `<GetDigits>` XML pattern
 *
 * Plivo delivers DTMF input through the `<GetDigits>` XML element callback,
 * not through the media stream WebSocket. When a call executes:
 *
 * ```xml
 * <GetDigits action="https://example.com/dtmf" method="POST" timeout="10">
 *   <Speak>Press 1 to confirm.</Speak>
 * </GetDigits>
 * ```
 *
 * Plivo POSTs the pressed digits to the `action` URL with a `Digits`
 * parameter in the form-encoded body (e.g., `Digits=1&CallUUID=xxx`).
 *
 * ## Event mapping table
 *
 * | Plivo `CallStatus`  | Normalised `kind`    |
 * |---------------------|----------------------|
 * | `ringing`           | `call-ringing`       |
 * | `in-progress`       | `call-answered`      |
 * | `completed`         | `call-completed`     |
 * | `busy`              | `call-busy`          |
 * | `no-answer`         | `call-no-answer`     |
 * | `failed`            | `call-failed`        |
 * | (+ `Digits` param)  | `call-dtmf`          |
 *
 * @module @framers/agentos/voice/providers/plivo
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type {
  IVoiceCallProvider,
  InitiateCallInput,
  InitiateCallResult,
  HangupCallInput,
  PlayTtsInput,
} from '../IVoiceCallProvider.js';

import type {
  WebhookContext,
  WebhookVerificationResult,
  WebhookParseResult,
  NormalizedCallEvent,
} from '../types.js';

// ============================================================================
// Config
// ============================================================================

/**
 * Configuration for {@link PlivoVoiceProvider}.
 */
export interface PlivoVoiceProviderConfig {
  /** Plivo Auth ID (account identifier, used in API URLs and Basic auth). */
  authId: string;
  /** Plivo Auth Token (used for both API auth and webhook HMAC verification). */
  authToken: string;
  /**
   * Optional fetch implementation override -- inject a mock in tests.
   * Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

// ============================================================================
// PlivoVoiceProvider
// ============================================================================

/** A webhook field's value: one string, a repeated field's values, or a nested object. */
export type PlivoParamValue = string | string[] | PlivoParams;

/** Webhook fields by name, as {@link computePlivoV3Signature} signs them. */
export interface PlivoParams {
  [key: string]: PlivoParamValue;
}

/**
 * Which SDK's signed text to build.
 *
 * - `'python'`: as plivo-python 4.63 builds it on Python 3.12 and later. The
 *   query is decoded one character per byte (`caf%C3%A9` reads `cafÃ©`), JSON
 *   values are written with `str()` (`True`, `None`, `1.0`, `1e-07`) and keys
 *   and repeated values are sorted by code point, as `sorted()` does.
 * - `'js'`: JavaScript's text, which is plivo-node's for flat bodies of
 *   strings, numbers and booleans. The query is decoded as UTF-8, JSON values
 *   are written with `String()` (`true`, `null`, `1`, `1e-7`) and sorting is by
 *   UTF-16 code unit, JavaScript's default. plivo-node throws on a JSON null
 *   and writes a nested object as `[object Object]`; this style writes `null`
 *   and signs nested fields like plivo-python, so no field goes unsigned.
 */
export type PlivoCanonicalStyle = 'python' | 'js';

/** Both signed texts, the order {@link PlivoVoiceProvider.verifyWebhook} tries them in. */
const PLIVO_CANONICAL_STYLES: readonly PlivoCanonicalStyle[] = ['python', 'js'];

/**
 * Orders strings by code point, as Python's `sorted()` does. JavaScript's
 * default sort orders by UTF-16 code unit, which differs only when a
 * character above U+FFFF meets one from U+E000 to U+FFFF at the same place.
 */
function compareCodePoints(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const left = a.codePointAt(index) as number;
    const right = b.codePointAt(index) as number;
    if (left !== right) return left - right;
    // Equal code points above U+FFFF are the same surrogate pair in both strings.
    if (left > 0xffff) index++;
  }
  return a.length - b.length;
}

/** The sort comparator for a style; `undefined` is JavaScript's default order. */
function comparatorFor(style: PlivoCanonicalStyle): ((a: string, b: string) => number) | undefined {
  return style === 'python' ? compareCodePoints : undefined;
}

/**
 * One query component decoded as plivo-python decodes it: `+` becomes a
 * space, each valid `%XX` becomes that byte, other characters keep their
 * UTF-8 bytes, and each byte becomes one character from U+0000 to U+00FF.
 */
function decodePythonQueryComponent(component: string): string {
  const raw = Buffer.from(component.replace(/\+/g, ' '), 'utf8');
  const bytes = Buffer.alloc(raw.length);
  let length = 0;
  for (let index = 0; index < raw.length; index++) {
    const hex = index + 2 < raw.length ? raw.toString('latin1', index + 1, index + 3) : '';
    if (raw[index] === 0x25 && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes[length++] = parseInt(hex, 16);
      index += 2;
    } else {
      bytes[length++] = raw[index];
    }
  }
  return bytes.toString('latin1', 0, length);
}

/**
 * Query fields grouped by key as plivo-python's `parse_qs` reads them on
 * Python 3.12 and later: split on `&`, empty segments skipped, a segment
 * without `=` read as an empty value, each part decoded with
 * {@link decodePythonQueryComponent}.
 */
function groupPythonQueryFields(encoded: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const segment of encoded.split('&')) {
    if (!segment) continue;
    const equals = segment.indexOf('=');
    const key = decodePythonQueryComponent(equals >= 0 ? segment.slice(0, equals) : segment);
    const value = equals >= 0 ? decodePythonQueryComponent(segment.slice(equals + 1)) : '';
    const values = fields.get(key);
    if (values) values.push(value);
    else fields.set(key, [value]);
  }
  return fields;
}

/**
 * URL-encoded fields grouped by key in one pass (a repeated key keeps every
 * value in order). Calling getAll() per key would rescan the whole input for
 * each key, quadratic work on a request that is not yet verified.
 */
function groupFormFields(encoded: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const [key, value] of new URLSearchParams(encoded)) {
    const values = fields.get(key);
    if (values) values.push(value);
    else fields.set(key, [value]);
  }
  return fields;
}

/**
 * The URL and query parts Plivo signs: everything before `?` (the fragment
 * dropped), and the query's values by key, decoded as the style decodes
 * them. Path parameters (`;name=value`) stay in the base, as plivo-node keeps
 * them; plivo-python's urlparse drops the last segment's parameters, which
 * would leave them unsigned.
 */
function splitPlivoUrl(
  url: string,
  style: PlivoCanonicalStyle = 'js',
): { base: string; query: Record<string, string[]> } {
  const withoutFragment = url.split('#')[0];
  const queryStart = withoutFragment.indexOf('?');
  const base = queryStart >= 0 ? withoutFragment.slice(0, queryStart) : withoutFragment;
  if (queryStart < 0) return { base, query: {} };
  const encoded = withoutFragment.slice(queryStart + 1);
  const grouped = style === 'python' ? groupPythonQueryFields(encoded) : groupFormFields(encoded);
  return { base, query: Object.fromEntries(grouped) };
}

/** `key=value` pairs joined by `&`, keys and each key's values sorted with `compare`. */
function sortedQueryString(params: Record<string, string[]>, compare?: (a: string, b: string) => number): string {
  return Object.keys(params)
    .sort(compare)
    .map((key) => [...params[key]].sort(compare).map((item) => `${key}=${item}`).join('&'))
    .join('&');
}

/**
 * Longest text the POST fields may sign to, in UTF-16 code units. Both SDKs
 * write a JSON array's key before every item, so a body under 100 KB with a
 * long key over a long array would sign to gigabytes, all of it built and
 * hashed before any signature is compared. Plivo's callbacks sign to a few
 * kilobytes.
 */
const MAX_PLIVO_SIGNED_FIELDS_LENGTH = 1 << 20;

/**
 * Every field as `key` + `value` with no separators, keys and values sorted
 * with `compare`, nested objects in place.
 *
 * @throws RangeError when the text would pass {@link MAX_PLIVO_SIGNED_FIELDS_LENGTH}.
 */
function sortedParamsString(params: PlivoParams, compare?: (a: string, b: string) => number): string {
  // Every piece goes into one array joined once, so each byte is copied
  // once. Joining per nesting level would copy a subtree again at every
  // level above it, depth x size work on a body that is not yet verified.
  const parts: string[] = [];
  appendSortedParams(params, parts, compare, { remaining: MAX_PLIVO_SIGNED_FIELDS_LENGTH });
  return parts.join('');
}

/**
 * Appends `params` to `parts` in signing order: keys sorted, each key before
 * its value or nested fields. Each field's length is charged to `budget`
 * before anything is appended or sorted.
 */
function appendSortedParams(
  params: PlivoParams,
  parts: string[],
  compare: ((a: string, b: string) => number) | undefined,
  budget: { remaining: number },
): void {
  for (const key of Object.keys(params).sort(compare)) {
    const value = params[key];
    if (Array.isArray(value)) {
      let length = key.length * value.length;
      for (const item of value) length += item.length;
      chargeSignedLength(budget, length);
      for (const item of [...value].sort(compare)) parts.push(key, item);
    } else if (typeof value === 'object') {
      chargeSignedLength(budget, key.length);
      parts.push(key);
      appendSortedParams(value, parts, compare, budget);
    } else {
      chargeSignedLength(budget, key.length + value.length);
      parts.push(key, value);
    }
  }
}

/**
 * Takes `length` from `budget`, refusing the fields once it runs out. A length
 * that is not a number (a value that is not text) leaves the budget at NaN,
 * which also refuses, so the limit cannot be switched off.
 */
function chargeSignedLength(budget: { remaining: number }, length: number): void {
  budget.remaining -= length;
  if (!(budget.remaining >= 0)) {
    throw new RangeError(`Plivo callback fields sign to more than ${MAX_PLIVO_SIGNED_FIELDS_LENGTH} characters`);
  }
}

/**
 * Plivo's v3 webhook signature, computed as plivo-python
 * (`plivo/utils/signature_v3.py`) computes it by default: base64 of
 * HMAC-SHA256 with the auth token over `{base}.{nonce}`.
 *
 * - GET: `base` is the URL without its query, then `?` and the query as
 *   sorted `key=value` pairs when there is one.
 * - POST: `base` is the URL without its query; when the body has fields, `?`,
 *   the sorted query (and `.` when there is a query), then every field as
 *   `key` + `value` sorted by key. With no fields it is the GET form.
 *
 * @param method - The request method (GET or POST).
 * @param url - The full URL Plivo requested.
 * @param nonce - The `X-Plivo-Signature-V3-Nonce` header.
 * @param authToken - The (sub)account auth token.
 * @param params - The POST fields as text; ignored for GET. A JSON body's
 *   values must already be written in `style` (as the provider's verifier
 *   writes them).
 * @param style - Which SDK's text to build: how the query is decoded and how
 *   keys and repeated values are sorted (see {@link PlivoCanonicalStyle}).
 * @returns The base64 signature.
 * @throws RangeError when the fields sign to more than
 *   {@link MAX_PLIVO_SIGNED_FIELDS_LENGTH} characters.
 */
export function computePlivoV3Signature(
  method: string,
  url: string,
  nonce: string,
  authToken: string,
  params: PlivoParams = {},
  style: PlivoCanonicalStyle = 'python',
): string {
  const compare = comparatorFor(style);
  const { base, query } = splitPlivoUrl(url, style);
  const queryString = sortedQueryString(query, compare);
  let signed: string;
  if (method.toUpperCase() === 'GET' || Object.keys(params).length === 0) {
    signed = queryString ? `${base}?${queryString}` : base;
  } else {
    signed = `${base}?${queryString}${queryString ? '.' : ''}${sortedParamsString(params, compare)}`;
  }
  return createHmac('sha256', authToken).update(`${signed}.${nonce}`).digest('base64');
}

/** A callback's content: fields as text, or a JSON body before its values are written as text. */
type PlivoRequestContent = { fields: PlivoParams } | { json: PlivoJsonObject };

/**
 * A callback's content, read one way for both verification and events, so
 * no field reaches an event without being covered by the signature:
 *
 * - GET: the URL's query. The body is ignored, since the signature does
 *   not cover it.
 * - Otherwise the raw body: a JSON object when it parses as one, else
 *   URL-encoded fields (a body that only starts like JSON is read as a
 *   form, the same way the signature check reads it); `parsedBody` when
 *   the raw body is empty, read like a JSON body.
 *
 * @throws RangeError when a JSON body has a shape {@link parsePlivoJson} refuses.
 * @throws TypeError when `parsedBody` cannot be serialized as JSON.
 */
function readPlivoRequest(ctx: WebhookContext): PlivoRequestContent {
  if (ctx.method.toUpperCase() === 'GET') return { fields: splitPlivoUrl(ctx.url).query };
  const body = ctx.body.toString();
  if (!body.trim()) {
    if (!ctx.parsedBody) return { fields: {} };
    // A framework's parsed body is declared as strings but can carry numbers,
    // booleans, nulls, nested objects and arrays (express.json() returns
    // `any`), so it goes through the same reader and limits as a raw JSON
    // body. JSON.stringify throws on a circular or BigInt value; both callers
    // treat that as an unreadable body.
    const parsed = parsePlivoJson(JSON.stringify(ctx.parsedBody));
    return isPlivoJsonObject(parsed) ? { json: parsed } : { fields: {} };
  }
  if (body.trimStart().startsWith('{')) {
    let parsed: PlivoJsonValue | undefined;
    try {
      parsed = parsePlivoJson(body);
    } catch (error) {
      // Text that is not JSON is read as a form below; a refused JSON shape is not.
      if (error instanceof RangeError) throw error;
      parsed = undefined;
    }
    if (parsed !== undefined && isPlivoJsonObject(parsed)) return { json: parsed };
  }
  // fromEntries defines each key as an own property, so a field named
  // __proto__ is signed like any other instead of replacing the prototype.
  return {
    fields: Object.fromEntries(
      [...groupFormFields(body)].map(([key, values]): [string, PlivoParamValue] => [
        key,
        values.length === 1 ? values[0] : values,
      ]),
    ),
  };
}

/** The fields that decide which call event a callback produces. */
const PLIVO_EVENT_FIELDS = ['CallUUID', 'call_uuid', 'CallStatus', 'call_status', 'Digits'];

/**
 * The fields events are read from. For a JSON body only {@link PLIVO_EVENT_FIELDS}
 * holding a string, or an array of strings, count: the SDKs write a number,
 * boolean or null differently (`1.0` or `1`), so such a value has no single
 * signed text, and Plivo sends these fields as strings.
 */
function plivoEventFields(content: PlivoRequestContent): PlivoParams {
  if (!('json' in content)) return content.fields;
  const entries: Array<[string, PlivoParamValue]> = [];
  for (const name of PLIVO_EVENT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(content.json, name)) continue;
    const value = content.json[name];
    if (typeof value === 'string') {
      entries.push([name, value]);
    } else if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) {
      entries.push([name, value]);
    }
  }
  return Object.fromEntries(entries);
}

/**
 * A field's value when it has exactly one. The V3 signature sorts a repeated
 * field's values, so their order in the request is not signed, and a field
 * repeated with different values has no value to trust.
 *
 * @param fields - Fields from {@link plivoEventFields}.
 * @param name - The field name.
 * @returns The value, or undefined when the field is absent, nested or conflicting.
 */
function singlePlivoField(fields: PlivoParams, name: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(fields, name)) return undefined;
  const value = fields[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0 && value.every((item) => item === value[0])) return value[0];
  return undefined;
}

/** Whether a field that decides the event is repeated with different values. */
function hasConflictingPlivoEventField(fields: PlivoParams): boolean {
  return PLIVO_EVENT_FIELDS.some((name) => {
    const value = Object.prototype.hasOwnProperty.call(fields, name) ? fields[name] : undefined;
    return Array.isArray(value) && value.some((item) => item !== value[0]);
  });
}

/**
 * Deepest object nesting read from a JSON callback body. Plivo's callbacks
 * are flat or nearly so; a deeper body is refused while it is parsed.
 */
const MAX_PLIVO_JSON_DEPTH = 8;

/** A JSON number kept as its source text, so each SDK's way of writing it can be reproduced. */
class JsonNumberToken {
  constructor(readonly raw: string) {}
}

/** A JSON value that is not an array or object, numbers kept as source text. */
type JsonScalar = string | boolean | null | JsonNumberToken;

/** A JSON object as {@link parsePlivoJson} returns it. */
interface PlivoJsonObject {
  [key: string]: PlivoJsonValue;
}

/** A value {@link parsePlivoJson} returns: arrays hold only scalars. */
type PlivoJsonValue = JsonScalar | JsonScalar[] | PlivoJsonObject;

/** Whether a parsed value is a JSON object. */
function isPlivoJsonObject(value: PlivoJsonValue): value is PlivoJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof JsonNumberToken);
}

/** A JSON number token: optional minus, integer part, optional fraction and exponent. */
const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** JSON's literal names and their values. */
const JSON_LITERALS: Array<[string, boolean | null]> = [
  ['true', true],
  ['false', false],
  ['null', null],
];

/**
 * Parses JSON as JSON.parse does, with two differences: each number keeps
 * its source text (plivo-python signs `1.0` as `1.0`, which JSON.parse
 * cannot tell from `1`), and shapes no callback has are refused while they
 * are read: objects nested deeper than {@link MAX_PLIVO_JSON_DEPTH} and
 * arrays holding arrays or objects. Duplicate keys keep the last value, as
 * JSON.parse and Python's json.loads do, and a key named `__proto__` becomes
 * an own property. Work is linear in the text length.
 *
 * @param text - The request body.
 * @returns The parsed value.
 * @throws SyntaxError when the text is not JSON.
 * @throws RangeError when the JSON has a refused shape.
 */
function parsePlivoJson(text: string): PlivoJsonValue {
  let at = 0;

  function syntaxError(): SyntaxError {
    return new SyntaxError(`Invalid JSON at position ${at}`);
  }

  function skipSpace(): void {
    while (at < text.length) {
      const code = text.charCodeAt(at);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
      at++;
    }
  }

  function parseEscape(): string {
    const code = text.charCodeAt(at++);
    switch (code) {
      case 0x22: return '"';
      case 0x5c: return '\\';
      case 0x2f: return '/';
      case 0x62: return '\b';
      case 0x66: return '\f';
      case 0x6e: return '\n';
      case 0x72: return '\r';
      case 0x74: return '\t';
      case 0x75: {
        const hex = text.slice(at, at + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw syntaxError();
        at += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      default:
        throw syntaxError();
    }
  }

  function parseString(): string {
    at++; // the opening quote
    let out = '';
    let runStart = at;
    for (;;) {
      if (at >= text.length) throw syntaxError();
      const code = text.charCodeAt(at);
      if (code === 0x22) {
        out += text.slice(runStart, at);
        at++;
        return out;
      }
      if (code === 0x5c) {
        out += text.slice(runStart, at);
        at++;
        out += parseEscape();
        runStart = at;
      } else if (code < 0x20) {
        throw syntaxError();
      } else {
        at++;
      }
    }
  }

  function parseValue(depth: number): PlivoJsonValue {
    skipSpace();
    const code = text.charCodeAt(at);
    if (code === 0x7b) return parseObject(depth + 1);
    if (code === 0x5b) return parseArray();
    if (code === 0x22) return parseString();
    if (code === 0x2d || (code >= 0x30 && code <= 0x39)) {
      JSON_NUMBER.lastIndex = at;
      const match = JSON_NUMBER.exec(text);
      if (!match) throw syntaxError();
      at += match[0].length;
      return new JsonNumberToken(match[0]);
    }
    for (const [word, value] of JSON_LITERALS) {
      if (text.startsWith(word, at)) {
        at += word.length;
        return value;
      }
    }
    throw syntaxError();
  }

  function parseArray(): JsonScalar[] {
    at++; // [
    const items: JsonScalar[] = [];
    skipSpace();
    if (text.charCodeAt(at) === 0x5d) {
      at++;
      return items;
    }
    for (;;) {
      skipSpace();
      const code = text.charCodeAt(at);
      if (code === 0x5b || code === 0x7b) {
        throw new RangeError('Plivo callback JSON has an array holding an array or object');
      }
      items.push(parseValue(0) as JsonScalar);
      skipSpace();
      const separator = text.charCodeAt(at++);
      if (separator === 0x5d) return items;
      if (separator !== 0x2c) throw syntaxError();
    }
  }

  function parseObject(depth: number): PlivoJsonObject {
    if (depth > MAX_PLIVO_JSON_DEPTH) {
      throw new RangeError(`Plivo callback JSON nests deeper than ${MAX_PLIVO_JSON_DEPTH} levels`);
    }
    at++; // {
    // Collected in a Map and defined by fromEntries, so `__proto__` is an own key.
    const entries = new Map<string, PlivoJsonValue>();
    skipSpace();
    if (text.charCodeAt(at) === 0x7d) {
      at++;
      return {};
    }
    for (;;) {
      skipSpace();
      if (text.charCodeAt(at) !== 0x22) throw syntaxError();
      const key = parseString();
      skipSpace();
      if (text.charCodeAt(at++) !== 0x3a) throw syntaxError();
      entries.set(key, parseValue(depth));
      skipSpace();
      const separator = text.charCodeAt(at++);
      if (separator === 0x7d) return Object.fromEntries(entries);
      if (separator !== 0x2c) throw syntaxError();
    }
  }

  const value = parseValue(0);
  skipSpace();
  if (at !== text.length) throw syntaxError();
  return value;
}

/**
 * A finite float as Python's repr writes it: the shortest digits that read
 * back to the same value (the digits JavaScript's toExponential() gives), in
 * fixed notation with at least one fractional digit when the decimal point
 * sits from 4 places left of the first digit up to 16 places right of it,
 * otherwise as `d.ddde±XX`.
 *
 * @param value - The number.
 * @returns Python's repr of the float.
 */
export function pythonFloatRepr(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
  const sign = value < 0 ? '-' : '';
  const [mantissa, exponentText] = Math.abs(value).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const exponent = Number(exponentText);
  const pointAt = exponent + 1; // digits before the decimal point
  if (pointAt <= -4 || pointAt > 16) {
    const head = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const exponentSign = exponent < 0 ? '-' : '+';
    return `${sign}${head}e${exponentSign}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  if (pointAt <= 0) return `${sign}0.${'0'.repeat(-pointAt)}${digits}`;
  if (pointAt >= digits.length) return `${sign}${digits}${'0'.repeat(pointAt - digits.length)}.0`;
  return `${sign}${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
}

/**
 * A JSON number token as each style writes it. `'js'` prints the number
 * JSON.parse gives. `'python'` prints what json.loads gives: an int for a
 * token with no fraction or exponent, else a float. JSON integer tokens have
 * no leading zeros or plus sign, so the int's text is the token itself,
 * except `-0`, which json.loads reads as the int 0.
 */
function formatJsonNumber(raw: string, style: PlivoCanonicalStyle): string {
  if (style === 'js') return String(Number(raw));
  if (/^-?\d+$/.test(raw)) return raw === '-0' ? '0' : raw;
  return pythonFloatRepr(Number(raw));
}

/** A JSON scalar as signature text in the given style. */
function formatJsonScalar(value: JsonScalar, style: PlivoCanonicalStyle): string {
  if (value instanceof JsonNumberToken) return formatJsonNumber(value.raw, style);
  if (style === 'python') {
    if (value === true) return 'True';
    if (value === false) return 'False';
    if (value === null) return 'None';
  }
  return String(value);
}

/**
 * A parsed JSON body as signature fields: arrays and nested objects kept,
 * scalars written as text in the given style.
 *
 * @param object - The parsed body or a nested object in it.
 * @param style - How scalars are written.
 * @returns The fields.
 */
function toPlivoParams(object: PlivoJsonObject, style: PlivoCanonicalStyle): PlivoParams {
  return Object.fromEntries(
    Object.entries(object).map(([key, value]): [string, PlivoParamValue] => {
      if (Array.isArray(value)) return [key, value.map((item) => formatJsonScalar(item, style))];
      if (isPlivoJsonObject(value)) return [key, toPlivoParams(value, style)];
      return [key, formatJsonScalar(value, style)];
    }),
  );
}

/**
 * Compares a computed signature with a received one in constant time. A
 * length mismatch is a plain mismatch.
 */
function signaturesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Plivo voice call provider.
 *
 * Uses the Plivo REST API v1 for outbound call control and HMAC-SHA256
 * for inbound webhook signature verification (v3 signature scheme).
 *
 * @example
 * ```typescript
 * const provider = new PlivoVoiceProvider({
 *   authId:    process.env.PLIVO_AUTH_ID!,
 *   authToken: process.env.PLIVO_AUTH_TOKEN!,
 * });
 * ```
 */
export class PlivoVoiceProvider implements IVoiceCallProvider {
  /** Provider identifier, always `'plivo'`. */
  readonly name = 'plivo' as const;

  /** Immutable configuration snapshot. */
  private readonly config: PlivoVoiceProviderConfig;

  /** Base URL for the Plivo REST API v1. */
  private readonly baseUrl: string;

  /** Pre-computed `Authorization: Basic ...` header value. */
  private readonly authHeader: string;

  /** HTTP fetch implementation (injectable for testing). */
  private readonly fetch: typeof fetch;

  /**
   * @param config - Plivo credentials and optional overrides.
   */
  constructor(config: PlivoVoiceProviderConfig) {
    this.config = config;
    this.baseUrl = 'https://api.plivo.com/v1';
    // Plivo uses HTTP Basic auth with authId:authToken (similar to Twilio).
    this.authHeader =
      'Basic ' + Buffer.from(`${config.authId}:${config.authToken}`).toString('base64');
    this.fetch = config.fetchImpl ?? globalThis.fetch;
  }

  // ── Webhook ───────────────────────────────────────────────────────────────

  /**
   * Verify an incoming Plivo webhook request using HMAC-SHA256 (v3 scheme).
   *
   * Computes {@link computePlivoV3Signature} over the request's method, URL
   * and fields (read by {@link readPlivoRequest}, as `parseWebhookEvent`
   * reads them) in both SDKs' texts (see {@link PlivoCanonicalStyle}) and
   * compares each in constant time with every signature listed in
   * `X-Plivo-Signature-V3` and `X-Plivo-Signature-Ma-V3`.
   *
   * @param ctx - Raw webhook request context.
   * @returns Verification result with `valid: true` if a signature matches.
   */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    const nonce = ctx.headers['x-plivo-signature-v3-nonce'];
    const signatures = [ctx.headers['x-plivo-signature-v3'], ctx.headers['x-plivo-signature-ma-v3']];

    if (Array.isArray(nonce) || signatures.some((value) => Array.isArray(value))) {
      return { valid: false, error: 'Duplicate Plivo signature headers' };
    }
    const received = (signatures as Array<string | undefined>)
      .filter((value): value is string => Boolean(value))
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean);
    if (!nonce || received.length === 0) {
      return { valid: false, error: 'Missing Plivo signature headers' };
    }

    let expected: string[];
    try {
      const content = readPlivoRequest(ctx);
      // The signature sorts a repeated field's values, so it cannot tell
      // which one comes first. A request whose event fields repeat with
      // different values is refused instead of read in some order.
      if (hasConflictingPlivoEventField(plivoEventFields(content))) {
        return { valid: false, error: 'Conflicting repeated event fields' };
      }
      const isGet = ctx.method.toUpperCase() === 'GET';
      expected = [
        ...new Set(
          PLIVO_CANONICAL_STYLES.map((style) => {
            const params: PlivoParams = isGet ? {} : 'json' in content ? toPlivoParams(content.json, style) : content.fields;
            return computePlivoV3Signature(ctx.method, ctx.url, nonce, this.config.authToken, params, style);
          }),
        ),
      ];
    } catch {
      // A RangeError: parsePlivoJson refused the body's shape (objects nested
      // deeper than MAX_PLIVO_JSON_DEPTH, or an array holding an array or
      // object), or the fields sign to more than MAX_PLIVO_SIGNED_FIELDS_LENGTH.
      return { valid: false, error: 'Unreadable webhook body' };
    }
    const valid = received.some((candidate) => expected.some((signature) => signaturesMatch(signature, candidate)));
    return valid ? { valid } : { valid, error: 'Signature mismatch' };
  }

  /**
   * Parse a Plivo webhook into normalized {@link NormalizedCallEvent}s.
   *
   * Fields come from {@link readPlivoRequest} and {@link plivoEventFields},
   * as the signature check reads them: a GET callback's query, otherwise the
   * URL-encoded or JSON body.
   *
   * Plivo uses two naming conventions for the same fields:
   * - PascalCase (`CallUUID`, `CallStatus`, `Digits`) in URL callbacks.
   * - snake_case (`call_uuid`, `call_status`) in some API responses.
   * Both are checked for maximum compatibility.
   *
   * @param ctx - Raw webhook request context.
   * @returns Parsed result containing zero or more normalized events.
   */
  parseWebhookEvent(ctx: WebhookContext): WebhookParseResult {
    let fields: PlivoParams;
    try {
      fields = plivoEventFields(readPlivoRequest(ctx));
    } catch {
      // A JSON body refused by parsePlivoJson carries no usable event.
      return { events: [] };
    }
    const field = (name: string): string | undefined => singlePlivoField(fields, name);

    // Support both PascalCase and snake_case field naming conventions.
    const callUuid = field('CallUUID') ?? field('call_uuid') ?? '';
    const callStatus = field('CallStatus') ?? field('call_status') ?? '';
    const digits = field('Digits');

    const timestamp = Date.now();
    const events: NormalizedCallEvent[] = [];

    /** Helper: shared base fields with a unique event ID for idempotency. */
    const base = () => ({
      eventId: randomUUID(),
      providerCallId: callUuid,
      timestamp,
    });

    // Map Plivo CallStatus values to normalized event kinds.
    switch (callStatus) {
      case 'ringing':
        events.push({ ...base(), kind: 'call-ringing' });
        break;
      case 'in-progress':
        events.push({ ...base(), kind: 'call-answered' });
        break;
      case 'completed':
        events.push({ ...base(), kind: 'call-completed' });
        break;
      case 'busy':
        events.push({ ...base(), kind: 'call-busy' });
        break;
      case 'no-answer':
        events.push({ ...base(), kind: 'call-no-answer' });
        break;
      case 'failed':
        events.push({ ...base(), kind: 'call-failed' });
        break;
      default:
        // initiated / queued / etc. -- no normalized event emitted.
        break;
    }

    // DTMF digit input (from <GetDigits> XML element callback).
    if (digits != null && digits !== '') {
      events.push({ ...base(), kind: 'call-dtmf', digit: digits });
    }

    return { events };
  }

  // ── Call Control ──────────────────────────────────────────────────────────

  /**
   * Initiate an outbound call via the Plivo Call API.
   *
   * POSTs a JSON body to `/v1/Account/{authId}/Call/` with the caller, callee,
   * and answer URL. Returns the `request_uuid` as the provider call ID.
   *
   * @param input - Call initiation parameters (from/to numbers, webhook URL).
   * @returns Result containing the Plivo `request_uuid` on success.
   * @throws Never throws; returns `{ success: false, error: '...' }` on failure.
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const url = `${this.baseUrl}/Account/${this.config.authId}/Call/`;

    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: input.fromNumber,
        to: input.toNumber,
        answer_url: input.webhookUrl,
        answer_method: 'POST',
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => String(response.status));
      return { providerCallId: '', success: false, error: `Plivo error ${response.status}: ${text}` };
    }

    const data = (await response.json()) as { request_uuid: string };
    return { providerCallId: data.request_uuid, success: true };
  }

  /**
   * Hang up an active call using the Plivo Call DELETE endpoint.
   *
   * Plivo uses HTTP `DELETE` to terminate a call (unlike Twilio's POST with
   * `Status=completed` or Telnyx's POST to `/actions/hangup`). This is a
   * RESTful convention where deleting the call resource ends the call.
   *
   * @param input - Contains the Plivo `call_uuid` to hang up.
   */
  async hangupCall(input: HangupCallInput): Promise<void> {
    const url = `${this.baseUrl}/Account/${this.config.authId}/Call/${input.providerCallId}/`;

    await this.fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: this.authHeader,
      },
    });
  }

  /**
   * Speak text into a live call using the Plivo Speak API.
   *
   * POSTs a JSON body to `/v1/Account/{authId}/Call/{callUuid}/Speak/`
   * with the text, voice (default `'WOMAN'`), and language (default `'en-US'`).
   *
   * @param input - TTS parameters (text, optional voice, call ID).
   */
  async playTts(input: PlayTtsInput): Promise<void> {
    const url = `${this.baseUrl}/Account/${this.config.authId}/Call/${input.providerCallId}/Speak/`;

    await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: input.text,
        voice: input.voice ?? 'WOMAN',
        language: 'en-US',
      }),
    });
  }
}
