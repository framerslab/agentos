/**
 * @fileoverview The model id a provider adapter writes on a completion response or a stream chunk, with the mark that
 * says when the id is the request's and not the answer's.
 */

import type { ModelCompletionResponse } from './IProvider';

/**
 * The model fields of a response: the model the answer named, or, when it named none, the model the request named,
 * marked `modelIdSource: 'requested'`.
 *
 * @param answered - The model the provider's answer names, as it arrived; anything but a non-empty string is none.
 * @param requested - The model the request named.
 * @returns `modelId`, and `modelIdSource` when the id is the request's.
 */
export function responseModel(
  answered: unknown,
  requested: string,
): Pick<ModelCompletionResponse, 'modelId' | 'modelIdSource'> {
  return typeof answered === 'string' && answered !== ''
    ? { modelId: answered }
    : { modelId: requested, modelIdSource: 'requested' };
}

/**
 * The model fields of a response whose adapter does not read the model the answer names: the model the request named,
 * marked `modelIdSource: 'requested'`.
 *
 * @param requested - The model the request named, or the provider's default model when the request named none.
 * @returns `modelId` and `modelIdSource: 'requested'`.
 */
export function requestedModel(requested: string): Pick<ModelCompletionResponse, 'modelId' | 'modelIdSource'> {
  return { modelId: requested, modelIdSource: 'requested' };
}
