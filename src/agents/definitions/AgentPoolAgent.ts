/**
 * @fileoverview Implements the `AgentPoolAgent`, a specialized type of `AgentCore`
 * that functions as a manager or orchestrator for a collection of other "sub-agents".
 * This agent embodies strategies like routing requests to the most suitable sub-agent,
 * synthesizing responses from multiple sub-agents (mixture of experts), or delegating
 * tasks directly.
 *
 * The `AgentPoolAgent` uses an `IAgentFactory` to instantiate its sub-agents based on
 * IDs provided in its `AgentPoolConfig`. Its behavior is primarily dictated by the
 * `AgentPoolStrategy` defined in its configuration.
 *
 * Key functionalities:
 * - Loads and initializes a set of sub-agents.
 * - Implements various strategies for sub-agent interaction and output generation.
 * - Can maintain a "unified persona" for user-facing interactions, even if sub-agents
 * have distinct characteristics.
 * - Utilizes its own LLM provider and prompt engine for meta-tasks like routing
 * decisions or synthesizing sub-agent outputs.
 * @module backend/agentos/agents/definitions/AgentPoolAgent
 */

import { AgentCore, AgentConfig, AgentType, AgentCoreError } from './AgentCore';
import { IAgent, AgentOutput } from './IAgent';
import { AgentPoolConfig, AgentPoolStrategy } from './AgentPoolConfig';
import { ConversationContext } from '../../core/conversation/ConversationContext';
import { IProvider, ModelCompletionResponse } from '../../core/llm/providers/IProvider';
import { IPromptEngine, PromptComponents } from '../../core/llm/IPromptEngine';
import { Tool } from './tools/Tool';
import { IUtilityAI } from '../../cognition/nlp/ai_utilities/IUtilityAI';
import { IAgentFactory, AgentDependencies } from './IAgentFactory';
import { MessageRole } from '../../core/conversation/ConversationMessage'; // Ensure ConversationMessage is imported if used directly

/**
 * Configuration specific to an `AgentPoolAgent`.
 * It extends the base `AgentConfig` and mandates that the `type` is `AgentType.POOL`,
 * and that `agentPoolOptions` (defined by `AgentPoolConfig`) are provided.
 * @interface AgentPoolAgentConfig
 * @extends {AgentConfig}
 */
export interface AgentPoolAgentConfig extends AgentConfig {
  /**
   * Specifies the type of this agent, which must be `AgentType.POOL`.
   * @type {AgentType.POOL}
   */
  type: AgentType.POOL;

  /**
   * Configuration settings specific to the agent pool's operation,
   * including sub-agent IDs and interaction strategy.
   * @type {AgentPoolConfig}
   */
  agentPoolOptions: AgentPoolConfig;
}

/**
 * A concrete agent implementation that acts as an intelligent coordinator or router
 * for a collection of sub-agents. It encapsulates the logic for selecting,
 * dispatching tasks to, and synthesizing results from its managed sub-agents,
 * all based on a configured `AgentPoolStrategy`.
 *
 * @class AgentPoolAgent
 * @extends {AgentCore}
 * @implements {IAgent}
 */
export class AgentPoolAgent extends AgentCore implements IAgent {
  /**
   * The specific configuration for this agent pool's operations.
   * @private
   * @type {AgentPoolConfig}
   */
  private readonly poolConfig: AgentPoolConfig;

  /**
   * A map storing the instantiated sub-agent instances, keyed by their agent IDs.
   * @private
   * @type {Map<string, IAgent>}
   */
  private subAgents: Map<string, IAgent> = new Map();

  /**
   * Snapshot of the dependencies originally supplied by the orchestrator/factory.
   * Needed so the pool can instantiate sub-agents with the same services.
   */
  private agentDependencies?: AgentDependencies;

  /**
   * Stores tools that are available to the pool agent itself. These might be
   * different from tools available to individual sub-agents.
   * @private
   * @type {Tool[]}
   */
  private availablePoolTools: Tool[] = [];

  /**
   * Constructs an `AgentPoolAgent` instance.
   *
   * @param {AgentPoolAgentConfig} config - The configuration for this agent pool.
   * Must specify `type` as `AgentType.POOL` and include `agentPoolOptions`.
   * @param {IPromptEngine} promptEngine - An instance of the `IPromptEngine`.
   * @param {IProvider} llmProvider - The primary AI model provider for the pool agent's
   * own meta-tasks (e.g., routing, synthesis).
   * @param {IUtilityAI | undefined} utilityAI - Optional. An instance of an `IUtilityAI` service.
   * @param {IAgentFactory} agentFactory - The `IAgentFactory` instance, which is **required**
   * for the `AgentPoolAgent` to load and instantiate its sub-agents.
   * @throws {AgentCoreError} If the configuration is invalid (e.g., missing `agentPoolOptions`)
   * or if the `agentFactory` dependency is not provided.
   */
  constructor(
    config: AgentPoolAgentConfig,
    promptEngine: IPromptEngine,
    llmProvider: IProvider,
    utilityAI: IUtilityAI | undefined,
    agentFactory: IAgentFactory // Made mandatory for AgentPoolAgent
  ) {
    super(config, promptEngine, llmProvider, utilityAI, agentFactory);

    if (config.type !== AgentType.POOL || !config.agentPoolOptions) {
      throw new AgentCoreError(
        "AgentPoolAgent: Invalid configuration. 'type' must be AgentType.POOL and 'agentPoolOptions' must be provided.",
        'POOL_AGENT_INVALID_CONFIG',
        config
      );
    }
    if (!agentFactory) {
        // This check is technically redundant due to super class constructor already using it,
        // but reinforces that AgentPoolAgent *critically* needs it.
        throw new AgentCoreError(
            "AgentPoolAgent: IAgentFactory dependency is absolutely required for AgentPoolAgent to function.",
            'POOL_AGENT_MISSING_FACTORY',
            config
        );
    }
    this.poolConfig = config.agentPoolOptions;
  }

