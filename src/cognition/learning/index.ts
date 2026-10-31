/**
 * The learning layer: a host's `learning` option, the learner a session is bound to, the personality section a GMI
 * sends each turn, the written form of every scope id a turn files and reads its memory under, what a tool reads about
 * its turn, the learning store and its ledger, a learner's trait state, and the loop manifest (docs/GMI.md,
 * "Learning").
 * @module agentos/learning
 */
export { createLearningLayer, type LearningLayerOptions } from './LearningLayer.js';
export { deferLearnerSession } from './LearnerSession.js';
export { buildManifest } from './manifest.js';
export * from './store/index.js';
export {
  chainKeyOf,
  GENESIS_HASH,
  Ledger,
  tombstoneHash,
  type CandidateInput,
  type ChainCheck,
  type DecideResult,
  type LedgerOptions,
  type ProposeOptions,
  type ProposeResult,
} from './ledger/index.js';
export { assertLearnerKey, forgetTargets, freezeScopeKey, type ForgetTarget } from './hostCalls.js';
export { LEARNABLE_TRAITS, LIFETIME_BAND, type OperatorTraits, type TraitState } from './traitState.js';
export { processIsFrozen, resolveLearning, resolveLearningConfig, resolveTurnMode } from './config.js';
export {
  couldBeSessionForm,
  learnerScopeIds,
  learnerUserScopeId,
  scopeIdOf,
  sessionScopeIds,
  taggedScopeId,
  type ScopeIdPair,
} from './scopes.js';
export {
  isTurnScopes,
  memoryWriteRefusal,
  readToolLearningContext,
  refusedSelfChange,
  selfChangeRefusal,
  toolLearningContextFor,
  type SelfChangeRefusal,
} from './toolContext.js';
export {
  DEFAULT_ANONYMOUS_USER_IDS,
  HOST_LOOP_NAMES,
  LEARNING_FREEZE_ENV,
  LEARNING_LOOP_NAMES,
  LEARNING_MODES,
  LEARNING_OFF_ENV,
  type ForgetReport,
  type FreezeScope,
  type GuardedMemoryWrite,
  type HostLoopName,
  type ILearnerSession,
  type ILearningLayer,
  type ImportReport,
  type LearnedStateDocument,
  type LearnerContext,
  type LearnerKey,
  type LearningConfig,
  type LearningKind,
  type LearningLayerHandle,
  type LearningLoopName,
  type LearningMemoryTools,
  type LearningMode,
  type LearningProfile,
  type LedgerEntry,
  type LedgerEvidence,
  type LedgerLearner,
  type LedgerVerdict,
  type LedgerVersions,
  type LoopManifest,
  type LoopName,
  type LoopState,
  type MemoryWriteBefore,
  type MemoryWriteChange,
  type NoLearnerReason,
  type OperatorSetInput,
  type ProposalResult,
  type ResolvedLearning,
  type SelfChangeTurn,
  type SessionSelfChange,
  type ToolLearningContext,
  type TurnInputForLearning,
  type TurnPreparation,
  type TurnScopes,
} from './types.js';
