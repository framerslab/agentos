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
  /** Provider-specific face/persona id (Simli: `faceId`). */
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
}
