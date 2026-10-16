/**
 * @fileoverview Long-term memory retrieval phase.
 * Checks cadence, retrieves durable memories, and updates retrieval state.
 */

import type { ConversationContext } from '../../../core/conversation/ConversationContext';
import type { ILongTermMemoryRetriever } from '../../../core/conversation/ILongTermMemoryRetriever';
import {
  DEFAULT_LONG_TERM_MEMORY_POLICY,
  type ResolvedLongTermMemoryPolicy,
} from '../../../core/conversation/LongTermMemoryPolicy';
import { MessageRole } from '../../../core/conversation/ConversationMessage';
import { GMIInteractionType, type GMITurnInput } from '../../../cognition/substrate/IGMI';
import { turnContentText } from '../../../cognition/substrate/turnContent';

type LongTermMemoryRetrievalState = {
  lastReviewedUserTurn: number;
  lastReviewedAt?: number;
};

export interface LongTermMemoryPhaseInput {
  conversationContext: ConversationContext | undefined;
  longTermMemoryRetriever: ILongTermMemoryRetriever | undefined;
  longTermMemoryPolicy: ResolvedLongTermMemoryPolicy | null;
  gmiInput: GMITurnInput;
  streamId: string;
  userId: string;
  organizationId: string | undefined;
  conversationId: string;
  personaId: string;
  modeForRouting: string;
  recallConfig: {
    cadenceTurns: number;
    forceOnCompaction: boolean;
    maxContextChars: number;
    topKByScope: Record<'user' | 'persona' | 'organization', number>;
  };
  didCompact: boolean;
}

export interface LongTermMemoryPhaseResult {
  contextText: string | null;
  diagnostics: Record<string, unknown> | undefined;
  feedbackPayload?: unknown;
  shouldReview: boolean;
  reviewReason: string | null;
}

export async function executeLongTermMemoryPhase(
  input: LongTermMemoryPhaseInput,
): Promise<LongTermMemoryPhaseResult> {
  const {
    conversationContext,
    longTermMemoryRetriever,
    longTermMemoryPolicy,
  } = input;

  const policyEnabled = Boolean(longTermMemoryPolicy?.enabled);
  const hasScopes =
    Boolean(longTermMemoryPolicy?.scopes?.user) ||
    Boolean(longTermMemoryPolicy?.scopes?.persona) ||
    Boolean(longTermMemoryPolicy?.scopes?.organization);

  if (!conversationContext || !longTermMemoryRetriever || !policyEnabled || !hasScopes) {
    return {
      contextText: null,
      diagnostics: undefined,
      feedbackPayload: undefined,
      shouldReview: false,
      reviewReason: 'retriever_not_applicable',
    };
  }

  try {
    const queryText =
      input.gmiInput.type === GMIInteractionType.TEXT && typeof input.gmiInput.content === 'string'
        ? input.gmiInput.content.trim()
        : input.gmiInput.type === GMIInteractionType.MULTIMODAL_CONTENT
          ? turnContentText(input.gmiInput.content).trim()
          : '';

    const userTurnCount = (conversationContext.getAllMessages() as any[]).filter(
      (m) => m?.role === MessageRole.USER,
    ).length;

    const { cadenceTurns, forceOnCompaction } = input.recallConfig;

    const rawState = conversationContext.getMetadata('longTermMemoryRetrievalState');
    const prevState: LongTermMemoryRetrievalState | null =
      rawState &&
      typeof rawState === 'object' &&
      typeof (rawState as any).lastReviewedUserTurn === 'number'
        ? (rawState as LongTermMemoryRetrievalState)
        : null;

    const turnsSinceReview = prevState
      ? Math.max(0, userTurnCount - prevState.lastReviewedUserTurn)
      : Number.POSITIVE_INFINITY;
    const dueToCadence = !prevState || turnsSinceReview >= cadenceTurns;
    const dueToCompaction = forceOnCompaction && input.didCompact;
    const shouldReview = dueToCadence || dueToCompaction;

    let reviewReason: string | null;
    if (shouldReview) {
      reviewReason = !prevState ? 'initial_review' : dueToCompaction ? 'forced_on_compaction' : 'cadence_due';
    } else {
      reviewReason = 'cadence_not_due';
    }

    let contextText: string | null = null;
    let diagnostics: Record<string, unknown> | undefined;
    let feedbackPayload: unknown;

    if (shouldReview && queryText.length > 0) {
      const retrievalResult = await longTermMemoryRetriever.retrieveLongTermMemory({
        userId: input.userId,
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        personaId: input.personaId,
        mode: input.modeForRouting,
        queryText,
        memoryPolicy: longTermMemoryPolicy ?? DEFAULT_LONG_TERM_MEMORY_POLICY,
        retrievalPolicy: longTermMemoryPolicy?.retrieval ?? undefined,
        maxContextChars: input.recallConfig.maxContextChars,
        topKByScope: input.recallConfig.topKByScope,
      });

      if (retrievalResult?.contextText?.trim()) {
        contextText = retrievalResult.contextText.trim();
        diagnostics = retrievalResult.diagnostics;
        feedbackPayload = retrievalResult.feedbackPayload;
      }

      conversationContext.setMetadata('longTermMemoryRetrievalState', {
        lastReviewedUserTurn: userTurnCount,
        lastReviewedAt: Date.now(),
      } satisfies LongTermMemoryRetrievalState);
    } else if (shouldReview && queryText.length === 0) {
      reviewReason = 'empty_query';
    }

    return { contextText, diagnostics, feedbackPayload, shouldReview, reviewReason };
  } catch (retrievalError: any) {
    console.warn(
      `Long-term memory retrieval failed for stream ${input.streamId} (continuing without it).`,
      retrievalError,
    );
    return {
      contextText: null,
      diagnostics: undefined,
      feedbackPayload: undefined,
      shouldReview: true,
      reviewReason: 'retrieval_error',
    };
  }
}
