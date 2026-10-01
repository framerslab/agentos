import type { IImageProvider } from './IImageProvider.js';
import { MiniMaxImageProvider } from './providers/MiniMaxImageProvider.js';
import { OpenAIImageProvider } from './providers/OpenAIImageProvider.js';
import { OpenRouterImageProvider } from './providers/OpenRouterImageProvider.js';
import { ReplicateImageProvider } from './providers/ReplicateImageProvider.js';
import { StabilityImageProvider } from './providers/StabilityImageProvider.js';
import { StableDiffusionLocalProvider } from './providers/StableDiffusionLocalProvider.js';
import { FluxImageProvider } from './providers/FluxImageProvider.js';
import { FalImageProvider } from './providers/FalImageProvider.js';

export * from './IImageProvider.js';
export * from './providers/MiniMaxImageProvider.js';
export * from './imageToBuffer.js';
export * from './ImageOperationError.js';
export * from './FallbackImageProxy.js';
export { PolicyAwareImageRouter, type ImageProviderPreference } from './PolicyAwareImageRouter.js';
export * from './providers/OpenAIImageProvider.js';
export * from './providers/OpenRouterImageProvider.js';
export * from './providers/ReplicateImageProvider.js';
export * from './providers/StabilityImageProvider.js';
export * from './providers/StableDiffusionLocalProvider.js';
export * from './providers/FluxImageProvider.js';
export * from './providers/FalImageProvider.js';

export {
  type FaceEmbedding,
  type IFaceEmbeddingService,
  ReplicateFaceEmbeddingService,
  type ReplicateFaceEmbeddingConfig,
} from './face/index.js';

export type ImageProviderFactory = () => IImageProvider;

const imageProviderFactories = new Map<string, ImageProviderFactory>([
  ['minimax', () => new MiniMaxImageProvider()],
  ['openai', () => new OpenAIImageProvider()],
  ['openrouter', () => new OpenRouterImageProvider()],
  ['stability', () => new StabilityImageProvider()],
  ['replicate', () => new ReplicateImageProvider()],
  ['stable-diffusion-local', () => new StableDiffusionLocalProvider()],
  ['bfl', () => new FluxImageProvider()],
  ['fal', () => new FalImageProvider()],
]);

export function registerImageProviderFactory(providerId: string, factory: ImageProviderFactory): void {
  imageProviderFactories.set(providerId.toLowerCase(), factory);
}

export function unregisterImageProviderFactory(providerId: string): void {
  imageProviderFactories.delete(providerId.toLowerCase());
}

export function hasImageProviderFactory(providerId: string): boolean {
  return imageProviderFactories.has(providerId.toLowerCase());
}

export function listImageProviderFactories(): string[] {
  return Array.from(imageProviderFactories.keys()).sort();
}

export function createImageProvider(providerId: string): IImageProvider {
  const factory = imageProviderFactories.get(providerId.toLowerCase());
  if (!factory) {
    throw new Error(`Image generation is not supported for provider "${providerId}".`);
  }
  return factory();
}
