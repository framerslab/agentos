/**
 * @file completionGateway.ts
 * One model layer for a GMI turn. `resolve()` picks the hop (router, primary,
 * policy-aware fallback chain) and initialises its provider BEFORE the GMI
 * builds a prompt, so the prompt is budgeted for the model that will serve it.
 * `stream()` makes ONE provider attempt on a resolved hop with a delivery
 * boundary: a failure before the first content chunk is reported through
 * `outcome`, with the usage the provider billed for it, and nothing is
 * yielded, so the GMI can rebuild the prompt for the next hop. The GMI drives
 * the hop loop.
 */
import type { ZodType } from 'zod';
import type { ChatMessage, ModelCompletionOptions, ModelCompletionResponse, ModelUsage } from '../../core/llm/providers/IProvider.js';
import type { AIModelProviderManager } from '../../core/llm/providers/AIModelProviderManager.js';
import type { ITool } from '../../core/tools/ITool.js';
import type { IModelRouter, ModelRouteParams } from '../../core/llm/routing/IModelRouter.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';
import { lowerZodToJsonSchema } from '../../orchestration/compiler/SchemaLowering.js';
import { resolveModelOption, resolveProvider, createProviderManager } from '../model.js';
import {
  buildPolicyAwareFallbackChain,
  fallbackHopOverrides,
  isContentPolicyRefusal,
  isRetryableError,
  usageOfError,
  type FallbackProviderEntry,
  type GenerateTextOptions,
} from '../generateText.js';
import { hostPolicyToRouteParams, mergeRequiredCapabilities, type HostLLMPolicy } from './hostPolicy.js';
import { buildResponseFormatForProvider, responseFormatCarriesSchema } from './responseFormatForProvider.js';
import { buildSchemaInstructionText } from './structuredReply.js';

/** What a turn asks the gateway for. Unset fields take the gateway's defaults. */
export interface CompletionRoute {
  modelId?: string;
  providerId?: string;
  /** The turn's messages so far; the last user message is the router's task hint. */
  messages: ChatMessage[];
  tools?: ITool[] | Array<Record<string, unknown>>;
  router?: IModelRouter;
  routerParams?: Partial<ModelRouteParams>;
  hostPolicy?: HostLLMPolicy;
  policyTier?: GenerateTextOptions['policyTier'];
  /** Caller chain. Undefined builds the policy-aware chain from the environment; an empty array disables fallback. */
  fallbackProviders?: FallbackProviderEntry[];
  /** Credentials for the primary only; fallback hops read the environment, as streamText's walk does. */
  apiKey?: string;
  baseUrl?: string;
  /** The call's own effort, cache and output budget, from which each fallback hop's overrides are derived. */
  callOptions?: Pick<GenerateTextOptions, 'maxTokens' | 'effort' | 'cache'>;
  /** Called when the turn moves to a hop after the primary. */
  onFallback?: (info: { from: string; to: string; hop: number; error: Error }) => void;
  /** Called for every hop that could not start (initialisation failure or open circuit). */
  onHopFailure?: (info: { providerId: string; hop: number; error: Error }) => void;
}

/** One entry of the hop list a route resolves to. */
export interface CompletionHop {
  provider: string;
  model?: string;
  entry?: FallbackProviderEntry;
}

/** A hop that is ready to serve: its provider is initialised and its window is known. */
export interface CompletionResolution {
  providerId: string;
  modelId: string;
  hop: number;
  maxContextTokens: number;
  capabilities: string[];
  /** Same strings as ModelTargetInfo.toolSupport.format. */
  toolFormat: 'openai_functions' | 'anthropic_tools' | 'google_function_calling';
  providerManager: AIModelProviderManager;
  /** Per-hop effort, cache and output budget from `fallbackHopOverrides`; merged over the caller's options. */
  optionOverrides: Partial<ModelCompletionOptions>;
  /** The hop list fixed by the route's first `resolve()`; later calls walk it. */
  readonly chain: ReadonlyArray<CompletionHop>;
}

