/**
 * @module io/avatar/errors
 *
 * The error an avatar provider raises when its vendor answers a request with
 * an HTTP error status.
 */

/** What an {@link AvatarProviderError} records about the failed request. */
export interface AvatarProviderErrorInit {
  /** The provider that made the request (e.g. 'simli'). */
  providerId: string;
  /** The HTTP status the vendor answered with. */
  status: number;
  /** The response body as text, cut to its first 2000 characters. */
  body: string;
}

/**
 * A vendor answered an avatar request with an HTTP error status. The status
 * and the body let a caller tell a capacity refusal (Simli: 403 when the
 * account has no avatars left) from a request the vendor could not accept
 * (422), and retry only the first.
 */
export class AvatarProviderError extends Error {
  /** The provider that made the request. */
  readonly providerId: string;
  /** The HTTP status the vendor answered with. */
  readonly status: number;
  /** The response body as text, cut to its first 2000 characters. The rest
   *  of the response is not read. */
  readonly body: string;

  constructor(message: string, init: AvatarProviderErrorInit) {
    super(message);
    this.name = 'AvatarProviderError';
    this.providerId = init.providerId;
    this.status = init.status;
    this.body = init.body;
  }
}
