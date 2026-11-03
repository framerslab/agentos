/**
 * @module io/avatar
 *
 * Realtime-avatar seam: provider-agnostic control plane
 * ({@link IAvatarProvider}: session minting, and face creation from a
 * portrait), discovery catalog, and the Simli implementation
 * (client-delegated handle + server-driven WS/WebRTC session).
 */

export type {
  AvatarFaceCreateOptions,
  AvatarFaceImage,
  AvatarFaceJob,
  AvatarFaceState,
  AvatarFaceStatus,
  AvatarFaceStatusOptions,
  AvatarIceServer,
  AvatarMediaMode,
  AvatarSessionConfig,
  AvatarSessionHandle,
  IAvatarProvider,
} from './types.js';
export { AvatarProviderError, type AvatarProviderErrorInit } from './errors.js';
export {
  AVATAR_PROVIDER_CATALOG,
  type AvatarProviderCatalogEntry,
} from './providerCatalog.js';
export {
  SimliAvatarProvider,
  type SimliAvatarProviderConfig,
} from './providers/SimliAvatarProvider.js';
export {
  createSimliServerSession,
  SimliServerSession,
  type SimliServerSessionOptions,
} from './providers/SimliServerSession.js';
