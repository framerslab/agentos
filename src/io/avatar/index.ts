/**
 * @module io/avatar
 *
 * Realtime-avatar seam: provider-agnostic control plane
 * ({@link IAvatarProvider}), discovery catalog, and the Simli
 * implementation (client-delegated handle + server-driven WS/WebRTC
 * session).
 */

export type {
  AvatarIceServer,
  AvatarMediaMode,
  AvatarSessionConfig,
  AvatarSessionHandle,
  IAvatarProvider,
} from './types.js';
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
