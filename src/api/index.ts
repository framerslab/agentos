/**
 * Public API surface for AgentOS.
 *
 * High-level functions for text generation, agents, agencies, and media.
 * Internal runtime (orchestrator, turn pipeline, handlers) is intentionally
 * NOT exported here — import those directly when needed.
 *
 * @module agentos/api
 */

// --- Core entry points ---
export { AgentOS, type AgentOSConfig } from './AgentOS.js';
export type { AgentOSInput } from './types/AgentOSInput.js';
export type { AgentOSResponse } from './types/AgentOSResponse.js';
export type { AgentOSToolResultInput } from './types/AgentOSToolResultInput.js';
export type { AgentOSPendingExternalToolRequest } from './types/AgentOSPendingExternalToolRequest.js';

// --- High-level generation functions ---
export {
  generateText,
  isRetryableError,
  isContentPolicyRefusal,
  buildFallbackChain,
  buildPolicyAwareFallbackChain,
  type GenerateTextOptions,
  type GenerateTextResult,
  type FallbackProviderEntry,
  type HostLLMPolicy,
  type Message,
  type ToolCallRecord,
  type TokenUsage,
} from './generateText.js';
export { normalizeHostLLMPolicy } from './runtime/hostPolicy.js';
export { streamText } from './streamText.js';
export { generateObject } from './generateObject.js';
export { streamObject } from './streamObject.js';
export { embedText } from './embedText.js';
export { generateImage } from './generateImage.js';
export { transferStyle } from './transferStyle.js';

// --- LLM usage observer (global cost / telemetry hook) ---
export {
  setGlobalLlmObserver,
  type LlmUsageEvent,
  type LlmUsageObserver,
} from './observers.js';

// --- Global default provider config ---
export {
  setDefaultProvider,
  getDefaultProvider,
  clearDefaultProvider,
  type GlobalDefaultProvider,
} from './runtime/global-default.js';

// --- Agent & Agency ---
export { agent } from './agent.js';
export { agency } from './agency.js';
export { souledAgent } from './souledAgent.js';
export type { SouledAgentOptions, SouledAgent } from './souledAgent.js';
export { exportAgent } from './exportAgent.js';

// --- Model routing ---
export type { IModelRouter, ModelRouteParams, ModelRouteResult } from '../core/llm/routing/IModelRouter.js';
export { ModelRouter } from '../core/llm/routing/ModelRouter.js';
export { PolicyAwareRouter, type PolicyOverrides } from '../core/llm/routing/PolicyAwareRouter.js';
export {
  createUncensoredModelCatalog,
  type UncensoredModelCatalog,
  type CatalogEntry,
  type PolicyTier,
  type ContentIntent,
} from '../core/llm/routing/UncensoredModelCatalog.js';

// --- Image routing ---
export { PolicyAwareImageRouter, type ImageProviderPreference } from '../io/media/images/PolicyAwareImageRouter.js';

// --- Generation hooks ---
export type { GenerationHookContext, GenerationHookResult, ToolCallHookInfo } from './generateText.js';

// --- Memory, PromptEngine, Skills (for agent() integration) ---
export { AgentMemory } from '../cognition/memory/AgentMemory.js';
export type { IPromptEngine } from '../core/llm/IPromptEngine.js';
export type { SkillEntry } from '../cognition/skills/types.js';
export { SkillRegistry } from '../cognition/skills/SkillRegistry.js';

// --- Avatar types ---
export type {
  AvatarConfig,
  AvatarRuntimeMode,
  AvatarAnchorAssets,
  AvatarStyleProjection,
  AvatarDriftGuard,
  AvatarBindingInputs,
  AvatarRiveProfile,
  AvatarSpriteProfile,
  AvatarIdentityPackage,
  AvatarIdentityDescriptor,
  VerifyCitationsConfig,
} from './types.js';

// --- Errors ---
export * from './errors.js';
