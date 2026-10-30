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
import type { NormalizedUserFeedback } from './userFeedback';
// Assuming AIModelProviderManager is correctly exported from this path
import { AIModelProviderManager } from '../../core/llm/providers/AIModelProviderManager';
import { IUtilityAI } from '../nlp/ai_utilities/IUtilityAI';
// Assuming IToolOrchestrator is correctly exported from this path
import { IToolOrchestrator } from '../../core/tools/IToolOrchestrator';
import type { ToolEffectRecord } from '../../core/tools/ITool';
import type { ChatMessage, ModelUsage, ThinkingBlock } from '../../core/llm/providers/IProvider';
import type { HexacoTraitValues } from './personas/hexaco';
import type { ILearnerSession } from '../learning/types.js';

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
  /**
   * Gemini thought signature for this call, kept so the next Gemini 3 turn can
   * replay it. See `ChatMessage.tool_calls[].thoughtSignature`.
   */
  thoughtSignature?: string;
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
  /** The call's effects, as the tool's result carried them (see `ToolExecutionResult.effects`). */
  effects?: ToolEffectRecord[];
}

/**
 * Why a {@link GMIToolCallGate} refused a call.
 * @interface GMIToolCallRefusal
 */
export interface GMIToolCallRefusal {
  /** Why the call was refused. The model reads it in the refused tool result. */
  reason: string;
  /** A machine-readable code for the rule that refused the call. */
  reasonCode?: string;
  /** The id of the guardrail that refused the call, when it has one. */
  guardrailId?: string;
}

/**
 * What the GMI tells a {@link GMIToolCallGate} beside the call it asks about.
 * @interface GMIToolCallGateContext
 */
export interface GMIToolCallGateContext {
  /**
   * Every call of the model step the call belongs to, in the order the model asked for them, the call among them. The
   * GMI asks about each call of a step before the first of them runs and passes the same array with each question, so
   * a gate can judge the calls together as well as one by one.
   */
  stepCalls?: readonly ToolCallRequest[];
  /**
   * The sources the turn retrieved for the model, when it retrieved any. A tool continuation retrieves nothing of
   * its own and passes the sources of the user turn it continues.
   */
  ragSources?: import('../rag/IRetrievalAugmentor.js').RagRetrievedChunk[];
}

/**
 * Asked before the GMI runs a call of its own tool round. Resolving to null lets the call run. A refusal turns the call
 * into a refused tool result that the model reads (an error with the code `AUTH_PERMISSION_DENIED`, as a permission
 * refusal is recorded), and the tool is not called; a gate that throws refuses the call too. The GMI asks about every
 * call of a step, with the step's calls and the turn's retrieved sources in `context`, before any call of the step
 * runs. AgentOS builds one from its output guardrails that set `config.evaluateToolCalls`: it judges each call alone,
 * then the calls of the step that pass alone together, as the stream's `TOOL_CALL_REQUEST` chunk for the step holds
 * them, each time with the turn's sources; a block on the calls together refuses each of them.
 */
export type GMIToolCallGate = (call: ToolCallRequest, context?: GMIToolCallGateContext) => Promise<GMIToolCallRefusal | null>;

/**
 * Options for the continuation a tool result starts.
 * @interface GMIToolResultOptions
 */
