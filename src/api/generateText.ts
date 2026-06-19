/**
 * @file generateText.ts
 * Stateless, single-call text generation for the AgentOS high-level API.
 *
 * Parses a `provider:model` string, resolves credentials from environment
 * variables or caller-supplied overrides, and invokes the provider's completion
 * endpoint.  Multi-step tool calling is supported: the loop continues until the
 * model produces a plain-text reply or `maxSteps` is exhausted.
 *
 * When `planning` is enabled, an upfront LLM call decomposes the user's request
 * into numbered steps before the tool loop starts.  The plan is injected into
 * the system prompt so the tool loop executes with awareness of the strategy.
 */
import { randomUUID } from 'node:crypto';
import { resolveModelOption, resolveProvider, createProviderManager } from './model.js';
import { attachUsageAttributes, toTurnMetricUsage } from './observability.js';
import { fireLlmUsageObserver } from './observers.js';
import {
  hostPolicyToRouteParams,
  mergeRequiredCapabilities,
  type HostLLMPolicy,
} from './runtime/hostPolicy.js';
import { adaptTools, type AdaptableToolInput } from './runtime/toolAdapter.js';
import { runEmulatedToolLoop, type ToolMode } from './runtime/tool-emulation/index.js';
import type { AgentOSUsageLedgerOptions } from './runtime/usageLedger.js';
import { resolveDynamicToolCalls } from './runtime/dynamicToolCalling.js';
import type { ITool, ToolExecutionContext } from '../core/tools/ITool.js';
import { recordAgentOSTurnMetrics, withAgentOSSpan } from '../safety/evaluation/observability/otel.js';
import { createLogger } from '../core/logging/loggerFactory.js';
import type { AgentCallRecord, AgencyTraceEvent } from './types.js';
import { globalLLMProviderHealth } from '../core/safety/LLMProviderHealthRegistry.js';

const fallbackLogger = createLogger('fallback');

/**
 * Internal error type thrown when the provider-health registry reports
 * the resolved primary provider as currently open. Carries
 * `httpStatus: 503` so the existing `isRetryableError` check at
 * line ~756 routes the failure into the fallback chain without any
 * special-case handling. The synthetic message contains the
 * remaining cooldown so the log line tells operators when the
 * breaker will close on its own.
 *
 * @internal
 */
class LLMProviderCircuitOpenError extends Error {
  /** Mirrors the HTTP status field on typed provider errors so
   *  {@link isRetryableError} recognizes this as retryable. */
  readonly httpStatus = 503;
  constructor(providerId: string, cooldownRemainingMs: number) {
    super(`[503] Provider '${providerId}' circuit open; cooldown ${cooldownRemainingMs}ms`);
    this.name = 'LLMProviderCircuitOpenError';
  }
}
import type { IModelRouter, ModelRouteParams } from '../core/llm/routing/IModelRouter.js';
import type {
  MessageContent,
  MessageContentPart,
} from '../core/llm/providers/IProvider.js';

// Re-export multimodal types for downstream consumers
export type { MessageContent, MessageContentPart };
export type { HostLLMPolicy } from './runtime/hostPolicy.js';

async function recordAgentOSUsageLazy(
  input: Parameters<typeof import('./runtime/usageLedger.js')['recordAgentOSUsage']>[0]
): Promise<boolean> {
  const { recordAgentOSUsage } = await import('./runtime/usageLedger.js');
  return recordAgentOSUsage(input);
}

/**
 * A single chat message in a conversation history.
 * Mirrors the OpenAI / Anthropic message shape accepted by provider adapters.
 */
export interface Message {
  /** Role of the message author. */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Content of the message. String for text-only, array for multimodal (images + text). */
  content: MessageContent;
}

/**
 * Extract plain text from a MessageContent value.
 * For strings, returns as-is. For arrays, concatenates text parts.
 */
export function extractTextFromContent(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof (p as any).text === 'string')
    .map((p) => p.text)
    .join('\n');
}

/**
 * Record of a single tool invocation performed during a {@link generateText} call.
 * One record is appended per tool call, regardless of whether the call succeeded.
 */
export interface ToolCallRecord {
  /** Name of the tool as registered in the `tools` map. */
  name: string;
  /** Parsed arguments supplied by the model. */
  args: unknown;
  /** Return value from the tool's `execute` function (present on success). */
  result?: unknown;
  /** Error message when the tool threw or returned a failure result. */
  error?: string;
}

/**
 * Token consumption figures reported by the provider for a single completion call.
 * All values are approximate and provider-dependent.
 */
export interface TokenUsage {
  /** Number of tokens in the prompt / input sent to the model. */
  promptTokens: number;
  /** Number of tokens in the model's response. */
  completionTokens: number;
  /** Sum of `promptTokens` and `completionTokens`. */
  totalTokens: number;
  /** Total cost reported by the provider across all steps, when available. */
  costUSD?: number;
  /**
   * Tokens served from the provider's prompt-prefix cache. When present,
   * these were billed at the cache-read rate (0.1× input price on
   * Anthropic) and are NOT also counted in `promptTokens`. Callers that
   * want total tokens-ever-sent should add `promptTokens + cacheReadTokens
   * + cacheCreationTokens`.
   *
   * Undefined when the provider does not report cache usage (OpenAI's
   * auto-cache does not expose this at the per-call layer; Anthropic
   * does via `cache_read_input_tokens`).
   */
  cacheReadTokens?: number;
  /**
   * Tokens written to the provider's prompt-prefix cache as a new cache
   * entry. Billed at the cache-creation rate (1.25× input price on
   * Anthropic for 5-minute TTL, 2× for 1-hour TTL). NOT also counted in
   * `promptTokens`. A `cacheReadTokens` of 0 and `cacheCreationTokens > 0`
   * indicates the first call that filled the cache; subsequent calls
   * with a cache hit flip the numbers.
   */
  cacheCreationTokens?: number;
}

/**
 * Configuration for the optional plan-then-execute planning phase.
 *
 * When `planning` is set to `true` on {@link GenerateTextOptions}, default
 * settings are used.  Pass a `PlanningConfig` object for fine-grained control
 * over the planning LLM call.
 */
export interface PlanningConfig {
  /**
   * Custom system prompt for the planning call.  When omitted a sensible
   * default that asks the model to produce a numbered JSON plan is used.
   */
  systemPrompt?: string;

  /**
   * Sampling temperature for the planning call.
   * Defaults to `0.2` (low creativity, high determinism for plans).
   */
  temperature?: number;

  /**
   * Hard token cap for the planning response.
   * Defaults to `2048`.
   */
  maxTokens?: number;

  /**
   * Per-call request timeout (ms) for the planning completion. Forwarded to
   * the provider so a stalled planning call honors the caller's bound instead
   * of hanging until the provider default.
   */
  requestTimeout?: number;
}

/**
 * A single step in a plan produced by the planning phase.
 * Serialised to / from the JSON plan the LLM emits.
 */
export interface PlanStep {
  /** Human-readable description of what this step accomplishes. */
  description: string;
  /** Name of the tool to invoke, or `null` when the step is pure reasoning. */
  tool: string | null;
  /** Short explanation of why this step is needed. */
  reasoning: string;
}

/**
 * The complete plan returned by {@link createPlan}.
 */
export interface Plan {
  /** Ordered list of steps the agent should follow. */
  steps: PlanStep[];
}

/**
 * Options for a {@link generateText} call.
 * Either `prompt` or `messages` (or both) must be provided.
 */
/**
 * A fallback provider entry specifying an alternative provider (and optionally
 * model) to try when the primary provider fails with a retryable error.
 *
 * @see {@link GenerateTextOptions.fallbackProviders}
 */
export interface FallbackProviderEntry {
  /** Provider identifier (e.g. `"openai"`, `"anthropic"`, `"openrouter"`). */
  provider: string;
  /** Model identifier override. When omitted, the provider's default text model is used. */
  model?: string;
}

/**
 * A structured block of system prompt content with optional cache breakpoint.
 * When `cacheBreakpoint` is true, providers that support prompt caching
 * (e.g., Anthropic) will mark this block's boundary for caching.
 */
export interface SystemContentBlock {
  /** The text content of this block. */
  text: string;
  /** When true, marks the end of this block as a cache boundary. */
  cacheBreakpoint?: boolean;
  /**
   * Cache time-to-live for this breakpoint. Defaults to the provider's
   * standard 5-minute ephemeral cache. Set `'1h'` for the 1-hour cache —
   * worth the higher write premium (2x base input vs 1.25x) on a stable
   * prefix that is re-sent on a slow, human-paced cadence (per-turn narrator
   * / companion calls minutes apart), where the 5-minute cache would expire
   * between turns and never produce reads. Only meaningful with
   * `cacheBreakpoint: true`.
   */
  cacheTtl?: '5m' | '1h';
}

