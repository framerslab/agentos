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
