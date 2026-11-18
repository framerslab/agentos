import type { ToolCallRequest } from '../../cognition/substrate/IGMI';

/**
 * Conversation-metadata snapshot describing an external tool pause that can be
 * recovered after process restart.
 */
export interface AgentOSPendingExternalToolRequest {
  streamId: string;
  sessionId: string;
  conversationId: string;
  userId: string;
  personaId: string;
  gmiInstanceId: string;
  toolCalls: ToolCallRequest[];
  rationale?: string;
  requestedAt: string;
}

/**
 * Optional runtime-only data needed when resuming a persisted external tool
 * pause after the original AgentOS process is gone.
 */
export interface AgentOSResumeExternalToolRequestOptions {
  userApiKeys?: Record<string, string>;
  preferredModelId?: string;
  preferredProviderId?: string;
  /**
   * Trusted request-scoped organization context to re-apply after restart.
   *
   * This is intentionally runtime-only and is not persisted into conversation
   * metadata, so callers must re-supply it after tenant membership checks when
   * the resumed turn needs organization-scoped memory or routing.
   */
  organizationId?: string;
  /**
   * The note of the turn this resume continues (`AgentOSInput.applicationNote`). Unset, the continuation sends the
   * paused stream's note while this process holds that stream, and none after a restart; an empty or blank note sends
   * none. Runtime-only like `organizationId`: the pause never stores it.
   */
  applicationNote?: string;
}

export const AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY =
  'agentosPendingExternalToolRequest';
