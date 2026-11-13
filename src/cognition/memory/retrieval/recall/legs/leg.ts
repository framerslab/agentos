/**
 * @fileoverview What a recall leg is asked and what it answers: the turn's text, scopes and filters with the leg's own
 * limit, and the leg's eligible traces with a count of the ones the eligibility gate dropped.
 *
 * @module agentos/cognition/memory/retrieval/recall/legs/leg
 */
import type { MemoryScope, MemoryTrace, MemoryType, TrustCapability } from '../../../core/types.js';
import type { LegAbsentReason, RecallLeg } from '../capture.js';

/** What a leg is asked: the turn's text, scopes and filters, and how many traces it may return. */
export interface LegQuery {
  /** The turn's text. */
  query: string;
  /** The scopes the turn may read, as the turn passes them. A leg asked with none does not run (`no_scopes`). */
  scopes: ReadonlyArray<{ scope: MemoryScope; scopeId: string }>;
  /** `CognitiveRetrievalOptions.types`. */
  types?: MemoryType[];
  /** `CognitiveRetrievalOptions.minConfidence`, on the trace's `provenance.confidence`. */
  minConfidence?: number;
  /** `CognitiveRetrievalOptions.timeRange.after`, on the trace's `createdAt`. */
  after?: number;
  /** `CognitiveRetrievalOptions.usableFor`: every capability must be allowed by the trace's trust policy at `now`. */
  usableFor?: TrustCapability[];
  /** The leg's own limit, counted after the scope filter. */
  limit: number;
  /** The turn's one clock, in milliseconds. */
  now: number;
}

/** What a leg answers. `traces` are eligible, best first; `ineligible` is a count, never an id. */
export interface LegResult<T extends MemoryTrace = MemoryTrace> {
  leg: Exclude<RecallLeg, 'supplied'>;
  /** False when the leg could not run for the turn; `reason` says why. */
  ran: boolean;
  reason?: LegAbsentReason;
  traces: T[];
  /** How many traces the leg found that the eligibility gate dropped. */
  ineligible: number;
  /** How long the leg took, in milliseconds, rounded. */
  ms: number;
}
