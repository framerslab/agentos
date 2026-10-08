// File: backend/agentos/core/tools/ITool.ts
/**
 * @fileoverview Defines the ITool interface, the core contract for any tool
 * that can be invoked within the AgentOS ecosystem, typically by a GMI.
 * This interface ensures that all tools provide necessary metadata for discovery,
 * schema validation, permission checking, and execution.
 *
 * @module backend/agentos/core/tools/ITool
 */

import { UserContext } from '../../cognition/substrate/IGMI';

/**
 * Represents a JSON schema definition.
 * This type is used to define the expected structure for tool inputs and outputs,
 * enabling validation and clear contracts for LLMs.
 * @see https://json-schema.org/
 * @typedef {object} JSONSchemaObject
 * @example
 * const schema: JSONSchemaObject = {
 * type: "object",
 * properties: {
 * query: { type: "string", description: "The search query." },
 * max_results: { type: "integer", minimum: 1, default: 5 }
 * },
 * required: ["query"]
 * };
 */
export type JSONSchemaObject = Record<string, any>;

/**
 * Defines the standardized outcome of a tool's execution.
 * It captures whether the execution was successful, the resulting output data,
 * or any error information if it failed.
 *
 * @interface ToolExecutionResult
 * @template TOutput The expected type of the `output` data if the tool executes successfully. Defaults to `any`.
 * @property {boolean} success - Indicates whether the tool execution was successful. `true` for success, `false` for failure.
 * @property {TOutput} [output] - The output data from the tool if successful. The structure
 * of this data should ideally conform to the tool's `outputSchema` (if defined).
 * @property {string} [error] - A human-readable error message if the execution failed (`success` is `false`).
 * @property {string} [contentType="application/json"] - The MIME type of the `output` data.
 * Defaults to "application/json". Other common types include "text/plain", "image/png", etc.
 * This helps consumers of the tool result to correctly interpret the output.
 * @property {Record<string, any>} [details] - An optional object for any additional details or metadata
 * about the execution or error. This can include things like error codes, stack traces (for debugging),
 * performance metrics, or other contextual information.
 */
export interface ToolExecutionResult<TOutput = any> {
  success: boolean;
  output?: TOutput;
  error?: string;
  contentType?: string; 
  details?: Record<string, any>;
  /**
   * The call's effects: a code-forged tool's capability calls under a
   * ceiling, or a composition's steps. Attached by AgentOS, never by the
   * tool's own code.
   */
  effects?: ToolEffectRecord[];
}

/**
 * One effect a tool call had, carried on its result: a capability call of a
 * code-forged tool under a ceiling, or a step of a composition.
 */
export type ToolEffectRecord = CapabilityEffect | StepEffect;

/** A capability call of a code-forged tool under a ceiling. */
export interface CapabilityEffect {
  kind: 'capability';
  toolId: string;
  callId: string;
  capability: string;
  /** The URL or path as the record keeps it: a SHA-256 hex digest, or the target itself when `audit.content` is `'full'`. */
  target: string;
  decision: 'allowed' | 'refused';
  /** `'ceiling'` for an allowed call; the refusal's code otherwise. */
  decidedBy: string;
  /** `pending`: the call had not settled when the result was returned; its record completes when it settles. */
  outcome: 'ok' | 'error' | 'aborted' | 'timed_out' | 'refused' | 'pending';
  /** The code a refusal or an end carried during the call (`host_not_allowed` at a redirect, `response_too_large`, `call_ended`). */
  code?: string;
  bytes?: number;
  /** For `crypto`: the number of calls in the run, which has one entry. */
  uses?: number;
  /** What storage holds: both halves, the intent only (the terminal write failed; the row reads unknown), or nothing. */
  record: 'written' | 'intent_only' | 'none';
}

/** A step of a composition that has side effects, or is a composition. */
export interface StepEffect {
  kind: 'step';
  step: string;
  tool: string;
  /** In a forge test: the step was not executed; its output came from the test case. */
  wouldRun?: true;
  /** The step ran. */
  ran?: true;
  /** The step is a composition. */
  nested?: true;
  args?: Record<string, unknown>;
}

