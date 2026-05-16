/**
 * @fileoverview This file implements the GMIManager (Generalized Mind Instance Manager),
 * a crucial component in AgentOS responsible for the lifecycle management of GMIs.
 * @module backend/agentos/cognitive_substrate/GMIManager
 */

import { uuidv4 } from '../../core/utils/uuid';
import { IGMI, GMIBaseConfig, ReasoningEntryType } from './IGMI';
import { GMI } from './GMI';
import { IPersonaDefinition } from './personas/IPersonaDefinition';
import { 
  validatePersonas, 
  formatAggregateReport, 
  PersonaValidationOptions,
  PersonaValidationStrictConfig,
  LoadedPersonaRecord,
  applyStrictMode
} from './personas/PersonaValidation';
import { IPersonaLoader, PersonaLoaderConfig } from './personas/IPersonaLoader';
import { PersonaLoader } from './personas/PersonaLoader';
import type { IAuthService, ISubscriptionService, ISubscriptionTier } from '../../core/types/auth';
import { InMemoryWorkingMemory } from './memory/InMemoryWorkingMemory';
import { ConversationManager } from '../../core/conversation/ConversationManager';
import { ConversationContext } from '../../core/conversation/ConversationContext';
import { GMIError, GMIErrorCode, createGMIErrorFromError } from '../../core/utils/errors.js';
import { IPromptEngine } from '../../core/llm/IPromptEngine';
import { AIModelProviderManager } from '../../core/llm/providers/AIModelProviderManager';
import { IUtilityAI } from '../nlp/ai_utilities/IUtilityAI';
import { IToolOrchestrator } from '../../core/tools/IToolOrchestrator';
import { IRetrievalAugmentor } from '../rag/IRetrievalAugmentor';
import { PersonaOverlayManager } from './persona_overlays/PersonaOverlayManager';
import type { PersonaStateOverlay, PersonaEvolutionContext } from './persona_overlays/PersonaOverlayTypes';
import { resolveSecretForProvider } from '../../core/config/extensionSecrets';
import type { PersonaEvolutionRule } from '../../orchestration/workflows/WorkflowTypes';
import type { ICognitiveMemoryManager } from '../memory/CognitiveMemoryManager.js';

/**
 * Custom error class for GMIManager-specific operational errors.
 */
export class GMIManagerError extends GMIError {
  constructor(message: string, code: GMIErrorCode | string, details?: any) {
    super(message, code as GMIErrorCode, details);
    this.name = 'GMIManagerError';
    Object.setPrototypeOf(this, GMIManagerError.prototype);
  }
}

/**
 * Configuration options for the GMIManager.
 */
export interface GMIManagerConfig {
  personaLoaderConfig: PersonaLoaderConfig;
  defaultGMIInactivityCleanupMinutes?: number;
  defaultWorkingMemoryType?: 'in_memory' | string;
  defaultGMIBaseConfigDefaults?: Partial<Pick<GMIBaseConfig, 'defaultLlmProviderId' | 'defaultLlmModelId' | 'customSettings'>>;
  /** Strict validation enforcement configuration (optional, defaults to permissive). */
  personaValidationStrict?: PersonaValidationStrictConfig;
  /** Optional per-GMI cognitive memory factory used by devtools and advanced runtimes. */
  cognitiveMemoryFactory?: GMICognitiveMemoryFactory;
}

export interface GMICognitiveMemoryFactoryInput {
  gmiInstanceId: string;
  sessionId: string;
  userId: string;
  persona: IPersonaDefinition;
  workingMemory: InMemoryWorkingMemory;
  llmProviderManager: AIModelProviderManager;
  utilityAI: IUtilityAI;
  toolOrchestrator: IToolOrchestrator;
  retrievalAugmentor?: IRetrievalAugmentor;
}

export type GMICognitiveMemoryFactory = (
  input: GMICognitiveMemoryFactoryInput,
) => Promise<ICognitiveMemoryManager | undefined> | ICognitiveMemoryManager | undefined;

/**
 * Options supplied when instantiating a GMI for an Agency seat.
 */
export interface GMIAgencyContextOptions {
  agencyId: string;
  roleId: string;
  workflowId?: string;
  evolutionRules?: PersonaEvolutionRule[];
  evolutionContext?: PersonaEvolutionContext;
}

/**
 * Manages the lifecycle of Generalized Mind Instances (GMIs).
 */
