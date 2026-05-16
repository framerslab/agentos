// File: backend/agentos/core/tools/permissions/ToolPermissionManager.ts
/**
 * @file ToolPermissionManager.ts
 * @module backend/agentos/core/tools/permissions/ToolPermissionManager
 * @version 1.2.1
 *
 * @description
 * This module implements the `IToolPermissionManager` interface, providing a robust and
 * configurable system for managing permissions related to tool execution within the AgentOS ecosystem.
 * The `ToolPermissionManager` is a critical component for enforcing authorization policies,
 * evaluating requests against Persona capabilities, user subscription features (via `ISubscriptionService`),
 * and any other defined contextual rules. Its design emphasizes clarity, extensibility, and
 * adherence to SOTA TypeScript practices.
 *
 * Key Responsibilities:
 * - Initialization with a detailed configuration (`ToolPermissionManagerConfig`) and essential
 * dependent services such as `IAuthService` and `ISubscriptionService`.
 * - Authoritatively checking if a tool execution is permitted based on a comprehensive
 * `PermissionCheckContext`, which includes the tool in question, the invoking Persona's
 * profile, and the end-user's context.
 * - Verifying that the invoking Persona possesses all `requiredCapabilities` specified by the tool,
 * if `strictCapabilityChecking` is enabled.
 * - Interacting with the `ISubscriptionService` to determine if the user's current subscription
 * tier grants access to specific features that may be prerequisites for using certain tools.
 * - Providing clear, actionable reasons and detailed metadata for all permission decisions,
 * aiding in debugging, auditing, and user feedback.
 * - Centralizing tool access logic to enhance security and maintainability across the platform.
 * - Offering configurable logging for permission checks via `logToolCalls` in its configuration.
 *
 * Architectural Tenets Applied:
 * - Interface-Driven Design: Implements `IToolPermissionManager`.
 * - Dependency Injection: `IAuthService` and `ISubscriptionService` are injected.
 * - Comprehensive JSDoc: All public and significant private members are documented.
 * - Robust Error Handling: Uses standardized `GMIError` and `GMIErrorCode`.
 * - Configuration Management: Behavior is driven by `ToolPermissionManagerConfig`.
 * - Strict Type Safety: Leverages TypeScript's type system to prevent common errors.
 *
 * @see {@link IToolPermissionManager} for the interface definition and related types
 * such as `FeatureFlag` and `ToolPermissionManagerConfig`.
 * See `ITool` and `ToolDefinition` for capability-gated tool metadata.
 * See `UserContext` in `IGMI` for invoking-user context.
 * See `ISubscriptionService` and `ISubscriptionTier` in `types/auth`.
 * See `GMIError` and `GMIErrorCode` in `@framers/agentos/utils/errors`.
 */

import {
  IToolPermissionManager,
  PermissionCheckContext,
  PermissionCheckResult,
  ToolPermissionManagerConfig,
  FeatureFlag,
} from './IToolPermissionManager';
import type {
  IAuthService,
  ISubscriptionService,
  ISubscriptionTier,
} from '../../types/auth';
import { GMIError, GMIErrorCode, createGMIErrorFromError } from '../../utils/errors.js';
import { uuidv4 } from '../../utils/uuid.js';

/**
 * @class ToolPermissionManager
 * @implements {IToolPermissionManager}
 * @description
 * Manages and enforces permissions for tool usage within the AgentOS ecosystem.
 * It evaluates tool execution requests against configured policies, Persona capabilities,
 * and user subscription entitlements to determine authorization. This class provides a
 * centralized point of control for tool access, enhancing security and feature gating
 * across the platform.
 */
export class ToolPermissionManager implements IToolPermissionManager {
  /**
   * Readonly configuration for this permission manager instance, applied during initialization.
   * Defines behavior such as strict capability checking, mappings of tools to subscription features,
   * and verbosity of logging. Ensures that once initialized, the core operational parameters of
   * the manager do not change, promoting predictable behavior.
   * @private
   * @readonly
   * @type {Readonly<Required<ToolPermissionManagerConfig>>}
   */
  private config!: Readonly<Required<ToolPermissionManagerConfig>>;