export interface GenerateTextOptions {
  /**
   * Provider name.  When supplied without `model`, the default text model for
   * the provider is resolved automatically from the built-in defaults registry.
   *
   * @example `"openai"`, `"anthropic"`, `"ollama"`
   */
  provider?: string;
  /**
   * Model identifier.  Accepted in two formats:
   * - Plain model name (e.g. `"gpt-4o"`) when `provider` is also set. Preferred.
   * - `"provider:model"` combined string (e.g. `"openai:gpt-4o"`).
   *
   * Either `provider` or `model` (or an API key env var for auto-detection) is required.
   */
  model?: string;
  /** Single user turn to append after any `messages`. Convenience alternative to building a `messages` array. */
  prompt?: string;
  /** System prompt injected as the first message. Accepts a plain string or structured blocks with cache breakpoints. */
  system?: string | SystemContentBlock[];
  /** Full conversation history. Appended before `prompt` when both are supplied. */
  messages?: Message[];
  /**
   * Tools the model may invoke.
   *
   * Accepted forms:
   * - named high-level tool maps
   * - external tool registries (`Record`, `Map`, or iterable)
   * - prompt-only `ToolDefinitionForLLM[]`
   *
   * Prompt-only definitions are visible to the model but return an explicit
   * tool error if the model invokes them without an executor.
   */
  tools?: AdaptableToolInput;
  /**
   * Provider `tool_choice` passthrough. Forwarded verbatim to the provider so
   * callers can force a specific tool, force tool use, or set `'auto'`. Provider
   * support varies; Anthropic + OpenAI honor it. Native path only (ignored on
   * the prompt-emulation shim).
   */
  toolChoice?: string | Record<string, unknown>;
  /**
   * Per-call request timeout in milliseconds, forwarded to the provider for
   * this call only. Large-output callers (e.g. structured-output generation
   * that emits long strings) can raise the abort window without slowing the
   * provider's default failover for chat or narration traffic. Native path
   * only; providers without a request timeout ignore it.
   */
  requestTimeout?: number;
  /**
   * Maximum number of agentic steps (LLM calls) to execute before returning.
   * Each tool-call round trip counts as one step. Defaults to `1`.
   */
  maxSteps?: number;
  /**
   * Tool-calling strategy. `'auto'` (default) uses native provider tool-calling,
   * and on a tool-unsupported provider error falls back to a prompt-based shim
   * (tool schemas rendered into the prompt, `<tool_call>` blocks parsed from the
   * model's text). `'native'` forces native only. `'prompt'` forces the shim.
   * The shim makes AgentOS tools work on models without native tool-use (e.g.
   * the uncensored OpenRouter catalog). Shim roundtrips are capped by `maxSteps`
   * (default 5 when unset on the shim path).
   */
  toolMode?: ToolMode;
  /** Sampling temperature forwarded to the provider (0-2 for most providers). */
  temperature?: number;
  /** Hard cap on output tokens. Provider-dependent default applies when omitted. */
  maxTokens?: number;
  /**
   * Extended-thinking switch forwarded to thinking-capable models (Opus
   * 4.7/4.8). Any positive `budgetTokens` enables adaptive thinking — the
   * only form this family accepts; the number itself is not sent and
   * `maxTokens` passes through unchanged. Omitted = thinking off (provider
   * default behavior). Has no effect on models that do not support thinking.
   */
  thinking?: { budgetTokens: number };
  /**
   * Reasoning depth / token-spend control forwarded to effort-capable models
   * (Opus 4.5+, Sonnet 4.6, Fable/Mythos 5) as `output_config.effort`
   * (low|medium|high|xhigh|max). Independent of `thinking` and tool_choice; the
   * provider drops it on unsupported models or invalid values.
   */
  effort?: string;
  /** Override the API key instead of reading from environment variables. */
  apiKey?: string;
  /** Override the provider base URL (useful for local proxies or Ollama). */
  baseUrl?: string;
  /** Optional durable usage ledger configuration for helper-level accounting. */
  usageLedger?: AgentOSUsageLedgerOptions;
  /**
   * Chain-of-thought instruction prepended to the system prompt when tools
   * are available.  Encourages the model to reason explicitly before choosing
   * an action.
   *
   * - `false` (default): no CoT injection.
   * - `true`: inject the default CoT instruction.
   * - `string`: inject a custom CoT instruction.
   */
  chainOfThought?: boolean | string;
  /**
   * Enable plan-then-execute mode.  When `true` (or a {@link PlanningConfig}),
   * an upfront LLM call decomposes the task into numbered steps before the
   * tool-calling loop begins.  The plan is injected into the system prompt
   * so the model executes with full awareness of the strategy.
   *
   * Set to `false` or omit to skip planning entirely (the default).
   */
  planning?: boolean | PlanningConfig;
  /**
   * Ordered list of fallback providers to try when the primary provider fails
   * with a retryable error (HTTP 402/429/5xx, network errors, auth failures).
   *
   * **Default behavior (omit / `undefined`):** auto-build the canonical
   * fallback chain for the primary provider via {@link buildFallbackChain},
   * filtered to providers that have API keys present in the environment.
   * No import needed: fallback is on by default.
   *
   * **Strict mode (`[]`):** explicitly opt out of fallback. The primary
   * provider's error is re-thrown after exhausting any provider-internal
   * retries. Use this when billing isolation, capability auditing, or
   * provider-pinned testing requires a single-provider guarantee.
   *
   * **Custom chain (array of entries):** specify exactly which providers
   * (and optional model overrides) to try, in order. Each entry's model
   * defaults to the provider's text-generation default from
   * {@link PROVIDER_DEFAULTS} when omitted. Providers are tried
   * left-to-right; the first successful response wins.
   *
   * @example Default: auto-fallback through the canonical chain
   * ```ts
   * const result = await generateText({
   *   provider: 'anthropic',
   *   prompt: 'Hello',
   * });
   * // On retryable Anthropic failure, walks anthropic -> openai -> gemini -> ...
   * ```
   *
   * @example Strict mode: fail if the primary is unavailable
   * ```ts
   * const result = await generateText({
   *   provider: 'anthropic',
   *   prompt: 'Hello',
   *   fallbackProviders: [],
   * });
   * ```
   *
   * @example Custom chain
   * ```ts
   * const result = await generateText({
   *   provider: 'anthropic',
   *   prompt: 'Hello',
   *   fallbackProviders: [
   *     { provider: 'openai', model: 'gpt-4o-mini' },
   *     { provider: 'openrouter' },
   *   ],
   * });
   * ```
   */
  fallbackProviders?: FallbackProviderEntry[];
  /**
   * Callback invoked when a fallback provider is about to be tried after the
   * primary (or a previous fallback) failed.  Useful for logging or metrics.
   *
   * @param error - The error that triggered the fallback.
   * @param fallbackProvider - The provider identifier being tried next.
   */
  onFallback?: (error: Error, fallbackProvider: string) => void;
  /**
   * Optional source label forwarded to the global LLM usage observer
   * registered via {@link setGlobalLlmObserver}. Hosts use this to
   * tag the emitted telemetry row with a caller-defined meter key
   * (e.g. 'narrator_turn', 'companion_reply', 'world_compile_job').
   *
   * Has no effect when no observer is registered.
   */
  source?: string;
  /**
   * Optional model router for intelligent provider/model selection.
   * When provided, the router's `selectModel()` is called before provider
   * resolution.  The router result overrides `model`/`provider`.
   * If the router returns `null`, falls back to standard resolution.
   */
  router?: IModelRouter;
  /**
   * Routing hints passed to the model router.  Extracted automatically
   * from system prompt and tool names when not provided.
   */
  routerParams?: Partial<ModelRouteParams>;
  /**
   * Host-level routing hints that can be forwarded into the model router
   * without requiring callers to construct raw router params directly.
   */
  hostPolicy?: HostLLMPolicy;
  /**
   * Caller's intended content policy tier. When set to `'mature'` or
   * `'private-adult'` AND no explicit `fallbackProviders` was supplied,
   * the auto-built fallback chain is constructed via
   * {@link buildPolicyAwareFallbackChain} instead of the default
   * availability chain: prepending an uncensored OpenRouter model
   * (Hermes 3 405B) so a content-policy refusal from the primary
   * (gpt-4o, Claude, etc.) re-routes to a model that can complete
   * the request rather than hard-failing.
   *
   * Combined with the {@link isContentPolicyRefusal} branch in
   * {@link isRetryableError}, this also makes the existing fallback
   * loop fire on OpenAI's 400 + `code: 'content_policy_violation'`
   *: which the network-only retryable matrix would otherwise treat
   * as a hard error.
   *
   * Has no effect for `safe`/`standard` tiers (or when omitted):
   * those keep the existing availability-only fallback behavior.
   *
   * Mirrors the existing `policyTier` parameter on
   * {@link import('./generateImage.js').GenerateImageOptions} and
   * {@link import('./editImage.js').EditImageOptions}.
   */
  policyTier?: 'safe' | 'standard' | 'mature' | 'private-adult';
  /**
   * Called before each LLM generation step.  Can inject memory context
   * into messages, sanitize input via guardrails, or modify the prompt.
   * Return a modified context to transform input, or void to pass through.
   */
  onBeforeGeneration?: (context: GenerationHookContext) => Promise<GenerationHookContext | void>;
  /**
   * Called after each LLM generation step.  Can check output against
   * guardrails, redact PII, or transform the response.
   * Return a modified result to transform output, or void to pass through.
   */
  onAfterGeneration?: (result: GenerationHookResult) => Promise<GenerationHookResult | void>;
  /**
   * Called before each tool execution.  Can modify arguments, apply
   * permission checks, or return `null` to skip the tool call entirely.
   */
  onBeforeToolExecution?: (info: ToolCallHookInfo) => Promise<ToolCallHookInfo | null>;
  /**
   * @internal Used by generateObject and AgentSession.send (with
   * responseSchema) to forward a provider-specific response_format
   * payload to the provider. Not part of the public API.
   *
   * Shape varies by provider: OpenAI accepts json_object or
   * json_schema, Anthropic uses an internal _agentosUseToolForStructuredOutput
   * marker that AnthropicProvider routes to forced tool_use, Gemini uses
   * a _gemini.responseSchema extra. The provider implementations consume
   * whatever shape is here.
   */
  _responseFormat?: { type: string } | Record<string, unknown>;
}

