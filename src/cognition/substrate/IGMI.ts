// File: backend/agentos/cognitive_substrate/IGMI.ts
/**
 * @fileoverview Defines the core interface (IGMI) for a Generalized Mind Instance,
 * its configuration, inputs, outputs, states, and related data structures.
 * The GMI is the central cognitive engine in AgentOS.
 * @module backend/agentos/cognitive_substrate/IGMI
 */

import { IPersonaDefinition } from './personas/IPersonaDefinition';
import { IWorkingMemory } from './memory/IWorkingMemory';
import { IPromptEngine } from '../../core/llm/IPromptEngine';
import { IRetrievalAugmentor } from '../rag/IRetrievalAugmentor';
import type { ConversationMessage } from '../../core/conversation/ConversationMessage';
// Assuming AIModelProviderManager is correctly exported from this path
import { AIModelProviderManager } from '../../core/llm/providers/AIModelProviderManager';
import { IUtilityAI } from '../nlp/ai_utilities/IUtilityAI';
// Assuming IToolOrchestrator is correctly exported from this path
import { IToolOrchestrator } from '../../core/tools/IToolOrchestrator';
import { ModelUsage } from '../../core/llm/providers/IProvider';

/**
 * Defines the possible moods a GMI can be in, influencing its behavior and responses.
 * These moods can be adapted based on interaction context or self-reflection.
 * @enum {string}
 */
export enum GMIMood {
  NEUTRAL = 'neutral',
  FOCUSED = 'focused',
  EMPATHETIC = 'empathetic',
  CURIOUS = 'curious',
  ASSERTIVE = 'assertive',
  ANALYTICAL = 'analytical',
  FRUSTRATED = 'frustrated',
  CREATIVE = 'creative',
}

/**
 * Defines the primary operational states of a GMI.
 * @enum {string}
 */
export enum GMIPrimeState {
  IDLE = 'idle',
  INITIALIZING = 'initializing',
  READY = 'ready',
  PROCESSING = 'processing',
  AWAITING_TOOL_RESULT = 'awaiting_tool_result',
  REFLECTING = 'reflecting', // Added based on GMI.ts usage
  ERRORED = 'errored',
  SHUTTING_DOWN = 'shutting_down',
  SHUTDOWN = 'shutdown',
}

/**
 * Represents the contextual information about the user interacting with the GMI.
 * @interface UserContext
 */
export interface UserContext {
  userId: string;
  skillLevel?: string;
  preferences?: Record<string, any>;
  pastInteractionSummary?: string;
  currentSentiment?: string;
  [key: string]: any;
}

/**
 * Represents the contextual information about the task the GMI is currently handling.
 * @interface TaskContext
 */
export interface TaskContext {
  taskId: string;
  domain?: string;
  complexity?: string;
  goal?: string;
  status?: 'not_started' | 'in_progress' | 'blocked' | 'requires_clarification' | 'completed' | 'failed';
  requirements?: string;
  progress?: number;
  [key: string]: any;
}

/**
 * Describes a request from the LLM to call a specific tool/function.
 * @interface ToolCallRequest
 */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

/**
 * Represents the result of a tool execution, structured to be sent back to the LLM.
 * @interface ToolCallResult
 */
export interface ToolCallResult {
  toolCallId: string;
  toolName: string;
  output: any;
  isError?: boolean;
  errorDetails?: any;
}

/**
 * Payload for providing tool results, abstracting success/error.
 * @export
 * @interface ToolResultPayload
 */
export type ToolResultPayload =
  | { type: 'success'; result: any }
  | { type: 'error'; error: { code: string; message: string; details?: any } };


/**
 * Configuration for visual input data.
 * @export
 * @interface VisionInputData
 */
export interface VisionInputData {
    type: 'image_url' | 'base64';
    data: string; // URL string or base64 encoded string
    mimeType?: string; // e.g., 'image/jpeg', 'image/png'
    description?: string; // Optional description for the GMI
}

/**
 * Configuration for audio input data.
 * @export
 * @interface AudioInputData
 */
export interface AudioInputData {
    type: 'audio_url' | 'base64' | 'transcription';
    data: string; // URL string, base64 encoded string, or text transcription
    mimeType?: string; // e.g., 'audio/mpeg', 'audio/wav'; not applicable for 'transcription'
    languageCode?: string; // BCP-47 language code, e.g., 'en-US'
}

