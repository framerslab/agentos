import type { ILogger } from '../core/logging/ILogger';
import type { IGuardrailService } from '../safety/guardrails/IGuardrailService';
import type { ITool } from '../core/tools/ITool';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  WorkflowDescriptorPayload,
  WorkflowInstance,
  WorkflowTaskDefinition,
  WorkflowTaskStatus,
} from '../orchestration/workflows/WorkflowTypes';
import type { MessagingChannelPayload } from './MessagingChannelPayload';
import type { ISharedServiceRegistry } from './ISharedServiceRegistry';
import type {
  SpeechToTextProvider,
  SpeechVadProvider,
  TextToSpeechProvider,
  WakeWordProvider,
} from '../io/speech/types';

/**
 * Represents the broad category an extension descriptor belongs to.
 * Well-known kinds include `tool`, `guardrail`, and `response-processor`,
 * but the system allows arbitrary strings for future expansion.
 */
export type ExtensionKind = string;

/**
 * Metadata describing where a descriptor originated from. Useful for debugging,
 * audit logs, or surfacing provenance in developer tooling.
 */
export interface ExtensionSourceMetadata {
  /**
   * Human-friendly name of the pack providing the descriptor (e.g. package name).
   */
  sourceName: string;
  /**
   * Optional semantic version of the pack.
   */
  sourceVersion?: string;
  /**
   * Identifier of the pack entry inside a manifest (path, local file, etc.).
   */
  identifier?: string;
}

/**
 * Context object passed to lifecycle hooks when descriptors are activated or
 * deactivated. Additional properties can be added as the extension runtime
 * evolves.
 */
export interface ExtensionLifecycleContext {
  logger?: ILogger;
  /**
   * Resolves a secret value registered with AgentOS / the host application.
   * Returns `undefined` when a secret is not configured.
   */
  getSecret?: (secretId: string) => string | undefined;
  /**
   * Shared singleton registry for lazy-loading heavyweight extension services.
   */
  services?: ISharedServiceRegistry;
}

/**
 * Context passed to extension-pack factory helpers (e.g. `createExtensionPack()`).
 *
 * AgentOS itself loads packs via manifest factories; this type exists to provide
 * a common shape for extension packages that expose a `createExtensionPack(context)`
 * function for direct, programmatic consumption.
 */
export interface ExtensionContext<TOptions = Record<string, unknown>>
  extends ExtensionLifecycleContext {
  options?: TOptions;
  onActivate?: () => Promise<void> | void;
  onDeactivate?: () => Promise<void> | void;
}

/**
 * Declares a dependency on a named secret (API key / credential).
 */
export interface ExtensionSecretRequirement {
  /** Unique identifier matching the shared secret catalog. */
  id: string;
  /** When true the descriptor can still activate without this secret. */
  optional?: boolean;
  /** Optional context surfaced in tooling. */
  description?: string;
}

/**
 * Unified descriptor contract consumed by the extension registry. Concrete
 * descriptor types (e.g., tools, guardrails) extend this shape with payloads
 * specific to their domain.
 */
export interface ExtensionDescriptor<TPayload = unknown> {
  /**
   * Unique identifier for the descriptor within its kind. Subsequent
   * descriptors with the same id stack on top of previous entries.
   */
  id: string;
  /**
   * High-level category of the descriptor (tool, guardrail, etc.).
   */
  kind: ExtensionKind;
  /**
   * Optional priority used during manifest loading. Higher numbers load later,
   * allowing them to supersede earlier descriptors with the same id.
   */
  priority?: number;
  /**
   * Flag indicating whether the descriptor should be enabled by default when
   * discovered. Manifests or overrides can still disable it explicitly.
   */
  enableByDefault?: boolean;
  /**
   * Arbitrary metadata for tooling or pack-specific usage.
   */
  metadata?: Record<string, unknown>;
  /**
   * The payload consumed by the runtime (e.g., tool factory function).
   */
  payload: TPayload;
  /**
   * Provenance information for the descriptor.
   */
  source?: ExtensionSourceMetadata;
  /**
   * Optional lifecycle hook invoked when the descriptor becomes the active
   * entry for its id.
   */
  onActivate?: (context: ExtensionLifecycleContext) => Promise<void> | void;
  /**
   * Optional lifecycle hook invoked when the descriptor is superseded or
   * removed.
   */
  onDeactivate?: (context: ExtensionLifecycleContext) => Promise<void> | void;
  /**
   * Declares the secrets (API keys, credentials) the descriptor needs in
   * order to function.
   */
  requiredSecrets?: ExtensionSecretRequirement[];
}

