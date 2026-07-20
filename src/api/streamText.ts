/**
 * @file streamText.ts
 * Stateless streaming text generation for the AgentOS high-level API.
 *
 * Accepts the same {@link GenerateTextOptions} as {@link generateText} but returns
 * immediately with async iterables so callers can process tokens incrementally.
 * Multi-step tool calling is supported: tool-call and tool-result parts are
 * yielded inline before the next LLM step begins.
 */
import { randomUUID } from 'node:crypto';
import { resolveModelOption, resolveProvider, createProviderManager } from './model.js';
import { attachGenAiAttributes, attachUsageAttributes, toTurnMetricUsage } from './observability.js';
import { fireLlmUsageObserver } from './observers.js';
import { hostPolicyToRouteParams, mergeRequiredCapabilities } from './runtime/hostPolicy.js';
import { adaptTools } from './runtime/toolAdapter.js';
import { runEmulatedToolLoop, type ToolMode } from './runtime/tool-emulation/index.js';
import {
  buildPolicyAwareFallbackChain,
  createPlan,
  isRetryableError,
  resolveChainOfThought,
  type GenerateTextOptions,
  type GenerationHookContext,
  type GenerationHookResult,
  type Plan,
  type TokenUsage,
  type ToolCallHookInfo,
  type ToolCallRecord,
} from './generateText.js';
import type { CacheDiagnostics } from '../core/llm/providers/IProvider.js';
import type { ModelRouteParams } from '../core/llm/routing/IModelRouter.js';
import { resolveDynamicToolCalls } from './runtime/dynamicToolCalling.js';
import type { ITool, ToolExecutionContext } from '../core/tools/ITool.js';
import { StreamingReconstructor } from '../core/llm/streaming/StreamingReconstructor.js';
import { globalLLMProviderHealth } from '../core/safety/LLMProviderHealthRegistry.js';
import { recordAgentOSTurnMetrics, startAgentOSSpan } from '../safety/evaluation/observability/otel.js';
import { createLogger } from '../core/logging/loggerFactory.js';

const fallbackLogger = createLogger('fallback');

async function recordAgentOSUsageLazy(
  input: Parameters<typeof import('./runtime/usageLedger.js')['recordAgentOSUsage']>[0]
): Promise<boolean> {
  const { recordAgentOSUsage } = await import('./runtime/usageLedger.js');
  return recordAgentOSUsage(input);
}

/**
 * A discriminated union representing a single event emitted by the
 * `StreamTextResult.fullStream` iterable.
 *
 * - `"text"`: incremental token delta from the model.
 * - `"tool-call"`: the model requested a tool invocation.
 * - `"tool-result"`: the tool has been executed and the result is available.
 * - `"error"`: an unrecoverable error occurred; the stream ends after this part.
 */
export type StreamPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolName: string; args: unknown }
  | { type: 'tool-result'; toolName: string; result: unknown }
  | { type: 'error'; error: Error };

/**
 * Canonical finish-reason union for the streaming surface. Mirrors
 * {@link GenerateTextResult.finishReason} so hosts can branch on one
 * vocabulary regardless of which API produced the text.
 */
export type StreamFinishReason = 'stop' | 'length' | 'tool-calls' | 'error';

/**
 * Normalize a provider-reported finish reason onto the canonical
 * {@link StreamFinishReason} union.
 *
 * Providers disagree on vocabulary: OpenAI-compatible hosts emit
 * `length` / `tool_calls` / `stop`; Anthropic's adapter maps its raw
 * `stop_reason` before it reaches this layer but raw `max_tokens` /
 * `tool_use` / `end_turn` are accepted here too so a provider that
 * skips that mapping still normalizes. Unknown strings and null/undefined
 * degrade to `'stop'` — the pre-existing semantics of the streaming
 * surface, which fabricated `'stop'` unconditionally.
 */
export function normalizeStreamFinishReason(
  raw: string | null | undefined,
): StreamFinishReason {
  if (raw == null) return 'stop';
  switch (raw.toLowerCase()) {
    case 'length':
    case 'max_tokens':
    case 'model_length':
      return 'length';
    case 'tool-calls':
    case 'tool_calls':
    case 'tool_use':
    case 'function_call':
      return 'tool-calls';
    case 'error':
      return 'error';
    default:
      return 'stop';
  }
}

/**
 * The object returned immediately by {@link streamText}.
 *
 * Consumers may iterate `textStream` for raw token deltas, `fullStream` for
 * all event types, or simply `await` the promise properties for aggregated
 * results once the stream has drained.
 */