export class GMIManager {
  private config!: Required<Omit<GMIManagerConfig, 'defaultGMIBaseConfigDefaults' | 'personaValidationStrict' | 'cognitiveMemoryFactory'>> &
    Pick<GMIManagerConfig, 'defaultGMIBaseConfigDefaults' | 'personaValidationStrict' | 'cognitiveMemoryFactory'>;
  private personaLoader: IPersonaLoader;
  private allPersonaDefinitions: Map<string, IPersonaDefinition>;
  private allPersonaRecords: Map<string, LoadedPersonaRecord>;
  public activeGMIs: Map<string, IGMI>;
  public gmiSessionMap: Map<string, string>;
  private readonly personaOverlayManager: PersonaOverlayManager;
  private readonly agencySeatOverlays: Map<string, PersonaStateOverlay>;

  private authService?: IAuthService;
  private subscriptionService?: ISubscriptionService;
  private conversationManager: ConversationManager;

  private promptEngine: IPromptEngine;
  private llmProviderManager: AIModelProviderManager;
  private utilityAI: IUtilityAI;
  private toolOrchestrator: IToolOrchestrator;
  private retrievalAugmentor?: IRetrievalAugmentor;

  private isInitialized: boolean = false;
  public readonly managerId: string;

  constructor(
    config: GMIManagerConfig,
    subscriptionService: ISubscriptionService | undefined,
    authService: IAuthService | undefined,
    conversationManager: ConversationManager,
    promptEngine: IPromptEngine,
    llmProviderManager: AIModelProviderManager,
    utilityAI: IUtilityAI,
    toolOrchestrator: IToolOrchestrator,
    retrievalAugmentor?: IRetrievalAugmentor,
    personaLoader?: IPersonaLoader,
  ) {
    this.managerId = `gmi-manager-${uuidv4()}`;
    if (!config || !config.personaLoaderConfig) {
      throw new GMIManagerError('Invalid GMIManager configuration: personaLoaderConfig is required.', GMIErrorCode.CONFIGURATION_ERROR, { providedConfig: config });
    }
    
    this.config = {
      personaLoaderConfig: config.personaLoaderConfig,
      defaultGMIInactivityCleanupMinutes: config.defaultGMIInactivityCleanupMinutes ?? 60,
      defaultWorkingMemoryType: config.defaultWorkingMemoryType ?? 'in_memory',
      defaultGMIBaseConfigDefaults: config.defaultGMIBaseConfigDefaults,
      personaValidationStrict: config.personaValidationStrict,
      cognitiveMemoryFactory: config.cognitiveMemoryFactory,
    };

    this.subscriptionService = subscriptionService;
    this.authService = authService;
    this.conversationManager = conversationManager;
    this.promptEngine = promptEngine;
    this.llmProviderManager = llmProviderManager;
    this.utilityAI = utilityAI;
    this.toolOrchestrator = toolOrchestrator;
    this.retrievalAugmentor = retrievalAugmentor;
    this.personaLoader = personaLoader || new PersonaLoader();
    this.allPersonaDefinitions = new Map();
    this.allPersonaRecords = new Map();
    this.activeGMIs = new Map();
    this.gmiSessionMap = new Map();
    this.personaOverlayManager = new PersonaOverlayManager();
    this.agencySeatOverlays = new Map();

    this.validateGMIDependencies();
  }

  private validateGMIDependencies(): void {
    const check = (service: any, name: string, code: GMIErrorCode = GMIErrorCode.DEPENDENCY_ERROR) => {
        if (!service) throw new GMIManagerError(`${name} dependency is missing.`, code, { service: name });
    };
    check(this.conversationManager, 'ConversationManager');
    check(this.promptEngine, 'IPromptEngine');
    check(this.llmProviderManager, 'AIModelProviderManager');
    check(this.utilityAI, 'IUtilityAI');
    check(this.toolOrchestrator, 'IToolOrchestrator');
  }

  private getAgencySeatKey(agencyId: string, roleId: string): string {
    return `${agencyId}::${roleId}`;
  }

  public clearAgencyPersonaOverlay(agencyId: string, roleId: string): void {
    const key = this.getAgencySeatKey(agencyId, roleId);
    this.agencySeatOverlays.delete(key);
  }

  public getAgencyPersonaOverlay(agencyId: string, roleId: string): PersonaStateOverlay | undefined {
    return this.agencySeatOverlays.get(this.getAgencySeatKey(agencyId, roleId));
  }

