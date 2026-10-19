/**
 * @module core/llm/providers/stream-error-body
 *
 * The error body of a request sent through axios with `responseType:
 * 'stream'`. axios rejects a non-2xx answer to such a request with the live
 * response stream as `error.response.data` (lib/adapters/http.js in axios
 * 1.20.0 sets `response.data` to the stream before it settles). That stream's
 * `req` holds the request head with the Authorization header, and the
 * response and its request refer to each other, so serializing the stream
 * throws and keeping it keeps the credential. These helpers read a bounded
 * prefix of the body as text, release the stream, and parse what was read;
 * OpenRouter's and Requesty's streamed requests share them. This module has
 * no imports, so any provider can use it without a cycle.
 */

/** Longest streamed error body read into an error, in bytes. */
export const MAX_STREAM_ERROR_BODY_BYTES = 8192;

/** How long reading a streamed error body may take, in milliseconds. */
export const STREAM_ERROR_BODY_TIMEOUT_MS = 2000;

/** Whether a value is a Node readable stream, as axios returns for `responseType: 'stream'`. */
export function isReadableStream(value: unknown): value is NodeJS.ReadableStream & { destroy?: () => void } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { pipe?: unknown }).pipe === 'function' &&
    typeof (value as { on?: unknown }).on === 'function'
  );
}

/**
 * Reads up to {@link MAX_STREAM_ERROR_BODY_BYTES} of a streamed error body as
 * UTF-8 text, waiting at most {@link STREAM_ERROR_BODY_TIMEOUT_MS}, then
 * destroys the stream so its socket is released.
 *
 * @param stream - The error response body axios returned as a stream.
 * @returns The text read, possibly empty, and whether it is the whole body
 *   (false when the size limit, the timeout or a stream error cut it short).
 */
export async function readErrorStream(
  stream: NodeJS.ReadableStream & { destroy?: () => void },
): Promise<{ text: string; complete: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let ended = false;
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, STREAM_ERROR_BODY_TIMEOUT_MS);
      function finish(): void {
        clearTimeout(timer);
        stream.removeListener('data', onData);
        stream.removeListener('end', onEnd);
        stream.removeListener('error', finish);
        resolve();
      }
      function onEnd(): void {
        ended = true;
        finish();
      }
      function onData(chunk: Buffer | string): void {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        chunks.push(bytes);
        size += bytes.length;
        if (size >= MAX_STREAM_ERROR_BODY_BYTES) finish();
      }
      stream.on('data', onData);
      stream.once('end', onEnd);
      stream.once('error', finish);
    });
  } finally {
    stream.destroy?.();
  }
  return {
    text: Buffer.concat(chunks).subarray(0, MAX_STREAM_ERROR_BODY_BYTES).toString('utf8'),
    complete: ended && size <= MAX_STREAM_ERROR_BODY_BYTES,
  };
}

/** An error body read as text: the parsed JSON object when it is one, else the text. */
export function parseErrorBody(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : text;
  } catch {
    return text;
  }
}

/**
 * Masks the end of a text that was cut short when that end is the start of
 * one of the given secrets. Masking that matches whole secrets cannot see a
 * key split by the cut, which would otherwise show all but its last
 * characters.
 *
 * @param text - Text cut at a size limit or a timeout.
 * @param secrets - The configured secrets (API keys, base-URL credentials).
 * @returns The text with any such tail replaced by `[redacted]`.
 */
export function maskCutSecretTail(text: string, secrets: readonly string[]): string {
  let cut = 0;
  for (const secret of secrets) {
    for (let length = Math.min(secret.length - 1, text.length); length > cut; length--) {
      if (text.endsWith(secret.slice(0, length))) {
        cut = length;
        break;
      }
    }
  }
  return cut > 0 ? `${text.slice(0, text.length - cut)}[redacted]` : text;
}
