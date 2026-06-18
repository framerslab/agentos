// File: backend/agentos/core/llm/providers/implementations/OpenRouterProvider.ts
/**
 * @fileoverview Implements the IProvider interface for OpenRouter, a service that
 * provides access to a wide variety of LLMs from different providers through a unified API.
 * This provider handles routing requests to the specified models via OpenRouter.
 * @module backend/agentos/core/llm/providers/implementations/OpenRouterProvider
 * @implements {IProvider}
 */

import axios, { AxiosInstance, AxiosError, ResponseType } from 'axios';
import {
  IProvider,
  ChatMessage,
  ModelCompletionOptions,
  ModelCompletionResponse,
  ModelInfo,
  ModelUsage,
  ProviderEmbeddingOptions,
  ProviderEmbeddingResponse,
  ModelCompletionChoice,
} from '../IProvider';
import { OpenRouterProviderError } from '../errors/OpenRouterProviderError';
import { ApiKeyPool } from '../../../providers/ApiKeyPool.js';
import { createGMIErrorFromError, GMIErrorCode } from '../../../utils/errors.js'; // Corrected import path
import { clampMaxOutputTokens } from '../model-output-limits.js';

/**
 * Configuration specific to the OpenRouterProvider.
 */
export interface OpenRouterProviderConfig {
  apiKey: string;
  baseURL?: string;
  defaultModelId?: string;
  siteUrl?: string;
  appName?: string;
  requestTimeout?: number;
  streamRequestTimeout?: number;
}

interface OpenRouterChatChoice {
  index: number;
  message?: {
    role: ChatMessage['role'];
    content: string | null;
    tool_calls?: ChatMessage['tool_calls'];
  };
  delta?: {
    role?: ChatMessage['role'];
    content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: 'function';
      function?: { name?: string; arguments?: string; };
    }>;
  };
  finish_reason: string | null;
  logprobs?: unknown;
}

interface OpenRouterChatCompletionAPIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenRouterChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: number;
  };
}

