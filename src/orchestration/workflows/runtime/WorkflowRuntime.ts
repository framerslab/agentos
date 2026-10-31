import { uuidv4 } from '../../../core/utils/uuid';

import type { WorkflowEngine } from '../WorkflowEngine';
import type {
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowInstance,
  WorkflowTaskDefinition,
} from '../WorkflowTypes';
import { WorkflowTaskStatus } from '../WorkflowTypes';
import type { GMIManager, GMIAgencyContextOptions } from '../../../cognition/substrate/GMIManager';
import type { StreamingManager } from '../../../core/streaming/StreamingManager';
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator';
import type { ILogger } from '../../../core/logging/ILogger';
import { AgencyRegistry } from '../../../agents/agency/AgencyRegistry';
import type { AgencySeatState, AgencySession } from '../../../agents/agency/AgencyTypes';
import {
  AgentOSResponseChunkType,
  type AgentOSAgencyUpdateChunk,
} from '../../../api/types/AgentOSResponse';
import {
  GMIInteractionType,
  type GMIOutputChunk,
  GMIOutputChunkType,
  type GMITurnInput,
  type CostAggregator,
} from '../../../cognition/substrate/IGMI';
import type { PersonaEvolutionContext } from '../../../cognition/substrate/persona_overlays/PersonaOverlayTypes';
import type { ToolExecutionRequestDetails } from '../../../core/tools/ToolExecutor';
import type { UserContext } from '../../../cognition/substrate/IGMI';
import type { ToolCallResult } from '../../../cognition/substrate/IGMI';
import {
  EXTENSION_KIND_WORKFLOW_EXECUTOR,
  type WorkflowExtensionExecutor,
  type WorkflowExtensionExecutionResult,
} from '../../../extensions/types';
import type { ExtensionManager } from '../../../extensions';

/**
 * Dependencies required to bootstrap the workflow runtime.
 */
export interface WorkflowRuntimeDependencies {
  workflowEngine: WorkflowEngine;
  gmiManager: GMIManager;
  streamingManager: StreamingManager;
  toolOrchestrator: IToolOrchestrator;
  agencyRegistry?: AgencyRegistry;
  extensionManager: ExtensionManager;
  logger?: ILogger;
}

/**
 * Lightweight coordinator that listens for workflow engine events and schedules task execution.
 * @remarks
 * The current implementation sets up scaffolding for future multi-GMI orchestration. Execution handlers
 * will be fleshed out as persona overlays, tool dispatchers, and guardrail hooks are implemented.
 */
class ConcurrencyQueue {
  private running = 0;
  private readonly queue: Array<() => void> = [];
  private readonly idleResolvers: Array<() => void> = [];

  constructor(private readonly concurrency: number) {}

  public add<T>(task: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const execute = async (): Promise<void> => {
        this.running += 1;
        try {
          const result = await task();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.running -= 1;
          this.dequeue();
        }
      };

      if (this.running < this.concurrency) {
        void execute();
      } else {
        this.queue.push(execute);
      }
    });
  }

  public async onIdle(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) {
      return;
    }
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  public clear(): void {
    this.queue.length = 0;
  }

  private dequeue(): void {
    if (this.queue.length > 0 && this.running < this.concurrency) {
      const next = this.queue.shift();
      if (next) {
        next();
      }
      return;
    }

    if (this.running === 0 && this.queue.length === 0) {
      this.resolveIdle();
    }
  }

  private resolveIdle(): void {
    if (!this.idleResolvers.length) {
      return;
    }
    const resolvers = this.idleResolvers.splice(0, this.idleResolvers.length);
    for (const resolve of resolvers) {
      resolve();
    }
  }
}

export class WorkflowRuntime {
  private readonly queue = new ConcurrencyQueue(4);
  private readonly agencyRegistry: AgencyRegistry;
  private readonly extensionManager: ExtensionManager;
  private workflowListener?: (event: WorkflowEvent) => void | Promise<void>;
  private started = false;
  private readonly definitionCache = new Map<string, WorkflowDefinition>();

  constructor(private readonly deps: WorkflowRuntimeDependencies) {
    this.agencyRegistry = deps.agencyRegistry ?? new AgencyRegistry(deps.logger?.child?.({ component: 'AgencyRegistry' }));
    this.extensionManager = deps.extensionManager;
  }

