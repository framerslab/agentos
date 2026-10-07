/**
 * @file completionGateway.ts
 * One model layer for a GMI turn. `resolve()` picks the hop (router, primary,
 * policy-aware fallback chain) and initialises its provider BEFORE the GMI
 * builds a prompt, so the prompt is budgeted for the model that will serve it.
 * `stream()` makes ONE provider attempt on a resolved hop with a delivery
 * boundary: a failure before the first content chunk is reported through
 * `outcome` and nothing is yielded, so the GMI can rebuild the prompt for the
 * next hop. The GMI drives the hop loop.
 */
import type { ZodType } from 'zod';
import type { ChatMessage, ModelCompletionOptions, ModelCompletionResponse } from '../../core/llm/providers/IProvider.js';
import type { AIModelProviderManager } from '../../core/llm/providers/AIModelProviderManager.js';
import type { ITool } from '../../core/tools/ITool.js';
import type { IModelRouter, ModelRouteParams } from '../../core/llm/routing/IModelRouter.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';
import { resolveModelOption, resolveProvider, createProviderManager } from '../model.js';
import {
  buildPolicyAwareFallbackChain,
  fallbackHopOverrides,
  isRetryableError,
  type FallbackProviderEntry,
  type GenerateTextOptions,
} from '../generateText.js';
import { hostPolicyToRouteParams, mergeRequiredCapabilities, type HostLLMPolicy } from './hostPolicy.js';

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

export type CompletionOutcome =
  | { kind: 'delivered' }
  | { kind: 'hopFailed'; error: Error; retryable: boolean }
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

  function stream(): CompletionAttempt {
    throw new Error('CompletionGateway.stream lands in the next task');
  }

  return { resolve, stream };
}