interface OpenRouterEmbeddingAPIResponse {
  object: 'list';
  data: Array<{
    object: 'embedding';
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

interface OpenRouterModelAPIObject {
  id: string;
  name: string;
  description: string;
  pricing: {
    prompt: string;
    completion: string;
    request?: string;
    image?: string;
  };
  context_length: number | null;
  architecture?: {
    modality: string;
    tokenizer: string;
    instruct_type: string | null;
  };
  top_provider: {
    max_retries: number | null;
    is_fallback: boolean | null;
  };
}

interface OpenRouterListModelsAPIResponse {
  data: OpenRouterModelAPIObject[];
}

export class OpenRouterProvider implements IProvider {
  public readonly providerId: string = 'openrouter';
  public isInitialized: boolean = false;
  public defaultModelId?: string;

  // Corrected: Changed type of this.config to satisfy the Readonly<Required<...>> assignment by providing defaults
  private config!: Readonly<Required<Omit<OpenRouterProviderConfig, 'defaultModelId' | 'siteUrl' | 'appName' | 'baseURL' | 'requestTimeout' | 'streamRequestTimeout'>> & OpenRouterProviderConfig>;
  private keyPool: ApiKeyPool | null = null;
  private client!: AxiosInstance;
  private readonly availableModelsCache: Map<string, ModelInfo> = new Map();

  constructor() {}

  public async initialize(config: OpenRouterProviderConfig): Promise<void> {
    if (!config.apiKey) {
      throw new OpenRouterProviderError(
        'OpenRouter API key (apiKey) is required for initialization.',
        'INIT_FAILED_MISSING_API_KEY'
      );
    }
    // Corrected: Ensure all properties of Required<OpenRouterProviderConfig> are present
    // by providing defaults for optional fields before freezing.
    this.config = Object.freeze({
      apiKey: config.apiKey,
      baseURL: config.baseURL || 'https://openrouter.ai/api/v1',
      defaultModelId: config.defaultModelId, // Can be undefined, but this.defaultModelId will store it
      siteUrl: config.siteUrl, // Can be undefined
      appName: config.appName, // Can be undefined
      requestTimeout: config.requestTimeout || 60000,
      streamRequestTimeout: config.streamRequestTimeout || 180000,
    });
    this.keyPool = new ApiKeyPool(config.apiKey);
    this.defaultModelId = this.config.defaultModelId; // Store the potentially undefined value

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.keyPool.next()}`,
      'Content-Type': 'application/json',
      'User-Agent': `AgentOS/1.0 (OpenRouterProvider; ${this.config.appName || 'UnknownApp'})`,
    };
    if (this.config.siteUrl) {
      headers['HTTP-Referer'] = this.config.siteUrl;
    }
    if (this.config.appName) {
      headers['X-Title'] = this.config.appName;
    }

    this.client = axios.create({
      baseURL: this.config.baseURL,
      headers,
    });

    try {
      await this.refreshAvailableModels();
      this.isInitialized = true;
      console.log(`OpenRouterProvider initialized. Default Model: ${this.defaultModelId || 'Not set'}. Found ${this.availableModelsCache.size} models via OpenRouter.`);
    } catch (error: unknown) {
      this.isInitialized = false;
      const initError = error instanceof OpenRouterProviderError ? error :
        createGMIErrorFromError( // Corrected: use imported createGMIErrorFromError
          error instanceof Error ? error : new Error(String(error)),
          GMIErrorCode.LLM_PROVIDER_ERROR, // Corrected: use imported GMIErrorCode
          { providerId: this.providerId },
          `OpenRouterProvider failed to initialize: ${error instanceof Error ? error.message : String(error)}`
        );
      console.error(initError.message, initError.details || initError);
      throw initError;
    }
  }

  private async refreshAvailableModels(): Promise<void> {
    const responseData = await this.makeApiRequest<OpenRouterListModelsAPIResponse>(
      '/models',
      'GET',
      this.config.requestTimeout
    );

    this.availableModelsCache.clear();
    if (responseData && Array.isArray(responseData.data)) {
      responseData.data.forEach((apiModel: OpenRouterModelAPIObject) => {
        const modelInfo = this.mapApiToModelInfo(apiModel);
        this.availableModelsCache.set(modelInfo.modelId, modelInfo);
      });
    } else {
      console.warn("OpenRouterProvider: Received no model data or malformed response from /models endpoint.");
    }
  }

  private mapApiToModelInfo(apiModel: OpenRouterModelAPIObject): ModelInfo {
    const capabilities: ModelInfo['capabilities'] = ['chat', 'completion'];
    if (apiModel.architecture?.modality === 'multimodal') {
      capabilities.push('vision_input');
    }
    const knownAdvancedModelPatterns = ['gpt-3.5', 'gpt-4', 'claude-2', 'claude-3', 'gemini', 'mistral', 'llama'];
    if (knownAdvancedModelPatterns.some(pattern => apiModel.id.toLowerCase().includes(pattern))) {
      capabilities.push('tool_use', 'json_mode');
    }
    if (apiModel.id.includes('embedding') || apiModel.id.includes('embed')) {
      capabilities.push('embeddings');
    }

    const parsePrice = (priceStr: string | undefined, tokensFactor: number = 1000000): number | undefined => {
      if (typeof priceStr !== 'string') return undefined;
      const price = parseFloat(priceStr);
      return isNaN(price) ? undefined : price * tokensFactor;
    };

    return {
      modelId: apiModel.id,
      providerId: this.providerId,
      displayName: apiModel.name,
      description: apiModel.description,
      capabilities: Array.from(new Set(capabilities)),
      contextWindowSize: apiModel.context_length || undefined,
      pricePer1MTokensInput: parsePrice(apiModel.pricing.prompt),
      pricePer1MTokensOutput: parsePrice(apiModel.pricing.completion),
      supportsStreaming: true,
      status: 'active',
    };
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new OpenRouterProviderError(
        'OpenRouterProvider is not initialized. Please call the initialize() method first.',
        'PROVIDER_NOT_INITIALIZED'
      );
    }
  }

  private mapToOpenRouterMessages(messages: ChatMessage[]): Array<Partial<ChatMessage>> {
    return messages.map(msg => {
      const mappedMsg: Partial<ChatMessage> = { role: msg.role, content: msg.content };
      if (msg.name) mappedMsg.name = msg.name;
      if (msg.tool_calls) mappedMsg.tool_calls = msg.tool_calls;
      if (msg.tool_call_id) mappedMsg.tool_call_id = msg.tool_call_id;
      return mappedMsg;
    });
  }

  public async generateCompletion(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions
  ): Promise<ModelCompletionResponse> {
    this.ensureInitialized();
    const openRouterMessages = this.mapToOpenRouterMessages(messages);

    const payload: Record<string, unknown> = {
      model: modelId,
      messages: openRouterMessages,
      stream: false,
      ...(options.temperature !== undefined && { temperature: options.temperature }),
      ...(options.topP !== undefined && { top_p: options.topP }),
      // OpenRouter reserves credits up to max_tokens at request time. When the
      // caller doesn't specify a limit, OR falls back to the model's full output
      // capacity (e.g. 64000 for claude-haiku-4-5), which causes 402 credit-required
      // errors on accounts without enough buffer. Default to 4096 — the same value
      // AnthropicProvider uses — so short prompts succeed without explicit tuning.
      // Then clamp to the model's output ceiling so a request sized for a
      // flagship model is not rejected when routed to a lower-ceiling OpenAI
      // model (e.g. openai/gpt-4o caps at 16384, not 32000).
      max_tokens: clampMaxOutputTokens(modelId, options.maxTokens) ?? 4096,
      ...(options.presencePenalty !== undefined && { presence_penalty: options.presencePenalty }),
      ...(options.frequencyPenalty !== undefined && { frequency_penalty: options.frequencyPenalty }),
      ...(options.stopSequences !== undefined && { stop: options.stopSequences }),
      ...(options.userId !== undefined && { user: options.userId }),
      ...(options.tools !== undefined && { tools: options.tools }),
      ...(options.toolChoice !== undefined && { tool_choice: options.toolChoice }),
      ...(options.responseFormat?.type === 'json_object' && { response_format: { type: 'json_object' } }),
      ...(options.customModelParams || {}),
    };

    const apiResponseData = await this.makeApiRequest<OpenRouterChatCompletionAPIResponse>(
      '/chat/completions',
      'POST',
      // CR8: honor a per-call requestTimeout override over the provider default.
      options.requestTimeout ?? this.config.requestTimeout,
      payload
    );
    return this.mapApiToCompletionResponse(apiResponseData, modelId);
  }

  public async *generateCompletionStream(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions
  ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    this.ensureInitialized();
    const openRouterMessages = this.mapToOpenRouterMessages(messages);

    const payload: Record<string, unknown> = {
      model: modelId,
      messages: openRouterMessages,
      stream: true,
      // OpenRouter follows the OpenAI streaming convention: usage is omitted
      // unless stream_options.include_usage is set, in which case a trailing
      // usage-only chunk arrives before [DONE]. Without this flag,
      // streamText({...}).usage resolves to all zeros even on success.
      stream_options: { include_usage: true },
      ...(options.temperature !== undefined && { temperature: options.temperature }),
      ...(options.topP !== undefined && { top_p: options.topP }),
      // OpenRouter reserves credits up to max_tokens at request time. When the
      // caller doesn't specify a limit, OR falls back to the model's full output
      // capacity (e.g. 64000 for claude-haiku-4-5), which causes 402 credit-required
      // errors on accounts without enough buffer. Default to 4096 — the same value
      // AnthropicProvider uses — so short prompts succeed without explicit tuning.
      // Then clamp to the model's output ceiling so a request sized for a
      // flagship model is not rejected when routed to a lower-ceiling OpenAI
      // model (e.g. openai/gpt-4o caps at 16384, not 32000).
      max_tokens: clampMaxOutputTokens(modelId, options.maxTokens) ?? 4096,
      ...(options.presencePenalty !== undefined && { presence_penalty: options.presencePenalty }),
      ...(options.frequencyPenalty !== undefined && { frequency_penalty: options.frequencyPenalty }),
      ...(options.stopSequences !== undefined && { stop: options.stopSequences }),
      ...(options.userId !== undefined && { user: options.userId }),
      ...(options.tools !== undefined && { tools: options.tools }),
      ...(options.toolChoice !== undefined && { tool_choice: options.toolChoice }),
      ...(options.responseFormat?.type === 'json_object' && { response_format: { type: 'json_object' } }),
      ...(options.customModelParams || {}),
    };

    const stream = await this.makeApiRequest<NodeJS.ReadableStream>(
      '/chat/completions',
      'POST',
      // CR8: honor a per-call requestTimeout override over the stream default.
      options.requestTimeout ?? this.config.streamRequestTimeout,
      payload,
      true
    );

    const accumulatedToolCalls: Map<number, { id?: string; type?: 'function'; function?: { name?: string; arguments?: string; } }> = new Map();

    const abortSignal = options.abortSignal;
    if (abortSignal?.aborted) {
      yield { id: `openrouter-abort-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), modelId, choices: [], error: { message: 'Stream aborted prior to first chunk', type: 'abort' }, isFinal: true };
      return;
    }
    const abortHandler = () => { /* passive; loop logic handles emission */ };
    abortSignal?.addEventListener('abort', abortHandler, { once: true });

    for await (const rawChunk of this.parseSseStream(stream)) {
      if (abortSignal?.aborted) {
        yield { id: `openrouter-abort-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), modelId, choices: [], error: { message: 'Stream aborted by caller', type: 'abort' }, isFinal: true };
        break;
      }
      if (rawChunk.startsWith('data: ') && rawChunk.includes('[DONE]')) {
        const doneData = rawChunk.substring('data: '.length).trim();
        if (doneData === '[DONE]') break;
      }
      if (rawChunk === 'data: [DONE]') {
        break;
      }

      if (rawChunk.startsWith('data: ')) {
        const jsonData = rawChunk.substring('data: '.length);
        try {
          const apiChunk = JSON.parse(jsonData) as OpenRouterChatCompletionAPIResponse;
          yield this.mapApiToStreamChunkResponse(apiChunk, modelId, accumulatedToolCalls);
          // Don't break on finish_reason: with stream_options.include_usage,
          // OpenRouter (like OpenAI) emits a trailing usage-only chunk AFTER
          // the finish_reason chunk and BEFORE [DONE]. Breaking here would
          // skip the usage chunk and zero out the caller's token totals. The
          // [DONE] marker check above is the right termination signal.
        } catch (error: unknown) {
          console.warn('OpenRouterProvider: Failed to parse stream chunk JSON, skipping chunk. Data:', jsonData, 'Error:', error);
        }
      }
    }
    abortSignal?.removeEventListener('abort', abortHandler);
  }

  public async generateEmbeddings(
    modelId: string,
    texts: string[],
    options?: ProviderEmbeddingOptions
  ): Promise<ProviderEmbeddingResponse> {
    this.ensureInitialized();
    if (!texts || texts.length === 0) {
      throw new OpenRouterProviderError('Input texts array cannot be empty for generating embeddings.', 'EMBEDDING_NO_INPUT');
    }

    const modelInfo = await this.getModelInfo(modelId);
    if (modelInfo && !modelInfo.capabilities.includes('embeddings')) {
      console.warn(`OpenRouterProvider: Model '${modelId}' is not explicitly listed with embedding capabilities. Attempting anyway.`);
    }

    const payload: Record<string, unknown> = {
      model: modelId,
      input: texts,
      ...(options?.encodingFormat && { encoding_format: options.encodingFormat }),
      ...(options?.dimensions && { dimensions: options.dimensions }),
      ...(options?.customModelParams || {}),
    };
    if (options?.inputType && payload.customModelParams && typeof payload.customModelParams === 'object') {
      (payload.customModelParams as Record<string, unknown>).input_type = options.inputType;
    } else if (options?.inputType) {
      payload.customModelParams = { input_type: options.inputType };
    }

    const apiResponseData = await this.makeApiRequest<OpenRouterEmbeddingAPIResponse>(
      '/embeddings',
      'POST',
      this.config.requestTimeout,
      payload
    );

    return {
      object: 'list',
      data: apiResponseData.data.map(d => ({
        object: 'embedding',
        embedding: d.embedding,
        index: d.index,
      })),
      model: apiResponseData.model,
      usage: {
        prompt_tokens: apiResponseData.usage.prompt_tokens,
        total_tokens: apiResponseData.usage.total_tokens,
      },
    };
  }

  public async listAvailableModels(filter?: { capability?: string }): Promise<ModelInfo[]> {
    this.ensureInitialized();
    if (this.availableModelsCache.size === 0) {
      try {
        await this.refreshAvailableModels();
      } catch (refreshError) {
        console.warn("OpenRouterProvider: Failed to refresh models during listAvailableModels call after finding empty cache:", refreshError);
      }
    }
    const models = Array.from(this.availableModelsCache.values());
    if (filter?.capability) {
      return models.filter(m => m.capabilities.includes(filter.capability!));
    }
    return models;
  }

  public async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    this.ensureInitialized();
    if (!this.availableModelsCache.has(modelId)) {
      try {
        console.log(`OpenRouterProvider: Model ${modelId} not in cache. Refreshing model list.`);
        await this.refreshAvailableModels();
      } catch (error) {
        console.warn(`OpenRouterProvider: Failed to refresh models list while trying to get info for ${modelId}:`, error);
      }
    }
    return this.availableModelsCache.get(modelId);
  }

  public async checkHealth(): Promise<{ isHealthy: boolean; details?: unknown }> {
    if (!this.client) {
      return { isHealthy: false, details: { message: "OpenRouterProvider not initialized (HTTP client missing)."}};
    }
    try {
      await this.client.get('/models', { timeout: Math.min(this.config.requestTimeout || 10000, 10000) });
      return { isHealthy: true, details: { message: "Successfully connected to OpenRouter /models endpoint." } };
    } catch (error: unknown) {
      const err = error as AxiosError;
      return {
        isHealthy: false,
        details: {
          message: `OpenRouter health check failed: ${err.message}`,
          status: err.response?.status,
          responseData: err.response?.data,
        },
      };
    }
  }

  public async shutdown(): Promise<void> {
    this.isInitialized = false;
    this.availableModelsCache.clear();
    console.log('OpenRouterProvider shutdown: Instance marked as uninitialized and cache cleared.');
  }

  private mapApiToCompletionResponse(
    apiResponse: OpenRouterChatCompletionAPIResponse,
    requestedModelId: string
  ): ModelCompletionResponse {
    const choice = apiResponse.choices[0];
    if (!choice) {
      throw new OpenRouterProviderError("Received empty choices array from OpenRouter.", "API_RESPONSE_MALFORMED", undefined, undefined, { responseId: apiResponse.id });
    }

    const usage: ModelUsage | undefined = apiResponse.usage ? {
      promptTokens: apiResponse.usage.prompt_tokens,
      completionTokens: apiResponse.usage.completion_tokens,
      totalTokens: apiResponse.usage.total_tokens,
      costUSD: apiResponse.usage.cost,
    } : undefined;

    return {
      id: apiResponse.id,
      object: apiResponse.object,
      created: apiResponse.created,
      modelId: apiResponse.model || requestedModelId,
      choices: apiResponse.choices.map(c => ({
        index: c.index,
        message: { 
          role: c.message!.role,
          content: c.message!.content,
          tool_calls: c.message!.tool_calls,
        },
        finishReason: c.finish_reason,
        logprobs: c.logprobs,
      })),
      usage,
    };
  }

  private mapApiToStreamChunkResponse(
      apiChunk: OpenRouterChatCompletionAPIResponse,
      requestedModelId: string,
      accumulatedToolCalls: Map<number, { id?: string; type?: 'function'; function?: { name?: string; arguments?: string; } }>
  ): ModelCompletionResponse {
      const choice = apiChunk.choices[0];

      // With stream_options.include_usage, OpenRouter (like OpenAI) emits a
      // trailing chunk with an empty choices array and a populated usage
      // object. Recognize it as a final usage-only chunk so callers see real
      // token totals after the stream resolves. Without this, the empty-choices
      // path below would mark it as a malformed-response error.
      if ((!apiChunk.choices || apiChunk.choices.length === 0) && apiChunk.usage) {
        return {
          id: apiChunk.id,
          object: apiChunk.object,
          created: apiChunk.created,
          modelId: apiChunk.model || requestedModelId,
          choices: [],
          isFinal: true,
          usage: {
            promptTokens: apiChunk.usage.prompt_tokens,
            completionTokens: apiChunk.usage.completion_tokens,
            totalTokens: apiChunk.usage.total_tokens,
            costUSD: apiChunk.usage.cost,
          },
        };
      }

      if (!choice) {
        return {
          id: apiChunk.id, object: apiChunk.object, created: apiChunk.created,
          modelId: apiChunk.model || requestedModelId, choices: [], isFinal: true,
          error: { message: "Stream chunk contained no choices.", type: "invalid_response" }
        };
      }

      let responseTextDelta: string | undefined;
      let toolCallsDeltas: ModelCompletionResponse['toolCallsDeltas'];
      
      if (choice.delta?.content) {
        responseTextDelta = choice.delta.content;
      }

      if (choice.delta?.tool_calls) {
        toolCallsDeltas = [];
        choice.delta.tool_calls.forEach(tcDelta => {
          let currentToolCallState = accumulatedToolCalls.get(tcDelta.index);
          if (!currentToolCallState) {
            currentToolCallState = { function: { name: '', arguments: ''} };
          }

          if (tcDelta.id) currentToolCallState.id = tcDelta.id;
          if (tcDelta.type) currentToolCallState.type = tcDelta.type as 'function';
          if (tcDelta.function?.name) currentToolCallState.function!.name = (currentToolCallState.function!.name || '') + tcDelta.function.name;
          if (tcDelta.function?.arguments) currentToolCallState.function!.arguments = (currentToolCallState.function!.arguments || '') + tcDelta.function.arguments;
           
          accumulatedToolCalls.set(tcDelta.index, currentToolCallState);

          toolCallsDeltas!.push({
            index: tcDelta.index,
            id: tcDelta.id,
            type: tcDelta.type as 'function',
            function: tcDelta.function ? {
              name: tcDelta.function.name,
              arguments_delta: tcDelta.function.arguments
            } : undefined,
          });
        });
      }

      const isFinal = !!choice.finish_reason;
      let finalUsage: ModelUsage | undefined;
      const finalChoices: ModelCompletionChoice[] = [];

      if (isFinal) {
        if (apiChunk.usage) {
          finalUsage = {
            promptTokens: apiChunk.usage.prompt_tokens,
            completionTokens: apiChunk.usage.completion_tokens,
            totalTokens: apiChunk.usage.total_tokens,
            costUSD: apiChunk.usage.cost,
          };
        }
        const finalMessage: ChatMessage = {
          role: choice.delta?.role || accumulatedToolCalls.size > 0 ? 'assistant' : (choice.message?.role || 'assistant'),
          content: responseTextDelta || (choice.message?.content || null),
          tool_calls: Array.from(accumulatedToolCalls.values())
            .filter(tc => tc.id && tc.function?.name)
            .map(accTc => ({
              id: accTc.id!,
              type: accTc.type!,
              function: { name: accTc.function!.name!, arguments: accTc.function!.arguments! }
            })),
        };
        if (!finalMessage.tool_calls || finalMessage.tool_calls.length === 0) {
          delete finalMessage.tool_calls;
        }
        if (responseTextDelta && !choice.message?.content && accumulatedToolCalls.size === 0) {
          finalMessage.content = responseTextDelta;
        } else if (accumulatedToolCalls.size > 0 && !responseTextDelta && !choice.message?.content) {
          finalMessage.content = null;
        }

        finalChoices.push({
          index: choice.index,
          message: finalMessage,
          finishReason: choice.finish_reason,
          logprobs: choice.logprobs,
        });
      } else {
        finalChoices.push({
          index: choice.index,
          message: {
            role: choice.delta?.role || 'assistant',
            content: responseTextDelta || null,
          },
          finishReason: null,
        });
      }
      
      return {
        id: apiChunk.id,
        object: apiChunk.object,
        created: apiChunk.created,
        modelId: apiChunk.model || requestedModelId,
        choices: finalChoices,
        responseTextDelta: isFinal ? undefined : responseTextDelta,
        toolCallsDeltas: isFinal ? undefined : toolCallsDeltas,
        isFinal,
        usage: finalUsage,
      };
  }

  private async makeApiRequest<T = unknown>(
    endpoint: string,
    method: 'GET' | 'POST',
    timeout?: number,
    body?: Record<string, unknown>,
    expectStream: boolean = false
  ): Promise<T> {
    try {
      const response = await this.client.request<T>({
        url: endpoint,
        method,
        data: body,
        timeout: timeout,
        responseType: expectStream ? 'stream' as ResponseType : 'json' as ResponseType,
      });
      return response.data;
    } catch (error: unknown) {
      let statusCode: number | undefined;
      let errorData: any;
      let errorMessage = 'Unknown OpenRouter API error';
      let errorType = 'UNKNOWN_API_ERROR';

      if (axios.isAxiosError(error)) {
        statusCode = error.response?.status;
        errorData = error.response?.data;
        if (errorData?.error && typeof errorData.error === 'object') {
          errorMessage = errorData.error.message || errorMessage;
          errorType = errorData.error.type || errorType;
        } else if (typeof errorData === 'string') {
          errorMessage = errorData;
        } else if ((error as Error).message) {
          errorMessage = (error as Error).message;
        }
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      // Prefix the status code into the message so downstream retry/fallback
      // logic (e.g. isRetryableError, which greps for \b402\b) can route on it
      // even when the OR API body provides a friendlier description.
      const decoratedMessage = statusCode ? `[${statusCode}] ${errorMessage}` : errorMessage;
      throw new OpenRouterProviderError(
        decoratedMessage,
        'API_REQUEST_FAILED',
        statusCode,
        errorType,
        { requestEndpoint: endpoint, requestBodyPreview: body ? JSON.stringify(body).substring(0, 200) + '...' : undefined, responseData: errorData, underlyingError: error }
      );
    }
  }

  private async *parseSseStream(stream: NodeJS.ReadableStream): AsyncGenerator<string, void, undefined> {
    let buffer = '';
    const readableStream = stream as NodeJS.ReadableStream & { destroy?: () => void };

    try {
      for await (const chunk of readableStream) {
        buffer += chunk.toString();
        let eolIndex;
        while ((eolIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.substring(0, eolIndex).trim();
          buffer = buffer.substring(eolIndex + 1);
          if (line) {
            yield line;
          }
        }
      }
      if (buffer.trim()) {
        yield buffer.trim();
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "OpenRouter stream parsing/reading error";
      console.error("OpenRouterProvider: Error reading or parsing SSE stream:", message, error);
      if (error instanceof OpenRouterProviderError) throw error;
      throw new OpenRouterProviderError(message, 'STREAM_PARSING_ERROR', undefined, undefined, error);
    } finally {
      if (typeof readableStream.destroy === 'function') {
        readableStream.destroy();
      } else if (typeof (readableStream as any).close === 'function') {
        (readableStream as any).close();
      }
    }
  }
}

