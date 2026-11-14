/**
 * @fileoverview Personality-specific memory formatting.
 *
 * Formats MemoryTrace objects into text appropriate for prompt injection,
 * with style adapted to the agent's personality:
 * - **structured** (high conscientiousness): bullet lists with metadata
 * - **narrative** (high openness): flowing prose with associations
 * - **emotional** (high emotionality): includes emotional context annotations
 *
 * A trace's content is rendered whole. Only a caller that passes
 * `maxChars` gets a shortened line: the content is cut at a word boundary so
 * the whole line fits `maxChars`, and ends with {@link MEMORY_CUT_MARKER}. A
 * cut never splits a surrogate pair. The cut form is for callers outside the
 * memory block: the prompt assembler passes no `maxChars`, and shows a trace
 * whole or leaves it out.
 *
 * Each line carries the trace's age and the UTC calendar date it was stored:
 * `just now`, `Nm ago` and `Nh ago` under a day; from a day on, the number of
 * UTC calendar days between the stored date and the date of `now`, as `Nd ago`
 * under a week and `N days ago` from a week on; then `, YYYY-MM-DD` (for
 * example `26 days ago, 2026-10-13`). Counted in calendar days, the age
 * always agrees with the printed date.
 *
 * @module agentos/memory/prompt/MemoryFormatters
 */

import type { MemoryTrace, ScoredMemoryTrace } from '../types.js';

export type FormattingStyle = 'structured' | 'narrative' | 'emotional';
type FormatTrace = MemoryTrace & Partial<Pick<ScoredMemoryTrace, 'retrievalScore'>>;

/** Options for {@link formatMemoryTrace}. */
export interface FormatMemoryTraceOptions {
  /**
   * The longest line, in characters, the caller has room for. When the whole
   * line is longer, the content is cut at a word boundary to fit and ends with
   * {@link MEMORY_CUT_MARKER}; when even a short cut does not fit
   * ({@link MIN_CUT_CONTENT_CHARS} characters of content), the result is the
   * empty string. Omitted: the content is rendered whole. The memory block
   * never passes it: no line of the block is a trace cut to fit.
   */
  maxChars?: number;
  /** The time ages are measured from, in epoch ms. Defaults to `Date.now()`. */
  now?: number;
}

/** Ends the content of a trace the formatter cut to fit a caller's `maxChars`. No line of the memory block carries it. */
export const MEMORY_CUT_MARKER = ' …[cut]';

/** The least content, in characters, worth keeping when a trace is cut. */
export const MIN_CUT_CONTENT_CHARS = 40;

/** Starts the content of a line that shows the agent's own earlier reply in the memory block. */
export const OWN_WORDS_PREFIX = 'You said: ';

/**
 * `trace` as the memory block shows it. A trace with sourceType `agent_inference` holds the agent's own words: a GMI
 * files each reply that way, as a semantic trace, and earlier versions filed it the same way. The block shows it as a
 * past exchange, never as a fact: an episodic trace whose content starts with {@link OWN_WORDS_PREFIX}. Every other
 * trace is returned as it is. The trace in the store is not changed.
 */
