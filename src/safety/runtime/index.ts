/**
 * Agent safety primitives: circuit breaker, action deduplication,
 * stuck detection, cost guards, and tool execution guards.
 *
 * @module safety
 */

export { CircuitBreaker, CircuitOpenError } from './CircuitBreaker.js';
export type { CircuitState, CircuitBreakerConfig, CircuitBreakerStats } from './CircuitBreaker.js';

export { ActionDeduplicator } from './ActionDeduplicator.js';
export type { ActionDeduplicatorConfig, DeduplicatorEntry } from './ActionDeduplicator.js';

export { StuckDetector } from './StuckDetector.js';
export type { StuckDetectorConfig, StuckReason, StuckDetection } from './StuckDetector.js';

export { CostGuard, CostCapExceededError } from './CostGuard.js';
export type { CostGuardConfig, CostCapType, CostRecord, CostSnapshot } from './CostGuard.js';

export { ToolExecutionGuard, ToolTimeoutError } from './ToolExecutionGuard.js';
export type { ToolExecutionGuardConfig, GuardedToolResult, ToolHealthReport } from './ToolExecutionGuard.js';

export {
  SpendMeterUnavailableError,
  withBoundedRetry,
  isTransientStorageError,
  DEFAULT_SPEND_RETRY_POLICY,
} from './SpendMeter.js';
export type {
  ISpendMeter,
  SpendOutcome,
  SpendReservationState,
  SpendDenyReason,
  SpendUsage,
  SpendFenceEvidence,
  SpendExpiryDecision,
  SpendExpiredReservation,
  SpendReserveRequest,
  SpendReserveResult,
  SpendSettleRequest,
  SpendSettleResult,
  SpendMeterSnapshot,
  SpendReconcileResult,
  SpendRetryPolicy,
} from './SpendMeter.js';
export type { SpendPurgeResult } from './SqlSpendMeter.js';
export { SqlSpendMeter, SPEND_METER_DDL, spendMeterDdl } from './SqlSpendMeter.js';
export type { SqlSpendMeterOptions, SpendUnknownResolution } from './SqlSpendMeter.js';

export {
  InMemorySpendDayStore,
  minutesMicro,
  releaseExpiredSpend,
  releaseSpend,
  reserveSpend,
  settledTokensMicro,
  toMicro,
  tokensMicro,
  utcDay,
} from './SpendReservations.js';
export type { OpenReservation, SpendAdmission, SpendDayStore } from './SpendReservations.js';
// The prices a spend admission reads, beside its rules, so `@framers/agentos/safety/runtime` carries both without loading a provider.
export {
  OPENAI_MODEL_PRICING,
  OPENAI_TRANSCRIPTION_PRICING,
  openAIModelPricing,
  openAITranscriptionPricing,
} from '../../core/llm/providers/implementations/openaiPricing.js';
export {
  DEEPGRAM_PRE_RECORDED_PRICING,
  DEEPGRAM_STREAMING_PRICING,
  deepgramPreRecordedPricing,
  deepgramStreamingPricing,
} from '../../io/voice-pipeline/providers/deepgramPricing.js';

// Compound credit: rational rates, funding lots, holds, every-attempt budgets and the margin report.
export {
  CREDIT_UNITS,
  assertRate,
  componentMicro,
  deriveMeasuredRate,
  isBilledPerAttempt,
  quoteCompoundLiability,
  rateComponent,
} from './CreditRates.js';
export type {
  AttemptLimits,
  CompoundLiability,
  CreditUnit,
  LiabilityRequest,
  MeasuredRate,
  MeasuredUnitCost,
  RateComponent,
  RateSnapshot,
  RationalRate,
} from './CreditRates.js';
export { CreditConflictError, InMemoryCompoundCreditStore, checkVersion, creditDay } from './CompoundCreditStore.js';
export type {
  AttemptPurpose,
  CreditAccountRow,
  CreditAllocationRow,
  CreditAttemptRow,
  CreditAttemptState,
  CreditDocumentRow,
  CreditEntryFilter,
  CreditEntryKind,
  CreditEntryRow,
  CreditHoldFilter,
  CreditHoldRow,
  CreditHoldState,
  CreditLotKind,
  CreditLotRow,
  CreditLotState,
  CreditTransaction,
  ICompoundCreditStore,
  SupplierDayRow,
} from './CompoundCreditStore.js';
export {
  attemptUsageOf,
  completeLotRefund,
  creditBalance,
  deferCompoundHold,
  disputeCreditLot,
  grantCreditLot,
  isLotEligible,
  lotFreeMicro,
  priceAttempts,
  promotionsFirstPolicy,
  reconcileCompoundCredit,
  refundCreditLot,
  reserveCompoundCredit,
  resolveCreditDispute,
  retireExpiredPromotions,
  settleCompoundCredit,
  withCreditRetry,
} from './CompoundCreditLedger.js';
export type {
  AllocationPolicy,
  CallFence,
  CreditBalance,
  GrantCreditLotInput,
  GrantCreditLotResult,
  HoldRates,
  HoldResolution,
  ReconcileCompoundCreditResult,
  RefundCreditLotInput,
  RefundCreditLotResult,
  ReserveCompoundCreditInput,
  ReserveCompoundCreditResult,
  SettleCompoundCreditInput,
  SettleCompoundCreditResult,
} from './CompoundCreditLedger.js';
export {
  AttemptBudgetExhaustedError,
  authorizeModelAttempt,
  CountingAttemptBudget,
  ModelAttemptBudget,
  recordAttemptUsage,
} from './ModelAttemptBudget.js';
export type {
  AttemptGrant,
  AuthorizeModelAttemptInput,
  AuthorizeModelAttemptResult,
  IAttemptAuthorizer,
  RecordAttemptUsageInput,
  RecordAttemptUsageResult,
} from './ModelAttemptBudget.js';
export { COMPOUND_CREDIT_DDL, SqlCompoundCreditStore, compoundCreditDdl } from './SqlCompoundCreditStore.js';
export type { SqlCompoundCreditStoreOptions } from './SqlCompoundCreditStore.js';
export { buildMarginReport, marginReport, readMarginPeriod } from './MarginReport.js';
export type { MarginAllocationPolicy, MarginPeriodInput, MarginReport, MarginReportQuery, MarginSettlement } from './MarginReport.js';

// Supplier transcription credit: a vendor's promotional balance, reserved before audio and allocated from measured usage.
export {
  makeTranscriptionCreditRecord,
  configureTranscriptionCredit,
  refreshTranscriptionCredit,
  failTranscriptionCreditCheck,
  transcriptionCreditSnapshot,
  reserveTranscriptionCredit,
  admitLowestCostTranscription,
  bindTranscriptionConnection,
  settleTranscriptionInterval,
} from './TranscriptionCredit.js';
export type {
  TranscriptionCreditRecordInput,
  TranscriptionCreditRecord,
  ReserveTranscriptionCreditInput,
  TranscriptionAdmission,
  TranscriptionIntervalInput,
  TranscriptionIntervalAllocation,
} from './TranscriptionCredit.js';

// Text funding by elapsed time for a listening session, independent of its transcription sockets.
export {
  createTimedTextBudget,
  readTimedTextBudget,
  reportTimedTextBudget,
  renewTimedTextBudget,
  settleTimedTextBudget,
} from './TimedTextBudget.js';
export type { TimedTextBudgetView } from './TimedTextBudget.js';
