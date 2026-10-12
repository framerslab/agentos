/**
 * @module personas/personalityPrompt
 *
 * The personality section of a system prompt: one directive for each HEXACO trait whose value sits in the high or the
 * low band, under a fixed heading. `agent()` builds its system prompt with it, and a GMI whose host turned learning on
 * sends it as a system prompt of its own on every turn (docs/GMI.md, "Learning").
 */
import { HEXACO_TRAIT_KEYS, normalizeHexacoTraits, type HexacoTraitKey, type HexacoTraitValues } from './hexaco.js';

/** Where a trait value sits: `high` above 0.65, `low` below 0.35, `moderate` between them. */
export type TraitBand = 'low' | 'moderate' | 'high';

/** The section's first line. */
export const PERSONALITY_SECTION_HEADING = '## Personality & Communication Style';

/**
 * The priority a GMI gives the section among its system prompts: right after the persona's base prompt, which has
 * priority 1 (the prompt engine sorts ascending and keeps order among equals).
 */
export const PERSONALITY_PROMPT_PRIORITY = 2;

/** The traits only the persona definition sets: no role overlay, tool or rule changes them. */
export const OPERATOR_ONLY_TRAITS: readonly HexacoTraitKey[] = ['honesty', 'emotionality'];

const HIGH_ABOVE = 0.65;
const LOW_BELOW = 0.35;
/** A trait that rendered `high` last stays `high` above this value. */
const HIGH_HELD_ABOVE = 0.63;
/** A trait that rendered `low` last stays `low` below this value. */
const LOW_HELD_BELOW = 0.37;

/** The directive each trait renders in its high and in its low band; a moderate trait renders nothing. */
const DIRECTIVES: Record<HexacoTraitKey, { high: string; low: string }> = {
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

/**
 * The band a trait value renders in.
 *
 * A value enters a band at the plain threshold: `high` above 0.65, `low` below 0.35. A trait that rendered a band last
 * leaves it only once the value has passed the threshold by 0.02: `high` holds down to 0.63 and `low` up to 0.37, so
 * a value that hovers at a threshold does not flip the text turn by turn. A value that is not a finite number reads
 * as 0.5.
 *
 * @param value - The trait value, from 0 to 1.
 * @param previous - The band the trait rendered last, when one is kept for it.
 */
export function bandOf(value: number, previous?: TraitBand): TraitBand {
  const v = Number.isFinite(value) ? value : 0.5;
  if (v > HIGH_ABOVE || (previous === 'high' && v > HIGH_HELD_ABOVE)) return 'high';
  if (v < LOW_BELOW || (previous === 'low' && v < LOW_HELD_BELOW)) return 'low';
  return 'moderate';
}

/**
 * Renders HEXACO trait values (0 to 1) as the personality section of a system prompt.
 *
 * Each trait in the high or the low band adds one directive, in the order honesty, emotionality, extraversion,
 * agreeableness, conscientiousness, openness; a moderate trait adds none. Trait keys are normalized first, so the
 * SOUL.md spelling `honestyHumility` reads as `honesty`, and a trait left out reads as 0.5.
 *
 * @param traits - A trait map under any accepted spelling; anything else renders nothing.
 * @param options.bands - The band to render per trait, in place of the one its value gives (the band a learner's
 *   trait rendered last). A trait with no entry takes the band of its value.
 * @returns The section, or `null` when every trait is moderate.
 */
export function renderPersonalitySection(
  traits: unknown,
  options: { bands?: Partial<Record<HexacoTraitKey, TraitBand>> } = {},
): string | null {
  const values = normalizeHexacoTraits(traits);
  const lines: string[] = [];
  for (const key of HEXACO_TRAIT_KEYS) {
    const band = options.bands?.[key] ?? bandOf(values[key] ?? 0.5);
    if (band !== 'moderate') lines.push(DIRECTIVES[key][band]);
  }
  if (lines.length === 0) return null;
  return `${PERSONALITY_SECTION_HEADING}\n\n${lines.join('\n')}`;
}

/**
 * The patch a role overlay makes to a persona's traits: each trait whose value in the overlay-resolved persona
 * differs from the registry persona's. (`PersonaOverlayManager.resolvePersona` stores the whole merged trait map, so
 * the patch is read back as the difference.)
 *
 * @param authored - The registry persona's `personalityTraits`.
 * @param resolved - The overlay-resolved persona's `personalityTraits`.
 * @returns The patched traits under canonical keys, or `undefined` when the overlay changes none.
 */
export function traitOverlayPatch(authored: unknown, resolved: unknown): HexacoTraitValues | undefined {
  const base = normalizeHexacoTraits(authored);
  const next = normalizeHexacoTraits(resolved);
  const patch: HexacoTraitValues = {};
  for (const key of HEXACO_TRAIT_KEYS) {
    const value = next[key];
    if (value !== undefined && value !== base[key]) patch[key] = value;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/**
 * The traits a session renders: the registry persona's, with a role overlay's patch on the traits an overlay may
 * set. Honesty-humility and emotionality always come from the registry persona.
 *
 * @param authored - The registry persona's traits.
 * @param overlay - The role overlay's patch ({@link traitOverlayPatch}), if any.
 * @returns The traits to render, and the operator-only traits the patch named, which were not applied.
 */
export function applyTraitOverlay(
  authored: unknown,
  overlay: unknown,
): { traits: HexacoTraitValues; dropped: HexacoTraitKey[] } {
  const traits: HexacoTraitValues = { ...normalizeHexacoTraits(authored) };
  const patch = normalizeHexacoTraits(overlay);
  const dropped: HexacoTraitKey[] = [];
  for (const key of HEXACO_TRAIT_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (OPERATOR_ONLY_TRAITS.includes(key)) dropped.push(key);
    else traits[key] = value;
  }
  return { traits, dropped };
}

/** The warning logged once for a role overlay whose patch names an operator-only trait. */
export function droppedTraitPatchWarning(personaId: string, dropped: readonly HexacoTraitKey[]): string {
  return (
    `A role overlay of persona '${personaId}' sets ${dropped.join(' and ')}, which only the persona definition sets; ` +
    `the overlay's value is not rendered.`
  );
}
