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
  /** Tries a piece gets in all. A fraction is rounded down; a non-finite value takes the default. @default 3 */
  attempts?: number;
  /** Pieces sent at once, 1 to 4. A fraction is rounded down; a non-finite value takes the default. @default 1 */
  inFlight?: number;
  /** The text before the first piece given, when a run starts again from a piece. */
  previousText?: string;
  /**
   * Ends the job: no further try is made, and the job rejects with the signal's reason. Every `transcribe` call is
   * given it.
   */
  signal?: AbortSignal;
  /** Called serially with each piece, in order, as it and every piece before it finish, even during a source read. */
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
 * @throws The reason of `options.signal`, after interrupting a pending source read and awaiting pieces in flight.
 * @throws The original source or `onPiece` error, after awaiting pieces in flight.
 */
export async function transcribePieces(
  pieces: Iterable<PieceInput> | AsyncIterable<PieceInput>,
  transcribe: TranscribePiece,
  options: TranscribePiecesOptions,
): Promise<{ text: string; pieces: PieceOutcome[]; seconds: number }> {
  const requestedAttempts = options.attempts ?? 3;
  const requestedInFlight = options.inFlight ?? 1;
  const attempts = Number.isFinite(requestedAttempts) ? Math.max(1, Math.floor(requestedAttempts)) : 3;
  const inFlight = Number.isFinite(requestedInFlight) ? Math.min(4, Math.max(1, Math.floor(requestedInFlight))) : 1;
  const done = new Map<number, PieceTranscript & { attempts: number; startMs: number }>();
  const outcomes: PieceOutcome[] = [];
  const previous = options.previousText?.trim() ?? '';
  let whole = previous;
  const state: { failure: PiecesFailed | null; interruption?: { reason: unknown } } = { failure: null };
  const order: number[] = [];
  /** Releases the source or capacity wait when the job must stop acquiring pieces. */
  let wakeReader!: () => void;
  const stopped = new Promise<undefined>((resolve) => {
    wakeReader = () => resolve(undefined);
  });

  /** Stops acquisition and retries while preserving the first source, callback, or abort error. */
  const stop = (reason: unknown): void => {
    state.interruption ??= { reason };
    wakeReader();
  };

  /** Interrupts a pending source read with the caller's abort reason. */
  const onAbort = (): void => stop(options.signal!.reason);

  /** Transcribes one piece, refreshing its earlier context before each attempt. */
  const one = async (piece: PieceInput): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (state.interruption !== undefined) throw state.interruption.reason;
      options.signal?.throwIfAborted();
      let newest = previous;
      let newestIndex = Number.NEGATIVE_INFINITY;
      for (const [index, answer] of done) {
        if (index < piece.index && index > newestIndex) {
          newestIndex = index;
          newest = answer.text;
        }
      }
      const prompt = newest === '' ? undefined : lastSentence(newest, options.sentences);
      try {
        const answer = await transcribe(piece, { prompt, attempt, signal: options.signal });
        done.set(piece.index, { ...answer, attempts: attempt, startMs: piece.startMs });
        return;
      } catch (error) {
        lastError = error;
        if (state.interruption !== undefined || options.signal?.aborted) throw error;
      }
    }
    throw new PiecesFailed(piece.index, attempts, lastError);
  };

  /** Reports every piece now done in order. */
  const report = async (): Promise<void> => {
    while (state.interruption === undefined && order.length > 0 && done.has(order[0]!)) {
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
  let reporting = Promise.resolve();
  let iterator: Iterator<PieceInput> | AsyncIterator<PieceInput> | undefined;
  let exhausted = false;
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    options.signal?.throwIfAborted();
    iterator = Symbol.asyncIterator in pieces ? pieces[Symbol.asyncIterator]() : pieces[Symbol.iterator]();
    while (state.failure === null && state.interruption === undefined) {
      const next = await Promise.race([iterator.next(), stopped]);
      if (next === undefined) break;
      if (next.done) {
        exhausted = true;
        break;
      }
      if (state.failure !== null || state.interruption !== undefined) break;
      options.signal?.throwIfAborted();
      const piece = next.value;
      order.push(piece.index);
      const task = one(piece).catch((error: unknown) => {
        if (state.interruption !== undefined || options.signal?.aborted) return;
        const failed = error instanceof PiecesFailed ? error : new PiecesFailed(piece.index, attempts, error);
        // With several in flight the earliest piece that failed is the one named, so a run starts again from it.
        if (state.failure === null || failed.index < state.failure.index) state.failure = failed;
        wakeReader();
      }).then(() => {
        // Each completion schedules reporting independently of source reads; callbacks never overlap.
        reporting = reporting.then(report).catch(stop);
      });
      running.add(task);
      void task.finally(() => running.delete(task));
      if (running.size >= inFlight) await Promise.race([Promise.race(running), stopped]);
    }
  } catch (error) {
    stop(error);
  } finally {
    if (!exhausted) {
      try {
        // A generator's return can queue behind its pending next, so closing must not block failure cleanup.
        void Promise.resolve(iterator?.return?.()).catch(() => {});
      } catch {
        // Closing must not replace the original failure.
      }
    }
    await Promise.all(running);
    await reporting;
    options.signal?.removeEventListener('abort', onAbort);
  }
  if (state.interruption !== undefined) throw state.interruption.reason;
  options.signal?.throwIfAborted();
  if (state.failure !== null) throw state.failure;
  return { text: whole, pieces: outcomes, seconds: outcomes.reduce((sum, outcome) => sum + outcome.seconds, 0) };
}
