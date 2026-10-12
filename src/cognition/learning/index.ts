/**
 * The learning layer: a host's `learning` option, the learner a session is bound to, the personality section a GMI
 * sends each turn, what a self-modification tool reads about its turn, and the loop manifest (docs/GMI.md,
 * "Learning").
 * @module agentos/learning
 */
export { createLearningLayer, type LearningLayerOptions } from './LearningLayer.js';
export { deferLearnerSession } from './LearnerSession.js';
export { buildManifest } from './manifest.js';
export { processIsFrozen, resolveLearning, resolveLearningConfig, resolveTurnMode } from './config.js';
export { readToolLearningContext, refusedSelfChange, selfChangeRefusal, type SelfChangeRefusal } from './toolContext.js';
export {
  DEFAULT_ANONYMOUS_USER_IDS,
  HOST_LOOP_NAMES,
  LEARNING_FREEZE_ENV,
  LEARNING_LOOP_NAMES,
  LEARNING_MODES,
  LEARNING_OFF_ENV,
  type HostLoopName,
  type ILearnerSession,
  type ILearningLayer,
  type LearnerContext,
  type LearnerKey,
  type LearningConfig,
  type LearningLoopName,
  type LearningMode,
  type LearningProfile,
  type LoopManifest,
  type LoopName,
  type LoopState,
  type NoLearnerReason,
  type ResolvedLearning,
  type ToolLearningContext,
  type TurnInputForLearning,
  type TurnPreparation,
} from './types.js';
