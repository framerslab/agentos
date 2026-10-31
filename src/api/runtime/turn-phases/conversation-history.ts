/**
 * @fileoverview Conversation history assembly phase.
 * Builds a trimmed, deduplicated history snapshot for prompt construction.
 */

import type { ConversationContext } from '../../../core/conversation/ConversationContext';
import { MessageRole } from '../../../core/conversation/ConversationMessage';
import { GMIInteractionType, type GMITurnInput } from '../../../cognition/substrate/IGMI';
import type { RollingSummaryCompactionConfig, RollingSummaryCompactionResult } from '../../../core/conversation/RollingSummaryCompactor';
import { toolRoundBounds } from '../../../core/conversation/toolRounds';
import { turnContentText } from '../../../cognition/substrate/turnContent';

export interface ConversationHistoryPhaseInput {
  conversationContext: ConversationContext | undefined;
  gmiInput: GMITurnInput;
  rollingSummaryEnabled: boolean;
  rollingSummaryResult: RollingSummaryCompactionResult | null;
  rollingSummaryText: string;
  rollingSummaryConfigForTurn: RollingSummaryCompactionConfig | null;
}

/**
 * Build a conversation history snapshot for prompt construction.
 * When rolling summary is active, trims history to head messages + unsummarized tail, and keeps a tool round (an
 * assistant message that names tool calls, the tool messages that answer them and anything between) whole when it
 * keeps any message of it: providers refuse a call without its result and a result without its call. The head is the
 * one the conversation's summary state records (`rollingSummaryResult.headMessagesToKeep`), which the turn's own
 * `headMessagesToKeep` replaces only for a result that reports none, so a turn under a compaction profile with another
 * head sends the messages the summary left to the head, and none it summarized.
 * Deduplicates the current user message if already in history.
 */
export function assembleConversationHistory(input: ConversationHistoryPhaseInput): any[] | null {
  const { conversationContext } = input;
  if (!conversationContext) return null;

  const excludeRoles = new Set<MessageRole>([MessageRole.ERROR, MessageRole.THOUGHT]);
  const useTrimmedHistory =
    input.rollingSummaryEnabled &&
    typeof input.rollingSummaryResult?.summaryUptoTimestamp === 'number' &&
    input.rollingSummaryText.length > 0;

  const rawHistory = useTrimmedHistory
    ? (conversationContext.getAllMessages() as any[])
    : (conversationContext.getHistory(undefined, [MessageRole.ERROR, MessageRole.THOUGHT]) as any[]);

  let historyForPrompt = rawHistory.filter((m) => m && !excludeRoles.has(m.role));

  // Deduplicate: remove the last user message if it matches the current inbound
  const last = historyForPrompt[historyForPrompt.length - 1];
  if (last?.role === MessageRole.USER) {
    const content = typeof last.content === 'string' ? last.content.trim() : '';
    const inbound =
      input.gmiInput.type === GMIInteractionType.TEXT && typeof input.gmiInput.content === 'string'
        ? input.gmiInput.content.trim()
        : input.gmiInput.type === GMIInteractionType.MULTIMODAL_CONTENT
          ? turnContentText(input.gmiInput.content).trim()
          : '';
    if (content && inbound && content === inbound) {
      historyForPrompt = historyForPrompt.slice(0, -1);
    }
  }

  // When rolling summary is active, keep head messages + unsummarized tail
  if (useTrimmedHistory) {
    const headCount = Math.max(
      0,
      input.rollingSummaryResult?.headMessagesToKeep ?? input.rollingSummaryConfigForTurn?.headMessagesToKeep ?? 0,
    );
    const boundary = (input.rollingSummaryResult as any).summaryUptoTimestamp;
    const inHeadOrTail = historyForPrompt.map((m: any, index: number) => index < headCount || m.timestamp > boundary);
    // A kept message keeps the rest of its tool round. The compactor ends a summary where a round ends, and this
    // also sends whole a round that a boundary stored by an earlier release cut through.
    const rounds = toolRoundBounds(historyForPrompt);
    const keep = [...inHeadOrTail];
    // Each round is marked once, from its first kept message: a later kept message of it is already marked.
    let markedThrough = -1;
    inHeadOrTail.forEach((kept, index) => {
      if (!kept || index <= markedThrough) return;
      for (let member = rounds.start[index]; member <= rounds.end[index]; member += 1) keep[member] = true;
      markedThrough = rounds.end[index];
    });
    const merged: any[] = [];
    const seen = new Set<string>();
    historyForPrompt.forEach((msg: any, index: number) => {
      const id = typeof msg?.id === 'string' ? msg.id : '';
      if (!keep[index] || !id || seen.has(id)) return;
      seen.add(id);
      merged.push(msg);
    });
    historyForPrompt = merged;
  }

  return historyForPrompt;
}
