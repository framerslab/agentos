// File: backend/agentos/core/tools/ToolExecutor.ts
/**
 * @fileoverview Implements the ToolExecutor class, responsible for the direct
 * execution of tools conforming to the ITool interface. It handles critical
 * aspects like input argument validation against JSON schemas and invoking
 * the tool's core logic.
 *
 * @module backend/agentos/core/tools/ToolExecutor
 * @see ./ITool.ts for ITool, ToolExecutionResult, ToolExecutionContext.
 * @see ../cognitive_substrate/IGMI.ts for ToolCallRequest, UserContext.
 * @see @framers/agentos/utils/errors.ts for GMIError, GMIErrorCode, createGMIErrorFromError.
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { uuidv4 } from '../utils/uuid.js';

import { ITool, JSONSchemaObject, ToolExecutionResult, ToolExecutionContext } from './ITool';
import { ToolCallRequest, UserContext } from '../../cognition/substrate/IGMI';
import type { IAuthService, ISubscriptionService } from '../types/auth';
import { GMIError, GMIErrorCode, createGMIErrorFromError } from '../utils/errors.js';
import { ExtensionRegistry, EXTENSION_KIND_TOOL, ToolDescriptor } from '../../extensions';

type AjvValidationError = {
  instancePath?: string;
  schemaPath?: string;
  message?: string;
  params?: Record<string, unknown>;
};

type AjvValidateFn = ((data: unknown) => boolean) & { errors?: AjvValidationError[] | null };

/**
 * @interface ToolExecutionRequestDetails
 * @description Encapsulates all necessary information for the `ToolExecutor` to execute a tool.
 * This includes the specific tool call request (typically originating from an LLM),
 * and crucial contextual information about the invoking GMI, Persona, and User.
 *
 * @property {ToolCallRequest} toolCallRequest - The raw tool call request containing the target tool's
 * function name and its arguments (usually as a JSON string or pre-parsed object).
 * @property {string} gmiId - The ID of the GMI (Generalized Mind Instance) initiating the tool call.
 * @property {string} personaId - The ID of the active Persona within the GMI.
 * @property {string[]} personaCapabilities - Capabilities of the active Persona, used for preliminary checks.
 * @property {UserContext} userContext - Contextual information about the end-user.
 * @property {string} [correlationId] - Optional ID for tracing this specific execution across logs and systems.
 * @property {Record<string, any>} [sessionData] - Optional per-turn execution context such as
 * conversation/session IDs or tenant routing data that tools may need for scoped behavior.
 */
export interface ToolExecutionRequestDetails {
  toolCallRequest: ToolCallRequest;
  gmiId: string;
  personaId: string;
  personaCapabilities: string[];
  userContext: UserContext;
  correlationId?: string;
  sessionData?: Record<string, any>;
}

/**
 * @class ToolExecutor
 * @description Manages a registry of `ITool` instances and robustly handles their execution.
 * Key responsibilities include validating input arguments against each tool's defined JSON schema
 * using Ajv, and then invoking the tool's `execute` method with the appropriate `ToolExecutionContext`.
 * It ensures that tools are called correctly and their outputs (or errors) are processed consistently.
 */
export class ToolExecutor {
  private readonly toolRegistry: ExtensionRegistry<ITool>;
  private readonly directRegistrations: Set<string>;
  private readonly authService?: IAuthService;
  private readonly subscriptionService?: ISubscriptionService;
  /**
   * Instance of Ajv for JSON schema validation.
   * Note: The TS2709 error "Cannot use namespace 'Ajv' as a type" might indicate
   * an issue with TypeScript configuration (e.g., esModuleInterop) or Ajv's type
   * definitions version mismatch if it persists. The `import Ajv from 'ajv';`
   * and `ajv: Ajv` usage with `new Ajv()` is standard for Ajv v8+.
   * @private
   * @type {InstanceType<typeof Ajv>}
   */
  private readonly ajv: InstanceType<typeof Ajv>;

