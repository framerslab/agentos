/**
 * @fileoverview Where the pieces of a recording start and end: `pieceSeconds` long, each starting `overlapSeconds`
 * before the one before it ends; a remainder no longer than the overlap and one second joins the piece before it.
 * @module agentos/io/hearing/pieces/plan
 */

/** One planned piece, in seconds. */
export interface PiecePlan {
  index: number;
  start: number;
  end: number;
}

/** The pieces of a recording of `seconds`. */
export function planPieces(seconds: number, options: { pieceSeconds: number; overlapSeconds: number }): PiecePlan[] {
  const { pieceSeconds, overlapSeconds } = options;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError('planPieces: the length must be a positive number of seconds');
  if (!Number.isFinite(pieceSeconds) || pieceSeconds < 10) throw new RangeError('planPieces: a piece must be finite and 10 seconds or more');
  if (!Number.isFinite(overlapSeconds) || overlapSeconds < 0 || overlapSeconds >= pieceSeconds) throw new RangeError('planPieces: the overlap must be finite, nonnegative and shorter than a piece');
  const step = pieceSeconds - overlapSeconds;
  const pieces: PiecePlan[] = [];
  for (let start = 0, index = 0; start < seconds; start += step, index += 1) {
    const end = Math.min(seconds, start + pieceSeconds);
    if (pieces.length > 0 && end - start <= overlapSeconds + 1) {
      pieces[pieces.length - 1]!.end = end;
      break;
    }
    pieces.push({ index, start, end });
    if (end >= seconds) break;
  }
  return pieces;
}
