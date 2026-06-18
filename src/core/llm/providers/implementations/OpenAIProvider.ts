// @ts-nocheck
// File: backend/agentos/core/llm/providers/implementations/OpenAIProvider.ts

/**
 * @fileoverview Implements the IProvider interface for OpenAI's GPT models.
 * This provider offers comprehensive integration with OpenAI's API, including:
 * - Chat completions (streaming and non-streaming)
 * - Tool/function calling
 * - Vision capabilities for multimodal models (e.g., GPT-4o)
 * - Text embeddings generation
 * - Model introspection and health checks.
 *
 * It is designed with robustness and extensibility in mind, featuring:
 * - Detailed error handling using custom `OpenAIProviderError`.
 * - API key management with support for system-wide and per-request overrides.
 * - Configurable request retries with exponential backoff.
 * - Rate limiting (conceptual, actual enforcement by OpenAI).
 * - Comprehensive JSDoc documentation.
 * - Adherence to TypeScript best practices and modern ECMAScript features.
 *
 * @module backend/agentos/core/llm/providers/implementations/OpenAIProvider
 * @implements {IProvider}
 */

import {
  IProvider,
  ChatMessage,
  ModelCompletionOptions,
  ModelCompletionResponse,
  ModelCompletionChoice,
  ModelInfo,
  ModelUsage,
  ProviderEmbeddingOptions,
  ProviderEmbeddingResponse,
} from '../IProvider';
import { OpenAIProviderError } from '../errors/OpenAIProviderError';
import { ApiKeyPool } from '../../../providers/ApiKeyPool.js';
import { toOpenAiResponseFormat } from './openai-response-format-guard';
import { clampMaxOutputTokens } from '../model-output-limits.js';
// Assuming a fetch-like interface is available globally or polyfilled (e.g., node-fetch)
// For Node.js, ensure 'node-fetch' is a dependency or use Node's built-in fetch from v18+.
// import fetch, { RequestInit, Response as FetchResponse, AbortController } from 'node-fetch'; // Example for Node

/**
 * Configuration specific to the OpenAIProvider.
 */
export interface OpenAIProviderConfig {
  /** The API key for accessing OpenAI services. Can be overridden by `apiKeyOverride` in request options. Can be empty when oauthFlow is provided. */
  apiKey: string;
  /** Base URL for the OpenAI API. Defaults to "https://api.openai.com/v1". Useful for proxies. */
  baseURL?: string;
  /** Default OpenAI organization ID to use for requests. */
  organizationId?: string;
  /** Maximum number of retry attempts for failed API requests. Defaults to 3. */
  maxRetries?: number;
  /** Timeout for API requests in milliseconds. Defaults to 60000 (60 seconds). */
  requestTimeout?: number;
  /** Optional custom headers to include with all requests to the OpenAI API. */
  customHeaders?: Record<string, string>;
  /** Default model ID to use if not specified in a request. E.g., "gpt-4o-mini". */
  defaultModelId?: string;
  /** Optional OAuth flow for subscription-based auth (e.g. ChatGPT Plus/Pro). When set, apiKey is derived dynamically from OAuth tokens. */
  oauthFlow?: { getAccessToken(): Promise<string> };
}

