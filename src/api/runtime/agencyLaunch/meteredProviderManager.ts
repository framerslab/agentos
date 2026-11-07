/**
 * @file meteredProviderManager.ts
 * Providers that check a spend budget before each completion request and charge each answer: the provider a GMI's
 * metaprompts and self-reflection reach through `gmi()`'s provider manager, and the provider manager of a
 * runtime seat of a launched team, through which every one of that seat's completion calls goes.
 */
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager.js';
import type { ChatMessage, IProvider, ModelCompletionOptions, ModelCompletionResponse, ModelUsage } from '../../../core/llm/providers/IProvider.js';
import { costOfUsageUSD, holdCall, type CallHold, type HelperCall, type SpendBudget } from '../spendBudget.js';
import { withMembers } from '../withMembers.js';

/** The tokens a usage report counts: its total, or its prompt and completion tokens when it names no total. */
function tokensOf(usage: ModelUsage): number {
  return usage.totalTokens > 0 ? usage.totalTokens : (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
}

/**
 * The usage a thrown failure reports as billed (`details.usage`, as OpenAIProvider and OpenRouterProvider attach it to
 * a failure before any output), when it is a usage report.
 */
function billedUsageOf(error: unknown): ModelUsage | undefined {
  const usage = (error as { details?: { usage?: unknown } } | null | undefined)?.details?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const { promptTokens, completionTokens, totalTokens } = usage as Record<string, unknown>;
  return [promptTokens, completionTokens, totalTokens].some((n) => typeof n === 'number' && Number.isFinite(n)) ? (usage as ModelUsage) : undefined;
}

/**
 * `provider` with a budget check before each completion request and a charge after each answer. A refusal is thrown
 * before the request: `generateCompletion` rejects, and `generateCompletionStream` throws on its first read. A stream
 * is charged once, when it ends or fails, with the last usage it carried (an error chunk's, for a billed failed
 * attempt), else the billed usage its thrown failure reports; an unstreamed call that throws is charged that usage.
 * On a budget with a spend meter each request is held in the meter before it is sent ({@link holdCall}): its largest
 * cost reserved under an operation id of its own, which spans the provider's retries of it and which the provider
 * sends in its operation id header, and settled by how it ended (consumed at its usage, released when it never left or
 * the provider refused it with a 4xx before any output, otherwise deferred until a reconcile decides from evidence). A call whose stop had already aborted, or aborts while its reservation is made, sends
 * nothing and holds nothing: the stream ends with the terminal abort chunk the provider contract names (`IProvider`)
 * and the unstreamed call rejects, with an `AbortError` or the signal's reason, as the gmi() gateway refuses such an
 * attempt, since a provider that does not pass the signal to fetch would send it and be billed. Every other member
 * runs on `provider`.
 *
 * @param provider - The provider to wrap.
 * @param budget - The budget each call is checked against and charged to.
 * @param what - What the calls are, in the budget's records (`gmi.metaprompt`, `launch.seat`).
 * @param onUsage - Receives each charged usage report (a seat's own totals).
 */
export function meteredProvider(provider: IProvider, budget: SpendBudget, what: string, onUsage?: (usage: ModelUsage) => void): IProvider {
  /** The request as the budget checks it, and as a budget with a meter holds it, before it is sent. */
  const hold = (modelId: string, messages: ChatMessage[], options: ModelCompletionOptions): Promise<CallHold> => {
    const call: HelperCall = {
      what,
      route: { providerId: provider.providerId, modelId },
      messages,
      tools: options.tools,
      maxTokens: options.maxTokens,
      options,
      onAttempt: options.onAttempt,
      abortSignal: options.abortSignal,
    };
    return holdCall(budget, call);
  };
  /**
   * `options` with the hold's attempt report, which a hold in a meter reads on its way to the caller's own, and the
   * operation id its reservation is under, which the provider sends in its operation id header.
   */
  const sentWith = (options: ModelCompletionOptions, held: CallHold): ModelCompletionOptions => {
    const { onAttempt, operationId } = held.providerOptions;
    return (onAttempt && onAttempt !== options.onAttempt) || operationId !== undefined ? { ...options, ...held.providerOptions } : options;
  };
  const charge = (modelId: string, usage: ModelUsage | undefined): void => {
    if (!usage) return;
    budget.record(costOfUsageUSD(provider.providerId, modelId, usage), tokensOf(usage), what);
    onUsage?.(usage);
  };
  /** Whether the call's stop had aborted before it began. */
  const stopped = (options: ModelCompletionOptions): boolean => options.abortSignal?.aborted === true;
  /** The provider contract's end of an aborted stream, in the gateway's abortChunk shape: nothing is sent or charged. */
  const abortChunk = (modelId: string): ModelCompletionResponse => ({
    id: `metered-abort-${provider.providerId}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    modelId,
    choices: [],
    isFinal: true,
    error: { message: 'Stream aborted by caller', type: 'abort' },
  });
  async function* stream(modelId: string, messages: ChatMessage[], options: ModelCompletionOptions): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    if (stopped(options)) {
      yield abortChunk(modelId);
      return;
    }
    // Runs on the first read, before the provider is asked for anything.
    let held: CallHold;
    try {
      held = await hold(modelId, messages, options);
    } catch (error) {
      // Stopped while the reservation was made, which is freed: nothing is sent, and the stream ends as a stopped one.
      if (!stopped(options)) throw error;
      yield abortChunk(modelId);
      return;
    }
    let last: ModelUsage | undefined;
    let thrown: ModelUsage | undefined;
    try {
      for await (const chunk of held.stream(provider.generateCompletionStream(modelId, messages, sentWith(options, held)))) {
        if (chunk.usage) last = chunk.usage;
        yield chunk;
      }
    } catch (error) {
      // A failure before any output can be billed: the provider puts the bill on the error.
      thrown = billedUsageOf(error);
      throw error;
    } finally {
      charge(modelId, last ?? thrown);
    }
  }
  return withMembers(provider, {
    generateCompletion: async (modelId: string, messages: ChatMessage[], options: ModelCompletionOptions): Promise<ModelCompletionResponse> => {
      if (stopped(options)) throw Object.assign(new Error('The request was aborted before it was sent.'), { name: 'AbortError' });
      const held = await hold(modelId, messages, options);
      let response: ModelCompletionResponse;
      try {
        response = await held.run(() => provider.generateCompletion(modelId, messages, sentWith(options, held)));
      } catch (error) {
        charge(modelId, billedUsageOf(error));
        throw error;
      }
      charge(modelId, response.usage);
      return response;
    },
    generateCompletionStream: stream,
  });
}

/**
 * A view of a provider manager whose providers check `budget` before each completion request and charge each answer
 * ({@link meteredProvider}, the calls recorded as `launch.seat`); every other member runs on `base`. A runtime seat's
 * GMI makes every completion call through it, its steps, metaprompts and self-reflection alike, so each is refused
 * before its request once the launch's budget is spent, and a step whose turn has already stopped is not sent. On a
 * budget with a spend meter each of those calls is held in the meter until it ends. Embeddings are not counted.
 *
 * @param base - The runtime's provider manager.
 * @param budget - The launch's budget.
 * @returns The view, typed as the manager it wraps.
 */
export function meteredProviderManager(base: AIModelProviderManager, budget: SpendBudget): AIModelProviderManager {
  const metered = (provider: IProvider | undefined): IProvider | undefined => (provider ? meteredProvider(provider, budget, 'launch.seat') : undefined);
  return withMembers(base, {
    getProvider: (providerId: string) => metered(base.getProvider(providerId)),
    getDefaultProvider: () => metered(base.getDefaultProvider()),
    getProviderForModel: (modelId: string) => metered(base.getProviderForModel(modelId)),
  });
}
