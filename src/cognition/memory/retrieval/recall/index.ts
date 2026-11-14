/**
 * @fileoverview The recall capture record and its helpers, the memory block's budget and the recall settings' checks,
 * the recall legs, their eligibility gate and the in-process exact-words index, the hybrid recall's fusion and
 * near-duplicate dedupe, the memory-question reserve, supplied candidates, memory rerank, the recall pipeline, and
 * the recall module's event handle.
 * @module agentos/memory/retrieval/recall
 */

export {
  MEMORY_RECALL_CAPTURE_VERSION,
  MEMORY_RERANK_MAX_DOCUMENTS,
  candidatesFrom,
  rerankerRecordOf,
} from './capture.js';
export type {
  RecallLeg,
  LegAbsentReason,
  RerankSkipReason,
  RecallCaptureMode,
  MemoryRecallCandidate,
  MemoryRecallReranker,
  MemoryRecallCapture,
  RankedRecallCandidate,
  RetrievalRecallReport,
} from './capture.js';
export {
  DEFAULT_RECALL_BUDGET_TOKENS,
  PROMPT_CONTEXT_SHARE,
  RecallOptionError,
  assertRecallConfig,
  effectiveRecallBudget,
  estimateMemoryTokens,
  rejectRecallOption,
  recallBudgetTokens,
} from './budget.js';
export type { EffectiveRecallBudget, RecallOptionRejection } from './budget.js';
export { recallLog } from './log.js';
export { isEligibleForRecall } from './eligibility.js';
export { recallTokens, ScopedLexicalIndex } from './lexical.js';
export type { LegQuery, LegResult } from './legs/leg.js';
export { denseLeg } from './legs/dense.js';
export type { DenseLegDeps, DenseLegResult } from './legs/dense.js';
export { exactWordsLeg, lexicalBackendOf } from './legs/exactWords.js';
export { recencyLeg } from './legs/recency.js';
export { RECALL_CONSTANTS, fuseLegs } from './fuse.js';
export type { PoolEntry, RecallConstants } from './fuse.js';
export { dedupePool, dedupeTokens, nearDuplicate } from './dedupe.js';
export type { DedupeEntry } from './dedupe.js';
export { isMemoryQuestion, reserveFor } from './memoryQuestion.js';
export { admitSupplied } from './supplied.js';
export type { AdmittedSupplied, SuppliedOutcome } from './supplied.js';
export { RecallReranker, RERANK_DEFAULTS } from './rerank.js';
export type { RecallRerankProvider, RecallRerankerDeps, RerankOutcome, RerankSetting } from './rerank.js';
export { RecallPipeline } from './pipeline.js';
export type { RecallPipelineDeps, RecallRun } from './pipeline.js';
