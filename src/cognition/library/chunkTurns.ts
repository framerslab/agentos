/**
 * @file chunkTurns.ts
 * @description A transcript cut into passages for retrieval. A turn is never cut, so a quote that lies inside one
 * turn's place in a passage is a verbatim span of that turn, and the passage records where each turn sits in it.
 * Pure and DOM-free.
 *
 * @module agentos/cognition/library/chunkTurns
 */

/** One final line of a transcript. */
export interface LibraryTurn {
  /** The turn's number in its session, rising. */
  seq: number;
  /** The provider's id of the line. */
  itemId: string;
  text: string;
  startMs?: number | null;
  endMs?: number | null;
}

/** A passage of consecutive turns. */
export interface TurnChunk {
  /** The passage's number in its session, from 0. */
  index: number;
  /** The turns' texts joined by one line feed. */
  text: string;
  firstSeq: number;
  lastSeq: number;
  itemIds: string[];
  /** The first turn's start and the last turn's end, when known. */
  startMs: number | null;
  endMs: number | null;
  /** Where each turn's text sits in `text`. */
  turns: Array<{ seq: number; itemId: string; start: number; end: number }>;
}

/** How to cut. */
export interface ChunkTurnsOptions {
  /** The most characters a passage holds, unless one turn alone is longer. @default 1200 */
  maxChars?: number;
  /**
   * At most how many turns from the end of a passage open the next one, never its first turn: only as many as fit
   * within `maxChars` together with the next new turn. @default 1
   */
  overlapTurns?: number;
}

/**
 * Cuts turns into passages, in order. Turns that are empty or white space alone are left out. Every passage after
 * the first holds at least one turn the passage before did not.
 */
export function chunkTurns(turns: readonly LibraryTurn[], options: ChunkTurnsOptions = {}): TurnChunk[] {
  const maxChars = options.maxChars ?? 1200;
  const overlap = Math.max(0, options.overlapTurns ?? 1);
  const spoken = turns.filter((turn) => turn.text.trim().length > 0);
  const chunks: TurnChunk[] = [];
  let from = 0;
  while (from < spoken.length) {
    let to = from;
    let length = spoken[from].text.length;
    while (to + 1 < spoken.length && length + 1 + spoken[to + 1].text.length <= maxChars) {
      to += 1;
      length += 1 + spoken[to].text.length;
    }
    const members = spoken.slice(from, to + 1);
    const placed: TurnChunk['turns'] = [];
    let cursor = 0;
    for (const member of members) {
      placed.push({ seq: member.seq, itemId: member.itemId, start: cursor, end: cursor + member.text.length });
      cursor += member.text.length + 1;
    }
    chunks.push({
      index: chunks.length,
      text: members.map((member) => member.text).join('\n'),
      firstSeq: members[0].seq,
      lastSeq: members[members.length - 1].seq,
      itemIds: members.map((member) => member.itemId),
      startMs: members[0].startMs ?? null,
      endMs: members[members.length - 1].endMs ?? null,
      turns: placed,
    });
    const next = to + 1;
    if (next >= spoken.length) break;
    // The next passage opens `overlap` turns back, past this passage's first turn, and keeps only the overlap turns
    // that fit within maxChars together with the next new turn: every passage after the first then holds a turn the
    // one before did not, and the walk always moves forward.
    from = Math.max(from + 1, next - overlap);
    let opening = spoken[next].text.length;
    for (let kept = from; kept < next; kept += 1) opening += spoken[kept].text.length + 1;
    while (from < next && opening > maxChars) {
      opening -= spoken[from].text.length + 1;
      from += 1;
    }
  }
  return chunks;
}
