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
 * when the call resolves to another provider than the owner's. The owner's
 * provider is the one its provider and model resolve to, or, when its model
 * does not resolve (a malformed id), the provider it names. An owner that
 * names no provider and no model, or only a model that does not resolve, is
 * for whichever provider the call names, as it always was; a target that does
 * not resolve fails in the call's own resolution, which reports why.
 */
export function credentialsGoWith(owner: ProviderAndModel, target: ProviderAndModel): boolean {
  if (owner.provider === undefined && owner.model === undefined) return true;
  let ownerProviderId: string | undefined;
  try {
    ownerProviderId = resolveModelOption({ provider: owner.provider, model: owner.model }, 'text').providerId;
  } catch {
    ownerProviderId = owner.provider;
  }
  if (ownerProviderId === undefined) return true;
  try {
    return resolveModelOption({ provider: target.provider, model: target.model }, 'text').providerId === ownerProviderId;
  } catch {
    return true;
  }
}

/**
 * Whether `model`, named by a call that names no provider, takes the call to
 * another provider than `inherited`, the provider it would inherit from an
 * agent or a gateway's defaults: a `provider:` prefix of a provider AgentOS
 * knows wins over the inherited provider (never under 'ollama', whose tags
 * carry colons). The call then does not inherit `inherited`, so a key of its
 * own is not refused as one sent to a provider it did not name.
 */
export function modelNamesAnotherProvider(inherited: string, model: string): boolean {
  try {
    return resolveModelOption({ provider: inherited, model }, 'text').providerId !== inherited;
  } catch {
    return false;
  }
}
