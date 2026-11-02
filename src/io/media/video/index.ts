/**
 * @file index.ts
 * Barrel export for the video generation and analysis subsystem.
 *
 * Re-exports all public types, interfaces, and the fallback proxy so
 * consumers can import from `@agentos/media/video` (or the relative path)
 * without reaching into individual files.
 *
 * Also provides a provider factory registry (modelled on the image
 * subsystem's pattern) so that built-in and third-party video providers
 * can be registered and instantiated by provider ID.
 */

import type { IVideoGenerator } from './IVideoGenerator.js';
import { FalVideoProvider } from './providers/FalVideoProvider.js';
import { GeminiVideoProvider } from './providers/GeminiVideoProvider.js';
import { ReplicateVideoProvider } from './providers/ReplicateVideoProvider.js';
import { RunwayVideoProvider } from './providers/RunwayVideoProvider.js';
import { registerKeyedVideoProviderId } from './videoInputs.js';

export * from './types.js';
export * from './IVideoGenerator.js';
export * from './IVideoAnalyzer.js';
export * from './FallbackVideoProxy.js';
export * from './VideoAnalyzer.js';
export { getVideoProviderOptions, videoImageToUrl } from './videoInputs.js';

// ---------------------------------------------------------------------------
// Provider factory registry
// ---------------------------------------------------------------------------

/** A factory function that creates an uninitialised video provider instance. */
export type VideoProviderFactory = () => IVideoGenerator;

/**
 * Internal registry mapping provider IDs to provider constructors.
 *
 * Built-in providers (Runway, Replicate, Fal, Gemini) are pre-registered here
 * so the public `createVideoProvider()` API remains synchronous and ESM-safe.
 */
const videoProviderFactories = new Map<string, VideoProviderFactory>([
  ['runway', () => new RunwayVideoProvider()],
  ['replicate', () => new ReplicateVideoProvider()],
  ['fal', () => new FalVideoProvider()],
  ['gemini', () => new GeminiVideoProvider()],
]);

/**
 * Register a video provider factory for a given provider ID.
 *
 * Use this to add third-party or custom video providers at runtime.
 * Built-in providers (runway, replicate, fal, gemini) are pre-registered.
 * The id also keys `providerOptions`: a bag holding an entry under it is
 * read as keyed by provider, so the fallback providers never receive that
 * entry as flat model inputs.
 *
 * @param providerId - Unique identifier for the provider (lowercased for matching).
 * @param factory - Factory function that creates a new uninitialised provider instance.
 */
export function registerVideoProviderFactory(
  providerId: string,
  factory: VideoProviderFactory,
): void {
  videoProviderFactories.set(providerId.toLowerCase(), factory);
  registerKeyedVideoProviderId(providerId);
}

/**
 * Create a video provider instance by provider ID.
 *
 * Looks up the factory in the registry and returns a new uninitialised
 * provider. The caller must call `provider.initialize(config)` before use.
 *
 * @param providerId - Provider identifier (e.g. `"runway"`, `"replicate"`, `"fal"`, `"gemini"`).
 * @returns A new uninitialised {@link IVideoGenerator} instance.
 * @throws {Error} When no factory is registered for the given provider ID.
 */
export function createVideoProvider(providerId: string): IVideoGenerator {
  const factory = videoProviderFactories.get(providerId.toLowerCase());
  if (!factory) {
    throw new Error(`Video generation is not supported for provider "${providerId}".`);
  }
  return factory();
}

/**
 * Check whether a video provider factory is registered for the given ID.
 *
 * @param providerId - Provider identifier to check.
 * @returns `true` if a factory exists for this provider.
 */
export function hasVideoProviderFactory(providerId: string): boolean {
  return videoProviderFactories.has(providerId.toLowerCase());
}

/**
 * List all registered video provider factory IDs, sorted alphabetically.
 *
 * @returns Sorted array of registered provider identifiers.
 */
export function listVideoProviderFactories(): string[] {
  return Array.from(videoProviderFactories.keys()).sort();
}