export interface GMIToolResultOptions {
  /** Asked before each call of the continuation's own tool round. Unset, the continuation asks the gate of the turn it continues. */
  toolCallGate?: GMIToolCallGate;
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


/** What `GMIBaseConfig.beforeModelCall` receives for one model attempt. */
export interface GMIModelCallContext {
  turnId: string;
  /** 0-based model step within the turn, as on the step's STEP_FINISHED. */
  stepIndex: number;
  /** 0 for the primary, n for the n-th fallback hop. */
  hop: number;
  providerId: string;
  modelId: string;
  /** The attempt's prompt, system messages included. A copy: return the messages to send instead. */
  messages: ChatMessage[];
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
  /**
   * Runtime default for the reasoning trace's entry cap when the persona sets no
   * `reasoningTraceConfig.maxEntries`. Defaults to `500`.
   */
  defaultReasoningTraceMaxEntries?: number;
  /** Runtime default for the characters kept per trace message. Defaults to `1000`. */
  defaultReasoningTraceMaxMessageLength?: number;
  customSettings?: Record<string, any>;
  /**
   * One model layer for the turn. When set, the GMI resolves the hop through it
   * before it builds the prompt, streams through it, and moves to the next hop
   * when an attempt fails before any output with a retryable error.
   * `llmProviderManager` is then a
   * `GatewayProviderManager` (see `src/api/runtime/gatewayProviderManager.ts`).
   */
  completionGateway?: import('../../api/runtime/completionGateway.js').CompletionGateway;
  /**
   * Called for every model attempt after its prompt is built and before it is
   * sent, a fallback hop's rebuilt prompt included. Messages it returns replace
   * that attempt's prompt and do not enter the history; a hook that throws or
   * returns an empty list is recorded on the reasoning trace and the built
   * prompt is sent. `agent({ runtime: 'gmi' })` routes `onBeforeGeneration` here.
   */
  beforeModelCall?: (context: GMIModelCallContext) => Promise<ChatMessage[] | void> | ChatMessage[] | void;
  /**
   * How long `shutdown()` waits, in milliseconds, for the turns it stopped to
   * end before it closes the GMI's memories anyway. Defaults to `8000`.
   * `GMIManager` passes its own `shutdownTimeoutMs`.
   */
  shutdownTimeoutMs?: number;
  /**
   * The session's learner session, passed by a host whose `learning` option is on. The GMI asks it once per user
   * turn, before the tool loop, for the personality section (a system prompt at priority 2, after the persona's base
   * prompt) and tells each tool call the turn's learner and mode (`sessionData.learning`). A session that fails or
   * does not answer within 2,000 ms never fails the turn. The host that passes the session ends it.
   */
  learning?: ILearnerSession;
  /**
   * The persona's traits as the GMI renders them itself, when it has no learner session or the session did not
   * answer: `authored` is the registry persona's traits and `overlay` a workflow role overlay's patch. They are read
   * once, at `initialize()`, never from the persona copy `setPersonalityTrait()` replaces. Honesty-humility and
   * emotionality always come from `authored`; an overlay that names either is not applied to it, and the trace says
   * so. Without this field the GMI renders no personality section of its own.
   */
  personaTraits?: { authored: HexacoTraitValues; overlay?: HexacoTraitValues };
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
     * The end-user id this turn's model calls send to the provider (OpenAI's
     * `user` / `safety_identifier`). Unset, the GMI sends the turn's `userId`;
     * `null` sends none. Pass an opaque or hashed id: the provider receives it.
     */
    providerUserId?: string | null;
    /**
     * The ids the turn's cognitive memory files and recalls traces under, in
     * place of the turn's `userId` and `sessionId` (the session also stands in
     * for the conversation when no `conversationId` is given). Tools, the user
     * context and the reasoning trace keep the turn's own ids. Unset, memory
     * uses the turn's ids.
     */
    memoryScope?: { userId?: string; sessionId?: string } | null;
    /**
     * Asked before each call of this turn's tool round runs (see {@link GMIToolCallGate}). A tool continuation that names
     * none asks the gate of the turn it continues.
     */
    toolCallGate?: GMIToolCallGate;
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
  /**
   * One per model step that completes: the step's text, finish reason, provider, model, hop and usage.
   * A step that fails emits none: a USAGE_UPDATE with `metadata.attemptFailed: true` reports what it was
   * billed, when the provider reported that, and the turn's ERROR chunk follows. Content: StepFinishedChunkPayload.
   */
  STEP_FINISHED = 'step_finished',
  /**
   * One per result the GMI records for a call of its own tool round, failures included. Results a host
   * passes to `handleToolResults()` produce none. Content: ToolResultChunkPayload.
   */
  TOOL_RESULT = 'tool_result',
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

/** Content of a STEP_FINISHED chunk. */
export interface StepFinishedChunkPayload {
  /** 0-based index of the model step within the turn. */
  stepIndex: number;
  /** The step's text: its deltas joined, or the final message content when the provider sent no deltas. */
  text: string;
  finishReason: string | null;
  providerId: string;
  modelId: string;
  /** 0 for the primary, n for the n-th fallback hop. */
  hop: number;
  usage?: ModelUsage;
  /** Model id the provider reported serving the step. */
  responseModel?: string;
  serviceTier?: string;
  /** Provider message id of the step's final chunk. */
  providerMessageId?: string;
  cacheDiagnostics?: unknown;
  /**
   * The step's schema answer when the turn asked for structured output and a completion-gateway hop
   * on Anthropic returned it, as JSON text on the JSON output format or as a forced schema tool call,
   * and it parsed; other hops return the JSON as the step's text. An answer that does not parse, and any
   * answer the output limit stopped (`max_tokens`), whose JSON can parse though it was cut, is not set
   * here: it stays the step's text, with the step's own finish reason.
   */
  structuredOutput?: unknown;
  /** The step's extended-thinking blocks (Anthropic), so a session store can replay the step. */
  thinkingBlocks?: ThinkingBlock[];
}

/** Content of a TOOL_RESULT chunk. */
export interface ToolResultChunkPayload {
  toolCallId: string;
  name: string;
  result: unknown;
  isError: boolean;
  errorDetails?: unknown;
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
    /**
     * `false` with `toolCalls` stops the turn for the host: the runtime saves the pending request, and the host runs
     * those calls and passes their results back. Any other output, final or naming no calls, ends the turn, or the
     * tool-result continuation, with `FINAL_RESPONSE`.
     */
    isFinal: boolean;
    responseText?: string | null;
    /**
     * On an output with `isFinal: false`, the calls the host runs: the runtime reads every one of them as a call that
     * waits on the host, since a call carries no mode of its own, so a GMI leaves out of such an output the calls it ran
     * itself. On a final output, the calls of the GMI's own tool rounds, each one run or refused by the tool-call gate:
     * `FINAL_RESPONSE.finalToolCalls` lists them, and nothing waits on them.
     */
    toolCalls?: ToolCallRequest[];
    uiCommands?: UICommand[];
    audioOutput?: AudioOutputConfig;
    imageOutput?: ImageOutputConfig;
    usage?: CostAggregator;
    reasoningTrace?: ReasoningTraceEntry[]; // Included for final consolidated trace
    error?: { code: string; message: string; details?: any };
    /**
     * Retrieved RAG chunks for the turn, populated when the GMI performed a
     * RAG retrieval; a tool continuation retrieves nothing of its own and
     * carries the chunks of the user turn it continues, when the same GMI ran
     * that turn (a pause stores no retrieved chunk). Threaded into the
     * FINAL_RESPONSE chunk so client code and the output-guardrail layer
     * (Grounding Guard, Citation Verifier) can verify generated claims against
     * the same sources the model saw.
     */
    ragSources?: import('../rag/IRetrievalAugmentor.js').RagRetrievedChunk[];
    /** On a structured turn: the parsed value and its check (see `api/runtime/structuredReply`). */
    structuredOutput?: import('../../api/runtime/structuredReply.js').StructuredReplyOutput;
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
    userApiKeys?: Record<string, string>,
    options?: GMIToolResultOptions,
  ): Promise<GMIOutput>;