  /**
   * Allows the orchestrator/factory to provide the dependency bundle that was used
   * to construct this pool agent so it can reuse them when instantiating sub-agents.
   */
  public setAgentDependencies(dependencies: AgentDependencies): void {
    this.agentDependencies = dependencies;
  }

  /**
   * Initializes the `AgentPoolAgent`. This involves:
   * 1. Calling the base class `initialize` method.
   * 2. Using the injected `IAgentFactory` to load and initialize all sub-agents
   * specified in `this.poolConfig.subAgentIds`.
   *
   * @override
   * @param {Record<string, any>} [configOverrides] - Optional configuration overrides applied during initialization.
   * @returns {Promise<void>}
   * @throws {AgentCoreError} If the `agentFactory` is missing or if any sub-agent fails to load or initialize.
   */
  public async initialize(configOverrides?: Record<string, any>): Promise<void> {
    await super.initialize(configOverrides); // Call base class initialize

    if (!this.agentFactory) {
      // This should ideally be caught by the constructor, but defensive check here.
      throw new AgentCoreError(
        `AgentPoolAgent '${this.name}': Critical dependency IAgentFactory is missing. Cannot load sub-agents.`,
        'POOL_AGENT_INIT_NO_FACTORY'
      );
    }

    // console.log(`AgentPoolAgent '${this.name}' (ID: ${this.id}) initializing sub-agents using factory...`);
    const subAgentLoadPromises: Promise<void>[] = [];
    const loadedSubAgentsMap = new Map<string, IAgent>();

    const providerManager = this.agentDependencies?.providerManager;
    if (!providerManager) {
      throw new AgentCoreError(
        `AgentPoolAgent '${this.name}': Missing providerManager dependency. Cannot materialize sub-agents.`,
        'POOL_AGENT_MISSING_PROVIDER_MANAGER'
      );
    }

    // Gather dependencies for sub-agents. They re-use the pool's core services.
    const subAgentDeps: AgentDependencies = {
      promptEngine: this.agentDependencies?.promptEngine ?? this.promptEngine,
      providerManager,
      utilityAI: this.agentDependencies?.utilityAI ?? this.utilityAI,
      agentFactory: this.agentDependencies?.agentFactory ?? this.agentFactory,
    };

    for (const subAgentId of this.poolConfig.subAgentIds) {
      subAgentLoadPromises.push(
        this.agentFactory.getAgent(subAgentId, subAgentDeps)
          .then(subAgent => {
            if (subAgent) {
              loadedSubAgentsMap.set(subAgentId, subAgent);
              // console.log(`- AgentPoolAgent '${this.name}': Successfully loaded sub-agent: ${subAgent.name} (ID: ${subAgent.id})`);
            } else {
              console.warn(`- AgentPoolAgent '${this.name}': Failed to load sub-agent with ID '${subAgentId}'. It might not be configured, registered, or an error occurred during its creation.`);
              // Optionally, throw an error here if any sub-agent loading failure is critical
            }
          })
          .catch(error => {
            console.error(`- AgentPoolAgent '${this.name}': Error loading sub-agent '${subAgentId}':`, error);
            // Decide on error handling: continue without this sub-agent, or fail pool initialization?
            // For robustness, let's allow continuing but log a critical warning.
            // throw new AgentCoreError(`Failed to load sub-agent '${subAgentId}' for pool '${this.name}'.`, 'SUB_AGENT_LOAD_FAILED', error);
          })
      );
    }

    await Promise.all(subAgentLoadPromises);
    this.subAgents = loadedSubAgentsMap;

    if (this.subAgents.size !== this.poolConfig.subAgentIds.length) {
      console.warn(`AgentPoolAgent '${this.name}': Not all configured sub-agents were loaded. Expected ${this.poolConfig.subAgentIds.length}, loaded ${this.subAgents.size}. The pool may not function as intended.`);
    }
    // console.log(`AgentPoolAgent '${this.name}' initialization complete. Loaded ${this.subAgents.size} of ${this.poolConfig.subAgentIds.length} configured sub-agents.`);
  }

  /**
   * Resets the `AgentPoolAgent`'s internal state and propagates the reset call
   * to all its managed sub-agents.
   * @override
   */
  public reset(): void {
    super.reset(); // Call base class reset
    this.subAgents.forEach(agent => {
      if (typeof agent.reset === 'function') {
        try {
          agent.reset();
        } catch (error: any) {
            console.error(`AgentPoolAgent '${this.name}': Error resetting sub-agent '${agent.id}': ${error.message}`, error);
        }
      }
    });
    // console.log(`AgentPoolAgent '${this.name}' (ID: ${this.id}) and its ${this.subAgents.size} sub-agents have been reset.`);
  }

