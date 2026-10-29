// File: backend/agentos/api/interfaces/IAgentOS.ts
/**
 * @fileoverview Defines the core interface for the public-facing AgentOS class.
 * This interface outlines the contract for interacting with the unified AgentOS platform,
 * emphasizing a streaming-first approach, robust error handling, comprehensive
 * interaction capabilities, and seamless persona/agent management.
 *
 * @module backend/agentos/api/interfaces/IAgentOS
 */

import { AgentOSInput, UserFeedbackPayload } from '../types/AgentOSInput';
import { AgentOSResponse } from '../types/AgentOSResponse';
import type {
  AgentOSPendingExternalToolRequest,
  AgentOSResumeExternalToolRequestOptions,
} from '../types/AgentOSExternalToolRequest';
import type { AgentOSToolResultInput } from '../types/AgentOSToolResult';
import { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';
import { ConversationContext } from '../../core/conversation/ConversationContext';
import type { AgentOSConfig, AgentOSRuntimeSnapshot } from '../AgentOS';
import type {
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowProgressUpdate,
  WorkflowStatus,
} from '../../orchestration/workflows/WorkflowTypes';
import type {
  WorkflowQueryOptions,
  WorkflowTaskUpdate,
} from '../../orchestration/workflows/storage/IWorkflowStore';
import type { ConversationManager } from '../../core/conversation/ConversationManager';
import type { GMIManager } from '../../cognition/substrate/GMIManager';
import type { ExtensionManager } from '../../extensions';
import type { IToolOrchestrator, ToolDefinitionForLLM } from '../../core/tools/IToolOrchestrator';
import type { AIModelProviderManager } from '../../core/llm/providers/AIModelProviderManager';
import type { ExternalToolRegistry } from '../runtime/externalToolRegistry';

/**
 * @interface IAgentOS
 * @description
 * Defines the contract for the main AgentOS system service, serving as the single,
 * unified entry point for all interactions with the AI agent platform.
 * It abstracts the underlying GMI and orchestration complexities, providing
 * a clear and powerful API for client applications.
 */
export interface IAgentOS {
  /**
   * Initializes the AgentOS system with all necessary configurations and dependencies.
   * @param {AgentOSConfig} config - The comprehensive configuration object for AgentOS.
   * @returns {Promise<void>} A promise that resolves once AgentOS is fully initialized.
   * @throws {Error} If initialization fails due to missing or invalid configurations.
   */
  initialize(config: AgentOSConfig): Promise<void>;

  /**
   * Processes a user request or initiates an agent task.
   * @param {AgentOSInput} input - The comprehensive input for the current turn.
   * @returns {AsyncGenerator<AgentOSResponse, void, undefined>} An async generator that
   * yields `AgentOSResponse` chunks.
   * @throws {Error} If AgentOS is not initialized or if a critical error occurs.
   */
  processRequest(input: AgentOSInput): AsyncGenerator<AgentOSResponse, void, undefined>;

  /**
   * Handles the result of a tool execution that was previously requested by an agent.
   * @param {string} streamId - The original stream ID associated with the initial request.
   * @param {string} toolCallId - The unique ID of the specific tool call.
   * @param {string} toolName - The name of the tool that was executed.
   * @param {any} toolOutput - The raw output or result data from the tool execution.
   * @param {boolean} isSuccess - Indicates whether the tool execution was successful.
   * @param {string} [errorMessage] - An optional error message if `isSuccess` is false.
   * @returns {AsyncGenerator<AgentOSResponse, void, undefined>} An async generator that yields
   * response chunks after processing the tool result.
   * @throws {Error} If the `streamId` or `toolCallId` is invalid.
   *
   * A pause is continued once. When the conversation no longer holds the pause
   * the stream stopped for (its results were passed already, it was resumed on
   * another stream, a newer turn ended it, or the stream's next pause replaced
   * it), or the result answers none of its calls, the stream yields one error
   * chunk with the code `SYS_INVALID_STATE` and the GMI takes none of the
   * results.
   */
  handleToolResult(
    streamId: string,
    toolCallId: string,
    toolName: string,
    toolOutput: any,
    isSuccess: boolean,
    errorMessage?: string
  ): AsyncGenerator<AgentOSResponse, void, undefined>;

  /**
   * Handles a batch of externally executed tool results that belong to the same
   * paused stream and continues the agent interaction once.
   * @param {string} streamId - The original stream ID associated with the paused request.
   * @param {AgentOSToolResultInput[]} toolResults - Ordered tool results to apply to the paused turn.
   * @returns {AsyncGenerator<AgentOSResponse, void, undefined>} An async generator that yields
   * response chunks after processing the tool results.
   * @throws {Error} If the `streamId` is invalid or the tool result batch is empty.
   *
   * The batch continues the pause once, as `handleToolResult()` does: a batch
   * for a pause the conversation no longer holds, or with a result for a call
   * the stream does not wait on, yields one error chunk with the code
   * `SYS_INVALID_STATE`.
   */
  handleToolResults?(
    streamId: string,
    toolResults: AgentOSToolResultInput[]
  ): AsyncGenerator<AgentOSResponse, void, undefined>;

  /**
   * Lists registered workflow definitions available via the extension manager.
   * @returns {WorkflowDefinition[]} Array of available workflow definitions.
   */
  listWorkflowDefinitions(): WorkflowDefinition[];

  /**
   * Starts a workflow instance using the specified definition and input payload.
   * @param {string} definitionId - The ID of the workflow definition to instantiate.
   * @param {AgentOSInput} input - The input payload for the workflow.
   * @param {Object} [options] - Optional configuration for the workflow instance.
   * @returns {Promise<WorkflowInstance>} The created workflow instance.
   */
  startWorkflow(
    definitionId: string,
    input: AgentOSInput,
    options?: {
      workflowId?: string;
      conversationId?: string;
      createdByUserId?: string;
      context?: Record<string, unknown>;
      roleAssignments?: Record<string, string>;
      metadata?: Record<string, unknown>;
    }
  ): Promise<WorkflowInstance>;

  /**
   * Retrieves a workflow instance by its identifier.
   * @param {string} workflowId - The workflow instance ID.
   * @returns {Promise<WorkflowInstance | null>} The workflow instance or null if not found.
   */
  getWorkflow(workflowId: string): Promise<WorkflowInstance | null>;

  /**
   * Lists workflow instances matching the provided filters.
   * @param {WorkflowQueryOptions} [options] - Optional query filters.
   * @returns {Promise<WorkflowInstance[]>} Array of matching workflow instances.
   */
  listWorkflows(options?: WorkflowQueryOptions): Promise<WorkflowInstance[]>;

  /**
   * Retrieves workflow progress details, including recent events.
   * @param {string} workflowId - The workflow instance ID.
   * @param {string} [sinceTimestamp] - Optional timestamp to get events since.
   * @returns {Promise<WorkflowProgressUpdate | null>} Progress details or null if not found.
   */
  getWorkflowProgress(
    workflowId: string,
    sinceTimestamp?: string
  ): Promise<WorkflowProgressUpdate | null>;

  /**
   * Updates the high-level workflow status (e.g., cancel, complete).
   * @param {string} workflowId - The workflow instance ID.
   * @param {WorkflowStatus} status - The new status to set.
   * @returns {Promise<WorkflowInstance | null>} Updated workflow instance or null if not found.
   */
  updateWorkflowStatus(
    workflowId: string,
    status: WorkflowStatus
  ): Promise<WorkflowInstance | null>;

  /**
   * Applies task-level updates to a workflow instance.
   * @param {string} workflowId - The workflow instance ID.
   * @param {WorkflowTaskUpdate[]} updates - Array of task updates to apply.
   * @returns {Promise<WorkflowInstance | null>} Updated workflow instance or null if not found.
   */
  applyWorkflowTaskUpdates(
    workflowId: string,
    updates: WorkflowTaskUpdate[]
  ): Promise<WorkflowInstance | null>;

  /**
   * Retrieves a list of all available persona definitions (agents) configured in the system.
   * @param {string} [userId] - Optional user ID for filtering based on permissions.
   * @returns {Promise<Partial<IPersonaDefinition>[]>} Array of partial persona definitions.
   * @throws {Error} If AgentOS is not initialized.
   */
  listAvailablePersonas(userId?: string): Promise<Partial<IPersonaDefinition>[]>;

  /**
   * Retrieves the full conversation history for a given conversation ID.
   * @param {string} conversationId - The unique ID of the conversation.
   * @param {string} userId - The ID of the user requesting the conversation.
   * @returns {Promise<ConversationContext | null>} The conversation context or null.
   * @throws {Error} If AgentOS is not initialized or if a database error occurs.
   */
  getConversationHistory(
    conversationId: string,
    userId: string
  ): Promise<ConversationContext | null>;

  /**
   * Returns the pending external-tool pause snapshot for a conversation, if one
   * was persisted during an actionable TOOL_CALL_REQUEST pause. A pause saved
   * by a stream an output guardrail blocked is never returned: it is dropped
   * once the stream's turn ends, and this returns `null` for it meanwhile.
   */
  getPendingExternalToolRequest(
    conversationId: string,
    userId: string
  ): Promise<AgentOSPendingExternalToolRequest | null>;

  /**
   * Resumes a previously persisted external-tool pause after restart using the
   * saved pause snapshot and the host-provided tool results.
   *
   * Hosts can re-assert runtime-only organization context through `options`
   * when the resumed turn needs organization-scoped memory or tenant routing.
   *
   * A pause is resumed once. When the conversation no longer holds the pause
   * the snapshot names (its results were passed on its stream, an output
   * guardrail blocked its stream, a newer turn ended it, or a newer pause
   * replaced it) or another resume of it is under way, the stream yields one
   * error chunk with the code `SYS_INVALID_STATE` and the GMI takes none of the
   * results. Such a resume is refused before the session's GMI is acquired, so
   * it changes neither the conversation nor that GMI. A resume ends the stream
   * the pause was saved on.
   *
   * The once-only rule holds within one AgentOS instance: instances that share
   * a conversation store do not see each other's resumes, so a deployment with
   * several instances sends one conversation's resumes to one instance at a
   * time.
   */
  resumeExternalToolRequest(
    pendingRequest: AgentOSPendingExternalToolRequest,
    toolResults: AgentOSToolResultInput[],
    options?: AgentOSResumeExternalToolRequestOptions
  ): AsyncGenerator<AgentOSResponse, void, undefined>;

  /**
   * Returns a serializable runtime/devtools snapshot of the initialized AgentOS instance.
   */
  getRuntimeSnapshot(): Promise<AgentOSRuntimeSnapshot>;

  /**
   * Explicit runtime getters for devtools integrations such as AgentOS Workbench.
   */
  getConversationManager(): ConversationManager;
  getGMIManager(): GMIManager;
  getExtensionManager(): ExtensionManager;
  getToolOrchestrator(): IToolOrchestrator;
  getExternalToolRegistry(): ExternalToolRegistry | undefined;
  listExternalToolsForLLM(): ToolDefinitionForLLM[];
  getModelProviderManager(): AIModelProviderManager;

  /**
   * Receives and processes explicit user feedback.
   * @param {string} userId - The ID of the user providing feedback.
   * @param {string} sessionId - The ID of the session the feedback pertains to.
   * @param {string} personaId - The ID of the GMI persona the feedback is about.
   * @param {UserFeedbackPayload} feedbackPayload - The structured feedback payload.
   * @returns {Promise<void>} A promise that resolves when feedback is accepted.
   * @throws {Error} If AgentOS is not initialized or if feedback processing fails.
   */
  receiveFeedback(
    userId: string,
    sessionId: string,
    personaId: string,
    feedbackPayload: UserFeedbackPayload
  ): Promise<void>;

  /**
   * Gracefully shuts down the AgentOS system and all its sub-components.
   * @returns {Promise<void>} A promise that resolves when shutdown is complete.
   * @throws {Error} If a critical error occurs during shutdown.
   */
  shutdown(): Promise<void>;
}