/**
 * Structure for aggregating cost and token usage.
 * @export
 * @interface CostAggregator
 */
export interface CostAggregator {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    totalCostUSD?: number;
    breakdown?: Array<{
        providerId: string;
        modelId: string;
        tokens: number;
        promptTokens: number;
        completionTokens: number;
        costUSD?: number;
    }>;
}


/**
 * Base configuration required to initialize a GMI instance.
 * @interface GMIBaseConfig
 */
export interface GMIBaseConfig {
  workingMemory: IWorkingMemory;
  promptEngine: IPromptEngine;
  llmProviderManager: AIModelProviderManager;
  utilityAI: IUtilityAI;
  toolOrchestrator: IToolOrchestrator;
  retrievalAugmentor?: IRetrievalAugmentor;
  /** Cognitive memory system (personality-affected encoding/retrieval with Ebbinghaus decay). */
  cognitiveMemory?: import('../memory/CognitiveMemoryManager.js').ICognitiveMemoryManager;
  defaultLlmProviderId?: string;
  defaultLlmModelId?: string;
  /**
   * Maximum number of tool-loop iterations before the safety break engages.
   * Prevents runaway tool loops in `processTurnStream()`. Defaults to `5`.
   */
  maxToolLoopIterations?: number;
  customSettings?: Record<string, any>;
}

/**
 * Defines the type of interaction or input being provided to the GMI.
 * @enum {string}
 */
export enum GMIInteractionType {
  TEXT = 'text',
  MULTIMODAL_CONTENT = 'multimodal_content',
  TOOL_RESPONSE = 'tool_response',
  SYSTEM_MESSAGE = 'system_message',
  LIFECYCLE_EVENT = 'lifecycle_event',
}

/**
 * Represents a single turn of input to the GMI.
 * @interface GMITurnInput
 */
export interface GMITurnInput {
  interactionId: string;
  userId: string;
  sessionId?: string; // GMI specific session/conversation ID
  type: GMIInteractionType;
  content: string | ToolCallResult | ToolCallResult[] | Record<string, any> | Array<Record<string, any>>;
  timestamp?: Date;
  userContextOverride?: Partial<UserContext>;
  taskContextOverride?: Partial<TaskContext>;
  metadata?: Record<string, any> & {
    options?: Partial<ModelCompletionOptions & { preferredModelId?: string; preferredProviderId?: string; toolChoice?: any; responseFormat?: any }>; // Added for GMI.ts usage
    userApiKeys?: Record<string, string>; // Added for GMI.ts usage
    userFeedback?: any; // Added for GMI.ts usage
    explicitPersonaSwitchId?: string; // Added for GMI.ts usage
    /**
     * Optional conversation history snapshot to use for prompt construction.
     * When provided, the GMI should prefer this over any internal ephemeral history so
     * persona switches share conversation memory.
     */
    conversationHistoryForPrompt?: any[];
    /**
     * Optional rolling summary block (text + structured metadata) maintained by ConversationContext
     * and injected into prompts for long conversations.
     */
    rollingSummary?: { text?: string; json?: any } | null;
    /**
     * Optional prompt-profile selection for this turn (e.g., concise/deep_dive/planner/reviewer).
     */
    promptProfile?: { id: string; systemInstructions?: string; reason?: string } | null;
    /**
     * Optional planner-selected execution policy for this turn.
     */
    executionPolicy?: {
      plannerVersion?: string;
      toolFailureMode?: 'fail_open' | 'fail_closed';
      toolSelectionMode?: 'all' | 'discovered';
    } | null;
    /**
     * Optional capability discovery payload for this turn.
     * `result` is intentionally `any` to avoid hard-coupling the GMI contract to
     * a specific discovery-engine type.
     */
    capabilityDiscovery?: {
      query?: string;
      kind?: string;
      selectedToolNames?: string[];
      promptContext?: string;
      fallbackReason?: string;
      result?: any;
    } | null;
  };
}

/**
 * Defines the type of content in a `GMIOutputChunk`.
 * @enum {string}
 */
