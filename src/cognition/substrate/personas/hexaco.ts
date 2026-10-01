/**
 * @fileoverview Canonical HEXACO trait keys and a normalizer that maps the
 * other spellings used across AgentOS onto them.
 *
 * Runtime readers (agent() personality prompts, AdaptPersonalityTool, the
 * cognitive memory `HexacoTraits`, PersonaDriftMechanism) key the
 * Honesty-Humility trait as `honesty`. SOUL.md frontmatter documents it as
 * `honestyHumility`, and some configs use `honesty_humility` or
 * `opennessToExperience`. {@link normalizeHexacoTraits} is the single place
 * that reconciles them.
 *
 * @module agentos/cognitive_substrate/personas/hexaco
 */

/** The six HEXACO dimensions under the key names runtime readers use. */
export const HEXACO_TRAIT_KEYS = [
  'honesty',
  'emotionality',
  'extraversion',
  'agreeableness',
  'conscientiousness',
  'openness',
] as const;

/** Canonical name of one HEXACO dimension. */
export type HexacoTraitKey = (typeof HEXACO_TRAIT_KEYS)[number];

/** HEXACO scores under canonical keys. Every key is optional. */
export type HexacoTraitValues = Partial<Record<HexacoTraitKey, number>>;

/** Alternate spellings accepted on input, mapped to their canonical key. */
const HEXACO_TRAIT_ALIASES: ReadonlyArray<readonly [alias: string, canonical: HexacoTraitKey]> = [
  ['honestyHumility', 'honesty'],
  ['honesty_humility', 'honesty'],
  ['opennessToExperience', 'openness'],
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Reads HEXACO scores from a trait map under any accepted spelling and
 * returns them under canonical keys.
 *
 * - `honestyHumility` and `honesty_humility` map to `honesty`;
 *   `opennessToExperience` maps to `openness`.
 * - When a canonical key and an alias are both present, the canonical key wins.
 * - Only finite numbers are kept; keys that are not HEXACO traits are dropped.
 *
 * @param raw - A persona `personalityTraits` map, SOUL.md `hexaco` block, or
 *   similar. Anything that is not an object yields an empty result.
 * @returns The scores under canonical keys, with no `undefined` entries.
 */
export function normalizeHexacoTraits(raw: unknown): HexacoTraitValues {
  const result: HexacoTraitValues = {};
  if (!raw || typeof raw !== 'object') {
    return result;
  }
  const source = raw as Record<string, unknown>;

  // Aliases first, so a canonical key present alongside its alias overrides it.
  for (const [alias, canonical] of HEXACO_TRAIT_ALIASES) {
    const value = source[alias];
    if (isFiniteNumber(value) && result[canonical] === undefined) {
      result[canonical] = value;
    }
  }
  for (const key of HEXACO_TRAIT_KEYS) {
    const value = source[key];
    if (isFiniteNumber(value)) {
      result[key] = value;
    }
  }
  return result;
}
