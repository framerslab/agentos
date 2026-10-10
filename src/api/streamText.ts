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
import { runEmulatedToolLoop, toShimMessages, type ToolMode } from './runtime/tool-emulation/index.js';
import { APPROVAL_GRANTED, askApprovalGate } from './runtime/approval-gate.js';
import {
  advanceFallbackWalk,
  buildPolicyAwareFallbackChain,
  createPlan,
  explicitRequiredCapabilities,
  fallbackEntrySentAs,
  fallbackHopOverrides,
  gateFallbackEntry,
  INITIAL_FALLBACK_WALK,
  resolveFallbackChain,
  resolvePolicyTier,
  addModelUsage,
  hasBillableUsage,
  isRetryableError,
  markChainWalked,
  markToolsRan,
  chainWalkedBefore,
  toolsRanBefore,
  usageOfError,
  resolveChainOfThought,
  type FallbackProviderEntry,
  type FallbackSkipReason,
  type GenerateTextOptions,
  type GenerationHookContext,
  type GenerationHookResult,
  type Plan,
  type TokenUsage,
  type ToolCallHookInfo,
  type ToolCallRecord,
  type ResolvedFallbackEntry,
} from './generateText.js';
import { ContextWindowExceededError } from '../core/llm/providers/errors/ContextWindowExceededError.js';
import { checkContextFit } from './runtime/contextWindowFit.js';
import { asSpendBudget, assertCallWithinBudget, costOfUsageUSD, promptCharsOf } from './runtime/spendBudget.js';
import { isCallerStop, markHookStop } from './runtime/callerStop.js';
import type { CacheDiagnostics } from '../core/llm/providers/IProvider.js';
import { toProviderReplayMessage } from './sessionTranscript.js';
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

/** Adds one {@link TokenUsage} to another; optional counters add when present. */
/**
 * The HTTP status a provider error chunk names in a numeric code: Gemini's
 * in-stream errors carry `code: 500` beside `type: 'INTERNAL'`. A 401 or 403
 * inside a stream describes an upstream attempt, not this key, so it is not
 * read as a status (the health registry would open its auth policy on it).
 */
function statusOfChunkCode(code: unknown): number | undefined {
  return typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599 && code !== 401 && code !== 403
    ? code
    : undefined;
}

function addTokenUsage(target: TokenUsage, add: TokenUsage): void {
  target.promptTokens += add.promptTokens;
  target.completionTokens += add.completionTokens;
  target.totalTokens += add.totalTokens;
  if (add.costUSD !== undefined) target.costUSD = (target.costUSD ?? 0) + add.costUSD;
  if (add.cacheReadTokens !== undefined) target.cacheReadTokens = (target.cacheReadTokens ?? 0) + add.cacheReadTokens;
  if (add.cacheCreationTokens !== undefined) {
    target.cacheCreationTokens = (target.cacheCreationTokens ?? 0) + add.cacheCreationTokens;
  }
  if (add.inclusiveInputTokens !== undefined) {
    target.inclusiveInputTokens = (target.inclusiveInputTokens ?? 0) + add.inclusiveInputTokens;
  }
}

/**
 * The part of a provider's cumulative usage report (`ModelUsage`) not yet
 * counted, as {@link TokenUsage}: each counter less what `counted` already
 * holds, never below zero.
 */
function usageBeyond(report: unknown, counted: TokenUsage): TokenUsage | undefined {
  if (!report || typeof report !== 'object') return undefined;
  const total: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  addModelUsage(total, report);
  const less = (x: number | undefined, y: number | undefined): number | undefined =>
    x === undefined ? undefined : Math.max(0, x - (y ?? 0));
  return {
    promptTokens: less(total.promptTokens, counted.promptTokens) ?? 0,
    completionTokens: less(total.completionTokens, counted.completionTokens) ?? 0,
    totalTokens: less(total.totalTokens, counted.totalTokens) ?? 0,
    ...(total.costUSD !== undefined ? { costUSD: less(total.costUSD, counted.costUSD) } : {}),
    ...(total.cacheReadTokens !== undefined ? { cacheReadTokens: less(total.cacheReadTokens, counted.cacheReadTokens) } : {}),
    ...(total.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: less(total.cacheCreationTokens, counted.cacheCreationTokens) }
      : {}),
    ...(total.inclusiveInputTokens !== undefined
      ? { inclusiveInputTokens: less(total.inclusiveInputTokens, counted.inclusiveInputTokens) }
      : {}),
  };
}

/**
 * The error a stream that the caller's signal ended reports in its `error`
 * part: the signal's reason when that is an Error (the `DOMException` an
 * `abort()` or `AbortSignal.timeout()` gives is one), or an Error naming it.
 */
