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
 * When `sentimentTracking.enabled` is true and `presets` names at least one preset,
 * the preset metaprompts are merged into `metaPrompts`. Returns the input object
 * untouched when nothing applies, and a new object (the input is never mutated) when it does.
 */
export function normalizePersonaDefinition(definition: IPersonaDefinition): IPersonaDefinition {
  const sentiment = definition.sentimentTracking;
  if (!sentiment?.enabled || !sentiment.presets || sentiment.presets.length === 0) {
    return definition;
  }
  const requestedIds = sentiment.presets.includes('all')
    ? undefined // undefined = every preset
    : sentiment.presets
        .filter((preset): preset is Exclude<typeof preset, 'all'> => preset !== 'all')
        .map((preset) => SENTIMENT_PRESET_IDS[preset])
        .filter(Boolean);
  return { ...definition, metaPrompts: mergeMetapromptPresets(definition.metaPrompts, requestedIds) };
}
