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
 * `maxChars` (the prompt assembler, when a trace does not fit what is left
 * of its section's budget) gets a shortened line: the content is cut at a
 * word boundary so the whole line fits `maxChars`, and ends with
 * {@link MEMORY_CUT_MARKER}.
 *
 * Each line carries the trace's age and the UTC calendar date it was stored:
 * `just now`, `Nm ago`, `Nh ago` and `Nd ago` under a week, `N days ago`
 * from a week on, followed by `, YYYY-MM-DD` (for example
 * `26 days ago, 2026-10-13`).
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
   * empty string. Omitted: the content is rendered whole.
   */
  maxChars?: number;
  /** The time ages are measured from, in epoch ms. Defaults to `Date.now()`. */
  now?: number;
}

/** Ends the content of a trace the formatter had to cut to fit a budget. */
export const MEMORY_CUT_MARKER = ' …[cut]';

/** The least content, in characters, worth keeping when a trace is cut. */
export const MIN_CUT_CONTENT_CHARS = 40;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;

/**
 * The age of a timestamp: `just now`, `Nm ago`, `Nh ago`, `Nd ago` under a
 * week, and `N days ago` from a week on, so a model can count days.
 */
function timeAgo(timestampMs: number, now: number): string {
  const elapsed = now - timestampMs;
  const minutes = Math.floor(elapsed / MINUTE_MS);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
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

/** The age of a trace with the date it was stored beside it: `26 days ago, 2026-10-13`. */
function when(trace: FormatTrace, now: number): string {
  const age = timeAgo(trace.createdAt, now);
  const date = calendarDate(trace.createdAt);
  return date ? `${age}, ${date}` : age;
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
 * The first `maxChars` characters of `content` or fewer, ending at a word
 * boundary when one falls in the second half of that span.
 */
function cutAtWordBoundary(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const span = content.slice(0, maxChars + 1);
  const lastSpace = span.search(/\s\S*$/);
  const cut = lastSpace > maxChars / 2 ? span.slice(0, lastSpace) : content.slice(0, maxChars);
  return cut.trimEnd();
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
 * The content is rendered whole unless `options.maxChars` is smaller than the
 * whole line; then the content is cut at a word boundary so the line fits and
 * ends with {@link MEMORY_CUT_MARKER}, or the result is `''` when the cut
 * would keep fewer than {@link MIN_CUT_CONTENT_CHARS} characters of content.
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

  const room = Math.floor(maxChars) - bare - MEMORY_CUT_MARKER.length;
  if (room < MIN_CUT_CONTENT_CHARS) return '';
  const cut = cutAtWordBoundary(trace.content, room);
  if (cut.length < MIN_CUT_CONTENT_CHARS) return '';
  return render(trace, style, `${cut}${MEMORY_CUT_MARKER}`, now);
}

/**
 * Format multiple traces with a separator appropriate for the style.
 */
export function formatMemoryTraces(
  traces: FormatTrace[],
  style: FormattingStyle,
  options: Pick<FormatMemoryTraceOptions, 'now'> = {},
): string {
  return traces.map((t) => formatMemoryTrace(t, style, options)).join('\n');
}
