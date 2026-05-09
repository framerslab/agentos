/**
 * @fileoverview Implements the MemoryLifecycleManager (MemoryLifecycleManager),
 * responsible for enforcing data retention and eviction policies on memories
 * stored within the AgentOS RAG system. It uses IUtilityAI for summarization tasks
 * and interacts with IVectorStoreManager to query and act on stored items.
 * GMI negotiation is a key feature for handling potentially critical memories.
 *
 * @module backend/agentos/memory/lifecycle/MemoryLifecycleManager
 * @see ./IMemoryLifecycleManager.ts for the interface definition.
 * @see ../core/config/MemoryLifecycleManagerConfiguration.ts for configuration.
 * @see ../nlp/ai_utilities/IUtilityAI.ts for summarization.
 * @see ../core/vector-store/IVectorStore.ts and ../rag/IVectorStoreManager.ts
 */

import { uuidv4 } from '@framers/agentos/core/utils/uuid';
import {
  IMemoryLifecycleManager,
  GMIResolverFunction,
  PolicyEnforcementFilter,
  LifecycleEnforcementReport,
} from './IMemoryLifecycleManager';
import {
  MemoryLifecycleManagerConfig,
  MemoryLifecyclePolicy,
  PolicyAction as ConfigPolicyActionDetails, // Renamed to avoid conflict in this file
} from '../../../../core/config/MemoryLifecycleManagerConfiguration';
import { IVectorStoreManager } from '../../../../core/vector-store/IVectorStoreManager';
import { IVectorStore, MetadataFilter } from '../../../../core/vector-store/IVectorStore';
import { IUtilityAI, SummarizationOptions } from '../../../nlp/ai_utilities/IUtilityAI';
import { RagMemoryCategory } from '../../../rag/IRetrievalAugmentor';
import { GMIError, GMIErrorCode } from '@framers/agentos/core/utils/errors';
import {
  MemoryLifecycleEvent,
  LifecycleAction,
  LifecycleActionResponse,
} from '../../../substrate/IGMI';
// import * as path from 'path'; // Only if dealing with file paths for archiveTargetId

/**
 * Helper to parse duration strings (e.g., "7d", "24h", "30m") into milliseconds.
 * Supports simple formats; for full ISO 8601 duration, a more robust parser is needed.
 * @param {string} [durationStr] - The duration string.
 * @returns {number | null} Milliseconds or null if parsing fails.
 * @internal
 */
const parseDurationToMs = (durationStr?: string): number | null => {
    if (!durationStr) return null;
    const s = durationStr.toLowerCase();
    const dayMatch = s.match(/^(\d+)d$/);
    if (dayMatch) return parseInt(dayMatch[1], 10) * 24 * 60 * 60 * 1000;
    const hourMatch = s.match(/^(\d+)h$/);
    if (hourMatch) return parseInt(hourMatch[1], 10) * 60 * 60 * 1000;
    const minuteMatch = s.match(/^(\d+)m$/);
    if (minuteMatch) return parseInt(minuteMatch[1], 10) * 60 * 1000;
    // Basic ISO 8601 Duration (PT H, M, S)
    if (s.startsWith('pt')) {
        let totalMs = 0;
        const hourMatchIso = s.match(/(\d+)h/); if (hourMatchIso) totalMs += parseInt(hourMatchIso[1],10) * 3600 * 1000;
        const minuteMatchIso = s.match(/(\d+)m/); if (minuteMatchIso) totalMs += parseInt(minuteMatchIso[1],10) * 60 * 1000;
        const secondMatchIso = s.match(/(\d+)s/); if (secondMatchIso) totalMs += parseInt(secondMatchIso[1],10) * 1000;
        if (totalMs > 0) return totalMs;
    }
    console.warn(`MemoryLifecycleManager: Could not parse duration string "${durationStr}". Supported formats: "Xd", "Xh", "Xm", or simple ISO "PTXHXM".`);
    return null;
};

/**
 * Represents an item identified as a candidate for a lifecycle action.
 * Includes necessary details for processing and negotiation.
 * @internal
 */
interface LifecycleCandidateItem {
  id: string; // Vector store item ID (e.g., chunk ID)
  dataSourceId: string;
  collectionName: string; // Actual name in the vector store
  gmiOwnerId?: string;
  personaOwnerId?: string;
  category?: RagMemoryCategory;
  timestamp?: Date; // Creation/last modification timestamp of the item
  metadata: Record<string, any>;
  textContent?: string; // Full text content, fetched if needed for summarization
  contentSummary?: string; // A pre-existing or brief summary of the item
  vectorStoreRef: IVectorStore; // Reference to the specific IVectorStore instance
}


/**
 * @class MemoryLifecycleManager
 * @implements {IMemoryLifecycleManager}
 * Manages the lifecycle of stored memories by enforcing configured policies,
 * handling data retention, eviction, archival, and negotiating with GMIs.
 */
