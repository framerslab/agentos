/**
 * @module io/avatar/providerCatalog
 *
 * Discovery catalog for realtime-avatar providers — the avatar sibling of
 * `SPEECH_PROVIDER_CATALOG`. Deliberately small and separate: realtime
 * avatars are a different concern from speech vendors, and the catalog only
 * grows when a provider actually ships in `providers/`.
 */

import type { AvatarMediaMode } from './types.js';

/** One discoverable avatar provider. */
export interface AvatarProviderCatalogEntry {
  id: string;
  label: string;
  /** Env vars whose presence unlocks the provider. */
  envVars: string[];
  description: string;
  mediaModes: AvatarMediaMode[];
  audioFormat: 'pcm16';
  /** Default upstream sample rate (Hz); provider-config overridable. */
  defaultSampleRate: number;
  features: string[];
}

export const AVATAR_PROVIDER_CATALOG: readonly AvatarProviderCatalogEntry[] = [
  {
    id: 'simli',
    label: 'Simli',
    envVars: ['SIMLI_API_KEY'],
    description: 'Realtime lip-synced avatar over WebRTC (Compose API).',
    mediaModes: ['client-delegated', 'server-driven'],
    audioFormat: 'pcm16',
    defaultSampleRate: 16000,
    features: ['webrtc', 'lipsync', 'barge-in', 'sfu-relay'],
  },
];