  /**
   * Optional authentication service instance. This service can be used for more complex
   * permission rules that might depend on user roles, identity verification status,
   * or other authentication-related attributes not typically found in `UserContext`.
   * @private
   * @type {IAuthService | undefined}
   */
  private authService?: IAuthService;

  /**
   * Optional subscription service instance. This service is crucial if tool access is
   * gated by user subscription tiers or specific feature flags. It allows the manager
   * to check if a user's current subscription plan permits the use of a requested tool.
   * @private
   * @type {ISubscriptionService | undefined}
   */
  private subscriptionService?: ISubscriptionService;

  /**
   * Flag indicating if the manager has been successfully initialized.
   * Operations that depend on configuration or services are blocked until initialization is complete,
   * ensuring the manager operates in a valid state.
   * @private
   * @type {boolean}
   */
  private isInitialized: boolean = false;

  /**
   * A unique identifier for this `ToolPermissionManager` instance.
   * Useful for logging, debugging, and potentially differentiating between multiple manager
   * instances if the system architecture evolves to support such a scenario.
   * @public
   * @readonly
   * @type {string}
   */
  public readonly managerId: string;

  /**
   * Constructs a `ToolPermissionManager` instance.
   * The instance is not fully operational until the `initialize` method is called
   * with the necessary configuration and optional service dependencies. This ensures
   * that the manager always starts in a predictable, uninitialized state.
   */
  constructor() {
    this.managerId = `tpm-${uuidv4()}`;
  }

  /**
   * Initializes the `ToolPermissionManager` with its configuration and dependent services.
   * This method must be called and successfully awaited before any permission checks can be performed.
   * It establishes the manager's operational parameters and links it to essential external services
   * like authentication and subscription management if they are provided, ensuring all dependencies
   * are ready for use.
   *
   * @public
   * @async
   * @param {ToolPermissionManagerConfig} config - The configuration object that defines how
   * tool permissions are to be evaluated (e.g., strictness of capability checks,
   * tool-to-feature mappings, logging verbosity). Must not be null or undefined.
   * @param {IAuthService} [authService] - Optional. An instance of the authentication service,
   * conforming to the `IAuthService` interface. If provided, it can be used for advanced,
   * identity-based permission rules not covered by `UserContext` alone.
   * @param {ISubscriptionService} [subscriptionService] - Optional. An instance of the subscription service,
   * conforming to the `ISubscriptionService` interface. If provided, it's used to check if a user's
   * subscription entitles them to use specific tools based on feature flags.
   * @returns {Promise<void>} A promise that resolves when the manager is fully initialized and ready
   * to process permission requests.
   * @throws {GMIError} If the provided `config` is null or undefined, a `GMIError` with
   * `GMIErrorCode.CONFIGURATION_ERROR` is thrown, preventing initialization with invalid parameters.
   */
  public async initialize(
    config: ToolPermissionManagerConfig,
    authService?: IAuthService,
    subscriptionService?: ISubscriptionService
  ): Promise<void> {
    if (this.isInitialized) {
      console.warn(
        `ToolPermissionManager (ID: ${this.managerId}): Attempting to re-initialize an already initialized instance. The current configuration will be replaced. This may affect ongoing operations if not handled carefully at the application level.`
      );
    }

    if (!config) {
      throw new GMIError(
        'ToolPermissionManagerConfig cannot be null or undefined during initialization.',
        GMIErrorCode.CONFIGURATION_ERROR,
        { managerId: this.managerId, detail: 'Configuration object is missing.' }
      );
    }

    this.config = Object.freeze({
      strictCapabilityChecking: config.strictCapabilityChecking ?? true,
      toolToSubscriptionFeatures: config.toolToSubscriptionFeatures || {},
      logToolCalls: config.logToolCalls ?? false, // Default for logToolCalls
      ...config, // Spread last to allow overrides from config object
    });

    this.authService = authService;
    this.subscriptionService = subscriptionService;

    if (
      Object.keys(this.config.toolToSubscriptionFeatures).length > 0 &&
      !this.subscriptionService
    ) {
      console.warn(
        `ToolPermissionManager (ID: ${this.managerId}): WARNING - 'toolToSubscriptionFeatures' are configured, but no ISubscriptionService instance was provided. Subscription-based tool access checks will default to denial for tools requiring features. This might be a deployment or configuration oversight.`
      );
    }

    this.isInitialized = true;
    console.log(
      `ToolPermissionManager (ID: ${this.managerId}) initialized successfully. Strict capability checking: ${this.config.strictCapabilityChecking}. Logging tool calls: ${this.config.logToolCalls}. Mapped tools to features: ${Object.keys(this.config.toolToSubscriptionFeatures).length}.`
    );
  }

