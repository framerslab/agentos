/**
 * @file WorkflowFacade.ts
 * @module api/WorkflowFacade
 *
 * @description
 * Encapsulates all workflow-related lifecycle operations previously embedded
 * directly in `AgentOS`. This includes workflow engine initialization,
 * runtime bootstrapping, descriptor registration/deregistration, event
 * handling, and public CRUD methods for workflow definitions and instances.
 *
 * The class owns the `WorkflowEngine`, `WorkflowRuntime`, `IWorkflowStore`,
 * and `AgencyRegistry` instances. It receives its remaining dependencies
 * (extension manager, tool orchestrator, orchestrator for broadcasting,
 * streaming/GMI managers, logger) via constructor injection.
 *
 * AgentOS retains thin public delegates that forward to this facade, so the
 * external API surface remains unchanged.
 */

import type { ILogger } from '../../logging/ILogger';
import type { IToolOrchestrator } from '../../core/tools/IToolOrchestrator';
import type {
  ExtensionManager,
  ExtensionEvent,
  ExtensionEventListener,
  ExtensionLifecycleContext,
} from '../extensions';
import { EXTENSION_KIND_WORKFLOW } from '../extensions';
import type { WorkflowDescriptor } from '../../extensions/types';
import type { AgentOSOrchestrator } from './AgentOSOrchestrator';
import type { GMIManager } from '../../cognition/substrate/GMIManager';
import type { StreamingManager } from '../../core/streaming/StreamingManager';

import { WorkflowEngine } from '../../orchestration/workflows/WorkflowEngine';
import type {
  WorkflowEngineConfig,
  WorkflowEngineEventListener,
} from '../../orchestration/workflows/IWorkflowEngine';
import type {
  WorkflowDefinition,
  WorkflowDescriptorPayload,
  WorkflowEvent,
  WorkflowInstance,
  WorkflowProgressUpdate,
  WorkflowStatus,
} from '../../orchestration/workflows/WorkflowTypes';
import type {
  IWorkflowStore,
  WorkflowQueryOptions,
  WorkflowTaskUpdate,
} from '../../orchestration/workflows/storage/IWorkflowStore';
import { InMemoryWorkflowStore } from '../../orchestration/workflows/storage/InMemoryWorkflowStore';
import { WorkflowRuntime } from '../../orchestration/workflows/runtime/WorkflowRuntime';
import { AgencyRegistry } from '../../agents/agency/AgencyRegistry';

import type { AgentOSInput } from '../types/AgentOSInput';
import { AgentOSServiceError } from '../errors';
import { GMIErrorCode } from '../../core/utils/errors.js';

/**
 * Dependencies injected into the WorkflowFacade at construction time.
 * These are references to services owned and managed by AgentOS.
 */
export interface WorkflowFacadeDependencies {
  /** Extension manager for registry access and event subscription. */
  extensionManager: ExtensionManager;
  /** Logger scoped to the workflow subsystem. */
  logger: ILogger;
  /** Optional workflow engine configuration. */
  workflowEngineConfig?: WorkflowEngineConfig;
  /** Optional caller-supplied workflow store; defaults to in-memory. */
  workflowStore?: IWorkflowStore;
}

/**
 * Runtime dependencies that become available only after AgentOS finishes
 * bootstrapping the core services (GMI, streaming, tools). These are set
 * via {@link WorkflowFacade.setRuntimeDependencies} before calling
 * {@link WorkflowFacade.startRuntime}.
 */
export interface WorkflowFacadeRuntimeDependencies {
  gmiManager: GMIManager;
  streamingManager: StreamingManager;
  toolOrchestrator: IToolOrchestrator;
  /** The orchestrator used for broadcasting workflow progress updates. */
  orchestrator?: AgentOSOrchestrator;
}

/**
 * @class WorkflowFacade
 *
 * Owns the full workflow lifecycle: engine init, descriptor sync, runtime
 * start/stop, and public query/mutation methods. Extracted from AgentOS to
 * reduce the monolith's surface area.
 */
