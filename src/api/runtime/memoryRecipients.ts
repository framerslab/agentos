/**
 * @module api/runtime/memoryRecipients
 *
 * Who receives a person's text from a souled agent: the providers its options send text to, and each route a call took
 * that the options do not name, recorded in the agent's store so the list still holds it after a restart. The list is
 * agent-wide, not per person: it names where the agent's calls go, not which person's text went where.
 */
import type { Brain } from '../../cognition/memory/retrieval/store/Brain.js';

/** One outside recipient of a person's text: a provider, and the model when one is named. */
export interface MemoryRecipient {
  /**
   * What the recipient is sent text for: the agent's model calls (`model`), a fallback hop of them
   * (`fallback-model`), the wiki compile (`compile`), the compile of an account the host marks a minor's
   * (`compile-minors`), or the embedding of cognitive memory (`embedding`).
   */
  role: 'model' | 'fallback-model' | 'compile' | 'compile-minors' | 'embedding';
  /**
   * The provider. {@link PROVIDER_FROM_THE_ENVIRONMENT} where the options name none, and the provider is picked from
   * the environment at each call; {@link AUTOMATIC_FALLBACK_CHAIN} for the fallback chain the library builds when the
   * options name none; {@link PROVIDER_FROM_THE_ROUTER} for a model router's pick.
   */
  provider: string;
  /** The model, when one is named; absent, the provider's default model. */
  model?: string;
}

/** The provider of a route whose options name none: it is picked from the environment at each call. */
export const PROVIDER_FROM_THE_ENVIRONMENT = 'from the environment at each call';
/** The provider of the fallback chain the library builds when the options name no `fallbackProviders`. */
export const AUTOMATIC_FALLBACK_CHAIN = 'the automatic fallback chain';
/** The provider of a call a model router routes. */
export const PROVIDER_FROM_THE_ROUTER = 'picked by the model router at each call';

/** A route as the options give it: the provider when one is named, and the model when one is named. */
export interface NamedRoute {
  provider?: string;
  model?: string;
}

/** The routes an agent's options send a person's text on. */
export interface RecipientRoutes {
  /** The agent's own model calls. */
  model: NamedRoute;
  /** Whether a model router picks the route of a call. */
  router: boolean;
  /** The options' fallback hops; undefined for the automatic chain, empty for none. */
  fallbacks: readonly NamedRoute[] | undefined;
  /** The wiki compile's route; undefined when the agent compiles nothing. */
  compile?: NamedRoute;
  /** The route of the compile of an account the host marks a minor's; undefined when none is named. */
  compileMinors?: NamedRoute;
  /** The embedding of cognitive memory; undefined when cognitive memory is off. */
  embedding?: NamedRoute;
}

/** One recipient of a route, with the provider named or the environment's pick, and the model where one is named. */
function recipient(role: MemoryRecipient['role'], route: NamedRoute): MemoryRecipient {
  return {
    role,
    provider: typeof route.provider === 'string' && route.provider !== '' ? route.provider : PROVIDER_FROM_THE_ENVIRONMENT,
    ...(typeof route.model === 'string' && route.model !== '' ? { model: route.model } : {}),
  };
}

/** The key a route is recorded under in `brain_meta`: its role, provider and model, each part URI-encoded. */
export function recipientKey(entry: MemoryRecipient): string {
  return `${RECIPIENT_KEY_PREFIX}${entry.role}:${encodeURIComponent(entry.provider)}:${encodeURIComponent(entry.model ?? '')}`;
}

/** The start of every recorded route's key in `brain_meta`. */
const RECIPIENT_KEY_PREFIX = 'recipient:';

/** The roles a recorded key may name. */
const ROLES: ReadonlySet<string> = new Set(['model', 'fallback-model', 'compile', 'compile-minors', 'embedding']);

/** The route a recorded key names; undefined for a key that is not one. */
function recipientOfKey(key: string): MemoryRecipient | undefined {
  if (!key.startsWith(RECIPIENT_KEY_PREFIX)) return undefined;
  const parts = key.slice(RECIPIENT_KEY_PREFIX.length).split(':');
  if (parts.length !== 3 || !ROLES.has(parts[0])) return undefined;
  try {
    const provider = decodeURIComponent(parts[1]);
    const model = decodeURIComponent(parts[2]);
    if (provider === '') return undefined;
    return { role: parts[0] as MemoryRecipient['role'], provider, ...(model !== '' ? { model } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * The list of who receives a person's text: the agent's model, a model router's pick, each fallback hop (one entry
 * for the automatic chain), the compile, the compile for minors, the embedding, then each recorded route the options
 * do not already name. An entry is listed once.
 */
export function recipientsOf(routes: RecipientRoutes, recorded: readonly MemoryRecipient[] = []): MemoryRecipient[] {
  const listed: MemoryRecipient[] = [recipient('model', routes.model)];
  if (routes.router) listed.push({ role: 'model', provider: PROVIDER_FROM_THE_ROUTER });
  if (routes.fallbacks === undefined) {
    listed.push({ role: 'fallback-model', provider: AUTOMATIC_FALLBACK_CHAIN });
  } else {
    for (const hop of routes.fallbacks) listed.push(recipient('fallback-model', hop));
  }
  if (routes.compile) listed.push(recipient('compile', routes.compile));
  if (routes.compileMinors) listed.push(recipient('compile-minors', routes.compileMinors));
  if (routes.embedding) listed.push(recipient('embedding', routes.embedding));
  listed.push(...recorded);
  const seen = new Set<string>();
  return listed.filter((entry) => {
    const key = recipientKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The recipient a call's route is, in `role`: the provider named or the environment's pick, and the model. */
export function routeRecipient(role: 'model' | 'fallback-model', route: NamedRoute): MemoryRecipient {
  return recipient(role, route);
}

/** Every route recorded in the store, as `recipient:` rows of its `brain_meta`, in key order. */
export async function recordedRecipients(brain: Brain): Promise<MemoryRecipient[]> {
  const rows = await brain.all<{ key: string }>('SELECT key FROM brain_meta WHERE brain_id = ?', [brain.brainId]);
  return rows
    .map((row) => row.key)
    .filter((key) => typeof key === 'string' && key.startsWith(RECIPIENT_KEY_PREFIX))
    .sort()
    .map(recipientOfKey)
    .filter((entry): entry is MemoryRecipient => entry !== undefined);
}

/** Records one route in the store: one `brain_meta` row of its key, holding no person, no text and no time. */
export async function recordRecipient(brain: Brain, entry: MemoryRecipient): Promise<void> {
  await brain.setMeta(recipientKey(entry), '1');
}
