/**
 * @fileoverview Rolling summary compaction phase.
 * Selects a compaction profile and runs maybeCompactConversationMessages.
 */

import type { ConversationContext } from '../../../core/conversation/ConversationContext';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import {
  maybeCompactConversationMessages,
  type RollingSummaryCompactionConfig,
  type RollingSummaryCompactionResult,
} from '../../../core/conversation/RollingSummaryCompactor';
import type { RollingSummaryCompactionProfilesConfig } from '../../types/OrchestratorConfig';

/** Picks a profile ID by matching `mode` against keys in a map (prefix/substring match). */
function pickByMode(map: Record<string, string> | undefined, mode: string): string | null {
  if (!map || Object.keys(map).length === 0) return null;
  const modeNorm = mode.trim().toLowerCase();
  const exact = map[modeNorm];
  if (exact) return exact;
  const match = Object.entries(map)
    .map(([key, value]) => ({ key: key.trim().toLowerCase(), value }))
    .filter(({ key }) => key && (modeNorm === key || modeNorm.startsWith(key) || modeNorm.includes(key)))
    .sort((a, b) => b.key.length - a.key.length)[0];
  return match?.value ?? null;
}

export interface RollingSummaryPhaseInput {
  conversationContext: ConversationContext | undefined;
  modeForRouting: string;
  streamId: string;
  /** Base compaction config from orchestrator config (may be null/disabled). */
  rollingSummaryCompactionConfig: RollingSummaryCompactionConfig | null;
  rollingSummaryCompactionProfilesConfig: RollingSummaryCompactionProfilesConfig | null;
  rollingSummarySystemPrompt: string;
  rollingSummaryStateKey: string;
  modelProviderManager: AIModelProviderManager;
}

export interface RollingSummaryPhaseResult {
  result: RollingSummaryCompactionResult | null;
  profileId: string | null;
  configForTurn: RollingSummaryCompactionConfig | null;
  enabled: boolean;
  summaryText: string;
}

/**
 * Runs the turn's rolling-summary pass under the compaction profile the turn's mode picks (`defaultProfileByMode`, else
 * `defaultProfileId`), or under the base settings when no profiles are configured or the picked one is not among them.
 * Every profile reads and writes the conversation's one summary state (`rollingSummaryStateKey`), and that state keeps
 * the head it was built with: the `headMessagesToKeep` of the pass that first wrote it stays the conversation's head
 * under every profile, so a turn under a profile with another head neither leaves out nor repeats the messages between
 * the two heads. The turn's profile sets the rest: whether the summary is on, the kept tail, the limits of a pass, the
 * cooldown, the model and the system prompt.
 *
 * @param input - The turn's conversation, its mode, the base settings, the profiles and the state key.
 * @returns The pass's result, the profile it ran under and its settings, and the summary text for the prompt.
 */
export async function executeRollingSummaryPhase(
  input: RollingSummaryPhaseInput,
): Promise<RollingSummaryPhaseResult> {
  let configForTurn = input.rollingSummaryCompactionConfig;
  let systemPromptForTurn: string | undefined = input.rollingSummarySystemPrompt;
  let profileId: string | null = null;

  // Select profile if profiles config is provided
  if (input.rollingSummaryCompactionProfilesConfig) {
    const profilesConfig = input.rollingSummaryCompactionProfilesConfig;
    const picked =
      pickByMode(profilesConfig.defaultProfileByMode, input.modeForRouting) ??
      profilesConfig.defaultProfileId;
    profileId = picked;
    const profile = profilesConfig.profiles?.[picked];
    if (profile?.config) configForTurn = profile.config;
    if (profile?.systemPrompt) systemPromptForTurn = profile.systemPrompt;
  }

  let result: RollingSummaryCompactionResult | null = null;

  if (input.conversationContext && configForTurn) {
    try {
      const llmCaller = async (call: {
        providerId?: string;
        modelId: string;
        messages: any[];
        options: any;
      }): Promise<string> => {
        const providerIdResolved =
          call.providerId ||
          input.modelProviderManager.getProviderForModel(call.modelId)?.providerId ||
          input.modelProviderManager.getDefaultProvider()?.providerId;
        if (!providerIdResolved) {
          throw new Error(`No provider resolved for rolling-summary model '${call.modelId}'.`);
        }
        const provider = input.modelProviderManager.getProvider(providerIdResolved);
        if (!provider) {
          throw new Error(`Provider '${providerIdResolved}' not found for rolling-summary compaction.`);
        }
        const response = await provider.generateCompletion(call.modelId, call.messages, call.options);
        const choice = response?.choices?.[0];
        const responseContent = choice?.message?.content ?? choice?.text ?? '';
        if (typeof responseContent === 'string') return responseContent.trim();
        if (Array.isArray(responseContent)) {
          return responseContent
            .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
            .filter(Boolean)
            .join('\n')
            .trim();
        }
        return String(responseContent ?? '').trim();
      };

      const stateKey = input.rollingSummaryStateKey;
      const compaction = await maybeCompactConversationMessages({
        messages: input.conversationContext.getAllMessages() as any,
        sessionMetadata: input.conversationContext.getAllMetadata() as any,
        config: configForTurn,
        llmCaller: ({ providerId, modelId, messages, options }) =>
          llmCaller({ providerId, modelId, messages, options }),
        systemPrompt: systemPromptForTurn,
        stateKey,
      });

      result = compaction;
      if (
        compaction.updatedSessionMetadata &&
        Object.prototype.hasOwnProperty.call(compaction.updatedSessionMetadata, stateKey)
      ) {
        input.conversationContext.setMetadata(stateKey, (compaction.updatedSessionMetadata as any)[stateKey]);
      }
    } catch (compactionError: any) {
      console.warn(
        `Rolling summary compaction failed for stream ${input.streamId} (continuing without it).`,
        compactionError,
      );
    }
  }

  const enabled = Boolean(configForTurn?.enabled);
  const summaryText =
    enabled && typeof result?.summaryText === 'string' ? result.summaryText.trim() : '';

  return { result, profileId, configForTurn, enabled, summaryText };
}
