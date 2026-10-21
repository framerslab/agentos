import { describe, expect, it } from 'vitest';
import { HEXACO_TRAIT_KEYS, type HexacoTraitKey } from '../hexaco.js';
import { NOTETAKER_PERSONA } from '../notetaker.js';
import { renderPersonalitySection, type PersonalityRegister, type TraitBand } from '../personalityPrompt.js';

const HEADING = '## Personality & Communication Style';
const GROUNDING = 'Change only how grounded material is presented: its length, order, tone and stated open points; never change its meaning or introduce content, suggestions or facts absent from the material.';

const CONVERSATION: Record<HexacoTraitKey, { high: string; low: string }> = {
  honesty: {
    high: 'Be straightforward and transparent. Avoid flattery, spin, or evasion. Acknowledge limitations directly.',
    low: 'Be strategically diplomatic. Frame information to serve the conversation goal. Emphasize advantages.',
  },
  emotionality: {
    high: 'Respond with emotional awareness and empathy. Acknowledge feelings in the conversation. Express concern when appropriate.',
    low: 'Maintain emotional composure. Be matter-of-fact and solution-oriented. Keep responses grounded and pragmatic.',
  },
  extraversion: {
    high: 'Be energetic and engaging. Use vivid language. Take initiative in the conversation. Offer suggestions proactively.',
    low: 'Be measured and reflective. Listen more than you speak. Respond thoughtfully rather than quickly. Prefer depth over breadth.',
  },
  agreeableness: {
    high: 'Prioritize harmony and cooperation. Validate the other perspective before offering alternatives. Be supportive and encouraging.',
    low: 'Be direct and challenge-oriented. Question assumptions. Prioritize accuracy over comfort. Push back when something seems wrong.',
  },
  conscientiousness: {
    high: 'Be thorough and systematic. Structure responses clearly. Follow through on details. Prefer precision over speed.',
    low: 'Be flexible and adaptive. Prioritize the big picture over details. Respond quickly. Tolerate ambiguity and improvise.',
  },
  openness: {
    high: 'Explore creative angles and unconventional ideas. Draw unexpected connections. Question established approaches.',
    low: 'Stick to proven approaches and established knowledge. Be practical and concrete. Favor reliability over novelty.',
  },
};

const WRITING: Record<HexacoTraitKey, { high: string; low: string }> = {
  honesty: {
    high: 'State what was said and what is certain; mark what is inferred; no flattery and no softening',
    low: 'Use diplomatic phrasing for the stated material; keep its qualifications and limits visible',
  },
  emotionality: {
    high: 'Describe feelings expressed in the material with care; keep their attribution and intensity as given',
    low: 'Write plainly; no exclamation, no reassurance, no alarm',
  },
  extraversion: {
    high: 'Use engaging phrasing; point out the material\'s open questions and action items without an owner; offer no suggestions of your own',
    low: 'Keep to the material; add nothing the speakers did not say',
  },
  agreeableness: {
    high: 'Use supportive phrasing for the stated perspectives; preserve disagreement and uncertainty',
    low: 'State disagreements and questioned assumptions directly when they are in the material; prefer accuracy to comfort',
  },
  conscientiousness: {
    high: 'Structure the text; complete lists; exact names, numbers and times as given',
    low: 'Keep the text brief; put the stated main points first; leave ambiguity explicit and never fill gaps',
  },
  openness: {
    high: 'Show connections supported by the material; label inferences and keep them distinct from what was said',
    low: 'Use concrete phrasing for established points in the material; preserve the stated evidence and limits',
  },
};

const BANDS: readonly TraitBand[] = ['low', 'moderate', 'high'];
const PRESET_CONVERSATION = [
  HEADING,
  '',
  'Be straightforward and transparent. Avoid flattery, spin, or evasion. Acknowledge limitations directly.',
  'Maintain emotional composure. Be matter-of-fact and solution-oriented. Keep responses grounded and pragmatic.',
  'Be measured and reflective. Listen more than you speak. Respond thoughtfully rather than quickly. Prefer depth over breadth.',
  'Be thorough and systematic. Structure responses clearly. Follow through on details. Prefer precision over speed.',
].join('\n');
const PRESET_WRITING = [
  HEADING,
  '',
  GROUNDING,
  'State what was said and what is certain; mark what is inferred; no flattery and no softening',
  'Write plainly; no exclamation, no reassurance, no alarm',
  'Keep to the material; add nothing the speakers did not say',
  'Structure the text; complete lists; exact names, numbers and times as given',
].join('\n');