function abortReasonError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
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
  /**
   * Resolves to the assembled assistant reply when the stream completes: the
   * text of the latest step that produced any. A stream that ends mid-step,
   * on an error after output or because the consumer stopped reading,
   * resolves to the text that step delivered.
   */
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
  /**
   * Provider-reported service tier the final step actually ran at (OpenAI;
   * spec batch-1 C2). Settles on every terminal path; `undefined` when no
   * chunk reported a tier.
   */
  serviceTier: Promise<string | undefined>;
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
   * not hang. On a stream the consumer abandoned it does not say why the
   * stream ended: it reports the latest step that finished. The
   * prompt-shim tool-emulation path reports `'stop'` (its internal calls
   * do not thread per-step reasons).
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
  // One budget instance for the whole stream: every options object built from
  // `opts` below (a fallback hop) carries it, so each hop is charged to the
  // same budget.
  const budget = asSpendBudget(opts.budget);
  if (budget) opts = { ...opts, budget };
  let resolveText: (v: string) => void;
  let resolveUsage: (v: TokenUsage) => void;
  let resolveResponseModel: (v: string | undefined) => void;
  let lastResponseModelId: string | undefined;
  let resolveServiceTier: (v: string | undefined) => void;
  let lastServiceTier: string | undefined;
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
  // Provider-reported service tier of the final step (spec batch-1 C2);
  // settled at every terminal path alongside responseModel.
  const serviceTierPromise = new Promise<string | undefined>((r) => {
    resolveServiceTier = r;
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
  // Set once the prompt-tool shim runs a tool: its rounds are buffered and
  // yield nothing until the end, so firstPartAt cannot show them. A stream
  // whose tools ran is not restarted on a fallback provider.
  let shimRanTool = false;

  async function* runStream(): AsyncGenerator<StreamPart> {
    const startedAt = Date.now();
    const rootSpan = startAgentOSSpan('agentos.api.stream_text');
    const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    // Usage the current step's final chunks reported so far, so a refusal
    // that reports the step's cumulative usage is not counted twice.
    let stepUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let finalText = '';
    // Text of the step in progress, as the consumer received it. A stream
    // that ends mid-step reports it as its text: the consumer already has it.
    let stepTextSoFar = '';
    let metricStatus: 'ok' | 'error' = 'ok';
    // True once a provider-fallback leg ran, served or failed. Each leg is a
    // recursive streamText call that meters its own attempt (usage-observer
    // event and ledger row, leg provider/model, fallbackDepth stamped), so
    // the outer finally meters only this call's own attempt (attemptUsage):
    // recordedProviderId/ModelId name this attempt's provider, and folding a
    // leg's usage in would bill it twice under that provider.
    let fallbackLegRan = false;
    // What the failed attempt consumed before a fallback leg took over. The
    // leg meters itself, so this is what the outer stream meters then.
    let attemptUsage: TokenUsage | undefined;
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
      // A stream whose signal has already aborted ends before anything is set up or sent.
      opts.abortSignal?.throwIfAborted();
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
              ?? opts.policyTier
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

      // Session history replays through here, so keep the tool pairing and
      // thinking fields (see toProviderReplayMessage).
      if (opts.messages)
        for (const m of opts.messages) messages.push(toProviderReplayMessage(m));
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

      // A catalog model is sent only a request it can hold: otherwise the
      // call throws in place of the send and the walk moves on. Checked on
      // the first native send and on the prompt shim's first send.
      const assertFitsContextWindow = (sent: { messages: ReadonlyArray<unknown>; tools?: unknown }): void => {
        const fit = checkContextFit({
          provider: resolved.providerId,
          model: resolved.modelId,
          messages: sent.messages,
          tools: sent.tools,
          maxTokens: opts.maxTokens,
          customModelParams: opts.customModelParams,
        });
        if (!fit.fits && fit.contextWindow !== undefined) {
          throw new ContextWindowExceededError({
            provider: resolved.providerId,
            model: resolved.modelId,
            contextWindow: fit.contextWindow,
            estimatedInputTokens: fit.estimatedInputTokens,
            outputTokens: fit.outputTokens,
          });
        }
      };

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
          // not auto-cache behind the caller's back. The call's abort signal
          // goes with it.
          {
            ...planConfig,
            requestTimeout: planConfig?.requestTimeout ?? opts.requestTimeout,
            ...(planConfig?.cache !== undefined || opts.cache !== undefined
              ? { cache: planConfig?.cache ?? opts.cache }
              : {}),
            ...(planConfig?.thinking === false || opts.thinking === false ? { thinking: false as const } : {}),
            ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
          },
          usage,
          budget ? { budget, providerId: resolved.providerId, what: 'stream_text.plan' } : undefined,
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
      let shimSendChecked = false;
      async function* runShimStream(): AsyncGenerator<StreamPart> {
        const loopResult = await runEmulatedToolLoop({
          tools: Array.from(toolMap.values()),
          onToolExecute: () => {
            shimRanTool = true;
          },
          // The hook, then the approval gate, before each parsed call runs,
          // as on the native loop below.
          onBeforeToolExecution: opts.onBeforeToolExecution,
          hookErrors: opts.hookErrors,
          approvalGate: opts.__approvalGate,
          // Native tool turns in the history become the shim's own
          // <tool_call> / <tool_response> text.
          messages: toShimMessages(messages),
          maxRoundtrips: opts.maxSteps ?? 5,
          callModel: async (msgs) => {
            // No round starts once the caller's signal has aborted.
            opts.abortSignal?.throwIfAborted();
            // The shim sends rendered tool text in place of native schemas,
            // so its first send is checked on its own.
            if (!shimSendChecked) {
              shimSendChecked = true;
              assertFitsContextWindow({ messages: msgs });
            }
            if (budget) assertCallWithinBudget(budget, resolved, promptCharsOf(msgs), opts.maxTokens, 'stream_text.shim');
            // provider is guaranteed non-undefined by the `if (!provider) throw`
            // guard above; the closure just loses TS's flow-narrowing.
            const r = await provider!.generateCompletion(resolved.modelId, msgs as any, {
              temperature: opts.temperature,
              maxTokens: opts.maxTokens,
              // Forward per-call requestTimeout on the shim path too so the
              // prompt-tool-calling emulation honors the caller's bound,
              // matching generateText's own shim path.
              ...(opts.requestTimeout !== undefined ? { requestTimeout: opts.requestTimeout } : {}),
              ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
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
            ...(opts.promptCacheKey === 'auto' && (opts.sessionId ?? opts.usageLedger?.sessionId) !== undefined
              ? { promptCacheSessionId: (opts.sessionId ?? opts.usageLedger?.sessionId) as string }
              : {}),
            ...(opts.promptCacheRetention !== undefined ? { promptCacheRetention: opts.promptCacheRetention } : {}),
            ...(opts.serviceTier !== undefined ? { serviceTier: opts.serviceTier } : {}),
              // Forward provider-specific top-level payload params (e.g.
              // OpenRouter provider-routing preferences) on the shim path too.
              ...(opts.customModelParams !== undefined
                ? { customModelParams: opts.customModelParams }
                : {}),
            } as any);
            budget?.record(costOfUsageUSD(resolved.providerId, resolved.modelId, r.usage), r.usage?.totalTokens ?? 0, 'stream_text.shim');
            // Aggregate the COMPLETE normalized usage from every shim
            // roundtrip (spec batch-1 review fold) as each call returns, so
            // a stream that fails on a later round still reports what its
            // earlier rounds consumed. The loop's own {totalTokens} sum is
            // left unused, or it would count twice.
            if (r.usage) {
              if (typeof r.usage.totalTokens === 'number') usage.totalTokens += r.usage.totalTokens;
              if (typeof r.usage.promptTokens === 'number') usage.promptTokens += r.usage.promptTokens;
              if (typeof r.usage.completionTokens === 'number') usage.completionTokens += r.usage.completionTokens;
              if (typeof r.usage.costUSD === 'number') usage.costUSD = (usage.costUSD ?? 0) + r.usage.costUSD;
              if (typeof r.usage.cacheReadInputTokens === 'number') {
                usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + r.usage.cacheReadInputTokens;
              }
              if (typeof r.usage.cacheCreationInputTokens === 'number') {
                usage.cacheCreationTokens = (usage.cacheCreationTokens ?? 0) + r.usage.cacheCreationInputTokens;
              }
              if (typeof r.usage.inclusiveInputTokens === 'number') {
                usage.inclusiveInputTokens = (usage.inclusiveInputTokens ?? 0) + r.usage.inclusiveInputTokens;
              }
            }
            if (typeof r.modelId === 'string' && r.modelId) lastResponseModelId = r.modelId;
            if (typeof r.serviceTier === 'string' && r.serviceTier) lastServiceTier = r.serviceTier;
            // A request whose provider did not read the signal ran to its end:
            // its usage is counted above, and the stream stops here.
            opts.abortSignal?.throwIfAborted();
            const cc = r.choices?.[0]?.message?.content;
            return {
              text: typeof cc === 'string' ? cc : ((cc as any)?.text ?? ''),
              usage: { totalTokens: r.usage?.totalTokens ?? 0 },
            };
          },
        });
        // An abort during the shim's last tool round ends the stream on the
        // signal's reason, once the round has run, instead of settling it.
        opts.abortSignal?.throwIfAborted();
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
        resolveUsage!(usage); resolveResponseModel!(lastResponseModelId); resolveServiceTier!(lastServiceTier);
        resolveToolCalls!(shimToolCalls);
      }
      if (tools.length > 0 && toolMode === 'prompt') {
        yield* runShimStream();
        return;
      }

      let streamedAnyText = false;
      try {
      for (let step = 0; step < maxSteps; step++) {
        // No step starts once the caller's signal has aborted.
        opts.abortSignal?.throwIfAborted();
        stepUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
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
            if (opts.hookErrors === 'throw') throw markHookStop(hookErr);
            console.warn('[agentos] onBeforeGeneration hook error:', hookErr);
          }
        }

        // A leg's first send is checked against its model's window; later
        // steps are not checked again.
        if (step === 0) assertFitsContextWindow({ messages: effectiveMessages, tools: toolSchemas });
        if (budget) assertCallWithinBudget(budget, resolved, promptCharsOf(effectiveMessages, undefined, toolSchemas), opts.maxTokens, 'stream_text');

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
            // Per-call request timeout, mirroring generateText: a streamed
            // call with opts.requestTimeout set (e.g. an agent-level
            // controls.maxDurationMs budget) bounds the provider request on
            // the stream path too, not only on the generate path.
            ...(opts.requestTimeout !== undefined ? { requestTimeout: opts.requestTimeout } : {}),
            // The caller's signal stops the provider's stream, which ends with
            // its abort chunk.
            ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
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
            ...(opts.promptCacheKey === 'auto' && (opts.sessionId ?? opts.usageLedger?.sessionId) !== undefined
              ? { promptCacheSessionId: (opts.sessionId ?? opts.usageLedger?.sessionId) as string }
              : {}),
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
        stepTextSoFar = '';

        try {
          for await (const chunk of stream) {
            // Capture the provider-reported identity from EVERY chunk (not
            // only the usage-final one) so an error or abandonment after a
            // model-bearing chunk still resolves responseModel/serviceTier.
            if (typeof chunk.modelId === 'string' && chunk.modelId) {
              lastResponseModelId = chunk.modelId;
            }
            if (typeof chunk.serviceTier === 'string' && chunk.serviceTier) {
              lastServiceTier = chunk.serviceTier;
            }
            reconstructor.push(chunk);

            const textDelta = chunk.responseTextDelta ?? '';
            if (textDelta) {
              const part: StreamPart = { type: 'text', text: textDelta };
              parts.push(part);
              stepTextSoFar += textDelta;
              yield part;
              streamedAnyText = true;
            }

            // An error chunk ends the step without a provider message, so it
            // names no id for the next step to compare against.
            if (chunk.isFinal && opts.cacheDiagnostics && !chunk.error) {
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
              addModelUsage(stepUsage, chunk.usage);
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
              // Per-step GenAI semconv attrs (queue item: step-span wiring).
              attachGenAiAttributes(stepSpan, {
                providerName: resolved.providerId,
                operationName: 'chat',
                requestModel: resolved.modelId,
                ...(typeof chunk.modelId === 'string' && chunk.modelId
                  ? { responseModel: chunk.modelId }
                  : {}),
                ...(opts.serviceTier !== undefined ? { requestServiceTier: opts.serviceTier } : {}),
                ...(typeof chunk.serviceTier === 'string'
                  ? { responseServiceTier: chunk.serviceTier }
                  : {}),
                usage: {
                  promptTokens: chunk.usage.promptTokens,
                  completionTokens: chunk.usage.completionTokens,
                  inclusiveInputTokens: (chunk.usage as { inclusiveInputTokens?: number }).inclusiveInputTokens,
                  cacheReadTokens: (chunk.usage as { cacheReadInputTokens?: number }).cacheReadInputTokens,
                  cacheCreationTokens: (chunk.usage as { cacheCreationInputTokens?: number }).cacheCreationInputTokens,
                },
              });
            }

            // After the usage above: a provider that ends a step with an
            // error can still report what the step billed (a failed
            // /v1/responses response carries its usage), and the result,
            // the usage ledger and the observer read `usage`.
            if (chunk.error) {
              // The error keeps what the provider classified, so the retry
              // classifier and the health registry read the fields a thrown
              // provider error carries.
              const chunkStatus = statusOfChunkCode(chunk.error.code);
              const error: Error = Object.assign(new Error(chunk.error.message), {
                ...(chunk.error.type !== undefined ? { type: chunk.error.type } : {}),
                ...(chunk.error.code !== undefined ? { code: chunk.error.code } : {}),
                ...(chunkStatus !== undefined ? { httpStatus: chunkStatus } : {}),
                ...(chunk.error.details !== undefined ? { details: chunk.error.details } : {}),
              });
              const aborted = chunk.error.type === 'abort';
              // The caller's signal ended the stream: its error part carries
              // the signal's reason.
              const signal = opts.abortSignal;
              const stoppedBy = signal?.aborted ? abortReasonError(signal) : undefined;
              // Before anything reached the consumer, a provider error is this
              // attempt failing: thrown, it is recorded with the health
              // registry and walked like any thrown error. An abort is the
              // caller's own stop and never walks.
              if (!aborted && firstPartAt === undefined && !shimRanTool) throw error;
              // After output the stream ends here, and the failure is recorded.
              if (!aborted && !stoppedBy && recordedProviderId) {
                globalLLMProviderHealth.recordFailure(recordedProviderId, error);
              }
              // Settled before the error part is handed over: a consumer that
              // stops reading at it still finds the stream failed.
              metricStatus = 'error';
              resolveText!(stepTextSoFar || finalText);
              resolveUsage!(usage); resolveResponseModel!(lastResponseModelId); resolveServiceTier!(lastServiceTier);
              resolveToolCalls!(allToolCalls);
              resolveFinishReason!('error');
              const part: StreamPart = { type: 'error', error: stoppedBy ?? error };
              parts.push(part);
              yield part;
              return;
            }
          }
        } finally {
          stepSpan?.end();
          // The budget is charged once per provider stream, whether it
          // finished, failed or was abandoned: what its final chunks reported.
          budget?.record(costOfUsageUSD(resolved.providerId, resolved.modelId, stepUsage), stepUsage.totalTokens, 'stream_text');
        }
        // A provider stream that did not read the signal ran to its end: its
        // usage is charged above, and the stream ends here on the signal's reason.
        opts.abortSignal?.throwIfAborted();

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
              ...(toolCall.thoughtSignature ? { thoughtSignature: toolCall.thoughtSignature } : {}),
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
            if (opts.hookErrors === 'throw') throw markHookStop(hookErr);
            console.warn('[agentos] onAfterGeneration hook error:', hookErr);
          }
        }
        // An abort while the hook ran ends the stream here: the step does not
        // settle the stream, and its tools do not run.
        opts.abortSignal?.throwIfAborted();

        // Always track the latest step's text so finalText is available even
        // when maxSteps is exhausted with outstanding tool calls.
        if (effectiveStepText) {
          finalText = effectiveStepText;
        }
        // The step's text is settled; finalText reports it from here on.
        stepTextSoFar = '';

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
              ...(opts.serviceTier !== undefined ? { requestServiceTier: opts.serviceTier } : {}),
              ...(lastServiceTier !== undefined ? { responseServiceTier: lastServiceTier } : {}),
            });
          }
          resolveText!(finalText);
          resolveUsage!(usage); resolveResponseModel!(lastResponseModelId); resolveServiceTier!(lastServiceTier);
          resolveToolCalls!(allToolCalls);
          resolveFinishReason!(stepFinish);
          return;
        }

        // Anthropic requires the tool turn's signed thinking back on the
        // continuation request (same rule generateText applies per step).
        const stepThinkingBlocks = finalChunk?.choices?.[0]?.message?.thinkingBlocks;
        messages.push({
          role: 'assistant',
          content: effectiveStepText || null,
          tool_calls: streamedToolCalls,
          ...(stepThinkingBlocks && stepThinkingBlocks.length > 0
            ? { thinkingBlocks: stepThinkingBlocks }
            : {}),
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
              if (opts.hookErrors === 'throw') throw markHookStop(hookErr);
              console.warn('[agentos] onBeforeToolExecution hook error:', hookErr);
            }
          }

          // --- approval gate (agency hitl.approvals.beforeTool) ---
          // Runs after the hook, on the arguments the hook left. Anything but
          // the exact approval skips the tool and tells the model.
          if (opts.__approvalGate) {
            const verdict = await askApprovalGate(opts.__approvalGate, {
              name: fnName,
              args: (parsedArgs ?? {}) as Record<string, unknown>,
              id: toolCallId || '',
              step,
            });
            if (verdict !== APPROVAL_GRANTED) {
              toolCallRecord.error = `Skipped: ${verdict.reason}`;
              const resultPart: StreamPart = {
                type: 'tool-result',
                toolName: fnName,
                result: { skipped: true, reason: verdict.reason },
              };
              parts.push(resultPart);
              yield resultPart;
              messages.push({
                role: 'tool',
                tool_call_id: toolCallId,
                content: JSON.stringify({ skipped: true, reason: verdict.reason }),
              } as any);
              allToolCalls.push(toolCallRecord);
              continue;
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

      // An abort during the last tool round ends the stream on the signal's
      // reason, once the round has run, instead of settling it as a success.
      opts.abortSignal?.throwIfAborted();

      resolveText!(finalText);
      resolveUsage!(usage); resolveResponseModel!(lastResponseModelId); resolveServiceTier!(lastServiceTier);
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
      // The caller's signal ended the stream, whatever error the provider made
      // of the abort: the stream ends on the signal's reason and walks no
      // fallback leg.
      const abortSignal = opts.abortSignal;
      const stoppedBy = abortSignal?.aborted ? abortReasonError(abortSignal) : undefined;
      const error = stoppedBy ?? (err instanceof Error ? err: new Error(String(err)));
      // A step the provider ended with usage attached (a refused turn) was
      // billed; the thrown error replaced the final chunk that reports it.
      // That usage is the request's running total, so what the step's
      // earlier final chunks already reported is left out.
      const unreported = usageBeyond(usageOfError(err), stepUsage);
      if (unreported) {
        addTokenUsage(usage, unreported);
        // The spend budget is charged it too: the step's stream charged only
        // what its chunks reported.
        budget?.record(
          costOfUsageUSD(recordedProviderId ?? '', recordedModelId ?? '', unreported),
          unreported.totalTokens,
          'stream_text.failed',
        );
      }
      attemptUsage = { ...usage };

      // Record the failure on the provider-health registry. Synthetic
      // circuit-open errors are skipped because they're already a
      // *consequence* of the registry, not a new failure to record, and so
      // is a call the caller stopped (its spend budget's refusal, a hook's
      // stop, an abort), which says nothing about the provider.
      if (recordedProviderId && error.name !== 'LLMProviderCircuitOpenError' && !stoppedBy && !isCallerStop(err)) {
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
      const walkTier = resolvePolicyTier(opts);
      const chainEntries = opts.fallbackProviders === undefined
        ? buildPolicyAwareFallbackChain(walkTier, recordedProviderId)
        : opts.fallbackProviders;
      const logLegSkip = (entry: FallbackProviderEntry, reason: FallbackSkipReason): void =>
        fallbackLogger.info('streaming provider fallback skipped', {
          event: 'fallback_leg_skipped',
          api: 'streamText',
          reason,
          primaryProvider: recordedProviderId,
          fallbackProvider: entry.provider,
          fallbackModel: entry.model,
        });
      // A stream that already handed text or tool activity to the consumer
      // is not restarted on another provider (a refusal after text
      // included): the consumer would receive the partial answer followed by
      // a fresh one, and tools could run twice.
      // firstPartAt is stamped when the first part reaches the consumer.
      const deliveredOutput = firstPartAt !== undefined || shimRanTool;
      const walks = !stoppedBy && isRetryableError(error) && !deliveredOutput;
      // The top-level walk resolves the chain once (the failed first model's
      // policy leg dropped, explicit requirements applied, standing legs and
      // refills marked); a leg receives its resolved slice. Resolved only
      // when the walk runs, so its skip lines describe a walk.
      const effectiveFallbacks: ResolvedFallbackEntry[] = !walks
        ? []
        : opts.__fallbackWalk
          ? chainEntries
          : resolveFallbackChain(chainEntries, {
              primary: { provider: recordedProviderId, model: recordedModelId },
              requiredCapabilities: explicitRequiredCapabilities(opts),
              excludedModelIds: opts.routerParams?.excludedModelIds,
              onSkip: logLegSkip,
            });
      // This attempt's own failure updates the walk: a refusal is recorded,
      // and a standing leg that failed on availability is owed a refill.
      let walkState = advanceFallbackWalk(
        opts.__fallbackWalk?.state ?? INITIAL_FALLBACK_WALK,
        opts.__fallbackWalk?.role,
        error,
      );

      if (walks && effectiveFallbacks.length) {
        let lastFallbackError: Error = error;
        // How the walk ended: a leg served the stream; a leg failed after it
        // delivered output (its error part already reached the consumer); or
        // no leg delivered anything.
        let outcome: 'served' | 'failed-after-output' | 'exhausted' = 'exhausted';
        let fallbackFinishReason: StreamFinishReason = 'stop';
        let attempt = 0;

        for (const fb of effectiveFallbacks) {
          // No leg starts once the caller's signal has aborted.
          if (opts.abortSignal?.aborted) break;
          attempt += 1;
          // A refill runs only while a standing leg is owed one, and the
          // policy chain's Claude legs are passed over after a refusal.
          const gate = gateFallbackEntry(walkState, fb);
          if (!gate.run) {
            logLegSkip(fb, gate.reason);
            continue;
          }
          walkState = gate.state;
          // Skip fallback entries with an open breaker: the recursive
          // streamText below would short-circuit at the same isOpen()
          // check, but the outer skip avoids the extra log noise +
          // recursion overhead.
          // The breaker read is the provider the leg is sent to: an
          // `openrouter:` id under another provider goes to OpenRouter.
          const legProvider = fallbackEntrySentAs(fb).provider;
          if (globalLLMProviderHealth.isOpen(legProvider)) {
            fallbackLogger.info('streaming provider fallback skipped (circuit open)', {
              event: 'fallback_skipped_circuit_open',
              api: 'streamText',
              primaryProvider: recordedProviderId,
              fallbackProvider: legProvider,
              fallbackModel: fb.model,
              attempt,
            });
            // An open breaker is an availability failure: a standing leg is
            // owed a refill.
            walkState = advanceFallbackWalk(walkState, fb.walkRole, undefined);
            continue;
          }
          // Whether this leg handed the consumer a part, and the error it
          // reported before it did.
          let legDelivered = false;
          let legError: Error | undefined;
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
              // Legs run as named: no router re-picks the model, and the
              // call's resolved tier travels with them.
              router: undefined,
              policyTier: walkTier,
              // The walk's state before this leg, and its role.
              __fallbackWalk: { state: walkState, role: fb.walkRole },
              // Per-hop effort, cache and output budget over the ORIGINAL
              // call, shared with generateText's walker (see
              // fallbackHopOverrides). Canonical chain legs pin `cache: false`
              // so a rescue hop pays no cache-write premium its one-shot
              // traffic never reads back; entries without an override take
              // the call level.
              ...fallbackHopOverrides(opts, fb),
              // Stamp the leg's observer events with its hop depth (see
              // LlmUsageEvent.fallbackDepth).
              __fallbackDepth: (opts.__fallbackDepth ?? 0) + 1,
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
              // The leg reports the hops of its own walk, as generateText's
              // legs do, so every hop is reported once.
            });
            // The leg meters its own attempt from here on, served or failed.
            fallbackLegRan = true;

            // A leg reports its failure as an error part. Before the leg
            // delivered anything, that part is held back and the walk moves
            // on, so the consumer sees one terminal error at most. After
            // output it is the stream's terminal error; nothing is replayed.
            try {
              for await (const fbPart of fallbackResult.fullStream) {
                if (fbPart.type === 'error' && !legDelivered) {
                  legError = fbPart.error;
                  continue;
                }
                legDelivered = true;
                // An error part after the leg's output ends this stream too;
                // marked before it is handed over, so a consumer that stops
                // reading at it finds the stream failed.
                if (fbPart.type === 'error') metricStatus = 'error';
                parts.push(fbPart);
                yield fbPart;
              }
            } finally {
              // This call's result usage covers every attempt, a leg the
              // consumer abandoned mid-stream included: closing the loop
              // above ran the leg's finally, which settled its usage and its
              // text. The leg's text is what the consumer received from it,
              // served, failed after output or abandoned.
              addTokenUsage(usage, await fallbackResult.usage);
              finalText = await fallbackResult.text;
            }

            if (legError) {
              lastFallbackError = legError;
              // The leg ran tools before it failed, or it walked every entry
              // after it: walking on would run the tools again or repeat the
              // entries it already walked. An abort is the caller's stop.
              if (
                toolsRanBefore(legError) ||
                chainWalkedBefore(legError) ||
                (legError as { type?: unknown }).type === 'abort' ||
                // The call's budget refused the leg, or a hook stopped it:
                // every later leg would be stopped the same way.
                isCallerStop(legError) ||
                // The caller's signal ended the leg, whatever its reason.
                opts.abortSignal?.aborted === true
              ) {
                break;
              }
              walkState = advanceFallbackWalk(walkState, fb.walkRole, legError);
              continue;
            }

            // Adopt the leg's response identity: the leg is the run that
            // answered.
            const fbResponseModel = await fallbackResult.responseModel;
            if (fbResponseModel) lastResponseModelId = fbResponseModel;
            const fbServiceTier = await fallbackResult.serviceTier;
            if (fbServiceTier) lastServiceTier = fbServiceTier;

            const fbToolCalls = await fallbackResult.toolCalls;
            allToolCalls.push(...fbToolCalls);
            // The recursive leg computed its own reason; the stream was
            // drained above, so the promise is already settled.
            fallbackFinishReason = await fallbackResult.finishReason;
            if (opts.cacheDiagnostics) {
              // Adopt the leg's verdict + thread key. Resolving with the
              // child promises locks ours to follow them; the outer
              // finally's later settle is then a no-op.
              resolveCacheDiagnostics!(fallbackResult.cacheDiagnostics);
              resolveProviderMessageId!(fallbackResult.providerMessageId);
            }

            if (fallbackFinishReason === 'error') {
              outcome = 'failed-after-output';
              fallbackLogger.warn('streaming provider fallback failed after output', {
                event: 'fallback_failed_after_output',
                api: 'streamText',
                primaryProvider: recordedProviderId,
                fallbackProvider: fb.provider,
                fallbackModel: fb.model,
                attempt,
              });
            } else {
              outcome = 'served';
              fallbackLogger.info('streaming provider fallback succeeded', {
                event: 'fallback_succeeded',
                api: 'streamText',
                primaryProvider: recordedProviderId,
                fallbackProvider: fb.provider,
                fallbackModel: fb.model,
                attempt,
              });
            }
            break;
          } catch (fbErr: any) {
            lastFallbackError = fbErr instanceof Error ? fbErr : new Error(String(fbErr));
            if (legDelivered) {
              // Output already reached the consumer: this error ends the
              // stream and nothing is replayed.
              outcome = 'failed-after-output';
              metricStatus = 'error';
              const errorPart: StreamPart = { type: 'error', error: lastFallbackError };
              parts.push(errorPart);
              yield errorPart;
              break;
            }
            if (
              toolsRanBefore(lastFallbackError) ||
              chainWalkedBefore(lastFallbackError) ||
              isCallerStop(lastFallbackError) ||
              opts.abortSignal?.aborted === true
            ) {
              break;
            }
            walkState = advanceFallbackWalk(walkState, fb.walkRole, lastFallbackError);
          }
        }

        if (outcome === 'served') {
          resolveText!(finalText);
          resolveUsage!(usage); resolveResponseModel!(lastResponseModelId); resolveServiceTier!(lastServiceTier);
          resolveToolCalls!(allToolCalls);
          resolveFinishReason!(fallbackFinishReason);
        } else if (outcome === 'failed-after-output') {
          metricStatus = 'error';
          resolveText!(finalText);
          resolveUsage!(usage); resolveResponseModel!(lastResponseModelId); resolveServiceTier!(lastServiceTier);
          resolveToolCalls!(allToolCalls);
          resolveFinishReason!('error');
        } else {
          // The caller's signal ended the walk: the stream ends on the
          // signal's reason, and no exhausted chain is reported.
          const walkSignal = opts.abortSignal;
          const walkStoppedBy = walkSignal?.aborted ? abortReasonError(walkSignal) : undefined;
          if (!walkStoppedBy) {
            fallbackLogger.warn('streaming provider fallbacks exhausted', {
              event: 'fallback_exhausted',
              api: 'streamText',
              primaryProvider: recordedProviderId,
              attempts: attempt,
              errorType: lastFallbackError.name,
              errorMessage: lastFallbackError.message.slice(0, 200),
            });
          }
          metricStatus = 'error';
          // Marked so a walker that called this one as a leg stops instead of
          // walking the same remaining entries again.
          const terminal = walkStoppedBy ?? (markChainWalked(lastFallbackError) as Error);
          const errorPart: StreamPart = { type: 'error', error: terminal };
          parts.push(errorPart);
          yield errorPart;
          resolveText!(finalText);
          resolveUsage!(usage); resolveResponseModel!(lastResponseModelId); resolveServiceTier!(lastServiceTier);
          resolveToolCalls!(allToolCalls);
          resolveFinishReason!('error');
        }
      } else {
        metricStatus = 'error';
        // Marked so a walker that called this one as a leg does not run the
        // tools again on another provider. The signal's reason is the
        // caller's own object and stays as it was given.
        const terminal = (shimRanTool && !stoppedBy ? markToolsRan(error) : error) as Error;
        const part: StreamPart = { type: 'error', error: terminal };
        parts.push(part);
        yield part;
        resolveText!(stepTextSoFar || finalText);
        resolveUsage!(usage); resolveResponseModel!(lastResponseModelId); resolveServiceTier!(lastServiceTier);
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
      resolveText!(stepTextSoFar || finalText);
      resolveUsage!(usage); resolveResponseModel!(lastResponseModelId); resolveServiceTier!(lastServiceTier);
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
          ...(opts.serviceTier !== undefined ? { requestServiceTier: opts.serviceTier } : {}),
          ...(lastServiceTier !== undefined ? { responseServiceTier: lastServiceTier } : {}),
        });
      }
      rootSpan?.end();
      try {
        await recordAgentOSUsageLazy({
          providerId: recordedProviderId,
          modelId: recordedModelId,
          // A fallback leg recorded its own usage; this row is this attempt's.
          usage: fallbackLegRan && attemptUsage ? attemptUsage : usage,
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
        usage: toTurnMetricUsage(fallbackLegRan && attemptUsage ? attemptUsage : usage),
      });
      // 2026-05-29 — fire the global LLM usage observer with the
      // finalized stream usage. Same hook generateText fires; hosts
      // (wilds-ai foundation_usage_events, billing dashboards) get
      // one consistent stream of events whether the caller used
      // generateText or streamText. No-op when no observer is
      // registered.
      // One usage event per attempt:
      // - a fallback leg ran: every leg already fired its own correctly
      //   attributed event — never fire the outer aggregate. This attempt
      //   gets its own event only when it was billed: providers report
      //   usage on the final chunk, so a thrown-over attempt has usually
      //   accrued none, but a refusal carries its usage on the error.
      // - error terminals: fire ONLY when the stream accrued real billable
      //   usage (tokens metered before a later failure) — suppressing those
      //   left real spend unmetered; zero-usage failures stay silent.
      const accruedBillableUsage = hasBillableUsage(usage);
      if (fallbackLegRan && attemptUsage && hasBillableUsage(attemptUsage)) {
        fireLlmUsageObserver({
          provider: recordedProviderId ?? '',
          model: recordedModelId ?? '',
          usage: attemptUsage,
          source: opts.source,
          ...(opts.__fallbackDepth ? { fallbackDepth: opts.__fallbackDepth } : {}),
          finishReason: 'error',
          surface: 'streamText',
          durationMs: Date.now() - startedAt,
        });
      }
      if (!fallbackLegRan && (metricStatus !== 'error' || accruedBillableUsage)) {
        fireLlmUsageObserver({
          provider: recordedProviderId ?? '',
          model: recordedModelId ?? '',
          ...(lastResponseModelId !== undefined ? { responseModel: lastResponseModelId } : {}),
          usage,
          source: opts.source,
          ...(opts.__fallbackDepth ? { fallbackDepth: opts.__fallbackDepth } : {}),
          finishReason:
            metricStatus === 'error'
              ? 'error'
              : allToolCalls.length > 0 && !finalText
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
    serviceTier: serviceTierPromise,
    toolCalls: toolCallsPromise,
    provider: providerPromise,
    model: modelPromise,
    finishReason: finishReasonPromise,
    cacheDiagnostics: cacheDiagnosticsPromise,
    providerMessageId: providerMessageIdPromise,
  };
}
