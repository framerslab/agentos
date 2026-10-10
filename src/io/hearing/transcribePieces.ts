/**
 * @fileoverview A batch transcription job. The pieces of one recording go to the caller's `transcribe` in order, at
 * most `inFlight` at once; each carries as its prompt the last sentence of the newest earlier piece already
 * transcribed when it is sent; a failed piece is tried again up to `attempts` times in all; each piece's text is
 * joined to the text before it by `mergeSeam`. Isomorphic: it imports only TranscriptDedupe's normalization.
 *
 * @module agentos/io/hearing/transcribePieces
 */

import { normalizeTranscriptText } from '../voice-pipeline/TranscriptDedupe.js';

/** One piece of a recording, cut by the caller. */
export interface PieceInput {
  /**
   * The piece's number in the recording, higher than the number of the piece before it. The job tells pieces apart
   * by it.
   */
  index: number;
  /** Where the piece starts in the recording. */
  startMs: number;
  /** How long the piece is. */
  durationMs: number;
  /** The piece's audio, in a container a provider takes. */
  data: Uint8Array;
  /** The media type of `data`. */
  mimeType: string;
  /** Named with the container's extension, which a provider reads to know the format. */
  fileName: string;
}

/** What one transcription answered. */
export interface PieceTranscript {
  /** The piece's text. */
  text: string;
  /** The seconds the provider reported, or the caller's measure when it reported none. */
  seconds: number;
}

/**
 * The caller's transcription of one piece. `request.prompt` is the context to hand the provider, when there is any;
 * `request.attempt` is 1 for a piece's first try; `request.signal` is the job's own. A call that throws is made again
 * while the piece has tries left and the job's signal has not aborted.
 */
export type TranscribePiece = (piece: PieceInput, request: { prompt?: string; attempt: number; signal?: AbortSignal }) => Promise<PieceTranscript>;

/** One piece done. */
export interface PieceOutcome {
  /** The piece's `index`. */
  index: number;
  /** The piece's `startMs`. */
  startMs: number;
  /** The piece's own text. */
  text: string;
  /** What it added to the whole, after the seam. */
  added: string;
  /** The seconds of the try that answered. */
  seconds: number;
  /** The tries the piece took, 1 when its first one answered. */
  attempts: number;
}

/** How the job runs. */
export interface TranscribePiecesOptions {
  /** The sentence spans of a text; the prompt is the last of them. */
  sentences: (text: string) => ReadonlyArray<{ start: number; end: number }>;
  /** Tries a piece gets in all. @default 3 */
  attempts?: number;
  /** Pieces sent at once, 1 to 4. @default 1 */
  inFlight?: number;
  /** The text before the first piece given, when a run starts again from a piece. */
  previousText?: string;
  /**
   * Ends the job: no further try is made, and the job rejects with the signal's reason. Every `transcribe` call is
   * given it.
   */
  signal?: AbortSignal;
  /** Called with each piece, in order, once it and every piece before it are done. */
  onPiece?: (outcome: PieceOutcome) => void | Promise<void>;
}

/** A piece failed every attempt; the pieces before it were reported. */
export class PiecesFailed extends Error {
  /**
   * @param index - The `index` of the piece that failed.
   * @param attempts - The tries the piece was given.
   * @param cause - What its last try threw. When the caller's `sentences` threw before a try, that error.
   */
  constructor(
    readonly index: number,
    readonly attempts: number,
    readonly cause: unknown,
  ) {
    super(`piece ${index} failed after ${attempts} attempts`);
    this.name = 'PiecesFailed';
  }
}

/** The longest run of repeated words the seam is searched for. */
const MAX_RUN = 20;
/** The shortest run taken for a repeat: one shared word is a coincidence. */
const MIN_RUN = 2;
/** The most words of the next text that may come before the repeat. */
const MAX_SKIP = 2;

/** The words of a text with where each starts, for cutting the original text. */
function wordsOf(text: string): Array<{ word: string; start: number }> {
  return [...text.matchAll(/\S+/g)].map((match) => ({ word: normalizeTranscriptText(match[0]), start: match.index })).filter((entry) => entry.word !== '');
}

/**
 * `next` with the words the overlap repeated dropped: the longest run of two to twenty words that ends `previous` and
 * starts `next` within its first three words (the words before the run in `next` are the cut word and dropped with
 * it), compared without case or punctuation. With no such run, `next` whole.
 *
 * @param previous - The text so far. Its last twenty words are the ones compared.
 * @param next - The text of the piece that follows.
 * @returns `next` from the first word after the run on, empty when the run ends it; with no run, `next` trimmed.
 */