/**
 * Defines the invocation context passed to a tool's `execute` method.
 * This context provides the tool with essential information about the calling entity (GMI, Persona),
 * the user, and the overall session, enabling context-aware tool execution.
 *
 * @interface ToolExecutionContext
 * @property {string} gmiId - The unique identifier of the GMI (Generalized Mind Instance) that is invoking the tool.
 * @property {string} personaId - The unique identifier of the active Persona within the GMI that requested the tool execution.
 * @property {UserContext} userContext - Contextual information about the end-user associated with the current interaction,
 * which might include user ID, preferences, skill level, etc.
 * @property {string} [correlationId] - An optional identifier used to correlate this specific tool call with other
 * operations, logs, or events across different parts of the system. Useful for tracing and debugging.
 * @property {Record<string, any>} [sessionData] - Optional. Ephemeral data relevant to the current session, potentially
 * sourced from the GMI's working memory or the orchestrator. This allows tools to access dynamic session state
 * if needed for their operation (e.g., user's current location, temporary files).
 */
export interface ToolExecutionContext {
  gmiId: string;
  personaId: string;
  userContext: UserContext;
  correlationId?: string;
  sessionData?: Record<string, any>;
  /**
   * The calling persona's capabilities, as the permission check received them.
   * A tool that runs other tools on the caller's behalf (a composed tool, a
   * workflow) passes them on, so each step is checked as the caller.
   */
  personaCapabilities?: string[];
}

/**
 * @interface ITool
 * @template TInput - The type of the input arguments object this tool expects. Defaults to `any`. It should ideally be a specific interface matching the `inputSchema`.
 * @template TOutput - The type of the output data this tool produces upon successful execution. Defaults to `any`. It should ideally be a specific interface matching the `outputSchema`.
 * @description The core interface that all tools within AgentOS must implement.
 * It provides a standardized way for tools to declare their identity, capabilities,
 * input/output schemas, required permissions, and the core execution logic.
 * This standardization is crucial for tool discovery, LLM interaction, validation, and orchestrated execution.
 */
export interface ITool<TInput extends Record<string, any> = any, TOutput = any> {
  /**
   * A globally unique identifier for this specific tool (e.g., "web-search-engine-v1.2", "stock-price-fetcher").
   * This ID is used for internal registration, management, and precise identification.
   * It's recommended to use a namespaced, versioned format (e.g., `vendor-toolname-version`).
   * @type {string}
   * @readonly
   */
  readonly id: string;

  /**
   * The functional name of the tool, as it should be presented to and used by an LLM in a tool call request
   * (e.g., "searchWeb", "executePythonCode", "getWeatherForecast").
   * This name must be unique among the set of tools made available to a given GMI/LLM at any time.
   * It should be concise, descriptive, and typically in camelCase or snake_case.
   * @type {string}
   * @readonly
   */
  readonly name: string;

  /**
   * A concise, human-readable title or display name for the tool.
   * Used in user interfaces, logs, or when presenting tool options to developers or users.
   * @type {string}
   * @readonly
   * @example "Web Search Engine", "Advanced Python Code Interpreter"
   */
  readonly displayName: string;

  /**
   * A detailed, natural language description of what the tool does, its primary purpose,
   * typical use cases, and any important considerations or limitations for its use.
   * This description is critical for an LLM to understand the tool's capabilities and
   * make informed decisions about when and how to invoke it. It should be comprehensive enough
   * for the LLM to grasp the tool's semantics.
   * @type {string}
   * @readonly
   */
  readonly description: string;

  /**
   * The JSON schema defining the structure, types, and constraints of the input arguments object
   * that this tool expects. This schema is used by:
   * 1. LLMs: To construct valid argument objects when requesting a tool call.
   * 2. `ToolExecutor`: For validating the arguments before invoking the tool's `execute` method.
   * It should follow the JSON Schema specification.
   * @see https://json-schema.org/
   * @type {JSONSchemaObject}
   * @readonly
   */
  readonly inputSchema: JSONSchemaObject;