export class WorkflowFacade {
  private workflowEngine!: WorkflowEngine;
  private workflowStore!: IWorkflowStore;
  private workflowRuntime?: WorkflowRuntime;
  private agencyRegistry?: AgencyRegistry;
  private workflowEngineListener?: WorkflowEngineEventListener;
  private workflowExtensionListener?: ExtensionEventListener;

  private runtimeDeps?: WorkflowFacadeRuntimeDependencies;

  constructor(private readonly deps: WorkflowFacadeDependencies) {}

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Initialize the workflow engine, agency registry, register existing
   * descriptors, and wire up extension/engine event listeners.
   *
   * Must be called during the AgentOS `initialize()` sequence, before
   * core services (tool orchestrator, GMI, etc.) are fully ready. The
   * runtime can be started later via {@link startRuntime}.
   *
   * @param context - Extension lifecycle context forwarded to registries.
   */
  public async initialize(context: ExtensionLifecycleContext): Promise<void> {
    this.workflowStore = this.deps.workflowStore ?? new InMemoryWorkflowStore();
    this.workflowEngine = new WorkflowEngine();

    const workflowLogger =
      this.deps.logger.child?.({ component: 'WorkflowEngine' }) ?? this.deps.logger;
    await this.workflowEngine.initialize(this.deps.workflowEngineConfig ?? {}, {
      store: this.workflowStore,
      logger: workflowLogger,
    });

    const agencyLogger =
      this.deps.logger.child?.({ component: 'AgencyRegistry' }) ?? this.deps.logger;
    this.agencyRegistry = new AgencyRegistry(agencyLogger);

    await this.registerWorkflowDescriptorsFromRegistry();

    this.workflowExtensionListener = async (event: ExtensionEvent) => {
      if (!this.workflowEngine) {
        return;
      }
      if (event.type === 'descriptor:activated' && event.kind === EXTENSION_KIND_WORKFLOW) {
        const descriptor = event.descriptor as WorkflowDescriptor;
        await this.handleWorkflowDescriptorActivated({
          id: descriptor.id,
          payload: descriptor.payload,
        });
      } else if (
        event.type === 'descriptor:deactivated' &&
        event.kind === EXTENSION_KIND_WORKFLOW
      ) {
        const descriptor = event.descriptor as WorkflowDescriptor;
        await this.handleWorkflowDescriptorDeactivated({
          id: descriptor.id,
          payload: descriptor.payload,
        });
      }
    };
    this.deps.extensionManager.on(this.workflowExtensionListener);

    this.workflowEngineListener = async (event: WorkflowEvent) => {
      await this.handleWorkflowEngineEvent(event);
    };
    this.workflowEngine.onEvent(this.workflowEngineListener);
  }

  /**
   * Provide runtime dependencies that only become available after AgentOS
   * finishes initializing GMI, streaming, and tools. Must be called before
   * {@link startRuntime}.
   */
  public setRuntimeDependencies(runtimeDeps: WorkflowFacadeRuntimeDependencies): void {
    this.runtimeDeps = runtimeDeps;
  }

