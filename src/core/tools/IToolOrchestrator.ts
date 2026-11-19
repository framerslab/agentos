/**
 * @fileoverview Defines the IToolOrchestrator interface, which acts as the central
 * coordinator for tool registration, discovery, permission checking, and execution
 * within the AgentOS system. GMIs interact with this orchestrator to utilize tools.
 *
 * @module backend/agentos/tools/IToolOrchestrator
 * @see ./ITool.ts
 * @see ./IToolPermissionManager.ts
 * @see ./ToolExecutor.ts
 * @see ../config/ToolOrchestratorConfig.ts
 * @see ../cognitive_substrate/IGMI.ts for ToolCallRequest, ToolCallResult, UserContext
 */

import { ITool, JSONSchemaObject } from './ITool';
import { IToolPermissionManager } from './permissions/IToolPermissionManager';
import { ToolExecutor, ToolExecutionRequestDetails } from './ToolExecutor';
import { ToolOrchestratorConfig } from '../config/ToolOrchestratorConfig';
import { ToolCallResult, UserContext } from '../../cognition/substrate/IGMI';
import type { GMIToolCallRefusal } from '../../cognition/substrate/IGMI';
import type { IHumanInteractionManager } from '../../orchestration/hitl/IHumanInteractionManager';
import type { CapabilityDiscoveryResult } from '../../cognition/discovery/types';
import type { EmergentConfig, EmergentTool } from '../../cognition/emergent/types.js';
import type { EmergentCapabilityEngine } from '../../cognition/emergent/EmergentCapabilityEngine.js';
import type { SelfImprovementToolDeps } from '../../cognition/emergent/EmergentCapabilityEngine.js';
import type { ForgeTrace } from '../../cognition/emergent/ForgeTrace.js';

/**
 * Represents the information about a tool that is suitable for an LLM
 * to understand its capabilities and how to call it.
 *
 * @interface ToolDefinitionForLLM
 * @property {string} name - The functional name of the tool (e.g., "searchWeb").
 * @property {string} description - Detailed description of what the tool does.
 * @property {JSONSchemaObject} inputSchema - JSON schema for the tool's input arguments.
 * @property {JSONSchemaObject} [outputSchema] - Optional: JSON schema for the tool's output.
 */
export interface ToolDefinitionForLLM {
  name: string;
  description: string;
  inputSchema: JSONSchemaObject;
  outputSchema?: JSONSchemaObject;
}

/**
 * @interface IToolOrchestrator
 * @description Defines the contract for the central tool management and invocation component.
 * It provides a unified interface for GMIs to discover and execute tools securely and reliably.
 */
export interface IToolOrchestrator {
  /**
   * A unique identifier for this ToolOrchestrator instance.
   * @readonly
   */
  readonly orchestratorId: string;

  /**
   * Initializes the ToolOrchestrator with its configuration and necessary dependencies.
   *
   * @async
   * @param {ToolOrchestratorConfig | undefined} config - Configuration settings for the orchestrator.
   * @param {IToolPermissionManager} permissionManager - The manager responsible for authorizing tool calls.
   * @param {ToolExecutor} toolExecutor - The executor responsible for running the tool's logic.
   * @param {ITool[]} [initialTools] - An optional array of tool instances to register upon initialization.
   * @returns {Promise<void>}
   * @throws {GMIError | Error} If initialization fails.
   */
  initialize(
    config: ToolOrchestratorConfig | undefined,
    permissionManager: IToolPermissionManager,
    toolExecutor: ToolExecutor,
    initialTools?: ITool[],
    hitlManager?: IHumanInteractionManager,
    emergentOptions?: {
      /** Enable emergent capability creation. */
      enabled: boolean;
      /** Partial emergent config to merge with defaults. */
      config?: Partial<EmergentConfig>;
      /**
       * LLM text generation callback for the EmergentJudge.
       * When omitted the judge rejects all tools (safe fallback).
       */
      generateText?: (model: string, prompt: string) => Promise<string>;
      /**
       * Runtime hooks for self-improvement tools.
       * Only used when `config.selfImprovement.enabled` is `true`.
       */
      selfImprovementDeps?: SelfImprovementToolDeps;
      /**
       * Called once for every forge, after its outcome is final, with its trace: the forges the engine runs and the
       * calls to this orchestrator's own forge_tool that the orchestrator or the executor ends before the tool runs.
       * Awaited up to 1,000 ms; a throw or rejection is caught and never changes the forge's result.
       */
      onForgeTrace?: (trace: ForgeTrace) => void | Promise<void>;
      /**
       * The provider the judge's `generateText` calls, written into each trace's provenance; absent means unknown. A
       * function is called as each review request is sent, so it names the provider that request went to.
       */
      judgeProviderId?: string | (() => string | undefined);
    }
  ): Promise<void>;

  /**
   * Registers a tool, making it available for discovery and execution.
   *
   * @async
   * @param {ITool} tool - The tool instance to register.
   * @returns {Promise<void>}
   * @throws {GMIError} If the tool is invalid, already registered, or dynamic registration is disabled.
   */
  registerTool(tool: ITool): Promise<void>;

