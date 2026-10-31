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
import type { IPromptEngine, PromptEngineConfig } from '../../core/llm/IPromptEngine';
import { PromptEngine } from '../../core/llm/PromptEngine';
import { AIModelProviderManager } from '../../core/llm/providers/AIModelProviderManager';
import { IUtilityAI } from '../nlp/ai_utilities/IUtilityAI';
import { StatisticalUtilityAI } from '../nlp/ai_utilities/StatisticalUtilityAI';
import { IToolOrchestrator } from '../../core/tools/IToolOrchestrator';
import { IRetrievalAugmentor } from '../rag/IRetrievalAugmentor';
import { PersonaOverlayManager } from './persona_overlays/PersonaOverlayManager';
import type { PersonaStateOverlay, PersonaEvolutionContext } from './persona_overlays/PersonaOverlayTypes';
import { resolveSecretForProvider } from '../../core/config/extensionSecrets';
import type { PersonaEvolutionRule } from '../../orchestration/workflows/WorkflowTypes';
import type { ICognitiveMemoryManager } from '../memory/CognitiveMemoryManager.js';
import { feedbackTraceMessage, normalizeUserFeedback } from './userFeedback';
import { settlesWithin, shutdownTimeoutOrDefault } from './shutdownBound';
import { normalizeHexacoTraits } from './personas/hexaco';
import { normalizePersonaDefinition } from './personas/personaNormalization';
import { traitOverlayPatch } from './personas/personalityPrompt';
import { deferLearnerSession } from '../learning/LearnerSession.js';
import type { ILearnerSession, ILearningLayer, LearnerContext } from '../learning/types.js';

/**
 * How long GMI acquisition waits for the learning layer to open a GMI's learner session, in milliseconds: the budget a
 * GMI gives a turn's preparation. An open that has not answered by then is taken by the GMI's first turn.
 */
const LEARNER_OPEN_BUDGET_MS = 2_000;

/**
 * One open of a learner session, which lives at most `ms`: past it the open fails, so the session asks again at its
 * next turn, and a session the layer gives after that is ended rather than kept.
 */
function openWithin(open: () => Promise<ILearnerSession>, ms: number): Promise<ILearnerSession> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = Promise.resolve().then(open).then(asLearnerSession);
  attempt.then(
    (session) => {
      if (expired) void Promise.resolve().then(() => session.endSession()).catch(() => undefined);
    },
    () => undefined,
  );
  const lifetime = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error(`the learning layer opened no learner session within ${ms} ms`));
    }, ms);
  });
  return Promise.race([attempt, lifetime]).finally(() => clearTimeout(timer));
}

/** A layer's answer as a learner session; an answer that lacks one of a session's calls is a failed open. */
function asLearnerSession(answer: unknown): ILearnerSession {
  const session = answer as Partial<ILearnerSession> | null | undefined;
  if (
    !session ||
    typeof session.prepareTurn !== 'function' ||
    typeof session.endSession !== 'function' ||
    typeof session.currentTraits !== 'function'
  ) {
    throw new Error('the learning layer answered with no learner session');
  }
  return session as ILearnerSession;
}

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
  defaultGMIBaseConfigDefaults?: Partial<Pick<GMIBaseConfig, 'defaultLlmProviderId' | 'defaultLlmModelId' | 'customSettings' | 'defaultReasoningTraceMaxEntries' | 'defaultReasoningTraceMaxMessageLength'>>;
  /** Strict validation enforcement configuration (optional, defaults to permissive). */
  personaValidationStrict?: PersonaValidationStrictConfig;
  /** Optional per-GMI cognitive memory factory used by devtools and advanced runtimes. */
  cognitiveMemoryFactory?: GMICognitiveMemoryFactory;
  /**
   * How long the manager waits for one GMI to shut down, in milliseconds, when
   * it shuts down, deactivates a session or cleans up idle GMIs. A GMI that has
   * not finished by then is logged at warn and finishes on its own while the
   * manager goes on. `shutdown()` shuts every GMI down at the same time, so it
   * takes about one bound however many GMIs are active. Defaults to 8000: inside
   * the 10 seconds `docker stop` waits before it kills a container, and above
   * the 5 seconds a GMI gives its metaprompt work to finish.
   */
  shutdownTimeoutMs?: number;
  /**
   * The runtime's learning layer, when the host turned learning on (`AgentOSConfig.learning`). With it, each GMI
   * the manager builds gets a learner session and the registry persona's traits, and sends the personality
   * section on every turn. Without it the manager builds GMIs as it did before the layer existed.
   */
  learningLayer?: ILearningLayer;
  /**
   * The prompt-engine config of the GMIs `createAgencySeat` builds for the teams a GMI launches (`launch_agency` on the
   * full runtime). Their engine gets no utility AI, so it truncates history and makes no model call. AgentOS sets it
   * from its own `promptEngineConfig` when `agencies` is set.
   */
  agencySeatPromptEngineConfig?: PromptEngineConfig;
}

