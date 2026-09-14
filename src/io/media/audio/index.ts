/**
 * @file index.ts
 * Barrel export for the audio generation subsystem.
 *
 * Re-exports all public types, interfaces, and the fallback proxy so
 * consumers can import from `@agentos/media/audio` (or the relative path)
 * without reaching into individual files.
 *
 * Audio processing utilities (AdaptiveVAD, SilenceDetector, etc.) have
 * moved to the `hearing/` module.
 *
 * Also provides a provider factory registry (modelled on the video
 * subsystem's pattern) so that built-in and third-party audio providers
 * can be registered and instantiated by provider ID.
 */

import type { IAudioGenerator } from './IAudioGenerator.js';
import { AudioGenLocalProvider } from './providers/AudioGenLocalProvider.js';
import { ElevenLabsSFXProvider } from './providers/ElevenLabsSFXProvider.js';
import { FalAudioProvider } from './providers/FalAudioProvider.js';
import { MusicGenLocalProvider } from './providers/MusicGenLocalProvider.js';
import { MiniMaxMusicProvider } from './providers/MiniMaxMusicProvider.js';
import { ReplicateAudioProvider } from './providers/ReplicateAudioProvider.js';
import { StableAudioProvider } from './providers/StableAudioProvider.js';
import { SunoProvider } from './providers/SunoProvider.js';
import { UdioProvider } from './providers/UdioProvider.js';

// ---------------------------------------------------------------------------
// Audio generation (types, interface, fallback proxy)
// ---------------------------------------------------------------------------
export * from './types.js';
export * from './IAudioGenerator.js';
export * from './FallbackAudioProxy.js';
export * from './providers/MiniMaxMusicProvider.js';

// ---------------------------------------------------------------------------
// Provider factory registry
// ---------------------------------------------------------------------------

/** A factory function that creates an uninitialised audio provider instance. */
export type AudioProviderFactory = () => IAudioGenerator;

/**
 * Internal registry mapping provider IDs to provider constructors.
 *
 * Built-in providers are pre-registered here so the public
 * `createAudioProvider()` API remains synchronous and ESM-safe.
 */
const audioProviderFactories = new Map<string, AudioProviderFactory>([
  ['minimax-music', () => new MiniMaxMusicProvider()],
  ['suno', () => new SunoProvider()],
  ['udio', () => new UdioProvider()],
  ['stable-audio', () => new StableAudioProvider()],
  ['elevenlabs-sfx', () => new ElevenLabsSFXProvider()],
  ['musicgen-local', () => new MusicGenLocalProvider()],
  ['audiogen-local', () => new AudioGenLocalProvider()],
  ['replicate-audio', () => new ReplicateAudioProvider()],
  ['fal-audio', () => new FalAudioProvider()],
]);

/**
 * Register an audio provider factory for a given provider ID.
 *
 * Use this to add third-party or custom audio providers at runtime.
 * Built-in providers (suno, udio, stable-audio, elevenlabs-sfx,
 * musicgen-local, audiogen-local, replicate-audio, fal-audio) are
 * pre-registered.
 *
 * @param providerId - Unique identifier for the provider (lowercased for matching).
 * @param factory - Factory function that creates a new uninitialised provider instance.
 */
export function registerAudioProviderFactory(
  providerId: string,
  factory: AudioProviderFactory,
): void {
  audioProviderFactories.set(providerId.toLowerCase(), factory);
}

/**
 * Create an audio provider instance by provider ID.
 *
 * Looks up the factory in the registry and returns a new uninitialised
 * provider. The caller must call `provider.initialize(config)` before use.
 *
 * @param providerId - Provider identifier (e.g. `"suno"`, `"stable-audio"`, `"elevenlabs-sfx"`).
 * @returns A new uninitialised {@link IAudioGenerator} instance.
 * @throws {Error} When no factory is registered for the given provider ID.
 */
export function createAudioProvider(providerId: string): IAudioGenerator {
  const factory = audioProviderFactories.get(providerId.toLowerCase());
  if (!factory) {
    throw new Error(`Audio generation is not supported for provider "${providerId}".`);
  }
  return factory();
}

/**
 * Check whether an audio provider factory is registered for the given ID.
 *
 * @param providerId - Provider identifier to check.
 * @returns `true` if a factory exists for this provider.
 */
export function hasAudioProviderFactory(providerId: string): boolean {
  return audioProviderFactories.has(providerId.toLowerCase());
}

/**
 * List all registered audio provider factory IDs, sorted alphabetically.
 *
 * @returns Sorted array of registered provider identifiers.
 */
export function listAudioProviderFactories(): string[] {
  return Array.from(audioProviderFactories.keys()).sort();
}