/**
 * Active descriptor paired with resolved priority and original stack index.
 */
export interface ActiveExtensionDescriptor<TPayload = unknown>
  extends ExtensionDescriptor<TPayload> {
  /**
   * Resolved numeric priority used to order descriptors inside a stack.
   */
  resolvedPriority: number;
  /**
   * 0-based insertion position within the stack (lower is older).
   */
  stackIndex: number;
}

export const EXTENSION_KIND_TOOL = 'tool';
export const EXTENSION_KIND_GUARDRAIL = 'guardrail';
export const EXTENSION_KIND_RESPONSE_PROCESSOR = 'response-processor';
export const EXTENSION_KIND_WORKFLOW = 'workflow';
export const EXTENSION_KIND_WORKFLOW_EXECUTOR = 'workflow-executor';
export const EXTENSION_KIND_PERSONA = 'persona';

// Planning & Communication extension kinds (v1.1.0)
export const EXTENSION_KIND_PLANNING_STRATEGY = 'planning-strategy';
export const EXTENSION_KIND_HITL_HANDLER = 'hitl-handler';
export const EXTENSION_KIND_COMM_CHANNEL = 'communication-channel';
export const EXTENSION_KIND_MEMORY_PROVIDER = 'memory-provider';
export const EXTENSION_KIND_STT_PROVIDER = 'stt-provider';
export const EXTENSION_KIND_TTS_PROVIDER = 'tts-provider';
export const EXTENSION_KIND_VAD_PROVIDER = 'vad-provider';
export const EXTENSION_KIND_WAKE_WORD_PROVIDER = 'wake-word-provider';

// Messaging Channels — external human-facing platforms (v1.3.0)
export const EXTENSION_KIND_MESSAGING_CHANNEL = 'messaging-channel';

// HTTP Handlers — webhook endpoints (host-provided server) (v1.4.0)
export const EXTENSION_KIND_HTTP_HANDLER = 'http-handler';

// Provenance & Audit (v1.2.0)
export const EXTENSION_KIND_PROVENANCE = 'provenance';

export type ToolDescriptor = ExtensionDescriptor<ITool> & { kind: typeof EXTENSION_KIND_TOOL };
export type GuardrailDescriptor = ExtensionDescriptor<IGuardrailService> & {
  kind: typeof EXTENSION_KIND_GUARDRAIL;
};
export type WorkflowDescriptor = ExtensionDescriptor<WorkflowDescriptorPayload> & {
  kind: typeof EXTENSION_KIND_WORKFLOW;
};

export type HttpHandlerPayload = (
  req: IncomingMessage,
  res: ServerResponse
) => Promise<boolean> | boolean;

export type HttpHandlerDescriptor = ExtensionDescriptor<HttpHandlerPayload> & {
  kind: typeof EXTENSION_KIND_HTTP_HANDLER;
};

export interface WorkflowExtensionExecutionContext {
  workflow: WorkflowInstance;
  task: WorkflowTaskDefinition;
}

export interface WorkflowExtensionExecutionResult {
  output?: unknown;
  status?: WorkflowTaskStatus;
  metadata?: Record<string, unknown>;
}

export type WorkflowExtensionExecutor = (
  context: WorkflowExtensionExecutionContext
) => Promise<WorkflowExtensionExecutionResult> | WorkflowExtensionExecutionResult;

export type WorkflowExecutorDescriptor = ExtensionDescriptor<WorkflowExtensionExecutor> & {
  kind: typeof EXTENSION_KIND_WORKFLOW_EXECUTOR;
};

/**
 * Messaging channel extension descriptor — wraps an IChannelAdapter for
 * external human-facing messaging platforms (Telegram, WhatsApp, Discord, etc.).
 */
export type MessagingChannelDescriptor = ExtensionDescriptor<MessagingChannelPayload> & {
  kind: typeof EXTENSION_KIND_MESSAGING_CHANNEL;
};

export type { MessagingChannelPayload } from './MessagingChannelPayload';

/**
 * Persona registry source configuration
 */