export enum GMIOutputChunkType {
  TEXT_DELTA = 'text_delta',
  TOOL_CALL_REQUEST = 'tool_call_request',
  REASONING_STATE_UPDATE = 'reasoning_state_update',
  FINAL_RESPONSE_MARKER = 'final_response_marker',
  ERROR = 'error',
  SYSTEM_MESSAGE = 'system_message', // Renamed from GMI.ts's SystemProgress to match Orchestrator
  USAGE_UPDATE = 'usage_update',
  LATENCY_REPORT = 'latency_report',
  UI_COMMAND = 'ui_command',
  /**
   * Emitted after a successful RAG retrieval during a turn so downstream
   * consumers (guardrails, grounding verification, UI source panels) can
   * see the retrieved chunks before the LLM call produces text deltas.
   * The chunk content is `{ ragSources: RagRetrievedChunk[] }`.
   */
  RAG_SOURCES_AVAILABLE = 'rag_sources_available',
}

/**
 * Represents a chunk of output streamed from the GMI during turn processing.
 * @interface GMIOutputChunk
 */
export interface GMIOutputChunk {
  type: GMIOutputChunkType;
  content: any;
  chunkId?: string;
  interactionId: string;
  timestamp: Date;
  isFinal?: boolean;
  finishReason?: string;
  usage?: ModelUsage;
  errorDetails?: any; // Can hold GMIError.toPlainObject()
  metadata?: Record<string, any>;
}

/**
 * Defines configuration for audio output (Text-to-Speech).
 * @export
 * @interface AudioOutputConfig
 */
export interface AudioOutputConfig {
    provider: string;
    voiceId?: string;
    textToSpeak: string;
    url?: string;
    format?: string;
    languageCode?: string;
    customParams?: Record<string, any>;
}

/**
 * Defines configuration for generated image output.
 * @export
 * @interface ImageOutputConfig
 */
export interface ImageOutputConfig {
    provider?: string;
    promptUsed?: string;
    imageUrl?: string;
    base64Data?: string;
    format?: string;
    metadata?: Record<string, any>;
}

/**
 * Defines a command for the UI, to be interpreted by the client.
 * @export
 * @interface UICommand
 */
export interface UICommand {
    commandId: string;
    targetElementId?: string;
    payload: Record<string, any>;
    metadata?: Record<string, any>;
}

/**
 * Represents the complete, non-chunked output of a GMI turn or significant processing step.
 * This is typically the TReturn type of an AsyncGenerator yielding GMIOutputChunk.
 * @export
 * @interface GMIOutput
 */
export interface GMIOutput {
    isFinal: boolean;
    responseText?: string | null;
    toolCalls?: ToolCallRequest[];
    uiCommands?: UICommand[];
    audioOutput?: AudioOutputConfig;
    imageOutput?: ImageOutputConfig;
    usage?: CostAggregator;
    reasoningTrace?: ReasoningTraceEntry[]; // Included for final consolidated trace
    error?: { code: string; message: string; details?: any };
    /**
     * Retrieved RAG chunks for the turn, populated when the GMI performed a
     * RAG retrieval. Threaded into the FINAL_RESPONSE chunk so client code and
     * the output-guardrail layer (Grounding Guard, Citation Verifier) can
     * verify generated claims against the same sources the model saw.
     */
    ragSources?: import('../rag/IRetrievalAugmentor.js').RagRetrievedChunk[];
}


/**
 * Types of entries that can appear in a GMI's reasoning trace.
 * @enum {string}
 */