/** What the manager knows, when it builds a GMI, for the learning layer. */
interface LearningSource {
  /** The registry persona, before any role overlay. */
  registryPersona: IPersonaDefinition;
  /** True for a GMI built for a workflow role (`agencyOptions`): its turns have no learner. */
  workflowSeat: boolean;
  /** The resolved organization of the turn the GMI is built for (`''` for none), when the caller passed it. */
  organizationId?: string;
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
 * One seat of a team a GMI launched on the full runtime (`launch_agency`): what {@link GMIManager.createAgencySeat}
 * builds. The launch passes the views the seat runs through, so the manager imports nothing of the launch.
 */
export interface AgencySeatSpec {
  /**
   * `seat:<agencyId>:<role>`; refused when a GMI already serves it. Until the seat is released no request acquires
   * a GMI in it and no feedback reaches its GMI.
   */
  seatSessionId: string;
  /** The parent turn's user: the seat's tools and the tier check see it. */
  userId: string;
  /** A registered persona, by id (a persistent member), or the definition a launch made for a temporary seat. */
  persona: { personaId: string } | { definition: IPersonaDefinition };
  /** The seat's tool orchestrator: a view the launch makes over the shared one. */
  toolView: (base: IToolOrchestrator) => IToolOrchestrator;
  /** The seat's provider manager: a view the launch makes over the runtime's; the runtime's own when absent. */
  providerManager?: (base: AIModelProviderManager) => AIModelProviderManager;
  /** The seat's step limit; the GMI's default when absent. */
  maxToolLoopIterations?: number;
}

/**
 * Manages the lifecycle of Generalized Mind Instances (GMIs).
 */
export class GMIManager {
  private config!: Required<Omit<GMIManagerConfig, 'defaultGMIBaseConfigDefaults' | 'personaValidationStrict' | 'cognitiveMemoryFactory' | 'learningLayer' | 'agencySeatPromptEngineConfig'>> &
    Pick<GMIManagerConfig, 'defaultGMIBaseConfigDefaults' | 'personaValidationStrict' | 'cognitiveMemoryFactory' | 'learningLayer' | 'agencySeatPromptEngineConfig'>;
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
  /**
   * One promise per getOrCreateGMIForSession() or createAgencySeat() call in
   * flight, resolved when the call returns or throws. shutdown() waits for them.
   */
  private readonly creationsInFlight = new Set<Promise<void>>();
  /**
   * The deactivation running for each session. The GMI it shuts down stays in
   * the maps until its shutdown has ended, so an acquisition for the session
   * waits for it and never hands out a GMI that is shutting down.
   */
  private readonly deactivations = new Map<string, Promise<boolean>>();
  /**
   * The session of each seat createAgencySeat() registered, mapped to the seat's GMI instance id, until the seat is
   * released. A seat's GMI serves its team alone: an acquisition that names one is refused and feedback that names one
   * is not recorded, so a request can neither run a turn on a seat's GMI (its tools, budget and working memory are the
   * team's) nor shut a running seat down by asking for another persona; the idle cleanup passes it by, since its launch
   * releases it.
   */
  private readonly agencySeatSessions = new Map<string, string>();

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
      shutdownTimeoutMs: shutdownTimeoutOrDefault(config.shutdownTimeoutMs),
      learningLayer: config.learningLayer,
      agencySeatPromptEngineConfig: config.agencySeatPromptEngineConfig,
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