/**
 * The completed result returned by {@link generateText}.
 */
export interface GenerateTextResult {
  /** Provider identifier used for the final run. */
  provider: string;
  /** Resolved model identifier used for the run. */
  model: string;
  /** Final assistant text after all agentic steps have completed. */
  text: string;
  /** Aggregated token usage across all steps. */
  usage: TokenUsage;
  /** Ordered list of every tool call made during the run. */
  toolCalls: ToolCallRecord[];
  /**
   * Reason the model stopped generating.
   * - `"stop"`: natural end of response.
   * - `"length"`: `maxTokens` limit reached.
   * - `"tool-calls"`: loop exhausted `maxSteps` while still calling tools.
   * - `"error"`: provider returned an error.
   */
  finishReason: 'stop' | 'length' | 'tool-calls' | 'error';
  /**
   * Ordered records of every sub-agent call made during an `agency()` run.
   * `undefined` for plain `generateText` / `agent()` calls.
   */
  agentCalls?: AgentCallRecord[];
  /**
   * Structured trace events emitted during the run.
   * Populated by the agency orchestrator; `undefined` for single-agent calls.
   */
  trace?: AgencyTraceEvent[];
  /**
   * Parsed structured output produced when `BaseAgentConfig.output` is a Zod
   * schema.  `undefined` when no output schema is configured.
   */
  parsed?: unknown;
  /**
   * The plan produced by the planning phase when `planning` is enabled.
   * `undefined` when planning is disabled or was not requested.
   */
  plan?: Plan;
  /**
   * Per-claim citation verdicts attached when `agent({ verifyCitations: … })`
   * is configured. `undefined` when verification was not requested or could
   * not run for this turn.
   *
   * @see {@link import('./types.js').VerifyCitationsConfig}
   */
  grounding?: import('../cognition/rag/citation/types.js').VerifiedResponse;
}

// ---------------------------------------------------------------------------
// Generation lifecycle hook types
// ---------------------------------------------------------------------------

/**
 * Context available to pre-generation hooks.
 * Hooks may return a modified copy to transform the generation input.
 */
export interface GenerationHookContext {
  /** Current messages array (system + conversation + user). */
  messages: Message[];
  /** System prompt: plain string or structured blocks with cache breakpoints. */
  system: string | SystemContentBlock[] | undefined;
  /** Tool definitions available for this step. */
  tools: ITool[];
  /** Resolved model ID. */
  model: string;
  /** Resolved provider ID. */
  provider: string;
  /** Current agentic step index (0-based). */
  step: number;
  /** The original user prompt (from opts.prompt). */
  prompt: string | undefined;
}

/**
 * Context available to post-generation hooks.
 * Hooks may return a modified copy to transform the generation output.
 */
export interface GenerationHookResult {
  /** Generated text from the LLM. */
  text: string;
  /** Tool calls requested by the LLM. */
  toolCalls: ToolCallRecord[];
  /** Token usage for this step. */
  usage: TokenUsage;
  /** Current agentic step index (0-based). */
  step: number;
}

/**
 * Info about a tool call before execution.
 * Hooks may return a modified copy or `null` to skip execution.
 */
export interface ToolCallHookInfo {
  /** Tool name. */
  name: string;
  /** Parsed arguments. */
  args: Record<string, unknown>;
  /** Tool call ID from the LLM. */
  id: string;
  /** Current agentic step index. */
  step: number;
}

// ---------------------------------------------------------------------------
// Chain-of-thought helpers
// ---------------------------------------------------------------------------

/**
 * Default chain-of-thought instruction prepended to the system prompt when
 * tools are available and `chainOfThought` is enabled.  Encourages the model
 * to reason explicitly before selecting a tool or crafting a response.
 */
export const DEFAULT_COT_INSTRUCTION = `Before choosing an action, briefly reason about what you need to do and why. Consider:
1. What information do you already have?
2. What information do you need?
3. Which tool is most appropriate and why?
4. How does your communication style (from the Personality section, if present) influence how you should frame your response?
Then proceed with your tool call or response.`;

/**
 * Resolves the chain-of-thought instruction from the `chainOfThought` option.
 *
 * @param cot - The `chainOfThought` option value.
 * @returns The resolved CoT instruction string, or `undefined` if disabled.
 *
 * @internal
 */
export function resolveChainOfThought(cot: boolean | string | undefined): string | undefined {
  if (!cot) return undefined;
  if (typeof cot === 'string') return cot;
  return DEFAULT_COT_INSTRUCTION;
}

// ---------------------------------------------------------------------------
// Planning helpers
// ---------------------------------------------------------------------------

/**
 * Default system prompt used when planning is enabled without a custom prompt.
 * Instructs the model to decompose the user's request into a numbered JSON plan.
 */
const DEFAULT_PLANNING_SYSTEM_PROMPT = `You are planning how to accomplish the user's request. Break it into numbered steps.
Describe what tools you'll need for each step. Output a JSON plan:
{"steps": [{"description": "...", "tool": "tool_name_or_null", "reasoning": "..."}]}
Return ONLY the JSON object: no markdown fences, no commentary.`;

/**
 * Makes a single LLM call to create an execution plan before the tool loop.
 *
 * The plan is a lightweight JSON object containing ordered steps.  It is
 * injected into the system prompt for the subsequent tool loop so the model
 * executes with full awareness of the strategy.
 *
 * @param provider - The resolved LLM provider instance.
 * @param modelId - Model identifier to use for the planning call.
 * @param userMessages - The user-supplied messages that describe the task.
 * @param toolNames - Names of available tools (informational context for the planner).
 * @param config - Optional planning configuration overrides.
 * @param totalUsage - Mutable usage aggregator: the planning call's tokens are added here.
 * @returns The parsed {@link Plan}, or `undefined` if parsing fails gracefully.
 *
 * @internal
 */
