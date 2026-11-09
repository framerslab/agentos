/**
 * @file personaNormalization.ts
 * Load-time transformations every persona source shares, so a definition loads
 * identically from a JSON file, an inline list or a custom loader.
 */
import type { IPersonaDefinition } from './IPersonaDefinition';
import { mergeMetapromptPresets } from './metaprompt_presets.js';

/** Short preset names accepted in `sentimentTracking.presets`, mapped to the metaprompt ids they expand to. */
export const SENTIMENT_PRESET_IDS: Record<string, string> = {
  frustration_recovery: 'gmi_frustration_recovery',
  confusion_clarification: 'gmi_confusion_clarification',
  satisfaction_reinforcement: 'gmi_satisfaction_reinforcement',
  error_recovery: 'gmi_error_recovery',
  engagement_boost: 'gmi_engagement_boost',
};

/**
 * The shape (`null` or a `typeof` name) of a `metaPrompts` that was not an array when the persona was supplied and
 * that the sentiment presets then replaced, keyed by the normalized definition. The stored definition carries only
 * the merged array, so validation reads the supplied shape here to report `invalid_metaprompts`.
 */
const replacedMetaPromptsShapes = new WeakMap<IPersonaDefinition, string>();

/**
 * The shape (`'null'` or a `typeof` name such as `'object'` or `'string'`) of the `metaPrompts` a persona was
 * supplied with, when that value was not an array and the sentiment presets replaced it during normalization;
 * `undefined` otherwise. The mark follows the definition through a second normalization and through
 * `clonePersonaDefinition`.
 */
export function replacedMetaPromptsShape(definition: IPersonaDefinition): string | undefined {
  return replacedMetaPromptsShapes.get(definition);
}

/** A plain object (not an array, a class instance or `null`). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * `cognitiveMemoryConfig` without the `null` values JSON writes for an unset key: a field set to `null` is dropped,
 * and so is a key set to `null` inside a field that is a plain object. Returns the input itself when it holds no
 * `null`, and `undefined` for a config that is itself `null`.
 */
function withoutMemoryNulls(
  config: IPersonaDefinition['cognitiveMemoryConfig'] | null,
): IPersonaDefinition['cognitiveMemoryConfig'] {
  if (config == null) return undefined;
  if (!isPlainObject(config)) return config;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(config)) {
    if (value === null) {
      changed = true;
      continue;
    }
    if (isPlainObject(value) && Object.values(value).some((entry) => entry === null)) {
      changed = true;
      out[field] = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null));
      continue;
    }
    out[field] = value;
  }
  return changed ? (out as IPersonaDefinition['cognitiveMemoryConfig']) : config;
}

/**
 * Two load-time steps:
 * - `cognitiveMemoryConfig` loses the `null` values a persona read from JSON writes for an unset key (a field set to
 *   `null`, a key set to `null` inside a field, or the whole config set to `null`), so a loaded persona matches
 *   `CognitiveMemoryPersonaConfig`, which lists no `null`.
 * - When `sentimentTracking.enabled` is true and `presets` is an array naming at least one preset, the preset
 *   metaprompts are merged into `metaPrompts`; a `metaPrompts` that is not an array is treated as empty there, and
 *   its shape is recorded so `validatePersona` still reports it as `invalid_metaprompts` (see
 *   `replacedMetaPromptsShape`). A
 *   `presets` that is not an array (`null` included) merges nothing (`validatePersona` reports it as
 *   `invalid_sentiment_presets`).
 *
 * Returns the input object untouched when nothing applies, and a new object (the input is never mutated) when
 * either step does.
 */
export function normalizePersonaDefinition(definition: IPersonaDefinition): IPersonaDefinition {
  const inheritedShape = replacedMetaPromptsShapes.get(definition);
  const marked = (out: IPersonaDefinition, shape: string | undefined): IPersonaDefinition => {
    if (shape !== undefined && out !== definition) replacedMetaPromptsShapes.set(out, shape);
    return out;
  };
  let result = definition;
  if ('cognitiveMemoryConfig' in definition) {
    const raw = definition.cognitiveMemoryConfig as IPersonaDefinition['cognitiveMemoryConfig'] | null;
    const memory = withoutMemoryNulls(raw);
    if (memory !== raw) {
      result = { ...definition };
      if (memory === undefined) delete result.cognitiveMemoryConfig;
      else result.cognitiveMemoryConfig = memory;
    }
  }

  const sentiment = result.sentimentTracking;
  if (!sentiment?.enabled || !Array.isArray(sentiment.presets) || sentiment.presets.length === 0) {
    return marked(result, inheritedShape);
  }
  const requestedIds = sentiment.presets.includes('all')
    ? undefined // undefined = every preset
    : sentiment.presets
        .filter((preset): preset is Exclude<typeof preset, 'all'> => preset !== 'all')
        .map((preset) => SENTIMENT_PRESET_IDS[preset])
        .filter(Boolean);
  const supplied = result.metaPrompts as unknown;
  const ownMetaPrompts = Array.isArray(supplied) ? (supplied as IPersonaDefinition['metaPrompts']) : undefined;
  const replacedShape =
    supplied !== undefined && !Array.isArray(supplied) ? (supplied === null ? 'null' : typeof supplied) : inheritedShape;
  return marked({ ...result, metaPrompts: mergeMetapromptPresets(ownMetaPrompts, requestedIds) }, replacedShape);
}

/**
 * Returns a copy of a definition that shares nothing with the input (a replaced `metaPrompts` mark included):
 * `structuredClone` for the
 * plain data every JSON persona is made of, and a shallow copy for a code-built definition
 * that carries values `structuredClone` rejects (functions, class instances), whose nested
 * objects then stay shared with the caller.
 */
export function clonePersonaDefinition(definition: IPersonaDefinition): IPersonaDefinition {
  let copy: IPersonaDefinition;
  try {
    copy = structuredClone(definition);
  } catch {
    copy = { ...definition };
  }
  const shape = replacedMetaPromptsShapes.get(definition);
  if (shape !== undefined) replacedMetaPromptsShapes.set(copy, shape);
  return copy;
}
