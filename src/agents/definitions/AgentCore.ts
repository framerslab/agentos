/**
 * @fileoverview Provides an abstract base class, `AgentCore`, for all agents in AgentOS.
 * This class implements the `IAgent` interface and offers foundational functionalities
 * common to most agents, such as configuration management, basic state handling,
 * interaction with the PromptEngine, AI Model Providers, and an optional UtilityAI service.
 *
 * Concrete agent implementations (e.g., a `SimpleChatAgent`, `ToolUsingAgent`, or `AgentPoolAgent`)
 * should extend `AgentCore` and implement the abstract `processTurn` method, which defines
 * the agent's primary turn-taking logic. `AgentCore` provides protected helper methods
 * for common tasks like LLM calls and response parsing, promoting code reuse and consistency.
 *
 * The design emphasizes:
 * - Clear separation of concerns: Agent logic is distinct from orchestration or tool execution.
 * - Configurability: Agents are defined by an `AgentConfig` object.
 * - Extensibility: Easy to create new agent types by inheriting from `AgentCore`.
 * - Dependency Injection: Core services (PromptEngine, ProviderManager, etc.) are injected.
 * @module backend/agentos/agents/definitions/AgentCore
 */

import { IAgent, AgentOutput, AgentToolCall } from './IAgent';
import { ConversationContext } from '../../core/conversation/ConversationContext';
import { IProvider, ModelCompletionOptions, ModelCompletionResponse, ChatMessage, MessageContent } from '../../core/llm/providers/IProvider';
import { IPromptEngine, PromptComponents, ModelTargetInfo, PromptEngineResult } from '../../core/llm/IPromptEngine';
import type { Tool, ToolDefinition } from './tools/Tool';
import type { ITool } from '../../core/tools/ITool';
import type { UIComponentSpecification } from '../../core/utils/IUIComponent';
import { IUtilityAI } from '../../cognition/nlp/ai_utilities/IUtilityAI';
import { MessageRole } from '../../core/conversation/ConversationMessage';
import { AgentPoolConfig } from './AgentPoolConfig';
import { IAgentFactory } from './IAgentFactory';
// AIModelProviderManager import moved to IAgentFactory (used for AgentDependencies type)

/**
 * Defines the type of an agent, used for categorization and potentially for
 * determining specific handling or factory instantiation logic.
 * @enum {string}
 */
export enum AgentType {
  /** A standard, general-purpose agent. */
  STANDARD = 'standard',
  /** An agent that manages a pool of other sub-agents (e.g., a router or mixture-of-experts). */
  POOL = 'pool',
  /** A specialized agent focused on a particular task or domain. */
  SPECIALIZED = 'specialized',
  /** An agent primarily designed for research or experimental purposes. */
  RESEARCH = 'research',
}

/**
 * Configuration options for an agent instance extending `AgentCore`.
 * This rich configuration object defines all aspects of an agent's behavior and capabilities.
 * @interface AgentConfig
 */
export interface AgentConfig {
  /**
   * Unique identifier for the agent configuration.
   * This ID is used by the `AgentFactory` to load and instantiate the agent.
   * @type {string}
   * @example "customer_service_agent_v1"
   */
  id: string;

  /**
   * Human-readable name of the agent.
   * @type {string}
   * @example "Friendly Customer Service Bot"
   */
  name: string;

  /**
   * A detailed description of the agent's purpose, capabilities, typical use cases,
   * and any notable characteristics or limitations.
   * @type {string}
   */
  description: string;

  /**
   * The type of agent this configuration describes (e.g., 'standard', 'pool').
   * This helps in categorizing agents and can be used by factories or orchestrators.
   * @type {AgentType}
   * @default AgentType.STANDARD
   */
  type?: AgentType;

  /**
   * The system prompt defining the agent's core role, personality, high-level instructions,
   * constraints, and desired output format. This is fundamental to guiding the LLM's behavior.
   * It can be a single string or an array of prioritized messages for more complex system instructions.
   * @type {string | Array<{ content: string; priority?: number }>}
   * @example "You are a helpful assistant that speaks like a pirate."
   */
  systemPrompt: string | Array<{ content: string; priority?: number }>;

  /**
   * Information about the primary AI model (LLM) this agent prefers or is optimized for.
   * This is used by the `PromptEngine` for formatting and by the `AIModelProviderManager`
   * (via `AgentFactory`) to select the appropriate `IProvider` instance for this agent.
   * @type {ModelTargetInfo}
   */
  modelTargetInfo: ModelTargetInfo;

