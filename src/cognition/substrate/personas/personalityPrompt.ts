/**
 * @module personas/personalityPrompt
 *
 * The personality section of a system prompt: one directive for each HEXACO trait whose value sits in the high or the
 * low band, under a fixed heading. `agent()` builds its system prompt with it, and a GMI whose host turned learning on
 * sends it as a system prompt of its own on every turn (docs/GMI.md, "Learning").
 */
import {
  HEXACO_TRAIT_ALIASES,
  HEXACO_TRAIT_KEYS,
  normalizeHexacoTraits,
  type HexacoTraitKey,
  type HexacoTraitValues,
} from './hexaco.js';

/** Where a trait value sits: `high` above 0.65, `low` below 0.35, `moderate` between them. */
export type TraitBand = 'low' | 'moderate' | 'high';

/** The register the host explicitly selects; conversation remains the default. */
export type PersonalityRegister = 'conversation' | 'writing';

/** The section's first line. */
export const PERSONALITY_SECTION_HEADING = '## Personality & Communication Style';

/**
 * The priority a GMI gives the section among its system prompts: after the persona's base prompt when it is a string
 * or a template, which has priority 1 (the prompt engine sorts ascending and keeps order among equals). The entries of
 * a base prompt given as a list keep their own priorities, so an entry above 2 comes after the section.
 */
export const PERSONALITY_PROMPT_PRIORITY = 2;

/**
 * The traits only the persona definition sets: no role overlay, tool or rule changes them. Frozen, since `readonly`
 * binds TypeScript callers only: no code in the process can remove a trait from it and so lift the overlay rule in
 * `applyTraitOverlay` or the refusal in `AdaptPersonalityTool`, which both read it.
 */
export const OPERATOR_ONLY_TRAITS: readonly HexacoTraitKey[] = Object.freeze<HexacoTraitKey[]>(['honesty', 'emotionality']);

const HIGH_ABOVE = 0.65;
const LOW_BELOW = 0.35;
/** A trait that rendered `high` last stays `high` above this value. */
const HIGH_HELD_ABOVE = 0.63;
/** A trait that rendered `low` last stays `low` below this value. */
const LOW_HELD_BELOW = 0.37;

const BAND_NAMES: readonly TraitBand[] = ['low', 'moderate', 'high'];

/**
 * The band a caller passed for a trait: the map's own property when it holds one of the three band names, else
 * nothing. A band read back from a stored row, or passed by a JavaScript caller, is not checked by the compiler.
 */
function passedBand(bands: Partial<Record<HexacoTraitKey, TraitBand>> | undefined, key: HexacoTraitKey): TraitBand | undefined {
  if (!bands || typeof bands !== 'object' || !Object.prototype.hasOwnProperty.call(bands, key)) return undefined;
  const band: unknown = bands[key];
  return BAND_NAMES.includes(band as TraitBand) ? (band as TraitBand) : undefined;
}

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

/** Writing changes presentation, never the source material. */
const WRITING_GROUNDING = 'Change only how grounded material is presented: its length, order, tone and stated open points; never change its meaning or introduce content, suggestions or facts absent from the material.';

/** Text directives for non-moderate traits, subject to WRITING_GROUNDING. */
const WRITING_DIRECTIVES: Record<HexacoTraitKey, { high: string; low: string }> = {
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
 *   trait rendered last). A trait with no entry takes the band of its value, and so does a trait whose entry is not
 *   the map's own property or not one of `high`, `low` and `moderate`.
 * @param options.register - Conversation when left out; writing prepends the grounding directive.
 * @returns The section, or `null` when every trait is moderate in either register.
 * @throws {TypeError} When `options.register` is given and is neither `conversation` nor `writing`.
 */
export function renderPersonalitySection(
  traits: unknown,
  options: { bands?: Partial<Record<HexacoTraitKey, TraitBand>>; register?: PersonalityRegister } = {},
): string | null {
  // The type binds TypeScript callers only: a JavaScript host's misspelled register would otherwise render the
  // conversation directives and drop the writing register's grounding rule without a word.
  const register: unknown = options.register;
  if (register !== undefined && register !== 'conversation' && register !== 'writing') {
    const shown = typeof register === 'string' ? `'${register}'` : String(register);
    throw new TypeError(
      `Unknown personality register ${shown}: pass 'conversation' or 'writing', or leave it out for conversation.`,
    );
  }
  const values = normalizeHexacoTraits(traits);
  const writing = register === 'writing';
  const directives = writing ? WRITING_DIRECTIVES : DIRECTIVES;
  const lines: string[] = [];
  for (const key of HEXACO_TRAIT_KEYS) {
    const band = passedBand(options.bands, key) ?? bandOf(values[key] ?? 0.5);
    if (band !== 'moderate') lines.push(directives[key][band]);
  }
  if (lines.length === 0) return null;
  if (writing) lines.unshift(WRITING_GROUNDING);
  return `${PERSONALITY_SECTION_HEADING}\n\n${lines.join('\n')}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';

/**
 * The patch a role overlay makes to a persona's traits: each trait whose value in the overlay-resolved persona
 * differs from the registry persona's. (`PersonaOverlayManager.resolvePersona` stores the whole merged trait map, so
 * the patch is read back as the difference.) A trait the overlay writes under an alias (`honestyHumility`,
 * `honesty_humility`, `opennessToExperience`) beside the persona's canonical key is read as a patch of that key.
 *
 * @param authored - The registry persona's `personalityTraits` as written, not normalized: an alias the persona writes
 *   itself beside its canonical key is then no patch.
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
  // The merged map keeps the persona's canonical key beside an alias the overlay wrote, and the normalizer reads the
  // canonical one, so an alias whose value the persona did not write is read here. A canonical key the overlay
  // changed keeps its value.
  const authoredMap = isRecord(authored) ? authored : {};
  const resolvedMap = isRecord(resolved) ? resolved : {};
  for (const [alias, canonical] of HEXACO_TRAIT_ALIASES) {
    const value = resolvedMap[alias];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (value === authoredMap[alias] || patch[canonical] !== undefined || value === base[canonical]) continue;
    patch[canonical] = value;
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
