/**
 * @fileoverview Normalizes user feedback payloads into one polarity and a
 * cleaned set of fields for the GMI to record.
 *
 * Feedback reaches the substrate as a loose object. The public
 * `UserFeedbackPayload` carries a `rating` label and an optional numeric
 * `score`; older producers send a numeric `rating`, a `type` label, or a
 * `comment` in place of `text`. This module reads every one of those
 * spellings so the GMI and GMIManager work with a single shape.
 *
 * The module is pure and has no dependency on the API layer.
 *
 * @module agentos/cognitive_substrate/userFeedback
 */

/** Direction of a piece of user feedback. */
export type FeedbackPolarity = 'positive' | 'negative' | 'neutral';

/**
 * User feedback after normalization. Optional fields are absent when the raw
 * payload had no usable value for them.
 */
export interface NormalizedUserFeedback {
  /** Direction of the feedback. */
  polarity: FeedbackPolarity;
  /** Numeric rating on the 1 to 5 scale, when the payload carried one. */
  score?: number;
  /** Free-text comment from the user. */
  text?: string;
  /** The answer the user says the assistant should have given. */
  correctedContent?: string;
  /** Identifier of the message the feedback refers to. */
  targetMessageId?: string;
  /** Caller-supplied labels. */
  tags?: string[];
}

const POLARITY_LABELS: ReadonlySet<string> = new Set<string>(['positive', 'negative', 'neutral']);

/** Reads a polarity label, ignoring case and surrounding whitespace. */
function readPolarityLabel(value: unknown): FeedbackPolarity | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.trim().toLowerCase();
  return POLARITY_LABELS.has(label) ? (label as FeedbackPolarity) : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Maps a rating on the 1 to 5 scale to a polarity: 4 and above is positive,
 * 2 and below is negative, and anything in between is neutral.
 *
 * @param score - A finite rating on the 1 to 5 scale.
 * @returns The polarity the rating expresses.
 */
export function polarityFromScore(score: number): FeedbackPolarity {
  if (score >= 4) return 'positive';
  if (score <= 2) return 'negative';
  return 'neutral';
}

/**
 * Normalizes a raw feedback payload.
 *
 * Polarity is decided by the first rule that applies:
 * 1. A `positive`, `negative` or `neutral` label in `rating`, then in the
 *    legacy `type` field.
 * 2. A finite numeric `rating` (legacy) or `score`, read on the 1 to 5 scale
 *    by {@link polarityFromScore}.
 * 3. Otherwise the feedback is neutral.
 *
 * `text` falls back to the legacy `comment` field. `text`,
 * `correctedContent` and `targetMessageId` are kept only as non-empty trimmed
 * strings, and `tags` keeps only non-empty string entries.
 *
 * @param input - Raw feedback object, normally a `UserFeedbackPayload`.
 * @returns The normalized feedback.
 */
export function normalizeUserFeedback(
  input: Record<string, unknown> | null | undefined,
): NormalizedUserFeedback {
  const source: Record<string, unknown> = input && typeof input === 'object' ? input : {};

  const score = readFiniteNumber(source.rating) ?? readFiniteNumber(source.score);
  const polarity =
    readPolarityLabel(source.rating) ??
    readPolarityLabel(source.type) ??
    (score !== undefined ? polarityFromScore(score) : 'neutral');

  const normalized: NormalizedUserFeedback = { polarity };
  if (score !== undefined) normalized.score = score;

  const text = readNonEmptyString(source.text) ?? readNonEmptyString(source.comment);
  if (text) normalized.text = text;

  const correctedContent = readNonEmptyString(source.correctedContent);
  if (correctedContent) normalized.correctedContent = correctedContent;

  const targetMessageId = readNonEmptyString(source.targetMessageId);
  if (targetMessageId) normalized.targetMessageId = targetMessageId;

  if (Array.isArray(source.tags)) {
    const tags = source.tags
      .map((tag) => readNonEmptyString(tag))
      .filter((tag): tag is string => tag !== undefined);
    if (tags.length > 0) normalized.tags = tags;
  }

  return normalized;
}

/**
 * Reasoning-trace message used when feedback of the given polarity is
 * recorded. Negative feedback is phrased as flagged for review.
 *
 * @param polarity - Polarity of the recorded feedback.
 * @returns The trace message.
 */
export function feedbackTraceMessage(polarity: FeedbackPolarity): string {
  switch (polarity) {
    case 'negative':
      return 'Negative feedback recorded, flagged for review.';
    case 'positive':
      return 'Positive feedback recorded.';
    default:
      return 'Neutral feedback recorded.';
  }
}
