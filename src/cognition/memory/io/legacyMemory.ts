/**
 * @module memory/io/legacyMemory
 *
 * Memory a store holds from before per-user scope ("legacy memory"): traces filed under the agent's plain scope id,
 * and pages a compile wrote under `memory/`. Nobody new reads it, unless a single person's install attributes it to
 * its one user. This module holds that attribution and its checks.
 */
import { memoryLog } from '../log.js';
import { conversationScopeKey } from '../retrieval/store/conversationScopeKey.js';
import { encodePlainScopeId } from '../retrieval/store/scopeIdForm.js';
import type { ForgottenLedger } from '../suppression/ForgottenLedger.js';
import type { Memory } from './facade/Memory.js';

/** The scope legacy traces were filed under. */
export const LEGACY_SCOPE = 'persona';

/** The one reason the attribution takes: the store is one person's own. */
export type LegacyMemoryReason = 'one-persons-machine';

/** A legacy page on disk: a compiled one (`parsed`), or one whose front matter cannot be read. */
export interface LegacyPageEntry {
  id: string;
  parsed: boolean;
}

/** The written forms of the agent's plain scope id legacy traces sit under: the id itself, and its encoded form. */
export function legacyScopeIds(agentId: string): string[] {
  const encoded = encodePlainScopeId(LEGACY_SCOPE, agentId);
  return encoded === agentId ? [agentId] : [agentId, encoded];
}

/** What a request to attribute legacy memory is refused with when it names nobody, or gives another reason. */
export const LEGACY_SHAPE =
  "souledAgent: legacyMemory needs attributeTo, an id that names one person, and reason: 'one-persons-machine'";

/**
 * Throws unless the option names one person (a non-empty id that is not one of the anonymous ids) and the one
 * reason it takes.
 *
 * @param isAnonymous - Whether an id names nobody.
 * @throws Error {@link LEGACY_SHAPE}.
 */
export function assertLegacyMemory(option: unknown, isAnonymous: (id: string) => boolean): void {
  const given = (option !== null && typeof option === 'object' ? option : {}) as { attributeTo?: unknown; reason?: unknown };
  if (typeof given.attributeTo !== 'string' || given.attributeTo === '' || isAnonymous(given.attributeTo)) {
    throw new Error(LEGACY_SHAPE);
  }
  if (given.reason !== 'one-persons-machine') throw new Error(LEGACY_SHAPE);
}

export interface AttributeLegacyMemoryOptions {
  /** The store, opened with its forgotten-user ledger. */
  memory: Memory;
  /** The store's ledger. */
  ledger: ForgottenLedger;
  agentId: string;
  /** The user the legacy memory is attributed to. */
  attributeTo: string;
  reason: LegacyMemoryReason;
  /** The legacy pages on disk, compiled and of uncertain kind. */
  legacyPages: () => Promise<LegacyPageEntry[]>;
  /** Whether an id names nobody. Default: none does but the empty id. */
  isAnonymous?: (id: string) => boolean;
}

/**
 * Attributes the store's legacy memory to one user, for a single person's own machine. In order, each refusal
 * changing nothing:
 *
 * 1. The option must name one person and the reason `'one-persons-machine'`.
 * 2. The ledger must not hold the user as forgotten.
 * 3. An attribution to another user is never moved; one to the same user needs nothing more.
 * 4. A store with no legacy trace (a soft-deleted one counts: it holds its words) and no legacy compiled page has
 *    nothing to attribute.
 * 5. The store must record nobody else: no registry row, trace or page of another user or of any session, no trace
 *    that names another user, no learner row of another user, and no other forgotten subject. The absence of all of
 *    these is not proof of one owner: the option rests on the host's own statement.
 *
 * Then the owner row is written and one `memory.legacy_attributed` line counts the traces and compiled pages.
 *
 * @returns Whether an attribution was written now.
 * @throws Error naming the refusal.
 */
export async function attributeLegacyMemory(options: AttributeLegacyMemoryOptions): Promise<{ attributed: boolean }> {
  const { memory, ledger, agentId, attributeTo } = options;
  const isAnonymous = options.isAnonymous ?? ((id: string) => id === '');
  assertLegacyMemory({ attributeTo, reason: options.reason }, isAnonymous);
  const owner = { kind: 'user' as const, id: attributeTo };

  if (await ledger.isForgotten(owner)) {
    throw new Error('souledAgent: legacyMemory names a user this store has forgotten; legacy memory stays off');
  }

  const ownerKey = conversationScopeKey(agentId, owner);
  const existing = await memory.legacyOwner(agentId);
  if (existing !== undefined) {
    if (existing === ownerKey) return { attributed: false };
    throw new Error("souledAgent: this store's legacy memory is attributed to another user; attribution is not moved");
  }

  let traces = 0;
  // A soft-deleted trace still holds its words: it is the owner's to recall no more, and to delete.
  for (const scopeId of legacyScopeIds(agentId)) traces += await memory.countScope(LEGACY_SCOPE, scopeId, { includeDeleted: true });
  const pages = (await options.legacyPages()).filter((page) => page.parsed).length;
  if (traces === 0 && pages === 0) return { attributed: false };

  const others = (await memory.listHeldSubjects()).filter((subject) => !(subject.kind === 'user' && subject.id === attributeTo));
  if (others.length > 0 || (await ledger.countNotOf(owner)) > 0) {
    throw new Error(
      "souledAgent: legacyMemory is for one person's own machine, and this store records memory of another person or session; legacy memory stays off",
    );
  }

  await memory.setLegacyOwner(agentId, ownerKey);
  memoryLog.info('memory.legacy_attributed', { traces, pages });
  return { attributed: true };
}