export interface StreamTextResult {
  /** Async iterable that yields only raw text-delta strings (filters out non-text parts). */
  textStream: AsyncIterable<string>;
  /** Async iterable that yields all {@link StreamPart} events in order. */
  fullStream: AsyncIterable<StreamPart>;
  /** Resolves to the fully assembled assistant reply when the stream completes. */
  text: Promise<string>;
  /** Resolves to aggregated {@link TokenUsage} when the stream completes. */
  usage: Promise<TokenUsage>;
  /**
   * Provider-reported model id of the final step (may differ from the
   * requested/resolved id across aliases and fallback hops; spec batch-1
   * C1). Settles on every terminal path — normal completion, fallback,
   * error, early abandonment — and is `undefined` when no chunk reported a
   * model id. The existing `model`-related fields keep their meaning.
   */
  responseModel: Promise<string | undefined>;
  /** Resolves to the ordered list of {@link ToolCallRecord}s when the stream completes. */
  toolCalls: Promise<ToolCallRecord[]>;
  /**
   * Resolves to the resolved provider id (e.g. `openrouter`, `anthropic`)
   * once the stream has started. Available eagerly because routing happens
   * before the first chunk; exposed as a Promise so the type lines up with
   * the rest of this contract and so callers don't see undefined while the
   * stream is still spinning up. Used by wilds-ai's `[llm-call]` telemetry
   * line for per-step latency attribution (production fix 2026-05-05:
   * narrator-stream rows were logging `provider=unknown model=unknown`,
   * which made model-routing audits significantly harder).
   */
  provider: Promise<string>;
  /** Resolves to the resolved model id once the stream has started. */
  model: Promise<string>;
  /**
   * Resolves to the reason the FINAL model step stopped emitting, on the
   * same cadence as {@link usage} (when the stream completes):
   *
   * - `'stop'` — natural end of turn (or an unknown provider vocabulary).
   * - `'length'` — the provider's output token cap cut the text off; the
   *   assembled reply is TRUNCATED mid-thought. Hosts that persist or
   *   cache streamed prose as canonical should branch on this before
   *   doing so (wilds-ai narrator truncation guard, 2026-07-08).
   * - `'tool-calls'` — the run ended with outstanding tool calls and no
   *   final text (maxSteps exhaustion).
   * - `'error'` — the stream emitted an `error` part.
   *
   * Historically the streaming surface discarded the provider's reason
   * and fabricated `'stop'`; the provider layer always had it (final
   * chunk `choices[0].finishReason`; Anthropic maps `max_tokens` →
   * `length` in its adapter). Settled via the generator's cleanup on
   * early abandonment too, so awaiting it after a partial consume does
   * not hang — though like `text`/`usage` it is only meaningful after a
   * full drain. The prompt-shim tool-emulation path reports `'stop'`
   * (its internal calls do not thread per-step reasons).
   */
  finishReason: Promise<StreamFinishReason>;
  /**
   * Cache-diagnostics verdict of the FINAL step (Anthropic beta; see
   * {@link GenerateTextOptions.cacheDiagnostics}). Resolves when the stream
   * completes: `null` when the run did not opt in, when the provider sent no
   * verdict, or when the compared requests did not diverge; a populated
   * `cacheMissReason` names the earliest divergence. Settled in the
   * generator's cleanup too, so awaiting after early abandonment never hangs.
   */
  cacheDiagnostics: Promise<CacheDiagnostics | null>;
  /**
   * Provider message id (`msg_...`) of the FINAL step; `null` when the run
   * did not opt into cache diagnostics or the provider sent no id. Persist it
   * and pass it back as the next request's
   * `cacheDiagnostics.previousMessageId` to thread the comparison across
   * turns (the wilds-ai narrator threads it per session).
   */
  providerMessageId: Promise<string | null>;
}