/**
 * How an attempt ended. A `hopFailed` attempt carries `usage` when the
 * provider billed it and reported the bill (a refused turn, an error chunk
 * with usage); the GMI adds it to the turn's usage.
 */
export type CompletionOutcome =
  | { kind: 'delivered' }
  | { kind: 'hopFailed'; error: Error; retryable: boolean; usage?: ModelUsage }
  | { kind: 'abandoned' };

/** One provider attempt. `outcome` settles when iteration ends (a never-iterated attempt never calls the provider). */
export interface CompletionAttempt extends AsyncIterable<ModelCompletionResponse> {
  outcome: Promise<CompletionOutcome>;
}

export interface CompletionGateway {
  resolve(route: CompletionRoute, after?: CompletionResolution): Promise<CompletionResolution | null>;
  stream(
    resolution: CompletionResolution,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
    responseSchema?: ZodType,
    schemaName?: string,
    /**
     * True when `messages` already carry the schema's instructions (a structured
     * reply puts its own in the system prompt): a hop whose payload carries no
     * schema then gets no second copy.
     */
    schemaInPrompt?: boolean,
  ): CompletionAttempt;
}

/** The tool format a provider expects; the same mapping as GMI.determineToolFormat. */
export function toolFormatFor(providerId: string): CompletionResolution['toolFormat'] {
  const pid = providerId.toLowerCase();
  if (pid.includes('anthropic')) return 'anthropic_tools';
  if (pid.includes('google') || pid.includes('gemini')) return 'google_function_calling';
  return 'openai_functions';
}

function definedOnly<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The text of the last user message, its text parts joined when the content is multimodal. */
function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((part) => {
          const { type, text } = part as { type?: unknown; text?: unknown };
          return type === 'text' && typeof text === 'string' ? text : '';
        })
        .filter((text) => text.length > 0)
        .join('\n');
    }
    return '';
  }
  return '';
}

