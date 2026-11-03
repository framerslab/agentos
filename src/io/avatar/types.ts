/**
 * @module io/avatar/types
 *
 * Provider-agnostic REALTIME avatar seam: control-plane session minting plus
 * media-mode contracts. Distinct from the 2D avatar GEN pipeline in
 * `io/media/avatar` (image generation) — that produces portraits; this
 * animates a live, lip-synced talking head.
 *
 * Media modes:
 * - `client-delegated` — the host hands an {@link AvatarSessionHandle} to a
 *   browser SDK which owns the peer connection (the typical web-app path).
 *   Node never touches WebRTC; no native deps involved.
 * - `server-driven` — Node owns the WebRTC peer via the optional `wrtc`
 *   native dependency (dynamically imported by the session helper, mirroring
 *   `createWebRTCTransport()`), signals over the provider's WebSocket, and
 *   streams audio server-side.
 *
 * A provider that can build a face from a portrait also implements
 * {@link IAvatarProvider.createFace} and {@link IAvatarProvider.faceStatus};
 * the face id a finished build yields is the `faceId` a session is minted for.
 */

/** How the media plane is owned for an avatar session. */
export type AvatarMediaMode = 'client-delegated' | 'server-driven';

/** One ICE server entry as handed to an RTCPeerConnection. */
export interface AvatarIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Configuration for minting one avatar session. */
export interface AvatarSessionConfig {
  /** Provider-specific face/persona id (Simli: `faceId`): an existing face,
   *  or one built with {@link IAvatarProvider.createFace} once
   *  {@link IAvatarProvider.faceStatus} reads it `ready`. */
  faceId: string;
  /** Hard session cap in seconds. Provider default applies when omitted
   *  (Simli: 3600). */
  maxSessionLengthSec?: number;
  /** Idle timeout in seconds. Provider default applies when omitted
   *  (Simli: 300). */
  maxIdleTimeSec?: number;
  /** Pass-through options forwarded verbatim to the provider API. */
  providerOptions?: Record<string, unknown>;
}

/**
 * Everything a media-plane consumer needs to join the avatar session.
 * Client-delegated consumers forward this to the browser SDK; server-driven
 * consumers feed it to the provider's server-session helper.
 */
export interface AvatarSessionHandle {
  /** Opaque session token the media plane authenticates with. */
  sessionToken: string;
  /** ICE servers for the peer connection. */
  iceServers: AvatarIceServer[];
  /** Upstream audio encoding the avatar lip-syncs to. */
  audioFormat: 'pcm16';
  /**
   * Upstream audio sample rate (Hz). Simli's default is 16000 —
   * config-overridable, and deliberately carried as data rather than a type
   * constant because the vendor spec does not publicly pin it.
   */
  sampleRate: number;
}

/**
 * A portrait to build an avatar face from. The bytes go to the provider as
 * given: resizing, cropping and transcoding to what the vendor takes are the
 * caller's.
 */
export interface AvatarFaceImage {
  /** The image bytes. A Node `Buffer` is a `Uint8Array` and is taken as is;
   *  a Blob from another realm (an iframe, jsdom) is read through its
   *  `arrayBuffer()`. */
  data: Uint8Array | ArrayBuffer | Blob;
  /** The image's MIME type. Defaults to the Blob's own type, else
   *  `'image/png'`. */
  mimeType?: string;
  /** The file name the upload carries. Defaults to `face.<extension>` for
   *  PNG, JPEG and WebP, else `face`. */
  filename?: string;
}

/** Options for {@link IAvatarProvider.createFace}. */
export interface AvatarFaceCreateOptions {
  /** A name the provider stores with the face (Simli: `face_name`, whose
   *  default is `untitled_avatar`). */
  name?: string;
  /** Aborts the upload. Combined with the upload's own deadline. An abort
   *  while an error response's body is read rejects with the abort, not an
   *  `AvatarProviderError`. */
  signal?: AbortSignal;
  /** Upload deadline in milliseconds. Provider default applies when omitted
   *  (Simli: 120000). */
  timeoutMs?: number;
  /**
   * Provider-specific options. Simli sends `targetRatio` as the
   * `target-ratio` header and every other key as a query parameter, such as
   * `gsVersion` (`'GSA_2.0'`, its default, or `'GSA_1.0'`).
   */
  providerOptions?: Record<string, unknown>;
}

