/**
 * @module io/avatar/providers/SimliAvatarProvider
 *
 * Simli realtime-avatar provider — control plane. Mints Compose sessions
 * (`POST /compose/token`) and resolves ICE servers (`GET /compose/ice`).
 * Media is joined per {@link AvatarMediaMode}: hand the returned
 * {@link AvatarSessionHandle} to the browser SDK (client-delegated), or to
 * `createSimliServerSession()` for the Node-owned WebRTC path.
 *
 * Contract (verified 2026-07-08 against the Compose REST + AsyncAPI docs):
 * auth header `x-simli-api-key`; token body `{ faceId, apiVersion: 'v2',
 * handleSilence, maxSessionLength, maxIdleTime, audioInputFormat: 'pcm16' }`;
 * the upstream sample rate is NOT publicly pinned — 16000 Hz is the
 * SDK-observed default, carried as config-overridable data.
 */

import type {
  AvatarIceServer,
  AvatarSessionConfig,
  AvatarSessionHandle,
  IAvatarProvider,
} from '../types.js';

/** Per-request control-plane timeout (session minting must be snappy). */
const CONTROL_PLANE_TIMEOUT_MS = 10_000;

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
}