  /**
   * Begins listening to workflow engine events and prepares the execution queue.
   */
  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    const listener = async (event: WorkflowEvent): Promise<void> => {
      await this.handleWorkflowEvent(event);
    };
    this.workflowListener = listener;
    this.deps.workflowEngine.onEvent(listener);
    this.started = true;
    this.deps.logger?.info?.('Workflow runtime started.');
  }

  /**
   * Stops the runtime, drains queued tasks, and detaches event listeners.
   */
  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    if (this.workflowListener) {
      this.deps.workflowEngine.offEvent(this.workflowListener);
      this.workflowListener = undefined;
    }
    await this.queue.onIdle();
    this.deps.logger?.info?.('Workflow runtime stopped.');
  }

  /**
   * Handles workflow engine events. At this stage we only log structural changes; execution
   * hooks will be connected as the multi-GMI runtime evolves.
   */
  private async handleWorkflowEvent(event: WorkflowEvent): Promise<void> {
    switch (event.type) {
      case 'workflow_created': {
        this.deps.logger?.debug?.('WorkflowRuntime observed workflow creation', {
          workflowId: event.workflowId,
          definitionId: event.definitionId,
        });
        break;
      }
      case 'task_status_changed': {
        if (!event.taskId || !event.payload) {
          return;
        }
        const status = (event.payload as { status?: string }).status;
        if (status === 'ready') {
          this.queue.add(() => this.enqueueTaskExecution(event.workflowId, event.definitionId, event.taskId!));
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Enqueues a single workflow task for execution.
   * @param workflowId - Identifier of the workflow instance.
   * @param definitionId - Identifier of the workflow definition.
   * @param taskId - Identifier of the task ready for execution.
   */
   
  private async enqueueTaskExecution(workflowId: string, definitionId: string, taskId: string): Promise<void> {
    const definition = this.getWorkflowDefinition(definitionId);
    if (!definition) {
      this.deps.logger?.error?.('WorkflowRuntime: definition not found', { workflowId, definitionId });
      return;
    }

    const taskDefinition = definition.tasks.find((task) => task.id === taskId);
    if (!taskDefinition) {
      this.deps.logger?.error?.('WorkflowRuntime: task definition not found', { workflowId, definitionId, taskId });
      return;
    }

    const instance = await this.deps.workflowEngine.getWorkflow(workflowId);
    if (!instance) {
      this.deps.logger?.warn?.('WorkflowRuntime: workflow instance not found', { workflowId });
      return;
    }

    try {
      switch (taskDefinition.executor.type) {
        case 'gmi':
          await this.executeGmiTask(definition, taskDefinition, instance);
          break;
        case 'tool':
          await this.executeToolTask(definition, taskDefinition, instance);
          break;
        case 'extension':
          await this.executeExtensionTask(definition, taskDefinition, instance);
          break;
        default:
          this.deps.logger?.warn?.('WorkflowRuntime: executor type not yet supported', {
            workflowId,
            taskId,
            executorType: taskDefinition.executor.type,
          });
          await this.deps.workflowEngine.applyTaskUpdates(workflowId, [
            {
              taskId,
              status: WorkflowTaskStatus.COMPLETED,
              completedAt: new Date().toISOString(),
              metadata: { note: 'Execution skipped (unsupported executor type).' },
            },
          ]);
          break;
      }
    } catch (error) {
      this.deps.logger?.error?.('WorkflowRuntime: task execution error', {
        workflowId,
        taskId,
        error,
      });
      await this.deps.workflowEngine.applyTaskUpdates(workflowId, [
        {
          taskId,
          status: WorkflowTaskStatus.FAILED,
          completedAt: new Date().toISOString(),
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        },
      ]);
    }
  }

  /**
   * Helper used by future implementations to resolve a task definition from the workflow definition catalogue.
   * Provided here to keep the scaffolding self-contained.
   */
  protected resolveTaskDefinition(definitionId: string, taskId: string): WorkflowTaskDefinition | undefined {
    const definition = this.getWorkflowDefinition(definitionId);
    return definition?.tasks.find((task) => task.id === taskId);
  }

  /**
   * Emits an Agency update to downstream consumers. Placeholder implementation until the runtime
   * fully manages stream identifiers per Agency seat.
   */
  protected async emitAgencyUpdate(session: AgencySession): Promise<void> {
    const seats = Object.values(session.seats).map((seat) => {
      const latestHistory = seat.history?.[seat.history.length - 1];
      const status = (latestHistory?.status ?? seat.metadata?.status ?? 'pending') as string;
      return {
        roleId: seat.roleId,
        gmiInstanceId: seat.gmiInstanceId,
        personaId: seat.personaId,
        metadata: {
          ...(seat.metadata ?? {}),
          status,
          lastOutputPreview: latestHistory?.outputPreview ?? seat.metadata?.lastOutputPreview,
          history: seat.history,
        },
      };
    });

    const isFinal =
      seats.length > 0 &&
      seats.every((seat) => {
        const status = (seat.metadata?.status as string | undefined) ?? 'pending';
        return status === 'completed' || status === 'failed';
      });

    const chunk: AgentOSAgencyUpdateChunk = {
      type: AgentOSResponseChunkType.AGENCY_UPDATE,
      streamId: session.conversationId,
      gmiInstanceId: `agency:${session.agencyId}`,
      personaId: `agency:${session.agencyId}`,
      isFinal,
      timestamp: new Date().toISOString(),
      agency: {
        agencyId: session.agencyId,
        workflowId: session.workflowId,
        conversationId: session.conversationId,
        seats,
        metadata: session.metadata,
      },
    };

    try {
      await this.deps.streamingManager.pushChunk(session.conversationId, chunk);
    } catch (error) {
      this.deps.logger?.error?.('WorkflowRuntime: failed to emit agency update', {
        agencyId: session.agencyId,
        error,
      });
    }
  }

  private getWorkflowDefinition(definitionId: string): WorkflowDefinition | undefined {
    let definition = this.definitionCache.get(definitionId);
    if (!definition) {
      const allDefinitions = this.deps.workflowEngine.listWorkflowDefinitions();
      definition = allDefinitions.find((def) => def.id === definitionId);
      if (definition) {
        this.definitionCache.set(definitionId, definition);
      }
    }
    return definition;
  }

  private async executeGmiTask(
    workflowDefinition: WorkflowDefinition,
    taskDefinition: WorkflowTaskDefinition,
    instance: WorkflowInstance,
  ): Promise<void> {
    const { workflowId } = instance;
    const taskId = taskDefinition.id;
    const roleId = taskDefinition.executor.roleId;
    const personaId =
      taskDefinition.executor.personaId ??
      workflowDefinition.roles?.find((role) => role.roleId === roleId)?.personaId;

    if (!roleId || !personaId) {
      throw new Error(`Missing role or persona configuration for task '${taskId}'.`);
    }

    const startedAt = new Date().toISOString();
    await this.deps.workflowEngine.applyTaskUpdates(workflowId, [
      { taskId, status: WorkflowTaskStatus.IN_PROGRESS, startedAt },
    ]);

    const conversationId = instance.conversationId ?? instance.workflowId;
    const userId = instance.createdByUserId ?? 'system';

    const agencySession = this.agencyRegistry.upsertAgency({ workflowId, conversationId });
    const roleDefinition = workflowDefinition.roles?.find((role) => role.roleId === roleId);
    const priorSeatState = agencySession.seats[roleId];
    const agencyOptions: GMIAgencyContextOptions = {
      agencyId: agencySession.agencyId,
      roleId,
      workflowId,
      evolutionRules: roleDefinition?.evolutionRules ?? [],
      evolutionContext: this.buildEvolutionContext(workflowId, agencySession.agencyId, roleId, priorSeatState),
    };

    const { gmi, conversationContext } = await this.deps.gmiManager.getOrCreateGMIForSession(
      userId,
      conversationId,
      personaId,
      conversationId,
      undefined,
      undefined,
      undefined,
      agencyOptions,
    );

    this.agencyRegistry.registerSeat({
      agencyId: agencySession.agencyId,
      roleId,
      gmiInstanceId: gmi.gmiId,
      personaId,
      metadata: roleDefinition?.metadata,
    });
    this.agencyRegistry.mergeSeatMetadata(agencySession.agencyId, roleId, {
      status: 'running',
      lastTaskId: taskId,
      lastUpdatedAt: new Date().toISOString(),
    });

    const runningSession = this.agencyRegistry.getAgency(agencySession.agencyId);
    if (runningSession) {
      await this.emitAgencyUpdate(runningSession);
      await this.syncWorkflowAgencyState(runningSession, workflowId);
    }

    const instructions =
      taskDefinition.executor.instructions ??
      `Complete workflow task '${taskDefinition.name}' for workflow '${workflowDefinition.displayName}'.`;

    const turnInput: GMITurnInput = {
      interactionId: `${workflowId}-${taskId}-${uuidv4()}`,
      userId,
      sessionId: conversationId,
      type: GMIInteractionType.TEXT,
      content: instructions,
      metadata: {
        workflowId,
        taskId,
        agencyId: agencySession.agencyId,
        roleId,
      },
      timestamp: new Date(),
    };

    try {
      const { text: taskOutputText } = await this.collectGmiResponse(gmi.processTurnStream(turnInput));
      conversationContext.setMetadata?.('latestTaskOutput', taskOutputText);

      const outputPreview = this.buildOutputPreview(taskOutputText);
      this.agencyRegistry.appendSeatHistory(agencySession.agencyId, roleId, {
        taskId,
        timestamp: new Date().toISOString(),
        status: 'completed',
        outputPreview,
        metadata: { executor: 'gmi' },
      });
      this.agencyRegistry.mergeSeatMetadata(agencySession.agencyId, roleId, {
        status: 'completed',
        lastOutputPreview: outputPreview,
        lastTaskId: taskId,
        lastUpdatedAt: new Date().toISOString(),
      });

      const completedSession = this.agencyRegistry.getAgency(agencySession.agencyId);
      if (completedSession) {
        await this.emitAgencyUpdate(completedSession);
        await this.syncWorkflowAgencyState(completedSession, workflowId);
      }

      await this.deps.workflowEngine.applyTaskUpdates(workflowId, [
        {
          taskId,
          status: WorkflowTaskStatus.COMPLETED,
          completedAt: new Date().toISOString(),
          output: { text: taskOutputText },
        },
      ]);
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : String(error);
      this.agencyRegistry.appendSeatHistory(agencySession.agencyId, roleId, {
        taskId,
        timestamp: new Date().toISOString(),
        status: 'failed',
        outputPreview: failureMessage,
        metadata: { executor: 'gmi' },
      });
      this.agencyRegistry.mergeSeatMetadata(agencySession.agencyId, roleId, {
        status: 'failed',
        lastError: failureMessage,
        lastTaskId: taskId,
        lastUpdatedAt: new Date().toISOString(),
      });

      const failedSession = this.agencyRegistry.getAgency(agencySession.agencyId);
      if (failedSession) {
        await this.emitAgencyUpdate(failedSession);
        await this.syncWorkflowAgencyState(failedSession, workflowId);
      }

      throw error;
    }
  }

  /**
   * Runs a tool task through the tool orchestrator, which applies the disabled list, the permission check and the
   * approval a direct call meets. The task is the workflow's, not a call a model requested, so the output guardrails
   * that evaluate tool calls never judge it.
   */
  private async executeToolTask(
    workflowDefinition: WorkflowDefinition,
    taskDefinition: WorkflowTaskDefinition,
    instance: WorkflowInstance,
  ): Promise<void> {
    const workflowId = instance.workflowId;
    const taskId = taskDefinition.id;
    const toolName =
      taskDefinition.executor.extensionId ??
      (taskDefinition.metadata?.toolName as string | undefined);
    if (!toolName) {
      throw new Error(`Tool task '${taskId}' is missing executor.extensionId or metadata.toolName`);
    }

    const startedAt = new Date().toISOString();
    await this.deps.workflowEngine.applyTaskUpdates(workflowId, [
      { taskId, status: WorkflowTaskStatus.IN_PROGRESS, startedAt },
    ]);

    const roleId = taskDefinition.executor.roleId;
    const roleDefinition = workflowDefinition.roles?.find((role) => role.roleId === roleId);
    const toolArgs = (taskDefinition.metadata?.toolArgs ?? {}) as Record<string, unknown>;
    const userId = instance.createdByUserId ?? 'system';

    const requestDetails: ToolExecutionRequestDetails = {
      toolCallRequest: {
        id: `${workflowId}-${taskId}-tool-call`,
        name: toolName,
        arguments: toolArgs,
      },
      gmiId: `workflow-tool-executor-${workflowId}`,
      personaId: taskDefinition.executor.personaId ?? roleDefinition?.personaId ?? 'workflow-tool-agent',
      personaCapabilities: roleDefinition?.personaCapabilityRequirements ?? [],
      userContext: { userId } as UserContext,
      correlationId: `${workflowId}-${taskId}`,
    };

    let toolResult: ToolCallResult | undefined;
    try {
      toolResult = await this.deps.toolOrchestrator.processToolCall(requestDetails);
    } catch (error) {
      await this.deps.workflowEngine.applyTaskUpdates(workflowId, [
        {
          taskId,
          status: WorkflowTaskStatus.FAILED,
          completedAt: new Date().toISOString(),
          error: { message: error instanceof Error ? error.message : String(error) },
        },
      ]);
      throw error;
    }

    const success = !!toolResult && !toolResult.isError;
    await this.deps.workflowEngine.applyTaskUpdates(workflowId, [
      {
        taskId,
        status: success ? WorkflowTaskStatus.COMPLETED : WorkflowTaskStatus.FAILED,
        completedAt: new Date().toISOString(),
        output: toolResult?.output,
        error: success
          ? undefined
          : {
              message:
                (toolResult?.errorDetails as { message?: string } | undefined)?.message ??
                'Tool execution reported failure',
            },
      },
    ]);
  }

  private async executeExtensionTask(
    workflowDefinition: WorkflowDefinition,
    taskDefinition: WorkflowTaskDefinition,
    instance: WorkflowInstance,
  ): Promise<void> {
    const workflowId = instance.workflowId;
    const taskId = taskDefinition.id;
    const executorId = taskDefinition.executor.extensionId;
    if (!executorId) {
      throw new Error(`Extension task '${taskId}' is missing executor.extensionId.`);
    }

    const registry = this.extensionManager.getRegistry<WorkflowExtensionExecutor>(
      EXTENSION_KIND_WORKFLOW_EXECUTOR,
    );
    const activeDescriptor = registry.getActive(executorId);
    if (!activeDescriptor) {
      throw new Error(`No workflow executor extension registered with id '${executorId}'.`);
    }

    await this.deps.workflowEngine.applyTaskUpdates(workflowId, [
      { taskId, status: WorkflowTaskStatus.IN_PROGRESS, startedAt: new Date().toISOString() },
    ]);

    let result: WorkflowExtensionExecutionResult | undefined;
    try {
      result = await activeDescriptor.payload({
        workflow: instance,
        task: taskDefinition,
      });
    } catch (error) {
      await this.deps.workflowEngine.applyTaskUpdates(workflowId, [
        {
          taskId,
          status: WorkflowTaskStatus.FAILED,
          completedAt: new Date().toISOString(),
          error: { message: error instanceof Error ? error.message : String(error) },
        },
      ]);
      throw error;
    }

    await this.deps.workflowEngine.applyTaskUpdates(workflowId, [
      {
        taskId,
        status: result?.status ?? WorkflowTaskStatus.COMPLETED,
        completedAt: new Date().toISOString(),
        output: result?.output,
        metadata: result?.metadata,
      },
    ]);
  }

  private async collectGmiResponse(
    stream: AsyncGenerator<GMIOutputChunk, unknown, undefined>,
  ): Promise<{ text: string; usage?: CostAggregator }> {
    let aggregated = '';
    let usage: CostAggregator | undefined;

    for await (const chunk of stream) {
      switch (chunk.type) {
        case GMIOutputChunkType.TEXT_DELTA:
          if (typeof chunk.content === 'string') {
            aggregated += chunk.content;
          }
          break;
        case GMIOutputChunkType.FINAL_RESPONSE_MARKER:
          if (typeof chunk.content === 'string') {
            aggregated += chunk.content;
          } else if (chunk.content && (chunk.content as any).finalResponseText) {
            aggregated += String((chunk.content as any).finalResponseText);
          }
          if (chunk.content && typeof chunk.content === 'object' && (chunk.content as any).usage) {
            usage = (chunk.content as any).usage as CostAggregator;
          }
          break;
        default:
          break;
      }
    }

    return { text: aggregated, usage };
  }

  private buildOutputPreview(text: string, maxLength = 600): string {
    if (!text) {
      return '';
    }
    const normalized = text.trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
  }

  private buildEvolutionContext(
    workflowId: string,
    agencyId: string,
    roleId: string,
    seatState?: AgencySeatState,
  ): PersonaEvolutionContext {
    const history = seatState?.history ?? [];
    const recentOutputs = history
      .slice(-3)
      .map((entry) =>
        entry.outputPreview
          ? { taskId: entry.taskId ?? 'unknown_task', output: entry.outputPreview }
          : undefined,
      )
      .filter((entry): entry is { taskId: string; output: string } => Boolean(entry));

    return {
      workflowId,
      agencyId,
      roleId,
      recentOutputs: recentOutputs.length > 0 ? recentOutputs : undefined,
      metadata: {
        lastEvent: history.at(-1)?.status,
        seatMetadata: seatState?.metadata,
      },
    };
  }

  private async syncWorkflowAgencyState(session: AgencySession, workflowId: string): Promise<void> {
    await this.deps.workflowEngine.updateWorkflowAgencyState(workflowId, {
      agencyId: session.agencyId,
      seats: Object.fromEntries(
        Object.entries(session.seats).map(([role, seat]) => [
          role,
          {
            roleId: role,
            gmiInstanceId: seat.gmiInstanceId,
            personaId: seat.personaId,
            attachedAt: seat.attachedAt,
            metadata: seat.metadata,
            history: seat.history,
          },
        ]),
      ),
      metadata: session.metadata,
    });
  }
}
