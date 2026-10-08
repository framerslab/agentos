/**
 * @file gmiCognition.ts
 * Cognition profiles for GMIs built from agent options (`agent({ runtime: 'gmi' })`).
 *
 * `light` (the default) is a GMI with its reasoning trace and nothing else
 * unless `memory` is set. `full` adds cognitive memory with every mechanism,
 * sentiment tracking and every metaprompt preset. A {@link CognitionConfig}
 * sets each switch on its own.
 */
import type { MemoryConfig } from '../types.js';
import type { CognitiveMechanismsConfig } from '../../cognition/memory/mechanisms/types.js';
import type { SentimentTrackingConfig } from '../../cognition/substrate/personas/IPersonaDefinition.js';
import { SENTIMENT_PRESET_IDS } from '../../cognition/substrate/personas/personaNormalization.js';

/** A named cognition profile. */
export type CognitionProfile = 'light' | 'full';

/** A metaprompt preset, named as `SentimentTrackingConfig.presets` names it. */
export type MetapromptPreset = Exclude<NonNullable<SentimentTrackingConfig['presets']>[number], 'all'>;

/** Each cognition switch set explicitly, in place of a named profile. */
export interface CognitionConfig {
  /** Cognitive memory: false, true (defaults) or a MemoryConfig. Unset: the agent's `memory` option. */
  memory?: boolean | MemoryConfig;
  /**
   * Memory mechanisms: true (the agent's `cognitiveMechanisms`, or every
   * mechanism at its defaults), false (none) or a per-mechanism config.
   * Unset means true. Needs memory.
   */
  mechanisms?: boolean | CognitiveMechanismsConfig;
  /** Sentiment tracking: every user turn is scored by the utility AI's lexicon. */
  sentiment?: boolean;
  /**
   * Metaprompt presets: `'all'`, a list of presets, or false. Needs
   * `sentiment`: the presets answer the events sentiment tracking raises.
   */
  metaprompts?: 'all' | MetapromptPreset[] | false;
}

/** What a GMI built from agent options runs. */
export interface ResolvedCognition {
  profile: CognitionProfile | 'custom';
  /** The cognitive memory config, or false for none. */
  memory: MemoryConfig | false;
  /** The mechanisms config the memory manager runs; undefined when memory or the mechanisms are off. */
  mechanisms: CognitiveMechanismsConfig | undefined;
  sentiment: boolean;
  /** The metaprompt presets; false when sentiment is off. */
  metaprompts: 'all' | MetapromptPreset[] | false;
}

/** The agent options {@link resolveCognition} reads. */
export interface CognitionInputs {
  cognition?: CognitionProfile | CognitionConfig;
  memory?: boolean | MemoryConfig;
  cognitiveMechanisms?: CognitiveMechanismsConfig;
}

function memoryOf(value: boolean | MemoryConfig | undefined): MemoryConfig | false {
  if (value === undefined || value === false) return false;
  return value === true ? {} : value;
}

function presetsOf(value: CognitionConfig['metaprompts']): 'all' | MetapromptPreset[] | false {
  if (value === undefined || value === false) return false;
  if (value === 'all') return 'all';
  if (!Array.isArray(value)) {
    throw new Error("cognition.metaprompts must be 'all', a list of presets, or false.");
  }
  const unknown = value.filter((name) => !Object.prototype.hasOwnProperty.call(SENTIMENT_PRESET_IDS, name));
  if (unknown.length > 0) {
    throw new Error(
      `cognition.metaprompts: unknown preset ${unknown.map((name) => `'${String(name)}'`).join(', ')}; ` +
        `use 'all' or a list of ${Object.keys(SENTIMENT_PRESET_IDS).join(', ')}.`,
    );
  }
  return [...value];
}

/**
 * Resolves an agent's `cognition`, `memory` and `cognitiveMechanisms` options
 * into the switches a GMI runs with.
 *
 * - `light`: memory only when `memory` is set (then every mechanism, or the
 *   agent's `cognitiveMechanisms`); no sentiment tracking, no metaprompts.
 * - `full`: memory unless `memory: false`, every mechanism (or the agent's
 *   `cognitiveMechanisms`), sentiment tracking and every metaprompt preset.
 * - A {@link CognitionConfig}: each switch as set, with `memory` falling back
 *   to the agent's `memory` option.
 *
 * @throws {Error} When `cognition` names an unknown profile or an unknown metaprompt preset.
 */
export function resolveCognition(opts: CognitionInputs): ResolvedCognition {
  const c = opts.cognition ?? 'light';
  if (c === 'light') {
    const memory = memoryOf(opts.memory);
    return { profile: 'light', memory, mechanisms: memory ? (opts.cognitiveMechanisms ?? {}) : undefined, sentiment: false, metaprompts: false };
  }
  if (c === 'full') {
    const memory = memoryOf(opts.memory ?? true);
    return { profile: 'full', memory, mechanisms: memory ? (opts.cognitiveMechanisms ?? {}) : undefined, sentiment: true, metaprompts: 'all' };
  }
  if (typeof c !== 'object') {
    throw new Error(`cognition: unknown profile '${String(c)}'; use 'light', 'full' or a CognitionConfig.`);
  }
  const memory = memoryOf(c.memory ?? opts.memory);
  const mechanisms = !memory || c.mechanisms === false
    ? undefined
    : c.mechanisms === true || c.mechanisms === undefined
      ? (opts.cognitiveMechanisms ?? {})
      : c.mechanisms;
  const sentiment = c.sentiment === true;
  const metaprompts = presetsOf(c.metaprompts);
  return { profile: 'custom', memory, mechanisms, sentiment, metaprompts: sentiment ? metaprompts : false };
}