  /**
   * Overrides the `processTurn` method from `AgentCore` to implement the specific
   * orchestration logic of the `AgentPoolAgent` based on its configured strategy.
   * This method will route tasks to, or synthesize results from, its sub-agents.
   *
   * @override
   * @param {string | null} userInput - The latest input from the user.
   * @param {ConversationContext} conversationContext - The current conversation context.
   * @param {Tool[]} [availableTools] - Tools available to the pool agent itself (these might also
   * be passed down to sub-agents depending on the strategy and sub-agent capabilities).
   * @returns {Promise<AgentOutput>} The agent's response and actions, which could be a direct
   * response, a synthesized response from sub-agents, or tool calls.
   * @throws {AgentCoreError} If an unhandled error occurs within the chosen strategy.
   */
  public async processTurn(
    userInput: string | null,
    conversationContext: ConversationContext,
    availableTools?: Tool[] // Tools available to this pool agent
  ): Promise<AgentOutput> {
    this.ensureInitialized(); // Ensure pool agent (and thus sub-agents) are initialized
    this.availablePoolTools = availableTools || [];

    // Optional: Apply unified persona to conversation context if configured for the pool
    if (this.poolConfig.unifiedPersonaId) {
      // This is a conceptual step. How this `unifiedPersonaId` translates to an actionable
      // change in context depends on how personas are managed and applied.
      // It might mean this pool agent's own system prompt (this.agentConfig.systemPrompt)
      // IS the unified persona, or it refers to a separate persona definition to load.
      // For now, we assume the pool agent's own configuration embodies the unified persona.
      conversationContext.setMetadata('activePoolPersonaId', this.poolConfig.unifiedPersonaId);
      conversationContext.setMetadata('controllingAgentId', this.id); // Mark that pool is in control
    }

    // console.log(`AgentPoolAgent '${this.name}' (ID: ${this.id}) processing turn. Strategy: '${this.poolConfig.strategy}'. User input: "${userInput ? userInput.substring(0,50)+'...' : 'N/A'}"`);

    if (this.subAgents.size === 0 && this.poolConfig.subAgentIds.length > 0) {
        const noSubAgentsMsg = `AgentPoolAgent '${this.name}' has no sub-agents loaded or available to handle the request. Please check the pool configuration and sub-agent status.`;
        console.warn(noSubAgentsMsg);
        return this.textOutput(
            "I'm currently unable to process your request as my specialized internal assistants are not available. Please try again later.",
            true,
            { error: noSubAgentsMsg }
        );
    }


    try {
      switch (this.poolConfig.strategy) {
        case AgentPoolStrategy.UNIFIED_PERSONA_ROUTING:
          return await this.handleUnifiedPersonaRouting(userInput, conversationContext);
        case AgentPoolStrategy.MIXTURE_OF_EXPERTS_SYNTHESIS:
          return await this.handleMixtureOfExpertsSynthesis(userInput, conversationContext);
        case AgentPoolStrategy.DIRECT_DELEGATION:
          return await this.handleDirectDelegation(userInput, conversationContext);
        case AgentPoolStrategy.EXPLORATORY_GENERATION:
          return await this.handleExploratoryGeneration(userInput, conversationContext);
        default: {
          const errorMsg = `AgentPoolAgent '${this.name}': Unhandled or unknown strategy '${this.poolConfig.strategy}'.`;
          console.error(errorMsg);
          // Use the inherited error handler to explain this to the user via LLM
          return await this.handleInternalAgentError(
            new AgentCoreError(errorMsg, 'POOL_UNKNOWN_STRATEGY'),
            conversationContext,
            true // This is fatal for the turn
          );
        }
      }
    } catch (error: any) {
        const strategyErrorMsg = `Error executing strategy '${this.poolConfig.strategy}' in AgentPoolAgent '${this.name}': ${error.message}`;
        console.error(strategyErrorMsg, error);
        return await this.handleInternalAgentError(
            new AgentCoreError(strategyErrorMsg, 'POOL_STRATEGY_EXECUTION_FAILED', error),
            conversationContext,
            true
        );
    }
  }

  /**
   * Implements the `UNIFIED_PERSONA_ROUTING` strategy.
   * This involves using an LLM (the pool agent's own) to select the most appropriate sub-agent
   * based on the user input and sub-agent descriptions. The selected sub-agent's output
   * is then rephrased by the pool agent to maintain a consistent unified persona.
   *
   * @private
   * @param {string | null} userInput - The user's input.
   * @param {ConversationContext} conversationContext - The current conversation context.
   * @returns {Promise<AgentOutput>} The synthesized and persona-aligned output.
   */
  private async handleUnifiedPersonaRouting(
    userInput: string | null,
    conversationContext: ConversationContext
  ): Promise<AgentOutput> {
    const availableSubAgents = Array.from(this.subAgents.values());
    if (availableSubAgents.length === 0) {
      return this.textOutput("I apologize, but I don't have any specialist agents available to help with that specific request right now.", true);
    }

    // 1. Generate a prompt for the pool's LLM to choose a sub-agent.
    const routingPromptComponents = this.generateRoutingPrompt(userInput, conversationContext, availableSubAgents);

    let chosenAgentId: string | null;
    let routingLlmResponse: ModelCompletionResponse;
    try {
      routingLlmResponse = await this.callLLM(
        this.llmProvider, // Pool agent's LLM
        routingPromptComponents,
        {
          temperature: 0.1,
          maxTokens: 150,
          ...(this.poolConfig.routingConfig?.selectionCompletionOptions || {}),
        }
      );
      chosenAgentId = this.parseLLMResponseForRouting(routingLlmResponse, availableSubAgents.map(a => a.id), userInput?.length ?? 0);
    } catch (error: any) {
      console.error(`AgentPoolAgent '${this.name}': LLM call for routing failed: ${error.message}`, error);
      return this.handleInternalAgentError(new AgentCoreError(`Failed to determine the best sub-agent for your request due to an internal routing error.`, 'POOL_ROUTING_LLM_ERROR', error), conversationContext, true);
    }

    if (!chosenAgentId) {
      console.warn(`AgentPoolAgent '${this.name}': LLM failed to choose a sub-agent for routing.`, {
        candidateNames: availableSubAgents.map((agent) => agent.name),
        inputLength: userInput?.length ?? 0,
        outcome: 'no_agent_selected',
      });
      // Fallback: could try a default agent or ask user for more clarification.
      return this.textOutput("I'm having a bit of trouble determining the best way to handle your request. Could you please provide more specific details or rephrase your query?", false);
    }

    const chosenAgent = this.subAgents.get(chosenAgentId);
    if (!chosenAgent) {
      const routingErrorMsg = `LLM chose sub-agent ID '${chosenAgentId}', but this agent is not found or not loaded in the pool '${this.name}'.`;
      console.error(`AgentPoolAgent '${this.name}': ${routingErrorMsg}`);
      return this.handleInternalAgentError(new AgentCoreError(routingErrorMsg, 'POOL_ROUTED_AGENT_NOT_FOUND'), conversationContext, true);
    }

    // console.log(`AgentPoolAgent '${this.name}': Routing to sub-agent: ${chosenAgent.name} (ID: ${chosenAgent.id}).`);

    // 2. Call the chosen sub-agent's processTurn.
    // Provide tools available to the pool, sub-agent will filter based on its own config.
    let subAgentResponse: AgentOutput;
    try {
      subAgentResponse = await chosenAgent.processTurn(userInput, conversationContext, this.availablePoolTools);
    } catch (error: any) {
      const subAgentErrorMsg = `Sub-agent '${chosenAgent.name}' (ID: ${chosenAgent.id}) failed to process the turn: ${error.message}`;
      console.error(`AgentPoolAgent '${this.name}': ${subAgentErrorMsg}`, error);
      return this.handleInternalAgentError(new AgentCoreError(subAgentErrorMsg, 'SUB_AGENT_TURN_PROCESSING_FAILED', error), conversationContext, true);
    }

    // 3. Synthesize/rephrase the sub-agent's response to align with the pool's unified persona.
    return await this.synthesizeAndFinalizeOutput(subAgentResponse, chosenAgent, conversationContext, "Routed to expert, rephrased for unified voice.");
  }

