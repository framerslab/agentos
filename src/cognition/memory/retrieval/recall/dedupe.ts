/**
 * @fileoverview The near-duplicate dedupe of the hybrid recall pool: two memories whose words are the same, or nearly
 * the same, are one.
 *
 * @module agentos/cognition/memory/retrieval/recall/dedupe
 */
import { FTS_STOP_WORDS } from '../store/tracePersistence.js';

/** Whether a word holds a digit: a number, a code, or part of a date or an amount. */
function holdsDigit(token: string): boolean {
  return /\p{N}/u.test(token);
}

/**
 * Whether two token sets are one memory: equal, or a Jaccard index (shared tokens over all tokens) of at least
 * `threshold`. Two empty sets are not. Nor are two sets that each hold a word with a digit the other lacks: texts
 * that state different numbers, codes, dates or amounts are two memories whatever else they share, so a correction
 * of such a value is never dropped as the duplicate of the text it corrects, however long the text. A word with a
 * digit that only one of them holds leaves the index to decide.
 *
 * @param a - One text's tokens ({@link dedupeTokens}).
 * @param b - The other's.
 * @param threshold - The index at which they are one (the recall's `nearDuplicate`, 0.80 to start).
 */
export function nearDuplicate(a: ReadonlySet<string>, b: ReadonlySet<string>, threshold: number): boolean {
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  let digitOnlyInA = false;
  for (const token of a) {
    if (b.has(token)) shared += 1;
    else if (!digitOnlyInA && holdsDigit(token)) digitOnlyInA = true;
  }
  if (digitOnlyInA) {
    for (const token of b) if (!a.has(token) && holdsDigit(token)) return false;
  }
  return shared / (a.size + b.size - shared) >= threshold;
}

/**
 * The words of a memory's text as the dedupe compares them: runs of letters, digits and `_`, lower-cased, with stop
 * words dropped unless nothing else is left. A one-character word stays, a stop word among them (`a`, `i`), though the
 * exact-words leg's words drop it, so two short memories that differ in a one-digit or one-letter value ("locker 7"
 * and "locker 9", "room A" and "room I") are two.
 */
export function dedupeTokens(text: string): Set<string> {
  const raw = (text.match(/[\p{L}\p{N}_]+/gu) ?? []).map((token) => token.toLowerCase());
  const kept = raw.filter((token) => [...token].length === 1 || !FTS_STOP_WORDS.has(token));
  return new Set(kept.length > 0 ? kept : raw);
}

/** Whether two token sets hold the same words. */
function sameWords(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const token of a) if (!b.has(token)) return false;
  return true;
}

/** A pool entry as the dedupe reads it. `undated` marks a candidate whose `createdAt` the caller did not give. */
export interface DedupeEntry {
  trace: { id: string; content: string; createdAt: number };
  fusedScore: number;
  ranks?: unknown;
  undated?: boolean;
}

/** Whether an entry carries a time the dedupe may compare. */
function dated(entry: DedupeEntry): boolean {
  return entry.undated !== true && Number.isFinite(entry.trace.createdAt);
}

/**
 * Drops near-duplicate texts from a pool in fused order, so that no two candidates kept are one memory
 * ({@link nearDuplicate}). Of two that are one memory:
 *
 * - When their words differ and both carry a `createdAt`, the newer stays: a near-duplicate that differs is most often
 *   the same memory after a correction or a rewrite, and the later text is its current state. It takes the better of
 *   the two fused scores, with that candidate's ranks, and the higher-ranked one's place in the fused order.
 * - Otherwise (the same words, or a candidate with no `createdAt`), the higher fused score stays, and on equal scores
 *   the newer, in the older one's place.
 *
 * Each dropped candidate names, in `duplicateOf`, the kept candidate that holds its place at the end. Near-duplicates
 * are not transitive (A and C can be two memories that B repeats both of), so a kept candidate can drop several that
 * are apart from each other.
 *
 * @param pool - The pool, in fused order.
 * @param threshold - The Jaccard index at which two texts are one ({@link nearDuplicate}).
 * @returns The candidates kept, in fused order (one that took another's place carries that one's `fusedScore` and
 *   `ranks`), and the ones dropped, in the pool's order.
 */
