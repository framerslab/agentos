import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  bandOf,
  HEXACO_TRAIT_KEYS,
  NOTETAKER_PERSONA,
  OPERATOR_ONLY_TRAITS,
  normalizeHexacoTraits,
  renderPersonalitySection,
  type TraitBand,
  type PersonalityRegister,
  type HexacoTraitKey,
  type IPersonaDefinition,
} from '@framers/agentos/cognition/substrate';

const WRITING = [
  '## Personality & Communication Style',
  '',
  'Change only how grounded material is presented: its length, order, tone and stated open points; never change its meaning or introduce content, suggestions or facts absent from the material.',
  'State what was said and what is certain; mark what is inferred; no flattery and no softening',
  'Write plainly; no exclamation, no reassurance, no alarm',
  'Keep to the material; add nothing the speakers did not say',
  'Structure the text; complete lists; exact names, numbers and times as given',
].join('\n');

const CONVERSATION = [
  '## Personality & Communication Style',
  '',
  'Be straightforward and transparent. Avoid flattery, spin, or evasion. Acknowledge limitations directly.',
  'Maintain emotional composure. Be matter-of-fact and solution-oriented. Keep responses grounded and pragmatic.',
  'Be measured and reflective. Listen more than you speak. Respond thoughtfully rather than quickly. Prefer depth over breadth.',
  'Be thorough and systematic. Structure responses clearly. Follow through on details. Prefer precision over speed.',
].join('\n');

test('the package export resolves the built substrate entry', () => {
  const resolved = fileURLToPath(import.meta.resolve('@framers/agentos/cognition/substrate'));
  assert.match(resolved.replaceAll('\\', '/'), /\/dist\/cognition\/substrate\/index\.js$/);
});

test('the public values and normalization have the authored contract', () => {
  const key: HexacoTraitKey = 'conscientiousness';
  const definition: IPersonaDefinition = {
    id: 'public-entry-notetaker', name: 'Notetaker', description: 'Grounded meeting notes.',
    version: '1.0.0', baseSystemPrompt: 'Write only from the supplied material.',
    personalityTraits: { ...NOTETAKER_PERSONA },
  };
  const bands: Record<HexacoTraitKey, TraitBand> = {
    honesty: bandOf(NOTETAKER_PERSONA.honesty), emotionality: bandOf(NOTETAKER_PERSONA.emotionality),
    extraversion: bandOf(NOTETAKER_PERSONA.extraversion), agreeableness: bandOf(NOTETAKER_PERSONA.agreeableness),
    conscientiousness: bandOf(NOTETAKER_PERSONA.conscientiousness), openness: bandOf(NOTETAKER_PERSONA.openness),
  };
  assert.deepEqual(bands, { honesty: 'high', emotionality: 'low', extraversion: 'low',
    agreeableness: 'moderate', conscientiousness: 'high', openness: 'moderate' });
  assert.equal(bands[key], 'high');
  assert.equal(renderPersonalitySection(definition.personalityTraits, { bands, register: 'writing' }), WRITING);
  assert.equal(bandOf(0.35), 'moderate');
  assert.equal(bandOf(0.65), 'moderate');
  assert.equal(bandOf(0.64, 'high'), 'high');
  assert.equal(bandOf(0.36, 'low'), 'low');
  assert.equal(bandOf(Number.NaN), 'moderate');
  assert.deepEqual(HEXACO_TRAIT_KEYS, [
    'honesty', 'emotionality', 'extraversion', 'agreeableness', 'conscientiousness', 'openness',
  ]);
  assert.deepEqual(OPERATOR_ONLY_TRAITS, ['honesty', 'emotionality']);
  assert.deepEqual(NOTETAKER_PERSONA, {
    honesty: 0.8, emotionality: 0.25, extraversion: 0.3,
    agreeableness: 0.55, conscientiousness: 0.85, openness: 0.5,
  });
  assert.deepEqual(normalizeHexacoTraits({ honestyHumility: 0.8, honesty: 0.7, opennessToExperience: 0.5 }), {
    honesty: 0.7, openness: 0.5,
  });
});

test('both complete preset sections render through the public export', () => {
  const register: PersonalityRegister = 'writing';
  assert.equal(renderPersonalitySection(NOTETAKER_PERSONA, { register }), WRITING);
  assert.equal(renderPersonalitySection(NOTETAKER_PERSONA, { register: 'conversation' }), CONVERSATION);
  assert.equal(renderPersonalitySection(NOTETAKER_PERSONA), CONVERSATION);
});

test('the exported band type selects the moderate omission through built code', () => {
  const band: TraitBand = 'moderate';
  const rendered = renderPersonalitySection(NOTETAKER_PERSONA, {
    bands: { conscientiousness: band }, register: 'writing',
  });
  assert.equal(rendered, WRITING.split('\n').slice(0, -1).join('\n'));
});