  /**
   * Implements the `MIXTURE_OF_EXPERTS_SYNTHESIS` strategy.
   * Consults multiple (or all) sub-agents and then uses the pool's LLM to synthesize
   * their contributions into a single, coherent response.
   *
   * @private
   * @param {string | null} userInput - The user's input.
   * @param {ConversationContext} conversationContext - The current conversation context.
   * @returns {Promise<AgentOutput>} The synthesized output from the mixture of experts.
   */
  private async handleMixtureOfExpertsSynthesis(
    userInput: string | null,
    conversationContext: ConversationContext
  ): Promise<AgentOutput> {
    const activeSubAgents = Array.from(this.subAgents.values());
    if (activeSubAgents.length === 0) {
      return this.textOutput("I apologize, but I don't have any expert agents available to consult for this request at the moment.", true);
    }

    // console.log(`AgentPoolAgent '${this.name}': Consulting ${activeSubAgents.length} experts for input: "${userInput ? userInput.substring(0,50)+'...' : 'N/A'}".`);

    // 1. Concurrently call processTurn on all (or a selection of) sub-agents.
    const expertOutputPromises = activeSubAgents.map(async (subAgent) => {
      try {
        const output = await subAgent.processTurn(userInput, conversationContext, this.availablePoolTools);
        // console.log(`- AgentPoolAgent '${this.name}': Expert '${subAgent.name}' responded.`);
        return { agentId: subAgent.id, agentName: subAgent.name, agentDescription: subAgent.description, output };
      } catch (e: any) {
        console.error(`- AgentPoolAgent '${this.name}': Expert '${subAgent.name}' (ID: ${subAgent.id}) failed to respond: ${e.message}`, e);
        return {
          agentId: subAgent.id,
          agentName: subAgent.name,
          agentDescription: subAgent.description,
          output: {
            responseText: `Error: Specialist '${subAgent.name}' encountered an issue and could not contribute.`,
            isComplete: true, // This expert's contribution is complete (with an error)
            error: new AgentCoreError(`Sub-agent ${subAgent.name} failed.`, 'SUB_AGENT_FAILURE_IN_MOE', e),
          }
        };
      }
    });

    const expertResults = await Promise.all(expertOutputPromises);

    // Filter out results that are purely errors or have no text, unless all are errors.
    const validExpertOutputs = expertResults.filter(res => res.output.responseText || res.output.toolCalls);
    if (validExpertOutputs.length === 0 && expertResults.length > 0) {
        // All experts failed or returned nothing. Concatenate error messages if any.
        const combinedErrorMessages = expertResults.map(res => res.output.error ? `${res.agentName}: ${(res.output.error as Error).message || res.output.error}` : `${res.agentName} provided no usable output.`).join('\n');
        return this.textOutput(
            `I consulted my team of experts, but unfortunately, they were unable to provide a consolidated response at this time. Details:\n${combinedErrorMessages}`,
            true,
            { allExpertsFailed: true }
        );
    }


    // 2. Generate a prompt for the pool's LLM to synthesize these expert outputs.
    const synthesisPromptComponents = this.generateSynthesisPrompt(userInput, conversationContext, validExpertOutputs);

    // 3. Call the pool's LLM for synthesis.
    let synthesizedResponse: AgentOutput;
    try {
      const synthesisLlmResponse = await this.callLLM(
        this.llmProvider,
        synthesisPromptComponents,
        {
          temperature: 0.4,
          maxTokens: 1500,
          ...(this.poolConfig.synthesisConfig?.synthesisCompletionOptions || {}),
        }
      );
      // The synthesis LLM might itself request tools or provide complex output.
      const parsed = this.parseLLMResponse(synthesisLlmResponse);
      synthesizedResponse = {
        responseText: parsed.responseText ?? undefined,
        toolCalls: parsed.toolCalls,
        isComplete: !parsed.toolCalls || parsed.toolCalls.length === 0,
        rawModelResponse: parsed.rawResponseMessage,
        metadata: { synthesizedByPool: true },
      };
    } catch (error: any) {
      console.error(`AgentPoolAgent '${this.name}': LLM call for expert synthesis failed: ${error.message}`, error);
      return this.handleInternalAgentError(new AgentCoreError(`Failed to synthesize expert opinions due to an internal processing error.`, 'POOL_SYNTHESIS_LLM_ERROR', error), conversationContext, true);
    }

    return await this.synthesizeAndFinalizeOutput(synthesizedResponse, this, conversationContext, "Synthesized from multiple experts.");
  }

