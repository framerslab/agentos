/** Pure speaker rules shared by providers, hosts and browser consumers. */
import type { TranscriptEvent, TranscriptWord } from './types.js';

/**
 * The raw label only when every word names the same voice. A requested line
 * with mixed or absent word labels answers null; an unrequested one answers
 * undefined. This rule does not alter the orchestrator's speaker selection.
 */
export function lineSpeaker(
  words: readonly TranscriptWord[] | undefined,
  diarized: boolean,
): string | null | undefined {
  if (diarized === false) return undefined;
  const first = words?.[0]?.speaker;
  if (first === undefined) return null;
  return words?.every((word) => word.speaker === first) ? first : null;
}

/** One contiguous run of raw provider words. */
interface SpeakerRun {
  /** A raw word label or the absence of a known voice. */
  speaker: string | null;
  /** The words in their original order. */
  words: TranscriptWord[];
}

/**
 * Splits a keyed, diarized final into consecutive word runs. The first keeps
 * its id and later runs use `.2`, `.3` and `runOf`. Their times are the first
 * and last word times in milliseconds. Word tokens already carry provider
 * punctuation. A Deepgram id scopes raw labels with its connection prefix;
 * other ids retain raw labels. Interims, unrequested events, unkeyed events,
 * existing child runs and homogeneous finals are returned unchanged.
 */
export function splitFinalBySpeaker(event: TranscriptEvent): TranscriptEvent[] {
  const itemId = event.itemId;
  if (event.isFinal === false || itemId === undefined || itemId === '') return [event];
  if (event.speaker === undefined || typeof event.runOf === 'string') return [event];
  const groups: SpeakerRun[] = [];
  for (const word of event.words) {
    const speaker = word.speaker ?? null;
    const last = groups.at(-1);
    if (last && last.speaker === speaker) last.words.push(word);
    else groups.push({ speaker, words: [word] });
  }
  if (groups.length <= 1) return [event];
  const colon = itemId.lastIndexOf(':');
  const scope = colon > 0 ? itemId.slice(0, colon + 1) : '';
  return groups.map((group, index) => {
    const first = group.words[0];
    const last = group.words.at(-1);
    if (first === undefined || last === undefined) throw new Error('empty speaker run');
    return {
      ...event,
      itemId: index === 0 ? itemId : `${itemId}.${index + 1}`,
      ...(index === 0 ? {} : { runOf: itemId }),
      speaker: group.speaker === null ? null : `${scope}${group.speaker}`,
      text: group.words.map((word) => word.word).join(' '),
      words: group.words,
      startMs: first.start,
      endMs: last.end,
      durationMs: last.end - first.start,
    };
  });
}