  /**
   * Continues the turn with several tool results at once: a batch the host passes, or a pause the host answers in
   * part. For a pause answered in part, the results hold, after the host's, one error result for each call of the
   * pause the host left out (`isError: true`, `errorDetails.code` `EXTERNAL_TOOL_NOT_RUN`), so the GMI's own history
   * answers every call of the pause before it writes again. An `IGMI` without it takes one result at a time: a pause
   * answered in part continues it through `handleToolResult()` with the host's result alone, and a batch of several
   * results ends the continuation with an error.
   */
  handleToolResults?(
    toolResults: ToolCallResult[],
    userId: string,
    userApiKeys?: Record<string, string>,
    options?: GMIToolResultOptions,
  ): Promise<GMIOutput>;

  /**
   * Makes `conversationHistory` the whole conversation history. The runtime calls it before a resume continues a
   * pause, and before results on the paused stream continue it on a GMI whose own history holds a turn of another
   * conversation, or that replaced the GMI the turn paused on: with the history the paused GMI's
   * `getConversationHistory()` returned when the turn paused, with the pause's calls, when the runtime kept one, and
   * with the conversation's stored history otherwise.
   */
  hydrateConversationHistory?(
    conversationHistory: ConversationMessage[],
  ): void;

  /**
   * The conversation history as the GMI holds it, the calls of its own tool rounds, their results and the assistant
   * turns' thinking blocks included; `hydrateConversationHistory()` sets it back. With conversational persistence on,
   * the runtime reads it when a turn stops for the host on a GMI whose history holds only that turn's conversation,
   * and keeps it with the turn's stream for the continuation.
   */
  getConversationHistory?(): ConversationMessage[];