export interface PersonaRegistrySource {
  /** Type of source */
  type: 'github' | 'npm' | 'file' | 'git' | 'url';
  /** Location (URL, path, package name) */
  location: string;
  /** Optional branch for git sources */
  branch?: string;
  /** Optional authentication token */
  token?: string;
  /** Whether this is a verified/trusted source */
  verified?: boolean;
  /** Cache duration in milliseconds */
  cacheDuration?: number;
}

/**
 * Persona extension descriptor type
 */
export type PersonaDescriptor = ExtensionDescriptor<any> & {
  kind: typeof EXTENSION_KIND_PERSONA;
};

// ============================================================================
// Planning, HITL, and Communication Extension Types (v1.1.0)
// ============================================================================

/**
 * Planning strategy payload for custom planning algorithms.
 * Strategies can override how plans are generated, refined, and executed.
 */
export interface PlanningStrategyPayload {
  /** Unique strategy name (e.g., 'tree-of-thought', 'reflexion', 'custom-heuristic') */
  name: string;
  /** Strategy description */
  description: string;
  /** Priority order when multiple strategies match (higher = preferred) */
  priority: number;
  /** Optional condition function to determine if this strategy should be used */
  shouldActivate?: (context: {
    goal: string;
    complexity: number;
    agentCapabilities: string[];
  }) => boolean;
  /** The planning function to execute */
  generatePlan: (goal: string, context: Record<string, unknown>) => Promise<unknown>;
  /** Optional refinement function */
  refinePlan?: (plan: unknown, feedback: unknown) => Promise<unknown>;
}

/**
 * Planning strategy extension descriptor
 */
export type PlanningStrategyDescriptor = ExtensionDescriptor<PlanningStrategyPayload> & {
  kind: typeof EXTENSION_KIND_PLANNING_STRATEGY;
};

/**
 * HITL handler payload for custom human interaction handlers.
 * Handlers receive human interaction requests and manage the approval/response flow.
 */
export interface HITLHandlerPayload {
  /** Handler name (e.g., 'slack-approvals', 'email-notifications', 'ui-modal') */
  name: string;
  /** Handler description */
  description: string;
  /** Types of interactions this handler supports */
  supportedTypes: ('approval' | 'clarification' | 'edit' | 'escalation' | 'checkpoint')[];
  /** Handler function for sending notifications */
  sendNotification: (notification: {
    type: string;
    requestId: string;
    summary: string;
    urgency: string;
  }) => Promise<void>;
  /** Optional function to check handler health/connectivity */
  checkHealth?: () => Promise<{ healthy: boolean; message?: string }>;
}

/**
 * HITL handler extension descriptor
 */
export type HITLHandlerDescriptor = ExtensionDescriptor<HITLHandlerPayload> & {
  kind: typeof EXTENSION_KIND_HITL_HANDLER;
};

/**
 * Communication channel payload for custom inter-agent messaging.
 * Channels handle message transport between agents (e.g., Redis pub/sub, WebSocket).
 */
export interface CommunicationChannelPayload {
  /** Channel name (e.g., 'redis-pubsub', 'websocket', 'in-memory') */
  name: string;
  /** Channel description */
  description: string;
  /** Whether this channel supports distributed communication */
  distributed: boolean;
  /** Initialize the channel */
  initialize: (config: Record<string, unknown>) => Promise<void>;
  /** Send a message */
  send: (targetId: string, message: unknown) => Promise<void>;
  /** Subscribe to messages */
  subscribe: (targetId: string, handler: (message: unknown) => void) => () => void;
  /** Broadcast to a group */
  broadcast?: (groupId: string, message: unknown) => Promise<void>;
  /** Cleanup/shutdown */
  shutdown?: () => Promise<void>;
}

/**
 * Communication channel extension descriptor
 */
export type CommunicationChannelDescriptor = ExtensionDescriptor<CommunicationChannelPayload> & {
  kind: typeof EXTENSION_KIND_COMM_CHANNEL;
};

/**
 * Memory provider payload for custom memory/storage backends.
 * Providers handle storage and retrieval for agent memory, including
 * vector/conversational backends and cognitive memory systems.
 */
