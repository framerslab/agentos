import type { UserContext, ToolCallRequest } from '../../cognition/substrate/IGMI';
import type { ToolExecutionContext } from '../../core/tools/ITool';
import type { IAgentOS } from '../interfaces/IAgentOS';
import { AgentOSServiceError } from '../errors';
import type {
  AgentOSPendingExternalToolRequest,
  AgentOSResumeExternalToolRequestOptions,
} from '../types/AgentOSExternalToolRequest';
import type { AgentOSResponse } from '../types/AgentOSResponse';
import type { AgentOSToolResultInput } from '../types/AgentOSToolResult';
import { GMIErrorCode } from '../../core/utils/errors.js';
import {
  buildScopedExternalToolContextParts,
  executeExternalToolFromRegistry,
  mergeExternalToolRegistries,
  normalizeOptionalString,
  registerTemporaryExternalTools,
  type ExternalToolRegistry,
} from './externalToolRegistry';
import type { AgentOSExternalToolHandlerResult } from './processRequestWithExternalTools';

function buildResumeOptions(
  options: ResumeExternalToolRequestWithRegisteredToolsOptions
): AgentOSResumeExternalToolRequestOptions {
  const resumeOptions: AgentOSResumeExternalToolRequestOptions = {};

  if (options.userApiKeys) {
    resumeOptions.userApiKeys = options.userApiKeys;
  }
  if (options.preferredModelId) {
    resumeOptions.preferredModelId = options.preferredModelId;
  }
  if (options.preferredProviderId) {
    resumeOptions.preferredProviderId = options.preferredProviderId;
  }
  if (options.organizationId) {
    resumeOptions.organizationId = options.organizationId;
  }

  return resumeOptions;
}

export interface PendingExternalToolExecutionOptions {
  /**
   * Optional additional user-context fields to merge into the execution
   * context. `pendingRequest.userId` always wins.
   */
  userContext?: Partial<UserContext>;
  /**
   * Trusted runtime-only organization context to propagate into both
   * `userContext.organizationId` and `sessionData.organizationId`.
   */
  organizationId?: string;
  /**
   * Optional correlation ID for tool execution tracing. Defaults to the pending
   * stream ID when omitted.
   */
  correlationId?: string;
  /**
   * Optional fallback for pending external tool calls that are not registered
   * in AgentOS. Use this when the same persisted pause can mix AgentOS-
   * registered tools with custom host-managed tools.
   */
  fallbackExternalToolHandler?: PendingExternalToolHandler;
  /**
   * Optional map, array, or iterable of host-managed external tools to use
   * when a tool name is not registered in AgentOS itself.
   */
  externalTools?: ExternalToolRegistry;
}

export interface ResumeExternalToolRequestWithRegisteredToolsOptions
  extends PendingExternalToolExecutionOptions,
    AgentOSResumeExternalToolRequestOptions {}

type RegisteredToolExecutionRuntime = Pick<
  IAgentOS,
  'getToolOrchestrator' | 'resumeExternalToolRequest'
> &
  Partial<Pick<IAgentOS, 'getExternalToolRegistry'>>;

function resolveExternalToolsForRuntime(
  agentos: Partial<Pick<IAgentOS, 'getExternalToolRegistry'>>,
  registry: ExternalToolRegistry | undefined
): ExternalToolRegistry | undefined {
  return mergeExternalToolRegistries(agentos.getExternalToolRegistry?.(), registry);
}

export interface PendingExternalToolHandlerContext {
  agentos: Pick<IAgentOS, 'getToolOrchestrator'>;
  pendingRequest: AgentOSPendingExternalToolRequest;
  toolCall: ToolCallRequest;
}

export type PendingExternalToolHandler = (
  context: PendingExternalToolHandlerContext
) => Promise<AgentOSExternalToolHandlerResult>;

/**
 * Builds the `ToolExecutionContext` that a host should use when it wants to
 * execute a persisted external tool pause against AgentOS's registered tool
 * registry after restart.
 */
export function buildPendingExternalToolExecutionContext(
  pendingRequest: AgentOSPendingExternalToolRequest,
  options: PendingExternalToolExecutionOptions = {}
): ToolExecutionContext {
  const organizationId = normalizeOptionalString(
    options.organizationId ?? options.userContext?.organizationId
  );
  const { userContext, sessionData } = buildScopedExternalToolContextParts({
    userId: pendingRequest.userId,
    organizationId,
    sessionId: pendingRequest.sessionId,
    conversationId: pendingRequest.conversationId,
    userContext: options.userContext as Record<string, unknown> | undefined,
  });

  return {
    gmiId: pendingRequest.gmiInstanceId,
    personaId: pendingRequest.personaId,
    userContext,
    correlationId: normalizeOptionalString(options.correlationId) ?? pendingRequest.streamId,
    sessionData,
  };
}