// Simplified OpenAI API response structures (non-namespaced)
type OpenAIChatCompletionChoice = {
    index: number;
    message: {
      role: ChatMessage['role'];
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
      function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string | null;
    logprobs?: unknown;
};

type _OpenAIChatCompletionResponse = {
    id: string;
    object: string; // e.g., "chat.completion"
    created: number; // Unix timestamp
    model: string; // Model ID used
  choices: OpenAIChatCompletionChoice[];
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    system_fingerprint?: string;
};

type OpenAIChatCompletionStreamChoiceDelta = {
    role?: ChatMessage['role'];
    content?: string;
    tool_calls?: Array<{
      index: number; // Required for accumulating tool calls
      id?: string;
      type?: 'function';
    function?: { name?: string; arguments?: string };
    }>;
};

type OpenAIChatCompletionStreamChoice = {
    index: number;
  delta: OpenAIChatCompletionStreamChoiceDelta;
    finish_reason?: string | null;
    logprobs?: unknown;
};

type _OpenAIChatCompletionStreamResponse = {
    id: string;
    object: string; // e.g., "chat.completion.chunk"
    created: number;
    model: string;
  choices: OpenAIChatCompletionStreamChoice[];
  usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    system_fingerprint?: string;
};

type OpenAIEmbeddingAPIObject = {
    object: 'embedding';
    embedding: number[];
    index: number;
};

type _OpenAIEmbeddingResponse = {
    object: 'list';
  data: OpenAIEmbeddingAPIObject[];
    model: string; // Model ID used
    usage: {
      prompt_tokens: number;
      total_tokens: number;
    };
};

type OpenAIModelAPIObject = {
    id: string;
    object: 'model';
    created: number; // Unix timestamp
    owned_by: string;
};

type _OpenAIListModelsResponse = {
    object: 'list';
  data: OpenAIModelAPIObject[];
};

type _OpenAIAPIErrorResponse = {
    error?: {
      message: string;
      type: string;
      param?: string | null;
      code?: string | null;
    };
};

/**
 * @class OpenAIProvider
 * @implements {IProvider}
 * Provides an interface to OpenAI's suite of models (GPT, Embeddings).
 * It handles API requests, streaming, error management, and model information.
 */
/**
 * Whether the given model id belongs to the family that requires
 * `max_completion_tokens` instead of the legacy `max_tokens` parameter.
 *
 * OpenAI's reasoning models (o1, o3, o4) and the GPT-5 family reject
 * `max_tokens` outright with HTTP 400 "Unsupported parameter:
 * 'max_tokens' is not supported with this model. Use
 * 'max_completion_tokens' instead." Legacy chat completions
 * (gpt-4o, gpt-4-turbo, gpt-4.1, gpt-3.5, etc.) still accept the
 * old field.
 *
 * Errs on the conservative side — any model id that is not a clear
 * member of one of the new families uses `max_tokens` so older
 * deployments do not silently break when the param-name flag changes.
 *
 * @param modelId Provider-side model identifier (e.g. `'gpt-5.4-mini'`).
 * @returns `true` when the model needs `max_completion_tokens`.
 */
export function modelRequiresMaxCompletionTokens(modelId: string): boolean {
  return isOpenAIReasoningModel(modelId);
}

/**
 * Whether `modelId` is an OpenAI reasoning model — the o1/o3/o4 series or the
 * GPT-5 family. These models reject custom sampling params (`temperature`,
 * `top_p`) with HTTP 400 in addition to requiring `max_completion_tokens`;
 * they run only at their fixed defaults. Single source of truth for the
 * o-series/gpt-5 detection used by both the param guards.
 *
 * @param modelId Provider-side model identifier (e.g. `'o3'`, `'gpt-5.4-mini'`).
 */
export function isOpenAIReasoningModel(modelId: string): boolean {
  // o1 / o3 / o4 reasoning models, plus GPT-5 family.
  return /^(o\d|gpt-5)/i.test(modelId);
}

export class OpenAIProvider implements IProvider {
  /** @inheritdoc */
  public readonly providerId: string = 'openai';
  /** @inheritdoc */
  public isInitialized: boolean = false;
  /** @inheritdoc */
  public defaultModelId?: string;

  private config!: OpenAIProviderConfig; // Asserted as initialized by `initialize`
  private keyPool: ApiKeyPool | null = null;
  private availableModelsCache: Map<string, ModelInfo> = new Map();

  // Known pricing for common OpenAI models (USD per 1K tokens).
  // Verified against openai.com/api/pricing and developers.openai.com/api/docs/pricing
  // on 2026-04-16. Values are standard (non-batch, non-regional) rates.
  // Input: cost for prompt tokens. Output: cost for completion tokens.
  // For embedding models, 'input' is total tokens.
  private readonly modelPricing: Record<string, { input: number; output: number }> = {
    // GPT-5.4 family (current flagship and siblings, Mar 2026)
    'gpt-5.4': { input: 0.0025, output: 0.015 },
    'gpt-5.4-mini': { input: 0.00075, output: 0.0045 },
    'gpt-5.4-nano': { input: 0.0002, output: 0.00125 },
    'gpt-5.4-pro': { input: 0.030, output: 0.180 },
    // GPT-5.3 family (ChatGPT / Codex variants, priced per Azure/OpenAI listings)
    'gpt-5.3-chat-latest': { input: 0.00175, output: 0.014 },
    'gpt-5.3-codex': { input: 0.00175, output: 0.014 },
    // GPT-5.2 family
    'gpt-5.2': { input: 0.00175, output: 0.014 },
    // GPT-5.1 and GPT-5 base (legacy, same tier pricing)
    'gpt-5': { input: 0.00125, output: 0.010 },
    'gpt-5.1': { input: 0.00125, output: 0.010 },
    'gpt-5-mini': { input: 0.00025, output: 0.002 },
    'gpt-5-nano': { input: 0.00005, output: 0.0004 },
    // GPT-4.1 family (legacy but still in rotation)
    'gpt-4.1': { input: 0.002, output: 0.008 },
    'gpt-4.1-mini': { input: 0.0004, output: 0.0016 },
    'gpt-4.1-nano': { input: 0.0001, output: 0.0004 },
    // GPT-4o family (legacy, repriced to current list at $2.50/$10 per 1M)
    'gpt-4o': { input: 0.0025, output: 0.010 },
    'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
    // Deprecated but still potentially referenced
    'gpt-4-turbo': { input: 0.01, output: 0.03 },
    'gpt-4-turbo-preview': { input: 0.01, output: 0.03 },
    'gpt-4-vision-preview': { input: 0.01, output: 0.03 },
    'gpt-4': { input: 0.03, output: 0.06 },
    'gpt-4-32k': { input: 0.06, output: 0.12 },
    'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
    'gpt-3.5-turbo-16k': { input: 0.001, output: 0.002 },
    // o-series reasoning models
    'o3': { input: 0.002, output: 0.008 },
    'o3-pro-2025-06-10': { input: 0.020, output: 0.080 },
    'o4-mini': { input: 0.001, output: 0.004 },
    'o1': { input: 0.015, output: 0.060 },
    'o1-pro': { input: 0.150, output: 0.600 },
    // Embedding models (per 1K tokens, input only)
    'text-embedding-3-large': { input: 0.00013, output: 0 },
    'text-embedding-3-small': { input: 0.00002, output: 0 },
    'text-embedding-ada-002': { input: 0.0001, output: 0 },
  };


  /**
   * Creates an instance of OpenAIProvider.
   * Note: The provider is not ready to use until `initialize()` is called and resolves.
   */
  constructor() {
    // Configuration is set during initialize()
  }

  /** @inheritdoc */
  public async initialize(config: OpenAIProviderConfig): Promise<void> {
    if (!config.apiKey && !config.oauthFlow) {
      throw new OpenAIProviderError(
        'API key or OAuth flow is required for OpenAIProvider initialization.',
        'INIT_FAILED_MISSING_API_KEY'
      );
    }

    this.config = {
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 3,
      requestTimeout: 60000, // 60 seconds
      ...config, // User-provided config overrides defaults
    };
    this.keyPool = new ApiKeyPool(config.apiKey);
    this.defaultModelId = config.defaultModelId;

    try {
      // Attempt to list models to verify API key and connectivity.
      await this.refreshAvailableModels();
      this.isInitialized = true;
      const env = typeof process !== 'undefined' ? process.env : undefined;
      const debugOn = !!env && (env.AGENTOS_DEBUG === '1' || env.AGENTOS_DEBUG === 'true' || (env.AGENTOS_LOG_LEVEL ?? '').toLowerCase() === 'debug');
      if (debugOn) {
        console.log(`OpenAIProvider initialized successfully. Default model: ${this.defaultModelId || 'Not set'}. Found ${this.availableModelsCache.size} models.`);
      }
    } catch (error: unknown) {
      this.isInitialized = false;
      if (error instanceof OpenAIProviderError) {
        throw error; // Re-throw if already an OpenAIProviderError
      }
      const message = error instanceof Error ? error.message : 'Unknown error during initialization.';
      throw new OpenAIProviderError(
        `OpenAIProvider initialization failed: ${message}`,
        'INITIALIZATION_FAILED',
        undefined, undefined, undefined, error
      );
    }
  }

  /**
   * Fetches the list of available models from OpenAI and updates the internal cache.
   * @private
   * @throws {OpenAIProviderError} If fetching or parsing models fails.
   */
  private async refreshAvailableModels(): Promise<void> {
    const apiKey = await this.getApiKey();
    const response = await this.makeApiRequest<OpenAIAPITypes.ListModelsResponse>(
      '/models',
      'GET',
      apiKey
    );

    this.availableModelsCache.clear();
    response.data.forEach((apiModel: OpenAIAPITypes.ModelAPIObject) => {
      // Basic filtering for generally usable models, can be expanded.
      if (apiModel.id.startsWith('gpt-') || apiModel.id.includes('embedding')) {
        const modelInfo = this.mapApiToModelInfo(apiModel);
        this.availableModelsCache.set(modelInfo.modelId, modelInfo);
      }
    });
  }

  /**
   * Maps an OpenAI API model object to the standard ModelInfo interface.
   * @private
   * @param {OpenAIAPITypes.ModelAPIObject} apiModel - The model object from OpenAI API.
   * @returns {ModelInfo} The standardized ModelInfo object.
   */
  private mapApiToModelInfo(apiModel: OpenAIAPITypes.ModelAPIObject): ModelInfo {
    const capabilities: ModelInfo['capabilities'] = [];
    let contextWindowSize: number | undefined;
    let _supportsTools = false;
    let _supportsVision = false;
    let isEmbeddingModel = false;

    // Infer capabilities and context window from model ID (common OpenAI patterns)
    if (apiModel.id.startsWith('gpt-4o')) {
        capabilities.push('chat', 'vision_input', 'tool_use', 'json_mode');
        contextWindowSize = 128000; _supportsTools = true; _supportsVision = true;
    } else if (apiModel.id.startsWith('gpt-4-turbo')) {
        capabilities.push('chat', 'tool_use', 'json_mode');
        contextWindowSize = 128000; _supportsTools = true;
        if (apiModel.id.includes('-vision')) { capabilities.push('vision_input'); _supportsVision = true;}
    } else if (apiModel.id.startsWith('gpt-4-32k')) {
        capabilities.push('chat', 'tool_use', 'json_mode');
        contextWindowSize = 32768; _supportsTools = true;
    } else if (apiModel.id.startsWith('gpt-4')) {
        capabilities.push('chat', 'tool_use', 'json_mode');
        contextWindowSize = 8192; _supportsTools = true;
    } else if (apiModel.id.startsWith('gpt-3.5-turbo-16k')) {
        capabilities.push('chat', 'tool_use', 'json_mode');
        contextWindowSize = 16385; _supportsTools = true;
    } else if (apiModel.id.startsWith('gpt-3.5-turbo')) {
        capabilities.push('chat', 'tool_use', 'json_mode');
        // context window for gpt-3.5-turbo can vary (e.g. 4096, 16385 for -0125)
        // Defaulting to a common value, but specific variants might differ.
        contextWindowSize = apiModel.id.includes('0125') || apiModel.id.includes('1106') ? 16385 : 4096;
        _supportsTools = true;
    } else if (apiModel.id.includes('embedding')) {
        capabilities.push('embeddings');
        isEmbeddingModel = true;
        // Common context/input token limit for OpenAI embedding models
        contextWindowSize = 8191; // Max input tokens
    } else {
        // Fallback for other gpt models if any (less common now)
        capabilities.push('chat'); // Assume chat at least
    }

    const pricing = this.modelPricing[apiModel.id] || { input: 0, output: 0 };

    return {
      modelId: apiModel.id,
      providerId: this.providerId,
      displayName: apiModel.id, // Can be enhanced if more metadata is available
      description: `OpenAI model: ${apiModel.id}`,
      capabilities,
      contextWindowSize,
      pricePer1MTokensInput: pricing.input,
      pricePer1MTokensOutput: pricing.output,
      pricePer1MTokensTotal: isEmbeddingModel ? pricing.input : undefined,
      supportsStreaming: capabilities.includes('chat'), // Generally, chat models support streaming
      // OpenAI specific details can be added to metadata
      embeddingDimension: apiModel.id.includes('embedding-3-large') ? 3072 :
                          apiModel.id.includes('embedding-3-small') ? 1536 :
                          apiModel.id.includes('ada-002') ? 1536 : undefined,
      lastUpdated: new Date(apiModel.created * 1000).toISOString(),
      status: 'active', // OpenAI doesn't directly provide status in this list, assume active.
    };
  }

  /**
   * Ensures the provider is initialized before use.
   * @private
   * @throws {OpenAIProviderError} If not initialized.
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new OpenAIProviderError(
        'OpenAIProvider is not initialized. Call initialize() first.',
        'PROVIDER_NOT_INITIALIZED'
      );
    }
  }

  /**
   * Resolves the API key to use for a request, prioritizing per-request override, then OAuth flow, then system default.
   * @private
   * @param {string | undefined} apiKeyOverride - API key provided directly in request options.
   * @returns {Promise<string>} The API key to use.
   * @throws {OpenAIProviderError} If no API key is available.
   */
  private async getApiKey(apiKeyOverride?: string): Promise<string> {
    if (apiKeyOverride) return apiKeyOverride;
    if (this.config.oauthFlow) {
      return await this.config.oauthFlow.getAccessToken();
    }
    if (this.keyPool?.hasKeys) return this.keyPool.next();
    if (this.config.apiKey) return this.config.apiKey;
    throw new OpenAIProviderError(
      'No OpenAI API key available for the request.',
      'API_KEY_MISSING'
    );
  }

  /** @inheritdoc */
  public async generateCompletion(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions
  ): Promise<ModelCompletionResponse> {
    this.ensureInitialized();
    const apiKey = await this.getApiKey(options.apiKeyOverride);

    const requestBody = this.buildChatCompletionPayload(modelId, messages, options, false);

    const apiResponse = await this.makeApiRequest<OpenAIAPITypes.ChatCompletionResponse>(
      '/chat/completions',
      'POST',
      apiKey,
      requestBody
    );

    return this.mapApiToCompletionResponse(apiResponse);
  }

  /** @inheritdoc */
  public async *generateCompletionStream(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions
  ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    this.ensureInitialized();
    const apiKey = await this.getApiKey(options.apiKeyOverride);

    const requestBody = this.buildChatCompletionPayload(modelId, messages, options, true);

    const stream = (await this.makeApiRequest(
      '/chat/completions',
      'POST',
      apiKey,
      requestBody,
      true // Indicate streaming response is expected
    )) as ReadableStream<Uint8Array>;

    // Accumulators for streaming tool calls
    const accumulatedToolCalls: Map<number, { id?: string; type?: 'function'; function?: { name?: string; arguments?: string; } }> = new Map();

    const abortSignal = options.abortSignal;
    if (abortSignal?.aborted) {
      yield {
        id: `openai-abort-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now()/1000),
        modelId,
        choices: [],
        error: { message: 'Stream aborted prior to first chunk', type: 'abort' },
        isFinal: true,
      };
      return;
    }

    const abortHandler = () => {
      // Emit final abort chunk and ensure generator completes.
      // We cannot directly cancel the underlying ReadableStream cleanly cross-platform here; consumer side will stop.
      // Provide a terminal chunk for consistent teardown.
      // Note: We don't attempt to read further chunks after abort.
    };
    abortSignal?.addEventListener('abort', abortHandler, { once: true });

    for await (const chunk of this.parseSseStream(stream)) {
      if (abortSignal?.aborted) {
        yield {
          id: `openai-abort-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now()/1000),
          modelId,
          choices: [],
          error: { message: 'Stream aborted by caller', type: 'abort' },
          isFinal: true,
        };
        break;
      }
      if (chunk === '[DONE]') {
        // The [DONE] message is a signal for the end of the stream from OpenAI.
        // A final response chunk with isFinal=true and potential usage should be yielded by the parser if data exists.
        // If OpenAI includes usage in the last data chunk before [DONE], parseSseStream handles it.
        return;
      }
      try {
        const apiChunk = JSON.parse(chunk) as OpenAIAPITypes.ChatCompletionStreamResponse;
        yield this.mapApiToStreamChunkResponse(apiChunk, accumulatedToolCalls);
      } catch (error: unknown) {
        console.warn('OpenAIProvider: Failed to parse stream chunk JSON:', chunk, error);
        // Decide if to yield an error chunk or continue if minor parsing issue
      }
    }

    abortSignal?.removeEventListener('abort', abortHandler);
  }

  /** @inheritdoc */
  public async generateEmbeddings(
    modelId: string,
    texts: string[],
    options?: ProviderEmbeddingOptions
  ): Promise<ProviderEmbeddingResponse> {
    this.ensureInitialized();
    if (!texts || texts.length === 0) {
      throw new OpenAIProviderError('Input texts array cannot be empty for embeddings.', 'EMBEDDING_NO_INPUT');
    }
    const apiKey = await this.getApiKey(options?.apiKeyOverride);

    const payload: Record<string, unknown> = {
      model: modelId,
      input: texts,
    };
    if (options?.encodingFormat) payload.encoding_format = options.encodingFormat;
    if (options?.dimensions) payload.dimensions = options.dimensions;
    if (options?.userId) payload.user = options.userId;
    // OpenAI specific: input_type for their newer models
    if (options?.inputType && (modelId.includes('text-embedding-3') || modelId.includes('ada-002'))) {
        // Not a standard OpenAI param, this is an example if they add it.
        // For now, customModelParams is the way for non-standard things.
    }
    if (options?.customModelParams) {
        Object.assign(payload, options.customModelParams);
    }


    const apiResponse = await this.makeApiRequest<OpenAIAPITypes.EmbeddingResponse>(
      '/embeddings',
      'POST',
      apiKey,
      payload
    );

    return this.mapApiToEmbeddingResponse(apiResponse);
  }

  /** @inheritdoc */
  public async listAvailableModels(filter?: { capability?: string }): Promise<ModelInfo[]> {
    this.ensureInitialized();
    // Optionally refresh cache, or rely on initialization. For simplicity, using cached.
    // await this.refreshAvailableModels(); 

    const models = Array.from(this.availableModelsCache.values());
    if (filter?.capability) {
      return models.filter(m => m.capabilities.includes(filter.capability!));
    }
    return models;
  }

  /** @inheritdoc */
  public async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    this.ensureInitialized();
    // Could implement a direct fetch if model not in cache, or rely on cached version.
    // For now, uses cached version.
    if (!this.availableModelsCache.has(modelId)) {
        // Attempt to refresh and check again, in case it's a new model
        try {
            await this.refreshAvailableModels();
        } catch (error) {
            console.warn(`OpenAIProvider: Failed to refresh models while fetching info for ${modelId}`, error);
        }
    }
    return this.availableModelsCache.get(modelId);
  }

  /** @inheritdoc */
  public async checkHealth(): Promise<{ isHealthy: boolean; details?: unknown }> {
    try {
      // A lightweight call, e.g., fetching a small model's info or /models with limit=1
      await this.makeApiRequest<OpenAIAPITypes.ModelAPIObject>(
          `/models/${this.defaultModelId || 'gpt-3.5-turbo'}`, // Use a known cheap/fast model
          'GET',
          this.config.apiKey
      );
      return { isHealthy: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Health check failed';
      return { isHealthy: false, details: { message, error } };
    }
  }

  /** @inheritdoc */
  public async shutdown(): Promise<void> {
    // For OpenAIProvider, using stateless HTTP requests, there might not be
    // persistent connections to close. If connection pooling or WebSockets
    // were used, they would be closed here.
    this.isInitialized = false; // Mark as not initialized
    console.log('OpenAIProvider shutdown complete.');
    // No explicit resources to release in this implementation.
  }


  // --- Helper Methods ---

  /**
   * Builds the payload for OpenAI's Chat Completions API.
   * @private
   */
  private buildChatCompletionPayload(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
    stream: boolean
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: modelId,
      messages: messages.map(m => ({ // Ensure null content is handled if OpenAI expects it explicitly
          role: m.role,
          content: m.content, // OpenAI allows null content for assistant tool_calls message
          name: m.name,
          tool_calls: m.tool_calls,
          tool_call_id: m.tool_call_id,
      })),
      stream: stream,
    };

    // OpenAI's streaming API omits the usage object by default. Without
    // stream_options.include_usage, the final SSE chunk carries finish_reason
    // but no token counts, so downstream `streamText({...}).usage` resolves
    // to zeros. Opting in here gives every streaming caller real usage data
    // (and surfaces a final usage chunk after the [DONE] marker per
    // https://platform.openai.com/docs/api-reference/chat/create#chat-create-stream_options).
    if (stream) {
      payload.stream_options = { include_usage: true };
    }

    // Reasoning models (o-series, GPT-5) reject custom sampling params with an
    // HTTP 400 — they run only at their fixed defaults. Omit temperature/top_p
    // for them, mirroring the max_tokens → max_completion_tokens switch below.
    if (!isOpenAIReasoningModel(modelId)) {
      if (options.temperature !== undefined) payload.temperature = options.temperature;
      if (options.topP !== undefined) payload.top_p = options.topP;
    }
    if (options.maxTokens !== undefined) {
      // Clamp to the model's real output ceiling first: a request sized for
      // a flagship model (e.g. 32000 for Claude Opus) is rejected by gpt-4o
      // (max 16384) when the fallback chain routes here. The clamp is a
      // no-op for models whose ceiling is at or above the request.
      const effMaxTokens = clampMaxOutputTokens(modelId, options.maxTokens) ?? options.maxTokens;
      // OpenAI's reasoning + GPT-5 model families reject `max_tokens`
      // and require `max_completion_tokens` instead. Legacy chat
      // completions (gpt-4o, gpt-4-turbo, gpt-3.5, etc.) keep
      // `max_tokens`. The two fields are otherwise equivalent: same
      // semantic meaning, just renamed in the newer API surface.
      if (modelRequiresMaxCompletionTokens(modelId)) {
        payload.max_completion_tokens = effMaxTokens;
      } else {
        payload.max_tokens = effMaxTokens;
      }
    }
    if (options.presencePenalty !== undefined) payload.presence_penalty = options.presencePenalty;
    if (options.frequencyPenalty !== undefined) payload.frequency_penalty = options.frequencyPenalty;
    if (options.stopSequences !== undefined) payload.stop = options.stopSequences;
    if (options.userId !== undefined) payload.user = options.userId;
    if (options.tools !== undefined) payload.tools = options.tools;
    if (options.toolChoice !== undefined) payload.tool_choice = options.toolChoice;
    // Coerce to an OpenAI-valid response_format, or drop it. agentos builds a
    // provider-specific responseFormat for the PRIMARY provider and reuses it
    // across the fallback chain; an Anthropic tool-marker / Gemini-internal
    // object reaching OpenAI verbatim makes the API reject the request
    // ("Missing required parameter: 'response_format.type'"). Mirrors the
    // guard OpenRouterProvider already applies. See openai-response-format-guard.ts.
    if (options.responseFormat !== undefined) {
      const coerced = toOpenAiResponseFormat(options.responseFormat);
      if (coerced !== undefined) payload.response_format = coerced;
    }
    
    if (options.customModelParams) {
        Object.assign(payload, options.customModelParams);
    }

    return payload;
  }

  /**
   * Maps the raw OpenAI API Chat Completion response to the standard ModelCompletionResponse.
   * @private
   */
  private mapApiToCompletionResponse(
    apiResponse: OpenAIAPITypes.ChatCompletionResponse
  ): ModelCompletionResponse {
    const _choice = apiResponse.choices[0]; // Assuming N=1; kept for reference
    return {
      id: apiResponse.id,
      object: apiResponse.object,
      created: apiResponse.created,
      modelId: apiResponse.model,
      choices: apiResponse.choices.map(c => ({
        index: c.index,
        message: {
          role: c.message.role,
          content: c.message.content,
          tool_calls: c.message.tool_calls,
        },
        finishReason: c.finish_reason,
        logprobs: c.logprobs,
      })),
      usage: apiResponse.usage ? this.calculateUsage(apiResponse.usage, apiResponse.model) : undefined,
      // No deltas for non-streaming response
    };
  }

    /**
     * Maps an OpenAI API stream chunk to a ModelCompletionResponse chunk.
     * Handles accumulation of tool calls.
     * @private
     */
    private mapApiToStreamChunkResponse(
        apiChunk: OpenAIAPITypes.ChatCompletionStreamResponse,
        accumulatedToolCalls: Map<number, { id?: string; type?: 'function'; function?: { name?: string; arguments?: string; } }>
    ): ModelCompletionResponse {
        const choice = apiChunk.choices[0];
        let responseTextDelta: string | undefined;
        let toolCallsDeltas: ModelCompletionResponse['toolCallsDeltas'];
        let finalUsage: ModelUsage | undefined;

        // With stream_options.include_usage, OpenAI emits a trailing chunk with
        // an empty `choices` array and a populated `usage` object. That chunk
        // carries no content / no finish_reason — its only job is to deliver
        // token totals. Treat it as a final usage-only chunk so callers see
        // accurate token counts after the stream resolves.
        if ((!apiChunk.choices || apiChunk.choices.length === 0) && apiChunk.usage) {
            const usageOnlyUsage = this.calculateUsage(apiChunk.usage, apiChunk.model);
            return {
                id: apiChunk.id,
                object: apiChunk.object,
                created: apiChunk.created,
                modelId: apiChunk.model,
                choices: [],
                isFinal: true,
                usage: usageOnlyUsage,
            };
        }

        if (choice?.delta?.content) {
            responseTextDelta = choice.delta.content;
        }

        if (choice?.delta?.tool_calls) {
            toolCallsDeltas = [];
            choice.delta.tool_calls.forEach(tcDelta => {
                let currentToolCall = accumulatedToolCalls.get(tcDelta.index);
                if (!currentToolCall) {
                    currentToolCall = { function: {} }; // Initialize if new
                    if (tcDelta.id) currentToolCall.id = tcDelta.id;
                    if (tcDelta.type) currentToolCall.type = tcDelta.type;
                }

                if (tcDelta.id && !currentToolCall.id) currentToolCall.id = tcDelta.id; // Ensure ID is set if provided in delta
                if (tcDelta.function?.name) currentToolCall.function!.name = (currentToolCall.function!.name || '') + tcDelta.function.name;
                if (tcDelta.function?.arguments) currentToolCall.function!.arguments = (currentToolCall.function!.arguments || '') + tcDelta.function.arguments;
                
                accumulatedToolCalls.set(tcDelta.index, currentToolCall);

                toolCallsDeltas!.push({
                    index: tcDelta.index,
                    id: tcDelta.id,
                    type: tcDelta.type,
                    function: tcDelta.function ? {
                        name: tcDelta.function.name,
                        arguments_delta: tcDelta.function.arguments
                    } : undefined,
                });
            });
        }
        
        const isFinal = !!choice?.finish_reason;
        if (isFinal) {
            // OpenAI might send usage in the last chunk or not at all for streams.
            // If `apiChunk.usage` exists (it's optional in stream chunks per some docs), use it.
            if (apiChunk.usage) {
                 finalUsage = this.calculateUsage(apiChunk.usage, apiChunk.model);
            }
        }
        
        // Construct the primary choice message for the response
        const responseChoice: ModelCompletionChoice = {
            index: choice.index,
            message: {
                role: choice.delta.role || 'assistant', // Role usually comes once or is 'assistant'
                content: responseTextDelta || null, // Content is delta
                 // For final chunk, assemble complete tool_calls
                tool_calls: isFinal ? Array.from(accumulatedToolCalls.values()).map(accTc => ({
                    id: accTc.id!, // ID should be present by now
                    type: accTc.type!, // Type should be present
                    function: {
                        name: accTc.function!.name!,
                        arguments: accTc.function!.arguments!
                    }
                })).filter(tc => tc.id && tc.function.name) : undefined, // Only include if valid
            },
            finishReason: choice.finish_reason || null,
            logprobs: choice.logprobs,
        };


        return {
            id: apiChunk.id,
            object: apiChunk.object,
            created: apiChunk.created,
            modelId: apiChunk.model,
            choices: [responseChoice],
            responseTextDelta,
            toolCallsDeltas,
            isFinal,
            usage: finalUsage, // Only on the very final message from the stream
        };
    }


  /**
   * Maps the raw OpenAI API Embedding response to the standard ProviderEmbeddingResponse.
   * @private
   */
  private mapApiToEmbeddingResponse(
    apiResponse: OpenAIAPITypes.EmbeddingResponse
  ): ProviderEmbeddingResponse {
    return {
      object: 'list',
      data: apiResponse.data.map(d => ({
        object: 'embedding',
        embedding: d.embedding,
        index: d.index,
      })),
      model: apiResponse.model,
      usage: {
        prompt_tokens: apiResponse.usage.prompt_tokens,
        total_tokens: apiResponse.usage.total_tokens,
        costUSD: this.calculateCost(
          apiResponse.usage.prompt_tokens,
          0, // No completion tokens for embeddings
          apiResponse.model,
          true // isEmbedding
        ),
      },
    };
  }

  /**
   * Calculates token usage and cost.
   * @private
   */
  private calculateUsage(
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
    modelId: string
  ): ModelUsage {
    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      costUSD: this.calculateCost(usage.prompt_tokens, usage.completion_tokens, modelId),
    };
  }

  /**
   * Calculates the estimated cost of an API call.
   * @private
   */
  private calculateCost(
    promptTokens: number,
    completionTokens: number,
    modelId: string,
    isEmbedding: boolean = false
  ): number | undefined {
    const pricing = this.modelPricing[modelId];
    if (!pricing) return undefined; // Pricing info not available

    if (isEmbedding) {
      return (promptTokens / 1000) * pricing.input;
    }
    const inputCost = (promptTokens / 1000) * pricing.input;
    const outputCost = (completionTokens / 1000) * pricing.output;
    return inputCost + outputCost;
  }

  /**
   * Makes an API request to OpenAI with error handling and retries.
   * @private
   * @template T The expected response type.
   * @param {string} endpoint - The API endpoint (e.g., "/chat/completions").
   * @param {'GET' | 'POST'} method - HTTP method.
   * @param {string} apiKey - The API key to use.
   * @param {Record<string, unknown>} [body] - The request body for POST requests.
   * @param {boolean} [expectStream] - Whether the response is expected to be a stream.
   * @returns {Promise<T | ReadableStream<Uint8Array>>} The API response or stream.
   * @throws {OpenAIProviderError} If the request fails after retries or for non-retryable errors.
   */
  private async makeApiRequest<T = unknown>(
    endpoint: string,
    method: 'GET' | 'POST',
    apiKey: string,
    body?: Record<string, unknown>,
    expectStream?: false
  ): Promise<T>;
  private async makeApiRequest(
    endpoint: string,
    method: 'GET' | 'POST',
    apiKey: string,
    body: Record<string, unknown> | undefined,
    expectStream: true
  ): Promise<ReadableStream<Uint8Array>>;
  private async makeApiRequest<T = unknown>(
    endpoint: string,
    method: 'GET' | 'POST',
    apiKey: string,
    body?: Record<string, unknown>,
    expectStream: boolean = false
  ): Promise<T | ReadableStream<Uint8Array>> {
    const url = `${this.config.baseURL}${endpoint}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'User-Agent': 'AgentOS/1.0 (OpenAIProvider)',
      ...(this.config.customHeaders || {}),
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }
    if (this.config.organizationId) {
      headers['OpenAI-Organization'] = this.config.organizationId;
    }

    let lastError: Error = new OpenAIProviderError('Request failed after all retries.', 'MAX_RETRIES_REACHED');

    for (let attempt = 0; attempt < this.config.maxRetries!; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.requestTimeout);

      try {
        const requestOptions: RequestInit = {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        };

        const response = await fetch(url, requestOptions);
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorData: OpenAIAPITypes.APIErrorResponse = await response.json().catch(() => ({}));
          const errorMessage = errorData.error?.message || `HTTP error ${response.status}: ${response.statusText}`;
          const errorType = errorData.error?.type;
          const errorCode = errorData.error?.code;
          
          // Non-retryable errors
          if (response.status === 401 || response.status === 403 || response.status === 400 || response.status === 404) {
            throw new OpenAIProviderError(errorMessage, 'API_CLIENT_ERROR', errorCode || undefined, errorType, response.status, errorData);
          }
          // For other server errors or rate limits, prepare for retry
          lastError = new OpenAIProviderError(errorMessage, 'API_SERVER_ERROR', errorCode || undefined, errorType, response.status, errorData);
          if (response.status === 429) { // Rate limit
            lastError = new OpenAIProviderError(errorMessage, 'RATE_LIMIT_EXCEEDED', errorCode || undefined, errorType, response.status, errorData);
            const retryAfter = response.headers.get('retry-after'); // seconds
            const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : (2 ** attempt) * 1000;
            await new Promise(resolve => setTimeout(resolve, retryAfterMs));
            continue; // Retry
          }
          // Other retryable server errors
          if (response.status >= 500) {
            await new Promise(resolve => setTimeout(resolve, (2 ** attempt) * 1000)); // Exponential backoff
            continue; // Retry
          }
          throw lastError; // If not explicitly handled for retry, throw
        }

        if (expectStream) {
          if (!response.body) {
            throw new OpenAIProviderError('Expected a stream response but body was null.', 'STREAM_BODY_NULL');
          }
          return response.body;
        }
        return (await response.json()) as T;

      } catch (error: unknown) {
        clearTimeout(timeoutId);
        if (error instanceof OpenAIProviderError) { // If already our custom error, re-throw if not retryable
             if (error.code === 'API_CLIENT_ERROR') throw error;
             lastError = error;
        } else if (error instanceof Error && error.name === 'AbortError') {
          lastError = new OpenAIProviderError(`Request timed out after ${this.config.requestTimeout}ms.`, 'REQUEST_TIMEOUT', undefined, undefined, undefined, error);
        } else {
          lastError = new OpenAIProviderError(error instanceof Error ? error.message : 'Network or unknown error', 'NETWORK_ERROR', undefined, undefined, undefined, error);
        }
        
        if (attempt === this.config.maxRetries! - 1) {
          break; // Last attempt failed, break to throw lastError
        }
        // Exponential backoff for retries not handled by 429
        const delay = Math.min(30000, (1000 * (2 ** attempt)) + Math.random() * 1000); // Add jitter
        // Keep retry logs concise — network errors are common and the stack trace is noise
        const isNetwork = lastError instanceof OpenAIProviderError && lastError.code === 'NETWORK_ERROR';
        const shortMsg = isNetwork ? 'Network unreachable' : lastError.message;
        console.warn(`[LLM] Retry ${attempt + 1}/${this.config.maxRetries! - 1} in ${(delay / 1000).toFixed(1)}s — ${shortMsg}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    // For network errors, replace the cryptic cause chain with a clean message
    if (lastError instanceof OpenAIProviderError && lastError.code === 'NETWORK_ERROR') {
      throw new OpenAIProviderError(
        `Network error: unable to reach ${this.config.baseURL}. Check your internet connection.`,
        'NETWORK_ERROR',
      );
    }
    throw lastError; // Throw the last encountered error after all retries
  }

  /**
   * Parses an SSE (Server-Sent Events) stream.
   * @private
   */
  private async *parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        
        let eolIndex;
        // An SSE event is typically defined by "data: ...\n\n"
        // Or multiple "data: ..." lines followed by \n\n
        while ((eolIndex = buffer.indexOf('\n\n')) >= 0) {
            const messageBlock = buffer.substring(0, eolIndex);
            buffer = buffer.substring(eolIndex + 2); // +2 for \n\n

            const lines = messageBlock.split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const dataContent = line.substring('data: '.length).trim();
                    if (dataContent) { // Ensure not empty data string
                        yield dataContent;
                    }
                }
            }
        }
      }
      // Process any remaining data in the buffer (e.g. if stream ends without \n\n)
      if (buffer.startsWith('data: ')) {
        const dataContent = buffer.substring('data: '.length).trim();
        if (dataContent) yield dataContent;
      } else if (buffer.trim()) { // Sometimes final [DONE] might not be prefixed by "data: "
          if (buffer.trim() === "[DONE]") yield "[DONE]";
          else console.warn("OpenAIProvider: Trailing stream data not processed:", buffer);
      }

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Stream parsing error';
        console.error('OpenAIProvider: Error reading or parsing SSE stream:', message, error);
        throw new OpenAIProviderError(message, 'STREAM_PARSING_ERROR', undefined, undefined, undefined, error);
    } finally {
      // Ensure stream is closed if `break` or `return` is called within the generator
      if (!reader.closed) {
          await reader.cancel().catch(err => console.error("OpenAIProvider: Error cancelling stream reader:", err));
      }
      // console.log("OpenAIProvider: SSE Stream parsing finished.");
    }
  }
}
