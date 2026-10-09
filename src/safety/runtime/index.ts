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
  SpendReserveRequest,
  SpendReserveResult,
  SpendSettleRequest,
  SpendSettleResult,
  SpendMeterSnapshot,
  SpendReconcileResult,
  SpendRetryPolicy,
} from './SpendMeter.js';
export type { SpendPurgeResult } from './SqlSpendMeter.js';
export { SqlSpendMeter, SPEND_METER_DDL } from './SqlSpendMeter.js';
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