  /**
   * Makes `messages` the whole conversation history. An empty array is authoritative.
   * `GMI` also drops what it recorded about the turns the new history no longer holds
   * (the details of their trace entries, the input excerpts of their sentiment records).
   */
  replaceHistory?(messages: ConversationMessage[]): void;
  /** Empties the conversation history; `GMI` drops what it recorded about its turns, as for `replaceHistory`. */
  clearHistory?(): void;

  /**
   * Sets the turn a tool continuation goes on with: the session, conversation and organization the continuation runs
   * under, and the sources the paused turn retrieved (`ragSources`), which its tool calls and reply are judged with.
   * The runtime calls it when it calls `hydrateConversationHistory()`, and also when the conversation holds no history
   * to set. A blank organization means the turn has none; an empty `ragSources` means it retrieved none; a field left
   * out keeps what the GMI holds. A conversation other than the one of the GMI's last turn also drops what `GMI` kept
   * for that turn (its memory scope, tool-call gate, learning preparation, model hop and sources), so the continuation
   * starts as on a GMI built for it.
   */
  hydrateTurnContext?(
    context: {
      sessionId?: string;
      conversationId?: string;
      organizationId?: string;
      ragSources?: import('../rag/IRetrievalAugmentor.js').RagRetrievedChunk[];
    },
  ): void;

  /**
   * Records user feedback on this instance's session: a reasoning-trace entry
   * and, when cognitive memory is configured, memories scoped to the user.
   * GMIManager calls it with feedback normalized by `normalizeUserFeedback`.
   * Optional so that custom IGMI implementations keep compiling.
   *
   * @param feedback - Normalized feedback plus the id of the user who sent it.
   */
  recordUserFeedback?(feedback: NormalizedUserFeedback & { userId: string }): Promise<void>;

  /**
   * Sets one personality trait on this instance without mutating the persona
   * definition shared with other sessions. Used by the self-improvement
   * `adapt_personality` tool. Optional so that custom IGMI implementations
   * keep compiling; without it, personality adaptation reports that the
   * caller could not be resolved.
   *
   * @param trait - Trait key, e.g. `openness` or `honesty`.
   * @param value - New trait value.
   */
  setPersonalityTrait?(trait: string, value: number): void;

  /**
   * The learner session this instance was built with (`GMIBaseConfig.learning`), or `undefined` when its host has
   * no learning layer. Optional so that custom IGMI implementations keep compiling.
   */
  getLearnerSession?(): ILearnerSession | undefined;

  getReasoningTrace(): Readonly<ReasoningTrace>;
  getWorkingMemorySnapshot(): Promise<Record<string, any>>;
  getCognitiveMemoryManager(): import('../memory/CognitiveMemoryManager.js').ICognitiveMemoryManager | undefined;
  _triggerAndProcessSelfReflection(): Promise<void>;
  onMemoryLifecycleEvent(event: MemoryLifecycleEvent): Promise<LifecycleActionResponse>;
  analyzeAndReportMemoryHealth(): Promise<GMIHealthReport['memoryHealth']>;
  getOverallHealth(): Promise<GMIHealthReport>;
  shutdown(): Promise<void>;
}