describe('writing and conversation registers', () => {
  for (const trait of HEXACO_TRAIT_KEYS) {
    for (const band of BANDS) {
      it(`pins ${trait} at ${band} in both registers`, () => {
        const bands = { [trait]: band };
        const spoken = renderPersonalitySection({}, { bands, register: 'conversation' });
        const written = renderPersonalitySection({}, { bands, register: 'writing' });
        if (band === 'moderate') {
          expect(spoken).toBeNull();
          expect(written).toBeNull();
        } else {
          expect(spoken).toBe(`${HEADING}\n\n${CONVERSATION[trait][band]}`);
          expect(written).toBe(`${HEADING}\n\n${GROUNDING}\n${WRITING[trait][band]}`);
        }
        expect(renderPersonalitySection({}, { bands })).toBe(spoken);
      });
    }
  }

  it('pins all six preset values and both complete sections', () => {
    expect(NOTETAKER_PERSONA).toEqual({
      honesty: 0.8,
      emotionality: 0.25,
      extraversion: 0.3,
      agreeableness: 0.55,
      conscientiousness: 0.85,
      openness: 0.5,
    });
    expect(Object.isFrozen(NOTETAKER_PERSONA)).toBe(true);
    expect(renderPersonalitySection(NOTETAKER_PERSONA)).toBe(PRESET_CONVERSATION);
    expect(renderPersonalitySection(NOTETAKER_PERSONA, { register: 'conversation' })).toBe(PRESET_CONVERSATION);
    expect(renderPersonalitySection(NOTETAKER_PERSONA, { register: 'writing' })).toBe(PRESET_WRITING);
  });

  it('renders the low Rigour line and omits only the moderate line', () => {
    expect(renderPersonalitySection(NOTETAKER_PERSONA, {
      bands: { conscientiousness: 'low' }, register: 'writing',
    })).toBe([
      HEADING, '', GROUNDING,
      'State what was said and what is certain; mark what is inferred; no flattery and no softening',
      'Write plainly; no exclamation, no reassurance, no alarm',
      'Keep to the material; add nothing the speakers did not say',
      'Keep the text brief; put the stated main points first; leave ambiguity explicit and never fill gaps',
    ].join('\n'));
    expect(renderPersonalitySection(NOTETAKER_PERSONA, {
      bands: { conscientiousness: 'moderate' }, register: 'writing',
    })).toBe([
      HEADING, '', GROUNDING,
      'State what was said and what is certain; mark what is inferred; no flattery and no softening',
      'Write plainly; no exclamation, no reassurance, no alarm',
      'Keep to the material; add nothing the speakers did not say',
    ].join('\n'));
  });

  it('keeps canonical ordering and places grounding before every writing line', () => {
    const bands: Partial<Record<HexacoTraitKey, TraitBand>> = {};
    for (const key of [...HEXACO_TRAIT_KEYS].reverse()) bands[key] = 'high';
    expect(renderPersonalitySection({}, { bands, register: 'writing' })).toBe(
      [HEADING, '', GROUNDING, ...HEXACO_TRAIT_KEYS.map((key) => WRITING[key].high)].join('\n'),
    );
    expect(renderPersonalitySection({}, { bands, register: 'conversation' })).toBe(
      [HEADING, '', ...HEXACO_TRAIT_KEYS.map((key) => CONVERSATION[key].high)].join('\n'),
    );
  });

  it('normalizes aliases and leaves absent or all-moderate traits empty', () => {
    expect(renderPersonalitySection({ honestyHumility: 0.8 }, { register: 'writing' })).toBe(
      `${HEADING}\n\n${GROUNDING}\n${WRITING.honesty.high}`,
    );
    for (const traits of [undefined, null, 'high', {}, { honesty: 0.5, openness: 0.65 }]) {
      expect(renderPersonalitySection(traits, { register: 'writing' })).toBeNull();
      expect(renderPersonalitySection(traits, { register: 'conversation' })).toBeNull();
    }
  });

  it('renders conversation for a register left out and refuses any other register', () => {
    expect(renderPersonalitySection(NOTETAKER_PERSONA, { register: undefined })).toBe(PRESET_CONVERSATION);
    // A JavaScript host is not held to the type: a misspelled register must not render without the grounding rule.
    for (const register of ['Writing', 'written', 'writing ', '', null, 0, {}]) {
      expect(() => renderPersonalitySection(NOTETAKER_PERSONA, { register: register as unknown as PersonalityRegister }))
        .toThrow(TypeError);
    }
    // Refused before the traits are read, so a section that would be empty is refused too.
    expect(() => renderPersonalitySection({}, { register: 'Writing' as unknown as PersonalityRegister })).toThrow(
      "Unknown personality register 'Writing': pass 'conversation' or 'writing', or leave it out for conversation.",
    );
  });
});