  private resolvePersonaWithAgencyOverlay(
    persona: IPersonaDefinition,
    agencyOptions?: GMIAgencyContextOptions,
  ): { persona: IPersonaDefinition; overlay?: PersonaStateOverlay; overlayChanged: boolean } {
    if (!agencyOptions?.agencyId || !agencyOptions.roleId) {
      return { persona, overlay: undefined, overlayChanged: false };
    }

    const key = this.getAgencySeatKey(agencyOptions.agencyId, agencyOptions.roleId);
    const existingOverlay = this.agencySeatOverlays.get(key);
    let overlayToApply = existingOverlay;
    let overlayChanged = false;

    if (agencyOptions.evolutionRules && agencyOptions.evolutionRules.length > 0) {
      const context: PersonaEvolutionContext = agencyOptions.evolutionContext ?? {
        workflowId: agencyOptions.workflowId ?? 'unknown_workflow',
        agencyId: agencyOptions.agencyId,
        roleId: agencyOptions.roleId,
      };
      const overlay = this.personaOverlayManager.applyRules({
        persona,
        rules: agencyOptions.evolutionRules,
        context,
        previousOverlay: existingOverlay,
      });
      this.agencySeatOverlays.set(key, overlay);
      overlayToApply = overlay;
      overlayChanged =
        !existingOverlay ||
        existingOverlay.appliedRules.join(',') !== overlay.appliedRules.join(',') ||
        JSON.stringify(existingOverlay.patchedDefinition) !== JSON.stringify(overlay.patchedDefinition);
    }

    if (!overlayToApply) {
      return { persona, overlay: undefined, overlayChanged: false };
    }

    const resolved = this.personaOverlayManager.resolvePersona(persona, overlayToApply);
    return { persona: resolved, overlay: overlayToApply, overlayChanged };
  }

  private async resolveUserTier(userId: string): Promise<ISubscriptionTier | null> {
    if (!userId || userId === 'anonymous_user') {
      return null;
    }
    if (!this.subscriptionService) {
      return null;
    }
    return this.subscriptionService.getUserSubscription(userId);
  }

  private async resolveTierByName(tierName: string): Promise<ISubscriptionTier | null> {
    if (!tierName || !this.subscriptionService) {
      return null;
    }
    if (this.subscriptionService.listTiers) {
      const tiers = await this.subscriptionService.listTiers();
      return tiers.find(tier => tier.name === tierName) ?? null;
    }
    return null;
  }