function buildHelperToolExecutionContext(
  source: 'streamText',
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

function formatPlanForPrompt(plan: Plan): string {
  const lines = plan.steps.map(
    (s, i) =>
      `${i + 1}. ${s.description}${s.tool ? ` [tool: ${s.tool}]`: ''}`,
  );
  return `Follow this plan:\n${lines.join('\n')}`;
}

/**
 * Stateless streaming text generation with optional multi-step tool calling.
 *
 * Returns a {@link StreamTextResult} immediately; the underlying provider call
 * begins lazily when a consumer starts iterating `textStream` or `fullStream`.
 * Awaiting `text`, `usage`, or `toolCalls` will also drain the stream.
 *
 * @param opts - Generation options (same shape as {@link generateText}).
 * @returns A {@link StreamTextResult} with async iterables and awaitable promises.
 *
 * @example
 * ```ts
 * const { textStream } = streamText({ provider: 'openai', model: 'gpt-4o', prompt: 'Tell me a joke.' });
 * for await (const chunk of textStream) {
 *   process.stdout.write(chunk);
 * }
 * ```
 */
export function streamText(opts: GenerateTextOptions): StreamTextResult {
  let resolveText: (v: string) => void;
  let resolveUsage: (v: TokenUsage) => void;
  let resolveResponseModel: (v: string | undefined) => void;
  let lastResponseModelId: string | undefined;
  let resolveToolCalls: (v: ToolCallRecord[]) => void;
  let resolveProviderId: (v: string) => void;
  let resolveModelId: (v: string) => void;
  let resolveFinishReason: (v: StreamFinishReason) => void;

  const textPromise = new Promise<string>((r) => {
    resolveText = r;
  });
  const usagePromise = new Promise<TokenUsage>((r) => {
    resolveUsage = r;
  });
  const toolCallsPromise = new Promise<ToolCallRecord[]>((r) => {
    resolveToolCalls = r;
  });
  // Provider-reported model id of the final step (spec batch-1 C1).
  // Settled at every resolveUsage site so it can never stay pending —
  // normal completion, fallback resolution, error, and abandonment alike.
  const responseModelPromise = new Promise<string | undefined>((r) => {
    resolveResponseModel = r;
  });
  // Provider + model resolution lives inside the lazy async generator,
  // so we expose them as Deferred Promises that the generator resolves
  // once routing completes (well before the first text chunk lands).
  // Allows wilds-ai's [llm-call] telemetry to log accurate per-call
  // attribution for streaming paths instead of `unknown/unknown`.
  const providerPromise = new Promise<string>((r) => {
    resolveProviderId = r;
  });
  const modelPromise = new Promise<string>((r) => {
    resolveModelId = r;
  });
  // Finish reason of the FINAL step. Resolved at every terminal return
  // path plus the generator's finally (belt-and-suspenders for early
  // abandonment); Promise semantics make later settles no-ops, so the
  // most specific settle wins.
  const finishReasonPromise = new Promise<StreamFinishReason>((r) => {
    resolveFinishReason = r;
  });
  // Cache-diagnostics verdict + provider message id of the FINAL step.
  // Settled in the generator's finally (every terminal path, including
  // early abandonment) so awaiters never hang; null when not opted in.
  // PromiseLike included: the fallback path adopts the child run's promises
  // by resolving with them (resolve() unwraps thenables; first settle wins).
  let resolveCacheDiagnostics: (
    v: CacheDiagnostics | null | PromiseLike<CacheDiagnostics | null>,
  ) => void;
  let resolveProviderMessageId: (v: string | null | PromiseLike<string | null>) => void;
  const cacheDiagnosticsPromise = new Promise<CacheDiagnostics | null>((r) => {
    resolveCacheDiagnostics = r;
  });
  const providerMessageIdPromise = new Promise<string | null>((r) => {
    resolveProviderMessageId = r;
  });

  const parts: StreamPart[] = [];
  const allToolCalls: ToolCallRecord[] = [];
  // Wall-clock of the FIRST StreamPart handed to the consumer (text or
  // tool-call alike), stamped by the timing wrapper around `runStream`
  // below. Read by the usage-observer fire in runStream's finally to
  // report `ttfbMs`; stays undefined when the stream errors before
  // producing any part.
  let firstPartAt: number | undefined;

  async function* runStream(): AsyncGenerator<StreamPart> {
    const startedAt = Date.now();
    const rootSpan = startAgentOSSpan('agentos.api.stream_text');
    const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let finalText = '';
    let metricStatus: 'ok' | 'error' = 'ok';
    let recordedProviderId: string | undefined;
    let recordedModelId: string | undefined;
    // Raw provider finish reason of the most recent step's final chunk.
    // The LAST step's reason is the one that describes the assembled
    // reply (earlier steps end on tool calls by construction).
    let lastStepFinishReason: string | null = null;
    // Cache-diagnostics threading (opts.cacheDiagnostics): mirrors
    // generateText. The object form seeds the FIRST step with the caller's
    // prior-request message id (cross-request threading); `true` seeds null.
    // Each step then chains its own response id into the next step.
    // True only after a step's FINAL chunk was observed. The finally must
    // never echo the caller's SEED as this run's id (prompt-shim, fallback
    // and error paths reach the finally without a native final chunk).
    let sawFinalProviderChunk = false;
    let lastProviderMessageId: string | null =
      typeof opts.cacheDiagnostics === 'object' && opts.cacheDiagnostics !== null
        ? (opts.cacheDiagnostics.previousMessageId ?? null)
        : null;
    let lastCacheDiagnostics: CacheDiagnostics | null = null;

    try {
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
      recordedProviderId = resolved.providerId;
      recordedModelId = resolved.modelId;
      // Resolve the eagerly-exposed routing Promises so callers
      // logging telemetry don't have to wait for the stream to drain.
      resolveProviderId!(resolved.providerId);
      resolveModelId!(resolved.modelId);

      // Provider-health circuit-breaker check. See
      // {@link LLMProviderHealthRegistry} for the policy. Mirrors the
      // generateText path so a 402 on the OpenRouter REST endpoint
      // short-circuits streaming consumers in the same process too.
      if (globalLLMProviderHealth.isOpen(resolved.providerId)) {
        const stats = globalLLMProviderHealth.getStats(resolved.providerId);
        const err: Error & { httpStatus?: number } = new Error(
          `[503] Provider '${resolved.providerId}' circuit open; cooldown ${stats?.cooldownRemainingMs ?? 0}ms`,
        );
        err.name = 'LLMProviderCircuitOpenError';
        err.httpStatus = 503;
        throw err;
      }

      const manager = await createProviderManager(resolved);
      const provider = manager.getProvider(resolved.providerId);
      if (!provider) throw new Error(`Provider ${resolved.providerId} not available.`);

      rootSpan?.setAttribute('llm.provider', resolved.providerId);
      rootSpan?.setAttribute('llm.model', resolved.modelId);

      const tools = adaptTools(opts.tools);
      const toolMap = new Map<string, ITool>();
      for (const tool of tools) toolMap.set(tool.name, tool);
      const helperToolRunId = randomUUID();

      const messages: Array<Record<string, unknown>> = [];

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
        const blocks = opts.system as import('./generateText.js').SystemContentBlock[];
        const parts = blocks.map(block => ({
          type: 'text' as const,
          text: block.text,
          ...(block.cacheBreakpoint
            ? { cache_control: { type: 'ephemeral' as const, ...(block.cacheTtl === '1h' ? { ttl: '1h' as const } : {}) } }
            : {}),
        }));

        if (cotInstruction && hasTools) {
          parts.unshift({ type: 'text' as const, text: cotInstruction });
        }

        messages.push({ role: 'system', content: parts });
      }

      if (opts.messages)
        for (const m of opts.messages) messages.push({ role: m.role, content: m.content });
      if (opts.prompt) messages.push({ role: 'user', content: opts.prompt });

      rootSpan?.setAttribute('agentos.api.tool_count', tools.length);

      const toolSchemas =
        tools.length > 0
          ? tools.map((tool) => ({
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            }))
         : undefined;

      const maxSteps = opts.maxSteps ?? 1;
      rootSpan?.setAttribute('agentos.api.max_steps', maxSteps);
      const planningEnabled = !!opts.planning;
      rootSpan?.setAttribute('agentos.api.planning_enabled', planningEnabled);

      if (planningEnabled) {
        const planConfig = typeof opts.planning === 'object' ? opts.planning: undefined;
        const userMessages = messages.filter((m) => m.role === 'user');
        const toolNames = tools.map((tool) => tool.name);
        const resolvedPlan = await createPlan(
          provider,
          resolved.modelId,
          userMessages,
          toolNames,
          // Inherit the root per-call cache control (planning-specific
          // override wins) — a cache:false stream's planning sub-call must
          // not auto-cache behind the caller's back.
          planConfig?.cache !== undefined || opts.cache !== undefined
            ? { ...planConfig, cache: planConfig?.cache ?? opts.cache }
            : planConfig,
          usage,
        );

        if (resolvedPlan) {
          const planPrompt = formatPlanForPrompt(resolvedPlan);
          const firstNonSystem = messages.findIndex((m) => m.role !== 'system');
          const insertIdx = firstNonSystem === -1 ? messages.length: firstNonSystem;
          messages.splice(insertIdx, 0, { role: 'system', content: planPrompt });
          rootSpan?.setAttribute('agentos.api.plan_steps', resolvedPlan.steps.length);
        }
      }

      // --- Prompt-based tool-calling shim (toolMode) ---
      // For models without native tool-use, buffer the tool roundtrips and emit
      // the final answer as a single text part through the stream contract (spec
      // decision #1 — replay from buffer, no extra model call). 'prompt' forces
      // it up front; 'auto' tries native streaming first and falls back here on
      // the provider's tool-unsupported error (see the catch around the loop).
      const toolMode: ToolMode = opts.toolMode ?? 'auto';
      const toolUnsupportedErr = (e: unknown): boolean =>
        e instanceof Error &&
        /support tool use|does not support (tools|function)|no endpoints found that support/i.test(e.message);
      async function* runShimStream(): AsyncGenerator<StreamPart> {
        const loopResult = await runEmulatedToolLoop({
          tools: Array.from(toolMap.values()),
          messages: messages.map((m) => ({
            role: String(m.role),
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
          })),
          maxRoundtrips: opts.maxSteps ?? 5,
          callModel: async (msgs) => {
            // provider is guaranteed non-undefined by the `if (!provider) throw`
            // guard above; the closure just loses TS's flow-narrowing.
            const r = await provider!.generateCompletion(resolved.modelId, msgs as any, {
              temperature: opts.temperature,
              maxTokens: opts.maxTokens,
              ...(opts.topP !== undefined ? { topP: opts.topP } : {}),
              ...(opts.frequencyPenalty !== undefined ? { frequencyPenalty: opts.frequencyPenalty } : {}),
              ...(opts.presencePenalty !== undefined ? { presencePenalty: opts.presencePenalty } : {}),
              // Forward the extended-thinking budget + reasoning effort on the
              // shim path too, matching the native stream path above and
              // generateText's own shim path. Without this, a thinking-capable
              // streaming caller that falls into prompt-tool emulation (or the
              // auto tool-unsupported fallback) silently loses its reasoning
              // depth. Omitted = thinking off; the provider drops effort on
              // unsupported models/values.
              ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
              ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
              // Per-call cache control rides the shim path too (opt-out /
              // 1h TTL on the auto markers), matching the native stream path.
              ...(opts.cache !== undefined ? { cache: opts.cache } : {}),
              // Per-conversation affinity key (OpenRouter session_id sticky
              // routing; other providers ignore it).
              ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
            ...(opts.promptCacheKey !== undefined ? { promptCacheKey: opts.promptCacheKey } : {}),
            ...(opts.promptCacheRetention !== undefined ? { promptCacheRetention: opts.promptCacheRetention } : {}),
            ...(opts.serviceTier !== undefined ? { serviceTier: opts.serviceTier } : {}),
              // Forward provider-specific top-level payload params (e.g.
              // OpenRouter provider-routing preferences) on the shim path too.
              ...(opts.customModelParams !== undefined
                ? { customModelParams: opts.customModelParams }
                : {}),
            } as any);
            const cc = r.choices?.[0]?.message?.content;
            return {
              text: typeof cc === 'string' ? cc : ((cc as any)?.text ?? ''),
              usage: { totalTokens: r.usage?.totalTokens ?? 0 },
            };
          },
        });
        usage.totalTokens = (usage.totalTokens ?? 0) + loopResult.totalTokens;
        finalText = loopResult.text;
        const shimToolCalls: ToolCallRecord[] = loopResult.toolCalls.map((c) => ({
          name: c.name,
          args: c.args,
          ...(c.error ? { error: c.error } : {}),
        }));
        if (loopResult.text) {
          const part: StreamPart = { type: 'text', text: loopResult.text };
          parts.push(part);
          yield part;
        }
        resolveText!(finalText);
        resolveUsage!(usage); resolveResponseModel!(lastResponseModelId);
        resolveToolCalls!(shimToolCalls);
      }
      if (tools.length > 0 && toolMode === 'prompt') {
        yield* runShimStream();
        return;
      }

      let streamedAnyText = false;
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

        const stepSpan = startAgentOSSpan('agentos.api.stream_text.step', {
          attributes: {
            'llm.provider': resolved.providerId,
            'llm.model': resolved.modelId,
            'agentos.api.step': step + 1,
            'agentos.api.tool_count': tools.length,
          },
        });
        const stream = provider.generateCompletionStream(
          resolved.modelId,
          effectiveMessages as any,
          {
            tools: toolSchemas,
            temperature: opts.temperature,
            maxTokens: opts.maxTokens,
            // Mirror generateText: forward the sampling controls so a
            // streaming caller's topP / frequency / presence penalties
            // actually reach the provider instead of being silently
            // dropped. Anthropic ignores the penalties at the provider
            // layer (no-op); OpenAI / OpenRouter honor them.
            ...(opts.topP !== undefined ? { topP: opts.topP } : {}),
            ...(opts.frequencyPenalty !== undefined ? { frequencyPenalty: opts.frequencyPenalty } : {}),
            ...(opts.presencePenalty !== undefined ? { presencePenalty: opts.presencePenalty } : {}),
            // Forward the extended-thinking switch and reasoning effort like
            // generateText does — without these, every streamed request
            // reaches the provider non-thinking, which silently pins it to
            // the non-thinking auto-cache branch and drops the caller's
            // intended reasoning depth. Omitted callers keep the defaults.
            ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
            ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
            // Per-call cache control: `false` = zero cache_control on the
            // wire; `{ ttl: '1h' }` = 1h TTL on the auto markers incl. the
            // moving message-tail (human-paced streamed turns routinely gap
            // past the 5m default TTL).
            ...(opts.cache !== undefined ? { cache: opts.cache } : {}),
            // Per-conversation affinity key (OpenRouter session_id sticky
            // routing; other providers ignore it).
            ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
            ...(opts.promptCacheKey !== undefined ? { promptCacheKey: opts.promptCacheKey } : {}),
            ...(opts.promptCacheRetention !== undefined ? { promptCacheRetention: opts.promptCacheRetention } : {}),
            ...(opts.serviceTier !== undefined ? { serviceTier: opts.serviceTier } : {}),
            // Cache-diagnostics opt-in (Anthropic beta): thread the previous
            // request's message id — the caller's seed on step 1, the prior
            // step's id after — so the verdict names any prefix divergence.
            ...(opts.cacheDiagnostics
              ? { cacheDiagnostics: { previousMessageId: lastProviderMessageId } }
              : {}),
            // Forward provider-specific top-level payload params (e.g.
            // OpenRouter provider-routing preferences); providers spread
            // them onto the streaming request body.
            ...(opts.customModelParams !== undefined
              ? { customModelParams: opts.customModelParams }
              : {}),
          } as any
        );

        const reconstructor = new StreamingReconstructor();

        try {
          for await (const chunk of stream) {
            reconstructor.push(chunk);

            const textDelta = chunk.responseTextDelta ?? '';
            if (textDelta) {
              const part: StreamPart = { type: 'text', text: textDelta };
              parts.push(part);
              yield part;
              streamedAnyText = true;
            }

            if (chunk.error) {
              const error = new Error(chunk.error.message);
              const part: StreamPart = { type: 'error', error };
              parts.push(part);
              yield part;
              metricStatus = 'error';
              resolveText!(finalText);
              resolveUsage!(usage); resolveResponseModel!(lastResponseModelId);
              resolveToolCalls!(allToolCalls);
              resolveFinishReason!('error');
              return;
            }

            if (chunk.isFinal && opts.cacheDiagnostics) {
              sawFinalProviderChunk = true;
              // Chain the id for the NEXT step's comparison; keep the
              // latest verdict for the result promise (the final step's
              // verdict describes the assembled reply).
              const finalId = (chunk as { id?: unknown }).id;
              lastProviderMessageId =
                typeof finalId === 'string' && finalId ? finalId : null;
              const verdict = (chunk as { cacheDiagnostics?: CacheDiagnostics | null })
                .cacheDiagnostics;
              lastCacheDiagnostics = verdict ?? null;
            }

            if (chunk.isFinal && chunk.usage) {
              usage.promptTokens += chunk.usage.promptTokens ?? 0;
              usage.completionTokens += chunk.usage.completionTokens ?? 0;
              usage.totalTokens += chunk.usage.totalTokens ?? 0;
              if (typeof chunk.usage.costUSD === 'number') {
                usage.costUSD = (usage.costUSD ?? 0) + chunk.usage.costUSD;
              }
              // Prompt-cache metrics from the provider layer. Provider
              // surfaces these as cacheReadInputTokens /
              // cacheCreationInputTokens on the final chunk's usage
              // (mirrors Anthropic's cache_read_input_tokens /
              // cache_creation_input_tokens); forward them onto the
              // aggregated TokenUsage so downstream cost trackers see
              // cache hits.
              const cacheRead = (chunk.usage as { cacheReadInputTokens?: number }).cacheReadInputTokens;
              const cacheCreate = (chunk.usage as { cacheCreationInputTokens?: number }).cacheCreationInputTokens;
              if (typeof cacheRead === 'number') {
                usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + cacheRead;
              }
              if (typeof cacheCreate === 'number') {
                usage.cacheCreationTokens = (usage.cacheCreationTokens ?? 0) + cacheCreate;
              }
              if (typeof chunk.modelId === 'string' && chunk.modelId) {
                lastResponseModelId = chunk.modelId;
              }
              const chunkInclusiveIn = (chunk.usage as { inclusiveInputTokens?: number }).inclusiveInputTokens;
              if (typeof chunkInclusiveIn === 'number') {
                usage.inclusiveInputTokens = (usage.inclusiveInputTokens ?? 0) + chunkInclusiveIn;
              }
              attachUsageAttributes(stepSpan, {
                promptTokens: chunk.usage.promptTokens,
                completionTokens: chunk.usage.completionTokens,
                totalTokens: chunk.usage.totalTokens,
                costUSD: chunk.usage.costUSD,
              });
            }
          }
        } finally {
          stepSpan?.end();
        }

        const stepText = reconstructor.getFullText();
        const finalChunk = reconstructor.getFinalChunk();
        // Capture the provider's reported reason for THIS step ending.
        // Anthropic's adapter has already mapped its raw stop_reason
        // (max_tokens → length); OpenAI-compatible providers report
        // length/tool_calls/stop verbatim on the final chunk's choice.
        {
          const rawStepFinish = finalChunk?.choices?.[0]?.finishReason;
          if (rawStepFinish != null) lastStepFinishReason = rawStepFinish;
        }
        let streamedToolCalls = resolveDynamicToolCalls(
          finalChunk?.choices?.[0]?.message?.tool_calls ??
          reconstructor
            .getToolCalls()
            .filter((toolCall) => toolCall.id && toolCall.name)
            .map((toolCall) => ({
              id: toolCall.id!,
              type: 'function' as const,
              function: {
                name: toolCall.name!,
                arguments: toolCall.rawArguments || JSON.stringify(toolCall.arguments ?? {}),
              },
            })),
          {
            text: stepText,
            step,
            toolsAvailable: tools.length > 0,
          },
        );

        // --- onAfterGeneration hook ---
        let effectiveStepText = stepText;
        if (opts.onAfterGeneration) {
          try {
            const stepUsage: TokenUsage = {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
              costUSD: usage.costUSD,
              cacheReadTokens: usage.cacheReadTokens,
              cacheCreationTokens: usage.cacheCreationTokens,
            };
            const toolCallRecords: ToolCallRecord[] = (streamedToolCalls ?? []).map((tc: any) => ({
              name: tc.function?.name ?? '',
              args: tc.function?.arguments ?? '{}',
            }));
            const hookResult: GenerationHookResult = {
              text: stepText,
              toolCalls: toolCallRecords,
              usage: stepUsage,
              step,
            };
            const modified = await opts.onAfterGeneration(hookResult);
            if (modified) {
              effectiveStepText = modified.text;
              if (modified.toolCalls.length === 0 && streamedToolCalls && streamedToolCalls.length > 0) {
                streamedToolCalls = [];
              }
            }
          } catch (hookErr) {
            console.warn('[agentos] onAfterGeneration hook error:', hookErr);
          }
        }

        // Always track the latest step's text so finalText is available even
        // when maxSteps is exhausted with outstanding tool calls.
        if (effectiveStepText) {
          finalText = effectiveStepText;
        }

        if (!streamedToolCalls || streamedToolCalls.length === 0) {
          const stepFinish = normalizeStreamFinishReason(lastStepFinishReason);
          rootSpan?.setAttribute('agentos.api.finish_reason', stepFinish);
          rootSpan?.setAttribute('agentos.api.tool_calls', allToolCalls.length);
          attachUsageAttributes(rootSpan, usage);
          if (recordedProviderId && recordedModelId) {
            attachGenAiAttributes(rootSpan, {
              providerName: recordedProviderId,
              operationName: 'chat',
              requestModel: recordedModelId,
              responseModel: lastResponseModelId,
              usage,
            });
          }
          resolveText!(finalText);
          resolveUsage!(usage); resolveResponseModel!(lastResponseModelId);
          resolveToolCalls!(allToolCalls);
          resolveFinishReason!(stepFinish);
          return;
        }

        messages.push({
          role: 'assistant',
          content: effectiveStepText || null,
          tool_calls: streamedToolCalls,
        } as any);

        for (const toolCall of streamedToolCalls) {
          const fnName = toolCall.function?.name ?? '';
          const rawArgs = toolCall.function?.arguments ?? '{}';
          const toolCallId = toolCall.id ?? '';
          const toolCallRecord: ToolCallRecord = {
            name: fnName,
            args: rawArgs,
          };
          let parsedArgs: unknown;

          try {
            parsedArgs = typeof rawArgs === 'string' ? JSON.parse(rawArgs): rawArgs;
            toolCallRecord.args = parsedArgs;
          } catch {
            toolCallRecord.error = `Tool "${fnName}" arguments were not valid JSON.`;
            const resultPart: StreamPart = {
              type: 'tool-result',
              toolName: fnName,
              result: { error: toolCallRecord.error },
            };
            parts.push(resultPart);
            yield resultPart;
            messages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: JSON.stringify({ error: toolCallRecord.error }),
            } as any);
            allToolCalls.push(toolCallRecord);
            continue;
          }
          const requestPart: StreamPart = { type: 'tool-call', toolName: fnName, args: parsedArgs };
          parts.push(requestPart);
          yield requestPart;

          const tool = toolMap.get(fnName);
          if (!tool) {
            toolCallRecord.error = `Tool "${fnName}" not found.`;
            const resultPart: StreamPart = {
              type: 'tool-result',
              toolName: fnName,
              result: { error: toolCallRecord.error },
            };
            parts.push(resultPart);
            yield resultPart;
            messages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: JSON.stringify({ error: toolCallRecord.error }),
            } as any);
            allToolCalls.push(toolCallRecord);
            continue;
          }

          // --- onBeforeToolExecution hook ---
          if (opts.onBeforeToolExecution) {
            try {
              const hookInfo: ToolCallHookInfo = {
                name: fnName,
                args: parsedArgs as Record<string, unknown>,
                id: toolCallId || '',
                step,
              };
              const hookResult = await opts.onBeforeToolExecution(hookInfo);
              if (hookResult === null) {
                toolCallRecord.error = 'Skipped by onBeforeToolExecution hook';
                const resultPart: StreamPart = {
                  type: 'tool-result',
                  toolName: fnName,
                  result: { skipped: true },
                };
                parts.push(resultPart);
                yield resultPart;
                messages.push({
                  role: 'tool',
                  tool_call_id: toolCallId,
                  content: JSON.stringify({ skipped: true }),
                } as any);
                allToolCalls.push(toolCallRecord);
                continue;
              }
              parsedArgs = hookResult.args;
            } catch (hookErr) {
              console.warn('[agentos] onBeforeToolExecution hook error:', hookErr);
            }
          }

          try {
            const result = await tool.execute(
              parsedArgs as any,
              buildHelperToolExecutionContext(
                'streamText',
                helperToolRunId,
                step,
                toolCallId || undefined,
              ),
            );
            toolCallRecord.result = result.output;
            toolCallRecord.error = result.success ? undefined: result.error;
            const resultPart: StreamPart = {
              type: 'tool-result',
              toolName: fnName,
              result: result.output ?? { error: result.error },
            };
            parts.push(resultPart);
            yield resultPart;
            messages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: JSON.stringify(
                result.output ?? { error: result.error ?? 'Tool execution failed.' }
              ),
            } as any);
          } catch (err: any) {
            toolCallRecord.error = err?.message ?? String(err);
            const resultPart: StreamPart = {
              type: 'tool-result',
              toolName: fnName,
              result: { error: toolCallRecord.error },
            };
            parts.push(resultPart);
            yield resultPart;
            messages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: JSON.stringify({ error: toolCallRecord.error }),
            } as any);
          }

          allToolCalls.push(toolCallRecord);
        }
      }
      } catch (loopErr) {
        // 'auto' reactive fallback: if the provider rejected native tool-use
        // before any text streamed, re-run the turn through the prompt shim.
        if (
          !streamedAnyText &&
          tools.length > 0 &&
          toolMode === 'auto' &&
          toolUnsupportedErr(loopErr)
        ) {
          yield* runShimStream();
          return;
        }
        throw loopErr;
      }

      resolveText!(finalText);
      resolveUsage!(usage); resolveResponseModel!(lastResponseModelId);
      resolveToolCalls!(allToolCalls);
      // maxSteps exhausted. Outstanding tool calls with no final text is
      // the classic 'tool-calls' ending; otherwise the last step's own
      // reason describes the assembled reply.
      resolveFinishReason!(
        allToolCalls.length > 0 && !finalText
          ? 'tool-calls'
          : normalizeStreamFinishReason(lastStepFinishReason),
      );
      // Primary streaming attempt succeeded: reset the failure streak
      // so a future transient error starts fresh. See
      // {@link LLMProviderHealthRegistry}.
      if (recordedProviderId) {
        globalLLMProviderHealth.recordSuccess(recordedProviderId);
      }
    } catch (err: any) {
      const error = err instanceof Error ? err: new Error(String(err));

      // Record the failure on the provider-health registry. Synthetic
      // circuit-open errors are skipped because they're already a
      // *consequence* of the registry, not a new failure to record.
      if (recordedProviderId && error.name !== 'LLMProviderCircuitOpenError') {
        globalLLMProviderHealth.recordFailure(recordedProviderId, error);
      }

      // ── Fallback chain for streaming ──────────────────────────────
      // When the primary provider fails with a retryable error and
      // fallbackProviders are configured, delegate to a new streamText
      // call targeting the next available fallback.  All parts from the
      // fallback stream are yielded transparently to the consumer.
      // Resolve fallback chain: caller-supplied wins, undefined triggers
      // auto-build from env keys, empty array explicitly opts out. The
      // auto-build is POLICY-AWARE like generateText's (mature tiers get
      // the uncensored prefix) — streaming previously used the plain
      // availability chain, so a mature streamed turn that lost its
      // primary fell onto refuse-happy legs first.
      const effectiveFallbacks = opts.fallbackProviders === undefined
        ? buildPolicyAwareFallbackChain(opts.policyTier, recordedProviderId)
       : opts.fallbackProviders;

      if (effectiveFallbacks.length && isRetryableError(error)) {
        let lastFallbackError: Error = error;
        let fallbackSucceeded = false;
        let fallbackFinishReason: StreamFinishReason = 'stop';
        let attempt = 0;

        for (const fb of effectiveFallbacks) {
          attempt += 1;
          // Skip fallback entries with an open breaker: the recursive
          // streamText below would short-circuit at the same isOpen()
          // check, but the outer skip avoids the extra log noise +
          // recursion overhead.
          if (globalLLMProviderHealth.isOpen(fb.provider)) {
            fallbackLogger.info('streaming provider fallback skipped (circuit open)', {
              event: 'fallback_skipped_circuit_open',
              api: 'streamText',
              primaryProvider: recordedProviderId,
              fallbackProvider: fb.provider,
              fallbackModel: fb.model,
              attempt,
            });
            continue;
          }
          try {
            fallbackLogger.info('streaming provider fallback triggered', {
              event: 'fallback_fired',
              api: 'streamText',
              primaryProvider: recordedProviderId,
              fallbackProvider: fb.provider,
              fallbackModel: fb.model,
              errorType: lastFallbackError.name,
              errorMessage: lastFallbackError.message.slice(0, 200),
              attempt,
            });
            opts.onFallback?.(lastFallbackError, fb.provider);
            const fallbackResult = streamText({
              ...opts,
              provider: fb.provider,
              model: fb.model,
              apiKey: undefined,
              baseUrl: undefined,
              // Preserve the REMAINING chain (entries AFTER the current fb;
              // `attempt` is 1-indexed so slice(attempt) drops fb and all
              // already-tried entries), mirroring generateText. Passing
              // `undefined` here made the recursion REBUILD the default
              // chain — it could re-try the already-failed primary and
              // ignored explicit frontier-only chains. The final entry
              // passes [] -> explicit opt-out -> the recursion throws
              // instead of looping.
              fallbackProviders: effectiveFallbacks.slice(attempt),
              onFallback: undefined,
            });

            // Pipe all parts from the fallback stream to the consumer
            for await (const fbPart of fallbackResult.fullStream) {
              parts.push(fbPart);
              yield fbPart;
            }

            // Resolve aggregated promises from the fallback stream
            finalText = await fallbackResult.text;
            const fbUsage = await fallbackResult.usage;
            usage.promptTokens += fbUsage.promptTokens;
            usage.completionTokens += fbUsage.completionTokens;
            usage.totalTokens += fbUsage.totalTokens;
            if (typeof fbUsage.costUSD === 'number') {
              usage.costUSD = (usage.costUSD ?? 0) + fbUsage.costUSD;
            }
            if (typeof fbUsage.cacheReadTokens === 'number') {
              usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + fbUsage.cacheReadTokens;
            }
            if (typeof fbUsage.cacheCreationTokens === 'number') {
              usage.cacheCreationTokens = (usage.cacheCreationTokens ?? 0) + fbUsage.cacheCreationTokens;
            }
            if (typeof fbUsage.inclusiveInputTokens === 'number') {
              usage.inclusiveInputTokens = (usage.inclusiveInputTokens ?? 0) + fbUsage.inclusiveInputTokens;
            }

            const fbToolCalls = await fallbackResult.toolCalls;
            allToolCalls.push(...fbToolCalls);
            // The recursive fallback streamText computed its own reason;
            // capture it while the result is in scope (drained above, so
            // the promise is already settled).
            fallbackFinishReason = await fallbackResult.finishReason;
            if (opts.cacheDiagnostics) {
              // Adopt the fallback run's verdict + thread key. Resolving with
              // the child promises locks ours to follow them; the outer
              // finally's later settle is then a no-op.
              resolveCacheDiagnostics!(fallbackResult.cacheDiagnostics);
              resolveProviderMessageId!(fallbackResult.providerMessageId);
            }

            fallbackLogger.info('streaming provider fallback succeeded', {
              event: 'fallback_succeeded',
              api: 'streamText',
              primaryProvider: recordedProviderId,
              fallbackProvider: fb.provider,
              fallbackModel: fb.model,
              attempt,
            });
            fallbackSucceeded = true;
            break;
          } catch (fbErr: any) {
            lastFallbackError = fbErr instanceof Error ? fbErr: new Error(String(fbErr));
          }
        }

        if (fallbackSucceeded) {
          resolveText!(finalText);
          resolveUsage!(usage); resolveResponseModel!(lastResponseModelId);
          resolveToolCalls!(allToolCalls);
          resolveFinishReason!(fallbackFinishReason);
        } else {
          fallbackLogger.warn('streaming provider fallbacks exhausted', {
            event: 'fallback_exhausted',
            api: 'streamText',
            primaryProvider: recordedProviderId,
            attempts: attempt,
            errorType: lastFallbackError.name,
            errorMessage: lastFallbackError.message.slice(0, 200),
          });
          metricStatus = 'error';
          const errorPart: StreamPart = { type: 'error', error: lastFallbackError };
          parts.push(errorPart);
          yield errorPart;
          resolveText!(finalText);
          resolveUsage!(usage); resolveResponseModel!(lastResponseModelId);
          resolveToolCalls!(allToolCalls);
          resolveFinishReason!('error');
        }
      } else {
        metricStatus = 'error';
        const part: StreamPart = { type: 'error', error };
        parts.push(part);
        yield part;
        resolveText!(finalText);
        resolveUsage!(usage); resolveResponseModel!(lastResponseModelId);
        resolveToolCalls!(allToolCalls);
        resolveFinishReason!('error');
      }
    } finally {
      // Belt-and-suspenders for the routing Promises: if the stream
      // errored before routing completed (e.g. resolveProvider option
      // threw), settle the Promises with whatever recorded ids exist
      // so awaiters don't hang forever. Empty strings keep the type
      // consistent with successful resolution.
      // Abandonment belt-and-suspenders for the AGGREGATE promises too: a
      // consumer that breaks out of the stream mid-flight must still be able
      // to await text/usage/toolCalls without hanging. Values reflect what
      // streamed before the abandonment; normal completions already settled
      // these, making the calls no-ops (first settle wins).
      resolveText!(finalText);
      resolveUsage!(usage); resolveResponseModel!(lastResponseModelId);
      resolveToolCalls!(allToolCalls);
      resolveProviderId!(recordedProviderId ?? '');
      resolveModelId!(recordedModelId ?? '');
      // Belt-and-suspenders like the routing Promises above: every
      // normal terminal already settled finishReason with a specific
      // value (Promise semantics make this a no-op there); this covers
      // early consumer abandonment, thrown-before-terminal paths, and
      // the prompt-shim delegation so awaiters never hang.
      resolveFinishReason!(
        metricStatus === 'error'
          ? 'error'
          : allToolCalls.length > 0 && !finalText
            ? 'tool-calls'
            : normalizeStreamFinishReason(lastStepFinishReason),
      );
      // Same belt-and-suspenders: every path settles the diagnostics pair
      // here (null when the run never opted in or never reached a final
      // chunk) so awaiters never hang. When opted in, the id is the final
      // step's — the caller's thread key for the next request.
      resolveCacheDiagnostics!(opts.cacheDiagnostics ? lastCacheDiagnostics : null);
      resolveProviderMessageId!(
        opts.cacheDiagnostics && sawFinalProviderChunk ? lastProviderMessageId : null,
      );
      rootSpan?.setAttribute('agentos.api.tool_calls', allToolCalls.length);
      if (metricStatus === 'error') {
        rootSpan?.setAttribute('agentos.api.finish_reason', 'error');
      } else if (allToolCalls.length > 0 && !finalText) {
        rootSpan?.setAttribute('agentos.api.finish_reason', 'tool-calls');
      }
      attachUsageAttributes(rootSpan, usage);
      if (recordedProviderId && recordedModelId) {
        attachGenAiAttributes(rootSpan, {
          providerName: recordedProviderId,
          operationName: 'chat',
          requestModel: recordedModelId,
          responseModel: lastResponseModelId,
          usage,
        });
      }
      rootSpan?.end();
      try {
        await recordAgentOSUsageLazy({
          providerId: recordedProviderId,
          modelId: recordedModelId,
          usage,
          options: {
            ...opts.usageLedger,
            source: opts.usageLedger?.source ?? 'streamText',
          },
        });
      } catch {
        // Helper-level usage persistence is best-effort and should not break streaming.
      }
      recordAgentOSTurnMetrics({
        durationMs: Date.now() - startedAt,
        status: metricStatus,
        ...(firstPartAt !== undefined ? { ttfbMs: firstPartAt - startedAt } : {}),
        usage: toTurnMetricUsage(usage),
      });
      // 2026-05-29 — fire the global LLM usage observer with the
      // finalized stream usage. Same hook generateText fires; hosts
      // (wilds-ai foundation_usage_events, billing dashboards) get
      // one consistent stream of events whether the caller used
      // generateText or streamText. No-op when no observer is
      // registered.
      if (metricStatus !== 'error') {
        fireLlmUsageObserver({
          provider: recordedProviderId ?? '',
          model: recordedModelId ?? '',
          usage,
          source: opts.source,
          finishReason:
            allToolCalls.length > 0 && !finalText
              ? 'tool-calls'
              : normalizeStreamFinishReason(lastStepFinishReason),
          surface: 'streamText',
          durationMs: Date.now() - startedAt,
          ...(firstPartAt !== undefined ? { ttfbMs: firstPartAt - startedAt } : {}),
        });
      }
    }
  }

  // Single timing chokepoint: stamp `firstPartAt` when the first part
  // reaches the consumer instead of instrumenting every yield site
  // inside runStream. The wrapper delegates verbatim otherwise, and
  // runStream's finally (where the usage observer fires) still runs on
  // generator completion because the wrapper drains it with for-await.
  async function* runStreamTimed(): AsyncGenerator<StreamPart> {
    for await (const part of runStream()) {
      if (firstPartAt === undefined) firstPartAt = Date.now();
      yield part;
    }
  }

  const fullStreamIterable = runStreamTimed();

  const textStreamIterable: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      const inner = fullStreamIterable[Symbol.asyncIterator]();
      return {
        async next() {
          while (true) {
            const { value, done } = await inner.next();
            if (done) return { value: undefined, done: true };
            if (value.type === 'text') return { value: value.text, done: false };
          }
        },
        // Early abandonment (for-await break / iterator.return()) must reach
        // the generator so its finally runs and every deferred promise
        // (text/usage/finishReason/cacheDiagnostics/providerMessageId)
        // settles — a next()-only wrapper left them pending forever.
        async return(value?: unknown) {
          await inner.return?.(value as never);
          return { value: undefined as never, done: true as const };
        },
        async throw(err?: unknown) {
          if (inner.throw) {
            await inner.throw(err);
          } else {
            await inner.return?.(undefined as never);
          }
          throw err;
        },
      };
    },
  };

  return {
    textStream: textStreamIterable,
    fullStream: fullStreamIterable,
    text: textPromise,
    usage: usagePromise,
    responseModel: responseModelPromise,
    toolCalls: toolCallsPromise,
    provider: providerPromise,
    model: modelPromise,
    finishReason: finishReasonPromise,
    cacheDiagnostics: cacheDiagnosticsPromise,
    providerMessageId: providerMessageIdPromise,
  };
}