  /**
   * Default completion options to use when calling the LLM provider for this agent.
   * These can include parameters like temperature, max_tokens, top_p, etc.
   * These defaults can be overridden on a per-call basis if needed.
   * @type {Partial<ModelCompletionOptions>}
   * @optional
   */
  defaultModelCompletionOptions?: Partial<ModelCompletionOptions>;

  /**
   * An array of tool IDs that this agent is configured and permitted to use.
   * The `AgentOrchestrator` or `ToolExecutor` will provide actual `Tool` instances based on these IDs.
   * @type {string[]}
   * @optional
   * @example ["web_search", "calculator", "database_query_tool"]
   */
  toolIds?: string[];

  /**
   * Optional: Name of a specific prompt template registered with the `IPromptEngine`
   * that this agent should use by default. If not provided, the `PromptEngine`'s
   * system-wide default template will be used.
   * @type {string}
   * @optional
   */
  promptTemplateName?: string;

  /**
   * Agent-specific overrides for the global `PromptEngine` configuration.
   * This allows fine-tuning of prompt construction aspects like history truncation
   * or summarization strategies specifically for this agent.
   * @type {Partial<import('../../core/llm/IPromptEngine').PromptEngineConfig>}
   * @optional
   */
  promptEngineConfigOverrides?: Partial<import('../../core/llm/IPromptEngine').PromptEngineConfig>;

  /**
   * Optional: Identifier for a specific `IUtilityAI` service instance that this agent
   * might use directly for utility tasks (e.g., advanced text analysis, classification)
   * not handled by the `PromptEngine` or standard tools.
   * @type {string}
   * @optional
   */
  utilityAIServiceId?: string;

  /**
   * Configuration specific to an agent operating as an Agent Pool.
   * This field is only present and relevant if `type` is `AgentType.POOL`.
   * @type {AgentPoolConfig}
   * @optional
   */
  agentPoolOptions?: AgentPoolConfig;

  /**
   * Optional: A meta-system prompt specifically for guiding the agent when it encounters
   * unexpected situations, errors from tools, or ambiguous user inputs. This helps the
   * agent to explain issues gracefully or ask for clarification.
   * @type {string}
   * @optional
   * @example "If a tool fails or you don't understand, politely explain the issue and ask the user for more details or an alternative approach."
   */
  metaSystemPromptForUnexpectedSituations?: string;

  /**
   * Optional provenance system configuration.
   * Controls storage immutability, signed event logging, and autonomy enforcement.
   * Use `profiles.mutableDev()`, `profiles.revisionedVerified()`, or
   * `profiles.sealedAutonomous()` for preset configurations.
   * @optional
   */
  provenanceConfig?: import('../../safety/provenance/types.js').ProvenanceSystemConfig;

  /**
   * Allows for adding any other agent-specific custom settings or metadata.
   * This provides an extension point for future or specialized agent properties.
   * @type {{ [key: string]: any }}
   * @optional
   */
  [key: string]: any;
}

/**
 * Custom error class for issues specific to AgentCore operations.
 * @class AgentCoreError
 * @extends {Error}
 */
export class AgentCoreError extends Error {
  /**
   * A specific error code related to AgentCore.
   * @type {string}
   */
  public readonly code: string;
  /**
   * Optional details or the underlying error.
   * @type {any}
   * @optional
   */
  public readonly details?: any;

  /**
   * Creates an instance of AgentCoreError.
   * @param {string} message - The error message.
   * @param {string} code - The error code (e.g., 'LLM_CALL_FAILED', 'PROMPT_PARSE_ERROR').
   * @param {any} [details] - Additional error details.
   */
  constructor(message: string, code: string, details?: any) {
    super(message);
    this.name = 'AgentCoreError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, AgentCoreError.prototype);
  }
}


/**
 * Provides a foundational abstract class for creating specialized agents.
 * It manages configuration, interaction with the `PromptEngine`, `IProvider` (LLM),
 * and an optional `IUtilityAI` service. Concrete agents must implement `processTurn`.
 *
 * @class AgentCore
 * @abstract
 * @implements {IAgent}
 */
export abstract class AgentCore implements IAgent {
  /** @inheritdoc */
  public readonly id: string;
  /** @inheritdoc */
  public readonly name: string;
  /** @inheritdoc */
  public readonly description: string;
  /** @inheritdoc */
  public agentConfig: AgentConfig;

  /**
   * An instance of the `IPromptEngine` used for constructing prompts.
   * @protected
   * @type {IPromptEngine}
   */
  protected promptEngine: IPromptEngine;

