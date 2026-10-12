/**
 * @file personalityPrompt.test.ts
 * The personality section's renderer: the bands and their hysteresis, the bands a caller passes in place of the
 * thresholds, the same bytes agent() sends, and the lock that keeps a role overlay off honesty-humility and
 * emotionality.
 */
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../../../api/agent';
import { HEXACO_TRAIT_KEYS, type HexacoTraitKey } from '../hexaco';
import {
  applyTraitOverlay,
  bandOf,
  droppedTraitPatchWarning,
  OPERATOR_ONLY_TRAITS,
  PERSONALITY_PROMPT_PRIORITY,
  PERSONALITY_SECTION_HEADING,
  renderPersonalitySection,
  traitOverlayPatch,
  type TraitBand,
} from '../personalityPrompt';

describe('bandOf', () => {
  it('enters a band at the plain threshold', () => {
    expect(bandOf(0.66)).toBe('high');
    expect(bandOf(0.65)).toBe('moderate');
    expect(bandOf(0.35)).toBe('moderate');
    expect(bandOf(0.34)).toBe('low');
    expect(bandOf(0.64, 'moderate')).toBe('moderate');
    expect(bandOf(0.36, 'moderate')).toBe('moderate');
  });

  it('leaves the band a trait rendered last only 0.02 past the threshold', () => {
    expect(bandOf(0.64, 'high')).toBe('high');
    expect(bandOf(0.63, 'high')).toBe('moderate');
    expect(bandOf(0.36, 'low')).toBe('low');
    expect(bandOf(0.37, 'low')).toBe('moderate');
    // The held band never reaches across: a high trait that falls below 0.35 is low.
    expect(bandOf(0.3, 'high')).toBe('low');
    expect(bandOf(0.7, 'low')).toBe('high');
  });

  it('reads a value that is not a finite number as 0.5', () => {
    expect(bandOf(Number.NaN)).toBe('moderate');
    expect(bandOf(Number.POSITIVE_INFINITY, 'high')).toBe('moderate');
  });
});

describe('renderPersonalitySection', () => {
  it('renders the bytes agent() sends for the same traits', () => {
    const traits = { honesty: 0.9, emotionality: 0.2, extraversion: 0.5, agreeableness: 0.7, conscientiousness: 0.1, openness: 0.66 };
    expect(renderPersonalitySection(traits)).toBe(buildSystemPrompt({ personality: traits }));
    expect(renderPersonalitySection({ honestyHumility: 0.9 })).toBe(buildSystemPrompt({ personality: { honestyHumility: 0.9 } }));
  });

  it('renders nothing when every trait is moderate, or when it is given no trait map', () => {
    expect(renderPersonalitySection({ honesty: 0.5, openness: 0.65 })).toBeNull();
    expect(renderPersonalitySection({})).toBeNull();
    expect(renderPersonalitySection(undefined)).toBeNull();
    expect(renderPersonalitySection('high')).toBeNull();
  });

  it('takes the band a caller passes in place of the one the value gives', () => {
    expect(renderPersonalitySection({ extraversion: 0.64 }, { bands: { extraversion: 'high' } })).toBe(
      renderPersonalitySection({ extraversion: 0.9 }),
    );
    expect(renderPersonalitySection({ extraversion: 0.9 }, { bands: { extraversion: 'moderate' } })).toBeNull();
    // A trait with no entry in `bands` takes the band of its value.
    expect(renderPersonalitySection({ extraversion: 0.9, openness: 0.1 }, { bands: { extraversion: 'moderate' } })).toBe(
      renderPersonalitySection({ openness: 0.1 }),
    );
  });

  it('starts with the heading and is 747 characters in its longest form, under the 900-character bound', () => {
    const bandsOf = (mask: number): Partial<Record<HexacoTraitKey, TraitBand>> => {
      const bands: Partial<Record<HexacoTraitKey, TraitBand>> = {};
      HEXACO_TRAIT_KEYS.forEach((key, i) => {
        bands[key] = (mask >> i) & 1 ? 'high' : 'low';
      });
      return bands;
    };
    let longest = 0;
    for (let mask = 0; mask < 64; mask += 1) {
      const section = renderPersonalitySection({}, { bands: bandsOf(mask) })!;
      expect(section.startsWith(`${PERSONALITY_SECTION_HEADING}\n\n`)).toBe(true);
      expect(section.split('\n')).toHaveLength(8);
      longest = Math.max(longest, section.length);
    }
    expect(longest).toBe(747);
  });

  it('sorts right after a base prompt of priority 1', () => {
    expect(PERSONALITY_PROMPT_PRIORITY).toBe(2);
  });
});

describe('a role overlay and the operator-only traits', () => {
  it('names honesty-humility and emotionality as the traits only the persona definition sets', () => {
    expect([...OPERATOR_ONLY_TRAITS]).toEqual(['honesty', 'emotionality']);
  });

  it('reads the patch as the traits the overlay changed, under canonical keys', () => {
    const authored = { honestyHumility: 0.8, extraversion: 0.5, openness: 0.4 };
    expect(traitOverlayPatch(authored, { ...authored, extraversion: 0.9, honesty: 0.2 })).toEqual({ honesty: 0.2, extraversion: 0.9 });
    expect(traitOverlayPatch(authored, { ...authored })).toBeUndefined();
    expect(traitOverlayPatch(authored, undefined)).toBeUndefined();
    // A trait the persona leaves out and the overlay sets is part of the patch.
    expect(traitOverlayPatch({}, { agreeableness: 0.7 })).toEqual({ agreeableness: 0.7 });
  });

  it('applies the patch to the four traits an overlay may set and reports the two it may not', () => {
    const authored = { honesty: 0.9, emotionality: 0.5, extraversion: 0.5 };
    const { traits, dropped } = applyTraitOverlay(authored, { honesty: 0.2, emotionality: 0.9, extraversion: 0.9, openness: 0.1 });
    expect(traits).toEqual({ honesty: 0.9, emotionality: 0.5, extraversion: 0.9, openness: 0.1 });
    expect(dropped).toEqual(['honesty', 'emotionality']);
    expect(authored).toEqual({ honesty: 0.9, emotionality: 0.5, extraversion: 0.5 });
    expect(applyTraitOverlay(authored, undefined)).toEqual({ traits: authored, dropped: [] });
  });

  it('says which persona and which traits a dropped patch named', () => {
    const warning = droppedTraitPatchWarning('reviewer', ['honesty']);
    expect(warning).toContain("persona 'reviewer'");
    expect(warning).toContain('honesty');
    expect(droppedTraitPatchWarning('reviewer', ['honesty', 'emotionality'])).toContain('honesty and emotionality');
  });
});