  private async userMeetsPersonaTier(userId: string, persona: IPersonaDefinition): Promise<boolean> {
    if (process.env.AGENTOS_DEV_ALLOW_ALL === 'true' || process.env.NODE_ENV === 'development') {
      return true;
    }
    if (!persona.minSubscriptionTier) {
      return true;
    }
    // If no subscription service configured, allow all personas by default
    if (!this.subscriptionService) {
      console.warn(`[GMIManager] Persona '${persona.id}' requires tier '${persona.minSubscriptionTier}', but no subscription service is configured. Allowing access by default. Use @framers/agentos-extensions/auth to enable tier-based access.`);
      return true;
    }
    const userTier = await this.resolveUserTier(userId);
    if (!userTier) {
      return false;
    }
    const requiredTier = await this.resolveTierByName(persona.minSubscriptionTier);
    if (requiredTier) {
      return userTier.level >= requiredTier.level;
    }
    return userTier.name === persona.minSubscriptionTier;
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.warn(`GMIManager (ID: ${this.managerId}) already initialized. Re-initializing persona definitions.`);
      this.allPersonaDefinitions.clear();
    }
    try {
      await this.personaLoader.initialize(this.config.personaLoaderConfig);
      await this.loadAllPersonaDefinitions();
    } catch (error: any) {
      throw createGMIErrorFromError(error, GMIErrorCode.GMI_INITIALIZATION_ERROR, undefined, `GMIManager (ID: ${this.managerId}) initialization failed during persona loading.`);
    }
    this.isInitialized = true;
    console.log(`GMIManager (ID: ${this.managerId}) initialized. ${this.allPersonaDefinitions.size} persona definitions loaded.`);
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new GMIManagerError(`GMIManager (ID: ${this.managerId}) is not initialized. Call initialize() first.`, GMIErrorCode.NOT_INITIALIZED);
    }
  }

  public async loadAllPersonaDefinitions(): Promise<void> {
    if (this.isInitialized) console.log(`GMIManager (ID: ${this.managerId}): Refreshing persona definitions...`);
    try {
      const loadedDefs = await this.personaLoader.loadAllPersonaDefinitions();
      this.allPersonaDefinitions.clear();
      loadedDefs.forEach(persona => {
        if (persona && persona.id) {
          this.allPersonaDefinitions.set(persona.id, persona);
        } else {
          console.warn(`GMIManager (ID: ${this.managerId}): Encountered an invalid persona definition (missing ID or null) during load. Skipping.`);
        }
      });
      console.log(`GMIManager (ID: ${this.managerId}): Successfully loaded/refreshed ${this.allPersonaDefinitions.size} persona definitions.`);

      // Persona validation integration hook
      try {
        let knownToolIds: Set<string> | undefined;
        if (this.toolOrchestrator && typeof this.toolOrchestrator.listAvailableTools === 'function') {
          try {
            const availableTools = await this.toolOrchestrator.listAvailableTools();
            knownToolIds = new Set(
              availableTools.flatMap((tool: any) => {
                const identifiers: string[] = [];
                if (typeof tool.name === 'string' && tool.name.trim().length > 0) {
                  identifiers.push(tool.name.trim());
                }
                const maybeId = typeof tool.id === 'string' ? tool.id.trim() : undefined;
                if (maybeId && maybeId.length > 0) {
                  identifiers.push(maybeId);
                }
                return identifiers;
              }),
            );
          } catch (toolListError) {
            console.warn(
              `GMIManager (ID: ${this.managerId}): Failed to enumerate registered tools for persona validation.`,
              toolListError,
            );
          }
        }

        const validationOpts: PersonaValidationOptions = {
          knownToolIds,
          reservedPersonaIds: new Set(['system_admin','internal_default']),
          maxSystemPromptLength: 4000,
          maxSystemPromptTokens: 2000,
          tokenEstimator: (text: string) => this.promptEngine.estimateTokenCount(text)
        };
        const personaArray = Array.from(this.allPersonaDefinitions.values());
        const report = await validatePersonas(personaArray, validationOpts);

        // Apply strict mode classification
        const strictConfig: PersonaValidationStrictConfig = this.config.personaValidationStrict || { enabled: false };
        const personaRecords = applyStrictMode(personaArray, report.results, strictConfig);

        // Store enriched records
        this.allPersonaRecords.clear();
        personaRecords.forEach(record => {
          this.allPersonaRecords.set(record.definition.id, record);
        });

        // Count invalid personas
        const invalidCount = personaRecords.filter(r => r.status === 'invalid').length;
        const degradedCount = personaRecords.filter(r => r.status === 'degraded').length;

        // Logging based on strict mode
        if (strictConfig.enabled && strictConfig.shadowMode) {
          console.warn(`GMIManager (ID: ${this.managerId}): STRICT SHADOW MODE - ${invalidCount} personas would be blocked (not enforced): ${personaRecords.filter(r => r.status === 'invalid').map(r => r.definition.id).join(', ')}`);
        } else if (strictConfig.enabled && !strictConfig.shadowMode) {
          if (invalidCount > 0) {
            console.error(`GMIManager (ID: ${this.managerId}): STRICT MODE ACTIVE - ${invalidCount} personas blocked from activation: ${personaRecords.filter(r => r.status === 'invalid').map(r => r.definition.id).join(', ')}`);
          }
          if (strictConfig.mode === 'load_block' && invalidCount > 0) {
            console.error(`GMIManager (ID: ${this.managerId}): load_block mode: invalid personas excluded from registry.`);
          }
        }

        if (report.totals.errors > 0) {
          console.error(`GMIManager (ID: ${this.managerId}): Persona validation found ${report.totals.errors} errors, ${invalidCount} invalid, ${degradedCount} degraded.`);
        } else {
          console.log(`GMIManager (ID: ${this.managerId}): Persona validation passed with ${report.totals.warnings} warnings, ${report.totals.suggestions} suggestions.`);
        }

        // Detailed report at debug level
        const formatted = formatAggregateReport(report);
        if (report.totals.errors > 0 || report.totals.warnings > 0) {
          formatted.split('\n').forEach(line => console.debug(line));
        }
      } catch (e: any) {
        console.warn(`GMIManager (ID: ${this.managerId}): Persona validation encountered an unexpected error: ${e.message || e}`);
      }
    } catch (error: any) {
      console.error(`GMIManager (ID: ${this.managerId}): Error loading persona definitions: ${error.message}`, error);
      throw createGMIErrorFromError(error, GMIErrorCode.PERSONA_LOAD_ERROR, undefined, `Failed to load persona definitions.`);
    }
  }

  public getPersonaDefinition(personaId: string): IPersonaDefinition | undefined {
    this.ensureInitialized();
    return this.allPersonaDefinitions.get(personaId);
  }

  public async listAvailablePersonas(userId?: string): Promise<Partial<IPersonaDefinition>[]> {
    this.ensureInitialized();
    const normalizedUserId = userId ?? 'anonymous_user';
    const availablePersonas: Partial<IPersonaDefinition>[] = [];
    const strictConfig = this.config.personaValidationStrict;
    for (const persona of this.allPersonaDefinitions.values()) {
      const isPublicPersona = persona.isPublic !== false;
      const meetsTierRequirement = await this.userMeetsPersonaTier(normalizedUserId, persona);
      
      // Strict load_block mode: exclude invalid personas from listing
      if (strictConfig?.enabled && strictConfig.mode === 'load_block' && !strictConfig.shadowMode) {
        const record = this.allPersonaRecords.get(persona.id);
        if (record?.status === 'invalid') {
          continue; // skip invalid personas in load_block mode
        }
      }
      
      if (isPublicPersona && meetsTierRequirement) {
        availablePersonas.push(this.stripSensitivePersonaData(persona));
      }
    }
    return availablePersonas;
  }

  private stripSensitivePersonaData(persona: IPersonaDefinition): Partial<IPersonaDefinition> {
    const {
      baseSystemPrompt: _baseSystemPrompt,
      defaultModelId: _defaultModelId,
      defaultProviderId: _defaultProviderId,
      defaultModelCompletionOptions: _defaultModelCompletionOptions,
      promptEngineConfigOverrides: _promptEngineConfigOverrides,
      embeddedTools: _embeddedTools,
      metaPrompts: _metaPrompts,
      initialMemoryImprints: _initialMemoryImprints,
      contextualPromptElements: _contextualPromptElements,
      ...publicPersonaData
    } = persona;

    const stripped: Partial<IPersonaDefinition> = {
      ...publicPersonaData,
      toolIds: persona.toolIds,
      allowedCapabilities: persona.allowedCapabilities,
      memoryConfig: persona.memoryConfig ? {
        enabled: persona.memoryConfig.enabled,
        ragConfig: persona.memoryConfig.ragConfig ? { enabled: persona.memoryConfig.ragConfig.enabled } : undefined,
      } : undefined,
    };

    const requiredSecrets = this.deriveRequiredSecretsForPersona(persona);
    if (requiredSecrets?.length) {
      stripped.requiredSecrets = requiredSecrets;
    }

    return stripped;
  }

  private deriveRequiredSecretsForPersona(persona: IPersonaDefinition): string[] | undefined {
    const secretIds = new Set<string>();
    persona.modelTargetPreferences?.forEach((preference) => {
      const secretId =
        resolveSecretForProvider(preference.providerId) ??
        resolveSecretForProvider(preference.modelId?.split('/')?.[0]);
      if (secretId) {
        secretIds.add(secretId);
      }
    });
    return secretIds.size ? Array.from(secretIds) : undefined;
  }

  private async assembleGMIBaseConfig(
    persona: IPersonaDefinition,
    runtimeContext: { gmiInstanceId: string; sessionId: string; userId: string },
  ): Promise<GMIBaseConfig> {
    const workingMemory = new InMemoryWorkingMemory();
    let cognitiveMemory: ICognitiveMemoryManager | undefined;

    if (this.config.cognitiveMemoryFactory) {
      try {
        cognitiveMemory = await this.config.cognitiveMemoryFactory({
          ...runtimeContext,
          persona,
          workingMemory,
          llmProviderManager: this.llmProviderManager,
          utilityAI: this.utilityAI,
          toolOrchestrator: this.toolOrchestrator,
          retrievalAugmentor: this.retrievalAugmentor,
        });
      } catch (error: any) {
        console.warn(
          `GMIManager (ID: ${this.managerId}): Failed to initialize cognitive memory for GMI ${runtimeContext.gmiInstanceId}.`,
          error?.message ?? error,
        );
      }
    }

    return {
      workingMemory,
      promptEngine: this.promptEngine,
      llmProviderManager: this.llmProviderManager,
      utilityAI: this.utilityAI,
      toolOrchestrator: this.toolOrchestrator,
      retrievalAugmentor: this.retrievalAugmentor,
      cognitiveMemory,
      defaultLlmProviderId: persona.defaultProviderId || this.config.defaultGMIBaseConfigDefaults?.defaultLlmProviderId,
      defaultLlmModelId: persona.defaultModelId || this.config.defaultGMIBaseConfigDefaults?.defaultLlmModelId,
      customSettings: persona.customFields,
    };
  }

  public async getOrCreateGMIForSession(
    userId: string,
    sessionId: string,
    requestedPersonaId: string,
    conversationIdInput?: string,
    preferredModelId?: string,
    preferredProviderId?: string,
    userApiKeys?: Record<string, string>,
    agencyOptions?: GMIAgencyContextOptions
  ): Promise<{ gmi: IGMI; conversationContext: ConversationContext }> {
    this.ensureInitialized();

    const personaDefinition = this.getPersonaDefinition(requestedPersonaId);
    if (!personaDefinition) {
      throw new GMIManagerError(`Persona '${requestedPersonaId}' not found.`, GMIErrorCode.PERSONA_NOT_FOUND, { requestedPersonaId });
    }

    // Strict mode activation blocking check
    const personaRecord = this.allPersonaRecords.get(requestedPersonaId);
    const strictConfig = this.config.personaValidationStrict;
    if (strictConfig?.enabled && !strictConfig.shadowMode && personaRecord?.status === 'invalid') {
      throw new GMIManagerError(
        `Persona '${requestedPersonaId}' is invalid and blocked by strict validation. Reasons: ${personaRecord.blockedReasons?.join(', ') || 'unknown'}`,
        GMIErrorCode.PERMISSION_DENIED,
        { requestedPersonaId, blockedReasons: personaRecord.blockedReasons }
      );
    }

    const canAccessPersona = await this.userMeetsPersonaTier(userId, personaDefinition);
    if (!canAccessPersona) {
      throw new GMIManagerError(
        `Access denied: Persona '${requestedPersonaId}' requires tier '${personaDefinition.minSubscriptionTier}'.`,
        GMIErrorCode.PERMISSION_DENIED,
        { requestedPersonaId, userId }
      );
    }

    const { persona: effectivePersona, overlay, overlayChanged } = this.resolvePersonaWithAgencyOverlay(
      personaDefinition,
      agencyOptions,
    );

    let gmiInstanceId = this.gmiSessionMap.get(sessionId);
    let gmi: IGMI | undefined = gmiInstanceId ? this.activeGMIs.get(gmiInstanceId) : undefined;

    if (gmi && (gmi.getPersona().id !== requestedPersonaId || overlayChanged)) {
      console.log(
        `GMIManager (ID: ${this.managerId}): Persona refresh requested for session ${sessionId} (base '${requestedPersonaId}', overlayChanged=${overlayChanged}). Recreating GMI.`,
      );
      await this.deactivateGMIForSession(sessionId);
      gmi = undefined;
      gmiInstanceId = undefined;
    }

    let currentConversationContext: ConversationContext;

    if (gmi && gmiInstanceId) {
      console.log(`GMIManager (ID: ${this.managerId}): Reusing GMI instance ${gmiInstanceId} for session ${sessionId}.`);
      currentConversationContext = await this.conversationManager.getOrCreateConversationContext(
        conversationIdInput || sessionId,
        userId,
        gmiInstanceId,
        personaDefinition.id
      );
    } else {
      const newGmiInstanceId = `gmi-instance-${uuidv4()}`;
      console.log(`GMIManager (ID: ${this.managerId}): Creating new GMI instance ${newGmiInstanceId} for session ${sessionId} with persona ${requestedPersonaId}.`);

      const completeGMIBaseConfig = await this.assembleGMIBaseConfig(effectivePersona, {
        gmiInstanceId: newGmiInstanceId,
        sessionId,
        userId,
      });
      const newGMI = new GMI(newGmiInstanceId);

      try {
        await newGMI.initialize(effectivePersona, completeGMIBaseConfig);
      } catch (error: any) {
        throw createGMIErrorFromError(error, GMIErrorCode.GMI_INITIALIZATION_ERROR, { newGmiInstanceId },`Failed to initialize new GMI instance ${newGmiInstanceId}.`);
      }
      gmi = newGMI;

      this.activeGMIs.set(newGmiInstanceId, gmi);
      this.gmiSessionMap.set(sessionId, newGmiInstanceId);

      currentConversationContext = await this.conversationManager.getOrCreateConversationContext(
        conversationIdInput || sessionId,
        userId,
        newGmiInstanceId,
        personaDefinition.id
      );
    }
    
    if (!gmi) {
        throw new GMIManagerError("Failed to get or create GMI instance unexpectedly.", GMIErrorCode.INTERNAL_SERVER_ERROR, { sessionId, requestedPersonaId });
    }

    if (preferredModelId) currentConversationContext.setMetadata('preferredModelId', preferredModelId);
    if (preferredProviderId) currentConversationContext.setMetadata('preferredProviderId', preferredProviderId);
    if (currentConversationContext.getMetadata('userId') !== userId) currentConversationContext.setMetadata('userId', userId);
    if (currentConversationContext.getMetadata('gmiInstanceId') !== gmi.gmiId) currentConversationContext.setMetadata('gmiInstanceId', gmi.gmiId);
    if (currentConversationContext.getMetadata('activePersonaId') !== gmi.getPersona().id) currentConversationContext.setMetadata('activePersonaId', gmi.getPersona().id);
    if (agencyOptions?.agencyId) {
      currentConversationContext.setMetadata('agencyId', agencyOptions.agencyId);
      currentConversationContext.setMetadata('agencyRoleId', agencyOptions.roleId);
    }
    if (overlay) {
      currentConversationContext.setMetadata('agencyPersonaOverlay', overlay);
    }

    return { gmi, conversationContext: currentConversationContext };
  }

  public getGMIByInstanceId(gmiInstanceId: string): IGMI | undefined {
    this.ensureInitialized();
    return this.activeGMIs.get(gmiInstanceId);
  }

  public async deactivateGMIForSession(sessionId: string): Promise<boolean> {
    this.ensureInitialized();
    const gmiInstanceId = this.gmiSessionMap.get(sessionId);
    if (!gmiInstanceId) {
        console.warn(`GMIManager (ID: ${this.managerId}): No GMI instance ID found for session ${sessionId} during deactivation attempt.`);
        return false;
    }

    const gmi = this.activeGMIs.get(gmiInstanceId);
    if (gmi) {
      console.log(`GMIManager (ID: ${this.managerId}): Deactivating GMI instance ${gmiInstanceId} for session ${sessionId}.`);
      try {
        await gmi.shutdown();
      } catch (error: any) {
        console.error(`GMIManager (ID: ${this.managerId}): Error during gmi.shutdown() for GMI ${gmiInstanceId}: ${error.message}`, error);
      } finally {
        this.activeGMIs.delete(gmiInstanceId);
        this.gmiSessionMap.delete(sessionId);
        console.log(`GMIManager (ID: ${this.managerId}): GMI instance ${gmiInstanceId} (session ${sessionId}) maps removed.`);
      }
      return true;
    } else {
      console.warn(`GMIManager (ID: ${this.managerId}): GMI instance ${gmiInstanceId} for session ${sessionId} was in session map but not active map. Cleaning map.`);
      this.gmiSessionMap.delete(sessionId);
      return false;
    }
  }

  public async cleanupInactiveGMIs(inactivityThresholdMinutes?: number): Promise<number> {
    this.ensureInitialized();
    const threshold = inactivityThresholdMinutes ?? this.config.defaultGMIInactivityCleanupMinutes;
    console.log(`GMIManager (ID: ${this.managerId}): Starting cleanup of GMIs inactive for over ${threshold} minutes.`);
    let cleanedUpCount = 0;
    const now = Date.now();
    const thresholdMs = threshold * 60 * 1000;

    const sessionIdsSnapshot = Array.from(this.gmiSessionMap.keys());

    for (const sessionId of sessionIdsSnapshot) {
      const gmiInstanceId = this.gmiSessionMap.get(sessionId);
      if (!gmiInstanceId) continue;

      const gmi = this.activeGMIs.get(gmiInstanceId);
      if (!gmi) {
        this.gmiSessionMap.delete(sessionId);
        continue;
      }

      try {
        const contextsSummary = await this.conversationManager.listContextsForSession(sessionId);
        let lastActivityOverall = 0;

        if (contextsSummary.length > 0) {
          for (const ctxSummary of contextsSummary) {
            if (!ctxSummary.sessionId) {
              continue;
            }
            const lastActiveTimestamp = await this.conversationManager.getLastActiveTimeForConversation(ctxSummary.sessionId);
            if (lastActiveTimestamp && lastActiveTimestamp > lastActivityOverall) {
              lastActivityOverall = lastActiveTimestamp;
            }
          }
        } else {
          lastActivityOverall = gmi.creationTimestamp.getTime();
        }
        
        if (lastActivityOverall > 0 && (now - lastActivityOverall > thresholdMs)) {
          console.log(`GMIManager (ID: ${this.managerId}): GMI ${gmiInstanceId} (session ${sessionId}) inactive since ${new Date(lastActivityOverall).toISOString()}. Deactivating.`);
          await this.deactivateGMIForSession(sessionId);
          cleanedUpCount++;
        }
      } catch (error: any) {
        console.error(`GMIManager (ID: ${this.managerId}): Error processing GMI ${gmiInstanceId} for session ${sessionId} during cleanup: ${error.message}`, error);
      }
    }

    console.log(`GMIManager (ID: ${this.managerId}): Cleanup finished. ${cleanedUpCount} inactive GMI instances deactivated.`);
    return cleanedUpCount;
  }

  public async shutdown(): Promise<void> {
    console.log(`GMIManager (ID: ${this.managerId}): Initiating shutdown. Deactivating all active GMIs...`);
    this.isInitialized = false;

    const sessionIdsToDeactivate = Array.from(this.gmiSessionMap.keys());
    for (const sessionId of sessionIdsToDeactivate) {
      try {
        await this.deactivateGMIForSession(sessionId);
      } catch (error: any) {
        console.error(`GMIManager (ID: ${this.managerId}): Error deactivating GMI for session ${sessionId} during manager shutdown: ${error.message}`, error);
      }
    }
    
    this.activeGMIs.clear();
    this.gmiSessionMap.clear();
    this.allPersonaDefinitions.clear();
    console.log(`GMIManager (ID: ${this.managerId}): Shutdown complete.`);
  }

  public async processUserFeedback(userId: string, sessionId: string, personaId: string, feedbackData: any): Promise<void> {
    this.ensureInitialized();
    console.log(`GMIManager (ID: ${this.managerId}): Received feedback for User: ${userId}, Session: ${sessionId}, Persona: ${personaId}`, feedbackData);

    const gmiInstanceId = this.gmiSessionMap.get(sessionId);
    const gmi = gmiInstanceId ? this.activeGMIs.get(gmiInstanceId) as GMI | undefined : undefined;

    if (gmi && feedbackData) {
      const rating = feedbackData.rating ?? feedbackData.score;
      const isPositive = typeof rating === 'number' ? rating >= 4 : feedbackData.type === 'positive';
      const feedbackText = feedbackData.comment ?? feedbackData.text ?? '';

      if (isPositive) {
        this.addTraceEntryToRelevantGMI(sessionId, ReasoningEntryType.DEBUG, 'Positive feedback recorded.', { userId, rating, feedbackText });
      } else {
        this.addTraceEntryToRelevantGMI(sessionId, ReasoningEntryType.WARNING, 'Negative feedback recorded — flagged for review.', { userId, rating, feedbackText });
      }

      if ((gmi as any).memoryBridge?.observe) {
        const summary = `User feedback (${isPositive ? 'positive' : 'negative'}${rating != null ? `, rating: ${rating}` : ''}): ${feedbackText}`.trim();
        await (gmi as any).memoryBridge.observe('system', summary);
      }
    } else {
      this.addTraceEntryToRelevantGMI(sessionId, ReasoningEntryType.DEBUG, 'User feedback received by manager.', { userId, feedbackData });
    }
  }

  private addTraceEntryToRelevantGMI(sessionId: string, type: ReasoningEntryType, message: string, details?: Record<string, any>): void {
    const gmiInstanceId = this.gmiSessionMap.get(sessionId);
    if (gmiInstanceId) {
        const gmi = this.activeGMIs.get(gmiInstanceId) as GMI | undefined;
        if (gmi && typeof (gmi as any)['addTraceEntry'] === 'function') {
            const entryDetails = details ?? {};
            (gmi as any)['addTraceEntry'](type, message, entryDetails);
        }
    }
  }
}
