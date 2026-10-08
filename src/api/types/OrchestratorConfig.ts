/**
 * @fileoverview Configuration types for the AgentOSOrchestrator.
 * Extracted from AgentOSOrchestrator.ts for readability.
 */

import type { RollingSummaryCompactionConfig } from '../../core/conversation/RollingSummaryCompactor';
import type { PromptProfileConfig } from '../structured/prompting/PromptProfileRouter';
import type { GMIManager } from '../../cognition/substrate/GMIManager';
import type { IToolOrchestrator } from '../../core/tools/IToolOrchestrator';
import type { ConversationManager } from '../../core/conversation/ConversationManager';
import type { StreamingManager } from '../../core/streaming/StreamingManager';
import type { AIModelProviderManager } from '../../core/llm/providers/AIModelProviderManager';
import type { ITurnPlanner } from '../../orchestration/turn-planner/TurnPlanner';
import type { IRollingSummaryMemorySink } from '../../core/conversation/IRollingSummaryMemorySink';
import type { ILongTermMemoryRetriever } from '../../core/conversation/ILongTermMemoryRetriever';
import type { ISpendMeter } from '../../safety/runtime/SpendMeter';

// ---------------------------------------------------------------------------
// Rolling Summary Compaction Profiles
// ---------------------------------------------------------------------------

export interface RollingSummaryCompactionProfileDefinition {
  config: RollingSummaryCompactionConfig;
  systemPrompt?: string;
}

export interface RollingSummaryCompactionProfilesConfig {
  defaultProfileId: string;
  defaultProfileByMode?: Record<string, string>;
  profiles: Record<string, RollingSummaryCompactionProfileDefinition>;
}

// ---------------------------------------------------------------------------
// Long-Term Memory Recall
// ---------------------------------------------------------------------------

export type LongTermMemoryRecallProfile =
  | 'aggressive'
  | 'balanced'
  | 'conservative';

export interface AgentOSLongTermMemoryRecallConfig {
  profile?: LongTermMemoryRecallProfile;
  cadenceTurns?: number;
  forceOnCompaction?: boolean;
  maxContextChars?: number;
  topKByScope?: Partial<Record<'user' | 'persona' | 'organization', number>>;
}

// ---------------------------------------------------------------------------
// Tenant Routing
// ---------------------------------------------------------------------------

export type TenantRoutingMode = 'multi_tenant' | 'single_tenant';

export interface AgentOSTenantRoutingConfig {
  mode?: TenantRoutingMode;
  defaultOrganizationId?: string;
  strictOrganizationIsolation?: boolean;
}

// ---------------------------------------------------------------------------
// Task Outcome Telemetry
// ---------------------------------------------------------------------------

export type TaskOutcomeTelemetryScope =
  | 'global'
  | 'organization'
  | 'organization_persona';

export interface AgentOSTaskOutcomeTelemetryConfig {
  enabled?: boolean;
  rollingWindowSize?: number;
  scope?: TaskOutcomeTelemetryScope;
  emitAlerts?: boolean;
  alertBelowWeightedSuccessRate?: number;
  alertMinSamples?: number;
  alertCooldownMs?: number;
}

// ---------------------------------------------------------------------------
// Adaptive Execution
// ---------------------------------------------------------------------------

export interface AgentOSAdaptiveExecutionConfig {
  enabled?: boolean;
  minSamples?: number;
  minWeightedSuccessRate?: number;
  forceAllToolsWhenDegraded?: boolean;
  forceFailOpenWhenDegraded?: boolean;
}

// ---------------------------------------------------------------------------
// Telemetry Store Interface
// ---------------------------------------------------------------------------

export type TaskOutcomeKpiWindowEntry = {
  status: 'success' | 'partial' | 'failed';
  score: number;
  timestamp: number;
};

export interface ITaskOutcomeTelemetryStore {
  loadWindows(): Promise<Record<string, TaskOutcomeKpiWindowEntry[]>>;
  saveWindow(scopeKey: string, entries: TaskOutcomeKpiWindowEntry[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Orchestrator Config & Dependencies
// ---------------------------------------------------------------------------

export interface AgentOSOrchestratorConfig {
  maxToolCallIterations?: number;
  defaultAgentTurnTimeoutMs?: number;
  enableConversationalPersistence?: boolean;
  promptProfileConfig?: PromptProfileConfig | null;
  rollingSummaryCompactionConfig?: RollingSummaryCompactionConfig | null;
  rollingSummaryCompactionProfilesConfig?: RollingSummaryCompactionProfilesConfig | null;
  rollingSummarySystemPrompt?: string;
  rollingSummaryStateKey?: string;
  longTermMemoryRecall?: AgentOSLongTermMemoryRecallConfig;
  tenantRouting?: AgentOSTenantRoutingConfig;
  taskOutcomeTelemetry?: AgentOSTaskOutcomeTelemetryConfig;
  adaptiveExecution?: AgentOSAdaptiveExecutionConfig;
}

export interface AgentOSOrchestratorDependencies {
  gmiManager: GMIManager;
  toolOrchestrator: IToolOrchestrator;
  conversationManager: ConversationManager;
  streamingManager: StreamingManager;
  modelProviderManager: AIModelProviderManager;
  turnPlanner?: ITurnPlanner;
  rollingSummaryMemorySink?: IRollingSummaryMemorySink;
  longTermMemoryRetriever?: ILongTermMemoryRetriever;
  taskOutcomeTelemetryStore?: ITaskOutcomeTelemetryStore;
  /** The spend meter `processRequest` reserved against; the turn heartbeats and settles the reservation by `input.operationId`. */
  spendMeter?: ISpendMeter;
}