  /**
   * Unregisters a tool, removing it from the available tools.
   *
   * @async
   * @param {string} toolName - The functional name (`ITool.name`) of the tool to unregister.
   * @returns {Promise<boolean>} True if the tool was found and unregistered, false otherwise.
   * @throws {GMIError} If dynamic unregistration is disabled.
   */
  unregisterTool(toolName: string): Promise<boolean>;

  /**
   * Retrieves a registered tool instance by its functional name.
   *
   * @async
   * @param {string} toolName - The name of the tool.
   * @returns {Promise<ITool | undefined>} The tool instance, or undefined if not found.
   */
  getTool(toolName: string): Promise<ITool | undefined>;

  /**
   * Lists available tools, potentially filtered by context (e.g., persona capabilities, user permissions).
   * Returns information suitable for an LLM to understand and use the tools.
   *
   * @async
   * @param {object} [context] - Optional context for filtering the list of tools.
   * @param {string} [context.personaId] - The ID of the requesting Persona.
   * @param {string[]} [context.personaCapabilities] - Capabilities of the Persona.
   * @param {UserContext} [context.userContext] - The user's context.
   * @returns {Promise<ToolDefinitionForLLM[]>} A list of tool definitions.
   */
  listAvailableTools(context?: {
    personaId?: string;
    personaCapabilities?: string[];
    userContext?: UserContext;
  }): Promise<ToolDefinitionForLLM[]>;

  /**
   * Processes a tool call request from a GMI.
   * This involves permission checking, argument validation (delegated), execution (delegated),
   * and formatting the result.
   *
   * @async
   * @param {ToolExecutionRequestDetails} requestDetails - The comprehensive details of the tool call request,
   * including the raw `ToolCallRequest` from the LLM, GMI ID, Persona context, and user context.
   * @returns {Promise<ToolCallResult>} The result of the tool call, formatted for the GMI.
   * This will include success/failure status, output, or error information.
   */
  processToolCall(requestDetails: ToolExecutionRequestDetails): Promise<ToolCallResult>;

  /**
   * Records a call that a turn's tool-call gate (an output guardrail) refused before it reached
   * {@link processToolCall}. The GMI calls it with the call as `processToolCall` would have received it. A call to this
   * orchestrator's own forge_tool gets a forge trace with the stage `guardrail_refused`, handed to `onForgeTrace`;
   * any other call records nothing. Optional: an orchestrator without it records nothing. Never throws.
   *
   * @param requestDetails - The refused call.
   * @param refusal - Why the gate refused it.
   */
  recordRefusedToolCall?(requestDetails: ToolExecutionRequestDetails, refusal: GMIToolCallRefusal): Promise<void>;

  /**
   * Lists only the tools that appear in a CapabilityDiscoveryResult.
   * Provides a filtered tool list for the LLM, dramatically reducing context
   * compared to listAvailableTools() which returns ALL registered tools.
   *
   * @async
   * @param {CapabilityDiscoveryResult} discoveryResult - The tiered discovery result
   *   containing Tier 1 and Tier 2 capability matches.
   * @param {object} [context] - Optional filtering context (same as listAvailableTools).
   * @returns {Promise<ToolDefinitionForLLM[]>} Only the tool definitions matching discovered capabilities.
   */
  listDiscoveredTools?(
    discoveryResult: CapabilityDiscoveryResult,
    context?: {
      personaId?: string;
      personaCapabilities?: string[];
      userContext?: UserContext;
    }
  ): Promise<ToolDefinitionForLLM[]>;

  /**
   * Returns the underlying emergent capability engine instance, or
   * `undefined` if emergent capabilities were not enabled at initialization.
   *
   * @returns The engine instance, or `undefined`.
   */
  getEmergentEngine?(): EmergentCapabilityEngine | undefined;

  /**
   * Clean up all emergent session-scoped tools for a given session.
   * No-op if emergent capabilities are not enabled.
   *
   * @param sessionId - The session identifier to clean up.
   */
  cleanupEmergentSession?(sessionId: string): void;

  /**
   * Register a dynamically forged emergent tool with the orchestrator so the
   * agent can use it in subsequent turns.
   *
   * @param tool - An `ITool` instance wrapping the forged tool.
   */
  registerForgedTool?(tool: ITool): Promise<void>;

  /**
   * Provide a discovery index callback for promoted emergent tools.
   */
  setEmergentDiscoveryIndexer?(indexer: (tools: EmergentTool[]) => Promise<void>): void;

  /**
   * Dynamically load an extension at runtime and register its tools.
   *
   * Used by the discovery engine when the agent encounters a request
   * outside its loaded toolset. The extension is loaded for the current
   * session only — it does not persist to config.
   *
   * @param extensionId - The extension ID from the tool catalog (e.g., 'omdb').
   * @returns The names of newly registered tools, or empty array on failure.
   */
  loadExtensionAtRuntime?(extensionId: string): Promise<string[]>;

  /**
   * Checks the health of the ToolOrchestrator and its critical dependencies.
   *
   * @async
   * @returns {Promise<{ isHealthy: boolean; details?: any }>} Health status.
   */
  checkHealth(): Promise<{ isHealthy: boolean; details?: any }>;

  /**
   * Gracefully shuts down the ToolOrchestrator.
   * This should also trigger shutdown for any managed resources, including registered tools
   * that implement a `shutdown` method (via the ToolExecutor).
   *
   * @async
   * @returns {Promise<void>}
   */
  shutdown(): Promise<void>;
}
