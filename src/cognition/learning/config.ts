/**
 * @module learning/config
 *
 * The `learning` option resolved into switches, and the mode a turn runs in once the process switches are applied.
 */
import {
  LEARNING_FREEZE_ENV,
  LEARNING_MODES,
  LEARNING_OFF_ENV,
  type LearningConfig,
  type LearningMode,
  type LearningProfile,
  type LoopManifest,
  type ResolvedLearning,
} from './types.js';

/** The process environment, or nothing where there is no `process` (a browser build). */
function processEnv(): Record<string, string | undefined> {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

/**
 * Checks a `LearningConfig` and resolves its switches.
 *
 * The `full` profile asks for trait changes, lessons and the skill library; `light` and `custom` ask for none. A
 * switch the config sets wins over the profile's. A field set to `null` reads as unset, as a config read from JSON or
 * YAML writes one.
 *
 * @throws {Error} Naming the field, when a field has a value of the wrong type, `mode` is not a known mode, or
 *   `agentKey` or `ledgerKey` is blank.
 */
export function resolveLearningConfig(config: LearningConfig, profile: LearningProfile): ResolvedLearning {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('learning: use true, false or a LearningConfig.');
  }
  // A field set to null reads as unset, as a config assembled from JSON or YAML writes one.
  const field = <K extends keyof LearningConfig>(key: K): LearningConfig[K] | undefined => (config[key] === null ? undefined : config[key]);
  const mode = field('mode') ?? 'on';
  if (!LEARNING_MODES.includes(mode)) {
    throw new Error(`learning.mode: unknown mode '${String(mode)}'; use 'on', 'frozen' or 'off'.`);
  }
  for (const key of ['traits', 'lessons', 'skills'] as const) {
    if (field(key) !== undefined && typeof field(key) !== 'boolean') {
      throw new Error(`learning.${key} must be true or false.`);
    }
  }
  for (const key of ['agentKey', 'namespace', 'ledgerKey'] as const) {
    if (field(key) !== undefined && typeof field(key) !== 'string') {
      throw new Error(`learning.${key} must be a string.`);
    }
  }
  for (const key of ['agentKey', 'ledgerKey'] as const) {
    const value = field(key);
    if (value !== undefined && value.trim() === '') throw new Error(`learning.${key} must not be blank.`);
  }
  const anonymous = field('anonymousUserIds');
  if (anonymous !== undefined && (!Array.isArray(anonymous) || anonymous.some((id) => typeof id !== 'string'))) {
    throw new Error('learning.anonymousUserIds must be a list of strings.');
  }
  if (field('clock') !== undefined && typeof field('clock') !== 'function') {
    throw new Error('learning.clock must be a function that returns milliseconds since the epoch.');
  }
  const store = field('store');
  if (store !== undefined && (typeof store !== 'object' || typeof (store as { transaction?: unknown }).transaction !== 'function')) {
    throw new Error('learning.store must be a LearningStore (InMemoryLearningStore or SqlLearningStore).');
  }
  const memoryTools = field('memoryTools');
  if (memoryTools !== undefined && typeof memoryTools !== 'object') {
    throw new Error('learning.memoryTools must be an object: the Memory facade the memory tools are built over.');
  }
  const asked = profile === 'full';
  return {
    mode,
    traits: field('traits') ?? asked,
    lessons: field('lessons') ?? asked,
    skills: field('skills') ?? asked,
  };
}

/**
 * Resolves a host's `learning` option: unset, `null` or `false` is off (`undefined`), `true` takes the profile's
 * switches, and a `LearningConfig` turns learning on and overrides them switch by switch.
 *
 * @throws {Error} As {@link resolveLearningConfig} throws.
 */
export function resolveLearning(
  option: boolean | LearningConfig | null | undefined,
  profile: LearningProfile,
): ResolvedLearning | undefined {
  if (option === undefined || option === null || option === false) return undefined;
  return resolveLearningConfig(option === true ? {} : option, profile);
}

/** True when `AGENTOS_LEARNING_FREEZE=1` freezes the process. */
export function processIsFrozen(env: Record<string, string | undefined> = processEnv()): boolean {
  return env[LEARNING_FREEZE_ENV] === '1';
}

/**
 * The mode a turn runs in: the configured mode with the process switches applied. `AGENTOS_LEARNING_OFF=1` puts
 * every turn in mode `off`; `AGENTOS_LEARNING_FREEZE=1` freezes a turn whose mode would be `on`.
 */
export function resolveTurnMode(
  configured: LearningMode,
  env: Record<string, string | undefined> = processEnv(),
): { mode: LearningMode; setBy: LoopManifest['modeSetBy'] } {
  if (env[LEARNING_OFF_ENV] === '1') return { mode: 'off', setBy: LEARNING_OFF_ENV };
  if (configured === 'on' && processIsFrozen(env)) return { mode: 'frozen', setBy: LEARNING_FREEZE_ENV };
  return { mode: configured, setBy: 'config' };
}
