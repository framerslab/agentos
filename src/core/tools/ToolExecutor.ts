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

import { uuidv4 } from '../utils/uuid.js';
import { SchemaChecks, checkValue, type SchemaCheck } from '../utils/schemaChecks.js';

import { ITool, JSONSchemaObject, ToolExecutionResult, ToolExecutionContext } from './ITool';
import { ToolCallRequest, UserContext } from '../../cognition/substrate/IGMI';
import type { IAuthService, ISubscriptionService } from '../types/auth';
import { GMIError, GMIErrorCode, createGMIErrorFromError } from '../utils/errors.js';
import { ExtensionRegistry, EXTENSION_KIND_TOOL, ToolDescriptor } from '../../extensions';
import type { CallerTurnContext } from '../../api/runtime/agencyLaunch/types.js';

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
  /**
   * The tool instance the caller already resolved and checked (a composed
   * step). `ToolOrchestrator.processToolCall` runs its checks against it and
   * refuses the call (`STEP_REPLACED`) when the name resolves to another
   * instance by the time the call is delegated. A call without it is bound
   * the same way to the instance resolved when the call began
   * (`TOOL_REPLACED`).
   */
  tool?: ITool;
  /**
   * The call's stop: on a call a GMI makes, its turn's stop (a session's
   * close(), the caller's abort signal, the GMI's shutdown()); on a step, the
   * one its composed call passes on, or a workflow step's timer joined with
   * the workflow call's own. A call whose stop has come by the time its checks
   * pass is refused (`STEP_ABORTED`) before its approval is asked, so no one is
   * asked about a call that cannot run; one whose stop comes while its approval
   * is pending is refused after it. Nothing runs either way, and a call already
   * running is not cut.
   */
  signal?: AbortSignal;
  /** The calling turn's live objects; copied into the tool's context (see ToolExecutionContext.callerTurn). */
  callerTurn?: CallerTurnContext;
  /**
   * Whether this call's console lines carry the tool's arguments, its output and the details of a failure.
   * Set by `ToolOrchestrator.processToolCall` from the orchestrator's own `logToolCalls`, so two orchestrators
   * sharing one executor each keep their own policy. Unset, the executor's own setting applies.
   */
  logToolCalls?: boolean;
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
   * The checks of the tools' input and output schemas. Ajv reads a schema as JSON Schema draft-07, reports every
   * error of a value, coerces a value to the type its schema names where it can, fills in a `default` the schema
   * gives, checks the standard formats (`date-time`, `email`, `uri` and the others of `ajv-formats`), and passes over a
   * keyword it does not know, as JSON Schema says to, and a format it does not know (strict mode is off). A schema
   * compiles once for as long as its object lives. Two tools may each hold a copy of one schema under a shared `$id`,
   * and a tool registered again may bring a new copy: each compile lets go of the `$id`s it registered.
   * @private
   */
  private readonly schemaChecks = new SchemaChecks({ allErrors: true, coerceTypes: true, useDefaults: true, strict: false });
  /**
   * Whether the console lines of `executeTool` carry a tool's arguments, its output and the details of a failure.
   * Off, the lines name the tool, the duration and the error only: a tool that reads a person's record must not put
   * their words in the process log. A call's own `logToolCalls` (set by `ToolOrchestrator.processToolCall`) overrides it.
   * @private
   */
  private logToolCalls: boolean;

  /**
  * Creates an instance of ToolExecutor.
  * Initializes an empty tool registry. A tool's schemas are compiled on its first call that reads them.
  * Default tools can be registered via `registerDefaultTools` or explicitly.
  *
  * @constructor
  * @param {IAuthService} [authService] - Optional. An instance of an authentication service.
  * Used for potential future integration with more complex user-specific permission checks directly within the executor,
  * though primary permission logic resides in `ToolPermissionManager`.
  * @param {ISubscriptionService} [subscriptionService] - Optional. An instance of a subscription service.
  * Similarly used for potential future feature-based tool access control at the executor level.
  * @param {ExtensionRegistry<ITool>} [toolRegistry] - Optional. The registry the tools live in; a new one when omitted.
  * @param {{ logToolCalls?: boolean }} [options] - Optional. `logToolCalls` puts each tool's arguments, an output preview
  * and failure details in the console lines of `executeTool`; off by default (see `setLogToolCalls`).
  */
  constructor(
    authService?: IAuthService,
    subscriptionService?: ISubscriptionService,
    toolRegistry?: ExtensionRegistry<ITool>,
    options?: { logToolCalls?: boolean },
  ) {
    this.logToolCalls = options?.logToolCalls === true;
    this.toolRegistry = toolRegistry ?? new ExtensionRegistry<ITool>(EXTENSION_KIND_TOOL);
    this.directRegistrations = new Set<string>();
    this.authService = authService;
    this.subscriptionService = subscriptionService;

    this.registerDefaultTools();
    console.log(
      `ToolExecutor initialized. Registered tools: ${this.toolRegistry.listActive().length}.`,
    );
  }

  /**
  * Turns the content-bearing console lines of `executeTool` on or off: a tool's arguments, the preview of its output
  * and the details of a failure, for calls that do not carry their own `logToolCalls`.
  *
  * @public
  * @param {boolean} on - True to print them, false to print the tool's name, the duration and the error only.
  * @returns {void}
  */
  public setLogToolCalls(on: boolean): void {
    this.logToolCalls = on === true;
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
   * Calls `listener` with the name of every tool registered from now on,
   * by any path that ends in this executor's registry. Returns a function
   * that removes the listener.
   */
  public onToolRegistered(listener: (toolName: string) => void): () => void {
    return this.toolRegistry.onRegister((descriptor) => listener(descriptor.id));
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
      signal,
    } = requestDetails;
    const logToolCalls = requestDetails.logToolCalls ?? this.logToolCalls;
    
    if (!toolCallRequest || !toolCallRequest.name || typeof toolCallRequest.name !== 'string') {
        const errorMsg = "Invalid ToolCallRequest provided to ToolExecutor: 'name' is missing or invalid.";
        console.error(`ToolExecutor: ${errorMsg}`, logToolCalls ? requestDetails : { gmiId, personaId });
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
      // a JSON parse error quotes the text it failed on, so the message stays in with the raw arguments
      console.warn(logToolCalls
        ? `${logContext}: Argument parsing failed. Raw Args: "${JSON.stringify(toolCallRequest.arguments)}". Error: ${parseError.message}`
        : `${logContext}: Argument parsing failed (${parseError?.name || 'Error'}).`);
      return { success: false, error: errorMsg, details: { toolName: tool.name, argumentParsingError: parseError.message, rawArguments: toolCallRequest.arguments } };
    }
    
    if (tool.inputSchema) {
      let validate: SchemaCheck;
      try {
        validate = this.schemaChecks.check(tool.inputSchema);
      } catch (schemaError: any) {
        // The schema is the tool's own, so its error names nothing from the arguments. Nothing runs.
        const errorMsg = `The input schema of tool '${tool.name}' does not compile: ${schemaError?.message ?? String(schemaError)}`;
        console.error(`${logContext}: ${errorMsg}`);
        return { success: false, error: errorMsg, details: { toolName: tool.name, code: GMIErrorCode.CONFIGURATION_ERROR } };
      }
      const checkedArgs = checkValue(validate, parsedArgs);
      parsedArgs = checkedArgs.value as Record<string, any>;
      if (!checkedArgs.valid) {
        const errorMsg = `Invalid arguments for tool '${tool.name}'. Validation failed against input schema.`;
        const validationErrors = Array.isArray(validate.errors)
          ? validate.errors.map(err => ({
              path: err.instancePath || err.schemaPath,
              message: err.message,
              params: err.params,
            }))
          : [{ message: 'Unknown schema validation error.' }];
        // a validation error's params can carry a name from the input (an additional property), so they stay in only with the arguments
        if (logToolCalls) {
          console.warn(`${logContext}: Argument schema validation failed. Errors:`, JSON.stringify(validationErrors, null, 2), 'Parsed Args:', parsedArgs);
        } else {
          console.warn(`${logContext}: Argument schema validation failed. Errors:`, JSON.stringify(validationErrors.map((e: { path?: string; message?: string }) => ({ path: e.path, message: e.message })), null, 2));
        }
        return { success: false, error: errorMsg, details: { toolName: tool.name, validationErrors, providedParsedArgs: parsedArgs } };
      }
    }

    const executionContext: ToolExecutionContext = {
      gmiId,
      personaId,
      userContext,
      correlationId: correlationId || `tool-exec-${uuidv4()}`,
      ...(sessionData ? { sessionData } : {}),
      ...(personaCapabilities ? { personaCapabilities } : {}),
      // A composed tool passes the expiry on to its own steps.
      ...(signal ? { signal } : {}),
      ...(requestDetails.callerTurn ? { callerTurn: requestDetails.callerTurn } : {}),
    };

    try {
      if (logToolCalls) console.log(`${logContext}: Executing tool '${tool.name}' (ID: '${tool.id}') with validated arguments:`, parsedArgs);
      const startTime = Date.now();
      const result: ToolExecutionResult = await tool.execute(parsedArgs, executionContext);
      const durationMs = Date.now() - startTime;
      
      if (result.success) {
        const outputPreview = !logToolCalls ? '' : ` Output preview: ${result.output ? JSON.stringify(result.output).substring(0, 150) + (JSON.stringify(result.output).length > 150 ? '...' : '') : 'N/A'}`;
        console.log(`${logContext}: Tool execution successful. Duration: ${durationMs}ms.${outputPreview}`);
      } else if (logToolCalls) {
        console.warn(`${logContext}: Tool execution reported failure. Duration: ${durationMs}ms. Error: ${result.error}`, result.details);
      } else {
        console.warn(`${logContext}: Tool execution reported failure. Duration: ${durationMs}ms. Error: ${result.error}`);
      }
      
      if (tool.outputSchema && result.success && result.output !== undefined) {
        let validateOutput: SchemaCheck;
        try {
          validateOutput = this.schemaChecks.check(tool.outputSchema);
        } catch (schemaError: any) {
          // The tool has run, and its output cannot be checked: the call fails. Its result keeps the output, as a failed
          // output check's does; ToolOrchestrator answers a failed call with `output: null`, the error and the details.
          const schemaErrorMsg = `The output schema of tool '${tool.name}' does not compile: ${schemaError?.message ?? String(schemaError)}`;
          console.error(`${logContext}: ${schemaErrorMsg}`);
          return {
            ...result,
            success: false,
            error: schemaErrorMsg,
            details: { ...(result.details || {}), code: GMIErrorCode.CONFIGURATION_ERROR },
          };
        }
        const checkedOutput = checkValue(validateOutput, result.output);
        if (!checkedOutput.valid) {
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
        // Ajv coerces a value inside the output in place; a coercion of the output itself comes back from the holder.
        if (checkedOutput.value !== result.output) return { ...result, output: checkedOutput.value };
      }
      return result;

    } catch (err: any) {
      const execErrorMsg = `Critical unhandled error during the execution of tool '${tool.name}'.`;
      console.error(`${logContext}: ${execErrorMsg}`, logToolCalls ? err : `${err?.name || 'Error'}: ${err?.message ?? String(err)}`);
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