export async function createPlan(
  provider: { generateCompletion: (...args: any[]) => Promise<any> },
  modelId: string,
  userMessages: Array<Record<string, unknown>>,
  toolNames: string[],
  config: PlanningConfig | undefined,
  totalUsage: TokenUsage,
): Promise<Plan | undefined> {
  const systemPrompt = config?.systemPrompt ?? DEFAULT_PLANNING_SYSTEM_PROMPT;
  const temperature = config?.temperature ?? 0.2;
  const maxTokens = config?.maxTokens ?? 2048;
  const requestTimeout = config?.requestTimeout;

  // Build the planning conversation: system prompt + user context
  const planMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
  ];

  // Inject available tool names so the planner knows what's available
  if (toolNames.length > 0) {
    planMessages.push({
      role: 'system',
      content: `Available tools: ${toolNames.join(', ')}`,
    });
  }

  // Append the user messages so the planner can see the actual request
  for (const msg of userMessages) {
    planMessages.push(msg);
  }

  const response = await provider.generateCompletion(modelId, planMessages, {
    temperature,
    maxTokens,
    ...(requestTimeout !== undefined ? { requestTimeout } : {}),
  });

  // Accumulate planning call usage
  if (response.usage) {
    totalUsage.promptTokens += response.usage.promptTokens ?? 0;
    totalUsage.completionTokens += response.usage.completionTokens ?? 0;
    totalUsage.totalTokens += response.usage.totalTokens ?? 0;
    if (typeof response.usage.costUSD === 'number') {
      totalUsage.costUSD = (totalUsage.costUSD ?? 0) + response.usage.costUSD;
    }
    // Provider-layer ModelUsage carries prompt-cache metrics that were
    // previously dropped by the TokenUsage mapping. Plumb them through
    // so callers can see cache hit rate and per-hit savings.
    const cacheRead = (response.usage as { cacheReadInputTokens?: number }).cacheReadInputTokens;
    const cacheCreate = (response.usage as { cacheCreationInputTokens?: number }).cacheCreationInputTokens;
    if (typeof cacheRead === 'number' && cacheRead > 0) {
      totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + cacheRead;
    }
    if (typeof cacheCreate === 'number' && cacheCreate > 0) {
      totalUsage.cacheCreationTokens = (totalUsage.cacheCreationTokens ?? 0) + cacheCreate;
    }
  }

  const rawContent = response.choices?.[0]?.message?.content;
  const planText = typeof rawContent === 'string' ? rawContent: '';

  try {
    const parsed = JSON.parse(planText);
    if (Array.isArray(parsed.steps)) {
      return {
        steps: parsed.steps.map((s: any) => ({
          description: String(s.description ?? ''),
          tool: s.tool ?? null,
          reasoning: String(s.reasoning ?? ''),
        })),
      };
    }
  } catch {
    // If the model returns malformed JSON, fall through gracefully:
    // the tool loop will still proceed, just without an explicit plan.
  }
  return undefined;
}

/**
 * Formats a {@link Plan} into a human-readable string suitable for injection
 * into the system prompt of the tool-calling loop.
 *
 * @param plan - The plan to format.
 * @returns A multi-line string with numbered steps.
 *
 * @internal
 */