  /**
   * The primary `IProvider` (LLM provider) instance configured for this agent.
   * @protected
   * @type {IProvider}
   */
  protected llmProvider: IProvider;

  /**
   * An optional instance of an `IUtilityAI` service for auxiliary AI tasks.
   * @protected
   * @type {IUtilityAI | undefined}
   */
  protected utilityAI?: IUtilityAI;

  /**
   * An optional instance of `IAgentFactory`. This is typically injected if this agent
   * (e.g., an `AgentPoolAgent`) needs to create or manage sub-agents.
   * @protected
   * @type {IAgentFactory | undefined}
   */
  protected agentFactory?: IAgentFactory;

  /**
   * Indicates if the agent has been successfully initialized.
   * @protected
   * @type {boolean}
   */
  protected isInitialized: boolean = false;

  /**
   * Constructs an `AgentCore` instance.
   *
   * @param {AgentConfig} config - The configuration for this agent. Must include `id`, `name`,
   * `description`, `systemPrompt`, and `modelTargetInfo`.
   * @param {IPromptEngine} promptEngine - An instance of the `IPromptEngine`.
   * @param {IProvider} llmProvider - The primary AI model provider for this agent.
   * @param {IUtilityAI} [utilityAI] - Optional. An instance of an `IUtilityAI` service.
   * @param {IAgentFactory} [agentFactory] - Optional. An instance of `IAgentFactory`,
   * primarily for agents that manage other agents (e.g., `AgentPoolAgent`).
   * @throws {AgentCoreError} If essential configuration or dependencies are missing.
   */
  constructor(
    config: AgentConfig,
    promptEngine: IPromptEngine,
    llmProvider: IProvider,
    utilityAI?: IUtilityAI,
    agentFactory?: IAgentFactory
  ) {
    if (!config || !config.id || !config.name || !config.description || !config.systemPrompt || !config.modelTargetInfo) {
      throw new AgentCoreError(
        "AgentCore: Missing required configuration properties (id, name, description, systemPrompt, modelTargetInfo).",
        'AGENT_CONFIG_INVALID'
      );
    }
    if (!promptEngine) {
        throw new AgentCoreError("AgentCore: IPromptEngine dependency is required.", 'DEPENDENCY_MISSING_PROMPTENGINE');
    }
    if (!llmProvider) {
        throw new AgentCoreError("AgentCore: IProvider (llmProvider) dependency is required.", 'DEPENDENCY_MISSING_LLMPROVIDER');
    }

    this.id = config.id;
    this.name = config.name;
    this.description = config.description;
    this.agentConfig = { type: AgentType.STANDARD, ...config }; // Default type if not specified
    this.promptEngine = promptEngine;
    this.llmProvider = llmProvider;
    this.utilityAI = utilityAI;
    this.agentFactory = agentFactory;

    // console.log(`AgentCore instance '${this.name}' (ID: ${this.id}) constructed. Awaiting initialization.`);
  }

