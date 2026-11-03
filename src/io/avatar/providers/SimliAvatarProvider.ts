/**
 * @module io/avatar/providers/SimliAvatarProvider
 *
 * Simli realtime-avatar provider — control plane. Mints Compose sessions
 * (`POST /compose/token`), resolves ICE servers (`GET /compose/ice`), and
 * builds Trinity faces from a portrait (`POST /faces/trinity`, polled with
 * `GET /faces/trinity/generation_status`).
 * Media is joined per {@link AvatarMediaMode}: hand the returned
 * {@link AvatarSessionHandle} to the browser SDK (client-delegated), or to
 * `createSimliServerSession()` for the Node-owned WebRTC path.
 *
 * Contract (verified 2026-07-08 against the Compose REST + AsyncAPI docs):
 * auth header `x-simli-api-key`; token body `{ faceId, apiVersion: 'v2',
 * handleSilence, maxSessionLength, maxIdleTime, audioInputFormat: 'pcm16' }`;
 * the upstream sample rate is NOT publicly pinned — 16000 Hz is the
 * SDK-observed default, carried as config-overridable data.
 *
 * Face contract (verified 2026-11-02 against
 * https://docs.simli.com/api-reference/generate-trinity-face,
 * https://docs.simli.com/api-reference/check-trinity-generation-status and
 * https://api.simli.ai/openapi.yaml): the upload is multipart with the
 * required field `image`, query `face_name` and `gsVersion` (`GSA_2.0` by
 * default), and an optional `target-ratio` header from
 * `POST /faces/trinity/preprocess`; it answers `{ message, face_id, warnings,
 * dispatch_after? }`, `dispatch_after` in Unix seconds. The status read
 * answers `{ status, queue_position, face_id?, generations[] }` with status
 * `not_found | pending | processing | completed | failed`; completed and
 * failed builds stay listed for 24 hours.
 */

import { AvatarProviderError } from '../errors.js';
import type {
  AvatarFaceCreateOptions,
  AvatarFaceImage,
  AvatarFaceJob,
  AvatarFaceState,
  AvatarFaceStatus,
  AvatarFaceStatusOptions,
  AvatarIceServer,
  AvatarSessionConfig,
  AvatarSessionHandle,
  IAvatarProvider,
} from '../types.js';

/** Per-request control-plane timeout (session minting must be snappy). */
const CONTROL_PLANE_TIMEOUT_MS = 10_000;

/**
 * Default deadline for a face upload. Simli frames an image that has not been
 * through `POST /faces/trinity/preprocess` before it answers, which its docs
 * put at about 25 seconds, and an abort after Simli has accepted the build
 * leaves that build queued with no face id on the caller's side, holding one
 * of the account's generations. The deadline stays well past the framing
 * time.
 */
const FACE_UPLOAD_TIMEOUT_MS = 120_000;

/** How much of an error body an {@link AvatarProviderError} keeps. */
const ERROR_BODY_LIMIT = 2_000;

/** File extensions for the image types the face upload names. */
const FACE_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Simli's status words, as the provider-neutral states. */
const FACE_STATES: Readonly<Record<string, AvatarFaceState>> = {
  not_found: 'not_found',
  pending: 'pending',
  processing: 'processing',
  completed: 'ready',
  failed: 'failed',
};

/** One build as `GET /faces/trinity/generation_status` reports it. */
interface SimliGeneration {
  face_id?: unknown;
  status?: unknown;
  queue_position?: unknown;
  dispatch_after?: unknown;
}

/** Configuration for the Simli avatar provider. */
export interface SimliAvatarProviderConfig {
  /** Simli API key. */
  apiKey: string;
  /** Base URL for the Simli API. @default 'https://api.simli.ai' */
  baseUrl?: string;
  /** Upstream pcm16 sample rate (Hz). @default 16000 */
  sampleRate?: number;
}

/**
 * Control-plane implementation of {@link IAvatarProvider} for Simli.
 */
export class SimliAvatarProvider implements IAvatarProvider {
  readonly providerId = 'simli';
  readonly capabilities: IAvatarProvider['capabilities'];

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly sampleRate: number;

  constructor(config: SimliAvatarProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.simli.ai';
    this.sampleRate = config.sampleRate ?? 16000;
    this.capabilities = {
      mediaModes: ['client-delegated', 'server-driven'],
      audioFormat: 'pcm16',
      sampleRate: this.sampleRate,
    };
  }