  /**
  * Creates an instance of ToolExecutor.
  * Initializes an empty tool registry and configures an Ajv instance for JSON schema validation.
  * Default tools can be registered via `registerDefaultTools` or explicitly.
  *
  * @constructor
  * @param {IAuthService} [authService] - Optional. An instance of an authentication service.
  * Used for potential future integration with more complex user-specific permission checks directly within the executor,
  * though primary permission logic resides in `ToolPermissionManager`.
  * @param {ISubscriptionService} [subscriptionService] - Optional. An instance of a subscription service.
  * Similarly used for potential future feature-based tool access control at the executor level.
  */
  constructor(
    authService?: IAuthService,
    subscriptionService?: ISubscriptionService,
    toolRegistry?: ExtensionRegistry<ITool>,
  ) {
    this.toolRegistry = toolRegistry ?? new ExtensionRegistry<ITool>(EXTENSION_KIND_TOOL);
    this.directRegistrations = new Set<string>();
    this.authService = authService;
    this.subscriptionService = subscriptionService;

    this.ajv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: true });
    addFormats(this.ajv); // Adds support for standard formats like "date-time", "email", "uri", etc.

    this.registerDefaultTools();
    console.log(
      `ToolExecutor initialized. Registered tools: ${this.toolRegistry.listActive().length}.`,
    );
  }

  /**
  * Registers a tool with the executor, making it available for subsequent execution.
  * Tools are indexed by their functional `name` property, which must be unique within the registry.
  *
  * @public
  * @param {ITool} tool - The tool instance to register. It must conform to the `ITool` interface.
  * @returns {void}
  * @throws {GMIError} If the tool is invalid (e.g., missing `id` or `name` - `GMIErrorCode.INVALID_ARGUMENT`),
  * or if a tool with the same functional `name` is already registered (`GMIErrorCode.ALREADY_EXISTS`).
  */
  public async registerTool(tool: ITool): Promise<void> {
    if (
      !tool ||
      typeof tool.name !== 'string' ||
      !tool.name.trim() ||
      typeof tool.id !== 'string' ||
      !tool.id.trim()
    ) {
      throw new GMIError(
        "Invalid tool object provided for registration: 'id' and 'name' are required and must be non-empty strings.",
        GMIErrorCode.INVALID_ARGUMENT,
        { toolDetails: { id: tool?.id, name: tool?.name } },
      );
    }

    if (this.directRegistrations.has(tool.name)) {
      await this.toolRegistry.unregister(tool.name);
      this.directRegistrations.delete(tool.name);
    }

    const descriptor = this.createDescriptorFromTool(tool);
    await this.toolRegistry.register(descriptor);
    this.directRegistrations.add(tool.name);
    console.log(
      `ToolExecutor: Tool '${tool.name}' (ID: '${tool.id}', Version: ${tool.version || 'N/A'}) successfully registered.`,
    );
  }

  /**
  * Retrieves a registered tool instance by its functional name.
  *
  * @public
  * @param {string} toolName - The `name` of the tool (as specified in `ITool.name` and used in `ToolCallRequest.name`).
  * @returns {ITool | undefined} The `ITool` instance if found in the registry; otherwise, `undefined`.
  */
  public getTool(toolName: string): ITool | undefined {
    return this.toolRegistry.getActive(toolName)?.payload;
  }

  /**
  * Unregisters a tool from the executor using its functional name.
  * If the tool has a `shutdown` method, it is called prior to removal from the registry.
  *
  * @public
  * @async
  * @param {string} toolName - The `name` of the tool to unregister.
  * @returns {Promise<boolean>} A promise resolving to `true` if the tool was found and successfully unregistered (including its shutdown, if applicable), `false` otherwise.
  */
  public async unregisterTool(toolName: string): Promise<boolean> {
    if (!this.directRegistrations.has(toolName)) {
      console.warn(
        `ToolExecutor: Attempted to unregister tool '${toolName}', but no direct registration was found.`,
      );
      return false;
    }

    const removed = await this.toolRegistry.unregister(toolName);
    if (removed) {
      this.directRegistrations.delete(toolName);
      console.log(`ToolExecutor: Tool '${toolName}' successfully unregistered.`);
    } else {
      console.warn(
        `ToolExecutor: Failed to unregister tool '${toolName}'. Descriptor stack may be managed externally.`,
      );
    }
    return removed;
  }

  /**
  * Returns an array of definitions for all currently registered tools.
  * This list typically includes essential information like the tool's name, description,
  * input/output schemas, category, and required capabilities, making it suitable for
  * LLM consumption for function calling or for UI display.
  *
  * @public
  * @returns {Array<Pick<ITool, 'name' | 'description' | 'inputSchema' | 'outputSchema' | 'displayName' | 'category' | 'requiredCapabilities'>>}
  * An array of partial tool information objects.
  */
  public listAvailableTools(): Array<
    Pick<ITool, 'name' | 'description' | 'inputSchema' | 'outputSchema' | 'displayName' | 'category' | 'requiredCapabilities'>
  > {
    return this.toolRegistry.listActive().map(({ payload }) => ({
      name: payload.name,
      displayName: payload.displayName,
      description: payload.description,
      inputSchema: payload.inputSchema,
      outputSchema: payload.outputSchema,
      category: payload.category,
      requiredCapabilities: payload.requiredCapabilities,
    }));
  }

  /**
  * Executes a specified tool based on the details provided in a `ToolExecutionRequestDetails` object.
  * This is the core method of the executor, orchestrating validation, context preparation,
  * actual tool invocation, and result packaging.
  *
  * @public
  * @async
  * @param {ToolExecutionRequestDetails} requestDetails - An object containing all necessary details for the tool execution,
  * including the `ToolCallRequest` from the LLM and contextual GMI/user information.
  * @returns {Promise<ToolExecutionResult>} A promise that resolves with the `ToolExecutionResult` object.
  * This result indicates the success or failure of the execution and provides the tool's output or error details.
  */
  public async executeTool(requestDetails: ToolExecutionRequestDetails): Promise<ToolExecutionResult> {
    const {
      toolCallRequest,
      gmiId,
      personaId,
      personaCapabilities,
      userContext,
      correlationId,
      sessionData,
    } = requestDetails;
    
    if (!toolCallRequest || !toolCallRequest.name || typeof toolCallRequest.name !== 'string') {
        const errorMsg = "Invalid ToolCallRequest provided to ToolExecutor: 'name' is missing or invalid.";
        console.error(`ToolExecutor: ${errorMsg}`, requestDetails);
        return { success: false, error: errorMsg, details: { receivedRequest: toolCallRequest, code: GMIErrorCode.VALIDATION_ERROR } };
    }
    const toolName = toolCallRequest.name;
    const toolDescriptor = this.toolRegistry.getActive(toolName);
    const tool = toolDescriptor?.payload;

    const logContext = `ToolExecutor (GMI: ${gmiId}, Persona: ${personaId}, Tool: ${toolName}, LLMCallID: ${toolCallRequest.id || 'N/A'})`;

    if (!tool) {
      const errorMsg = `Tool '${toolName}' not found in ToolExecutor registry. Cannot execute.`;
      console.error(`${logContext}: ${errorMsg}`);
      return { success: false, error: errorMsg, details: { toolName, reason: "NotRegisteredInExecutor" } };
    }
    
    if (tool.requiredCapabilities && tool.requiredCapabilities.length > 0) {
      const hasAllCapabilities = tool.requiredCapabilities.every(cap => personaCapabilities.includes(cap));
      if (!hasAllCapabilities) {
        const missingCaps = tool.requiredCapabilities.filter(rc => !personaCapabilities.includes(rc));
        const errorMsg = `Persona (ID: ${personaId}) lacks capabilities for tool '${tool.name}'. Required: [${tool.requiredCapabilities.join(', ')}], Missing: [${missingCaps.join(', ')}].`;
        console.warn(`${logContext}: Capability check failed - ${errorMsg}`);
        return { success: false, error: errorMsg, details: { toolName: tool.name, requiredCapabilities: tool.requiredCapabilities, possessedCapabilities: personaCapabilities, missingCapabilities: missingCaps }};
      }
    }

    let parsedArgs: Record<string, any>;
    try {
      // Assuming toolCallRequest.arguments is already a Record<string, any> as per IGMI.ts ToolCallRequest definition
      // If it can be a string, further parsing logic is needed.
      if (typeof toolCallRequest.arguments === 'string') {
          parsedArgs = JSON.parse(toolCallRequest.arguments);
      } else if (typeof toolCallRequest.arguments === 'object' && toolCallRequest.arguments !== null) {
          parsedArgs = toolCallRequest.arguments;
      } else if (toolCallRequest.arguments === undefined || toolCallRequest.arguments === null) {
          parsedArgs = {}; 
      } else {
          throw new Error(`Tool arguments are not a JSON string or object: ${typeof toolCallRequest.arguments}`);
      }
    } catch (parseError: any) {
      const errorMsg = `Failed to parse arguments for tool '${tool.name}'. Arguments must be a valid JSON string or object.`;
      console.warn(`${logContext}: Argument parsing failed. Raw Args: "${JSON.stringify(toolCallRequest.arguments)}". Error: ${parseError.message}`);
      return { success: false, error: errorMsg, details: { toolName: tool.name, argumentParsingError: parseError.message, rawArguments: toolCallRequest.arguments } };
    }
    
    if (tool.inputSchema) {
      const validate = this.ajv.compile(tool.inputSchema) as AjvValidateFn;
      if (!validate(parsedArgs)) {
        const errorMsg = `Invalid arguments for tool '${tool.name}'. Validation failed against input schema.`;
        const validationErrors = Array.isArray(validate.errors)
          ? validate.errors.map(err => ({
              path: err.instancePath || err.schemaPath,
              message: err.message,
              params: err.params,
            }))
          : [{ message: 'Unknown schema validation error.' }];
        console.warn(`${logContext}: Argument schema validation failed. Errors:`, JSON.stringify(validationErrors, null, 2), 'Parsed Args:', parsedArgs);
        return { success: false, error: errorMsg, details: { toolName: tool.name, validationErrors, providedParsedArgs: parsedArgs } };
      }
    }

    const executionContext: ToolExecutionContext = {
      gmiId,
      personaId,
      userContext,
      correlationId: correlationId || `tool-exec-${uuidv4()}`,
      ...(sessionData ? { sessionData } : {}),
    };

    try {
      console.log(`${logContext}: Executing tool '${tool.name}' (ID: '${tool.id}') with validated arguments:`, parsedArgs);
      const startTime = Date.now();
      const result: ToolExecutionResult = await tool.execute(parsedArgs, executionContext);
      const durationMs = Date.now() - startTime;
      
      const outputPreview = result.output ? JSON.stringify(result.output).substring(0,150) + (JSON.stringify(result.output).length > 150 ? '...' : '') : 'N/A';
      if (result.success) {
        console.log(`${logContext}: Tool execution successful. Duration: ${durationMs}ms. Output preview: ${outputPreview}`);
      } else {
        console.warn(`${logContext}: Tool execution reported failure. Duration: ${durationMs}ms. Error: ${result.error}`, result.details);
      }
      
      if (tool.outputSchema && result.success && result.output !== undefined) {
        const validateOutput = this.ajv.compile(tool.outputSchema) as AjvValidateFn;
        if (!validateOutput(result.output)) {
          const outputErrorMsg = `Tool '${tool.name}' produced output that failed its defined output schema validation.`;
          const outputValidationErrors = Array.isArray(validateOutput.errors)
            ? validateOutput.errors.map(err => ({
                path: err.instancePath,
                message: err.message,
                params: err.params,
              }))
            : [];
          console.warn(`${logContext}: Output schema validation failed for '${tool.name}'. Errors:`, JSON.stringify(outputValidationErrors, null, 2));
          return {
            ...result,
            success: false, // Mark as overall failure if output schema validation fails
            error: result.error ? `${result.error} And output schema validation failed.` : outputErrorMsg,
            details: {
              ...(result.details || {}),
              outputValidationWarning: outputErrorMsg,
              outputValidationErrors,
            },
          };
        }
      }
      return result;

    } catch (err: any) {
      const execErrorMsg = `Critical unhandled error during the execution of tool '${tool.name}'.`;
      console.error(`${logContext}: ${execErrorMsg}`, err);
      const gmiErr = createGMIErrorFromError(err, GMIErrorCode.TOOL_EXECUTION_FAILED, { toolName: tool.name, arguments: parsedArgs }, execErrorMsg);
      return { 
        success: false, 
        error: gmiErr.message, 
        details: { 
          toolName: tool.name, 
          errorCode: gmiErr.code, 
          errorDetailsFromGMIError: gmiErr.details,
          rawErrorString: err.toString(),
          stack: err.stack 
        } 
      };
    }
  }

  /** @private 
  * Registers example tools. In a production system, tools would be loaded dynamically or via configuration.
  */
  private createDescriptorFromTool(tool: ITool): ToolDescriptor {
    return {
      id: tool.name,
      kind: EXTENSION_KIND_TOOL,
      payload: tool,
      metadata: {
        toolId: tool.id,
        origin: 'direct-registration',
      },
      onDeactivate: async () => {
        if (typeof tool.shutdown === 'function') {
          try {
            await tool.shutdown();
          } catch (error) {
            console.error(
              `ToolExecutor: Error during shutdown of tool '${tool.name}' (ID: '${tool.id}')`,
              error,
            );
          }
        }
      },
    };
  }

  private registerDefaultTools(): void {
    const currentTimeTool: ITool<{ timezone?: string }, { currentTime: string; timezoneUsed: string; isoTimestamp: string }> = {
      id: "system-current-time-tool-v1.1",
      name: "getCurrentDateTime",
      displayName: "Current Date & Time Service",
      description: "Gets the current date and time, optionally for a specific IANA timezone (e.g., 'America/New_York', 'Europe/London'). Defaults to the server's local timezone if no timezone is provided or if the provided one is invalid.",
      inputSchema: {
        type: "object",
        properties: { timezone: { type: "string", description: "Optional: IANA timezone string (e.g., 'America/Los_Angeles', 'Europe/London'). Examples: 'UTC', 'America/New_York', 'Asia/Tokyo'.", format: "time-zone" } },
        additionalProperties: false,
      } as JSONSchemaObject,
      outputSchema: {
        type: "object",
        properties: {
          currentTime: { type: "string", description: "The current date and time formatted as a locale string (e.g., '5/24/2025, 11:43:58 AM')." },
          timezoneUsed: { type: "string", description: "The IANA timezone that was used for the calculation." },
          isoTimestamp: { type: "string", format: "date-time", description: "The current date and time in ISO 8601 format (UTC)."}
        },
        required: ["currentTime", "timezoneUsed", "isoTimestamp"]
      } as JSONSchemaObject,
      category: "System Utilities", version: "1.1.0", hasSideEffects: false,
      execute: async (args: { timezone?: string }, context: ToolExecutionContext): Promise<ToolExecutionResult<{ currentTime: string; timezoneUsed: string; isoTimestamp: string }>> => {
        try {
          let effectiveTimezone = args.timezone;
          const serverDefaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
          if (effectiveTimezone) {
            try { new Date().toLocaleString("en-US", { timeZone: effectiveTimezone }); } 
            catch (tzError: any) {
              console.warn(`ToolExecutor[getCurrentDateTime]: Invalid timezone '${args.timezone}' provided by GMI ${context.gmiId}. Falling back to ${serverDefaultTimezone}. Error: ${tzError.message}`);
              effectiveTimezone = serverDefaultTimezone;
            }
          } else { effectiveTimezone = serverDefaultTimezone; }
          
          const currentDate = new Date();
          return {
            success: true,
            output: {
              currentTime: currentDate.toLocaleString("en-US", { timeZone: effectiveTimezone, hour12: true, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }),
              timezoneUsed: effectiveTimezone,
              isoTimestamp: currentDate.toISOString(),
            },
            contentType: "application/json"
          };
        } catch (e: any) {
          return { success: false, error: `Error getting current time: ${e.message}`, details: { stack: e.stack } };
        }
      }
    };
    this.registerTool(currentTimeTool).catch((e: any) => {
      console.error('Error registering default current time tool:', e);
    });
  }

  /**
  * Gracefully shuts down all registered tools that implement the optional `shutdown` method.
  * This is typically called when the ToolExecutor itself is being shut down as part of a larger
  * application termination sequence.
  *
  * @public
  * @async
  * @returns {Promise<void[]>} A promise that resolves when all tool shutdown attempts are complete.
  * Individual tool shutdown errors are logged but do not prevent other tools from attempting shutdown.
  */
  public async shutdownAllTools(): Promise<void[]> {
    const activeCount = this.toolRegistry.listActive().length;
    console.log(`ToolExecutor: Initiating shutdown for ${activeCount} registered tool(s)...`);
    await this.toolRegistry.clear();
    this.directRegistrations.clear();
    return [];
  }
}