export function dedupePool<E extends DedupeEntry>(
  pool: readonly E[],
  threshold: number,
): { kept: E[]; dropped: Array<{ entry: E; duplicateOf: string }> } {
  type Item = { entry: E; index: number; tokens: Set<string> };
  /** A kept memory: the text it shows, the candidate whose score and ranks it carries, and its place. */
  type Slot = Item & { best: E; place: number; mergedInto?: Slot };
  const items: Item[] = pool.map((entry, index) => ({ entry, index, tokens: dedupeTokens(entry.trace.content) }));
  const byPreference = [...items].sort(
    (a, b) => b.entry.fusedScore - a.entry.fusedScore || b.entry.trace.createdAt - a.entry.trace.createdAt || a.index - b.index,
  );
  const kept: Slot[] = [];
  const dropped: Array<{ entry: E; index: number; holder: Slot }> = [];

  /** Whether `x`'s text stays over `y`'s, the two being one memory. */
  const staysOver = (x: { entry: E; tokens: Set<string>; best: E; place: number }, y: { entry: E; tokens: Set<string>; best: E; place: number }): boolean => {
    if (dated(x.entry) && dated(y.entry) && x.entry.trace.createdAt !== y.entry.trace.createdAt && !sameWords(x.tokens, y.tokens)) {
      return x.entry.trace.createdAt > y.entry.trace.createdAt;
    }
    const xs = x.best.fusedScore;
    const ys = y.best.fusedScore;
    if (xs !== ys) return xs > ys;
    const xt = x.entry.trace.createdAt;
    const yt = y.entry.trace.createdAt;
    if (xt !== yt && Number.isFinite(xt) && Number.isFinite(yt)) return xt > yt;
    return x.place <= y.place;
  };
  /** Folds `loser` into `winner`: the better score and ranks, the higher place, and the loser's text dropped. */
  const fold = (winner: Slot, loser: Slot): void => {
    if (loser.best.fusedScore > winner.best.fusedScore) winner.best = loser.best;
    winner.place = Math.min(winner.place, loser.place);
    loser.mergedInto = winner;
    dropped.push({ entry: loser.entry, index: loser.index, holder: winner });
    kept.splice(kept.indexOf(loser), 1);
  };

  for (const item of byPreference) {
    const holder = kept.find((k) => nearDuplicate(k.tokens, item.tokens, threshold));
    if (!holder) {
      kept.push({ ...item, best: item.entry, place: item.index });
      continue;
    }
    const challenger: Slot = { ...item, best: item.entry, place: item.index };
    if (!staysOver(challenger, holder)) {
      // A newer candidate of an equal score takes the place of the older one it repeats.
      holder.place = Math.min(holder.place, item.index);
      dropped.push({ entry: item.entry, index: item.index, holder });
      continue;
    }
    // The newer text takes the holder's place, score and ranks; the holder's text is dropped against it.
    dropped.push({ entry: holder.entry, index: holder.index, holder });
    if (item.entry.fusedScore >= holder.best.fusedScore) holder.best = item.entry;
    holder.entry = item.entry;
    holder.index = item.index;
    holder.tokens = item.tokens;
    holder.place = Math.min(holder.place, item.index);
    // Its words can repeat another kept memory, which the holder's did not: of the two, one stays.
    for (const other of [...kept]) {
      if (other === holder || other.mergedInto || !nearDuplicate(other.tokens, holder.tokens, threshold)) continue;
      if (staysOver(holder, other)) {
        fold(holder, other);
      } else {
        fold(other, holder);
        break;
      }
    }
  }
  const finalHolder = (slot: Slot): Slot => {
    let at = slot;
    while (at.mergedInto) at = at.mergedInto;
    return at;
  };
  return {
    kept: kept
      .sort((a, b) => a.place - b.place)
      .map((k) => (k.best === k.entry ? k.entry : { ...k.entry, fusedScore: k.best.fusedScore, ...(k.best.ranks !== undefined ? { ranks: k.best.ranks } : {}) })),
    dropped: dropped.sort((a, b) => a.index - b.index).map((d) => ({ entry: d.entry, duplicateOf: finalHolder(d.holder).entry.trace.id })),
  };
}