export class MemoryLifecycleManager implements IMemoryLifecycleManager {
  public readonly managerId: string;
  private config!: MemoryLifecycleManagerConfig;
  private vectorStoreManager!: IVectorStoreManager;
  private gmiResolver!: GMIResolverFunction;
  private utilityAI?: IUtilityAI;
  private isInitialized: boolean = false;
  private periodicCheckTimer?: NodeJS.Timeout;
  /** Optional memory archive. When set, the 'archive' action stores content before deleting. */
  private archive: import('../../archive/IMemoryArchive.js').IMemoryArchive | null = null;

  /**
   * Constructs a MemoryLifecycleManager instance.
   * The manager is not operational until `initialize` is called.
   */
  constructor() {
    this.managerId = `mlm-${uuidv4()}`;
  }

  /**
   * @inheritdoc
   */
  public async initialize(
    config: MemoryLifecycleManagerConfig,
    vectorStoreManager: IVectorStoreManager,
    gmiResolver: GMIResolverFunction,
    utilityAI?: IUtilityAI,
  ): Promise<void> {
    if (this.isInitialized) {
      console.warn(`MemoryLifecycleManager (ID: ${this.managerId}) already initialized. Re-initializing.`);
      await this.shutdown(); // Gracefully stop previous instance timers and state
    }

    if (!config) throw new GMIError('MemoryLifecycleManagerConfig cannot be null.', GMIErrorCode.CONFIG_ERROR, { managerId: this.managerId });
    if (!vectorStoreManager) throw new GMIError('IVectorStoreManager dependency is missing for MemoryLifecycleManager.', GMIErrorCode.DEPENDENCY_ERROR, { managerId: this.managerId });
    if (!gmiResolver) throw new GMIError('GMIResolverFunction dependency is missing for MemoryLifecycleManager.', GMIErrorCode.DEPENDENCY_ERROR, { managerId: this.managerId });

    this.config = {
        defaultCheckInterval: "PT6H", // Default to 6 hours
        defaultGMINegotiationTimeoutMs: 30000,
        dryRunMode: false,
        maxConcurrentOperations: 5,
        gmiOwnerIdMetadataField: "gmiOwnerId",
        personaOwnerIdMetadataField: "personaOwnerId",
        itemTimestampMetadataField: "creationTimestamp",
        ...config, // User config overrides defaults
    };
    this.vectorStoreManager = vectorStoreManager;
    this.gmiResolver = gmiResolver;
    this.utilityAI = utilityAI;

    // Validate policies for dependencies
    this.config.policies.forEach(p => {
      if (p.action.type.startsWith('summarize_') && !this.utilityAI) {
        throw new GMIError(`Policy '${p.policyId}' requires summarization, but IUtilityAI dependency was not provided to MemoryLifecycleManager.`, GMIErrorCode.CONFIG_ERROR, { policyId: p.policyId });
      }
    });

    this.isInitialized = true;
    this.setupPeriodicChecks();
    console.log(`MemoryLifecycleManager (ID: ${this.managerId}) initialized. Policies: ${this.config.policies.length}. DryRun: ${this.config.dryRunMode}.`);
  }

  /**
   * Attach an IMemoryArchive for real archive operations.
   *
   * When set, the `archive` and `summarize_and_archive` action types perform
   * a real store-then-delete instead of the previous conceptual log-then-delete.
   *
   * @param archiveImpl - The archive implementation to use.
   */
  public setArchive(archiveImpl: import('../../archive/IMemoryArchive.js').IMemoryArchive): void {
    this.archive = archiveImpl;
  }

  /**
   * Ensures the manager is initialized before performing operations.
   * @private
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new GMIError(`MemoryLifecycleManager (ID: ${this.managerId}) is not initialized. Call initialize() first.`, GMIErrorCode.NOT_INITIALIZED);
    }
  }

  /**
   * Sets up periodic policy enforcement based on configuration.
   * @private
   */
  private setupPeriodicChecks(): void {
    if (this.periodicCheckTimer) clearInterval(this.periodicCheckTimer);

    const intervalMs = parseDurationToMs(this.config.defaultCheckInterval);
    if (intervalMs && intervalMs > 0) {
      this.periodicCheckTimer = setInterval(async () => {
        if (this.config.dryRunMode) {
            console.log(`[DRY RUN] MemoryLifecycleManager (ID: ${this.managerId}): Periodic policy enforcement check triggered.`);
            // In dry run, we might still want to log what *would* be done.
            // To do that, enforcePolicies would need to be called, and it respects dryRunMode.
        }
        console.log(`MemoryLifecycleManager (ID: ${this.managerId}): Running periodic policy enforcement...`);
        try {
          // Enforce policies that are periodic or general age-based
          await this.enforcePolicies({
            policyIds: this.config.policies
                            .filter(p => p.isEnabled !== false && (p.trigger?.type === 'periodic' || (!p.trigger && p.retentionDays && p.retentionDays > 0)))
                            .map(p => p.policyId)
          });
        } catch (error: any) {
          console.error(`MemoryLifecycleManager (ID: ${this.managerId}): Error during periodic policy enforcement: ${error.message}`, error);
        }
      }, intervalMs);
      console.log(`MemoryLifecycleManager (ID: ${this.managerId}): Scheduled periodic policy enforcement (interval: ${intervalMs / 1000}s). DryRun: ${this.config.dryRunMode}.`);
    }
  }