  /**
   * Mint a Compose session token and resolve ICE, returning the complete
   * media-join handle.
   */
  async createSession(config: AvatarSessionConfig): Promise<AvatarSessionHandle> {
    const res = await fetch(`${this.baseUrl}/compose/token`, {
      method: 'POST',
      headers: {
        'x-simli-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        faceId: config.faceId,
        apiVersion: 'v2',
        handleSilence: true,
        audioInputFormat: 'pcm16',
        ...(config.maxSessionLengthSec != null
          ? { maxSessionLength: config.maxSessionLengthSec }
          : {}),
        ...(config.maxIdleTimeSec != null ? { maxIdleTime: config.maxIdleTimeSec } : {}),
        ...(config.providerOptions ?? {}),
      }),
      signal: AbortSignal.timeout(CONTROL_PLANE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Simli session mint failed: ${res.status} ${detail.slice(0, 200)}`);
    }
    const payload = (await res.json()) as { session_token?: string };
    if (!payload.session_token) {
      throw new Error('Simli session mint returned no session_token');
    }
    return {
      sessionToken: payload.session_token,
      iceServers: await this.getIceServers(),
      audioFormat: 'pcm16',
      sampleRate: this.sampleRate,
    };
  }

  /** Fetch ICE servers (`GET /compose/ice`). */
  async getIceServers(): Promise<AvatarIceServer[]> {
    const res = await fetch(`${this.baseUrl}/compose/ice`, {
      headers: { 'x-simli-api-key': this.apiKey },
      signal: AbortSignal.timeout(CONTROL_PLANE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Simli ICE fetch failed: ${res.status} ${detail.slice(0, 200)}`);
    }
    const payload = (await res.json()) as Array<{
      urls: string | string[];
      username?: string;
      credential?: string;
    }>;
    return payload.map((s) => ({
      urls: s.urls,
      ...(s.username != null ? { username: s.username } : {}),
      ...(s.credential != null ? { credential: s.credential } : {}),
    }));
  }

  /**
   * Upload a portrait to build a Trinity face (`POST /faces/trinity`).
   * Resolves once Simli has accepted the build; poll
   * {@link SimliAvatarProvider.faceStatus} with the returned id until it reads
   * `ready`, then mint sessions for it.
   *
   * Without `providerOptions.targetRatio`, Simli frames the image itself
   * first, which adds about 25 seconds to this call.
   *
   * @throws {AvatarProviderError} on an HTTP error status: 403 when the
   *   account has no avatars left for the `gsVersion`, 422 when Simli cannot
   *   take the request.
   */
  async createFace(
    image: AvatarFaceImage,
    options: AvatarFaceCreateOptions = {}
  ): Promise<AvatarFaceJob> {
    const { targetRatio, ...queryOptions } = options.providerOptions ?? {};
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(queryOptions)) {
      if (value != null) query[key] = String(value);
    }
    if (options.name != null) query.face_name = options.name;

    const headers: Record<string, string> = { 'x-simli-api-key': this.apiKey };
    if (targetRatio != null) headers['target-ratio'] = String(targetRatio);

    const part = await faceImagePart(image);
    const form = new FormData();
    form.append('image', part.blob, part.filename);

    const signal = deadline(options.signal, options.timeoutMs ?? FACE_UPLOAD_TIMEOUT_MS);
    const res = await fetch(`${this.baseUrl}/faces/trinity${queryString(query)}`, {
      method: 'POST',
      headers,
      body: form,
      signal,
    });
    if (!res.ok) throw await simliError('face upload', res, signal);