/** Options for {@link IAvatarProvider.faceStatus}. */
export interface AvatarFaceStatusOptions {
  /** Aborts the request. Combined with the request's own deadline. */
  signal?: AbortSignal;
  /** Request deadline in milliseconds. Provider default applies when omitted
   *  (Simli: 10000). */
  timeoutMs?: number;
}

/**
 * Where one face build stands: queued (`pending`), being built
 * (`processing`), built and usable as a session's `faceId` (`ready`),
 * `failed`, or unknown to the provider (`not_found`).
 */
export type AvatarFaceState = 'pending' | 'processing' | 'ready' | 'failed' | 'not_found';

/** A face build the provider accepted. */
export interface AvatarFaceJob {
  /** The new face's id: poll {@link IAvatarProvider.faceStatus} with it, and
   *  mint sessions for it once it reads `ready`. */
  faceId: string;
  /** The provider's message (Simli: the build's place in the queue, and how
   *  long it is held, if it is). */
  message?: string;
  /** Advisory notes about the image. The build goes ahead. */
  warnings: string[];
  /** When the provider holds the build before it starts: the time it may
   *  start, in epoch milliseconds. Absent otherwise. */
  startAfterMs?: number;
  /** The provider's response body as returned. */
  raw: unknown;
}

/** One face build's status. */
export interface AvatarFaceStatus {
  /** The face id asked about. */
  faceId: string;
  /** Where the build stands. */
  state: AvatarFaceState;
  /** The provider's own word for the state (Simli: `completed` for
   *  `ready`). Absent when the response names none. */
  providerState?: string;
  /** Place in the provider's queue, 0 once the build is being worked on.
   *  Absent when the provider reports none. */
  queuePosition?: number;
  /** When the provider holds a queued build: the time it may start, in epoch
   *  milliseconds. Absent otherwise. */
  startAfterMs?: number;
  /** The provider's response body as returned. */
  raw: unknown;
}

/**
 * A realtime-avatar provider: mints sessions and exposes the audio contract.
 * Control-plane-first — media ownership is chosen per session by which
 * consumer the handle is given to.
 */
export interface IAvatarProvider {
  /** Unique, stable identifier for this provider (e.g. 'simli'). */
  readonly providerId: string;
  /** What the provider supports and the audio contract it expects. */
  readonly capabilities: {
    mediaModes: AvatarMediaMode[];
    audioFormat: 'pcm16';
    sampleRate: number;
  };
  /** Mint a session (control plane only — no media is opened here). */
  createSession(config: AvatarSessionConfig): Promise<AvatarSessionHandle>;
  /** Fetch ICE servers for the peer connection. */
  getIceServers(): Promise<AvatarIceServer[]>;
  /**
   * Build a new face from a portrait. Resolves once the provider has accepted
   * the build, before the face is ready: poll {@link IAvatarProvider.faceStatus} with the
   * returned id. Implemented by providers that build faces (Simli does);
   * check for the method before calling it.
   *
   * @throws {AvatarProviderError} when the vendor answers with an HTTP error
   *   status (Simli: 403 when the account has no avatars left, 422 for an
   *   image it cannot take).
   */
  createFace?(image: AvatarFaceImage, options?: AvatarFaceCreateOptions): Promise<AvatarFaceJob>;
  /**
   * Read where one face build stands. Implemented together with
   * {@link IAvatarProvider.createFace}.
   *
   * @throws {AvatarProviderError} when the vendor answers with an HTTP error
   *   status.
   */
  faceStatus?(faceId: string, options?: AvatarFaceStatusOptions): Promise<AvatarFaceStatus>;
}