export interface MemoryProviderPayload {
  /** Provider name (e.g., 'pinecone', 'weaviate', 'qdrant', 'sql') */
  name: string;
  /** Provider description */
  description: string;
  /** Memory types this provider supports */
  supportedTypes: (
    | 'vector'
    | 'conversational'
    | 'episodic'
    | 'semantic'
    | 'procedural'
    | 'prospective'
    | 'relational'
  )[];
  /** Initialize the provider */
  initialize: (config: Record<string, unknown>) => Promise<void>;
  /** Store data */
  store: (collectionId: string, data: unknown) => Promise<string>;
  /** Query data */
  query: (
    collectionId: string,
    query: unknown,
    options?: Record<string, unknown>
  ) => Promise<unknown[]>;
  /** Delete data */
  delete?: (collectionId: string, ids: string[]) => Promise<void>;
  /** Get provider statistics */
  getStats?: () => Promise<{ collections: number; documents: number; size: number }>;
  /** Cleanup/shutdown */
  shutdown?: () => Promise<void>;
}

/**
 * Memory provider extension descriptor
 */
export type MemoryProviderDescriptor = ExtensionDescriptor<MemoryProviderPayload> & {
  kind: typeof EXTENSION_KIND_MEMORY_PROVIDER;
};

export type SttProviderDescriptor = ExtensionDescriptor<SpeechToTextProvider> & {
  kind: typeof EXTENSION_KIND_STT_PROVIDER;
};

export type TtsProviderDescriptor = ExtensionDescriptor<TextToSpeechProvider> & {
  kind: typeof EXTENSION_KIND_TTS_PROVIDER;
};

export type VadProviderDescriptor = ExtensionDescriptor<SpeechVadProvider> & {
  kind: typeof EXTENSION_KIND_VAD_PROVIDER;
};

export type WakeWordProviderDescriptor = ExtensionDescriptor<WakeWordProvider> & {
  kind: typeof EXTENSION_KIND_WAKE_WORD_PROVIDER;
};

// Streaming Voice Pipeline extension kinds (v1.5.0)
export const EXTENSION_KIND_STREAMING_STT = 'streaming-stt-provider';
export const EXTENSION_KIND_STREAMING_TTS = 'streaming-tts-provider';
export const EXTENSION_KIND_DIARIZATION = 'diarization-provider';
export const EXTENSION_KIND_ENDPOINT_DETECTOR = 'endpoint-detector';
export const EXTENSION_KIND_BARGEIN_HANDLER = 'bargein-handler';

/** Extension kind for meeting-participant providers: a bot that joins a call as a listener. */
export const EXTENSION_KIND_MEETING_PROVIDER = 'meeting-provider';
/** The descriptor of a meeting provider: its payload is the `IMeetingBotProvider` a host registers on its `MeetingManager`. */
export type MeetingProviderDescriptor = ExtensionDescriptor<import('../io/channels/meetings/IMeetingBotProvider.js').IMeetingBotProvider> & {
  kind: typeof EXTENSION_KIND_MEETING_PROVIDER;
};
/** Scoped VAD factories own an awaited per-call IVadSession. */
export const EXTENSION_KIND_VAD_SESSION = 'vad-session-provider';
/** Audio endpoint factories receive the sequenced PCM fan-out. */
export const EXTENSION_KIND_AUDIO_ENDPOINT = 'audio-endpoint-provider';
/** Typed streaming speech descriptor; legacy payloads remain valid on their existing registries. */
export type ScopedStreamingSttDescriptor = ExtensionDescriptor<import('../io/speech/VoiceAdapter.js').ScopedVoiceAdapter<'streaming-stt'>> & { kind: typeof EXTENSION_KIND_STREAMING_STT };
/** Typed awaited-output synthesis factory. */
export type ScopedStreamingTtsDescriptor = ExtensionDescriptor<import('../io/speech/VoiceAdapter.js').ScopedVoiceAdapter<'streaming-tts'>> & { kind: typeof EXTENSION_KIND_STREAMING_TTS };
/** Typed owned VAD factory. */
export type VadSessionDescriptor = ExtensionDescriptor<import('../io/speech/VoiceAdapter.js').ScopedVoiceAdapter<'vad-session'>> & { kind: typeof EXTENSION_KIND_VAD_SESSION };
/** Typed owned audio-endpoint factory. */
export type AudioEndpointDescriptor = ExtensionDescriptor<import('../io/speech/VoiceAdapter.js').ScopedVoiceAdapter<'audio-endpoint'>> & { kind: typeof EXTENSION_KIND_AUDIO_ENDPOINT };
/** Batch adapters remain batch and use their original registry kinds. */
export type ScopedBatchSpeechDescriptor = ExtensionDescriptor<import('../io/speech/VoiceAdapter.js').ScopedVoiceAdapter<'batch-stt' | 'batch-tts'>>;