function toolNamesOf(tools: CompletionRoute['tools']): string[] {
  return (tools ?? [])
    .map((t) => (t as { name?: string }).name ?? (t as { function?: { name?: string } }).function?.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

/** The error a hop with an open circuit fails with, worded as streamText words it. */
function circuitOpenError(providerId: string): Error {
  const stats = globalLLMProviderHealth.getStats(providerId);
  return Object.assign(
    new Error(`[503] Provider '${providerId}' circuit open; cooldown ${stats?.cooldownRemainingMs ?? 0}ms`),
    { name: 'LLMProviderCircuitOpenError', httpStatus: 503 },
  );
}

/** Primary selection, the same as streamText's: explicit model and provider, then the router when one is set. */
async function selectPrimary(route: CompletionRoute): Promise<{ provider: string; model: string }> {
  let { providerId, modelId } = resolveModelOption({ provider: route.providerId, model: route.modelId }, 'text');
  if (route.router) {
    try {
      const toolNames = toolNamesOf(route.tools);
      const hostParams = hostPolicyToRouteParams(route.hostPolicy);
      const params = {
        taskHint: route.routerParams?.taskHint ?? lastUserText(route.messages),
        ...hostParams,
        ...route.routerParams,
        optimizationPreference: route.routerParams?.optimizationPreference ?? hostParams.optimizationPreference ?? 'balanced',
        requiredCapabilities: mergeRequiredCapabilities(
          hostParams.requiredCapabilities,
          route.routerParams?.requiredCapabilities,
          toolNames.length > 0 ? ['function_calling'] : undefined,
        ),
        preferredProviderIds: route.routerParams?.preferredProviderIds ?? hostParams.preferredProviderIds,
        policyTier: route.routerParams?.policyTier ?? route.policyTier ?? hostParams.policyTier,
      } as ModelRouteParams;
      const routed = await route.router.selectModel(params, undefined);
      if (routed) {
        providerId = routed.modelInfo?.providerId ?? providerId;
        modelId = routed.modelId;
      }
    } catch (routerErr) {
      console.warn('[agentos] Model router error, falling back to standard resolution:', routerErr);
    }
  }
  return { provider: providerId, model: modelId };
}

type InBandError = NonNullable<ModelCompletionResponse['error']>;

/**
 * The HTTP status an in-band error names in a numeric code (Gemini's stream
 * errors carry `code: 500` beside `type: 'INTERNAL'`), read as streamText reads
 * it: a 401 or 403 inside a stream describes an upstream attempt, not this
 * key, so it is not taken as a status.
 */
function statusOfChunkCode(code: unknown): number | undefined {
  return typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599 && code !== 401 && code !== 403
    ? code
    : undefined;
}

/** An in-band provider error as an Error that `isRetryableError` and the health registry can judge (type, code, HTTP status kept). */
function errorFromChunk(e: InBandError): Error {
  const status = statusOfChunkCode(e.code);
  return Object.assign(new Error(e.message), {
    name: 'ProviderStreamError',
    ...(e.type !== undefined ? { type: e.type } : {}),
    ...(e.code !== undefined ? { code: e.code } : {}),
    ...(status !== undefined ? { httpStatus: status } : {}),
    ...(e.details !== undefined ? { details: e.details } : {}),
  });
}

/**
 * The chunk that ends an attempt whose provider threw after content. It carries
 * the usage the error reports (`details.usage`, as a refused Claude turn reports
 * it), so the GMI counts what the failed step was billed.
 */
function terminalErrorChunk(resolution: CompletionResolution, error: Error): ModelCompletionResponse {
  const usage = asUsageReport(usageOfError(error));
  return {
    id: `gateway-error-${resolution.providerId}-${resolution.hop}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    modelId: resolution.modelId,
    choices: [],
    isFinal: true,
    ...(usage ? { usage } : {}),
    error: { message: error.message, type: (error as { type?: string }).type ?? 'provider_error', details: { terminal: true, providerId: resolution.providerId, hop: resolution.hop } },
  };
}

/** The chunk that ends an attempt the caller's signal stopped, in the shape the providers give theirs. */
function abortChunk(resolution: CompletionResolution): ModelCompletionResponse {
  return {
    id: `gateway-abort-${resolution.providerId}-${resolution.hop}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    modelId: resolution.modelId,
    choices: [],
    isFinal: true,
    error: { message: 'Stream aborted by caller', type: 'abort' },
  };
}

const ABORTED = Symbol('aborted');

/** The iterator's next result, or `ABORTED` once `signal` has aborted, whichever comes first. */
function nextUnlessAborted<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T> | typeof ABORTED> {
  const next = iterator.next();
  if (signal.aborted) {
    // Settled or not, the result is not read; a rejection is not left unhandled.
    void next.catch(() => undefined);
    return Promise.resolve(ABORTED);
  }
  return new Promise<IteratorResult<T> | typeof ABORTED>((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    next.then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The provider's chunks until `signal` aborts, then the abort chunk at once.
 * Anthropic, Gemini and Ollama read the signal only when a streamed event
 * arrives, so a request stalled before its first byte, or between two events,
 * would otherwise hold the turn (and a session's `close()`) until the
 * provider's own timeout. The provider's stream is ended in the background.
 */
async function* untilAborted(
  source: AsyncIterable<ModelCompletionResponse>,
  signal: AbortSignal,
  resolution: CompletionResolution,
): AsyncGenerator<ModelCompletionResponse, void, undefined> {
  const iterator = source[Symbol.asyncIterator]();
  let leftRunning = false;
  try {
    for (;;) {
      const next = await nextUnlessAborted(iterator, signal);
      if (next === ABORTED) {
        leftRunning = true;
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
        yield abortChunk(resolution);
        return;
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // As a for-await loop ends its source; not one still waiting on the network.
    if (!leftRunning) await iterator.return?.();
  }
}

/** Text, tool activity or a lifted schema answer: the first such chunk ends the buffering. */
function carriesContent(chunk: ModelCompletionResponse): boolean {
  if (chunk.responseTextDelta) return true;
  if (chunk.toolCallsDeltas && chunk.toolCallsDeltas.length > 0) return true;
  if ((chunk.choices?.[0]?.message?.tool_calls?.length ?? 0) > 0) return true;
  return (chunk as { structuredOutput?: unknown }).structuredOutput !== undefined;
}

/** A usage report as a provider gives it: an object with a numeric token count. */
function asUsageReport(value: unknown): ModelUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { promptTokens, completionTokens, totalTokens } = value as Record<string, unknown>;
  return [promptTokens, completionTokens, totalTokens].some((n) => typeof n === 'number' && Number.isFinite(n))
    ? (value as ModelUsage)
    : undefined;
}

/**
 * What the provider billed an attempt that failed before any content: the
 * error chunk's own usage, else the usage the error carries (`details.usage`,
 * as a refused Claude turn reports it), else the last usage among the chunks
 * buffered before the failure. Providers report the request's running total,
 * so the latest report is the attempt's whole bill.
 */
function billedUsage(buffered: ReadonlyArray<ModelCompletionResponse>, error: Error, chunkUsage?: ModelUsage): ModelUsage | undefined {
  const reported = asUsageReport(chunkUsage) ?? asUsageReport(usageOfError(error));
  if (reported) return reported;
  for (let i = buffered.length - 1; i >= 0; i--) {
    const usage = asUsageReport(buffered[i].usage);
    if (usage) return usage;
  }
  return undefined;
}

/**
 * The provider-native schema payload for this hop, built as session.send builds
 * it, and, when that payload carries no schema (no payload for the provider or
 * model, or a JSON mode without one), the schema instructions for the hop's
 * system prompt, in generateObject's words.
 */
function lowerForHop(
  resolution: CompletionResolution,
  schema: ZodType,
  schemaName: string,
): { responseFormat: Record<string, unknown> | undefined; toolName?: string; schemaInstruction?: string } {
  const jsonSchema = lowerZodToJsonSchema(schema);
  const responseFormat = buildResponseFormatForProvider({
    providerId: resolution.providerId,
    modelId: resolution.modelId,
    jsonSchema,
    effectiveSchema: schema,
    schemaName,
  });
  const marker = responseFormat as { _agentosUseToolForStructuredOutput?: boolean; tool?: { name?: string } } | undefined;
  return {
    responseFormat,
    toolName: marker?._agentosUseToolForStructuredOutput ? marker.tool?.name : undefined,
    ...(responseFormatCarriesSchema(responseFormat) ? {} : { schemaInstruction: buildSchemaInstructionText(jsonSchema, schemaName) }),
  };
}

/** `messages` with a system message of `text` after the leading system messages. */
function withSystemMessage(messages: ChatMessage[], text: string): ChatMessage[] {
  let at = 0;
  while (at < messages.length && messages[at].role === 'system') at += 1;
  return [...messages.slice(0, at), { role: 'system', content: text }, ...messages.slice(at)];
}

/** A streamed forced schema tool call becomes `structuredOutput` on the chunk, never a tool call the GMI would dispatch. */
function liftSchemaToolCall(chunk: ModelCompletionResponse, toolName: string): ModelCompletionResponse {
  const choice = chunk.choices?.[0];
  const calls = choice?.message?.tool_calls;
  if (!choice || !calls?.length) return chunk;
  const schemaCall = calls.find((call) => call.function?.name === toolName);
  if (!schemaCall) return chunk;
  let structuredOutput: unknown = schemaCall.function.arguments;
  if (typeof structuredOutput === 'string') {
    try {
      structuredOutput = JSON.parse(structuredOutput);
    } catch {
      // Kept as the raw string; the session reports the parse failure.
    }
  }
  const rest = calls.filter((call) => call !== schemaCall);
  return {
    ...chunk,
    choices: [{ ...choice, message: { ...choice.message, tool_calls: rest.length > 0 ? rest : undefined } }, ...chunk.choices.slice(1)],
    structuredOutput,
  } as ModelCompletionResponse & { structuredOutput: unknown };
}

export function createCompletionGateway(defaults: Partial<CompletionRoute> = {}): CompletionGateway {
  async function resolve(input: CompletionRoute, after?: CompletionResolution): Promise<CompletionResolution | null> {
    const route: CompletionRoute = { ...defaults, ...definedOnly(input as unknown as Record<string, unknown>) } as CompletionRoute;
    let chain: ReadonlyArray<CompletionHop>;
    if (after) {
      chain = after.chain;
    } else {
      const primary = await selectPrimary(route);
      const fallbacks = route.fallbackProviders ?? buildPolicyAwareFallbackChain(route.policyTier, primary.provider);
      chain = [{ provider: primary.provider, model: primary.model }, ...fallbacks.map((entry) => ({ provider: entry.provider, model: entry.model, entry }))];
    }
    let lastError: Error | undefined;
    for (let hop = after ? after.hop + 1 : 0; hop < chain.length; hop++) {
      const h = chain[hop];
      // Set once credentials resolve: the provider that serves the hop (resolveProvider
      // may serve anthropic through openrouter), whose circuit and health are the hop's.
      let servingProviderId: string | undefined;
      try {
        const parsed = hop === 0 && h.model ? { providerId: h.provider, modelId: h.model } : resolveModelOption({ provider: h.provider, model: h.model }, 'text');
        const resolved = hop === 0
          ? resolveProvider(parsed.providerId, parsed.modelId, { apiKey: route.apiKey, baseUrl: route.baseUrl })
          : resolveProvider(parsed.providerId, parsed.modelId);
        servingProviderId = resolved.providerId;
        if (globalLLMProviderHealth.isOpen(resolved.providerId)) throw circuitOpenError(resolved.providerId);
        const providerManager = await createProviderManager(resolved);
        const info = await providerManager.getModelInfo(resolved.modelId, resolved.providerId);
        const overrides = h.entry ? fallbackHopOverrides(route.callOptions ?? {}, h.entry) : undefined;
        const resolution: CompletionResolution = {
          providerId: resolved.providerId,
          modelId: resolved.modelId,
          hop,
          maxContextTokens: info?.contextWindowSize ?? 8192,
          capabilities: [...(info?.capabilities ?? [])],
          toolFormat: toolFormatFor(resolved.providerId),
          providerManager,
          optionOverrides: overrides
            ? (definedOnly({ maxTokens: overrides.maxTokens, effort: overrides.effort, cache: overrides.cache }) as Partial<ModelCompletionOptions>)
            : {},
          chain,
        };
        if (hop > 0) {
          route.onFallback?.({ from: after?.providerId ?? chain[0].provider, to: resolved.providerId, hop, error: lastError ?? new Error('the previous hop failed') });
        }
        return resolution;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // As in streamText: a configuration error (no credentials, unknown model)
        // says nothing about the provider's health, and an open circuit is the
        // registry's own verdict; neither is recorded.
        if (servingProviderId && lastError.name !== 'LLMProviderCircuitOpenError') {
          globalLLMProviderHealth.recordFailure(servingProviderId, lastError);
        }
        route.onHopFailure?.({ providerId: servingProviderId ?? h.provider, hop, error: lastError });
        // The primary's configuration error (no credentials, unknown provider) is the caller's to see.
        // A fallback leg that cannot start is skipped.
        if (hop === 0 && !isRetryableError(lastError)) throw lastError;
      }
    }
    return null;
  }

  function stream(
    resolution: CompletionResolution,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
    responseSchema?: ZodType,
    schemaName = 'response',
    schemaInPrompt = false,
  ): CompletionAttempt {
    let settle!: (outcome: CompletionOutcome) => void;
    const outcome = new Promise<CompletionOutcome>((resolveOutcome) => {
      settle = resolveOutcome;
    });
    let settled = false;
    const finish = (o: CompletionOutcome): void => {
      if (!settled) {
        settled = true;
        settle(o);
      }
    };
    const failed = (
      error: Error,
      usage: ModelUsage | undefined,
      retryable = isRetryableError(error) || isContentPolicyRefusal(error),
    ): CompletionOutcome => ({ kind: 'hopFailed', error, retryable, ...(usage ? { usage } : {}) });

    const structured = responseSchema ? lowerForHop(resolution, responseSchema, schemaName) : undefined;
    // A hop whose payload carries no schema gets it in its system prompt, unless the prompt carries it already.
    const hopMessages = structured?.schemaInstruction && !schemaInPrompt ? withSystemMessage(messages, structured.schemaInstruction) : messages;
    const callOptions: ModelCompletionOptions = {
      ...options,
      ...resolution.optionOverrides,
      ...(structured
        ? { responseFormat: structured.responseFormat as ModelCompletionOptions['responseFormat'], tools: undefined, toolChoice: undefined }
        : {}),
      stream: true,
    };

    async function* run(): AsyncGenerator<ModelCompletionResponse, void, undefined> {
      let delivered = false;
      let completed = false;
      const buffer: ModelCompletionResponse[] = [];
      try {
        const provider = resolution.providerManager.getProvider(resolution.providerId);
        if (!provider) {
          const error = Object.assign(new Error(`Provider '${resolution.providerId}' is not available.`), { name: 'ProviderInitializationError' });
          globalLLMProviderHealth.recordFailure(resolution.providerId, error);
          finish(failed(error, undefined));
          return;
        }
        const chunks = provider.generateCompletionStream(resolution.modelId, hopMessages, callOptions);
        const signal = callOptions.abortSignal;
        for await (const raw of signal ? untilAborted(chunks, signal, resolution) : chunks) {
          const chunk = structured?.toolName ? liftSchemaToolCall(raw, structured.toolName) : raw;
          if (chunk.error) {
            // An abort is the caller's own stop: it is never walked to another
            // hop and says nothing about the provider's health (as in streamText).
            const aborted = chunk.error.type === 'abort';
            const error = errorFromChunk(chunk.error);
            if (!aborted) globalLLMProviderHealth.recordFailure(resolution.providerId, error);
            if (!delivered) {
              const usage = billedUsage(buffer, error, chunk.usage);
              finish(aborted ? failed(error, usage, false) : failed(error, usage));
              return;
            }
            // After content the step ends with the provider's error chunk. The
            // outcome settles first, so a consumer that stops reading at the
            // error still finds the attempt delivered.
            completed = true;
            finish({ kind: 'delivered' });
            yield chunk;
            return;
          }
          if (!delivered) {
            buffer.push(chunk);
            if (carriesContent(chunk)) {
              delivered = true;
              yield* buffer.splice(0);
            }
            continue;
          }
          yield chunk;
        }
        // A normal end with no content chunk (an empty reply, a content-filter stop,
        // a usage-only trailing chunk) still reaches the GMI.
        if (!delivered) {
          delivered = true;
          yield* buffer.splice(0);
        }
        completed = true;
        globalLLMProviderHealth.recordSuccess(resolution.providerId);
        finish({ kind: 'delivered' });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        globalLLMProviderHealth.recordFailure(resolution.providerId, error);
        if (!delivered) {
          finish(failed(error, billedUsage(buffer, error)));
          return;
        }
        completed = true;
        finish({ kind: 'delivered' });
        yield terminalErrorChunk(resolution, error);
      } finally {
        // Only an attempt that neither delivered nor failed gets here unsettled:
        // the consumer stopped reading. `finish` ignores every later call.
        if (!completed) finish({ kind: 'abandoned' });
      }
    }

    return { [Symbol.asyncIterator]: () => run(), outcome };
  }

  return { resolve, stream };
}
