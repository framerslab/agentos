// File: backend/agentos/config/ToolOrchestratorConfig.ts
/**
 * @fileoverview Defines the configuration interface for the ToolOrchestrator.
 * This configuration allows customization of various aspects of tool management,
 * execution, and registry behavior within AgentOS, providing flexibility and control
 * over the tool ecosystem.
 *
 * @module backend/agentos/config/ToolOrchestratorConfig
 */

/**
 * @interface ToolRegistrySettings
 * @description Defines settings specific to the tool registry behavior within the ToolOrchestrator.
 * These settings control how tools are managed, whether they can be added dynamically,
 * and conceptual aspects of persistence.
 *
 * @property {boolean} [allowDynamicRegistration=true] - If true (default), tools can be registered or
 * unregistered with the orchestrator after its initial initialization. If false, the set of
 * available tools is fixed once the orchestrator is initialized.
 * @property {boolean} [persistRegistry=false] - If true (default: false), this conceptually indicates that the tool
 * registry's state (e.g., list of dynamically registered tools, their versions) should be persisted
 * to a durable store (e.g., database, configuration file). The actual persistence mechanism
 * would be implemented within the ToolOrchestrator or a dedicated registry service.
 * (Note: The current ToolOrchestrator uses an in-memory map).
 * @property {string} [persistencePath] - Optional. If `persistRegistry` is true, this string could specify
 * the path, URI, or identifier for the persisted storage location or configuration. (Conceptual).
 */
export interface ToolRegistrySettings {
  allowDynamicRegistration?: boolean;
  persistRegistry?: boolean;
  persistencePath?: string;
}

export interface ToolOrchestratorHITLConfig {
  /**
   * Enable HITL gating inside the ToolOrchestrator.
   * Default: false.
   */
  enabled?: boolean;
  /**
   * If true, tools with `tool.hasSideEffects === true` require an approval before execution.
   * Default: true (when HITL is enabled).
   */
  requireApprovalForSideEffects?: boolean;
  /**
   * Default severity for side-effect tool approvals.
   * Default: 'high'.
   */
  defaultSideEffectsSeverity?: 'low' | 'medium' | 'high' | 'critical';
  /**
   * Optional per-approval timeout (ms). If omitted, the HITL manager's default timeout is used.
   */
  approvalTimeoutMs?: number;
  /**
   * If true, ToolOrchestrator will execute side-effect tools even if no HITL manager was provided.
   * Default: false.
   */
  autoApproveWhenNoManager?: boolean;
}

/**
 * @interface ToolOrchestratorConfig
 * @description Configuration options for the ToolOrchestrator.
 * This interface allows for fine-tuning its operational parameters, default behaviors,
 * logging levels, and integration points with other system components.
 *
 * @property {string} [orchestratorId] - An optional unique identifier for this ToolOrchestrator instance.
 * If not provided, one may be generated automatically (e.g., by the orchestrator's constructor).
 * This ID is useful for logging, debugging, and potentially for managing multiple orchestrator instances
 * in more complex or distributed setups.
 * @property {number} [defaultToolCallTimeoutMs=30000] - Default timeout in milliseconds (default: 30 seconds)
 * for a tool execution if the tool itself does not specify a more granular timeout or if the `ToolExecutor`
 * needs a fallback. (Note: Actual timeout enforcement is typically handled by the `ToolExecutor` or the tool implementation).
 * @property {number} [maxConcurrentToolCalls=10] - Maximum number of tool calls that the orchestrator, or more likely
 * the underlying `ToolExecutor`, will attempt to process concurrently. This helps in managing system resources
 * and preventing overload from too many simultaneous tool executions. (Conceptual for orchestrator, executor enforces).
 * @property {boolean} [logToolCalls=true] - If true (default), detailed information about tool calls (including requests,
 * arguments, results, and any errors) will be logged by the orchestrator, and the `ToolExecutor` it is initialized with
 * prints each tool's arguments, an output preview and failure details. Off, the executor's lines name the tool, the
 * duration and the error only, so a tool that reads a person's record keeps their words out of the process log. The
 * default configuration turns it on only when `NODE_ENV` is `development`.
 * @property {string[]} [globalDisabledTools] - An array of tool names (`ITool.name`) or tool IDs (`ITool.id`)
 * that are globally disabled. These tools will not be registered or, if already present, will not be
 * executed, irrespective of other permission settings. This provides a system-wide mechanism to quickly
 * disable problematic or deprecated tools.
 * @property {ToolRegistrySettings} [toolRegistrySettings] - Configuration settings that specifically govern
 * the behavior of the internal tool registry, such as dynamic registration allowance.
 * @property {Record<string, any>} [customParameters] - A flexible object to accommodate any other custom
 * parameters or settings that specific `ToolOrchestrator` implementations or extensions might require.
 * This allows for extensibility without modifying the core interface.
 */
export interface ToolOrchestratorConfig {
  orchestratorId?: string;
  defaultToolCallTimeoutMs?: number;
  maxConcurrentToolCalls?: number;
  logToolCalls?: boolean;
  globalDisabledTools?: string[];
  toolRegistrySettings?: ToolRegistrySettings;
  hitl?: ToolOrchestratorHITLConfig;
  customParameters?: Record<string, any>;
}