export enum ReasoningEntryType { // Must be imported into GMIManager if used there
  LIFECYCLE = 'LIFECYCLE',
  INTERACTION_START = 'INTERACTION_START',
  INTERACTION_END = 'INTERACTION_END',
  STATE_CHANGE = 'STATE_CHANGE',
  PROMPT_CONSTRUCTION_START = 'PROMPT_CONSTRUCTION_START',
  PROMPT_CONSTRUCTION_DETAIL = 'PROMPT_CONSTRUCTION_DETAIL',
  PROMPT_CONSTRUCTION_COMPLETE = 'PROMPT_CONSTRUCTION_COMPLETE',
  LLM_CALL_START = 'LLM_CALL_START',
  LLM_CALL_COMPLETE = 'LLM_CALL_COMPLETE',
  LLM_RESPONSE_CHUNK = 'LLM_RESPONSE_CHUNK',
  LLM_USAGE = 'LLM_USAGE',
  TOOL_CALL_REQUESTED = 'TOOL_CALL_REQUESTED',
  TOOL_PERMISSION_CHECK_START = 'TOOL_PERMISSION_CHECK_START',
  TOOL_PERMISSION_CHECK_RESULT = 'TOOL_PERMISSION_CHECK_RESULT',
  TOOL_ARGUMENT_VALIDATION = 'TOOL_ARGUMENT_VALIDATION',
  TOOL_EXECUTION_START = 'TOOL_EXECUTION_START',
  TOOL_EXECUTION_RESULT = 'TOOL_EXECUTION_RESULT',
  RAG_QUERY_START = 'RAG_QUERY_START',
  RAG_QUERY_DETAIL = 'RAG_QUERY_DETAIL',
  RAG_QUERY_RESULT = 'RAG_QUERY_RESULT',
  RAG_INGESTION_START = 'RAG_INGESTION_START',
  RAG_INGESTION_DETAIL = 'RAG_INGESTION_DETAIL',
  RAG_INGESTION_COMPLETE = 'RAG_INGESTION_COMPLETE',
  SELF_REFLECTION_TRIGGERED = 'SELF_REFLECTION_TRIGGERED',
  SELF_REFLECTION_START = 'SELF_REFLECTION_START',
  SELF_REFLECTION_DETAIL = 'SELF_REFLECTION_DETAIL',
  SELF_REFLECTION_COMPLETE = 'SELF_REFLECTION_COMPLETE',
  SELF_REFLECTION_SKIPPED = 'SELF_REFLECTION_SKIPPED',
  MEMORY_LIFECYCLE_EVENT_RECEIVED = 'MEMORY_LIFECYCLE_EVENT_RECEIVED',
  MEMORY_LIFECYCLE_NEGOTIATION_START = 'MEMORY_LIFECYCLE_NEGOTIATION_START',
  MEMORY_LIFECYCLE_RESPONSE_SENT = 'MEMORY_LIFECYCLE_RESPONSE_SENT',
  HEALTH_CHECK_REQUESTED = 'HEALTH_CHECK_REQUESTED',
  HEALTH_CHECK_RESULT = 'HEALTH_CHECK_RESULT',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  DEBUG = 'DEBUG',
}

/**
 * A single entry in the GMI's reasoning trace, providing an auditable log of its operations.
 * @interface ReasoningTraceEntry
 */
export interface ReasoningTraceEntry {
  timestamp: Date;
  type: ReasoningEntryType;
  message: string;
  details?: Record<string, any>;
}

/**
 * The complete reasoning trace for a GMI instance or a specific turn.
 * @interface ReasoningTrace
 */
export interface ReasoningTrace {
  gmiId: string;
  personaId: string;
  turnId?: string; // Made optional as per GMI.ts usage
  sessionId?: string; // Added based on GMI.ts usage (Error 41)
  conversationId?: string;
  organizationId?: string;
  entries: ReasoningTraceEntry[];
}

/**
 * Represents an event related to memory lifecycle management that the GMI needs to be aware of or act upon.
 * @interface MemoryLifecycleEvent
 */
export interface MemoryLifecycleEvent {
  eventId: string;
  timestamp: Date;
  type: 'EVICTION_PROPOSED' | 'ARCHIVAL_PROPOSED' | 'DELETION_PROPOSED' | 'SUMMARY_PROPOSED' | 'RETENTION_REVIEW_PROPOSED' | 'NOTIFICATION' | 'EVALUATION_PROPOSED';
  gmiId: string;
  personaId?: string;
  itemId: string;
  dataSourceId: string;
  category?: string;
  itemSummary: string;
  reason: string;
  proposedAction: LifecycleAction;
  negotiable: boolean;
  metadata?: Record<string, any>;
}

/**
 * Defines the possible actions a GMI can take or that can be proposed/taken regarding a memory item.
 * @enum {string}
 */
export type LifecycleAction =
  | 'ALLOW_ACTION'
  | 'PREVENT_ACTION'
  | 'DELETE'
  | 'ARCHIVE'
  | 'SUMMARIZE_AND_DELETE'
  | 'SUMMARIZE_AND_ARCHIVE'
  | 'RETAIN_FOR_DURATION'
  | 'MARK_AS_CRITICAL'
  | 'NO_ACTION_TAKEN'
  | 'ACKNOWLEDGE_NOTIFICATION';