  /**
   * Implements the `DIRECT_DELEGATION` strategy.
   * Selects a single sub-agent (e.g., based on simple routing logic or configuration)
   * and directly forwards its response without significant modification by the pool agent.
   *
   * @private
   * @param {string | null} userInput - The user's input.
   * @param {ConversationContext} conversationContext - The current conversation context.
   * @returns {Promise<AgentOutput>} The output from the delegated sub-agent.
   */
  private async handleDirectDelegation(
    userInput: string | null,
    conversationContext: ConversationContext
  ): Promise<AgentOutput> {
    const availableSubAgents = Array.from(this.subAgents.values());
    if (availableSubAgents.length === 0) {
      return this.textOutput("I don't have any specialist agents available to delegate this task to at the moment.", true);
    }

    // Simple delegation: use routing prompt to pick one, or pick first if routing fails/not configured.
    // More complex delegation might involve specific rules in poolConfig.routingConfig.
    let delegatedAgent: IAgent | undefined = availableSubAgents[0]; // Fallback to first

    if (availableSubAgents.length > 1 && (this.poolConfig.routingConfig || this.poolConfig.poolSystemPrompt)) {
        // Attempt to use routing LLM if configured for it.
        const routingPromptComponents = this.generateRoutingPrompt(userInput, conversationContext, availableSubAgents);
        try {
            const routingLlmResponse = await this.callLLM(
              this.llmProvider,
              routingPromptComponents,
              {
                temperature: 0.1,
                maxTokens: 150,
                ...(this.poolConfig.routingConfig?.selectionCompletionOptions || {}),
              }
            );
            const chosenAgentId = this.parseLLMResponseForRouting(routingLlmResponse, availableSubAgents.map(a => a.id), userInput?.length ?? 0);
            if (chosenAgentId) {
                delegatedAgent = this.subAgents.get(chosenAgentId) || delegatedAgent;
            } else {
                console.warn(`AgentPoolAgent '${this.name}' (DirectDelegation): LLM routing failed to select an agent. Defaulting to agent '${delegatedAgent?.id}'.`);
            }
        } catch (error: any) {
            console.warn(`AgentPoolAgent '${this.name}' (DirectDelegation): LLM routing call failed: ${error.message}. Defaulting to agent '${delegatedAgent?.id}'.`, error);
        }
    }


    if (!delegatedAgent) { // Should not happen if availableSubAgents is not empty, but defensive check.
      return this.handleInternalAgentError(new AgentCoreError("Could not select a sub-agent for direct delegation.", 'POOL_DELEGATION_NO_AGENT_SELECTED'), conversationContext, true);
    }

    // console.log(`AgentPoolAgent '${this.name}': Directly delegating task to sub-agent: ${delegatedAgent.name} (ID: ${delegatedAgent.id}).`);

    try {
      const subAgentResponse = await delegatedAgent.processTurn(userInput, conversationContext, this.availablePoolTools);
      // For "direct" delegation, we might do minimal or no synthesis.
      // However, if a unifiedPersonaId is set, a light rephrasing might still be desired.
      return await this.synthesizeAndFinalizeOutput(subAgentResponse, delegatedAgent, conversationContext, "Directly delegated to expert.", true); // Pass `isDirectDelegation = true`
    } catch (error: any) {
      const subAgentErrorMsg = `Sub-agent '${delegatedAgent.name}' (ID: ${delegatedAgent.id}) failed during direct delegation: ${error.message}`;
      console.error(`AgentPoolAgent '${this.name}': ${subAgentErrorMsg}`, error);
      return this.handleInternalAgentError(new AgentCoreError(subAgentErrorMsg, 'SUB_AGENT_DELEGATION_FAILED', error), conversationContext, true);
    }
  }

  /**
   * Implements the `EXPLORATORY_GENERATION` strategy. (Placeholder - complex to fully implement here)
   * Spawns sub-agents to explore different approaches for a problem, then evaluates
   * and synthesizes their outputs. This is a more advanced strategy.
   *
   * @private
   * @param {string | null} userInput - The user's input.
   * @param {ConversationContext} conversationContext - The current conversation context.
   * @returns {Promise<AgentOutput>} The synthesized result of the exploratory generation.
   */
  private async handleExploratoryGeneration(
    userInput: string | null,
    conversationContext: ConversationContext
  ): Promise<AgentOutput> {
    // console.log(`AgentPoolAgent '${this.name}': Exploratory Generation strategy selected. This is a complex strategy and this implementation is a simplified placeholder.`);

    // Simplified: Behaves like Mixture of Experts for now.
    // A true exploratory generation would involve:
    // 1. Defining diverse sub-tasks or perspectives based on userInput.
    // 2. Assigning these to sub-agents (possibly with modified prompts for each).
    // 3. Collecting all exploratory outputs.
    // 4. Using an evaluation mechanism (LLM or heuristic) to rank/select/combine results.
    // 5. Synthesizing a final response.
    if (this.subAgents.size < 1) { // Needs at least one "explorer"
        return this.textOutput("I need at least one specialist agent to conduct an exploration, but none are available.", true);
    }
    return this.handleMixtureOfExpertsSynthesis(userInput, conversationContext); // Fallback to MoE
  }


