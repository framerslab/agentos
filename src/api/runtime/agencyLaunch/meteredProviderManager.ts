/**
 * @file meteredProviderManager.ts
 * Providers that check a spend budget before each completion request and charge each answer: the provider a GMI's
 * metaprompts and self-reflection reach through `gmi()`'s provider manager, and the provider manager of a
 * runtime seat of a launched team, through which every one of that seat's completion calls goes.
 */
import type { ChatMessage, IProvider, ModelCompletionOptions, ModelCompletionResponse, ModelUsage } from '../../../core/llm/providers/IProvider.js';
import { assertCallWithinBudget, costOfUsageUSD, promptCharsOf, type SpendBudget } from '../spendBudget.js';
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
 * A call whose stop had already aborted sends nothing: the stream ends with the terminal abort chunk the provider
 * contract names (`IProvider`) and the unstreamed call rejects with an `AbortError`, as the gmi() gateway refuses
 * such an attempt, since a provider that does not pass the signal to fetch would send it and be billed. Every other
 * member runs on `provider`.
 *
 * @param provider - The provider to wrap.
 * @param budget - The budget each call is checked against and charged to.
 * @param what - What the calls are, in the budget's records (`gmi.metaprompt`, `launch.seat`).
 * @param onUsage - Receives each charged usage report (a seat's own totals).
 */
export function meteredProvider(provider: IProvider, budget: SpendBudget, what: string, onUsage?: (usage: ModelUsage) => void): IProvider {
  const check = (modelId: string, messages: ChatMessage[], options: ModelCompletionOptions): void =>
    assertCallWithinBudget(budget, { providerId: provider.providerId, modelId }, promptCharsOf(messages, undefined, options.tools), options.maxTokens, what);
  const charge = (modelId: string, usage: ModelUsage | undefined): void => {
    if (!usage) return;
    budget.record(costOfUsageUSD(provider.providerId, modelId, usage), tokensOf(usage), what);
    onUsage?.(usage);
  };
  /** Whether the call's stop had aborted before it began. */
  const stopped = (options: ModelCompletionOptions): boolean => options.abortSignal?.aborted === true;
  async function* stream(modelId: string, messages: ChatMessage[], options: ModelCompletionOptions): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    if (stopped(options)) {
      // The provider contract's end of an aborted stream, in the gateway's abortChunk shape: nothing is sent or charged.
      yield { id: `metered-abort-${provider.providerId}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), modelId, choices: [], isFinal: true, error: { message: 'Stream aborted by caller', type: 'abort' } };
      return;
    }
    // Runs on the first read, before the provider is asked for anything.
    check(modelId, messages, options);
    let last: ModelUsage | undefined;
    let thrown: ModelUsage | undefined;
    try {
      for await (const chunk of provider.generateCompletionStream(modelId, messages, options)) {
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
      check(modelId, messages, options);
      let response: ModelCompletionResponse;
      try {
        response = await provider.generateCompletion(modelId, messages, options);
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