  /**
   * Optional. The JSON schema defining the structure and types of the output object
   * that this tool will produce upon successful execution.
   * Providing an output schema helps in validating the tool's output, provides clarity for
   * consumers of the tool's result (including other tools or the GMI), and can aid the LLM
   * in understanding what to expect back from the tool.
   * @type {JSONSchemaObject | undefined}
   * @optional
   * @readonly
   */
  readonly outputSchema?: JSONSchemaObject;

  /**
   * Optional. An array of capability strings (e.g., "capability:filesystem:read", "capability:network:external_api")
   * that the active Persona (or GMI configuration) must possess to be authorized to use this tool.
   * If this array is empty or undefined, the tool might be generally available or rely on other
   * permission mechanisms (e.g., user subscription tiers).
   * @type {string[] | undefined}
   * @optional
   * @readonly
   * @example `["capability:web_search", "capability:execute_code_unsafe"]`
   */
  readonly requiredCapabilities?: string[];

  /**
   * Optional. A category or group to which this tool belongs (e.g., "data_analysis", "communication", "file_system", "image_generation").
   * This is useful for organizing tools, for filtering in UIs or registries, and potentially for
   * aiding an LLM in selecting from a large set of tools.
   * @type {string | undefined}
   * @optional
   * @readonly
   */
  readonly category?: string;

  /**
   * Optional. The version of the tool (e.g., "1.0.0", "2.1-beta", "2024-05-24").
   * Useful for managing updates and compatibility.
   * @type {string | undefined}
   * @optional
   * @readonly
   */
  readonly version?: string;

  /**
   * Optional. Indicates if the tool might have side effects on external systems
   * (e.g., writing to a database, sending an email, making a purchase, modifying a file).
   * Defaults to `false` if not specified. LLMs or orchestrators might handle tools with side effects
   * with greater caution, potentially requiring explicit user confirmation.
   * @type {boolean | undefined}
   * @optional
   * @readonly
   */
  readonly hasSideEffects?: boolean;

  /**
   * Executes the core logic of the tool with the provided arguments and execution context.
   * This method is asynchronous and should encapsulate the tool's primary functionality.
   * Implementations should handle their own internal errors gracefully and package them
   * into the `ToolExecutionResult` object.
   *
   * @public
   * @async
   * @param {TInput} args - The input arguments for the tool. These arguments are expected to have been
   * validated against the tool's `inputSchema` by the calling system (e.g., `ToolExecutor`).
   * @param {ToolExecutionContext} context - The execution context, providing information about
   * the GMI, user, current session, and any correlation IDs for tracing.
   * @returns {Promise<ToolExecutionResult<TOutput>>} A promise that resolves with a `ToolExecutionResult` object,
   * which contains the `success` status, the `output` data (if successful), or an `error` message (if failed).
   * @throws {GMIError | Error} While tools should ideally capture errors and return them in `ToolExecutionResult.error`,
   * critical, unrecoverable, or unexpected system-level failures during execution might still result in a thrown exception.
   * The `ToolExecutor` should be prepared to catch these.
   */
  execute(args: TInput, context: ToolExecutionContext): Promise<ToolExecutionResult<TOutput>>;

  /**
   * Optional. Provides a hook for tools to implement custom validation logic for their input arguments,
   * potentially more specific or nuanced than standard JSON schema validation.
   * While the `ToolExecutor` typically performs schema validation based on `inputSchema` before calling `execute`,
   * this method allows the tool itself to perform additional checks if necessary.
   *
   * @public
   * @param {Record<string, any>} args - The raw arguments object to validate.
   * @returns {{ isValid: boolean; errors?: any[] }} An object indicating if the arguments are valid.
   * If `isValid` is `false`, the `errors` array should contain objects or strings describing the validation failures.
   * @optional
   */
  validateArgs?(args: Record<string, any>): { isValid: boolean; errors?: any[] };

  /**
   * Optional. A method to gracefully shut down the tool and release any resources it holds
   * (e.g., database connections, network listeners, file handles, child processes).
   * This is called by the system (e.g., `ToolExecutor` or `ToolOrchestrator`) during application shutdown
   * or when a tool is being unregistered dynamically.
   *
   * @public
   * @async
   * @returns {Promise<void>} A promise that resolves when the tool has completed its shutdown procedures.
   * @optional
   */
  shutdown?(): Promise<void>;
}