  /**
   * Generates a prompt for the pool agent's internal LLM to perform routing to a sub-agent.
   * The prompt includes descriptions of available sub-agents and the user's query.
   *
   * @private
   * @param {string | null} userInput - The user's current input.
   * @param {ConversationContext} conversationContext - For history and broader context.
   * @param {IAgent[]} subAgents - The list of available sub-agents to choose from.
   * @returns {Partial<PromptComponents>} The components for constructing the routing prompt.
   */
  private generateRoutingPrompt(userInput: string | null, conversationContext: ConversationContext, subAgents: IAgent[]): Partial<PromptComponents> {
    const agentDescriptions = subAgents
      .map(agent => `- Agent ID: "${agent.id}", Name: "${agent.name}", Description: "${agent.description.substring(0,150)}..."`)
      .join('\n');

    const systemPromptContent = this.poolConfig.poolSystemPrompt ||
      `You are an intelligent request router for a team of specialized AI agents. Your task is to analyze the user's request and the ongoing conversation, then select the most suitable agent from the provided list to handle the request.
      Respond with ONLY the Agent ID of your chosen agent. If no agent is suitable, respond with "NONE". Do not add any other text or explanation.`;

    const fullQueryContext = `
User's latest input: "${userInput || "No explicit new input from user, consider the conversation history."}"

Conversation History (last few turns):
${conversationContext.getHistory(5).map(msg => `${msg.role}: ${typeof msg.content === 'string' ? msg.content : '[multimodal_content]'}`).join('\n')}

Available Specialist Agents:
${agentDescriptions}

Based on the user's input and conversation history, which agent (by Agent ID) is best suited to handle this request?
Respond with only the Agent ID. If unsure or no agent is a good fit, respond with "NONE".`;

    return {
      systemPrompts: [{ content: systemPromptContent, priority: 0 }],
      userInput: fullQueryContext, // The task for the routing LLM
      // No conversation history for the routing LLM itself, it's embedded in the userInput.
    };
  }