  /**
   * @inheritdoc
   */
  public async enforcePolicies(filter?: PolicyEnforcementFilter): Promise<LifecycleEnforcementReport> {
    this.ensureInitialized();
    const startTime = new Date();
    const report: LifecycleEnforcementReport = {
      startTime,
      endTime: startTime, // Will update at the end
      policiesEvaluated: 0,
      itemsScanned: 0,
      itemsAffected: 0,
      policyResults: {},
      errors: [],
      wasDryRun: this.config.dryRunMode === true,
    };

    const policiesToEvaluate = this.config.policies.filter(p =>
      p.isEnabled !== false &&
      (!filter?.policyIds || filter.policyIds.length === 0 || filter.policyIds.includes(p.policyId))
    ).sort((a, b) => (a.priority || 0) - (b.priority || 0));

    report.policiesEvaluated = policiesToEvaluate.length;
    this.addTraceToReport(report, undefined, undefined, undefined, `Starting policy enforcement. Evaluating ${report.policiesEvaluated} policies. DryRun: ${report.wasDryRun}.`);

    for (const policy of policiesToEvaluate) {
      report.policyResults![policy.policyId] = { itemsProcessed: 0, actionsTaken: {} };
      let policyCandidatesFound = 0;
      try {
        const candidates = await this.findPolicyCandidates(policy, filter);
        policyCandidatesFound = candidates.length;
        report.itemsScanned += candidates.length;

        if (candidates.length > 0) {
            this.addTraceToReport(report, undefined, policy.policyId, undefined, `Found ${candidates.length} candidate items for policy.`);
        }

        for (const candidate of candidates) {
          report.policyResults![policy.policyId].itemsProcessed++;
          const actionToTake = await this.negotiateAndDetermineAction(candidate, policy);

          if (actionToTake && actionToTake !== 'NO_ACTION_TAKEN') {
            // Store the intended action before actual execution for accurate reporting
            const actionKey = actionToTake as string;
            report.policyResults![policy.policyId].actionsTaken[actionKey] = (report.policyResults![policy.policyId].actionsTaken[actionKey] || 0) + 1;
            report.itemsAffected++; // Count as affected if an action *would* be taken

            if (!this.config.dryRunMode) { // Only execute if not dry run
              await this.executeLifecycleAction(candidate, policy.action, actionToTake, policy.policyId, report);
            } else {
                this.addTraceToReport(report, candidate.id, policy.policyId, actionToTake, `[DRY RUN] Would execute action.`);
            }
          } else {
              this.addTraceToReport(report, candidate.id, policy.policyId, 'NO_ACTION_TAKEN', `No action taken after negotiation or due to policy outcome.`);
          }
        }
      } catch (error: any) {
        const gmiErr = GMIError.wrap(error, GMIErrorCode.PROCESSING_ERROR, `Error enforcing policy '${policy.policyId}'.`);
        console.error(`${this.managerId}: ${gmiErr.message}`, gmiErr.details?.underlyingError);
        report.errors?.push({ policyId: policy.policyId, message: gmiErr.message, details: gmiErr.toPlainObject() });
      }
      this.addTraceToReport(report, undefined, policy.policyId, undefined, `Finished processing policy. Candidates found: ${policyCandidatesFound}.`);
    }

    report.endTime = new Date();
    const durationMs = report.endTime.getTime() - report.startTime.getTime();
    this.addTraceToReport(report, undefined, undefined, undefined, `Policy enforcement completed in ${durationMs}ms. ${report.itemsAffected} items affected.`);
    console.log(`MemoryLifecycleManager (ID: ${this.managerId}): Policy enforcement completed. ${report.itemsAffected} items affected (DryRun: ${report.wasDryRun}). Duration: ${durationMs}ms.`);
    return report;
  }


