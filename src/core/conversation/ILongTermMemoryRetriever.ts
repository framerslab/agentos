import type { ResolvedLongTermMemoryPolicy } from './LongTermMemoryPolicy';
import type { MemoryRetrievalPolicy } from '../../cognition/rag/unified/policy.js';
import type { TurnScopes } from '../../cognition/learning/types.js';

export interface LongTermMemoryRetrievalInput {
  userId: string;
  organizationId?: string;
  conversationId: string;
  personaId: string;
  mode: string;
  queryText: string;
  memoryPolicy: ResolvedLongTermMemoryPolicy;
  retrievalPolicy?: MemoryRetrievalPolicy;
  /**
   * Advisory character budget for the returned context string.
   * Implementations may truncate to stay within this budget.
   */
  maxContextChars?: number;
  /**
   * Optional per-scope retrieval caps.
   * Implementations are free to ignore/override.
   */
  topKByScope?: Partial<Record<'user' | 'persona' | 'organization', number>>;
  /**
   * With a learning layer: the turn's scope ids, from the GMI's learner session. A retriever reads the user, persona
   * and conversation scopes under them (a learner's, or the session's own form on a turn with no learner); without
   * them it reads under the plain ids, as with no layer.
   */
  turnScopes?: TurnScopes;
}

export interface LongTermMemoryRetrievalResult {
  /** Markdown/plain-text context to inject into the next prompt. */
  contextText: string;
  /** Optional lightweight diagnostics for UI/debugging. */
  diagnostics?: Record<string, unknown>;
  /**
   * Opaque implementation-specific payload used to record used/ignored
   * feedback after the assistant produces a final response.
   */
  feedbackPayload?: unknown;
}

export interface LongTermMemoryFeedbackInput {
  queryText: string;
  responseText: string;
  feedbackPayload?: unknown;
}

export interface ILongTermMemoryRetriever {
  retrieveLongTermMemory(
    input: LongTermMemoryRetrievalInput,
  ): Promise<LongTermMemoryRetrievalResult | null>;

  recordRetrievalFeedback?(
    input: LongTermMemoryFeedbackInput,
  ): Promise<void>;
}
