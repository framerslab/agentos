/**
 * @file fuseRanked.ts
 * @description Reciprocal rank fusion of any number of ranked lists of any items (Cormack, Clarke and Buettcher,
 * 2009): an item's score is the sum, over the lists it stands in, of the list's weight over `k` plus its 1-based rank
 * there. Items are told apart by `idOf`; one that stands in several lists is one fused item, kept as its first list
 * holds it. The fused order is by score, then by the first list the item stands in, then by its rank there, then by
 * its id, so the same input always gives the same answer. Then the caps, walking that order: an item is passed over
 * when its first list already gave `perList` items or its group already gave `perGroup`, and the walk stops at
 * `limit`. Two lists fused with their weights give {@link reciprocalRankFusion}'s scores and order, but for a tie,
 * which that function breaks by the id alone, and an item twice in one list, which it scores at each of its ranks.
 * @module agentos/rag/search/fuseRanked
 */

/** How to fuse. */
export interface FuseRankedOptions<T> {
  /** An item's id: items with the same id in different lists are one item. */
  idOf: (item: T) => string;
  /** The smoothing constant. @default 60 */
  k?: number;
  /** Each list's weight by the list's place; a list with none weighs 1. */
  weights?: readonly number[];
  /**
   * The most items kept whose first list is a given list: one number for every list, or one a list by place. A cap is
   * a whole number, zero or more, or positive infinity for no cap.
   */
  perList?: number | readonly number[];
  /** An item's group, which `perGroup` counts. */
  groupOf?: (item: T) => string;
  /** The most items kept of one group, a whole number, zero or more, or positive infinity; needs `groupOf`. */
  perGroup?: number;
  /** The most items answered, a whole number, zero or more, or positive infinity. */
  limit?: number;
}

/** One fused item. */
export interface FusedItem<T> {
  /** The item as its first list holds it. */
  item: T;
  /** Its id. */
  id: string;
  /** Its fused score; higher ranks first. */
  score: number;
  /** The place of the first list it stands in. */
  list: number;
  /** Its 1-based rank in each list it stands in, by the list's place. */
  ranks: ReadonlyMap<number, number>;
}

/** A finite number, zero or more. */
function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Throws unless the cap named, when given, is a whole number, zero or more, or positive infinity. */
function checkCap(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if ((Number.isInteger(value) && value >= 0) || value === Number.POSITIVE_INFINITY) return;
  throw new RangeError(`fuseRanked: ${name} is a whole number, zero or more, or positive infinity`);
}

/**
 * Fuses the lists. A list's items are in its own rank order, best first; an item twice in one list counts once, at its
 * better rank.
 * @throws {RangeError} When `k` or a weight is not a finite number, zero or more, or a cap (`perList`, `perGroup`,
 * `limit`) is not a whole number, zero or more, or positive infinity.
 * @throws {TypeError} When `perGroup` is given without `groupOf`.
 */
export function fuseRanked<T>(lists: ReadonlyArray<readonly T[]>, options: FuseRankedOptions<T>): FusedItem<T>[] {
  const k = options.k ?? 60;
  if (!finiteNonNegative(k)) throw new RangeError('fuseRanked: k is a finite number, zero or more');
  checkCap('limit', options.limit);
  checkCap('perGroup', options.perGroup);
  if (typeof options.perList === 'number') checkCap('perList', options.perList);
  else options.perList?.forEach((value, place) => checkCap(`perList[${place}]`, value));
  if (options.perGroup !== undefined && options.groupOf === undefined) throw new TypeError('fuseRanked: perGroup needs groupOf');
  const byId = new Map<string, { item: T; id: string; score: number; list: number; rank: number; ranks: Map<number, number> }>();
  lists.forEach((list, place) => {
    const weight = options.weights?.[place] ?? 1;
    if (!finiteNonNegative(weight)) throw new RangeError(`fuseRanked: the weight of list ${place} is a finite number, zero or more`);
    const seen = new Set<string>();
    list.forEach((item, at) => {
      const id = options.idOf(item);
      if (seen.has(id)) return;
      seen.add(id);
      const rank = at + 1;
      const part = weight / (k + rank);
      const fused = byId.get(id);
      if (fused === undefined) {
        byId.set(id, { item, id, score: part, list: place, rank, ranks: new Map([[place, rank]]) });
        return;
      }
      fused.score += part;
      fused.ranks.set(place, rank);
    });
  });
  const ordered = [...byId.values()].sort(
    (a, b) => b.score - a.score || a.list - b.list || a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const capOf = (place: number): number =>
    typeof options.perList === 'number' ? options.perList : (options.perList?.[place] ?? Number.POSITIVE_INFINITY);
  const fromList = new Map<number, number>();
  const fromGroup = new Map<string, number>();
  const kept: FusedItem<T>[] = [];
  for (const fused of ordered) {
    if (options.limit !== undefined && kept.length >= options.limit) break;
    if ((fromList.get(fused.list) ?? 0) >= capOf(fused.list)) continue;
    const group = options.groupOf?.(fused.item);
    if (group !== undefined && options.perGroup !== undefined && (fromGroup.get(group) ?? 0) >= options.perGroup) continue;
    fromList.set(fused.list, (fromList.get(fused.list) ?? 0) + 1);
    if (group !== undefined) fromGroup.set(group, (fromGroup.get(group) ?? 0) + 1);
    kept.push({ item: fused.item, id: fused.id, score: fused.score, list: fused.list, ranks: fused.ranks });
  }
  return kept;
}