export function asShownInMemoryBlock<T extends MemoryTrace>(trace: T): T {
  if (trace.provenance?.sourceType !== 'agent_inference') return trace;
  return { ...trace, type: 'episodic', content: `${OWN_WORDS_PREFIX}${trace.content}` };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The age of a timestamp: `just now`, `Nm ago` and `Nh ago` under a day; from
 * a day on, the UTC calendar days between the timestamp's date and `now`'s
 * date, as `Nd ago` under a week and `N days ago` from a week on, so a model
 * can count days and the age agrees with the date printed beside it.
 */
function timeAgo(timestampMs: number, now: number): string {
  const elapsed = now - timestampMs;
  const minutes = Math.floor(elapsed / MINUTE_MS);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(now / DAY_MS) - Math.floor(timestampMs / DAY_MS);
  if (days < 7) return `${days}d ago`;
  return `${days} days ago`;
}

/**
 * The UTC calendar date (YYYY-MM-DD) of a timestamp, or undefined when it has
 * none or lies outside the range a Date can hold (toISOString would throw).
 */
function calendarDate(timestampMs: number): string | undefined {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return undefined;
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

/**
 * The age of a timestamp with its UTC calendar date beside it, as the memory block dates a recalled trace:
 * `26 days ago, 2026-10-13`, or the age alone when the timestamp has no date.
 *
 * @param timestampMs - When the trace was stored, in epoch ms.
 * @param now - The time the age is measured from, in epoch ms.
 * @returns The age and the date.
 */
export function formatMemoryAge(timestampMs: number, now: number): string {
  const age = timeAgo(timestampMs, now);
  const date = calendarDate(timestampMs);
  return date ? `${age}, ${date}` : age;
}

/** The age of a trace with the date it was stored beside it: `26 days ago, 2026-10-13`. */
function when(trace: FormatTrace, now: number): string {
  return formatMemoryAge(trace.createdAt, now);
}

function confidenceLabel(confidence: number): string {
  if (confidence > 0.8) return 'high confidence';
  if (confidence > 0.5) return 'moderate confidence';
  return 'low confidence';
}

function valenceEmoji(valence: number): string {
  if (valence > 0.3) return '(+)';
  if (valence < -0.3) return '(-)';
  return '(~)';
}

/**
 * The first `maxChars` UTF-16 code units of `text`, one fewer when the last
 * would be the first half of a surrogate pair, so a cut never leaves a lone
 * surrogate.
 */
export function sliceWholeCodePoints(text: string, maxChars: number): string {
  const end = Math.max(0, Math.floor(maxChars));
  if (end >= text.length) return text;
  const last = text.charCodeAt(end - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, end - 1) : text.slice(0, end);
}

/**
 * The first `maxChars` characters of `content` or fewer, ending at a word
 * boundary when one falls in the second half of that span, and never inside
 * a surrogate pair.
 */
function cutAtWordBoundary(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const span = content.slice(0, maxChars + 1);
  const lastSpace = span.search(/\s\S*$/);
  const cut = lastSpace > maxChars / 2 ? span.slice(0, lastSpace) : sliceWholeCodePoints(content, maxChars);
  return cut.trimEnd();
}

/**
 * `content` cut at a word boundary so that it and {@link MEMORY_CUT_MARKER}
 * fit `maxChars`, ending with the marker; `''` when the cut would keep fewer
 * than {@link MIN_CUT_CONTENT_CHARS} characters.
 */
export function cutMemoryContent(content: string, maxChars: number): string {
  const room = Math.floor(maxChars) - MEMORY_CUT_MARKER.length;
  if (room < MIN_CUT_CONTENT_CHARS) return '';
  const cut = cutAtWordBoundary(content, room);
  if (cut.length < MIN_CUT_CONTENT_CHARS) return '';
  return `${cut}${MEMORY_CUT_MARKER}`;
}

// ---------------------------------------------------------------------------
// Formatters (each renders the content it is given, whole)
// ---------------------------------------------------------------------------

function formatStructured(trace: FormatTrace, content: string, now: number): string {
  const parts = [`- [${trace.type}]`, content];

  const meta: string[] = [];
  meta.push(when(trace, now));
  meta.push(confidenceLabel(trace.provenance.confidence));
  meta.push(`relevance: ${(trace.retrievalScore ?? trace.provenance.confidence).toFixed(2)}`);
  if (trace.tags.length > 0) {
    meta.push(`tags: ${trace.tags.slice(0, 3).join(', ')}`);
  }

  parts.push(`(${meta.join(' | ')})`);
  return parts.join(' ');
}

function formatNarrative(trace: FormatTrace, content: string, now: number): string {
  let text = `${when(trace, now)}: ${content}`;
  if (trace.associatedTraceIds.length > 0) {
    text += ` [linked to ${trace.associatedTraceIds.length} other memories]`;
  }
  if (trace.entities.length > 0) {
    text += ` (involves: ${trace.entities.slice(0, 3).join(', ')})`;
  }
  return text;
}

function formatEmotional(trace: FormatTrace, content: string, now: number): string {
  const emoji = valenceEmoji(trace.emotionalContext.valence);
  const intensity = trace.emotionalContext.intensity;

  let text = `${emoji} ${when(trace, now)}: ${content}`;
  if (intensity > 0.6) {
    text += ` [strongly felt, mood: ${trace.emotionalContext.gmiMood}]`;
  } else if (intensity > 0.3) {
    text += ` [mood: ${trace.emotionalContext.gmiMood}]`;
  }
  return text;
}

function render(trace: FormatTrace, style: FormattingStyle, content: string, now: number): string {
  switch (style) {
    case 'narrative':
      return formatNarrative(trace, content, now);
    case 'emotional':
      return formatEmotional(trace, content, now);
    case 'structured':
    default:
      return formatStructured(trace, content, now);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The length, in characters, of the line {@link formatMemoryTrace} renders for
 * a trace whole, without building it.
 */
export function memoryTraceLineLength(
  trace: FormatTrace,
  style: FormattingStyle,
  options: Pick<FormatMemoryTraceOptions, 'now'> = {},
): number {
  return render(trace, style, '', options.now ?? Date.now()).length + trace.content.length;
}

/**
 * Format a single memory trace according to the given style.
 *
 * Without `options.maxChars` the line carries the trace's whole content,
 * however long. Versions through 0.15.120 cut the content to about 300
 * characters (350 in the narrative style); a caller that relied on that bound
 * passes `maxChars`.
 *
 * With `options.maxChars` smaller than the whole line, the content is cut at
 * a word boundary (never inside a surrogate pair) so the line fits and ends
 * with {@link MEMORY_CUT_MARKER}, or the result is `''` when the cut would
 * keep fewer than {@link MIN_CUT_CONTENT_CHARS} characters of content.
 */
export function formatMemoryTrace(
  trace: FormatTrace,
  style: FormattingStyle,
  options: FormatMemoryTraceOptions = {},
): string {
  const now = options.now ?? Date.now();
  const { maxChars } = options;
  if (maxChars === undefined) return render(trace, style, trace.content, now);

  const bare = render(trace, style, '', now).length;
  if (bare + trace.content.length <= maxChars) return render(trace, style, trace.content, now);

  const cut = cutMemoryContent(trace.content, Math.floor(maxChars) - bare);
  if (!cut) return '';
  return render(trace, style, cut, now);
}

/**
 * Format multiple traces, one line each, joined with newlines.
 *
 * Each line carries its trace's whole content, however long. Versions through
 * 0.15.120 cut each to about 300 characters (350 in the narrative style); a
 * caller that needs a bound calls {@link formatMemoryTrace} with `maxChars`.
 */
export function formatMemoryTraces(
  traces: FormatTrace[],
  style: FormattingStyle,
  options: Pick<FormatMemoryTraceOptions, 'now'> = {},
): string {
  return traces.map((t) => formatMemoryTrace(t, style, options)).join('\n');
}
