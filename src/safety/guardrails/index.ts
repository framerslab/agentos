/**
 * @module guardrails
 *
 * Guardrails system for content safety and policy enforcement.
 *
 * Guardrails intercept content at two points:
 * 1. **Input** - Before user messages enter the orchestration pipeline
 * 2. **Output** - Before agent responses are streamed to the client
 *
 * @example Basic guardrail
 * ```typescript
 * import {
 *   IGuardrailService,
 *   GuardrailAction,
 *   type GuardrailInputPayload
 * } from '@framers/agentos/safety/guardrails';
 *
 * class ContentFilter implements IGuardrailService {
 *   async evaluateInput({ input }: GuardrailInputPayload) {
 *     if (containsProhibitedContent(input.textInput)) {
 *       return {
 *         action: GuardrailAction.BLOCK,
 *         reason: 'Content policy violation'
 *       };
 *     }
 *     return null;
 *   }
 * }
 * ```
 *
 * @example Cross-agent supervision
 * ```typescript
 * import {
 *   ICrossAgentGuardrailService,
 *   GuardrailAction
 * } from '@framers/agentos/safety/guardrails';
 *
 * class SupervisorGuardrail implements ICrossAgentGuardrailService {
 *   observeAgentIds = ['worker-1', 'worker-2'];
 *   canInterruptOthers = true;
 *
 *   async evaluateCrossAgentOutput({ sourceAgentId, chunk }) {
 *     // Supervise worker agents' outputs
 *   }
 * }
 * ```
 */

// Core guardrail interface and types
export {
  GuardrailAction,
  type GuardrailConfig,
  type GuardrailContext,
  type GuardrailEvaluationResult,
  type GuardrailHold,
  type GuardrailInputPayload,
  type GuardrailOutputPayload,
  type IGuardrailService,
} from './IGuardrailService';

// Guardrail dispatcher functions
export {
  createGuardrailBlockedStream,
  createToolCallGate,
  evaluateInputGuardrails,
  guardrailOutcomeOf,
  holdResult,
  isGuardrailHold,
  toModerationEvaluation,
  type GuardrailInputOutcome,
  type GuardrailMetadataEntry,
  type GuardrailOutcome,
  type GuardrailOutputOptions,
  type GuardrailOutputVerdict,
  type GuardrailToolCallGate,
  type ModerationEvaluation,
  wrapOutputGuardrails,
} from './guardrailDispatcher';

// Guards a deployment requires: the boot and request checks and the fail-closed posture; the moderation posture
export {
  assertRequiredGuardrails,
  checkRequiredGuardrails,
  withModerationPosture,
  withRequiredPosture,
  type ActiveGuardrail,
  type GuardrailStage,
  type ModerationPostureOptions,
  type RequiredGuardrailReport,
  type RequiredGuardrailSpec,
} from './requiredGuardrails';

// Content between people: one entry point, a closed posture, a typed context
export {
  moderateContent,
  type ContentUnderReview,
  type ModerateContentOptions,
  type ModerationDecision,
  type ModerationOutcome,
} from './contentModeration';
export { assertModerationContext, type ModerationContext, type ModerationSurface } from './ModerationContext';

// Text a person wrote, framed so a model reads it as data
export { UNTRUSTED_EVIDENCE_NOTICE, frameUntrustedEvidence, type FramedEvidence } from './untrustedEvidence';

// Two-phase parallel guardrail dispatcher
export { ParallelGuardrailDispatcher, type GuardrailToolCallVerdict } from './ParallelGuardrailDispatcher';

// A guard over a reviewed phrase list, with a judge behind it and a fixed reply per rule
export {
  PhraseListGuardrail,
  StaticPhraseListSource,
  createLlmPhraseJudge,
  createPhraseListPack,
  normalizePhraseText,
  phraseMatches,
  type PhraseEntry,
  type PhraseJudge,
  type PhraseJudgeVerdict,
  type PhraseListGuardrailOptions,
  type PhraseListSnapshot,
  type PhraseListSource,
} from './builtin/PhraseListGuardrail';

// A guard over an input's images: match checks first, one capture, a closed default
export {
  ImageGuardrail,
  type ImageCheck,
  type ImageCheckResult,
  type ImageGuardrailOptions,
  type ImageUnderReview,
} from './builtin/ImageGuardrail';

// Cross-agent guardrail interface and types
export {
  type CrossAgentOutputPayload,
  type ICrossAgentGuardrailService,
  isCrossAgentGuardrail,
  shouldObserveAgent,
} from './ICrossAgentGuardrailService';

// Sentence boundary buffer for streaming evaluation
export { SentenceBoundaryBuffer } from './SentenceBoundaryBuffer';

// Cross-agent guardrail dispatcher
export {
  type CrossAgentEvaluationResult,
  type CrossAgentGuardrailContext,
  evaluateCrossAgentGuardrails,
  filterCrossAgentGuardrails,
  wrapWithCrossAgentGuardrails,
} from './crossAgentGuardrailDispatcher';
