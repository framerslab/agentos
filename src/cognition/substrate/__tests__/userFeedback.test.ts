/**
 * @file userFeedback.test.ts
 * Edge cases of the feedback normalizer: label precedence, the 1 to 5 score
 * boundaries, legacy field names, and dropping unusable values.
 */
import { describe, expect, it } from 'vitest';
import { normalizeUserFeedback, type NormalizedUserFeedback } from '../userFeedback';

describe('normalizeUserFeedback', () => {
  it.each<[string, Record<string, unknown>, NormalizedUserFeedback]>([
    ['a rating label beats a numeric score', { rating: 'negative', score: 5 }, { polarity: 'negative', score: 5 }],
    ['a score of 4 is positive', { score: 4 }, { polarity: 'positive', score: 4 }],
    ['a score of 3 is neutral', { score: 3 }, { polarity: 'neutral', score: 3 }],
    ['a score of 2 is negative', { score: 2 }, { polarity: 'negative', score: 2 }],
    ['a legacy numeric rating uses the same scale', { rating: 5 }, { polarity: 'positive', score: 5 }],
    ['a NaN score is ignored', { score: Number.NaN }, { polarity: 'neutral' }],
    ['labels ignore case and whitespace', { rating: ' Positive ' }, { polarity: 'positive' }],
    ['an unknown label falls back to the score', { rating: 'great', score: 1 }, { polarity: 'negative', score: 1 }],
    ['the legacy comment field fills text', { comment: '  Too long  ' }, { polarity: 'neutral', text: 'Too long' }],
    [
      'blank correction and target fields are dropped',
      { rating: 'negative', correctedContent: '   ', targetMessageId: '' },
      { polarity: 'negative' },
    ],
    [
      'tags keep only non-empty strings',
      { tags: ['clarity', 3, '', null, ' tone '] },
      { polarity: 'neutral', tags: ['clarity', 'tone'] },
    ],
  ])('%s', (_name, input, expected) => {
    expect(normalizeUserFeedback(input)).toStrictEqual(expected);
  });

  it('treats a missing payload as neutral', () => {
    expect(normalizeUserFeedback(undefined)).toStrictEqual({ polarity: 'neutral' });
  });
});