/**
 * The GMI's response to a `MemoryLifecycleEvent`.
 * @interface LifecycleActionResponse
 */
export interface LifecycleActionResponse {
  gmiId: string;
  eventId: string;
  actionTaken: LifecycleAction;
  rationale?: string;
  requestedRetentionDuration?: string;
  metadata?: Record<string, any>;
}

/**
 * A report on the GMI's health, including its sub-components.
 * @interface GMIHealthReport
 */
export interface GMIHealthReport {
  gmiId: string;
  personaId: string;
  timestamp: Date;
  overallStatus: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'ERROR';
  currentState: GMIPrimeState;
  memoryHealth?: {
    overallStatus: 'OPERATIONAL' | 'DEGRADED' | 'ERROR' | 'LIMITED';
    workingMemoryStats?: { itemCount: number; [key: string]: any };
    ragSystemStats?: { isHealthy: boolean; details?: any };
    lifecycleManagerStats?: { isHealthy: boolean; details?: any };
    issues?: Array<{ severity: 'critical' | 'warning' | 'info'; description: string; component: string; details?: any }>;
  };
  dependenciesStatus?: Array<{
    componentName: string;
    status: 'HEALTHY' | 'UNHEALTHY' | 'DEGRADED' | 'UNKNOWN' | 'ERROR'; // Added 'ERROR'
    details?: any;
  }>;
  recentErrors?: ReasoningTraceEntry[];
  uptimeSeconds?: number;
  activeTurnsProcessed?: number;
}

/**
 * Options for LLM completion, compatible with IProvider.ModelCompletionOptions.
 * @interface ModelCompletionOptions
 */
export interface ModelCompletionOptions extends Record<string, any> {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    topK?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
    stopSequences?: string[];
    responseFormat?: { type: 'text' | 'json_object' }; // Simplified example
    stream?: boolean;
    userId?: string;
    tools?: any[]; // Simplified, should align with IProvider if more specific tool definition is used there
    toolChoice?: any; // Simplified
}

/**
 * @interface IGMI
 * @description Defines the contract for a Generalized Mind Instance (GMI).
 */
export interface IGMI {
  readonly gmiId: string; // Corrected: was instanceId in AgentOSOrchestrator
  readonly creationTimestamp: Date;

  initialize(persona: IPersonaDefinition, config: GMIBaseConfig): Promise<void>;
  getPersona(): IPersonaDefinition; // Corrected: was getCurrentPersonaDefinition in AgentOSOrchestrator
  getCurrentPrimaryPersonaId(): string; // Added for AgentOSOrchestrator
  getGMIId(): string; // This or gmiId property directly.
  getCurrentState(): GMIPrimeState;
  processTurnStream(turnInput: GMITurnInput): AsyncGenerator<GMIOutputChunk, GMIOutput, undefined>; // Corrected TReturn to GMIOutput

  handleToolResult(
    toolCallId: string,
    toolName: string,
    resultPayload: ToolResultPayload,
    userId: string,
    userApiKeys?: Record<string, string>
  ): Promise<GMIOutput>;

  handleToolResults?(
    toolResults: ToolCallResult[],
    userId: string,
    userApiKeys?: Record<string, string>
  ): Promise<GMIOutput>;

  hydrateConversationHistory?(
    conversationHistory: ConversationMessage[],
  ): void;

  hydrateTurnContext?(
    context: {
      sessionId?: string;
      conversationId?: string;
      organizationId?: string;
    },
  ): void;


  getReasoningTrace(): Readonly<ReasoningTrace>;
  getWorkingMemorySnapshot(): Promise<Record<string, any>>;
  getCognitiveMemoryManager(): import('../memory/CognitiveMemoryManager.js').ICognitiveMemoryManager | undefined;
  _triggerAndProcessSelfReflection(): Promise<void>;
  onMemoryLifecycleEvent(event: MemoryLifecycleEvent): Promise<LifecycleActionResponse>;
  analyzeAndReportMemoryHealth(): Promise<GMIHealthReport['memoryHealth']>;
  getOverallHealth(): Promise<GMIHealthReport>;
  shutdown(): Promise<void>;
}
