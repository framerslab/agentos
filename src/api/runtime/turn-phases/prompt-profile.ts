/**
 * @fileoverview Prompt profile routing phase.
 * Selects a prompt profile (concise/deep/planner/reviewer) based on conversation state.
 */

import type { ConversationContext } from '../../../core/conversation/ConversationContext';
import {
  selectPromptProfile,
  type PromptProfileConfig,
  type PromptProfileConversationState,
} from '../../structured/prompting/PromptProfileRouter.js';
import { GMIInteractionType, type GMITurnInput } from '../../../cognition/substrate/IGMI';
import { turnContentText } from '../../../cognition/substrate/turnContent';

export interface PromptProfilePhaseInput {
  conversationContext: ConversationContext | undefined;
  promptProfileConfig: PromptProfileConfig | null;
  modeForRouting: string;
  gmiInput: GMITurnInput;
  didCompact: boolean;
}

export interface PromptProfileSelection {
  presetId: string;
  systemInstructions?: string;
  reason?: string;
}

export type PromptProfilePhaseResult = PromptProfileSelection | null;

export function executePromptProfilePhase(
  input: PromptProfilePhaseInput,
): PromptProfilePhaseResult {
  if (!input.conversationContext || !input.promptProfileConfig) return null;

  try {
    const rawPrev = input.conversationContext.getMetadata('promptProfileState');
    const previousState: PromptProfileConversationState | null =
      rawPrev && typeof rawPrev === 'object' && typeof (rawPrev as any).presetId === 'string'
        ? (rawPrev as PromptProfileConversationState)
        : null;

    const userMessage =
      input.gmiInput.type === GMIInteractionType.TEXT && typeof input.gmiInput.content === 'string'
        ? input.gmiInput.content
        : input.gmiInput.type === GMIInteractionType.MULTIMODAL_CONTENT
          ? turnContentText(input.gmiInput.content)
          : '';

    const selection = selectPromptProfile(
      input.promptProfileConfig,
      {
        conversationId: input.conversationContext.sessionId,
        mode: input.modeForRouting,
        userMessage,
        didCompact: input.didCompact,
      },
      previousState,
    );

    input.conversationContext.setMetadata('promptProfileState', selection.nextState);
    return selection.result;
  } catch (routerError: any) {
    console.warn('Prompt-profile routing failed (continuing without it).', routerError);
    return null;
  }
}
