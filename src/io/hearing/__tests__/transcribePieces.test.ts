import { describe, expect, it, vi } from 'vitest';

import { mergeSeam, PiecesFailed, transcribePieces, type PieceInput } from '../transcribePieces.js';
import vectors from './fixtures/seam-vectors.json';

/** The grounding guard's rule, simplified: a sentence ends at . ! or ? followed by a space or the end. */
const sentences = (text: string) => {
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?](?=\s|$)/g)) {
    spans.push({ start, end: match.index + 1 });
    start = match.index + 2;
  }
  if (start < text.length) spans.push({ start, end: text.length });
  return spans;
};

const piece = (index: number): PieceInput => ({ index, startMs: index * 297_000, durationMs: 300_000, data: new Uint8Array([index]), mimeType: 'audio/mp4', fileName: `piece-${index}.m4a` });

/** Lets the job run on until it waits for a transcription: a timer fires only after every promise job queued before it. */
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('mergeSeam', () => {
  it.each(vectors as Array<{ previous: string; next: string; merged: string; why: string }>)('$why', ({ previous, next, merged }) => {
    expect(mergeSeam(previous, next)).toBe(merged);
  });
});

describe('transcribePieces', () => {
  it('sends the pieces in order with the last sentence before each as its prompt, and joins the seams', async () => {
    const texts = ['We meet in Lisbon. The hotel holds fourteen rooms', 'fourteen rooms until the twentieth. Maya owns the agenda.'];
    const transcribe = vi.fn(async (input: PieceInput, request: { prompt?: string }) => ({ text: texts[input.index]!, seconds: 300, prompt: request.prompt }));
    const result = await transcribePieces([piece(0), piece(1)], transcribe, { sentences });
    expect(transcribe.mock.calls.map((call) => call[1].prompt)).toEqual([undefined, 'The hotel holds fourteen rooms']);
    expect(result.text).toBe('We meet in Lisbon. The hotel holds fourteen rooms until the twentieth. Maya owns the agenda.');
    expect(result.pieces.map((outcome) => outcome.startMs)).toEqual([0, 297_000]);
  });

  it('tries a failed piece twice more and reports every attempt', async () => {
    let calls = 0;
    const transcribe = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('provider refused');
      return { text: 'Done.', seconds: 300 };
    });
    const result = await transcribePieces([piece(0)], transcribe, { sentences });
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(result.pieces[0]!.attempts).toBe(3);
  });

  it('stops at a piece that fails every attempt, naming it, with the pieces before it kept', async () => {
    const done: number[] = [];
    const transcribe = vi.fn(async (input: PieceInput) => {
      if (input.index === 1) throw new Error('provider refused');
      return { text: `Piece ${input.index}.`, seconds: 300 };
    });
    const run = transcribePieces([piece(0), piece(1), piece(2)], transcribe, { sentences, onPiece: (outcome) => void done.push(outcome.index) });
    await expect(run).rejects.toMatchObject({ name: 'PiecesFailed', index: 1 });
    expect(done).toEqual([0]);
  });

  it('with several in flight, names the earliest piece that failed with the error of its last attempt, and reports no piece after it', async () => {
    const refusals: Error[] = [];
    const done: number[] = [];
    const transcribe = async (input: PieceInput) => {
      if (input.index === 1) {
        // The earlier failure is the slower one: piece 3 has failed and piece 2 has answered before piece 1 gives up.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const refusal = new Error('provider refused');
        refusals.push(refusal);
        throw refusal;
      }
      if (input.index === 3) throw new Error('provider refused');
      return { text: `Piece ${input.index}.`, seconds: 300 };
    };
    const run = transcribePieces([piece(0), piece(1), piece(2), piece(3)], transcribe, { sentences, inFlight: 3, onPiece: (outcome) => void done.push(outcome.index) });
    const failed = await run.catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(PiecesFailed);
    expect(failed).toMatchObject({ name: 'PiecesFailed', index: 1, attempts: 3 });
    expect(refusals).toHaveLength(3);
    expect((failed as PiecesFailed).cause).toBe(refusals[2]);
    expect(done).toEqual([0]);
  });

  it('keeps at most inFlight pieces at once and reports them in order', async () => {
    let open = 0;
    let most = 0;
    const order: number[] = [];
    const transcribe = async (input: PieceInput) => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, input.index === 0 ? 30 : 5));
      open -= 1;
      return { text: `Piece ${input.index}.`, seconds: 300 };
    };
    await transcribePieces([piece(0), piece(1), piece(2), piece(3)], transcribe, { sentences, inFlight: 2, onPiece: (outcome) => void order.push(outcome.index) });
    expect(most).toBe(2);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('takes the prompt from the latest piece of the recording that is done, not from the last to answer', async () => {
    const answer = new Map<number, () => void>();
    const prompts: Array<string | undefined> = [];
    const transcribe = (input: PieceInput, request: { prompt?: string }) => {
      prompts[input.index] = request.prompt;
      return new Promise<{ text: string; seconds: number }>((resolve) => {
        answer.set(input.index, () => resolve({ text: `Piece ${input.index}.`, seconds: 300 }));
      });
    };
    const run = transcribePieces([piece(0), piece(1), piece(2), piece(3)], transcribe, { sentences, inFlight: 2 });
    await turn(); // pieces 0 and 1 are out
    answer.get(1)!(); // piece 1 answers first
    await turn(); // piece 2 goes out with piece 1's sentence
    answer.get(0)!(); // piece 0 answers after piece 1 has
    await turn(); // piece 3 goes out while piece 2 is still out
    answer.get(2)!();
    answer.get(3)!();
    await run;
    expect(prompts).toEqual([undefined, undefined, 'Piece 1.', 'Piece 1.']);
  });

  it('starts again from a piece, with the text before it as its context', async () => {
    const transcribe = vi.fn(async (_input: PieceInput, request: { prompt?: string }) => ({ text: 'and the flights.', seconds: 300, prompt: request.prompt }));
    const result = await transcribePieces([piece(2)], transcribe, { sentences, previousText: 'We approved the budget.' });
    expect(transcribe.mock.calls[0]![1].prompt).toBe('We approved the budget.');
    expect(result.pieces[0]!.index).toBe(2);
  });

  it('stops when its signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(transcribePieces([piece(0)], async () => ({ text: 'x', seconds: 1 }), { sentences, signal: controller.signal })).rejects.toThrow();
  });
});