  /**
   * Parses the LLM's response when it was tasked with routing, expecting just an agent ID or "NONE".
   *
   * @private
   * @param {ModelCompletionResponse} llmResponse - The response from the routing LLM call.
   * @param {string[]} validAgentIds - An array of valid sub-agent IDs for validation.
   * @param inputLength - Length of the input being routed, for diagnostics.
   * @returns {string | null} The chosen agent ID, or `null` if parsing fails or "NONE" is returned.
   */
  private parseLLMResponseForRouting(llmResponse: ModelCompletionResponse, validAgentIds: string[], inputLength = 0): string | null {
    const choice = llmResponse.choices?.[0];
    const textContent = this.extractTextFromMessageContent(choice?.message?.content) || choice?.text?.trim();

    if (textContent) {
      // Remove potential quotes or markdown code blocks around the ID
      const cleanedText = textContent.replace(/^[`"']|[`"']$/g, '').replace(/^`{3}.*?`{3}$/s, '').trim();
      if (cleanedText.toUpperCase() === "NONE") {
        console.warn(`AgentPoolAgent '${this.name}': Routing LLM answered NONE.`, {
          candidateNames: validAgentIds.map((id) => this.subAgents.get(id)?.name ?? id),
          inputLength,
          outcome: 'none',
        });
        return null;
      }
      if (validAgentIds.includes(cleanedText)) {
        return cleanedText;
      }
      // Try to find if the response *contains* a valid ID among other text (less ideal LLM behavior)
      for (const id of validAgentIds) {
          if (cleanedText.includes(id)) return id;
      }
      console.warn(`AgentPoolAgent '${this.name}': Routing LLM named an unknown sub-agent.`, {
        candidateNames: validAgentIds.map((id) => this.subAgents.get(id)?.name ?? id),
        inputLength,
        outcome: 'unknown_agent',
      });
    } else {
      console.warn(`AgentPoolAgent '${this.name}': Routing LLM returned no parsable text content.`, {
        candidateNames: validAgentIds.map((id) => this.subAgents.get(id)?.name ?? id),
        inputLength,
        outcome: 'empty_response',
      });
    }
    return null;
  }

  /**
   * Generates a prompt for the pool agent's internal LLM to synthesize outputs from multiple expert sub-agents.
   *
   * @private
   * @param {string | null} originalUserInput - The initial user input that led to expert consultation.
   * @param {ConversationContext} conversationContext - For overall context.
   * @param {Array<{ agentId: string; agentName: string; agentDescription: string; output: AgentOutput; }>} expertResults - The outputs from consulted sub-agents.
   * @returns {Partial<PromptComponents>} The components for constructing the synthesis prompt.
   */
  private generateSynthesisPrompt(
    originalUserInput: string | null,
    conversationContext: ConversationContext,
    expertResults: Array<{ agentId: string; agentName: string; agentDescription: string; output: AgentOutput; }>
  ): Partial<PromptComponents> {
    const expertContributionsText = expertResults
      .map(res => {
        let contribution = `Expert: ${res.agentName} (Specialty: ${res.agentDescription.substring(0,100)}...)\n`;
        if (res.output.responseText) {
          contribution += `Response:\n${res.output.responseText}\n`;
        }
        if (res.output.toolCalls && res.output.toolCalls.length > 0) {
          contribution += `Proposed Tool Calls:\n${res.output.toolCalls.map(tc => `- ${tc.toolId}(${JSON.stringify(tc.arguments)})`).join('\n')}\n`;
        }
        if (res.output.error) {
          contribution += `Note: This expert encountered an issue: ${typeof res.output.error === 'string' ? res.output.error : (res.output.error as Error).message}\n`;
        }
        return contribution;
      })
      .join('---\n');

    const systemPromptContent = this.poolConfig.synthesisConfig?.synthesisPrompt || this.poolConfig.poolSystemPrompt ||
      `You are a master synthesizer AI. Your role is to consolidate findings from a team of specialist AI agents into a single, coherent, and comprehensive response or plan of action.
      The user's original request was: "${originalUserInput || "Not specified, refer to conversation history."}"
      You have received the following contributions from your specialist team. Review them carefully, identify key insights, resolve any contradictions, and formulate a unified output.
      If the experts propose tool calls, decide if they are necessary and include the most relevant ones in your final plan.
      Your final response should be directly address the user's request and be presented as if you are the sole, highly knowledgeable AI.`;

    const synthesisTaskPrompt = `
Conversation History (last few turns for context):
${conversationContext.getHistory(3).map(msg => `${msg.role}: ${typeof msg.content === 'string' ? msg.content : '[multimodal_content]'}`).join('\n')}

Original User Request: "${originalUserInput || "Refer to history."}"

Contributions from Specialist Agents:
${expertContributionsText}

---
Task: Based on all the above, generate a single, synthesized response to the user. If tool calls are appropriate, include them.
The response should be comprehensive and directly address the user's original request.`;

    return {
      systemPrompts: [{ content: systemPromptContent, priority: 0 }],
      userInput: synthesisTaskPrompt,
    };
  }

  /**
   * A helper method to potentially rephrase or wrap a sub-agent's output to align
   * with the pool's unified persona, if one is configured. Also finalizes metadata.
   *
   * @private
   * @param {AgentOutput} subAgentOutput - The output from the sub-agent.
   * @param {IAgent} sourceAgent - The sub-agent that produced the output.
   * @param {ConversationContext} conversationContext - For context if rephrasing LLM call is needed.
   * @param {string} internalActionDescription - Description of the pool's internal action (e.g., "Routed to expert").
   * @param {boolean} [isDirectDelegation=false] - If true, rephrasing might be lighter or skipped.
   * @returns {Promise<AgentOutput>} The finalized (potentially rephrased) `AgentOutput`.
   */
  private async synthesizeAndFinalizeOutput(
    subAgentOutput: AgentOutput,
    sourceAgent: IAgent,
    conversationContext: ConversationContext,
    internalActionDescription: string,
    isDirectDelegation: boolean = false
  ): Promise<AgentOutput> {
    const finalOutput = { ...subAgentOutput }; // Start with a copy

    // Add metadata about the source of this output
    finalOutput.metadata = {
      ...finalOutput.metadata,
      sourceAgentId: sourceAgent.id,
      sourceAgentName: sourceAgent.name,
      poolAction: internalActionDescription,
      controllingAgentId: this.id,
    };

    // If a unified persona is defined and this isn't a direct delegation where original voice is preferred,
    // and there's text to rephrase, then attempt rephrasing.
    if (this.poolConfig.unifiedPersonaId && !isDirectDelegation && finalOutput.responseText) {
      const unifiedPersonaSystemPrompt = this.agentConfig.systemPrompt; // Pool agent's own system prompt defines unified voice

      const rephrasePromptComponents: Partial<PromptComponents> = {
        systemPrompts: Array.isArray(unifiedPersonaSystemPrompt) ? unifiedPersonaSystemPrompt : [{ content: unifiedPersonaSystemPrompt, priority: 0 }],
        userInput: `An internal specialist agent (${sourceAgent.name}) provided the following information:
        ---
        ${finalOutput.responseText}
        ---
        Your task is to rephrase this information to perfectly match YOUR persona and tone (as defined by the system prompt).
        Present it as if you generated it directly. Ensure consistency with your overall voice and the ongoing conversation.
        If the specialist proposed tool calls, and you agree with them, include them in your rephrased response's tool_calls section.`,
        conversationHistory: [...conversationContext.getHistory(2)], // Brief recent history
        // Pass through tool schemas if rephrasing LLM might also decide on tools
        toolSchemas: finalOutput.toolCalls ? (await this.getAvailableToolDefinitions(finalOutput.toolCalls.map(tc => tc.toolId))) : undefined,
      };

      try {
        const rephraseLlmResponse = await this.callLLM(this.llmProvider, rephrasePromptComponents, {
          temperature: 0.3, // Low temperature for faithful rephrasing
          maxTokens: (finalOutput.responseText.length * 2) + 500, // Generous allowance
        });
        const parsedRephrased = this.parseLLMResponse(rephraseLlmResponse);

        if (parsedRephrased.responseText) {
          finalOutput.responseText = parsedRephrased.responseText;
          finalOutput.metadata = {
            ...finalOutput.metadata,
            rephrasedByPool: true,
          };
          // If rephrasing LLM makes its own tool decisions, use them
          if(parsedRephrased.toolCalls) {
            finalOutput.toolCalls = parsedRephrased.toolCalls;
            finalOutput.isComplete = false; // Now has tool calls
          } else if (subAgentOutput.toolCalls && !finalOutput.toolCalls) {
             // If original had tool calls but rephrased didn't explicitly include them,
             // decide if they should be carried over or if the rephrasing implies they are handled.
             // For safety, let's assume if rephrasing LLM doesn't re-request tools, they are not needed from this step.
             // This might need more nuanced logic based on the rephrasing prompt.
             // A clearer prompt would ask the rephrasing LLM to explicitly state if original tool calls are still valid.
             // For now, if rephrasing occurs and new tool calls are not part of rephrased output, old tool calls are dropped.
             if (finalOutput.toolCalls) {
                // console.log(`AgentPoolAgent '${this.name}': Rephrasing LLM suggested new tool calls, overriding sub-agent's original calls.`);
             } else {
                // console.log(`AgentPoolAgent '${this.name}': Rephrasing occurred. Original sub-agent tool calls are not automatically carried over unless re-stated by rephrasing LLM.`);
                // This means if the rephrasing integrates the information such that tools are no longer needed, that's the new state.
                finalOutput.toolCalls = undefined; // Explicitly clear if not re-requested.
                finalOutput.isComplete = true; // Since no more tool calls from this unified output.
             }
          }
        }
      } catch (error: any) {
        console.warn(`AgentPoolAgent '${this.name}': Failed to rephrase sub-agent output for unified persona. Using original text from '${sourceAgent.name}'. Error: ${error.message}`, error);
        // Fallback to original text, but metadata still indicates source.
      }
    } else if (isDirectDelegation && this.poolConfig.unifiedPersonaId && finalOutput.responseText) {
        // Light touch for direct delegation if unified persona is active: just prepend a small attribution.
        // finalOutput.responseText = `My specialist, ${sourceAgent.name}, reports: "${finalOutput.responseText}"`;
        // This kind of modification should be optional or configurable. For true direct delegation, no modification.
    }
    return finalOutput;
  }


  /**
   * Overrides `handleToolResult` from `AgentCore`.
   * This method is called when a tool initiated by the `AgentPoolAgent` itself completes.
   * (Tools initiated by sub-agents are handled by their respective `handleToolResult` methods,
   * and the orchestrator delivers the result to that sub-agent).
   *
   * The `AgentPoolAgent` might use tools for its meta-tasks, like a "SubAgentSelectionTool"
   * or a "ContentAnalysisTool" to help in routing or synthesis.
   *
   * @override
   * @param {string} toolCallId - The ID of the tool call this result pertains to.
   * @param {any} toolOutput - The output from the tool execution.
   * @param {string} toolName - The name of the tool that was called.
   * @param {ConversationContext} conversationContext - The current conversation context.
   * @returns {Promise<AgentOutput>} The pool agent's subsequent output after processing its own tool's result.
   */
  public async handleToolResult(
    toolCallId: string,
    toolOutput: any,
    toolName: string,
    conversationContext: ConversationContext,
  ): Promise<AgentOutput> {
    this.ensureInitialized();
    // console.log(`AgentPoolAgent '${this.name}' (ID: ${this.id}) is handling its OWN tool result for tool '${toolName}' (Call ID: ${toolCallId}).`);

    // First, add the tool result to the conversation context, as per standard practice.
    try {
      conversationContext.addMessage({
        role: MessageRole.TOOL,
        content: typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput, null, 2),
        tool_call_id: toolCallId,
        name: toolName,
      });
    } catch (error: any) {
      const contextErrorMsg = `Failed to add AgentPoolAgent's own tool result ('${toolName}') to context: ${error.message}`;
      console.error(`AgentPoolAgent '${this.name}': ${contextErrorMsg}`, error);
      return this.handleInternalAgentError(new AgentCoreError(contextErrorMsg, 'POOL_TOOL_RESULT_CONTEXT_ERROR', error), conversationContext, true);
    }

    // Now, the AgentPoolAgent needs to decide what to do with this tool's output.
    // This typically involves another LLM call to interpret the tool's output in the context
    // of its ongoing meta-task (e.g., routing, synthesis).
    // This logic mirrors the base AgentCore's handleToolResult but is specific to the pool's context.

    const metaSystemPrompt = this.agentConfig.metaSystemPromptForUnexpectedSituations || this.poolConfig.poolSystemPrompt ||
      `You are the Agent Pool Manager. You just used a tool called '${toolName}' to assist with your orchestration tasks.
      The tool's output is: "${typeof toolOutput === 'string' ? toolOutput.substring(0,200) : JSON.stringify(toolOutput).substring(0,200)}...".
      Based on this output and the overall goal (e.g., routing a user request, synthesizing information), decide the next step in your pool management process.
      This might involve selecting a sub-agent, formulating a synthesis plan, or directly responding if the tool provided a final answer.`;

    try {
      const promptComponents: Partial<PromptComponents> = {
        systemPrompts: [{ content: metaSystemPrompt, priority: 0 }],
        conversationHistory: [...conversationContext.getHistory()], // Full history now includes the pool's tool result
        // The "userInput" for this LLM call is effectively the context of needing to process its own tool's output.
        userInput: `The tool '${toolName}' (which I, the Pool Manager, called) has provided its output. Now, how should I proceed with managing my sub-agents or responding to the original user query based on this new information?`,
      };

      // The pool agent might itself call other tools after processing this one.
      const llmResponse = await this.callLLM(this.llmProvider, promptComponents, {
          // Tools available to the pool agent for its meta-tasks
          tools: this.availablePoolTools.length > 0 ? this.availablePoolTools.map(t => t.definition) : undefined
      });
      const parsedResponse = this.parseLLMResponse(llmResponse);

      return {
        responseText: parsedResponse.responseText ?? undefined,
        toolCalls: parsedResponse.toolCalls,
        isComplete: !parsedResponse.toolCalls || parsedResponse.toolCalls.length === 0,
        rawModelResponse: parsedResponse.rawResponseMessage,
        metadata: { processedPoolToolResult: toolName, toolCallId },
      };
    } catch (llmError: any) {
      const errorMsg = `AgentPoolAgent '${this.name}' failed to process its own tool result for '${toolName}' using LLM: ${llmError.message}`;
      console.error(errorMsg, llmError);
      return this.handleInternalAgentError(new AgentCoreError(errorMsg, 'POOL_SELF_TOOL_RESULT_LLM_ERROR', llmError), conversationContext, true);
    }
  }
}
