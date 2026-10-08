// File: backend/agentos/api/types/AgentOSInput.ts
/**
 * @fileoverview Defines the unified input structure for the AgentOS API.
 * This interface encapsulates all possible data and options a user or
 * client might provide when interacting with an AgentOS instance.
 * It emphasizes clarity, type safety, and comprehensive data capture for
 * sophisticated GMI interactions.
 *
 * @module backend/agentos/api/types/AgentOSInput
 * @see ../../cognitive_substrate/IGMI.ts For VisionInputData and AudioInputData definitions.
 */

import {
  VisionInputData,
  AudioInputData,
  type UserContext,
} from '../../cognition/substrate/IGMI';
import type { AgentOSMemoryControl } from '../../core/conversation/LongTermMemoryPolicy';

/**
 * Defines the structure for user-provided feedback on a GMI's performance or a specific message.
 * This feedback is crucial for the GMI's adaptive learning capabilities and for system analytics.
 *
 * @interface UserFeedbackPayload
 */
export interface UserFeedbackPayload {
  /** Polarity label. When set, it decides the polarity even if `score` disagrees. */
  rating?: 'positive' | 'negative' | 'neutral';
  /**
   * Numeric rating on a 1 to 5 scale, read when `rating` is absent: 4 and
   * above is positive, 2 and below is negative, anything in between is neutral.
   */
  score?: number;
  /** Free-text comment. Stored in the user's cognitive memory when configured. */
  text?: string;
  tags?: string[];
  /**
   * The answer the user says the assistant should have given. Stored as a
   * semantic memory of the user so later turns can recall it.
   */
  correctedContent?: string;
  /** Identifier of the message the feedback refers to. */
  targetMessageId?: string;
  customData?: Record<string, any>;
}

/**
 * Encapsulates all data and options for a single interaction turn with AgentOS.
 * This structure is designed to be comprehensive, supporting multimodal inputs,
 * persona selection, user-specific API keys, explicit feedback, conversation
 * management, and fine-grained processing controls.
 *
 * @interface AgentOSInput
 */
export interface WorkflowInvocationRequest {
  definitionId: string;
  workflowId?: string;
  conversationId?: string;
  context?: Record<string, unknown>;
  roleAssignments?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

/**
 * Describes a request to create or join an Agency (multi-GMI collective).
 */
export interface AgencyInvocationRequest {
  /**
   * Existing agency identifier to join. If omitted, a new agency is instantiated.
   */
  agencyId?: string;
  /**
   * Optional workflow identifier to bind the agency to.
   */
  workflowId?: string;
  /**
   * High-level description of the shared objective.
   */
  goal?: string;
  /**
   * Desired seats within the agency along with their preferred personas.
   */
  participants?: Array<{ roleId: string; personaId?: string }>;
  /**
   * Arbitrary metadata for agency initialization.
   */
  metadata?: Record<string, unknown>;
}

export interface AgentOSInput {
  userId: string;
  /** Optional organization context used for org-scoped memory + multi-tenant routing. */
  organizationId?: string;
  sessionId: string;
  textInput: string | null;
  visionInputs?: VisionInputData[];
  audioInput?: AudioInputData;
  selectedPersonaId?: string;
  /** Optional explicit language hint from UI (BCP-47 or ISO 639-1). */
  languageHint?: string;
  /** Optional detected languages supplied externally (highest confidence first). */
  detectedLanguages?: Array<{ code: string; confidence: number }>;
  /** Optional target language override (skips negotiation if supported). */
  targetLanguage?: string;
  userApiKeys?: Record<string, string>;
  userFeedback?: UserFeedbackPayload;
  conversationId?: string;
  /**
   * Optional memory control input. Stored in conversation metadata so settings persist across turns.
   * Use this to disable long-term memory for a conversation or enable user/org scope when desired.
   */
  memoryControl?: AgentOSMemoryControl;
  workflowRequest?: WorkflowInvocationRequest;
  agencyRequest?: AgencyInvocationRequest;
  options?: ProcessingOptions;
  userContextOverride?: Partial<UserContext>;
  skillPromptContext?: string;
  disabledSessionSkillIds?: string[];
}

/**
 * Defines fine-grained control options for how AgentOS processes an individual turn.
 * These options can override system defaults or persona-specific settings for the duration
 * of the current request, allowing for dynamic adjustments to GMI behavior and output.
 *
 * @interface ProcessingOptions
 */
export interface ProcessingOptions {
  streamUICommands?: boolean;
  maxToolCallIterations?: number;
  preferredModelId?: string;
  preferredProviderId?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  responseFormat?: { type: 'text' | 'json_object' | string };
  disableAdaptation?: boolean;
  debugMode?: boolean;
  forceNewConversation?: boolean;
  customFlags?: Record<string, any>;
}
