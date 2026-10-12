/**
 * @file credentialOwner.ts
 * Whether a key and base URL set beside one provider and model go with a call
 * that names its own. An agent's options and a completion gateway's defaults
 * hold credentials for the provider they name; a call that names another
 * provider runs on its own credentials, or on that provider's from the
 * environment, and never sends the first provider's key to the second.
 */
import { resolveModelOption } from '../model.js';

/** The provider and model credentials were set beside, or a call names. */
export interface ProviderAndModel {
  provider?: string;
  model?: string;
}

/**
 * Whether credentials set beside `owner` go with a call to `target`: false
 * only when both resolve, to different providers. When `owner` names neither
 * a provider nor a model, or names one that does not resolve, its provider is
 * not known and the credentials are for whichever provider the call names, as
 * they always were; a target that does not resolve fails in the call's own
 * resolution, which reports why.
 */
export function credentialsGoWith(owner: ProviderAndModel, target: ProviderAndModel): boolean {
  if (owner.provider === undefined && owner.model === undefined) return true;
  try {
    const ownerProviderId = resolveModelOption({ provider: owner.provider, model: owner.model }, 'text').providerId;
    return resolveModelOption({ provider: target.provider, model: target.model }, 'text').providerId === ownerProviderId;
  } catch {
    return true;
  }
}
