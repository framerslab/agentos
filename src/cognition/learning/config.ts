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
 * switch the config sets wins over the profile's.
 *
 * @throws {Error} Naming the field, when a field has a value of the wrong type or `mode` is not a known mode.
 */
export function resolveLearningConfig(config: LearningConfig, profile: LearningProfile): ResolvedLearning {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('learning: use true, false or a LearningConfig.');
  }
  const mode = config.mode ?? 'on';
  if (!LEARNING_MODES.includes(mode)) {
    throw new Error(`learning.mode: unknown mode '${String(mode)}'; use 'on', 'frozen' or 'off'.`);
  }
  for (const key of ['traits', 'lessons', 'skills'] as const) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') {
      throw new Error(`learning.${key} must be true or false.`);
    }
  }
  for (const key of ['agentKey', 'namespace'] as const) {
    if (config[key] !== undefined && typeof config[key] !== 'string') {
      throw new Error(`learning.${key} must be a string.`);
    }
  }
  if (config.agentKey !== undefined && config.agentKey.trim() === '') {
    throw new Error('learning.agentKey must not be blank.');
  }
  const anonymous = config.anonymousUserIds;
  if (anonymous !== undefined && (!Array.isArray(anonymous) || anonymous.some((id) => typeof id !== 'string'))) {
    throw new Error('learning.anonymousUserIds must be a list of strings.');
  }
  const asked = profile === 'full';
  return {
    mode,
    traits: config.traits ?? asked,
    lessons: config.lessons ?? asked,
    skills: config.skills ?? asked,
  };
}

/**
 * Resolves a host's `learning` option: unset or `false` is off (`undefined`), `true` takes the profile's switches,
 * and a `LearningConfig` turns learning on and overrides them switch by switch.
 *
 * @throws {Error} As {@link resolveLearningConfig} throws.
 */
export function resolveLearning(
  option: boolean | LearningConfig | undefined,
  profile: LearningProfile,
): ResolvedLearning | undefined {
  if (option === undefined || option === false) return undefined;
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