/**
 * Executes one pending external tool call through AgentOS's registered tool
 * registry using the correct resume-time execution context, then optionally
 * falls back to a host-provided external tool registry or dynamic callback.
 */
export async function executePendingExternalToolCall(
  agentos: Pick<IAgentOS, 'getToolOrchestrator'> &
    Partial<Pick<IAgentOS, 'getExternalToolRegistry'>>,
  pendingRequest: AgentOSPendingExternalToolRequest,
  toolCall: ToolCallRequest,
  options: PendingExternalToolExecutionOptions = {}
): Promise<AgentOSToolResultInput> {
  const externalTools = resolveExternalToolsForRuntime(agentos, options.externalTools);
  const tool = await agentos.getToolOrchestrator().getTool(toolCall.name);
  if (!tool) {
    const executionContext = buildPendingExternalToolExecutionContext(pendingRequest, {
      ...options,
      correlationId: options.correlationId ?? toolCall.id,
    });

    const registryExecution = await executeExternalToolFromRegistry(
      externalTools,
      toolCall.name,
      toolCall.arguments,
      executionContext,
      {
        errorOrigin: 'executePendingExternalToolCall',
        failureMessage: `Failed to execute external tool '${toolCall.name}' from externalTools registry`,
      }
    );
    if (registryExecution) {
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        toolOutput: registryExecution.toolOutput,
        isSuccess: registryExecution.isSuccess ?? true,
        errorMessage: registryExecution.errorMessage,
      };
    }

    if (options.fallbackExternalToolHandler) {
      try {
        const execution = await options.fallbackExternalToolHandler({
          agentos,
          pendingRequest,
          toolCall,
        });

        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          toolOutput: execution.toolOutput,
          isSuccess: execution.isSuccess ?? true,
          errorMessage: execution.errorMessage,
        };
      } catch (error: unknown) {
        throw AgentOSServiceError.wrap(
          error,
          GMIErrorCode.TOOL_ERROR,
          `Failed to execute fallback external tool '${toolCall.name}'`,
          'executePendingExternalToolCall'
        );
      }
    }

    throw new AgentOSServiceError(
      `Pending external tool '${toolCall.name}' is not registered.`,
      GMIErrorCode.RESOURCE_NOT_FOUND,
      {
        conversationId: pendingRequest.conversationId,
        streamId: pendingRequest.streamId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      },
      'executePendingExternalToolCall'
    );
  }

  try {
    const execution = await tool.execute(
      toolCall.arguments,
      buildPendingExternalToolExecutionContext(pendingRequest, {
        ...options,
        correlationId: options.correlationId ?? toolCall.id,
      })
    );

    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      toolOutput: execution.output,
      isSuccess: execution.success,
      errorMessage: execution.error,
    };
  } catch (error: unknown) {
    throw AgentOSServiceError.wrap(
      error,
      GMIErrorCode.TOOL_ERROR,
      `Failed to execute pending external tool '${toolCall.name}'`,
      'executePendingExternalToolCall'
    );
  }
}

/**
 * Executes all tool calls from a persisted external-tool pause, in order,
 * through AgentOS's registered tool registry.
 */
export async function executePendingExternalToolCalls(
  agentos: Pick<IAgentOS, 'getToolOrchestrator'> &
    Partial<Pick<IAgentOS, 'getExternalToolRegistry'>>,
  pendingRequest: AgentOSPendingExternalToolRequest,
  options: PendingExternalToolExecutionOptions = {}
): Promise<AgentOSToolResultInput[]> {
  const toolResults: AgentOSToolResultInput[] = [];

  for (const toolCall of pendingRequest.toolCalls) {
    toolResults.push(
      await executePendingExternalToolCall(agentos, pendingRequest, toolCall, options)
    );
  }

  return toolResults;
}

/**
 * Executes all pending registered tool calls from a persisted external-tool
 * pause and immediately resumes the AgentOS stream on the caller's behalf.
 * Missing tool names can optionally fall back to `externalTools` or
 * `fallbackExternalToolHandler`.
 */
export async function* resumeExternalToolRequestWithRegisteredTools(
  agentos: RegisteredToolExecutionRuntime,
  pendingRequest: AgentOSPendingExternalToolRequest,
  options: ResumeExternalToolRequestWithRegisteredToolsOptions = {}
): AsyncGenerator<AgentOSResponse, void, undefined> {
  const externalTools = resolveExternalToolsForRuntime(agentos, options.externalTools);
  const toolResults = await executePendingExternalToolCalls(agentos, pendingRequest, {
    ...options,
    externalTools,
  });
  const cleanup = await registerTemporaryExternalTools(
    agentos.getToolOrchestrator(),
    externalTools
  );

  try {
    yield* agentos.resumeExternalToolRequest(
      pendingRequest,
      toolResults,
      buildResumeOptions(options)
    );
  } finally {
    await cleanup();
  }
}
