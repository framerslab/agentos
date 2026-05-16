import type { UserContext } from '../../cognition/substrate/IGMI';
import type { ToolExecutionContext } from '../../core/tools/ITool';
import type { IAgentOS } from '../interfaces/IAgentOS';
import type { AgentOSInput } from '../types/AgentOSInput';
import { AgentOSServiceError } from '../errors';
import { GMIErrorCode } from '../../core/utils/errors.js';
import {
  buildScopedExternalToolContextParts,
  executeExternalToolFromRegistry,
  mergeExternalToolRegistries,
  normalizeOptionalString,
  registerTemporaryExternalTools,
  type ExternalToolRegistry,
} from './externalToolRegistry';
import {
  processRequestWithExternalTools,
  type AgentOSExternalToolHandler,
  type AgentOSExternalToolHandlerContext,
} from './processRequestWithExternalTools';
import type { AgentOSResponse } from '../types/AgentOSResponse';

export interface RegisteredExternalToolExecutionOptions {
  /**
   * Optional additional user-context fields to merge into the live tool
   * execution context. `input.userId` always wins.
   */
  userContext?: Partial<UserContext>;
  /**
   * Trusted runtime-only organization context to propagate into both
   * `userContext.organizationId` and `sessionData.organizationId`.
   */
  organizationId?: string;
  /**
   * Optional correlation ID override. Defaults to the tool call ID.
   */
  correlationId?: string;
  /**
   * Optional fallback for actionable external tool calls that are not
   * registered in AgentOS. Use this when the same turn can mix
   * AgentOS-registered tools with custom host-managed tools.
   */
  fallbackExternalToolHandler?: AgentOSExternalToolHandler;
  /**
   * Optional map, array, or iterable of host-managed external tools to use
   * when a tool name is not registered in AgentOS itself.
   */
  externalTools?: ExternalToolRegistry;
}

type RegisteredToolRuntime = Pick<
  IAgentOS,
  'processRequest' | 'handleToolResult' | 'getToolOrchestrator'
> &
  Partial<Pick<IAgentOS, 'getExternalToolRegistry' | 'handleToolResults'>>;

function resolveExternalToolsForRuntime(
  agentos: Partial<Pick<IAgentOS, 'getExternalToolRegistry'>>,
  registry: ExternalToolRegistry | undefined
): ExternalToolRegistry | undefined {
  return mergeExternalToolRegistries(agentos.getExternalToolRegistry?.(), registry);
}

/**
 * Builds the `ToolExecutionContext` for a host-managed external tool call that
 * should execute against AgentOS's registered tool registry during a live
 * `processRequest(...)` stream.
 */
export function buildRegisteredExternalToolExecutionContext(
  input: AgentOSInput,
  context: Pick<AgentOSExternalToolHandlerContext, 'requestChunk' | 'toolCall'>,
  options: RegisteredExternalToolExecutionOptions = {}
): ToolExecutionContext {
  const organizationId = normalizeOptionalString(
    options.organizationId ??
      context.requestChunk.metadata?.organizationId ??
      input.organizationId ??
      options.userContext?.organizationId
  );

  const sessionId =
    normalizeOptionalString(context.requestChunk.metadata?.sessionId) ??
    normalizeOptionalString(input.sessionId) ??
    undefined;
  const conversationId =
    normalizeOptionalString(context.requestChunk.metadata?.conversationId) ??
    normalizeOptionalString(input.conversationId) ??
    sessionId;

  const { userContext, sessionData } = buildScopedExternalToolContextParts({
    userId: input.userId,
    organizationId,
    sessionId,
    conversationId,
    userContext: options.userContext as Record<string, unknown> | undefined,
  });

  return {
    gmiId: context.requestChunk.gmiInstanceId,
    personaId: context.requestChunk.personaId,
    userContext,
    correlationId: normalizeOptionalString(options.correlationId) ?? context.toolCall.id,
    ...(Object.keys(sessionData).length > 0 ? { sessionData } : {}),
  };
}

/**
 * Creates an external-tool handler that executes AgentOS-registered tools with
 * the correct live-turn execution context, then optionally falls back to a
 * host-provided external tool registry or dynamic callback.
 */
export function createRegisteredExternalToolHandler(
  agentos: Pick<IAgentOS, 'getToolOrchestrator'> &
    Partial<Pick<IAgentOS, 'getExternalToolRegistry'>>,
  input: AgentOSInput,
  options: RegisteredExternalToolExecutionOptions = {}
): AgentOSExternalToolHandler {
  const externalTools = resolveExternalToolsForRuntime(agentos, options.externalTools);

  return async ({ agentos: runtime, streamId, requestChunk, toolCall }) => {
    const tool = await agentos.getToolOrchestrator().getTool(toolCall.name);
    if (!tool) {
      const executionContext = buildRegisteredExternalToolExecutionContext(
        input,
        { requestChunk, toolCall },
        options
      );

      const registryExecution = await executeExternalToolFromRegistry(
        externalTools,
        toolCall.name,
        toolCall.arguments,
        executionContext,
        {
          errorOrigin: 'createRegisteredExternalToolHandler',
          failureMessage: `Failed to execute external tool '${toolCall.name}' from externalTools registry`,
        }
      );
      if (registryExecution) {
        return registryExecution;
      }

      if (options.fallbackExternalToolHandler) {
        try {
          return await options.fallbackExternalToolHandler({
            agentos: runtime,
            streamId,
            requestChunk,
            toolCall,
          });
        } catch (error: unknown) {
          throw AgentOSServiceError.wrap(
            error,
            GMIErrorCode.TOOL_ERROR,
            `Failed to execute fallback external tool '${toolCall.name}'`,
            'createRegisteredExternalToolHandler'
          );
        }
      }

      throw new AgentOSServiceError(
        `Registered external tool '${toolCall.name}' is not available.`,
        GMIErrorCode.RESOURCE_NOT_FOUND,
        {
          streamId: requestChunk.streamId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        },
        'createRegisteredExternalToolHandler'
      );
    }

    try {
      const execution = await tool.execute(
        toolCall.arguments,
        buildRegisteredExternalToolExecutionContext(input, { requestChunk, toolCall }, options)
      );

      return {
        toolOutput: execution.output,
        isSuccess: execution.success,
        errorMessage: execution.error,
      };
    } catch (error: unknown) {
      throw AgentOSServiceError.wrap(
        error,
        GMIErrorCode.TOOL_ERROR,
        `Failed to execute registered external tool '${toolCall.name}'`,
        'createRegisteredExternalToolHandler'
      );
    }
  };
}

/**
 * Runs a full `AgentOS.processRequest(...)` turn and executes any actionable
 * external tool pauses against AgentOS's registered tools automatically.
 * Missing tool names can optionally fall back to `externalTools` or
 * `fallbackExternalToolHandler`.
 */
export async function* processRequestWithRegisteredTools(
  agentos: RegisteredToolRuntime,
  input: AgentOSInput,
  options: RegisteredExternalToolExecutionOptions = {}
): AsyncGenerator<AgentOSResponse, void, undefined> {
  const externalTools = resolveExternalToolsForRuntime(agentos, options.externalTools);
  const cleanup = await registerTemporaryExternalTools(
    agentos.getToolOrchestrator(),
    externalTools
  );

  try {
    yield* processRequestWithExternalTools(
      agentos,
      input,
      createRegisteredExternalToolHandler(agentos, input, {
        ...options,
        externalTools,
      })
    );
  } finally {
    await cleanup();
  }
}