  /**
   * Ensures the agent has been initialized before performing operations that depend on it.
   * @protected
   * @throws {AgentCoreError} If the agent is not initialized.
   */
  protected ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new AgentCoreError(
        `Agent '${this.name}' (ID: ${this.id}) is not initialized. Call initialize() first.`,
        'AGENT_NOT_INITIALIZED'
      );
    }
  }

  /**
   * Abstract method that concrete agent classes must implement to process a turn.
   */
  public abstract processTurn(
    userInput: string | null,
    conversationContext: ConversationContext,
    availableTools?: Tool[]
  ): Promise<AgentOutput>;

  /**
   * Handles results from tool calls requested by this agent.
   *
   * Subclasses can override this when they need tool-specific handling logic.
   *
   * @throws {AgentCoreError} If adding the tool result to context fails or if the LLM call for explanation fails.
   */
  public async handleToolResult(
    toolCallId: string,
    toolOutput: any,
    toolName: string,
    conversationContext: ConversationContext,
  ): Promise<AgentOutput> {
    this.ensureInitialized();
    // console.log(`Agent '${this.name}': Handling tool result for call '${toolCallId}' from tool '${toolName}'.`);

    try {
      conversationContext.addMessage({
        role: MessageRole.TOOL,
        content: typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput, null, 2),
        tool_call_id: toolCallId,
        name: toolName, // Standard practice to include tool name here
      });
    } catch (error: any) {
      console.error(`Agent '${this.name}': Failed to add tool result to conversation context: ${error.message}`, error);
      // This is a significant issue as context is now inconsistent.
      throw new AgentCoreError(
        `Failed to add tool result for '${toolName}' to context: ${error.message}`,
        'CONTEXT_UPDATE_FAILED_TOOL_RESULT',
        error
      );
    }

    // Default behavior: Attempt to explain/summarize the tool output using the LLM.
    // This is particularly useful if the tool output is verbose or technical.
    let summarizedOutput = `Tool '${toolName}' (call ID: ${toolCallId}) executed.`;
    if (toolOutput !== undefined && toolOutput !== null) {
        summarizedOutput += ` Output: ${typeof toolOutput === 'string' ? toolOutput.substring(0, 500) : JSON.stringify(toolOutput).substring(0, 500)}`;
        if (summarizedOutput.length > 500) summarizedOutput += "... (output truncated for summary prompt)";
    } else {
        summarizedOutput += " The tool did not produce any explicit output content."
    }


    // Use a meta-prompt to guide the LLM in processing the tool output.
    const metaSystemPromptContent = this.agentConfig.metaSystemPromptForUnexpectedSituations ||
      `You are an AI assistant. A tool named '${toolName}' was just executed as part of your thought process.
      Its output is: "${summarizedOutput}".
      Your task is to now decide the next step. You can either:
      1. Formulate a response to the user based on this tool output and the conversation history.
      2. Decide to call another tool if necessary.
      3. Ask the user for clarification if the tool output is ambiguous or insufficient.
      Present your decision or response clearly.`;

    try {
      const promptComponents: Partial<PromptComponents> = {
        systemPrompts: [{ content: metaSystemPromptContent, priority: -100 }], // High priority for meta-task
        conversationHistory: [...conversationContext.getHistory()], // Pass full available history
        // No direct userInput here; the "input" is effectively the tool result.
        // The LLM prompt will need to be framed such that it processes the history + tool result.
      };

      // We need a user-like message to "prompt" the LLM about the tool result
      const userPromptForToolResult = `The tool '${toolName}' has completed. Output: ${summarizedOutput}. What is the next step or the response to the user?`;
      promptComponents.userInput = userPromptForToolResult;


      const llmResponse = await this.callLLM(this.llmProvider, promptComponents, {
        temperature: this.agentConfig.defaultModelCompletionOptions?.temperature ?? 0.5, // Default or configured
        maxTokens: this.agentConfig.defaultModelCompletionOptions?.maxTokens ?? 1000, // Allow ample space for reasoning
        // Tools should still be available if the agent needs to chain tool calls
        tools: this.agentConfig.toolIds ? (await this.getAvailableToolDefinitions(this.agentConfig.toolIds)) : undefined,
      });

      const parsedResponse = this.parseLLMResponse(llmResponse);

      return {
        responseText: parsedResponse.responseText ?? undefined,
        toolCalls: parsedResponse.toolCalls,
        isComplete: !parsedResponse.toolCalls || parsedResponse.toolCalls.length === 0, // Complete if no further tool calls
        rawModelResponse: parsedResponse.rawResponseMessage,
        metadata: { processedToolResult: toolName, toolCallId },
      };

    } catch (llmError: any) {
      const errorMsg = `Agent '${this.name}': Failed to process tool result for '${toolName}' using LLM: ${llmError.message}`;
      console.error(errorMsg, llmError);
      return {
        responseText: `I received a result from the '${toolName}' tool, but I encountered an issue while trying to process it. Please try rephrasing your request or try again later.`,
        isComplete: true, // Mark as complete as it cannot proceed with this path.
        error: new AgentCoreError(errorMsg, 'TOOL_RESULT_LLM_PROCESSING_FAILED', llmError),
      };
    }
  }

  /**
   * Initializes the agent with optional configuration overrides.
   */
  public async initialize(config?: Record<string, any>): Promise<void> {
    if (this.isInitialized && !config) {
        // console.log(`Agent '${this.name}' (ID: ${this.id}) already initialized. Skipping no-op re-initialization.`);
        return;
    }
    if (config) {
      // Shallow-merge override. Replace the field rather than mutating
      // in place so the assignment respects the public field contract.
      this.agentConfig = { ...this.agentConfig, ...config };
    }
    this.isInitialized = true;
    // console.log(`Agent '${this.name}' (ID: ${this.id}) initialized. Config:`, this.agentConfig);
  }

  /**
   * Resets any agent-specific state between conversations or sessions.
   */
  public reset(): void {
    this.ensureInitialized(); // Should be initialized to be reset
    // console.log(`Agent '${this.name}' (ID: ${this.id}) state reset. (Base implementation, no specific state cleared here).`);
    // Subclasses should call super.reset() and then clear their own state.
  }

  /**
   * Provides a default implementation for handling internal agent errors.
   *
   * This method leverages the agent's primary LLM to generate a user-friendly explanation
   * of the error and potentially ask for user guidance.
   *
   * @throws {AgentCoreError} If the LLM call for error explanation itself fails.
   */
  public async handleInternalAgentError(
    internalErrorDescriptionOrError: string | Error,
    conversationContext: ConversationContext,
    isFatalForTurn: boolean = true
  ): Promise<AgentOutput> {
    this.ensureInitialized();
    const internalErrorDescription = typeof internalErrorDescriptionOrError === 'string' ? internalErrorDescriptionOrError : internalErrorDescriptionOrError.message;
    console.error(`Agent '${this.name}' (ID: ${this.id}) encountered an internal error: ${internalErrorDescription}`,
                  typeof internalErrorDescriptionOrError !== 'string' ? internalErrorDescriptionOrError : '');

    const metaSystemPrompt = this.agentConfig.metaSystemPromptForUnexpectedSituations ||
      `You are an AI assistant. You've encountered an internal operational issue.
      Your task is to clearly and apologetically explain this problem to the user.
      If possible, suggest how the user might rephrase their request or provide information that could help.
      The internal issue was: "${internalErrorDescription.substring(0, 300)}${internalErrorDescription.length > 300 ? '...' : ''}".`;

    try {
      const promptComponents: Partial<PromptComponents> = {
        systemPrompts: [{ content: metaSystemPrompt, priority: -200 }], // High priority for this meta-task
        conversationHistory: [...conversationContext.getHistory(3)], // Limited recent history for context
        userInput: `I've encountered an internal technical difficulty described as: "${internalErrorDescription}". I need to inform the user about this. How should I phrase it and what should I suggest?`,
      };

      const llmResponse = await this.callLLM(this.llmProvider, promptComponents, {
        temperature: 0.5, // Neutral temperature for explanation
        maxTokens: 500,    // Sufficient for a concise explanation
        tools: [], // Typically no tools needed to explain an error
      });

      const parsedResponse = this.parseLLMResponse(llmResponse);

      return {
        responseText: parsedResponse.responseText || `I'm sorry, I've encountered an unexpected internal issue and cannot proceed as expected with your request. The issue was related to: ${internalErrorDescription.substring(0,100)}...`,
        isComplete: isFatalForTurn,
        error: new AgentCoreError(internalErrorDescription, 'INTERNAL_AGENT_ERROR_EXPLAINED', internalErrorDescriptionOrError),
        rawModelResponse: parsedResponse.rawResponseMessage,
      };

    } catch (llmError: any) {
      const errorMsg = `Agent '${this.name}': Critical failure. LLM failed to generate an explanation for its own internal error: ${llmError.message}`;
      console.error(errorMsg, llmError);
      // Fallback to a very generic error message if the LLM can't even explain the error.
      throw new AgentCoreError(errorMsg, 'INTERNAL_ERROR_EXPLANATION_FAILED', llmError);
    }
  }

  /**
   * Protected helper to construct prompt components for the `PromptEngine`.
   * Gathers system prompt, conversation history, user input, and tool schemas based on agent configuration.
   *
   * @protected
   * @param {string | null} userInput - The current user input.
   * @param {ConversationContext} conversationContext - The conversation context.
   * @param {Tool[]} [availableTools] - Tools available for this turn.
   * @param {Array<{ content: string; priority?: number }>} [additionalSystemPrompts] - Optional additional system prompts to layer in.
   * @returns {Promise<Partial<PromptComponents>>} The assembled prompt components.
   * @throws {AgentCoreError} If `PromptEngine`'s configuration cannot be accessed.
   */
  protected async gatherPromptComponents(
    userInput: string | null,
    conversationContext: ConversationContext,
    availableTools?: Tool[],
    additionalSystemPrompts?: Array<{ content: string; priority?: number }>
  ): Promise<Partial<PromptComponents>> {
    this.ensureInitialized();

    const systemPromptsFromConfig = Array.isArray(this.agentConfig.systemPrompt)
      ? [...this.agentConfig.systemPrompt]
      : [{ content: this.agentConfig.systemPrompt, priority: 0 }];

    const finalSystemPrompts = additionalSystemPrompts
      ? [...systemPromptsFromConfig, ...additionalSystemPrompts].sort((a,b) => (a.priority ?? 0) - (b.priority ?? 0))
      : systemPromptsFromConfig;

    // Access PromptEngine's own config for defaults if agent doesn't override.
    // This requires PromptEngine to expose its config or have a method for it.
    // For now, we assume promptEngineConfigOverrides are comprehensive if used.
    const historyMaxMessages =
      this.agentConfig.promptEngineConfigOverrides?.historyManagement?.defaultMaxMessages ??
      20; // Hard fallback

    const components: Partial<PromptComponents> = {
      systemPrompts: finalSystemPrompts,
      conversationHistory: [...conversationContext.getHistory(historyMaxMessages)],
      userInput: userInput ?? undefined, // Pass undefined if null, as per PromptComponents
    };

    if (
      availableTools &&
      availableTools.length > 0 &&
      this.agentConfig.modelTargetInfo.toolSupport?.supported
    ) {
      components.tools = availableTools as unknown as ITool[];
    }
    return components;
  }

  /**
   * Protected helper method to make a call to the LLM provider via the `PromptEngine`.
   *
   * @protected
   * @param {IProvider} llmProvider - The LLM provider instance to use for this call.
   * @param {Partial<PromptComponents>} promptComponents - Components to build the prompt.
   * @param {Partial<ModelCompletionOptions>} [overrideOptions] - Options to override agent's defaults for this specific call.
   * @returns {Promise<ModelCompletionResponse>} The LLM's full response.
   * @throws {AgentCoreError} If prompt construction fails with an error, or if the LLM call itself fails.
   */
  protected async callLLM(
    llmProvider: IProvider, // Allow specifying provider for advanced scenarios (e.g. utility LLM call)
    promptComponents: Partial<PromptComponents>,
    overrideOptions?: Partial<ModelCompletionOptions>
  ): Promise<ModelCompletionResponse> {
    this.ensureInitialized();

    let promptResult: PromptEngineResult;
    try {
      promptResult = await this.promptEngine.constructPrompt(
        promptComponents as PromptComponents,
        this.agentConfig.modelTargetInfo, // Agent's primary model target
        undefined,
        this.agentConfig.promptTemplateName
      );
    } catch (error: any) {
      console.error(`Agent '${this.name}': Error during prompt construction: ${error.message}`, error);
      throw new AgentCoreError(`Prompt construction failed: ${error.message}`, 'PROMPT_CONSTRUCTION_ERROR', error);
    }

    if (promptResult.issues?.some(i => i.type === 'error')) {
      const errorMessages = promptResult.issues.filter(i => i.type === 'error').map(i => i.message).join('; ');
      console.error(`Agent '${this.name}': Critical errors during prompt construction:`, promptResult.issues);
      throw new AgentCoreError(`Prompt construction failed with critical errors: ${errorMessages}`, 'PROMPT_VALIDATION_ERROR', promptResult.issues);
    }
    if (promptResult.issues?.some(i => i.type === 'warning')) {
      console.warn(`Agent '${this.name}': Warnings during prompt construction:`, promptResult.issues);
    }

    const completionOptions: ModelCompletionOptions = {
      modelId: this.agentConfig.modelTargetInfo.modelId, // From agent's primary target
      ...this.agentConfig.defaultModelCompletionOptions, // Agent's defaults
      ...overrideOptions,                                // Call-specific overrides
      tools: promptResult.formattedToolSchemas,          // Schemas formatted by PromptEngine
    };

    if (!completionOptions.modelId) {
      throw new AgentCoreError(
        `No modelId configured for agent '${this.name}'. Verify agentConfig.modelTargetInfo.modelId.`,
        'MODEL_ID_MISSING'
      );
    }

    // console.debug(`Agent '${this.name}' (ID: ${this.id}) calling LLM (${completionOptions.modelId || 'N/A'}) on provider ${llmProvider.providerId}. Options:`, completionOptions, `Prompt metadata:`, promptResult.metadata);

    let llmResponse: ModelCompletionResponse;
    try {
      llmResponse = await llmProvider.generateCompletion(
        completionOptions.modelId,
        promptResult.prompt as ChatMessage[],
        completionOptions
      );
    } catch (error: any) {
      console.error(`Agent '${this.name}': LLM Provider (${llmProvider.providerId}) .generateCompletion failed for model ${completionOptions.modelId}: ${error.message}`, error);
      throw new AgentCoreError(
        `LLM Provider Error on .generateCompletion (${completionOptions.modelId}, ${llmProvider.providerId}): ${error.message}`,
        'LLM_PROVIDER_EXECUTION_ERROR',
        error
      );
    }

    if (llmResponse.error) {
      console.error(`Agent '${this.name}': LLM Provider (${llmProvider.providerId}) returned an error for model ${completionOptions.modelId}:`, llmResponse.error);
      throw new AgentCoreError(
        `LLM Provider Error (${completionOptions.modelId}, ${llmProvider.providerId}): ${llmResponse.error.message}`,
        'LLM_PROVIDER_RESPONSE_ERROR',
        llmResponse.error
      );
    }
    return llmResponse;
  }

  /**
   * Protected helper to parse an LLM response, extracting the primary text content and any tool calls.
   * It handles parsing of tool call arguments from their typical JSON string format into objects.
   *
   * @protected
   * @param {ModelCompletionResponse} llmResponse - The complete response object from the LLM provider.
   * @returns {{ responseText: string | null; toolCalls?: AgentToolCall[]; rawResponseMessage?: any; }}
   * An object containing:
   * - `responseText`: The main textual content from the LLM, or `null` if none.
   * - `toolCalls`: An array of `AgentToolCall` objects if the LLM requested tool executions, `undefined` otherwise.
   * - `rawResponseMessage`: The actual message object from the LLM's first choice, for debugging or advanced needs.
   * @throws {AgentCoreError} If no valid choice is found in the LLM response.
   */
  protected parseLLMResponse(llmResponse: ModelCompletionResponse): {
    responseText: string | null;
    toolCalls?: AgentToolCall[];
    rawResponseMessage?: any; // The actual message object from the choice (e.g., ChatMessage)
  } {
    this.ensureInitialized();
    // Error in llmResponse object itself should have been handled by callLLM.
    const choice = llmResponse.choices?.[0];
    if (!choice) {
      const errorMsg = `No valid choice found in LLM response. Response ID: ${llmResponse.id}`;
      console.error(`Agent '${this.name}': ${errorMsg}`, llmResponse);
      throw new AgentCoreError(errorMsg, 'LLM_RESPONSE_NO_CHOICE', { responseId: llmResponse.id });
    }

    // Extract text content. Handle both direct text and message.content.
    const responseText =
      this.extractTextFromMessageContent(choice.message?.content) ??
      (typeof choice.text === 'string' ? choice.text : null);
    let agentToolCalls: AgentToolCall[] | undefined = undefined;

    if (choice.message?.tool_calls && choice.message.tool_calls.length > 0) {
      agentToolCalls = [];
      for (const tc of choice.message.tool_calls) {
        if (tc.type === 'function' && tc.function) {
          try {
            const callId = tc.id || `tool_call_${Date.now()}_${Math.random().toString(36).substring(7)}`; // Ensure callId
            agentToolCalls.push({
              callId: callId,
              toolId: tc.function.name,
              arguments: JSON.parse(tc.function.arguments || '{}'), // Ensure arguments are parsed; default to empty object if null/undefined
            });
          } catch (e: any) {
            const parseErrorMsg = `Failed to parse tool call arguments for tool '${tc.function.name}' (ID: ${tc.id}). Arguments: "${tc.function.arguments}". Error: ${e.message}`;
            console.error(`Agent '${this.name}': ${parseErrorMsg}`, e);
            // Optionally, include this error information in the agent's output or a system message to the user/orchestrator.
            // For now, we skip the malformed tool call.
            // A more robust system might try to self-correct or ask for clarification.
          }
        } else {
          console.warn(`Agent '${this.name}': Received tool_call of unhandled type '${tc.type}' or malformed function call structure for call ID '${tc.id}'. Skipping.`);
        }
      }
      if (agentToolCalls.length === 0) {
        agentToolCalls = undefined; // Ensure it's undefined if no valid tool calls were parsed.
      }
    }
    return { responseText, toolCalls: agentToolCalls, rawResponseMessage: choice.message };
  }

  /**
   * Normalizes a provider message content payload into plain text where possible.
   */
  protected extractTextFromMessageContent(content: MessageContent | null | undefined): string | null {
    if (content === null || content === undefined) {
      return null;
    }
    if (typeof content === 'string') {
      const trimmed = content.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (Array.isArray(content)) {
      const combined = content
        .map(part => {
          if (!part || typeof part !== 'object') {
            return '';
          }
          if (typeof (part as any).text === 'string') {
            return (part as any).text;
          }
          if (typeof (part as any).content === 'string') {
            return (part as any).content;
          }
          if ((part as any).type === 'tool_result' && typeof (part as any).content === 'string') {
            return (part as any).content;
          }
          return '';
        })
        .filter(chunk => typeof chunk === 'string' && chunk.trim().length > 0)
        .join(' ')
        .trim();
      return combined.length > 0 ? combined : null;
    }
    if (typeof content === 'object') {
      return JSON.stringify(content);
    }
    return null;
  }


  /**
   * Protected helper to get `ToolDefinition`s for a list of tool IDs.
   * Used internally when `callLLM` needs to pass tool schemas.
   * This assumes tools are registered with a `ToolRegistry` or accessible via `AgentOrchestrator`
   * or similar mechanism that can provide `Tool` instances.
   * For `AgentCore`, it needs a way to access these definitions.
   * A simple approach is to assume `this.agentConfig.toolIds` refers to tools
   * whose definitions can be fetched. This detail depends on how tools are managed globally.
   * For now, this is a placeholder and might require a `ToolRegistry` dependency.
   *
   * @param _toolIds List of tool IDs.
   * @returns Array of ToolDefinitions.
   */
  protected async getAvailableToolDefinitions(_toolIds: string[]): Promise<ToolDefinition[] | undefined> {
      // This is a conceptual placeholder. In a real system, you'd fetch Tool instances
      // from a ToolRegistry or via the orchestrator, then get their definitions.
      // For AgentCore, it doesn't manage tools directly.
      // If an orchestrator provides `availableTools: Tool[]` to `processTurn`, that's the source.
      // If this agent needs to pass tools to `callLLM` outside of `processTurn` (e.g., in `handleToolResult`),
      // it needs a way to get those definitions.
      // For now, return undefined, assuming the orchestrator handles tool provisioning to processTurn.
      console.warn(`AgentCore.getAvailableToolDefinitions: Placeholder used. Tool definitions not dynamically fetched based on toolIds in this base class. Ensure tools are provided to processTurn or handleToolResult if needed for sub-calls.`);
      return undefined;
  }


  // --- Convenience output builders ---

  /**
   * Creates a standard text-only agent output.
   * @param {string} text - The textual response from the agent.
   * @param {boolean} [isComplete=true] - Indicates if the agent's turn is complete with this output.
   * @param {Record<string, any>} [metadata] - Optional metadata to include.
   * @returns {AgentOutput} The structured agent output.
   */
  protected textOutput(text: string, isComplete: boolean = true, metadata?: Record<string, any>): AgentOutput {
    return { responseText: text, isComplete, metadata };
  }

  /**
   * Creates an agent output that requests UI components to be rendered by the client.
   * @param {UIComponentSpecification[]} components - An array of UI component specifications.
   * @param {string} [responseText] - Optional accompanying textual response.
   * @param {boolean} [isComplete=true] - Indicates if the agent's turn is complete.
   * @param {Record<string, any>} [metadata] - Optional metadata.
   * @returns {AgentOutput} The structured agent output.
   */
  protected uiOutput(
    components: UIComponentSpecification[],
    responseText?: string,
    isComplete: boolean = true,
    metadata?: Record<string, any>
  ): AgentOutput {
    return { uiComponents: components, responseText, isComplete, metadata };
  }

  /**
   * Creates an agent output that requests one or more tool calls to be executed.
   * This typically means the agent's turn is **not yet complete** (`isComplete: false`),
   * as it will await the results of these tool calls.
   *
   * @param {AgentToolCall[]} toolCalls - An array of tool call objects.
   * @param {string} [responseText] - Optional interim text to provide to the user
   * (e.g., "Okay, I will search the web for that information.").
   * @param {Record<string, any>} [metadata] - Optional metadata.
   * @returns {AgentOutput} The structured agent output.
   * @throws {AgentCoreError} If `toolCalls` array is empty or not provided.
   */
  protected toolCallOutput(
    toolCalls: AgentToolCall[],
    responseText?: string,
    metadata?: Record<string, any>
  ): AgentOutput {
    if (!toolCalls || toolCalls.length === 0) {
      console.warn(`Agent '${this.name}': toolCallOutput was called with no toolCalls. This is likely an error in agent logic.`);
      // Return an error output or a fallback text output indicating an issue.
      return {
        responseText: responseText || "I was about to use a tool, but encountered an issue selecting one. Please try again.",
        isComplete: true, // Since no tool call can be made, the turn is effectively stalled/complete.
        error: new AgentCoreError("Attempted to create toolCallOutput with no tool calls.", 'EMPTY_TOOL_CALL_REQUEST'),
        metadata,
      };
    }
    return { toolCalls, responseText, isComplete: false, metadata }; // isComplete is false as it awaits tool results
  }
}
