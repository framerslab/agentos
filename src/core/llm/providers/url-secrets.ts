/**
 * @module core/llm/providers/url-secrets
 *
 * Masks the secrets a provider request carries out of error text. fetch
 * (undici) names secrets in three rejection messages:
 *
 * - `Failed to parse URL from <url>` for a base URL it cannot parse,
 * - `Request cannot be constructed from a URL that includes credentials: <url>`
 *   for a base URL with `user:password@`,
 * - `Headers.append: "<value>" is an invalid header value.` for a header
 *   value it rejects, which quotes an API key sent in a header.
 *
 * Providers and `embedText` pass every such message through
 * {@link redactUrlSecrets} before it reaches an error, a log line or a span.
 * This module has no imports, so any layer can use it without a cycle.
 */

/**
 * The credentials part of a base URL, read from the raw string: the text
 * between the authority start (after a leading `scheme://` or `//`, else the
 * start of a scheme-less URL) and the last `@`. The last `@` is used because
 * an email-style username carries its own `@`, and the raw string because a
 * URL that fails to parse (for example with a `/` in the password) still
 * appears verbatim in fetch's error.
 *
 * @param baseUrl Configured base URL.
 * @returns The credentials substring, or undefined when there is none.
 */
export function baseUrlCredentials(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  // Only a leading scheme or `//` opens the authority; a `//` later in the
  // path must not move the start past the credentials.
  const scheme = /^[a-z][a-z\d+.-]*:\/\//i.exec(baseUrl);
  const start = scheme ? scheme[0].length : baseUrl.startsWith('//') ? 2 : 0;
  const at = baseUrl.lastIndexOf('@');
  return at > start ? baseUrl.slice(start, at) : undefined;
}

/**
 * Masks the secrets a request carries out of a message: any credentials in
 * the base URL and each known secret (API keys, whether they travel in the
 * URL or in a header). The known values are replaced literally, since a
 * pattern cannot tell where arbitrary credentials end.
 *
 * @param message Text that may contain the request URL or a header value.
 * @param baseUrl Configured base URL.
 * @param knownSecrets Other secrets the request carried, such as API keys.
 *   Empty and undefined entries are ignored.
 * @returns The message with those secrets replaced by `[redacted]`.
 */
export function redactUrlSecrets(
  message: string,
  baseUrl: string | undefined,
  knownSecrets: ReadonlyArray<string | undefined> = [],
): string {
  // Longest first, so a key that also appears inside the credentials cannot
  // split them before the whole credentials string is replaced.
  const secrets = [baseUrlCredentials(baseUrl), ...knownSecrets]
    .filter((secret): secret is string => Boolean(secret))
    .sort((a, b) => b.length - a.length);
  let out = message;
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  // Backstops for any other key= value or //user:password@ credentials.
  return out
    .replace(/([?&]key=)[^&\s"')]+/g, '$1[redacted]')
    .replace(/(\/\/)[^/\s@"')]+@/g, '$1[redacted]@');
}

/** Options for {@link redactUrlForExport}. */
export interface RedactUrlForExportOptions {
  /** The URL belongs to a `...webhookUrl` property: keep the origin, replace the path and the query. */
  webhook?: boolean;
  /** The export's property-name rule; a query or fragment parameter whose name matches is a secret. */
  isSecretParam?: (name: string) => boolean;
}

const URL_SECRET_PARAM_NAMES = new Set(['key', 'sig', 'signature', 'auth', 'password']);
const EXPORT_PLACEHOLDER = '<<REDACTED>>';

/**
 * Rewrites a URL for a config export without re-serializing it: the userinfo
 * becomes `<<REDACTED>>@`; the value of every query or fragment parameter
 * whose name is a secret (the export's property rule, or `key`, `sig`,
 * `signature`, `auth`, `password`) becomes `<<REDACTED>>`; a webhook URL keeps
 * its origin and has its path and query replaced (its secret fragment
 * parameters too), except when it has no path and no query. A URL with nothing to remove comes back byte for byte. The
 * placeholder is spliced in literally, so import can find it again.
 *
 * @param url The URL string found in the config.
 * @param opts Whether it is a webhook URL, and the parameter-name rule.
 * @returns The URL with its secrets replaced by `<<REDACTED>>`.
 */
export function redactUrlForExport(url: string, opts: RedactUrlForExportOptions = {}): string {
  const scheme = /^[a-z][a-z\d+.-]*:\/\//i.exec(url);
  if (!scheme) return url;
  const authorityStart = scheme[0].length;
  const pathStart = (() => {
    const i = url.slice(authorityStart).search(/[/?#]/);
    return i === -1 ? url.length : authorityStart + i;
  })();
  let authority = url.slice(authorityStart, pathStart);
  const at = authority.lastIndexOf('@');
  if (at !== -1) authority = `${EXPORT_PLACEHOLDER}@${authority.slice(at + 1)}`;
  const origin = url.slice(0, authorityStart) + authority;
  const rest = url.slice(pathStart);
  const isSecret = (name: string): boolean =>
    URL_SECRET_PARAM_NAMES.has(name.toLowerCase()) || (opts.isSecretParam?.(name) ?? false);
  const redactParams = (params: string): string =>
    params
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq === -1) return pair;
        const name = pair.slice(0, eq);
        return isSecret(name) ? `${name}=${EXPORT_PLACEHOLDER}` : pair;
      })
      .join('&');
  const hash = rest.indexOf('#');
  if (opts.webhook) {
    if (rest === '' || rest === '/') return origin + rest;
    // The path and the query carry the webhook's secret; secret fragment
    // parameters are replaced as on any other URL.
    return `${origin}/${EXPORT_PLACEHOLDER}${hash === -1 ? '' : `#${redactParams(rest.slice(hash + 1))}`}`;
  }
  const beforeHash = hash === -1 ? rest : rest.slice(0, hash);
  const fragment = hash === -1 ? '' : rest.slice(hash + 1);
  const q = beforeHash.indexOf('?');
  const path = q === -1 ? beforeHash : beforeHash.slice(0, q);
  const query = q === -1 ? '' : beforeHash.slice(q + 1);
  return (
    origin +
    path +
    (q === -1 ? '' : `?${redactParams(query)}`) +
    (hash === -1 ? '' : `#${redactParams(fragment)}`)
  );
}