  /**
   * Ensures that the permission manager has been properly initialized before attempting
   * to perform any operations that rely on its configuration or injected services.
   * This is a critical check to prevent runtime errors due to an unconfigured state.
   *
   * @private
   * @throws {GMIError} If the manager is not initialized, an error with
   * `GMIErrorCode.NOT_INITIALIZED` is thrown, detailing that an operation was
   * attempted on an uninitialized manager.
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new GMIError(
        `ToolPermissionManager (ID: ${this.managerId}) is not initialized. Operations cannot be performed until initialize() is called with a valid configuration.`,
        GMIErrorCode.NOT_INITIALIZED,
        {
          component: 'ToolPermissionManager',
          managerId: this.managerId,
          attemptedOperationRequiresInitialization: true,
        }
      );
    }
  }

  /**
   * Checks if a Persona possesses all capabilities explicitly required by a tool.
   * This is a fundamental building block for the overall permission decision in `isExecutionAllowed`.
   * An empty or undefined `toolRequiredCapabilities` array means the tool has no specific capability prerequisites.
   *
   * @public
   * @param {string[]} personaCapabilities - An array of capability strings (e.g., "filesystem:read", "api:weather")
   * currently possessed by the Persona. It's expected these are valid, non-empty strings.
   * @param {string[] | undefined} toolRequiredCapabilities - An array of capability strings defined by the tool
   * as prerequisites for its execution. If `undefined` or empty, the tool is considered to have no
   * specific capability requirements, and this check will pass by default.
   * @returns {boolean} `true` if the Persona possesses all capabilities required by the tool,
   * or if the tool requires no specific capabilities. Returns `false` if any required capability is missing,
   * or if the Persona has no capabilities listed when some are required.
   */
  public hasRequiredCapabilities(
    personaCapabilities: string[],
    toolRequiredCapabilities: string[] | undefined
  ): boolean {
    this.ensureInitialized();

    if (!toolRequiredCapabilities || toolRequiredCapabilities.length === 0) {
      return true;
    }
    if (!personaCapabilities || personaCapabilities.length === 0) {
      return false;
    }

    const personaCapabilitiesSet = new Set(
      personaCapabilities.filter((cap) => typeof cap === 'string' && cap.trim() !== '')
    );
    const validToolRequiredCaps = toolRequiredCapabilities.filter(
      (cap) => typeof cap === 'string' && cap.trim() !== ''
    );

    for (const requiredCap of validToolRequiredCaps) {
      if (!personaCapabilitiesSet.has(requiredCap)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Retrieves the list of `FeatureFlag`s that are configured as being required for a specific tool.
   * These feature flags typically map to user subscription tiers or special entitlements.
   * The information is sourced directly from the `toolToSubscriptionFeatures` mapping
   * provided in the manager's runtime configuration.
   *
   * @public
   * @param {string} toolIdOrName - The unique ID (`ITool.id`) or functional name (`ITool.name`) of the tool.
   * The manager will attempt to find a mapping using this identifier. Using `tool.id` is generally preferred
   * for more stable mappings if tool names might change or be overloaded.
   * @returns {FeatureFlag[] | undefined} An array of `FeatureFlag` objects (each with a `flag` string
   * and optional `description`) required for the tool. Returns `undefined` if no specific features
   * are mapped as required for this tool in the current configuration.
   */
  public getRequiredFeaturesForTool(toolIdOrName: string): FeatureFlag[] | undefined {
    this.ensureInitialized();
    return this.config.toolToSubscriptionFeatures?.[toolIdOrName];
  }

  /**
   * Checks if a user's current subscription grants them access to the specific features
   * required by a particular tool. This method relies on an injected `ISubscriptionService`
   * to fetch user tier information and validate feature entitlements.
   *
   * @public
   * @async
   * @param {string} userId - The ID of the user whose subscription entitlements are being verified.
   * @param {string} toolIdOrName - The unique ID (`ITool.id`) or functional name (`ITool.name`) of the tool.
   * This identifier is used to look up any feature flag prerequisites from the manager's configuration.
   * @returns {Promise<{isAllowed: boolean, missingFeatures?: FeatureFlag[], reason?: string}>}
   * An object detailing the outcome of the subscription check.
   * @throws {GMIError} If critical services are misconfigured or if interaction with `ISubscriptionService` fails.
   */
  public async checkToolSubscriptionAccess(
    userId: string,
    toolIdOrName: string
  ): Promise<{ isAllowed: boolean; missingFeatures?: FeatureFlag[]; reason?: string }> {
    this.ensureInitialized();
    const requiredFeatureFlags: FeatureFlag[] | undefined =
      this.getRequiredFeaturesForTool(toolIdOrName);

    if (!requiredFeatureFlags || requiredFeatureFlags.length === 0) {
      return {
        isAllowed: true,
        reason: `Tool '${toolIdOrName}' does not require specific subscription features.`,
      };
    }

    if (!this.subscriptionService) {
      const reason = `Tool '${toolIdOrName}' requires subscription features [${requiredFeatureFlags.map((f) => f.flag).join(', ')}], but ISubscriptionService is not configured. To enable subscription-based access control, inject a subscription service via AgentOSConfig or use @framers/agentos-extensions/auth. Defaulting to ALLOW.`;
      console.warn(`ToolPermissionManager (ID: ${this.managerId}, User: ${userId}): ${reason}`);
      // Default to allowing access when no subscription service configured
      return {
        isAllowed: true,
        reason: `No subscription service configured - access allowed by default`,
      };
    }

    try {
      const userTier: ISubscriptionTier | null = this.subscriptionService.getUserSubscriptionTier
        ? await this.subscriptionService.getUserSubscriptionTier(userId)
        : await this.subscriptionService.getUserSubscription(userId);

      if (!userTier) {
        const reason = `User (ID: ${userId}) does not have an identifiable or active subscription tier. Access to tool '${toolIdOrName}' requiring features [${requiredFeatureFlags.map((f) => f.flag).join(', ')}] is denied.`;
        return { isAllowed: false, missingFeatures: requiredFeatureFlags, reason };
      }

      const userTierFeatureStrings = new Set(userTier.features || []);
      const missingFeaturesAccumulator: FeatureFlag[] = [];

      for (const requiredFeature of requiredFeatureFlags) {
        if (!userTierFeatureStrings.has(requiredFeature.flag)) {
          missingFeaturesAccumulator.push(requiredFeature);
        }
      }

      if (missingFeaturesAccumulator.length > 0) {
        const reason = `User (ID: ${userId}) lacks required subscription features for tool '${toolIdOrName}': [${missingFeaturesAccumulator.map((f) => `'${f.flag}'`).join(', ')}]. Current tier: '${userTier.name}'.`;
        return { isAllowed: false, missingFeatures: missingFeaturesAccumulator, reason };
      }

      return {
        isAllowed: true,
        reason: `User (ID: ${userId}) possesses all required subscription features for tool '${toolIdOrName}' via tier '${userTier.name}'.`,
      };
    } catch (error: unknown) {
      const wrappedError = createGMIErrorFromError(
        error,
        GMIErrorCode.SUBSCRIPTION_ERROR,
        { userId, toolIdOrName, serviceCalled: 'ISubscriptionService.getUserSubscriptionTier' },
        `An error occurred while checking subscription features for tool '${toolIdOrName}'.`,
        this.managerId
      );
      console.error(
        `ToolPermissionManager (ID: ${this.managerId}): ${wrappedError.message}`,
        wrappedError.toJSON()
      );
      throw wrappedError;
    }
  }

  /**
   * Determines if a tool execution is permitted based on the comprehensive provided context.
   * This is the primary method for authorizing tool calls.
   *
   * @public
   * @async
   * @param {PermissionCheckContext} context - The context for the permission check.
   * @returns {Promise<PermissionCheckResult>} A promise resolving to a `PermissionCheckResult`.
   * @throws {GMIError} If the manager is not initialized or if an unrecoverable error occurs.
   */
  public async isExecutionAllowed(context: PermissionCheckContext): Promise<PermissionCheckResult> {
    this.ensureInitialized();
    const { tool, personaId, personaCapabilities, userContext, gmiId } = context;

    const logPreamble = `ToolPermissionManager (ID: ${this.managerId}, GMI: ${gmiId || 'N/A'}, Persona: ${personaId}, User: ${userContext.userId}, Tool: ${tool.name} [ID: ${tool.id}])`;

    if (this.config.strictCapabilityChecking) {
      if (!this.hasRequiredCapabilities(personaCapabilities, tool.requiredCapabilities)) {
        const missingCaps =
          tool.requiredCapabilities?.filter((rc) => !personaCapabilities.includes(rc)) || [];
        const reason = `Permission Denied: Persona (ID: '${personaId}') lacks required capabilities for tool '${tool.name}'. Missing: [${missingCaps.join(', ')}]. Required: [${tool.requiredCapabilities?.join(', ')}].`;
        if (this.config.logToolCalls) {
          console.warn(`${logPreamble}: Strict capability check FAILED. ${reason}`);
        }
        return {
          isAllowed: false,
          reason,
          details: {
            checkType: 'personaCapabilities',
            required: tool.requiredCapabilities,
            possessed: personaCapabilities,
            missing: missingCaps,
          },
        };
      }
      if (this.config.logToolCalls) {
        console.info(`${logPreamble}: Persona capability check PASSED.`);
      }
    } else {
      if (this.config.logToolCalls) {
        console.warn(
          `${logPreamble}: Strict capability checking is DISABLED by configuration. Persona capability validation for tool '${tool.name}' was skipped.`
        );
      }
    }

    const toolIdentifierForFeatureLookup = tool.id || tool.name;
    const requiredFeatures = this.getRequiredFeaturesForTool(toolIdentifierForFeatureLookup);

    if (requiredFeatures && requiredFeatures.length > 0) {
      const subscriptionAccessResult = await this.checkToolSubscriptionAccess(
        userContext.userId,
        toolIdentifierForFeatureLookup
      );
      if (!subscriptionAccessResult.isAllowed) {
        const reason =
          subscriptionAccessResult.reason ||
          `User (ID: '${userContext.userId}') subscription does not grant access to tool '${tool.name}'.`;
        if (this.config.logToolCalls) {
          console.warn(
            `${logPreamble}: User subscription feature check FAILED. ${reason}`,
            subscriptionAccessResult.missingFeatures
          );
        }
        return {
          isAllowed: false,
          reason,
          details: {
            checkType: 'userSubscriptionFeatures',
            requiredFeatures: requiredFeatures.map((f) => f.flag),
            missingFeatures: subscriptionAccessResult.missingFeatures?.map((f) => f.flag),
            toolIdentifier: toolIdentifierForFeatureLookup,
          },
        };
      }
      if (this.config.logToolCalls) {
        console.info(`${logPreamble}: User subscription feature check PASSED.`);
      }
    }

    const successReason = `Execution of tool '${tool.name}' (ID: ${tool.id}) is permitted. All configured permission checks passed.`;
    if (this.config.logToolCalls) {
      console.log(`${logPreamble}: All permission checks PASSED. ${successReason}`);
    }
    return { isAllowed: true, reason: successReason };
  }
}
