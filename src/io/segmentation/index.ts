/**
 * @module io/segmentation
 * Public barrel for the image segmentation surface: promptable masks
 * (`segment()`) and background removal (`removeBackground()`).
 */
export * from './types.js';
export * from './errors.js';
export { resolveSegmentationMode } from './resolveMode.js';
export { computeMaskBbox } from './maskGeometry.js';
export { ReplicateSegmentationProvider } from './providers/ReplicateSegmentationProvider.js';
export {
  FalBackgroundRemovalProvider,
  FAL_BIREFNET_MODEL,
  FAL_RUN_URL,
} from './providers/FalBackgroundRemovalProvider.js';
export {
  resolveSegmentationProvider,
  registerSegmentationProvider,
  resetSegmentationProviders,
} from './SegmentationProviderRegistry.js';
export {
  resolveBackgroundRemovalProvider,
  registerBackgroundRemovalProvider,
  resetBackgroundRemovalProviders,
  type BackgroundRemovalProviderConfig,
} from './BackgroundRemovalProviderRegistry.js';
export { maskToEditMask } from './consumers/maskToEditMask.js';
export { cropRegion } from './consumers/cropRegion.js';
