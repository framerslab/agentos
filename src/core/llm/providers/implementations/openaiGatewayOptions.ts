/**
 * @fileoverview Options the providers built on {@link OpenAIProvider} remove
 * before they send to their own OpenAI-compatible endpoint.
 */
import type { ModelCompletionOptions } from '../IProvider';

/**
 * A call's options without `store`, OpenAI's field for keeping a request's
 * output. Groq, xAI, Together, Mistral, LiteLLM and MiniMax send through the
 * OpenAI transport to their own endpoint, and such an endpoint can refuse a
 * field outside its schema: Mistral's chat completion request lists no `store`
 * and sets `additionalProperties: false` (https://docs.mistral.ai/openapi.yaml,
 * `ChatCompletionRequest`, read 2026-11-10), answering "Extra inputs are not
 * permitted". A `store` key in `customModelParams` still reaches the endpoint.
 *
 * @param options - The call's options.
 * @returns The same options when they carry no `store`; otherwise a copy without it.
 */
export function withoutOpenAiStore(options: ModelCompletionOptions): ModelCompletionOptions {
  if (options.store === undefined) return options;
  const { store: _store, ...rest } = options;
  return rest;
}
