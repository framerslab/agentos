/**
 * @file TypedNetworkStore.ts
 * @description In-memory 4-bank store for typed facts plus a
 * bidirectional edge index. Stage E primary data structure.
 *
 * The store is independent of persistence — it holds the working set
 * of typed facts and their edges for a single retrieval session. A
 * future SQL-backed extension can wrap the same interface for cross-
 * session persistence.
 *
 * Insertion semantics:
 * - {@link addFact} routes by `fact.bank` into the correct bank set.
 * - {@link addEdge} stores the forward edge AND a paired reverse edge
 *   for {@link EdgeKind} entries that are bidirectional in Hindsight
 *   §2.4.1 (entity, semantic, temporal). Causal edges are directional
 *   in the paper; this implementation stores both directions for
 *   simplicity at small graph sizes — the consumer can filter by
 *   `kind === 'causal'` + edge ordering if direction-sensitive queries
 *   are needed.
 *
 * @module @framers/agentos/memory/retrieval/typed-network/TypedNetworkStore
 */

import type { BankId, TypedFact, TypedEdge } from './types.js';
import { BANK_IDS } from './types.js';

/**
 * In-memory 4-bank store. Holds facts indexed by ID + per-bank ID set
 * + outgoing-edge map. Constructed empty; populate via {@link addFact}
 * and {@link addEdge}.
 */
export class TypedNetworkStore {
  private readonly facts = new Map<string, TypedFact>();
  private readonly banks: Record<BankId, Set<string>>;
  private readonly edgesFrom = new Map<string, TypedEdge[]>();

  /**
   * Construct an empty store with one entry per bank in
   * {@link BANK_IDS}. Pre-allocating avoids null-checks in the
   * insertion path.
   */
  constructor() {
    this.banks = Object.fromEntries(
      BANK_IDS.map((b) => [b, new Set<string>()]),
    ) as Record<BankId, Set<string>>;
  }

  /**
   * Insert a fact. Routes into `fact.bank` by membership in the
   * appropriate `banks[bank]` set. Re-inserting the same ID overwrites
   * the prior fact and leaves bank membership unchanged.
   */
  addFact(fact: TypedFact): void {
    this.facts.set(fact.id, fact);
    this.banks[fact.bank].add(fact.id);
  }

  /**
   * Lookup a fact by ID. Returns `undefined` if not present.
   */
  getFact(id: string): TypedFact | undefined {
    return this.facts.get(id);
  }

  /**
   * Return the set of fact IDs in a given bank. Live reference — do
   * not mutate the returned `Set` directly.
   */
  getBank(bank: BankId): Set<string> {
    return this.banks[bank];
  }

  /**
   * Total fact count across all banks. Useful for debugging /
   * consolidation pruning thresholds.
   */
  size(): number {
    return this.facts.size;
  }

  /**
   * Insert a typed edge. Stores both the forward edge (`from → to`)
   * and a paired reverse edge (`to → from`) so spreading activation
   * traverses bidirectionally per Hindsight §2.4.1. Identical reverse-
   * edge insertion is what makes entity, semantic, and temporal links
   * bidirectional by construction.
   */
  addEdge(edge: TypedEdge): void {
    this.appendEdge(edge.fromFactId, edge);
    this.appendEdge(edge.toFactId, {
      fromFactId: edge.toFactId,
      toFactId: edge.fromFactId,
      kind: edge.kind,
      weight: edge.weight,
    });
  }

  /**
   * Outgoing edges from a fact. Empty array if the fact has no
   * outgoing edges or is unknown.
   */
  getEdges(factId: string): TypedEdge[] {
    return this.edgesFrom.get(factId) ?? [];
  }

  /**
   * Iterate every fact in the store. Useful for export and
   * persistence.
   */
  *iterateFacts(): IterableIterator<TypedFact> {
    yield* this.facts.values();
  }

  /**
   * Delete facts by ID, from every bank they are filed in (a fact added
   * again under another bank stays filed in the bank it had, see
   * {@link addFact}), with every edge that starts or ends at one of them.
   * Unknown IDs are skipped.
   *
   * @returns How many facts were deleted.
   */
  deleteFacts(ids: Iterable<string>): number {
    const gone = new Set<string>();
    for (const id of ids) {
      if (!this.facts.delete(id)) continue;
      for (const bank of BANK_IDS) this.banks[bank].delete(id);
      gone.add(id);
    }
    if (gone.size === 0) return 0;
    for (const id of gone) this.edgesFrom.delete(id);
    for (const [fromId, edges] of this.edgesFrom) {
      const kept = edges.filter((edge) => !gone.has(edge.toFactId));
      if (kept.length === 0) this.edgesFrom.delete(fromId);
      else if (kept.length !== edges.length) this.edgesFrom.set(fromId, kept);
    }
    return gone.size;
  }

  /**
   * Append an edge to the outgoing-edge map for `fromId`, allocating
   * the inner array on first insertion.
   */
  private appendEdge(fromId: string, edge: TypedEdge): void {
    const list = this.edgesFrom.get(fromId) ?? [];
    list.push(edge);
    this.edgesFrom.set(fromId, list);
  }
}