    const payload = (await res.json()) as {
      message?: unknown;
      face_id?: unknown;
      warnings?: unknown;
      dispatch_after?: unknown;
    };
    if (typeof payload.face_id !== 'string' || payload.face_id.length === 0) {
      throw new Error('Simli face upload returned no face_id');
    }
    const startAfterMs = unixSecondsToMs(payload.dispatch_after);
    return {
      faceId: payload.face_id,
      ...(typeof payload.message === 'string' ? { message: payload.message } : {}),
      warnings: Array.isArray(payload.warnings)
        ? payload.warnings.filter((w): w is string => typeof w === 'string')
        : [],
      ...(startAfterMs != null ? { startAfterMs } : {}),
      raw: payload,
    };
  }

  /**
   * Read where one face build stands
   * (`GET /faces/trinity/generation_status?face_id=`). Simli's `completed`
   * reads as `ready`. Simli lists completed and failed builds for 24 hours, so
   * a face built longer ago reads `not_found`: record `ready` when you see it.
   *
   * @throws {AvatarProviderError} on an HTTP error status.
   */
  async faceStatus(
    faceId: string,
    options: AvatarFaceStatusOptions = {}
  ): Promise<AvatarFaceStatus> {
    const signal = deadline(options.signal, options.timeoutMs ?? CONTROL_PLANE_TIMEOUT_MS);
    const res = await fetch(
      `${this.baseUrl}/faces/trinity/generation_status${queryString({ face_id: faceId })}`,
      { headers: { 'x-simli-api-key': this.apiKey }, signal }
    );
    if (!res.ok) throw await simliError('face status read', res, signal);

    const payload = (await res.json()) as SimliGeneration & { generations?: unknown };
    // `generations` lists each tracked build; the top-level fields describe the
    // most recent one, which is the asked-for build when it echoes its id. With
    // other builds listed and no id at the top level, those fields could be
    // any of them, so they are not read as this face's.
    const generations = Array.isArray(payload.generations)
      ? (payload.generations as SimliGeneration[])
      : [];
    const listed = generations.find((g) => g?.face_id === faceId);
    const topLevelIsThisFace =
      payload.face_id === faceId || (payload.face_id === undefined && generations.length === 0);
    const build = listed ?? (topLevelIsThisFace ? payload : undefined);

    if (!build) return { faceId, state: 'not_found', raw: payload };

    const providerState = typeof build.status === 'string' ? build.status : undefined;
    const queuePosition =
      typeof build.queue_position === 'number' && build.queue_position >= 0
        ? build.queue_position
        : undefined;
    const startAfterMs = unixSecondsToMs(build.dispatch_after);
    return {
      faceId,
      // A word outside the documented five is a build Simli still reports on.
      state: providerState != null ? (FACE_STATES[providerState] ?? 'processing') : 'not_found',
      ...(providerState != null ? { providerState } : {}),
      ...(queuePosition != null ? { queuePosition } : {}),
      ...(startAfterMs != null ? { startAfterMs } : {}),
      raw: payload,
    };
  }
}

/**
 * Whether a value is a Blob, from this realm or another (an iframe, jsdom, a
 * vm context), where `instanceof Blob` is false. Typed arrays never count.
 */
function isBlobLike(value: unknown): value is Blob {
  if (value instanceof Blob) return true;
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) return false;
  const candidate = value as Partial<Blob>;
  return (
    typeof candidate.arrayBuffer === 'function' &&
    typeof candidate.size === 'number' &&
    typeof candidate.type === 'string'
  );
}

/** The image as the multipart part the face upload sends. */
async function faceImagePart(image: AvatarFaceImage): Promise<{ blob: Blob; filename: string }> {
  const { data } = image;
  const ownType = isBlobLike(data) && data.type ? data.type : undefined;
  const mimeType = image.mimeType ?? ownType ?? 'image/png';
  let blob: Blob;
  if (data instanceof Blob) {
    blob = data.type === mimeType ? data : new Blob([data], { type: mimeType });
  } else if (isBlobLike(data)) {
    // Another realm's Blob is no BlobPart here: copy its bytes out.
    blob = new Blob([await data.arrayBuffer()], { type: mimeType });
  } else {
    // A copy in an ArrayBuffer of its own: a view over a SharedArrayBuffer is
    // not a BlobPart. ArrayBuffer.isView holds across realms, where
    // instanceof does not.
    const view = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    const bytes = new ArrayBuffer(view.byteLength);
    new Uint8Array(bytes).set(view);
    blob = new Blob([bytes], { type: mimeType });
  }
  const extension = FACE_IMAGE_EXTENSIONS[mimeType];
  return { blob, filename: image.filename ?? (extension ? `face.${extension}` : 'face') };
}

/** `?k=v&…` with each part percent-encoded, or '' when there is none. */
function queryString(params: Record<string, string>): string {
  const pairs = Object.entries(params).map(
    ([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
  );
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

/** The caller's signal, if any, bounded by a deadline of its own. */
function deadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Unix seconds as epoch milliseconds, or undefined for anything else. */
function unixSecondsToMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : undefined;
}

/** Whether an error is an abort or a deadline passing. */
function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * The first {@link ERROR_BODY_LIMIT} characters of a response body. Reads only
 * as far as that and cancels the rest. A body that breaks off keeps what
 * arrived; an abort or a deadline passing during the read rejects with it.
 */
async function readErrorBody(res: Response, signal: AbortSignal): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < ERROR_BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    if (isAbortError(error)) throw error;
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return text.slice(0, ERROR_BODY_LIMIT);
}

/** The error for a Simli response with an HTTP error status. */
async function simliError(
  operation: string,
  res: Response,
  signal: AbortSignal
): Promise<AvatarProviderError> {
  const body = await readErrorBody(res, signal);
  return new AvatarProviderError(`Simli ${operation} failed: ${res.status} ${body.slice(0, 200)}`, {
    providerId: 'simli',
    status: res.status,
    body,
  });
}