  /**
   * What a GMI of a runtime with a learning layer is built with: the registry persona's traits and the role
   * overlay's patch, apart, and the session's learner session. A workflow seat's session has no learner. Any other
   * session is bound to the user the GMI is created for: under the turn's resolved organization when the caller
   * passed it, else under the organization of the GMI's first prepared turn (a GMI built again for a tool-result
   * resume, whose organization is read from the conversation after the GMI is acquired). The open has the budget a
   * turn's preparation has, 2,000 ms. A layer that fails to open the session, answers with something that is not a
   * session, or has not answered by then never fails the GMI: the GMI gets a session that asks again at each turn
   * (its first turn takes an open that answers late), and until one opens each turn has no learner and the GMI
   * renders the persona's traits itself, so its tools refuse rather than act as on a host with no layer. Without a
   * layer the result is empty, and the GMI is built as before the layer existed.
   *
   * @param effectivePersona - The persona the GMI is initialized with: the registry persona, overlay applied.
   * @param runtimeContext - The GMI's id, its session and the user it is created for.
   * @param source - The registry persona, whether the GMI is a workflow seat, and the turn's organization.
   */
  private async assembleLearning(
    effectivePersona: IPersonaDefinition,
    runtimeContext: { gmiInstanceId: string; sessionId: string; userId: string },
    source: LearningSource | undefined,
  ): Promise<Pick<GMIBaseConfig, 'learning' | 'personaTraits'>> {
    const layer = this.config.learningLayer;
    if (!layer || !source) return {};
    const authored = normalizeHexacoTraits(source.registryPersona.personalityTraits);
    // The registry traits as written: an alias the persona writes itself beside its canonical key is no patch.
    const overlay = traitOverlayPatch(source.registryPersona.personalityTraits, effectivePersona.personalityTraits);
    const personaTraits = { authored, ...(overlay ? { overlay } : {}) };
    const context: LearnerContext = {
      sessionId: runtimeContext.sessionId,
      personaId: source.registryPersona.id,
      authoredTraits: authored,
      ...(overlay ? { overlayTraits: overlay } : {}),
    };
    // Each open lives at most shutdownTimeoutMs, as every wait of the manager on a GMI's session does: a layer that
    // stalls is asked again at a later turn, and never holds a turn or a shutdown past the bound.
    const lifetime = this.config.shutdownTimeoutMs;
    const open = (namespace: string): Promise<ILearnerSession> =>
      openWithin(
        () => layer.forLearner({ namespace, agentKey: source.registryPersona.id, userId: runtimeContext.userId }, context),
        lifetime,
      );
    // Without the turn's organization the session opens at the GMI's first prepared turn, under that turn's.
    if (!source.workflowSeat && source.organizationId === undefined) {
      return { learning: deferLearnerSession({ traits: authored, open }), personaTraits };
    }
    const organizationId = (source.organizationId ?? '').trim();
    const openNow = (): Promise<ILearnerSession> =>
      source.workflowSeat
        ? openWithin(() => layer.forLearner(null, { ...context, noLearnerReason: 'workflow_seat' }), lifetime)
        : open(organizationId);
    // The open runs inside GMI acquisition, so it has the budget a turn's preparation has.
    const first = openNow();
    let late: Promise<ILearnerSession> | undefined = first;
    // An open that fails (it rejects, or outlives its lifetime) is no answer for a turn that comes after it: it is
    // dropped once it fails, so the GMI's next turn asks the layer again.
    first.catch(() => {
      if (late === first) late = undefined;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), LEARNER_OPEN_BUDGET_MS);
    });
    try {
      const answer = await Promise.race([late, budget]);
      if (answer !== 'late') return { learning: answer, personaTraits };
      console.warn(
        `GMIManager (ID: ${this.managerId}): The learning layer opened no learner session for GMI ${runtimeContext.gmiInstanceId} within ${LEARNER_OPEN_BUDGET_MS} ms; the GMI's first turn takes the open when it answers, and until a session opens each turn has no learner and the GMI renders the persona's traits itself.`,
      );
    } catch (error: any) {
      late = undefined;
      console.warn(
        `GMIManager (ID: ${this.managerId}): The learning layer gave GMI ${runtimeContext.gmiInstanceId} no learner session; each turn asks again, and until one opens the turn has no learner and the GMI renders the persona's traits itself.`,
        error?.message ?? error,
      );
    } finally {
      clearTimeout(timer);
    }
    // The first attempt of the deferred session is the open still running, if any, so the layer is asked once while
    // that open lives; a GMI that ends before any turn took it ends the session the open gives, when it gives one.
    const takeLate = (): Promise<ILearnerSession> | undefined => {
      const attempt = late;
      late = undefined;
      return attempt;
    };
    // Fail closed: the deferred session rejects while the layer cannot open one, so each such turn runs degraded
    // and tells its tools it has no learner.
    const deferred = deferLearnerSession({ traits: authored, open: () => takeLate() ?? openNow() });
    const learning: ILearnerSession = {
      prepareTurn: (input) => deferred.prepareTurn(input),
      currentTraits: () => deferred.currentTraits(),
      endSession: async () => {
        void takeLate()?.then((session) => session.endSession()).catch(() => undefined);
        await deferred.endSession();
      },
    };
    return { learning, personaTraits };
  }

  private async assembleGMIBaseConfig(
    persona: IPersonaDefinition,
    runtimeContext: { gmiInstanceId: string; sessionId: string; userId: string },
    learningSource?: LearningSource,
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
      defaultReasoningTraceMaxEntries: this.config.defaultGMIBaseConfigDefaults?.defaultReasoningTraceMaxEntries,
      defaultReasoningTraceMaxMessageLength: this.config.defaultGMIBaseConfigDefaults?.defaultReasoningTraceMaxMessageLength,
      customSettings: persona.customFields,
      // A GMI waits as long for the turns its shutdown stops as the manager waits for the GMI.
      shutdownTimeoutMs: this.config.shutdownTimeoutMs,
      ...(await this.assembleLearning(persona, runtimeContext, learningSource)),
    };
  }

  /**
   * The GMI of a session: the one the session has, or a new one built for it. A session that a seat of a team a GMI
   * launched holds (createAgencySeat()) is refused with `PERMISSION_DENIED` until the seat is released.
   *
   * @param turnOrganizationId - The resolved organization of the turn the GMI is acquired for (`''` for none).
   *   With a learning layer a new GMI's learner session is bound under it; a caller that cannot resolve it before
   *   the GMI is acquired leaves it out, and the learner session is bound at the GMI's first prepared turn.
   */
  public async getOrCreateGMIForSession(
    userId: string,
    sessionId: string,
    requestedPersonaId: string,
    conversationIdInput?: string,
    preferredModelId?: string,
    preferredProviderId?: string,
    userApiKeys?: Record<string, string>,
    agencyOptions?: GMIAgencyContextOptions,
    turnOrganizationId?: string,
  ): Promise<{ gmi: IGMI; conversationContext: ConversationContext }> {
    this.ensureInitialized();
    // shutdown() waits for this call to settle; a GMI the call builds once
    // shutdown has begun is shut down instead of registered.
    let settle!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.creationsInFlight.add(inFlight);
    try {
      return await this.resolveGMIForSession(
        userId,
        sessionId,
        requestedPersonaId,
        conversationIdInput,
        preferredModelId,
        preferredProviderId,
        userApiKeys,
        agencyOptions,
        turnOrganizationId,
      );
    } finally {
      this.creationsInFlight.delete(inFlight);
      settle();
    }
  }

  /**
   * The work of getOrCreateGMIForSession(). The manager's initialization is
   * checked again after every wait, so a call that shutdown() overtakes fails
   * with NOT_INITIALIZED; a GMI it built and has not registered yet is shut
   * down first.
   */
  private async resolveGMIForSession(
    userId: string,
    sessionId: string,
    requestedPersonaId: string,
    conversationIdInput?: string,
    preferredModelId?: string,
    preferredProviderId?: string,
    userApiKeys?: Record<string, string>,
    agencyOptions?: GMIAgencyContextOptions,
    turnOrganizationId?: string,
  ): Promise<{ gmi: IGMI; conversationContext: ConversationContext }> {
    // A seat's session serves its team alone, whatever persona the request names: reusing its GMI would run the
    // request on the team's tools, budget and working memory, and a persona refresh would shut the seat down mid-run.
    // It is checked first, and again after each wait in which a seat could take the session.
    const seatSessionRefused = (): GMIManagerError =>
      new GMIManagerError(
        `Session '${sessionId}' is a seat of a team a GMI launched; no request runs in it.`,
        GMIErrorCode.PERMISSION_DENIED,
        { sessionId },
      );
    if (this.agencySeatSessions.has(sessionId)) throw seatSessionRefused();

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
    this.ensureInitialized();
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

    // A GMI being deactivated (a persona refresh, the idle cleanup) stays bound to the session until its shutdown has
    // ended: the acquisition waits for that, so it finds the session without a GMI rather than the GMI shutting down.
    let deactivation = this.deactivations.get(sessionId);
    while (deactivation) {
      await deactivation.catch(() => false);
      this.ensureInitialized();
      deactivation = this.deactivations.get(sessionId);
    }

    if (this.agencySeatSessions.has(sessionId)) throw seatSessionRefused();

    let gmiInstanceId = this.gmiSessionMap.get(sessionId);
    let gmi: IGMI | undefined = gmiInstanceId ? this.activeGMIs.get(gmiInstanceId) : undefined;

    if (gmi && (gmi.getPersona().id !== requestedPersonaId || overlayChanged)) {
      console.log(
        `GMIManager (ID: ${this.managerId}): Persona refresh requested for session ${sessionId} (base '${requestedPersonaId}', overlayChanged=${overlayChanged}). Recreating GMI.`,
      );
      await this.deactivateGMIForSession(sessionId);
      this.ensureInitialized();
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
      // A shutdown that began meanwhile shuts this GMI down with the others.
      this.ensureInitialized();
    } else {
      const newGmiInstanceId = `gmi-instance-${uuidv4()}`;
      console.log(`GMIManager (ID: ${this.managerId}): Creating new GMI instance ${newGmiInstanceId} for session ${sessionId} with persona ${requestedPersonaId}.`);

      const completeGMIBaseConfig = await this.assembleGMIBaseConfig(
        effectivePersona,
        { gmiInstanceId: newGmiInstanceId, sessionId, userId },
        // The registry persona, before any role overlay: the learning layer reads its traits as the authored ones.
        { registryPersona: personaDefinition, workflowSeat: agencyOptions !== undefined, organizationId: turnOrganizationId },
      );
      const newGMI = new GMI(newGmiInstanceId);

      try {
        await newGMI.initialize(effectivePersona, completeGMIBaseConfig);
      } catch (error: any) {
        // The GMI never runs, so the learner session made for it ends here, within shutdownTimeoutMs as a shutdown
        // waits for it; a failure to end it is not the error.
        const ending = Promise.resolve().then(() => completeGMIBaseConfig.learning?.endSession());
        ending.catch(() => undefined);
        const bound = this.config.shutdownTimeoutMs;
        if (!(await settlesWithin(ending, bound).catch(() => true))) {
          console.warn(
            `GMIManager (ID: ${this.managerId}): The learner session of GMI ${newGmiInstanceId}, which failed to initialize, did not end within ${bound} ms; going on without it.`,
          );
        }
        throw createGMIErrorFromError(error, GMIErrorCode.GMI_INITIALIZATION_ERROR, { newGmiInstanceId },`Failed to initialize new GMI instance ${newGmiInstanceId}.`);
      }
      if (!this.isInitialized) {
        // shutdown() began while this GMI was built and will not find it in the
        // maps, so it is shut down here and never registered.
        await this.shutDownGMI(newGMI, newGmiInstanceId, sessionId);
        throw new GMIManagerError(
          `GMIManager (ID: ${this.managerId}) shut down while GMI ${newGmiInstanceId} was being created for session ${sessionId}.`,
          GMIErrorCode.NOT_INITIALIZED,
          { sessionId, gmiInstanceId: newGmiInstanceId },
        );
      }
      if (this.agencySeatSessions.has(sessionId)) {
        // A seat took the session while this GMI was built: it is shut down and never registered.
        await this.shutDownGMI(newGMI, newGmiInstanceId, sessionId);
        throw seatSessionRefused();
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
      // A shutdown that began meanwhile shuts this GMI down with the others.
      this.ensureInitialized();
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
    return this.deactivateSession(sessionId);
  }

  /** The seat GMIs' prompt engine: built once, with no utility AI; a build that fails is not kept. */
  private agencySeatEngine?: Promise<IPromptEngine>;

  private agencySeatPromptEngine(): Promise<IPromptEngine> {
    const config = this.config.agencySeatPromptEngineConfig;
    if (!config) {
      return Promise.reject(
        new GMIManagerError('GMIManagerConfig.agencySeatPromptEngineConfig is not set; AgentOS sets it with agencies.', GMIErrorCode.CONFIGURATION_ERROR),
      );
    }
    this.agencySeatEngine ??= (async () => {
      const engine = new PromptEngine();
      // No utility AI: the engine truncates the history and summarizes nothing, so it makes no model call.
      await engine.initialize(config);
      return engine;
    })().catch((error: unknown) => {
      this.agencySeatEngine = undefined;
      throw error;
    });
    return this.agencySeatEngine;
  }

  /** A seat's persona: the definition a launch made, or a registered one the user may use. */
  private async agencySeatPersona(spec: AgencySeatSpec): Promise<IPersonaDefinition> {
    if ('definition' in spec.persona) return normalizePersonaDefinition(spec.persona.definition);
    const personaId = spec.persona.personaId;
    const persona = this.getPersonaDefinition(personaId);
    if (!persona) {
      throw new GMIManagerError(`Persona '${personaId}' not found.`, GMIErrorCode.PERSONA_NOT_FOUND, { personaId });
    }
    const record = this.allPersonaRecords.get(personaId);
    const strict = this.config.personaValidationStrict;
    if (strict?.enabled && !strict.shadowMode && record?.status === 'invalid') {
      throw new GMIManagerError(`Persona '${personaId}' is invalid and blocked by strict validation.`, GMIErrorCode.PERMISSION_DENIED, { personaId });
    }
    if (!(await this.userMeetsPersonaTier(spec.userId, persona))) {
      throw new GMIManagerError(`Access denied: Persona '${personaId}' requires tier '${persona.minSubscriptionTier}'.`, GMIErrorCode.PERMISSION_DENIED, { personaId, userId: spec.userId });
    }
    return persona;
  }

  /**
   * Builds and registers the GMI of one seat of a team a GMI launched (`launch_agency` on the full runtime): the
   * registered persona a `personaId` seat names, checked as a session's persona is (strict validation, the user's
   * tier), or the definition the launch made for a temporary seat. The GMI has no cognitive memory and no retrieval
   * augmentor (its input is a manager's or a sibling's text), a prompt engine and a statistical utility that
   * make no model call, the tool view and provider manager the launch gives it, and, with the runtime's learning layer,
   * no learner (a workflow seat's source): it still renders its persona's traits, and with the layer off it sends no
   * personality section. It is registered under the seat session id, so its own tool calls resolve it; `release()`
   * shuts it down and takes it out of the manager, and a handle released after the manager shut down leaves alone
   * whatever holds the session since. Until then the session is the seat's:
   * `getOrCreateGMIForSession()` refuses it with `PERMISSION_DENIED`, whatever persona the request names (a request
   * whose GMI was being built when the seat took the session included, that GMI shut down unregistered),
   * `processUserFeedback()` records nothing for it and `cleanupInactiveGMIs()` passes it by. `shutdown()` waits for a
   * seat being built, as it waits for a session's GMI, and the build then fails with its GMI shut down.
   *
   * @throws {GMIManagerError} `PERSONA_NOT_FOUND` for an unknown persona; `PERMISSION_DENIED` for one the user's tier or
   *   strict validation refuses; `INVALID_STATE` for a session that already has a GMI; `CONFIGURATION_ERROR` without
   *   `agencySeatPromptEngineConfig`; `NOT_INITIALIZED` when the manager is not, or shuts down while the seat is built.
   * @throws {GMIError} `GMI_INITIALIZATION_ERROR` when the GMI does not initialize.
   */
  public async createAgencySeat(spec: AgencySeatSpec): Promise<{ gmi: IGMI; personaId: string; release(): Promise<void> }> {
    this.ensureInitialized();
    // shutdown() waits for this build to settle, as it waits for a session's; a GMI the build makes once shutdown has
    // begun is shut down instead of registered.
    let settle!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.creationsInFlight.add(inFlight);
    try {
      return await this.buildAgencySeat(spec);
    } finally {
      this.creationsInFlight.delete(inFlight);
      settle();
    }
  }

  /** The work of {@link GMIManager.createAgencySeat}. */
  private async buildAgencySeat(spec: AgencySeatSpec): Promise<{ gmi: IGMI; personaId: string; release(): Promise<void> }> {
    const taken = (): GMIManagerError =>
      new GMIManagerError(`Session '${spec.seatSessionId}' already has a GMI; a seat runs in a session of its own.`, GMIErrorCode.INVALID_STATE, { sessionId: spec.seatSessionId });
    if (this.gmiSessionMap.has(spec.seatSessionId)) throw taken();
    const persona = await this.agencySeatPersona(spec);
    const promptEngine = await this.agencySeatPromptEngine();
    const gmiInstanceId = `gmi-instance-${uuidv4()}`;
    const utilityAI = new StatisticalUtilityAI(`agency-seat-utility-${gmiInstanceId}`);
    await utilityAI.initialize({ utilityId: `agency-seat-utility-${gmiInstanceId}` });
    const config: GMIBaseConfig = {
      workingMemory: new InMemoryWorkingMemory(),
      promptEngine,
      llmProviderManager: spec.providerManager ? spec.providerManager(this.llmProviderManager) : this.llmProviderManager,
      utilityAI,
      toolOrchestrator: spec.toolView(this.toolOrchestrator),
      defaultLlmProviderId: persona.defaultProviderId || this.config.defaultGMIBaseConfigDefaults?.defaultLlmProviderId,
      defaultLlmModelId: persona.defaultModelId || this.config.defaultGMIBaseConfigDefaults?.defaultLlmModelId,
      defaultReasoningTraceMaxEntries: this.config.defaultGMIBaseConfigDefaults?.defaultReasoningTraceMaxEntries,
      defaultReasoningTraceMaxMessageLength: this.config.defaultGMIBaseConfigDefaults?.defaultReasoningTraceMaxMessageLength,
      customSettings: persona.customFields,
      // A GMI waits as long for the turns its shutdown stops as the manager waits for the GMI.
      shutdownTimeoutMs: this.config.shutdownTimeoutMs,
      ...(spec.maxToolLoopIterations !== undefined ? { maxToolLoopIterations: spec.maxToolLoopIterations } : {}),
      // A workflow seat's source: with a learning layer, the seat's turns have no learner.
      ...(await this.assembleLearning(persona, { gmiInstanceId, sessionId: spec.seatSessionId, userId: spec.userId }, { registryPersona: persona, workflowSeat: true })),
    };
    const gmi = new GMI(gmiInstanceId);
    try {
      await gmi.initialize(persona, config);
    } catch (error: any) {
      // The GMI never runs, so the learner session made for it ends here; a failure to end it is not the error.
      await Promise.resolve()
        .then(() => config.learning?.endSession())
        .catch(() => undefined);
      throw createGMIErrorFromError(error, GMIErrorCode.GMI_INITIALIZATION_ERROR, { gmiInstanceId }, `Failed to initialize the agency seat GMI ${gmiInstanceId}.`);
    }
    if (!this.isInitialized) {
      // shutdown() began while the seat was built: it is shut down here and never registered.
      await this.shutDownGMI(gmi, gmiInstanceId, spec.seatSessionId);
      throw new GMIManagerError(`GMIManager (ID: ${this.managerId}) shut down while the agency seat ${spec.seatSessionId} was being created.`, GMIErrorCode.NOT_INITIALIZED, { sessionId: spec.seatSessionId });
    }
    if (this.gmiSessionMap.has(spec.seatSessionId)) {
      // Another build took the session while this one ran: this GMI is shut down and never registered.
      await this.shutDownGMI(gmi, gmiInstanceId, spec.seatSessionId);
      throw taken();
    }
    this.activeGMIs.set(gmiInstanceId, gmi);
    this.gmiSessionMap.set(spec.seatSessionId, gmiInstanceId);
    this.agencySeatSessions.set(spec.seatSessionId, gmiInstanceId);
    let released: Promise<void> | undefined;
    return {
      gmi,
      personaId: persona.id,
      // Once: a second call waits for the first. It skips the initialization check, so a seat closed while the manager
      // shuts down is still released. The session is the seat's until its GMI is gone.
      release: () => (released ??= this.releaseAgencySeat(spec.seatSessionId, gmiInstanceId, gmi)),
    };
  }

  /**
   * Releases one seat's GMI and then its hold on the session. Only the seat's own GMI and hold go: once the manager has
   * shut down, the session may hold a GMI or a seat that came after it, which stays.
   */
  private async releaseAgencySeat(sessionId: string, gmiInstanceId: string, gmi: IGMI): Promise<void> {
    try {
      if (this.gmiSessionMap.get(sessionId) === gmiInstanceId) {
        await this.deactivateSession(sessionId);
      } else if (this.activeGMIs.get(gmiInstanceId) === gmi) {
        try {
          await this.shutDownGMI(gmi, gmiInstanceId, sessionId);
        } finally {
          this.activeGMIs.delete(gmiInstanceId);
        }
      }
    } finally {
      if (this.agencySeatSessions.get(sessionId) === gmiInstanceId) this.agencySeatSessions.delete(sessionId);
    }
  }

  /**
   * Shuts down the GMI bound to a session and removes it from both maps. It
   * skips the initialization check because `shutdown()` marks the manager
   * uninitialized first, so that no new work starts, and then calls this for
   * every session. A call made while the session's deactivation runs waits for
   * that one, and so does an acquisition for the session
   * (`getOrCreateGMIForSession()`).
   *
   * @param sessionId - The session whose GMI is shut down.
   * @returns `true` when the session had an active GMI, `false` when it had none.
   */
  private deactivateSession(sessionId: string): Promise<boolean> {
    const running = this.deactivations.get(sessionId);
    if (running) return running;
    const deactivation = this.shutDownSessionGMI(sessionId).finally(() => {
      if (this.deactivations.get(sessionId) === deactivation) this.deactivations.delete(sessionId);
    });
    this.deactivations.set(sessionId, deactivation);
    return deactivation;
  }

  /** The work of {@link GMIManager.deactivateSession}, run once at a time for a session. */
  private async shutDownSessionGMI(sessionId: string): Promise<boolean> {
    const gmiInstanceId = this.gmiSessionMap.get(sessionId);
    if (!gmiInstanceId) {
        console.warn(`GMIManager (ID: ${this.managerId}): No GMI instance ID found for session ${sessionId} during deactivation attempt.`);
        return false;
    }

    const gmi = this.activeGMIs.get(gmiInstanceId);
    if (gmi) {
      console.log(`GMIManager (ID: ${this.managerId}): Deactivating GMI instance ${gmiInstanceId} for session ${sessionId}.`);
      try {
        await this.shutDownGMI(gmi, gmiInstanceId, sessionId);
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

  /**
   * Shuts one GMI down and waits for it at most `shutdownTimeoutMs`. A GMI
   * that has not finished by then is logged at warn and finishes on its own; a
   * GMI whose shutdown throws is logged at error. Neither reaches the caller.
   *
   * @param gmi - The GMI to shut down.
   * @param gmiInstanceId - Its instance id, for the log.
   * @param sessionId - The session it serves, for the log.
   */
  private async shutDownGMI(gmi: IGMI, gmiInstanceId: string, sessionId?: string): Promise<void> {
    const logFailure = (error: any): void => {
      console.error(`GMIManager (ID: ${this.managerId}): Error during gmi.shutdown() for GMI ${gmiInstanceId}: ${error?.message}`, error);
    };
    const bound = this.config.shutdownTimeoutMs;
    try {
      // A GMI with a learner session ends it once it has shut down, inside the same bound.
      const learnerSession = typeof gmi.getLearnerSession === 'function' ? gmi.getLearnerSession() : undefined;
      const gmiShutdown = Promise.resolve(gmi.shutdown());
      const shutdown = learnerSession
        ? gmiShutdown.finally(() =>
            Promise.resolve()
              .then(() => learnerSession.endSession())
              .catch((error: any) => {
                console.warn(`GMIManager (ID: ${this.managerId}): Ending the learner session of GMI ${gmiInstanceId} failed: ${error?.message ?? error}`);
              }),
          )
        : gmiShutdown;
      if (await settlesWithin(shutdown, bound)) return;
      console.warn(
        `GMIManager (ID: ${this.managerId}): GMI ${gmiInstanceId}${sessionId ? ` (session ${sessionId})` : ''} did not finish shutting down within ${bound} ms; going on without it.`,
      );
      // It goes on in the background; a failure it ends with is still logged.
      shutdown.catch(logFailure);
    } catch (error: any) {
      logFailure(error);
    }
  }

  /**
   * Waits, at most `shutdownTimeoutMs`, for the getOrCreateGMIForSession() and
   * createAgencySeat() calls in flight to settle. A call still running after
   * that shuts down the GMI it builds once it gets that far.
   */
  private async creationsSettled(): Promise<void> {
    if (this.creationsInFlight.size === 0) return;
    const bound = this.config.shutdownTimeoutMs;
    if (await settlesWithin(Promise.allSettled(Array.from(this.creationsInFlight)), bound)) return;
    console.warn(
      `GMIManager (ID: ${this.managerId}): ${this.creationsInFlight.size} GMI creation(s) still in flight after ${bound} ms; each shuts its GMI down when it finishes.`,
    );
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
      // A seat's GMI lives as long as its launch, which releases it; its turns leave no conversation context here.
      if (this.agencySeatSessions.has(sessionId)) continue;
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
    // Calls that arrive from here on fail with the not-initialized error. The
    // sessions go through deactivateSession(), which does not check the flag.
    this.isInitialized = false;

    // Every GMI shuts down at the same time, each within shutdownTimeoutMs, so
    // the manager takes about one bound however many GMIs are active. In the
    // same bound it waits for the getOrCreateGMIForSession() and
    // createAgencySeat() calls in flight: one that began before the flag was
    // cleared and has not registered its GMI shuts that GMI down itself.
    const sessionIdsToDeactivate = Array.from(this.gmiSessionMap.keys());
    // A GMI in the active map that no session maps to is shut down in the same
    // pass. Two creations for one new session that race both build a GMI, and
    // the later registration takes the session entry from the earlier one.
    const mappedInstanceIds = new Set(this.gmiSessionMap.values());
    const unmappedGMIs = Array.from(this.activeGMIs).filter(([gmiInstanceId]) => !mappedInstanceIds.has(gmiInstanceId));
    await Promise.allSettled([
      ...sessionIdsToDeactivate.map((sessionId) =>
        this.deactivateSession(sessionId).catch((error: any) => {
          console.error(`GMIManager (ID: ${this.managerId}): Error deactivating GMI for session ${sessionId} during manager shutdown: ${error.message}`, error);
        }),
      ),
      ...unmappedGMIs.map(([gmiInstanceId, gmi]) => this.shutDownGMI(gmi, gmiInstanceId)),
      this.creationsSettled(),
    ]);

    this.activeGMIs.clear();
    this.gmiSessionMap.clear();
    this.agencySeatSessions.clear();
    this.allPersonaDefinitions.clear();
    console.log(`GMIManager (ID: ${this.managerId}): Shutdown complete.`);
  }

  /**
   * Routes user feedback to the GMI that serves the session; feedback that
   * names the session of a seat of a launched team (createAgencySeat()) is not
   * recorded. The payload is normalized first (see
   * {@link normalizeUserFeedback}): a `rating` label
   * decides the polarity, otherwise a numeric rating is read on the 1 to 5
   * scale. The GMI then records a trace entry and, when cognitive memory is
   * configured, stores the feedback and any correction as memories of the user.
   *
   * @param userId - The user who sent the feedback.
   * @param sessionId - The session the feedback refers to.
   * @param personaId - The persona involved; used for logging only.
   * @param feedbackData - Raw feedback, normally a `UserFeedbackPayload`.
   */
  public async processUserFeedback(userId: string, sessionId: string, personaId: string, feedbackData: any): Promise<void> {
    this.ensureInitialized();
    console.log(`GMIManager (ID: ${this.managerId}): Received feedback for User: ${userId}, Session: ${sessionId}, Persona: ${personaId}`, {
      fields: feedbackData && typeof feedbackData === 'object' ? Object.keys(feedbackData) : [],
      textLength: typeof feedbackData?.text === 'string' ? feedbackData.text.length : 0,
    });

    // A seat's GMI serves its team alone: feedback that names its session reaches neither the GMI nor its trace, which
    // the GMI's self-reflection reads.
    if (this.agencySeatSessions.has(sessionId)) return;

    const gmiInstanceId = this.gmiSessionMap.get(sessionId);
    const gmi = gmiInstanceId ? this.activeGMIs.get(gmiInstanceId) : undefined;

    if (!gmi || !feedbackData || typeof feedbackData !== 'object') {
      this.addTraceEntryToRelevantGMI(sessionId, ReasoningEntryType.DEBUG, 'User feedback received by manager.', { userId, feedbackData });
      return;
    }

    const normalized = normalizeUserFeedback(feedbackData);
    if (typeof gmi.recordUserFeedback === 'function') {
      await gmi.recordUserFeedback({ ...normalized, userId });
      return;
    }

    // IGMI implementations without the hook still get the classified trace entry.
    this.addTraceEntryToRelevantGMI(
      sessionId,
      normalized.polarity === 'negative' ? ReasoningEntryType.WARNING : ReasoningEntryType.DEBUG,
      feedbackTraceMessage(normalized.polarity),
      { userId, ...normalized },
    );
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
