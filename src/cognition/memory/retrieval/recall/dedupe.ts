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
  undated?: boolean;
}

/** Whether an entry carries a time the dedupe may compare. */
function dated(entry: DedupeEntry): boolean {
  return entry.undated !== true && Number.isFinite(entry.trace.createdAt);
}

/** An entry's time for ordering: none (below every time) when it is undated. */
function timeOf(entry: DedupeEntry): number {
  return dated(entry) ? entry.trace.createdAt : Number.NEGATIVE_INFINITY;
}

/** How many passes may let a newer text take a held place; the pass after them only keeps or drops. */
const TAKEOVER_PASSES = 3;

/**
 * Drops near-duplicate texts from a pool in fused order, so that no two candidates kept are one memory
 * ({@link nearDuplicate}). Of two that are one memory:
 *
 * - When their words differ and both carry a `createdAt`, the newer stays: a near-duplicate that differs is most often
 *   the same memory after a correction or a rewrite, and the later text is its current state. It takes the better of
 *   the two fused scores and the higher-ranked one's place in the fused order, and keeps its own `ranks`, the legs'
 *   ranks of its own text.
 * - Otherwise (the same words, or a candidate with no `createdAt`), the higher fused score stays; on equal scores the
 *   newer, in the older one's place, and with no time to compare, the one earlier in the pool.
 *
 * Each dropped candidate names, in `duplicateOf`, the kept candidate that holds its place at the end, and repeats it:
 * a candidate dropped against a text that a newer one then replaced is looked at again, and is kept when it repeats
 * no kept text. Near-duplicates are not transitive (A and C can be two memories that B repeats both of), so a kept
 * candidate can drop several that are apart from each other.
 *
 * @param pool - The pool, in fused order.
 * @param threshold - The Jaccard index at which two texts are one ({@link nearDuplicate}).
 * @returns The candidates kept, in fused order (one that took another's place carries that one's `fusedScore`), and
 *   the ones dropped, in the pool's order.
 */
export function dedupePool<E extends DedupeEntry>(
  pool: readonly E[],
  threshold: number,
): { kept: E[]; dropped: Array<{ entry: E; duplicateOf: string }> } {
  type Item = { entry: E; index: number; tokens: Set<string> };
  /** A kept memory: the text it shows, the candidate whose score it carries, and its place. */
  type Slot = Item & { best: E; place: number; mergedInto?: Slot };
  const items: Item[] = pool.map((entry, index) => ({ entry, index, tokens: dedupeTokens(entry.trace.content) }));
  const byPreference = (list: readonly Item[]): Item[] =>
    [...list].sort((a, b) => b.entry.fusedScore - a.entry.fusedScore || timeOf(b.entry) - timeOf(a.entry) || a.index - b.index);
  const kept: Slot[] = [];
  let dropped: Array<{ item: Item; holder: Slot }> = [];

  /** Whether `x`'s text stays over `y`'s, the two being one memory. */
  const staysOver = (x: Slot, y: Slot): boolean => {
    const xt = x.entry.trace.createdAt;
    const yt = y.entry.trace.createdAt;
    const bothDated = dated(x.entry) && dated(y.entry);
    if (bothDated && xt !== yt && !sameWords(x.tokens, y.tokens)) return xt > yt;
    if (x.best.fusedScore !== y.best.fusedScore) return x.best.fusedScore > y.best.fusedScore;
    if (bothDated && xt !== yt) return xt > yt;
    return x.place <= y.place;
  };
  const finalHolder = (slot: Slot): Slot => {
    let at = slot;
    while (at.mergedInto) at = at.mergedInto;
    return at;
  };
  /** A kept memory of `item` alone: its own text, score and place, and nothing of a slot it was folded from. */
  const slotOf = (item: Item): Slot => ({ entry: item.entry, index: item.index, tokens: item.tokens, best: item.entry, place: item.index });
  /** Folds `loser` into `winner`: the better score, the higher place, and the loser's text dropped. */
  const fold = (winner: Slot, loser: Slot): void => {
    if (loser.best.fusedScore > winner.best.fusedScore) winner.best = loser.best;
    winner.place = Math.min(winner.place, loser.place);
    loser.mergedInto = winner;
    dropped.push({ item: { entry: loser.entry, index: loser.index, tokens: loser.tokens }, holder: winner });
    kept.splice(kept.indexOf(loser), 1);
  };
  /** Keeps `item`, drops it against the kept text it repeats, or lets it take that text's place. */
  const insert = (item: Item, mayTakeOver: boolean): void => {
    const holder = kept.find((k) => nearDuplicate(k.tokens, item.tokens, threshold));
    if (!holder) {
      kept.push(slotOf(item));
      return;
    }
    const challenger = slotOf(item);
    if (!mayTakeOver || !staysOver(challenger, holder)) {
      // A newer candidate of an equal score takes the place of the older one it repeats.
      holder.place = Math.min(holder.place, item.index);
      dropped.push({ item, holder });
      return;
    }
    // The newer text takes the holder's place and score; the holder's text is dropped against it.
    dropped.push({ item: { entry: holder.entry, index: holder.index, tokens: holder.tokens }, holder });
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
  };

  let queue = byPreference(items);
  for (let pass = 0; queue.length > 0; pass++) {
    const mayTakeOver = pass < TAKEOVER_PASSES;
    for (const item of queue) insert(item, mayTakeOver);
    // A pass that lets no text take a place changes no kept text, so every drop still repeats the text it names: it
    // is the last pass.
    if (!mayTakeOver) break;
    // A drop whose holder's text changed since may no longer repeat it: look at it again.
    const stale = dropped.filter((d) => !nearDuplicate(d.item.tokens, finalHolder(d.holder).tokens, threshold));
    dropped = dropped.filter((d) => !stale.includes(d));
    queue = byPreference(stale.map((d) => d.item));
  }
  return {
    kept: kept
      .sort((a, b) => a.place - b.place)
      .map((k) => (k.best === k.entry || k.best.fusedScore === k.entry.fusedScore ? k.entry : { ...k.entry, fusedScore: k.best.fusedScore })),
    dropped: dropped
      .sort((a, b) => a.item.index - b.item.index)
      .map((d) => ({ entry: d.item.entry, duplicateOf: finalHolder(d.holder).entry.trace.id })),
  };
}