  /**
   * Start the workflow runtime. Requires that both {@link initialize} and
   * {@link setRuntimeDependencies} have been called.
   */
  public async startRuntime(): Promise<void> {
    if (!this.workflowEngine) {
      return;
    }
    if (this.workflowRuntime) {
      return;
    }
    if (!this.runtimeDeps) {
      this.deps.logger.warn(
        'Workflow runtime start skipped because runtime dependencies are not set.',
      );
      return;
    }
    const { gmiManager, streamingManager, toolOrchestrator } = this.runtimeDeps;
    if (!gmiManager || !streamingManager || !toolOrchestrator) {
      this.deps.logger.warn(
        'Workflow runtime start skipped because core dependencies are not ready.',
      );
      return;
    }

    if (!this.agencyRegistry) {
      const agencyLogger =
        this.deps.logger.child?.({ component: 'AgencyRegistry' }) ?? this.deps.logger;
      this.agencyRegistry = new AgencyRegistry(agencyLogger);
    }

    const runtimeLogger =
      this.deps.logger.child?.({ component: 'WorkflowRuntime' }) ?? this.deps.logger;
    this.workflowRuntime = new WorkflowRuntime({
      workflowEngine: this.workflowEngine,
      gmiManager,
      streamingManager,
      toolOrchestrator,
      extensionManager: this.deps.extensionManager,
      agencyRegistry: this.agencyRegistry,
      logger: runtimeLogger,
    });
    await this.workflowRuntime.start();
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  /**
   * Gracefully shut down all workflow-owned resources: listeners, runtime,
   * engine, agency registry.
   */
  public async shutdown(): Promise<void> {
    if (this.workflowEngineListener && this.workflowEngine) {
      this.workflowEngine.offEvent(this.workflowEngineListener);
      this.workflowEngineListener = undefined;
    }
    if (this.workflowExtensionListener && this.deps.extensionManager) {
      this.deps.extensionManager.off(this.workflowExtensionListener);
      this.workflowExtensionListener = undefined;
    }
    if (this.workflowRuntime) {
      await this.workflowRuntime.stop();
      this.workflowRuntime = undefined;
    }
    this.agencyRegistry = undefined;
  }

  // ---------------------------------------------------------------------------
  // Public query / mutation helpers (used by AgentOS delegates)
  // ---------------------------------------------------------------------------

  /**
   * List all registered workflow definitions.
   *
   * @returns An array of workflow definitions known to the engine.
   */
  public listWorkflowDefinitions(): WorkflowDefinition[] {
    return this.workflowEngine.listWorkflowDefinitions();
  }

  /**
   * Start a new workflow instance from the given definition.
   *
   * @param definitionId - The ID of the workflow definition to instantiate.
   * @param input        - The AgentOS input triggering the workflow.
   * @param options      - Optional overrides for the workflow instance.
   * @returns The newly created workflow instance.
   * @throws {AgentOSServiceError} When the definition is not found.
   */
  public async startWorkflow(
    definitionId: string,
    input: AgentOSInput,
    options: {
      workflowId?: string;
      conversationId?: string;
      createdByUserId?: string;
      context?: Record<string, unknown>;
      roleAssignments?: Record<string, string>;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<WorkflowInstance> {
    const definition = this.workflowEngine
      .listWorkflowDefinitions()
      .find((item) => item.id === definitionId);
    if (!definition) {
      throw new AgentOSServiceError(
        `Workflow definition '${definitionId}' not found.`,
        GMIErrorCode.CONFIGURATION_ERROR,
        { definitionId },
      );
    }
    return this.workflowEngine.startWorkflow({
      input,
      definition,
      workflowId: options.workflowId,
      conversationId: options.conversationId,
      createdByUserId: options.createdByUserId,
      context: options.context,
      roleAssignments: options.roleAssignments,
      metadata: options.metadata,
    });
  }

  /**
   * Retrieve a single workflow instance by ID.
   *
   * @param workflowId - The unique identifier of the workflow.
   * @returns The workflow instance, or `null` if not found.
   */
  public async getWorkflow(workflowId: string): Promise<WorkflowInstance | null> {
    return this.workflowEngine.getWorkflow(workflowId);
  }

  /**
   * List workflow instances, optionally filtered by query options.
   *
   * @param options - Optional filter/sort/pagination criteria.
   * @returns An array of matching workflow instances.
   */
  public async listWorkflows(options?: WorkflowQueryOptions): Promise<WorkflowInstance[]> {
    return this.workflowEngine.listWorkflows(options);
  }

  /**
   * Retrieve progress information for a given workflow.
   *
   * @param workflowId     - The workflow to query.
   * @param sinceTimestamp  - Optional ISO-8601 timestamp; only return events after this point.
   * @returns Progress update payload, or `null` if not found.
   */
  public async getWorkflowProgress(
    workflowId: string,
    sinceTimestamp?: string,
  ): Promise<WorkflowProgressUpdate | null> {
    return this.workflowEngine.getWorkflowProgress(workflowId, sinceTimestamp);
  }

  /**
   * Update the status of a workflow instance.
   *
   * @param workflowId - Target workflow.
   * @param status     - New status to apply.
   * @returns The updated workflow instance, or `null` if not found.
   */
  public async updateWorkflowStatus(
    workflowId: string,
    status: WorkflowStatus,
  ): Promise<WorkflowInstance | null> {
    return this.workflowEngine.updateWorkflowStatus(workflowId, status);
  }

  /**
   * Apply a batch of task-level updates to a workflow instance.
   *
   * @param workflowId - Target workflow.
   * @param updates    - Array of task updates.
   * @returns The updated workflow instance, or `null` if not found.
   */
  public async applyWorkflowTaskUpdates(
    workflowId: string,
    updates: WorkflowTaskUpdate[],
  ): Promise<WorkflowInstance | null> {
    return this.workflowEngine.applyTaskUpdates(workflowId, updates);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Register all active workflow descriptors found in the extension registry.
   */
  private async registerWorkflowDescriptorsFromRegistry(): Promise<void> {
    const registry =
      this.deps.extensionManager.getRegistry<WorkflowDescriptorPayload>(EXTENSION_KIND_WORKFLOW);
    const activeDescriptors = registry.listActive();
    for (const descriptor of activeDescriptors) {
      await this.handleWorkflowDescriptorActivated({
        id: descriptor.id,
        payload: descriptor.payload,
      });
    }
  }

  /**
   * Handle activation of a workflow descriptor by registering it with the engine.
   */
  private async handleWorkflowDescriptorActivated(descriptor: {
    id: string;
    payload: WorkflowDescriptorPayload;
  }): Promise<void> {
    try {
      await this.workflowEngine.registerWorkflowDescriptor(descriptor.payload);
      this.deps.logger.debug?.('Workflow descriptor registered', {
        descriptorId: descriptor.id,
        workflowDefinitionId: descriptor.payload.definition.id,
      });
    } catch (error) {
      this.deps.logger.error('Failed to register workflow descriptor', {
        descriptorId: descriptor.id,
        workflowDefinitionId: descriptor.payload.definition.id,
        error,
      });
    }
  }

  /**
   * Handle deactivation of a workflow descriptor by unregistering it from the engine.
   */
  private async handleWorkflowDescriptorDeactivated(descriptor: {
    id: string;
    payload: WorkflowDescriptorPayload;
  }): Promise<void> {
    try {
      await this.workflowEngine.unregisterWorkflowDescriptor(descriptor.payload.definition.id);
      this.deps.logger.debug?.('Workflow descriptor unregistered', {
        descriptorId: descriptor.id,
        workflowDefinitionId: descriptor.payload.definition.id,
      });
    } catch (error) {
      this.deps.logger.error('Failed to unregister workflow descriptor', {
        descriptorId: descriptor.id,
        workflowDefinitionId: descriptor.payload.definition.id,
        error,
      });
    }
  }

  /**
   * Handle a workflow engine event by emitting a progress update.
   */
  private async handleWorkflowEngineEvent(event: WorkflowEvent): Promise<void> {
    try {
      await this.emitWorkflowUpdate(event.workflowId);
    } catch (error) {
      this.deps.logger.error('Failed to handle workflow engine event', {
        workflowId: event.workflowId,
        eventType: event.type,
        error,
      });
    }
  }

  /**
   * Emit a workflow progress update via the orchestrator's broadcast channel.
   */
  private async emitWorkflowUpdate(workflowId: string): Promise<void> {
    if (!this.workflowEngine) {
      return;
    }
    try {
      const update = await this.workflowEngine.getWorkflowProgress(workflowId);
      if (!update) {
        return;
      }
      this.deps.logger.debug?.('Workflow progress update ready', {
        workflowId,
        status: update.workflow.status,
      });
      if (
        this.runtimeDeps?.orchestrator &&
        typeof this.runtimeDeps.orchestrator.broadcastWorkflowUpdate === 'function'
      ) {
        await this.runtimeDeps.orchestrator.broadcastWorkflowUpdate(update);
      } else {
        this.deps.logger.warn(
          'Workflow update could not be broadcast - orchestrator unavailable',
          { workflowId },
        );
      }
    } catch (error) {
      this.deps.logger.error('Failed to generate workflow progress update', {
        workflowId,
        error,
      });
    }
  }
}
