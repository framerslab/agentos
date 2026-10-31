/**
 * A hook interface for persisting AgentOS rolling-memory outputs (`summary_markdown` + `memory_json`)
 * into an external long-term memory store (e.g., RAG, knowledge graph, database).
 *
 * AgentOS keeps the rolling summary inside the per-conversation `ConversationContext` metadata for
 * prompt compaction. This sink is for *cross-conversation* retrieval and analytics.
 */

import type { ResolvedLongTermMemoryPolicy } from './LongTermMemoryPolicy';
import type { ProposalResult, SessionSelfChange, TurnScopes } from '../../cognition/learning/types.js';

export interface RollingSummaryMemoryUpdate {
  userId: string;
  /** Optional organization context (multi-tenant / org-scoped memory). */
  organizationId?: string;
  sessionId: string;
  conversationId: string;
  personaId: string;
  /** Optional routing mode (customFlags.mode, persona id, etc.). */
  mode?: string;
  /** Compaction profile id used for this update (if profile routing is enabled). */
  profileId?: string | null;
  /**
   * Effective long-term memory policy for this conversation at the time of compaction.
   * Implementations should respect this (e.g., allow per-conversation opt-out).
   */
  memoryPolicy?: ResolvedLongTermMemoryPolicy;

  /** The rolling summary markdown (human-readable). */
  summaryText: string;
  /** The structured memory JSON (`memory_json`) emitted by the compactor. */
  summaryJson: any | null;
  /** Timestamp up to which messages are considered summarized. */
  summaryUptoTimestamp?: number | null;
  /** When this summary snapshot was updated. */
  summaryUpdatedAt?: number | null;
  /**
   * With a learning layer: the turn's scope ids, from the GMI's learner session. The sink files the user, persona and
   * conversation targets under them and records the upsert through {@link recordSelfChange}; without them it files
   * under the plain ids and records nothing, as with no layer.
   */
  turnScopes?: TurnScopes;
  /**
   * With `turnScopes`: the learner session's recorder, bound to the turn. A sink that files under the turn's scope ids
   * records each upsert through it as one memory write, or files nothing.
   */
  recordSelfChange?: <T>(input: SessionSelfChange<T>) => Promise<ProposalResult<T>>;
  /**
   * With `turnScopes`: the explicit user ids whose messages this compaction and the conversation's earlier ones
   * summarized. Each trace the sink files records them, so `forgetUser` for any of them finds it.
   */
  contributorIds?: string[];
}

/**
 * Implement this interface to capture rolling-summary updates into a durable store.
 *
 * Implementations should be:
 * - idempotent (same update may be retried)
 * - best-effort (failures should not break the core chat loop)
 * - strict where a learning layer records its writes (an update with `turnScopes`): an upsert it cannot record writes
 *   nothing and rejects
 */
export interface IRollingSummaryMemorySink {
  upsertRollingSummaryMemory(update: RollingSummaryMemoryUpdate): Promise<void>;
}