  /**
   * Finds candidate items for a given policy.
   * This is a complex method that needs to interact with IVectorStoreManager and IVectorStore.
   * @private
   */
  private async findPolicyCandidates(policy: MemoryLifecyclePolicy, enforcementFilter?: PolicyEnforcementFilter): Promise<LifecycleCandidateItem[]> {
    const allCandidateItems: LifecycleCandidateItem[] = [];
    const timestampField = this.config.itemTimestampMetadataField!; // Assumed to be configured
    const gmiOwnerField = this.config.gmiOwnerIdMetadataField!;
    const personaOwnerField = this.config.personaOwnerIdMetadataField!;

    // Determine data sources to scan
    let dsIdsToScan: string[] = [];
    if (policy.appliesTo.dataSourceIds && policy.appliesTo.dataSourceIds.length > 0) {
        dsIdsToScan = policy.appliesTo.dataSourceIds;
    } else {
        dsIdsToScan = this.vectorStoreManager.listDataSourceIds(); // Scan all if policy doesn't specify
    }
    // Further filter by enforcementFilter if provided
    if (enforcementFilter?.dataSourceIds && enforcementFilter.dataSourceIds.length > 0) {
        dsIdsToScan = dsIdsToScan.filter(id => enforcementFilter.dataSourceIds!.includes(id));
    }

    for (const dsId of dsIdsToScan) {
      try {
        const { store, collectionName } = await this.vectorStoreManager.getStoreForDataSource(dsId);
        const combinedFilter: MetadataFilter = { ...(policy.appliesTo.metadataFilter || {}) };

        // Apply category filter (assuming 'category' metadata field)
        const targetCategories = enforcementFilter?.categories || policy.appliesTo.categories;
        if (targetCategories && targetCategories.length > 0) {
          combinedFilter['category'] = { $in: targetCategories as string[] };
        }

        // Apply GMI owner filter
        const targetGmiOwner = enforcementFilter?.gmiOwnerId || policy.appliesTo.gmiOwnerId;
        if (targetGmiOwner) {
          combinedFilter[gmiOwnerField] = targetGmiOwner;
        }
        // Apply Persona owner filter
        const targetPersonaOwner = enforcementFilter?.personaOwnerId || policy.appliesTo.personaOwnerId;
        if (targetPersonaOwner) {
          combinedFilter[personaOwnerField] = targetPersonaOwner;
        }

        // Apply retentionDays filter
        if (policy.retentionDays && policy.retentionDays > 0) {
          const cutoffDate = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000);
          // Ensure the filter for timestamp is compatible with how store handles date comparisons
          combinedFilter[timestampField] = { $lt: cutoffDate.toISOString() };
        }

        if (Object.keys(combinedFilter).length === 0) {
             console.warn(`MemoryLifecycleManager (${this.managerId}): Policy '${policy.policyId}' has no effective filters (age, category, metadata). Scanning all items is not feasible. Skipping candidate search for this policy on this data source.`);
             continue;
        }

        if (typeof store.scanByMetadata === 'function') {
            const scanResult = await store.scanByMetadata(collectionName, {
                filter: combinedFilter,
                includeMetadata: true,
                includeTextContent: true,
            });

            for (const doc of scanResult.documents) {
                const metadata = (doc.metadata || {}) as Record<string, any>;
                const rawTimestamp = metadata[timestampField];
                const timestamp = typeof rawTimestamp === 'string' || rawTimestamp instanceof Date
                    ? new Date(rawTimestamp)
                    : undefined;

                allCandidateItems.push({
                    id: doc.id,
                    dataSourceId: dsId,
                    collectionName,
                    gmiOwnerId: typeof metadata[gmiOwnerField] === 'string' ? metadata[gmiOwnerField] : undefined,
                    personaOwnerId: typeof metadata[personaOwnerField] === 'string' ? metadata[personaOwnerField] : undefined,
                    category: typeof metadata.category === 'string' ? metadata.category as RagMemoryCategory : undefined,
                    timestamp: timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp : undefined,
                    metadata,
                    textContent: doc.textContent,
                    contentSummary: typeof metadata.contentSummary === 'string' ? metadata.contentSummary : undefined,
                    vectorStoreRef: store,
                });
            }
            continue;
        }

        // How to query without an embedding for lifecycle purposes?
        // This is a MAJOR DEPENDENCY on IVectorStore capabilities.
        // Assumption 1: store.query with a null/empty embedding and filter works.
        // Assumption 2: store might have a specific scanByMetadata (not in IVectorStore yet).
        // Assumption 3: We fetch a large number of recent items and filter client-side (inefficient).
        //
        // For now, let's log a warning and return empty, highlighting this gap.
        // To make this "work" in a limited fashion, one could query for *everything* (topK very large)
        // without an embedding if the store supports it, but this is dangerous and slow.
        if (Object.keys(combinedFilter).length > 0) {
            console.warn(`MemoryLifecycleManager (${this.managerId}): Policy '${policy.policyId}' for DS '${dsId}' requires metadata-based querying. ` +
                         `Current IVectorStore.query typically requires an embedding. Efficiently finding candidates for lifecycle ` +
                         `management based purely on metadata (like age, category, owner) needs specific IVectorStore support ` +
                         `(e.g., scanByMetadata, or query with null embedding vector and strong filter support). ` +
                         `This implementation will yield no candidates for this policy run if such support isn't available and used.`);
            // Placeholder: If a store *could* do this with a special query:
            // const queryOptions:             // const result: QueryResult = await store.query(collectionName, [], queryOptions); // Pass empty/null vector?
            // result.documents.forEach(doc => { /* convert to LifecycleCandidateItem */ });
        } else {
             console.warn(`MemoryLifecycleManager (${this.managerId}): Policy '${policy.policyId}' for DS '${dsId}' has no effective filters (age, category, metadata). Scanning all items is not feasible. Skipping candidate search for this policy on this data source.`);
        }

      } catch (error: any) {
        console.error(`MemoryLifecycleManager (ID: ${this.managerId}): Error preparing to find candidates for policy '${policy.policyId}' on DS '${dsId}': ${error.message}`, error);
        this.addTraceToReport(undefined, undefined, policy.policyId, undefined, `Error processing DS '${dsId}': ${error.message}`);
      }
    }
    return allCandidateItems; // Supported stores populate this via scanByMetadata(); unsupported stores fall back to the warnings above.
  }

  private async negotiateAndDetermineAction(candidate: LifecycleCandidateItem, policy: MemoryLifecyclePolicy): Promise<LifecycleAction | null> {
    if (policy.gmiNegotiation?.enabled && candidate.gmiOwnerId) {
      const gmiInstance = await this.gmiResolver(candidate.gmiOwnerId, candidate.personaOwnerId);
      if (gmiInstance) {
        const event: MemoryLifecycleEvent = {
            eventId: uuidv4(), timestamp: new Date(), type: this.mapPolicyActionToEventType(policy.action.type),
            gmiId: candidate.gmiOwnerId, personaId: candidate.personaOwnerId, itemId: candidate.id,
            dataSourceId: candidate.dataSourceId, category: candidate.category?.toString(),
            itemSummary: candidate.contentSummary || candidate.textContent?.substring(0, 200) || `Item ID: ${candidate.id}`,
            reason: policy.description || `Policy '${policy.policyId}' triggered.`,
            proposedAction: policy.action.type as LifecycleAction, // Map from ConfigPolicyActionDetails['type']
            negotiable: true, metadata: candidate.metadata
        };
        try {
          const timeout = policy.gmiNegotiation.timeoutMs || this.config.defaultGMINegotiationTimeoutMs!;
          const negotiationPromise = gmiInstance.onMemoryLifecycleEvent(event);
          const response = await Promise.race([
            negotiationPromise,
            new Promise<LifecycleActionResponse>((_, reject) =>
              setTimeout(() => reject(new GMIError("GMI negotiation timed out", GMIErrorCode.TIMEOUT, { itemId: candidate.id })), timeout)
            )
          ]);
          console.log(`MLM (${this.managerId}): GMI '${candidate.gmiOwnerId}' responded with '${response.actionTaken}' for item '${candidate.id}'.`);
          return response.actionTaken;
        } catch (error: any) {
          const gmiErr = GMIError.wrap(error, GMIErrorCode.PROCESSING_ERROR, `Error/timeout negotiating with GMI '${candidate.gmiOwnerId}' for item '${candidate.id}'.`);
          console.error(`${this.managerId}: ${gmiErr.message}`, gmiErr.details?.underlyingError);
          return policy.gmiNegotiation.defaultActionOnTimeout || 'ALLOW_ACTION'; // Fallback
        }
      } else {
         console.warn(`MLM (${this.managerId}): Owning GMI '${candidate.gmiOwnerId}' for item '${candidate.id}' not found/resolved. Applying configured action directly.`);
         return policy.action.type as LifecycleAction;
      }
    }
    return policy.action.type as LifecycleAction; // No negotiation configured
  }

  private mapPolicyActionToEventType(actionType: ConfigPolicyActionDetails['type']): MemoryLifecycleEvent['type'] {
    // ... (mapping logic as before) ...
    switch (actionType) {
        case 'delete': return 'DELETION_PROPOSED';
        case 'summarize_and_delete': return 'EVICTION_PROPOSED';
        case 'archive': return 'ARCHIVAL_PROPOSED';
        case 'summarize_and_archive': return 'ARCHIVAL_PROPOSED';
        case 'notify_gmi_owner': return 'NOTIFICATION';
        default: return 'EVALUATION_PROPOSED';
    }
  }

  private async executeLifecycleAction(
    candidate: LifecycleCandidateItem,
    configuredActionDetails: ConfigPolicyActionDetails,
    determinedAction: LifecycleAction, // This is the action post-negotiation
    policyId: string,
    report?: LifecycleEnforcementReport // For adding detailed traces
  ): Promise<void> {
    /**
     * Core action executor invoked after (optional) GMI negotiation resolves a final lifecycle decision.
     * Responsibilities:
     *  1. Honor dryRun mode (log intent only, no side-effects).
     *  2. Resolve effective action (may differ from configuredActionDetails.type if GMI overrode).
     *  3. Execute summarization variants (summarize_and_delete / summarize_and_archive) via UtilityAI.
     *  4. Perform storage mutation (delete/archive) through vectorStoreManager.
     *  5. Emit detailed trace lines into enforcement report for auditing & analytics.
     *
     * Error Semantics:
     *  - Missing dependencies (UtilityAI for summarization) -> throws GMIError(MISSING_DEPENDENCY) early.
     *  - Missing required candidate.textContent for summarization -> throws GMIError(MISSING_DATA).
     *  - Underlying vector store failures wrapped into GMIError(PROCESSING_ERROR) and logged; processing continues
     *    for remaining items (best-effort policy execution).
     *  - All thrown errors are caught by caller loops which append to report.errors.
     *
     * Idempotency Considerations:
     *  - Delete/archive operations SHOULD be idempotent at vector store layer; repeated attempts should no-op.
     *  - Summarization re-runs will regenerate summary text; ingest step currently conceptual (logged only).
     */
    const dryRunPrefix = this.config.dryRunMode ? "[DRY RUN] " : "";
  const logPreamble = `${dryRunPrefix}MLM (${this.managerId}): Item '${candidate.id}' from '${candidate.dataSourceId}/${candidate.collectionName}'. Action: '${determinedAction}'. Policy: '${policyId}'.`;
    console.log(logPreamble);
  this.addTraceToReport(report, candidate.id, policyId, determinedAction, "Preparing to execute action.");


    if (this.config.dryRunMode) {
    this.addTraceToReport(report, candidate.id, policyId, determinedAction, "Dry run: No actual change made.");
        return;
    }

    let effectiveConfigActionType = configuredActionDetails.type;
    if (determinedAction === 'ALLOW_ACTION') {
        effectiveConfigActionType = configuredActionDetails.type; // Proceed with original policy action
    } else if (['PREVENT_ACTION', 'NO_ACTION_TAKEN', 'ACKNOWLEDGE_NOTIFICATION'].includes(determinedAction)) {
    this.addTraceToReport(report, candidate.id, policyId, determinedAction, "Action prevented or no change required.");
        return;
    } else {
        // GMI specified a concrete action (DELETE, ARCHIVE, etc.)
        effectiveConfigActionType = determinedAction as ConfigPolicyActionDetails['type'];
    }

    try {
      let summaryText: string | undefined;
      if (effectiveConfigActionType.startsWith('summarize_')) {
        if (!this.utilityAI) {
          throw new GMIError("Summarization action requires IUtilityAI, but it's not configured for MLM.", GMIErrorCode.MISSING_DEPENDENCY);
        }
        const summarizationOpts: SummarizationOptions = {
          desiredLength: 'short', // Make this configurable via policy.action.summarizationOptions
          method: 'abstractive_llm', // Make this configurable
          modelId: configuredActionDetails.llmModelForSummary || this.config.defaultSummarizationModelId,
        };

        if (!candidate.textContent) {
          // Gracefully skip summarization if full text is missing; continue with downstream action.
          this.addTraceToReport(
            report,
            candidate.id,
            policyId,
            determinedAction,
            `Text content missing for summarization; skipping summary generation.`,
          );
          console.warn(
            `MLM (${this.managerId}): Text content missing for item '${candidate.id}' during summarize action. Skipping summary.`,
          );
        } else {
          this.addTraceToReport(
            report,
            candidate.id,
            policyId,
            determinedAction,
            `Starting summarization with options: ${JSON.stringify(summarizationOpts)}`,
          );
          summaryText = await this.utilityAI.summarize(candidate.textContent, summarizationOpts);
          this.addTraceToReport(
            report,
            candidate.id,
            policyId,
            determinedAction,
            `Summarization complete. Summary length: ${summaryText.length}.`,
          );

          if (configuredActionDetails.summaryDataSourceId && summaryText) {
            const summaryDocId = `summary_of_${candidate.id.replace(/[^a-zA-Z0-9-_]/g, '_')}`; // Sanitize ID
            this.addTraceToReport(
              report,
              candidate.id,
              policyId,
              determinedAction,
              `Summary (New ID: ${summaryDocId}) for item '${candidate.id}' to be ingested to DS '${configuredActionDetails.summaryDataSourceId}'. (Conceptual RAG ingestion step).`,
            );
            console.log(
              `MLM (${this.managerId}): Summary for item '${candidate.id}' (ID: ${summaryDocId}) intended for DS '${configuredActionDetails.summaryDataSourceId}'.`,
            );
          }
        }
      }

      // Perform Delete or Archive based on the effective action type
      if (effectiveConfigActionType === 'delete' || (effectiveConfigActionType === 'summarize_and_delete' && (configuredActionDetails.deleteOriginalAfterSummary !== false || summaryText !== undefined))) {
        await candidate.vectorStoreRef.delete(candidate.collectionName, [candidate.id]);
  this.addTraceToReport(report, candidate.id, policyId, determinedAction, `Item deleted successfully.`);
      } else if (effectiveConfigActionType === 'archive' || (effectiveConfigActionType === 'summarize_and_archive' && (configuredActionDetails.deleteOriginalAfterSummary !== false || summaryText !== undefined))) {
        if (this.archive) {
          // Real archive: preserve content in cold storage, then delete original.
          const content = candidate.textContent ?? candidate.contentSummary ?? '';
          const { sha256 } = await import('../../core/util/crossPlatformCrypto.js');
          const contentHash = await sha256(content);
          const writeResult = await this.archive.store({
            traceId: candidate.id,
            agentId: candidate.gmiOwnerId ?? this.managerId,
            verbatimContent: content,
            contentHash,
            traceType: (candidate.category as any) ?? 'episodic',
            emotionalContext: { valence: 0, arousal: 0, dominance: 0, intensity: 0, gmiMood: 'neutral' },
            entities: [],
            tags: [],
            createdAt: candidate.timestamp?.getTime() ?? Date.now(),
            archivedAt: Date.now(),
            archiveReason: 'lifecycle_archive',
          });
          if (!writeResult.success) {
            this.addTraceToReport(report, candidate.id, policyId, determinedAction,
              `ARCHIVAL_FAILED: ${writeResult.error}. Original retained.`);
            return;
          }
          this.addTraceToReport(report, candidate.id, policyId, determinedAction,
            `Archived (${writeResult.bytesWritten} bytes). Deleting original.`);
        } else {
          // No archive configured — fall back to delete with a warning.
          const archiveTarget = configuredActionDetails.archiveTargetId || this.config.defaultArchiveStoreId;
          this.addTraceToReport(report, candidate.id, policyId, determinedAction,
            `No archive configured (target '${archiveTarget}' is conceptual). Falling back to delete.`);
        }
        // Delete original after successful archive or when no archive is configured
        if (configuredActionDetails.deleteOriginalAfterSummary !== false || effectiveConfigActionType === 'archive') {
             await candidate.vectorStoreRef.delete(candidate.collectionName, [candidate.id]);
        }
      } else if (effectiveConfigActionType === 'notify_gmi_owner') {
         this.addTraceToReport(report, candidate.id, policyId, determinedAction, `GMI owner notification action type; no direct data modification by MLM here.`);
      }
      // Other actions like RETAIN_FOR_DURATION, MARK_AS_CRITICAL would involve updating item metadata.
      // This requires IVectorStore to support metadata updates, e.g., `updateMetadata(collectionName, itemId, metadataPatch)`.

    } catch (error: any) {
      const gmiErr = GMIError.wrap(error, GMIErrorCode.PROCESSING_ERROR, `Failed to execute lifecycle action '${effectiveConfigActionType}' on item '${candidate.id}'.`);
  this.addTraceToReport(report, candidate.id, policyId, determinedAction, `Error: ${gmiErr.message}`);
      console.error(`MLM (${this.managerId}): Error during executeLifecycleAction for item '${candidate.id}', action '${effectiveConfigActionType}': ${gmiErr.message}`, gmiErr.details?.underlyingError);
      throw gmiErr;
    }
  }

  public async processSingleItemLifecycle(
    itemContext: {
      itemId: string; dataSourceId: string; gmiOwnerId?: string; personaOwnerId?: string;
      category?: RagMemoryCategory; metadata?: Record<string, any>;
      contentSummary?: string; textContent?: string; // textContent is important if summarization needed
    },
    triggeringReason?: string
  ): Promise<{ actionTaken: LifecycleAction; details?: any }> {
    this.ensureInitialized();
    const logPreamble = `MLM (${this.managerId}): processSingleItemLifecycle for '${itemContext.itemId}', Reason: ${triggeringReason || 'manual'}.`;
    console.log(logPreamble);

    const { store, collectionName } = await this.vectorStoreManager.getStoreForDataSource(itemContext.dataSourceId);
    const candidate: LifecycleCandidateItem = {
      id: itemContext.itemId,
      dataSourceId: itemContext.dataSourceId,
      collectionName,
      gmiOwnerId: itemContext.gmiOwnerId,
      personaOwnerId: itemContext.personaOwnerId,
      category: itemContext.category,
      metadata: itemContext.metadata || {},
      contentSummary: itemContext.contentSummary,
      textContent: itemContext.textContent, // Important for summarization if policy needs it
      vectorStoreRef: store,
      timestamp: itemContext.metadata?.[this.config.itemTimestampMetadataField!] ? new Date(itemContext.metadata[this.config.itemTimestampMetadataField!]) : undefined,
    };

    const applicablePolicies = this.config.policies.filter(p => {
      if (p.isEnabled === false) return false;
      // Match appliesTo criteria
      let matches = true;
      if (p.appliesTo.categories && !p.appliesTo.categories.some(cat => cat === candidate.category)) matches = false;
      if (p.appliesTo.dataSourceIds && !p.appliesTo.dataSourceIds.includes(candidate.dataSourceId)) matches = false;
      if (p.appliesTo.gmiOwnerId && p.appliesTo.gmiOwnerId !== candidate.gmiOwnerId) matches = false;
      if (p.appliesTo.personaOwnerId && p.appliesTo.personaOwnerId !== candidate.personaOwnerId) matches = false;
      if (p.appliesTo.metadataFilter && candidate.metadata) {
        const filter = p.appliesTo.metadataFilter as Record<string, unknown>;
        const meta = candidate.metadata;
        const filterMatches = Object.entries(filter).every(
          ([key, val]) => meta[key] === val,
        );
        if (!filterMatches) matches = false;
      }
      if (!matches) return false;

      // Check retention if policy is age-based
      if (p.retentionDays && p.retentionDays > 0) {
        if (!candidate.timestamp) {
          console.warn(`${logPreamble} Item '${candidate.id}' missing timestamp for retention check with policy '${p.policyId}'. Assuming not expired.`);
          return false; // Cannot evaluate age-based policy without timestamp
        }
        const cutoffDate = new Date(Date.now() - p.retentionDays * 24 * 60 * 60 * 1000);
        if (candidate.timestamp > cutoffDate) {
          return false; // Item is newer than retention period
        }
      }
      // Access-count trigger: skip if item has been accessed more than the threshold
      if ((p as any).minAccessCount && candidate.metadata?.accessCount != null) {
        if (candidate.metadata.accessCount >= (p as any).minAccessCount) return false;
      }
      return true;
    }).sort((a,b) => (b.priority || 0) - (a.priority || 0));

    if (applicablePolicies.length === 0) {
      const withinRetention =
        candidate.timestamp &&
        this.config.defaultRetentionDays &&
        candidate.timestamp > new Date(Date.now() - this.config.defaultRetentionDays * 24 * 60 * 60 * 1000);
      const msg = withinRetention
        ? `Item within retention period; no lifecycle action required for item '${itemContext.itemId}'.`
        : `No applicable lifecycle policies found for item '${itemContext.itemId}'.`;
      console.log(`${logPreamble} ${msg}`);
      return { actionTaken: 'NO_ACTION_TAKEN', details: msg };
    }
    
    const policyToApply = applicablePolicies[0]; // Highest priority
    console.log(`${logPreamble} Applying policy '${policyToApply.policyId}'.`);

    const action = await this.negotiateAndDetermineAction(candidate, policyToApply);
    let reportForSingleItem: LifecycleEnforcementReport | undefined; // Create a mini-report for tracing this one action

    if (action && action !== 'NO_ACTION_TAKEN') {
  await this.executeLifecycleAction(candidate, policyToApply.action, action, policyToApply.policyId, reportForSingleItem);
      const detailsMsg = `Action '${action}' executed based on policy '${policyToApply.policyId}'.`;
      this.addTraceToReport(reportForSingleItem, candidate.id, policyToApply.policyId, action, detailsMsg);
      return { actionTaken: action, details: detailsMsg };
    }
    const detailsMsg = `No action executed for item '${itemContext.itemId}' based on policy '${policyToApply.policyId}' and GMI negotiation.`;
    this.addTraceToReport(reportForSingleItem, candidate.id, policyToApply.policyId, 'NO_ACTION_TAKEN', detailsMsg);
    return { actionTaken: 'NO_ACTION_TAKEN', details: detailsMsg };
  }

  public async checkHealth(): Promise<{ isHealthy: boolean; details?: Record<string, unknown>; dependencies?: any[] }> {
    // ... (implementation as previously provided, ensure all deps are checked) ...
    if (!this.isInitialized) return {isHealthy: false, details: {message: `MLM (ID: ${this.managerId}) not initialized.`}};
    const vsmHealth = await this.vectorStoreManager.checkHealth();
    const utilAIHealth = this.utilityAI ? await this.utilityAI.checkHealth() : {isHealthy: true, details: "UtilityAI not configured for MLM"};
    return {
        isHealthy: this.isInitialized && vsmHealth.isOverallHealthy && utilAIHealth.isHealthy,
        details: { managerId: this.managerId, status: 'Initialized', policyCount: this.config.policies.length, dryRunMode: this.config.dryRunMode },
        dependencies: [
            {name: 'VectorStoreManager', isHealthy: vsmHealth.isOverallHealthy, details: vsmHealth},
            {name: 'UtilityAI', isHealthy: utilAIHealth.isHealthy, details: utilAIHealth.details}
        ]
    };
  }

  public async shutdown(): Promise<void> {
    if (!this.isInitialized) {
      console.log(`MemoryLifecycleManager (ID: ${this.managerId}): Shutdown called but not initialized.`);
      return;
    }
    console.log(`MemoryLifecycleManager (ID: ${this.managerId}): Shutting down...`);
    if (this.periodicCheckTimer) {
      clearInterval(this.periodicCheckTimer);
      this.periodicCheckTimer = undefined;
    }
    this.isInitialized = false;
    console.log(`MemoryLifecycleManager (ID: ${this.managerId}) shut down successfully.`);
  }

  /**
   * Helper to add entries to the enforcement report's error/trace log.
   * This is an internal helper.
   * @param report The report to add to.
   * @param itemId ID of the item being processed.
   * @param policyId ID of the policy being applied.
   * @param action Action taken or intended.
   * @param message Descriptive message.
   * @param details Additional details.
   * @private
   */
  private addTraceToReport(
      report: LifecycleEnforcementReport | undefined,
      itemId: string | undefined,
      policyId: string | undefined,
      action: LifecycleAction | null | undefined,
      message: string,
      details?: any
  ): void {
      if (report && report.errors) { // Using 'errors' field as a general trace log for actions/errors
          report.errors.push({
              itemId,
              policyId,
              action: action || undefined, // Ensure action is string or undefined
              message,
              details
          });
      } else {
          // If no report (e.g. processSingleItem), just log to console
          console.debug(`MLM Trace (${this.managerId}): Item: ${itemId}, Policy: ${policyId}, Action: ${action}, Msg: ${message}`, details || '');
      }
  }
}