export function mergeSeam(previous: string, next: string): string {
  const tail = wordsOf(previous).slice(-MAX_RUN).map((entry) => entry.word);
  const head = wordsOf(next);
  for (let run = Math.min(MAX_RUN, tail.length); run >= MIN_RUN; run -= 1) {
    const ending = tail.slice(-run).join(' ');
    for (let skip = 0; skip <= MAX_SKIP && skip + run <= head.length; skip += 1) {
      if (head.slice(skip, skip + run).map((entry) => entry.word).join(' ') === ending) {
        const after = head[skip + run];
        return after === undefined ? '' : next.slice(after.start);
      }
    }
  }
  return next.trim();
}

/**
 * The last sentence of a text, or undefined.
 *
 * @param text - The text to read.
 * @param sentences - The caller's sentence spans, as in {@link TranscribePiecesOptions}.
 * @returns The text of the last span, trimmed; the whole text, trimmed, when `sentences` answers no span; undefined
 * when that is empty.
 */
export function lastSentence(text: string, sentences: TranscribePiecesOptions['sentences']): string | undefined {
  const spans = sentences(text);
  const last = spans[spans.length - 1];
  const sentence = last === undefined ? text.trim() : text.slice(last.start, last.end).trim();
  return sentence === '' ? undefined : sentence;
}

/**
 * Transcribes the pieces; answers the whole text and each piece's outcome.
 *
 * @param pieces - The pieces in the order of the recording. An async iterable is asked for its next piece only when
 * the job has room to send it.
 * @param transcribe - The caller's transcription of one piece.
 * @param options - The sentence cut, and how the job runs.
 * @returns `text`, the pieces' texts joined at their seams, after `previousText` when one is given; `pieces`, each
 * piece's outcome in order; `seconds`, the sum of the outcomes' seconds.
 * @throws {PiecesFailed} When a piece fails every attempt. The pieces before it have been reported to `onPiece` by
 * then, and no piece after it is reported.
 * @throws The reason of `options.signal`, when the job finds it aborted: before it sends the next piece, or once the
 * pieces in flight have settled.
 */
export async function transcribePieces(
  pieces: Iterable<PieceInput> | AsyncIterable<PieceInput>,
  transcribe: TranscribePiece,
  options: TranscribePiecesOptions,
): Promise<{ text: string; pieces: PieceOutcome[]; seconds: number }> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const inFlight = Math.min(4, Math.max(1, options.inFlight ?? 1));
  const done = new Map<number, PieceTranscript & { attempts: number; startMs: number }>();
  const outcomes: PieceOutcome[] = [];
  let whole = options.previousText?.trim() ?? '';
  let newest = whole;
  let newestIndex = Number.NEGATIVE_INFINITY;
  let failure: PiecesFailed | null = null;
  const order: number[] = [];

  const one = async (piece: PieceInput): Promise<void> => {
    const prompt = newest === '' ? undefined : lastSentence(newest, options.sentences);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      options.signal?.throwIfAborted();
      try {
        const answer = await transcribe(piece, { prompt, attempt, signal: options.signal });
        done.set(piece.index, { ...answer, attempts: attempt, startMs: piece.startMs });
        // A piece that answers after a later one has is not the newest: the later piece's text stays the context.
        if (piece.index > newestIndex) {
          newestIndex = piece.index;
          newest = answer.text;
        }
        return;
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted) throw error;
      }
    }
    throw new PiecesFailed(piece.index, attempts, lastError);
  };

  /** Reports every piece now done in order. */
  const report = async (): Promise<void> => {
    while (order.length > 0 && done.has(order[0]!)) {
      const index = order.shift()!;
      const answer = done.get(index)!;
      const added = whole === '' ? answer.text.trim() : mergeSeam(whole, answer.text);
      whole = [whole, added].filter((part) => part !== '').join(' ');
      const outcome: PieceOutcome = { index, startMs: answer.startMs, text: answer.text, added, seconds: answer.seconds, attempts: answer.attempts };
      outcomes.push(outcome);
      await options.onPiece?.(outcome);
    }
  };

  const running = new Set<Promise<void>>();
  for await (const piece of pieces) {
    options.signal?.throwIfAborted();
    order.push(piece.index);
    const task = one(piece).catch((error: unknown) => {
      // An abort is not a piece's failure: the job throws the signal's own reason, before its next piece or once the
      // pieces in flight have settled.
      if (options.signal?.aborted) return;
      const failed = error instanceof PiecesFailed ? error : new PiecesFailed(piece.index, attempts, error);
      // With several in flight the earliest piece that failed is the one named, so a run starts again from it.
      if (failure === null || failed.index < failure.index) failure = failed;
    });
    running.add(task);
    void task.finally(() => running.delete(task));
    if (running.size >= inFlight) await Promise.race(running);
    if (failure !== null) break;
    await report();
  }
  await Promise.all(running);
  options.signal?.throwIfAborted();
  if (failure !== null) {
    const failed: PiecesFailed = failure;
    order.splice(order.indexOf(failed.index));
    await report();
    throw failed;
  }
  await report();
  return { text: whole, pieces: outcomes, seconds: outcomes.reduce((sum, outcome) => sum + outcome.seconds, 0) };
}