function formatPlanForPrompt(plan: Plan): string {
  const lines = plan.steps.map(
    (s, i) =>
      `${i + 1}. ${s.description}${s.tool ? ` [tool: ${s.tool}]`: ''}`,
  );
  return `Follow this plan:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Fallback helpers
// ---------------------------------------------------------------------------

/**
 * HTTP status codes and network error patterns that indicate a transient or
 * provider-level failure worth retrying with a different provider.
 *
 * Matched status codes:
 * - `401` / `403`: authentication / authorization failure (key expired or wrong provider).
 * - `402`: payment required (quota exhausted).
 * - `429`: rate limit exceeded.
 * - `500` / `502` / `503` / `504`: server-side errors.
 *
 * Matched network errors:
 * - `fetch failed`: generic fetch rejection (DNS, TLS, etc.).
 * - `ECONNREFUSED` / `ETIMEDOUT` / `ENOTFOUND`: socket-level failures.
 *
 * @param error - The error to inspect.
 * @returns `true` when the error is likely transient and a different provider
 *   might succeed; `false` for deterministic user-input errors.
 *
 * @internal
 */
const RETRYABLE_HTTP_STATUSES = new Set([401, 402, 403, 429, 500, 502, 503, 504]);

/**
 * Detect content-policy refusals across providers so the fallback chain
 * can route them to a more permissive model (typically uncensored
 * OpenRouter for mature/private-adult callers). The provider matrix:
 *
 *   - OpenAI: HTTP 400 with `error.code: 'content_policy_violation'` or
 *     `error.type: 'content_policy_violation'`. Also surfaces as a
 *     400 with a `safety_violations` block on the structured-output
 *     path, which message-greps catch via "content_policy".
 *   - Anthropic: HTTP 400 with messages like "blocked by Anthropic's
 *     usage policies" or "violates safety guidelines". Recent SDKs
 *     also emit `error.type: 'content_filter'`.
 *   - Gemini: Doesn't error: instead returns `finishReason: 'SAFETY'`
 *     in the response. Caller-side detection catches that path; this
 *     helper only matches the error-shaped variants because the
 *     fallback chain only fires on thrown errors.
 *   - OpenRouter: forwards the upstream provider's error mostly
 *     verbatim, so the OpenAI/Anthropic patterns above also catch
 *     OpenRouter routes against gpt-4o / claude.
 *
 * Returns true when the message + typed fields together indicate a
 * content-policy refusal. The caller (the fallback loop in
 * generateText) treats this as "retryable in the policy sense" so
 * a content-policy fallback chain can fire on a 400 even though
 * the network fallback chain wouldn't.
 *
 * @internal
 */
export function isContentPolicyRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  const errorType = (error as { type?: unknown }).type;
  // Typed-field detection runs first: providers with structured error
  // shapes are the reliable signal. Substring grep is the message-only
  // fallback for older SDKs / wrapped errors.
  if (typeof code === 'string') {
    const c = code.toLowerCase();
    if (c === 'content_policy_violation' || c === 'content_filter' || c === 'safety_violations') {
      return true;
    }
  }
  if (typeof errorType === 'string') {
    const t = errorType.toLowerCase();
    if (t === 'content_policy_violation' || t === 'content_filter' || t === 'safety_violations') {
      return true;
    }
  }
  // Nested OpenAI error envelope (httpStatus 400 with a nested
  // `error.code` from `details`). Some agentos providers re-throw
  // with the raw upstream JSON in `details.error.code`.
  const details = (error as { details?: unknown }).details;
  if (details && typeof details === 'object') {
    const inner = (details as { error?: unknown }).error;
    if (inner && typeof inner === 'object') {
      const innerCode = (inner as { code?: unknown }).code;
      const innerType = (inner as { type?: unknown }).type;
      if (typeof innerCode === 'string'
        && /content_policy|content_filter|safety_violation/i.test(innerCode)) {
        return true;
      }
      if (typeof innerType === 'string'
        && /content_policy|content_filter|safety_violation/i.test(innerType)) {
        return true;
      }
    }
  }
  const msg = error.message ?? '';
  return /content[_ ]policy|content filter|safety guidelines|safety policy|blocked by .*'s? usage policies|safety_violations|usage policies/i.test(msg);
}

export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // Typed provider errors carry the HTTP status as a numeric field. Prefer that
  // over message-grepping, since providers often substitute the body description
  // (e.g. "This request requires more credits...") for the status code.
  const status = (error as { httpStatus?: unknown }).httpStatus;
  if (typeof status === 'number' && RETRYABLE_HTTP_STATUSES.has(status)) return true;

  const msg = error.message;
  // HTTP status codes that warrant a provider switch (string-grepped fallback
  // when the error type is not a typed provider error).
  if (/\b(402|429|500|502|503|504|401|403)\b/.test(msg)) return true;
  // Network-level failures
  if (/fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(msg)) return true;
  // Provider-specific phrases that always imply a retryable condition.
  // `credit balance` covers Anthropic's billing message ("Your credit
  // balance is too low to access the Anthropic API") which carries
  // none of the other phrases and is only otherwise caught by the
  // numeric httpStatus 402 branch — a wrapped / re-thrown error that
  // loses the typed `httpStatus` field would slip through without it.
  if (
    /requires more credits|insufficient credits|credit balance|rate limit|quota|exceeded your current quota/i.test(
      msg,
    )
  ) {
    return true;
  }
  // Content-policy refusals: the policy-aware fallback chain (see
  // buildPolicyAwareFallbackChain) should fire on these so callers
  // who tagged their request with policyTier=mature/private-adult
  // get re-routed to an uncensored model instead of a hard error.
  // Without this, OpenAI's 400 on a refusal escapes the fallback
  // loop and the caller sees a raw provider error.
  if (isContentPolicyRefusal(error)) return true;
  return false;
}

/**
 * Auto-discovers available LLM providers from well-known environment variables
 * and builds an ordered fallback chain.
 *
 * Each entry in the returned array contains a provider identifier and an
 * optional cheap model suitable for fallback use.  Providers are ordered by
 * general availability and cost-effectiveness:
 * 1. OpenAI (`gpt-4o-mini`)
 * 2. Anthropic (`claude-haiku-4-5-20251001`)
 * 3. OpenRouter (default model)
 * 4. Gemini (`gemini-2.5-flash`)
 *
 * @param excludeProvider - Provider to omit from the chain (typically the
 *   primary provider that already failed).
 * @returns An array of `{ provider, model? }` entries ready for use as
 *   {@link GenerateTextOptions.fallbackProviders}.
 *
 * @example
 * ```ts
 * // Primary is anthropic: build fallback chain from remaining providers
 * const chain = buildFallbackChain('anthropic');
 * // => [{ provider: 'openai', model: 'gpt-4o-mini' }, { provider: 'openrouter' }, ...]
 * ```
 */
export function buildFallbackChain(
  excludeProvider?: string,
): FallbackProviderEntry[] {
  const chain: FallbackProviderEntry[] = [];

  if (process.env.OPENAI_API_KEY && excludeProvider !== 'openai') {
    chain.push({ provider: 'openai', model: 'gpt-4o-mini' });
  }
  if (process.env.ANTHROPIC_API_KEY && excludeProvider !== 'anthropic') {
    chain.push({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' });
  }
  if (process.env.OPENROUTER_API_KEY && excludeProvider !== 'openrouter') {
    // Pin a cheap last-resort model. A model-less OpenRouter entry defaults
    // to `openai/gpt-4o` (the OpenRouter provider's `defaultModel`), so
    // failover traffic silently lands on the priciest sensible model — that
    // made `openrouter/openai/gpt-4o` the #1 LLM cost in wilds prod
    // (2026-06-07, ~half the LLM bill). gpt-4o-mini is ~16x cheaper, same
    // family (structured-output safe), and routes around an OpenAI-direct
    // outage that already knocked the `openai` link above out.
    chain.push({ provider: 'openrouter', model: 'openai/gpt-4o-mini' });
  }
  if (process.env.GEMINI_API_KEY && excludeProvider !== 'gemini') {
    chain.push({ provider: 'gemini' });
  }

  return chain;
}

/**
 * Build a policy-tier-aware fallback chain. Used by callers that pass
 * `policyTier: 'mature' | 'private-adult'` so refusals from the
 * primary model (typically gpt-4o, Claude, Gemini: all of which
 * moderate explicit content) re-route to an uncensored OpenRouter
 * model instead of hard-failing the request.
 *
 * Chain order for mature / private-adult:
 *   1. `nousresearch/hermes-3-llama-3.1-405b` on OpenRouter: leads
 *      the uncensored leaderboard for instruction-following + long-
 *      context comprehension. Same model the wilds-ai
 *      companion-pipeline uses for identity generation on mature+
 *      companions; battle-tested on real workloads.
 *   2. `anthropic/claude-sonnet-4` on OpenRouter: Claude refuses
 *      hard NSFW but is markedly more permissive than gpt-4o for
 *      narrative analysis of explicit fiction (extracting characters
 *      from a CAI-export with mild adult content, etc.). Acts as the
 *      headroom band when Hermes 3 is rate-limited or down.
 *   3. The standard {@link buildFallbackChain} suffix: keeps
 *      availability fallback on top of the policy fallback so a
 *      mature request that hits a Hermes 3 outage AND a Sonnet
 *      outage still has gpt-4o-mini etc. to fall back to (which
 *      will refuse on the explicit case but at least surfaces a
 *      moderation error rather than a network error).
 *
 * For `safe` / `standard` tiers, this is identical to
 * {@link buildFallbackChain}: no uncensored prefix needed. Callers
 * that don't pass a tier should keep using the original builder.
 *
 * Auto-built fallbacks always require their own env keys; missing
 * keys silently drop the entry rather than throwing, so a partial
 * deploy still produces a usable (shorter) chain.
 *
 * @param tier - Caller's intended content tier. Mature/private-adult
 *   triggers the uncensored prefix; safe/standard returns the
 *   availability-only chain.
 * @param excludeProvider - Provider to omit (typically the primary
 *   that already failed). Mirrors {@link buildFallbackChain}.
 * @returns Ordered fallback entries: uncensored prefix (when tier
 *   warrants it) + availability suffix.
 */
export function buildPolicyAwareFallbackChain(
  tier: 'safe' | 'standard' | 'mature' | 'private-adult' | undefined,
  excludeProvider?: string,
): FallbackProviderEntry[] {
  const isMatureTier = tier === 'mature' || tier === 'private-adult';
  if (!isMatureTier) {
    return buildFallbackChain(excludeProvider);
  }

  const chain: FallbackProviderEntry[] = [];

  // Hermes 3 405B leads: uncensored, large, instruction-following
  // proven on the wilds-ai identity-generation path. Skipped when
  // OPENROUTER_API_KEY is absent rather than throwing; the suffix
  // chain may still produce a usable fallback.
  if (process.env.OPENROUTER_API_KEY) {
    chain.push({
      provider: 'openrouter',
      model: 'nousresearch/hermes-3-llama-3.1-405b',
    });
    // Sonnet via OpenRouter as the second uncensored band. We keep
    // it on OpenRouter (not direct Anthropic) because the chain's
    // `excludeProvider` semantics treat each entry as a provider
    // ID: using `anthropic` here would lock out the suffix's
    // Anthropic fallback. OpenRouter routes Claude under its own
    // billing surface, so the slot is independent.
    chain.push({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
    });
  }

  // Append the standard availability chain. Filter out duplicates
  // since the uncensored prefix may have already added openrouter.
  const availability = buildFallbackChain(excludeProvider);
  for (const entry of availability) {
    const alreadyInChain = chain.some(
      (existing) =>
        existing.provider === entry.provider && existing.model === entry.model,
    );
    if (!alreadyInChain) chain.push(entry);
  }
  return chain;
}

function buildHelperToolExecutionContext(
  source: 'generateText',
  runId: string,
  stepIndex: number,
  correlationId?: string,
): ToolExecutionContext {
  return {
    gmiId: `${source}:${runId}`,
    personaId: `${source}:persona`,
    userContext: {
      userId: 'system',
      source,
    },
    correlationId: correlationId ?? `${source}:tool:${stepIndex + 1}:${randomUUID()}`,
    sessionData: {
      sessionId: `${source}:${runId}`,
      source,
      stepIndex,
    },
  };
}

/**
 * Stateless text generation with optional multi-step tool calling.
 *
 * Creates a temporary provider manager, executes one or more LLM completion
 * steps (each tool-call round trip counts as one step), and returns the final
 * assembled result.  Provider credentials are resolved from environment
 * variables unless overridden in `opts`.
 *
 * When `planning` is enabled, an upfront LLM call produces a step-by-step plan
 * that is then injected into the system prompt for the tool loop.
 *
 * @param opts - Generation options including model, prompt/messages, and optional tools.
 * @returns A promise that resolves to the final text, token usage, tool call log, and finish reason.
 *
 * @example
 * ```ts
 * const result = await generateText({
 *   provider: 'openai',
 *   model: 'gpt-4o',
 *   prompt: 'Summarise the history of the Roman Empire in two sentences.',
 * });
 * console.log(result.text);
 * ```
 */
export async function generateText(opts: GenerateTextOptions): Promise<GenerateTextResult> {
  const startedAt = Date.now();
  let metricStatus: 'ok' | 'error' = 'ok';
  let metricUsage: TokenUsage | undefined;
  let metricProviderId: string | undefined;
  let metricModelId: string | undefined;

  try {
    const successResult: GenerateTextResult = await withAgentOSSpan('agentos.api.generate_text', async (span) => {
      let { providerId, modelId } = resolveModelOption(opts, 'text');

      // --- Model routing (optional) ---
      if (opts.router) {
        try {
          const toolNames = opts.tools
            ? (Array.isArray(opts.tools)
                ? opts.tools
               : [...((opts.tools as any).values?.() ?? [])]
              )
                .map((t: any) => t.name ?? t.function?.name)
                .filter(Boolean) as string[]
           : [];
          const hostPolicyRouteParams = hostPolicyToRouteParams(opts.hostPolicy);
          const requiredCapabilities = mergeRequiredCapabilities(
            hostPolicyRouteParams.requiredCapabilities,
            opts.routerParams?.requiredCapabilities,
            toolNames.length > 0 ? ['function_calling']: undefined,
          );
          const routeParams: ModelRouteParams = {
            taskHint:
              opts.routerParams?.taskHint ?? (typeof opts.system === 'string' ? opts.system: undefined) ?? opts.prompt ?? '',
            ...hostPolicyRouteParams,
            ...opts.routerParams,
            optimizationPreference:
              opts.routerParams?.optimizationPreference
              ?? hostPolicyRouteParams.optimizationPreference
              ?? 'balanced',
            requiredCapabilities,
            preferredProviderIds:
              opts.routerParams?.preferredProviderIds
              ?? hostPolicyRouteParams.preferredProviderIds,
            policyTier:
              opts.routerParams?.policyTier
              ?? hostPolicyRouteParams.policyTier,
          };
          const routeResult = await opts.router.selectModel(
            routeParams,
            undefined,
          );
          if (routeResult) {
            providerId =
              routeResult.modelInfo?.providerId ?? providerId;
            modelId = routeResult.modelId;
          }
        } catch (routerErr) {
          console.warn(
            '[agentos] Model router error, falling back to standard resolution:',
            routerErr,
          );
        }
      }

      const resolved = resolveProvider(providerId, modelId, {
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
      });
      metricProviderId = resolved.providerId;
      metricModelId = resolved.modelId;

      // ── Provider health circuit-breaker ──────────────────────────────
      // If the resolved primary has tripped its breaker (e.g. a recent
      // 402 / 401), skip the network call entirely and let the catch
      // block route us into the fallback chain. The synthetic 503-coded
      // error matches `isRetryableError`'s retryable-status list and
      // flows through `fallback_fired` like any other transient
      // failure: but with zero network latency. See
      // {@link LLMProviderHealthRegistry} for the policy that decides
      // when a provider is considered open. This check runs BEFORE
      // `createProviderManager` so we don't spend the SDK init cost
      // on a known-bad provider either.
      if (globalLLMProviderHealth.isOpen(resolved.providerId)) {
        const stats = globalLLMProviderHealth.getStats(resolved.providerId);
        throw new LLMProviderCircuitOpenError(
          resolved.providerId,
          stats?.cooldownRemainingMs ?? 0,
        );
      }

      const manager = await createProviderManager(resolved);
      const provider = manager.getProvider(resolved.providerId);
      if (!provider) throw new Error(`Provider ${resolved.providerId} not available.`);

      span?.setAttribute('llm.provider', resolved.providerId);
      span?.setAttribute('llm.model', resolved.modelId);

      const tools = adaptTools(opts.tools);
      const toolMap = new Map<string, ITool>();
      for (const t of tools) toolMap.set(t.name, t);
      const helperToolRunId = randomUUID();

      // Build messages
      const messages: Array<Record<string, unknown>> = [];

      // --- Chain-of-thought injection ---
      // When CoT is enabled and tools are provided, prepend a reasoning
      // instruction to the system prompt so the model explicitly reasons
      // before selecting a tool or composing a response.
      const cotInstruction = resolveChainOfThought(opts.chainOfThought);
      const hasTools = tools.length > 0;

      if (typeof opts.system === 'string' || !opts.system) {
        // Plain string system prompt (existing behavior)
        if (cotInstruction && hasTools) {
          const systemContent = opts.system
            ? `${cotInstruction}\n\n${opts.system}`
           : cotInstruction;
          messages.push({ role: 'system', content: systemContent });
        } else if (opts.system) {
          messages.push({ role: 'system', content: opts.system });
        }
      } else {
        // Structured SystemContentBlock[]: convert to content parts with cache_control
        const blocks = opts.system as SystemContentBlock[];
        const parts = blocks.map(block => ({
          type: 'text' as const,
          text: block.text,
          ...(block.cacheBreakpoint
            ? { cache_control: { type: 'ephemeral' as const, ...(block.cacheTtl === '1h' ? { ttl: '1h' as const } : {}) } }
            : {}),
        }));

        // Prepend CoT instruction as the first non-cached block if needed
        if (cotInstruction && hasTools) {
          parts.unshift({ type: 'text' as const, text: cotInstruction });
        }

        messages.push({ role: 'system', content: parts });
      }

      if (opts.messages) {
        for (const m of opts.messages) messages.push({ role: m.role, content: m.content });
      }
      if (opts.prompt) messages.push({ role: 'user', content: opts.prompt });

      span?.setAttribute('agentos.api.tool_count', tools.length);

      const toolSchemas =
        tools.length > 0
          ? tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            }))
         : undefined;

      const allToolCalls: ToolCallRecord[] = [];
      const totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      const maxSteps = opts.maxSteps ?? 1;
      span?.setAttribute('agentos.api.max_steps', maxSteps);

      // -----------------------------------------------------------------
      // Planning phase (optional)
      // When `opts.planning` is truthy, make one LLM call to decompose the
      // task into a numbered step list.  The plan is injected into the
      // message array as a system message so the tool loop is plan-aware.
      // -----------------------------------------------------------------
      let resolvedPlan: Plan | undefined;
      const planningEnabled = !!opts.planning;
      span?.setAttribute('agentos.api.planning_enabled', planningEnabled);

      if (planningEnabled) {
        const planConfig = typeof opts.planning === 'object' ? opts.planning: undefined;

        // Collect only user-role messages for the planner
        const userMessages = messages.filter((m) => m.role === 'user');
        const toolNames = tools.map((t) => t.name);

        resolvedPlan = await createPlan(
          provider,
          resolved.modelId,
          userMessages,
          toolNames,
          // Thread the caller's per-call requestTimeout into the planning
          // completion (a planning-specific override on planConfig wins).
          { ...planConfig, requestTimeout: planConfig?.requestTimeout ?? opts.requestTimeout },
          totalUsage,
        );

        if (resolvedPlan) {
          // Inject the plan as a system message right after any existing
          // system messages so the tool loop executes plan-aware.
          const planPrompt = formatPlanForPrompt(resolvedPlan);
          const firstNonSystem = messages.findIndex((m) => m.role !== 'system');
          const insertIdx = firstNonSystem === -1 ? messages.length: firstNonSystem;
          messages.splice(insertIdx, 0, { role: 'system', content: planPrompt });
          span?.setAttribute('agentos.api.plan_steps', resolvedPlan.steps.length);
        }
      }

      // --- Prompt-based tool-calling shim (toolMode) ---
      // For models without native tool-use, render tool schemas into the
      // prompt and parse <tool_call> blocks out of the model's text. 'prompt'
      // forces it up front; 'auto' tries native first and falls back on the
      // provider's tool-unsupported error (see the catch after the loop).
      const toolMode: ToolMode = opts.toolMode ?? 'auto';
      const shimMaxRoundtrips = opts.maxSteps ?? 5;
      const runShim = async (): Promise<GenerateTextResult> => {
        const loopResult = await runEmulatedToolLoop({
          tools: Array.from(toolMap.values()),
          messages: messages.map((m) => ({
            role: String(m.role),
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
          })),
          maxRoundtrips: shimMaxRoundtrips,
          callModel: async (msgs) => {
            const r = await provider.generateCompletion(resolved.modelId, msgs as any, {
              temperature: opts.temperature,
              maxTokens: opts.maxTokens,
              // Forward the extended-thinking budget on the shim path too so
              // thinking-capable models stay consistent across tool modes;
              // the provider decides applicability. Omitted = thinking off.
              ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
              // Forward reasoning effort the same way; provider drops it on
              // unsupported models/values.
              ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
              // Forward per-call requestTimeout so the prompt-tool-calling shim
              // (toolMode:'prompt') honors the caller's timeout like the native
              // step loop already does. Without it, a stalled provider call on
              // this path hangs until the provider's own default, silently
              // ignoring the caller's requestTimeout bound.
              ...(opts.requestTimeout !== undefined ? { requestTimeout: opts.requestTimeout } : {}),
            } as any);
            const cc = r.choices?.[0]?.message?.content;
            return {
              text: typeof cc === 'string' ? cc : ((cc as any)?.text ?? ''),
              usage: { totalTokens: r.usage?.totalTokens ?? 0 },
            };
          },
        });
        const shimUsage: TokenUsage = {
          ...totalUsage,
          totalTokens: (totalUsage.totalTokens ?? 0) + loopResult.totalTokens,
        };
        metricUsage = shimUsage;
        fireLlmUsageObserver({
          provider: resolved.providerId,
          model: resolved.modelId,
          usage: shimUsage,
          source: opts.source,
          finishReason: loopResult.finishReason,
          surface: 'generateText',
        });
        return {
          provider: resolved.providerId,
          model: resolved.modelId,
          text: loopResult.text,
          usage: shimUsage,
          toolCalls: loopResult.toolCalls.map((c) => ({
            name: c.name,
            args: c.args,
            ...(c.error ? { error: c.error } : {}),
          })) as ToolCallRecord[],
          finishReason: loopResult.finishReason,
          plan: resolvedPlan,
        };
      };
      const toolUnsupportedErr = (e: unknown): boolean =>
        e instanceof Error &&
        /support tool use|does not support (tools|function)|no endpoints found that support/i.test(e.message);
      if (tools.length > 0 && toolMode === 'prompt') {
        return await runShim();
      }

      try {
      for (let step = 0; step < maxSteps; step++) {
        // --- onBeforeGeneration hook ---
        let effectiveMessages = messages;
        if (opts.onBeforeGeneration) {
          try {
            const hookCtx: GenerationHookContext = {
              messages: [...messages] as any,
              system: opts.system,
              tools: Array.from(toolMap.values()),
              model: resolved.modelId,
              provider: resolved.providerId,
              step,
              prompt: opts.prompt,
            };
            const modified = await opts.onBeforeGeneration(hookCtx);
            if (modified) {
              effectiveMessages = modified.messages as any;
            }
          } catch (hookErr) {
            console.warn('[agentos] onBeforeGeneration hook error:', hookErr);
          }
        }

        const response = await withAgentOSSpan(
          'agentos.api.generate_text.step',
          async (stepSpan) => {
            stepSpan?.setAttribute('llm.provider', resolved.providerId);
            stepSpan?.setAttribute('llm.model', resolved.modelId);
            stepSpan?.setAttribute('agentos.api.step', step + 1);
            stepSpan?.setAttribute('agentos.api.tool_count', tools.length);

            const stepResponse = await provider.generateCompletion(
              resolved.modelId,
              effectiveMessages as any,
              {
                tools: toolSchemas,
                temperature: opts.temperature,
                maxTokens: opts.maxTokens,
                // Forward the extended-thinking switch so thinking-capable
                // models (Opus 4.7/4.8) emit reasoning blocks; the provider's
                // resolveThinkingPayload decides applicability and emits the
                // adaptive form. Omitted callers keep the default (thinking off).
                ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
                // Forward reasoning effort (output_config.effort) the same way;
                // the provider drops it on unsupported models/values.
                ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
                // Forward caller toolChoice so orchestrators can force tool_use
                // (e.g. ai-codegen); models narrate under tool_choice: 'auto'.
                ...(opts.toolChoice !== undefined ? { toolChoice: opts.toolChoice } : {}),
                // Forward per-call requestTimeout so large-output callers
                // (e.g. codegen structured output) get a longer abort window
                // than the provider default; omitted callers keep the default.
                ...(opts.requestTimeout !== undefined ? { requestTimeout: opts.requestTimeout } : {}),
                ...(opts._responseFormat ? { responseFormat: opts._responseFormat }: {}),
              } as any
            );
            attachUsageAttributes(stepSpan, {
              promptTokens: stepResponse.usage?.promptTokens,
              completionTokens: stepResponse.usage?.completionTokens,
              totalTokens: stepResponse.usage?.totalTokens,
              costUSD: stepResponse.usage?.costUSD,
            });
            return stepResponse;
          }
        );

        if (response.usage) {
          totalUsage.promptTokens += response.usage.promptTokens ?? 0;
          totalUsage.completionTokens += response.usage.completionTokens ?? 0;
          totalUsage.totalTokens += response.usage.totalTokens ?? 0;
          if (typeof response.usage.costUSD === 'number') {
            totalUsage.costUSD = (totalUsage.costUSD ?? 0) + response.usage.costUSD;
          }
          // Plumb prompt-cache metrics through so generateText() callers
          // can measure cache hit rate. Provider-layer ModelUsage carries
          // these fields; TokenUsage was dropping them.
          const cacheRead = (response.usage as { cacheReadInputTokens?: number }).cacheReadInputTokens;
          const cacheCreate = (response.usage as { cacheCreationInputTokens?: number }).cacheCreationInputTokens;
          if (typeof cacheRead === 'number' && cacheRead > 0) {
            totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + cacheRead;
          }
          if (typeof cacheCreate === 'number' && cacheCreate > 0) {
            totalUsage.cacheCreationTokens = (totalUsage.cacheCreationTokens ?? 0) + cacheCreate;
          }
        }

        const choice = response.choices?.[0];
        if (!choice) break;

        const content = choice.message?.content;
        let textContent = typeof content === 'string' ? content: ((content as any)?.text ?? '');
        let toolCallsInChoice = resolveDynamicToolCalls(choice.message?.tool_calls, {
          text: textContent,
          step,
          toolsAvailable: tools.length > 0,
        });

        // --- onAfterGeneration hook ---
        if (opts.onAfterGeneration) {
          try {
            const stepUsage: TokenUsage = {
              promptTokens: response.usage?.promptTokens ?? 0,
              completionTokens: response.usage?.completionTokens ?? 0,
              totalTokens: response.usage?.totalTokens ?? 0,
              costUSD: response.usage?.costUSD,
              cacheReadTokens: (response.usage as { cacheReadInputTokens?: number } | undefined)?.cacheReadInputTokens,
              cacheCreationTokens: (response.usage as { cacheCreationInputTokens?: number } | undefined)?.cacheCreationInputTokens,
            };
            const toolCallRecords: ToolCallRecord[] = toolCallsInChoice.map((tc: any) => ({
              name: (tc as any).function?.name ?? (tc as any).name ?? '',
              args: (tc as any).function?.arguments ?? '{}',
            }));
            const hookResult: GenerationHookResult = {
              text: textContent,
              toolCalls: toolCallRecords,
              usage: stepUsage,
              step,
            };
            const modified = await opts.onAfterGeneration(hookResult);
            if (modified) {
              textContent = modified.text;
              if (modified.toolCalls.length === 0 && toolCallsInChoice.length > 0) {
                toolCallsInChoice = [];
              }
            }
          } catch (hookErr) {
            console.warn('[agentos] onAfterGeneration hook error:', hookErr);
          }
        }

        if (textContent && toolCallsInChoice.length === 0) {
          metricUsage = totalUsage;
          span?.setAttribute('agentos.api.finish_reason', choice.finishReason ?? 'stop');
          span?.setAttribute('agentos.api.tool_calls', allToolCalls.length);
          attachUsageAttributes(span, totalUsage);
          // 2026-05-29 — fire the global LLM usage observer so hosts
          // (wilds-ai foundation_usage_events, billing dashboards) get
          // the resolved provider + model + cost without wrapping every
          // callsite. No-op when no observer is registered.
          fireLlmUsageObserver({
            provider: resolved.providerId,
            model: resolved.modelId,
            usage: totalUsage,
            source: opts.source,
            finishReason: choice.finishReason ?? 'stop',
            surface: 'generateText',
          });
          return {
            provider: resolved.providerId,
            model: resolved.modelId,
            text: textContent,
            usage: totalUsage,
            toolCalls: allToolCalls,
            finishReason: (choice.finishReason ?? 'stop') as GenerateTextResult['finishReason'],
            plan: resolvedPlan,
          };
        }

        if (toolCallsInChoice.length > 0) {
          // Preserve the captured thinking blocks on the replayed assistant
          // turn. With extended thinking enabled, Anthropic requires the
          // most-recent assistant tool_use turn to carry its thinking blocks
          // verbatim (signature intact) on the next request; dropping them
          // 400s the continuation step. AnthropicProvider strips thinking from
          // all earlier assistant turns at payload-build time, so carrying it
          // here on every tool step is safe. Inert when thinking is off
          // (no blocks present), keeping the non-thinking path byte-identical.
          const stepThinkingBlocks = choice.message?.thinkingBlocks;
          messages.push({
            role: 'assistant',
            content: textContent || null,
            tool_calls: toolCallsInChoice,
            ...(stepThinkingBlocks && stepThinkingBlocks.length > 0
              ? { thinkingBlocks: stepThinkingBlocks }
              : {}),
          } as any);

          for (const tc of toolCallsInChoice) {
            const fnName = (tc as any).function?.name ?? (tc as any).name ?? '';
            const fnArgs = (tc as any).function?.arguments ?? '{}';
            const tcId = (tc as any).id ?? '';
            const tool = toolMap.get(fnName);
            const record: ToolCallRecord = {
              name: fnName,
              args: fnArgs,
            };

            let parsedArgs: unknown;
            try {
              parsedArgs =
                typeof fnArgs === 'string' ? JSON.parse(fnArgs): fnArgs;
              record.args = parsedArgs;
            } catch {
              record.error = `Tool "${fnName}" arguments were not valid JSON.`;
              messages.push({
                role: 'tool',
                tool_call_id: tcId,
                content: JSON.stringify({ error: record.error }),
              } as any);
              allToolCalls.push(record);
              continue;
            }

            // --- onBeforeToolExecution hook ---
            if (opts.onBeforeToolExecution) {
              try {
                const hookInfo: ToolCallHookInfo = {
                  name: fnName,
                  args: parsedArgs as Record<string, unknown>,
                  id: tcId || '',
                  step,
                };
                const hookResult = await opts.onBeforeToolExecution(hookInfo);
                if (hookResult === null) {
                  record.error = 'Skipped by onBeforeToolExecution hook';
                  messages.push({
                    role: 'tool',
                    tool_call_id: tcId,
                    content: JSON.stringify({ skipped: true }),
                  } as any);
                  allToolCalls.push(record);
                  continue;
                }
                parsedArgs = hookResult.args;
              } catch (hookErr) {
                console.warn('[agentos] onBeforeToolExecution hook error:', hookErr);
              }
            }

            if (tool) {
              try {
                const result = await tool.execute(
                  parsedArgs as any,
                  buildHelperToolExecutionContext(
                    'generateText',
                    helperToolRunId,
                    step,
                    tcId || undefined,
                  ),
                );
                record.result = result.output;
                record.error = result.success ? undefined: result.error;
                messages.push({
                  role: 'tool',
                  tool_call_id: tcId,
                  content: JSON.stringify(result.output ?? result.error ?? ''),
                } as any);
              } catch (err: any) {
                record.error = err?.message;
                messages.push({
                  role: 'tool',
                  tool_call_id: tcId,
                  content: JSON.stringify({ error: err?.message }),
                } as any);
              }
            } else {
              record.error = `Tool "${fnName}" not found.`;
              messages.push({
                role: 'tool',
                tool_call_id: tcId,
                content: JSON.stringify({ error: record.error }),
              } as any);
            }
            allToolCalls.push(record);
          }
          continue;
        }

        metricUsage = totalUsage;
        span?.setAttribute('agentos.api.finish_reason', choice.finishReason ?? 'stop');
        span?.setAttribute('agentos.api.tool_calls', allToolCalls.length);
        attachUsageAttributes(span, totalUsage);
        fireLlmUsageObserver({
          provider: resolved.providerId,
          model: resolved.modelId,
          usage: totalUsage,
          source: opts.source,
          finishReason: choice.finishReason ?? 'stop',
          surface: 'generateText',
        });
        return {
          provider: resolved.providerId,
          model: resolved.modelId,
          text: textContent,
          usage: totalUsage,
          toolCalls: allToolCalls,
          finishReason: (choice.finishReason ?? 'stop') as GenerateTextResult['finishReason'],
          plan: resolvedPlan,
        };
      }
      } catch (loopErr) {
        // 'auto' reactive fallback: when the provider rejects native tool-use,
        // re-run the turn through the prompt-based shim.
        if (tools.length > 0 && toolMode === 'auto' && toolUnsupportedErr(loopErr)) {
          return await runShim();
        }
        throw loopErr;
      }

      const lastAssistant = messages.filter((m) => m.role === 'assistant').pop();
      metricUsage = totalUsage;
      span?.setAttribute('agentos.api.finish_reason', 'tool-calls');
      span?.setAttribute('agentos.api.tool_calls', allToolCalls.length);
      attachUsageAttributes(span, totalUsage);
      fireLlmUsageObserver({
        provider: resolved.providerId,
        model: resolved.modelId,
        usage: totalUsage,
        source: opts.source,
        finishReason: 'tool-calls',
        surface: 'generateText',
      });
      return {
        provider: resolved.providerId,
        model: resolved.modelId,
        text: (lastAssistant?.content as string) ?? '',
        usage: totalUsage,
        toolCalls: allToolCalls,
        finishReason: 'tool-calls',
        plan: resolvedPlan,
      };
    });
    // The primary attempt succeeded: let the registry know so its
    // failure streak resets. Safe to call on a never-failed provider;
    // the registry no-ops in that case.
    if (metricProviderId) {
      globalLLMProviderHealth.recordSuccess(metricProviderId);
    }
    return successResult;
  } catch (error) {
    // Record the primary attempt as a failure on the health registry
    // BEFORE walking the fallback chain. Subsequent calls in this
    // process will now see this provider as open (per the registry's
    // status-aware policy) and skip the network round-trip entirely.
    // Note: we record against `metricProviderId` not the inbound
    // `opts.provider` because the model router may have resolved a
    // different provider than the caller asked for.
    if (metricProviderId && !(error instanceof LLMProviderCircuitOpenError)) {
      globalLLMProviderHealth.recordFailure(metricProviderId, error);
    }
    // ── Fallback chain ────────────────────────────────────────────────
    // Resolve fallback chain: caller-supplied wins, undefined triggers
    // auto-build from env keys, empty array explicitly opts out.
    // When `policyTier` is mature/private-adult, the auto-build picks
    // the policy-aware chain (Hermes 3 + Sonnet uncensored prefix +
    // standard availability suffix) instead of the availability-only
    // chain. Caller-supplied chains are respected verbatim regardless
    // of tier: explicit beats implicit.
    const effectiveFallbacks = opts.fallbackProviders === undefined
      ? buildPolicyAwareFallbackChain(opts.policyTier, metricProviderId)
     : opts.fallbackProviders;

    if (
      effectiveFallbacks.length &&
      isRetryableError(error)
    ) {
      let lastError = error;
      let attempt = 0;
      for (const fb of effectiveFallbacks) {
        attempt += 1;
        // Skip fallback entries whose breaker is already open. Without
        // this check, the loop would still spend a full network round-
        // trip on every dead fallback in the chain before reaching the
        // next healthy one. The recursive `generateText` call below would
        // also short-circuit at the same isOpen() check, but the outer
        // skip avoids the recursion overhead + the extra log line.
        if (globalLLMProviderHealth.isOpen(fb.provider)) {
          fallbackLogger.info('provider fallback skipped (circuit open)', {
            event: 'fallback_skipped_circuit_open',
            api: 'generateText',
            primaryProvider: metricProviderId,
            fallbackProvider: fb.provider,
            fallbackModel: fb.model,
            attempt,
          });
          continue;
        }
        try {
          const lastErr = lastError instanceof Error ? lastError: new Error(String(lastError));
          fallbackLogger.info('provider fallback triggered', {
            event: 'fallback_fired',
            api: 'generateText',
            primaryProvider: metricProviderId,
            fallbackProvider: fb.provider,
            fallbackModel: fb.model,
            errorType: lastErr.name,
            errorMessage: lastErr.message.slice(0, 200),
            attempt,
          });
          opts.onFallback?.(lastErr, fb.provider);
          // Build a new options object targeting the fallback provider,
          // stripping the fallbackProviders to prevent recursive fallback.
          const fallbackResult = await generateText({
            ...opts,
            provider: fb.provider,
            model: fb.model,
            // Clear explicit keys/URLs so resolution uses env vars for the
            // fallback provider rather than the primary's overrides.
            apiKey: undefined,
            baseUrl: undefined,
            fallbackProviders: undefined,
            onFallback: undefined,
          });
          fallbackLogger.info('provider fallback succeeded', {
            event: 'fallback_succeeded',
            api: 'generateText',
            primaryProvider: metricProviderId,
            fallbackProvider: fallbackResult.provider,
            fallbackModel: fallbackResult.model,
            attempt,
          });
          metricStatus = 'ok';
          metricUsage = fallbackResult.usage;
          metricProviderId = fallbackResult.provider;
          metricModelId = fallbackResult.model;
          return fallbackResult;
        } catch (fbError) {
          lastError = fbError;
        }
      }
      // All fallbacks exhausted: fall through to throw
      const lastErr = lastError instanceof Error ? lastError: new Error(String(lastError));
      fallbackLogger.warn('all provider fallbacks exhausted', {
        event: 'fallback_exhausted',
        api: 'generateText',
        primaryProvider: metricProviderId,
        attempts: attempt,
        errorType: lastErr.name,
        errorMessage: lastErr.message.slice(0, 200),
      });
      metricStatus = 'error';
      throw lastError;
    }

    metricStatus = 'error';
    throw error;
  } finally {
    try {
      await recordAgentOSUsageLazy({
        providerId: metricProviderId,
        modelId: metricModelId,
        usage: metricUsage,
        options: {
          ...opts.usageLedger,
          source: opts.usageLedger?.source ?? 'generateText',
        },
      });
    } catch {
      // Helper-level usage persistence is best-effort and should not break generation.
    }
    recordAgentOSTurnMetrics({
      durationMs: Date.now() - startedAt,
      status: metricStatus,
      usage: toTurnMetricUsage(metricUsage),
    });
  }
}
