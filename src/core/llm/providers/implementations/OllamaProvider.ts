// File: backend/agentos/core/llm/providers/implementations/OllamaProvider.ts

/**
 * @fileoverview Implements the IProvider interface for Ollama, enabling interaction
 * with locally hosted large language models. This provider supports chat completions,
 * streaming, embedding generation (if the Ollama model supports it), and model introspection.
 *
 * Key features:
 * - Connects to a specified Ollama instance.
 * - Standardized chat completion and streaming API.
 * - Embedding generation via Ollama's `/api/embeddings` endpoint.
 * - Listing of available local models.
 * - Health checks for the Ollama service.
 * - Adherence to AgentOS architectural principles, including custom error handling and comprehensive JSDoc.
 *
 * @module backend/agentos/core/llm/providers/implementations/OllamaProvider
 * @implements {IProvider}
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import {
  IProvider,
  ChatMessage,
  MessageContentPart,
  ModelCompletionOptions,
  ModelCompletionResponse,
  ModelInfo,
  ModelUsage,
  ProviderEmbeddingOptions,
  ProviderEmbeddingResponse,
  EmbeddingObject,
} from '../IProvider';
import { stripOpenRouterOnlyParams } from '../openrouter-only-params';
import { OllamaProviderError } from '../errors/OllamaProviderError';

/**
 * Configuration specific to the OllamaProvider.
 */
export interface OllamaProviderConfig {
  /**
   * The base URL of the Ollama API.
   * Accepts both `baseURL` and `baseUrl` for compatibility.
   * @example "http://localhost:11434" (Ollama's default)
   */
  baseURL?: string;
  /** Alias for baseURL (camelCase variant accepted by callers). */
  baseUrl?: string;
  /**
   * Default model ID to use if not specified in a request (e.g., "llama3:latest").
   * This model must be available in the connected Ollama instance.
   */
  defaultModelId?: string;
  /**
   * Timeout for API requests to Ollama in milliseconds.
   * @default 60000 (60 seconds)
   */
  requestTimeout?: number;
  /**
   * Optional API key if the Ollama instance is secured (not common for local instances).
   * Currently, Ollama itself does not use API keys for authentication.
   */
  apiKey?: string;
}

// --- Ollama Specific API Types ---

/**
 * Represents the structure of a chat message as expected by Ollama's /api/chat.
 * Ollama supports tool calling since v0.3 (mid-2024) for compatible models
 * (qwen2.5, qwen3, llama3.1+, mistral, command-r+, etc.).
 */
interface OllamaChatMessage {
  role: ChatMessage['role'];
  content: string;
  images?: string[]; // Base64 encoded images, if the model supports vision
  /** Tool calls requested by the assistant (present on assistant messages). */
  tool_calls?: Array<{
    id?: string;
    type?: 'function';
    function: {
      name: string;
      arguments: Record<string, unknown> | string;
    };
  }>;
}

/**
 * Represents the response structure from Ollama's /api/chat endpoint (non-streaming and streaming chunks).
 */
interface OllamaChatResponseChunk {
  model: string;
  created_at: string;
  message?: {
    role: ChatMessage['role'];
    content: string;
    /** Tool calls returned by Ollama for tool-capable models. */
    tool_calls?: Array<{
      id?: string;
      type?: 'function';
      function: {
        name: string;
        /** Ollama returns arguments as an object (not a JSON string like OpenAI). */
        arguments: Record<string, unknown> | string;
      };
    }>;
  };
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  error?: string;
}

const extractErrorMessage = (data: unknown): string | undefined => {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const candidate = (data as { error?: unknown }).error;
  return typeof candidate === 'string' ? candidate : undefined;
};

/**
 * Represents the request structure for Ollama's /api/embeddings endpoint.
 */
interface OllamaEmbeddingRequest {
  model: string;
  prompt: string; // Ollama takes a single text prompt for embedding
  options?: Record<string, unknown>; // Model-specific options
}

/**
 * Represents the response structure from Ollama's /api/embeddings endpoint.
 */
interface OllamaEmbeddingResponse {
  embedding: number[];
  // Ollama currently does not provide usage tokens for embeddings.
}

type TextContentPart = Extract<MessageContentPart, { type: 'text' }>;
type ImageUrlContentPart = Extract<MessageContentPart, { type: 'image_url' }>;

const isTextContentPart = (part: MessageContentPart): part is TextContentPart =>
  part.type === 'text' && typeof (part as Record<string, unknown>).text === 'string';

const isImageUrlContentPart = (part: MessageContentPart): part is ImageUrlContentPart =>
  part.type === 'image_url'
  && typeof (part as Record<string, unknown>).image_url === 'object'
  && part.image_url !== null
  && typeof part.image_url.url === 'string';

const extractBase64ImagePayload = (url: string): string | null => {
  const trimmed = url.trim();
  if (!trimmed.startsWith('data:')) return null;

  const marker = ';base64,';
  const markerIndex = trimmed.indexOf(marker);
  if (markerIndex === -1) return null;

  const payload = trimmed.slice(markerIndex + marker.length).trim();
  return payload.length > 0 ? payload : null;
};

/**
 * Represents a model listed by Ollama's /api/tags endpoint.
 */
interface OllamaModelTag {
  name: string; // Full model name including tag, e.g., "llama3:8b"
  model: string; // Base model name, e.g., "llama3"
  modified_at: string;
  size: number; // Size in bytes
  digest: string;
  _details?: {
    parent_model: string;
    format: string;
    family: string;
    families: string[] | null;
    parameter_size: string; // e.g., "8B"
    quantization_level: string; // e.g., "Q4_0"
  };
}

/**
 * Represents the response from Ollama's /api/tags endpoint.
 */
interface OllamaListTagsResponse {
  models: OllamaModelTag[];
}


/**
 * @class OllamaProvider
 * @implements {IProvider}
 * Provides an interface to locally hosted LLMs through an Ollama instance.
 * It handles API requests for chat completions, streaming, embeddings, and model listing.
 */
export class OllamaProvider implements IProvider {
  /** @inheritdoc */
  public readonly providerId: string = 'ollama';
  /** @inheritdoc */
  public isInitialized: boolean = false;
  /** @inheritdoc */
  public defaultModelId?: string;

  private config!: OllamaProviderConfig;
  private client!: AxiosInstance;

  /**
   * Creates an instance of OllamaProvider.
   * The provider must be initialized using `initialize()` before use.
   */
  constructor() {}

  /** @inheritdoc */
  public async initialize(config: OllamaProviderConfig): Promise<void> {
    // Normalize: accept both baseURL and baseUrl (camelCase variant from callers)
    const resolvedBaseURL = config.baseURL || config.baseUrl;
    if (!resolvedBaseURL) {
      throw new OllamaProviderError(
        'Ollama baseURL is required for initialization.',
        'INIT_FAILED_MISSING_BASEURL'
      );
    }
    // Strip /v1 suffix if present — callers may pass the OpenAI-compatible URL,
    // but OllamaProvider uses the native Ollama API (/api/tags, /api/generate).
    const normalizedBaseURL = resolvedBaseURL.replace(/\/v1\/?$/, '');
    this.config = {
      requestTimeout: 60000, // Default 60 seconds
      ...config,
      baseURL: normalizedBaseURL,
    };
    this.defaultModelId = config.defaultModelId;

    this.client = axios.create({
      baseURL: normalizedBaseURL.endsWith('/api') ? normalizedBaseURL : `${normalizedBaseURL}/api`,
      timeout: this.config.requestTimeout,
      headers: {
        'Content-Type': 'application/json',
        // Ollama typically does not require an API key for local instances.
        // If a proxy in front of Ollama needs one, it could be added here via config.apiKey.
        ...(this.config.apiKey ? { 'Authorization': `Bearer ${this.config.apiKey}` } : {}),
      },
    });

    try {
      // Verify connection — Ollama's root endpoint (/) returns "Ollama is running".
      // We use the raw baseURL (not /api) since /api/ returns 404.
      await axios.get(normalizedBaseURL);
      this.isInitialized = true;
      console.log(`OllamaProvider initialized successfully. Base URL: ${this.client.defaults.baseURL}. Default model: ${this.defaultModelId || 'Not set'}`);
    } catch (error: unknown) {
      this.isInitialized = false;
      const axiosError = error as AxiosError;
      const _details = {
        baseURL: this.client.defaults.baseURL,
        status: axiosError.response?.status,
        data: axiosError.response?.data,
      };
      throw new OllamaProviderError(
        `OllamaProvider initialization failed: Could not connect to Ollama at ${this.client.defaults.baseURL}. Ensure Ollama is running and accessible. Error: ${axiosError.message}`,
        'INITIALIZATION_FAILED',
        axiosError.response?.status,
        _details
      );
    }
  }

  /**
   * Ensures the provider is initialized.
   * @private
   * @throws {OllamaProviderError} If not initialized.
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new OllamaProviderError(
        'OllamaProvider is not initialized. Call initialize() first.',
        'PROVIDER_NOT_INITIALIZED'
      );
    }
  }

  /**
   * Transforms standard ChatMessage array to Ollama's expected format.
   * @private
   */
  private mapToOllamaMessages(messages: ChatMessage[]): OllamaChatMessage[] {
    return messages.map(msg => {
      // Handle tool role messages (tool execution results)
      if (msg.role === 'tool') {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
        return { role: 'tool' as const, content };
      }

      // Handle assistant messages with tool_calls
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        const ollamaMsg: OllamaChatMessage = {
          role: 'assistant',
          content: typeof msg.content === 'string' ? msg.content : (msg.content ? JSON.stringify(msg.content) : ''),
          tool_calls: msg.tool_calls.map(tc => ({
            id: tc.id,
            type: tc.type,
            function: {
              name: tc.function.name,
              // Ollama expects arguments as an object; OpenAI sends them as a JSON string
              arguments: typeof tc.function.arguments === 'string'
                ? (() => { try { return JSON.parse(tc.function.arguments); } catch { return tc.function.arguments; } })()
                : tc.function.arguments,
            },
          })),
        };
        return ollamaMsg;
      }

      if (typeof msg.content !== 'string') {
        if (Array.isArray(msg.content)) {
          const textContent = msg.content
            .filter(isTextContentPart)
            .map((part) => part.text.trim())
            .filter(Boolean)
            .join('\n');
          const images = msg.content
            .filter(isImageUrlContentPart)
            .map((part) => extractBase64ImagePayload(part.image_url.url))
            .filter((value): value is string => typeof value === 'string' && value.length > 0);

          return {
            role: msg.role,
            content: textContent || JSON.stringify(msg.content),
            ...(images.length > 0 ? { images } : {}),
          };
        }
        return { role: msg.role, content: JSON.stringify(msg.content) };
      }
      return {
        role: msg.role,
        content: msg.content,
      };
    });
  }

  /** @inheritdoc */
  public async generateCompletion(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions
  ): Promise<ModelCompletionResponse> {
    this.ensureInitialized();
    const ollamaMessages = this.mapToOllamaMessages(messages);

    // Build tools array for Ollama (OpenAI-compatible format)
    const ollamaTools = this.mapToolsForOllama(options.tools);

    const payload: Record<string, unknown> = {
      model: modelId,
      messages: ollamaMessages,
      stream: false,
      options: {
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.topP !== undefined && { top_p: options.topP }),
        ...(options.maxTokens !== undefined && { num_predict: options.maxTokens }),
        ...(options.presencePenalty !== undefined && { presence_penalty: options.presencePenalty }),
        ...(options.frequencyPenalty !== undefined && { frequency_penalty: options.frequencyPenalty }),
        ...(options.stopSequences !== undefined && { stop: options.stopSequences }),
        // OpenRouter-only routing controls never reach Ollama's options bag.
        ...(stripOpenRouterOnlyParams(options.customModelParams) || {}),
      },
      format: options.responseFormat?.type === 'json_object' ? 'json' : undefined,
      ...(ollamaTools.length > 0 && { tools: ollamaTools }),
    };

    try {
      // CR8: honor a per-call requestTimeout override over the client default.
      const response = await this.client.post('/chat', payload, { timeout: options.requestTimeout ?? this.config.requestTimeout });
      const data = response.data as OllamaChatResponseChunk;

      if (data.error) {
        throw new OllamaProviderError(
            `Ollama API error for model ${modelId}: ${data.error}`,
            'API_ERROR',
            response.status,
            data
        );
      }

      const promptTokens = data.prompt_eval_count || 0;
      const completionTokens = data.eval_count || 0;
      const usage: ModelUsage = {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        costUSD: 0,
      };

      // Normalize tool_calls: Ollama returns arguments as objects, IProvider expects JSON strings
      const normalizedToolCalls = this.normalizeToolCalls(data.message?.tool_calls);
      const hasToolCalls = normalizedToolCalls.length > 0;

      return {
        id: `ollama-${modelId}-${Date.now()}`,
        object: 'chat.completion',
        created: data.created_at ? new Date(data.created_at).getTime() / 1000 : Math.floor(Date.now() / 1000),
        modelId: data.model || modelId,
        choices: data.message ? [{
          index: 0,
          message: {
            role: data.message.role,
            content: data.message.content,
            ...(hasToolCalls && { tool_calls: normalizedToolCalls }),
          },
          finishReason: hasToolCalls ? 'tool_calls' : (data.done ? 'stop' : 'length'),
        }] : [],
        usage,
      };
    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const errorData = axiosError.response?.data;
      const message = extractErrorMessage(errorData) || axiosError.message || 'Unknown Ollama API error';
      throw new OllamaProviderError(
        message,
        'API_REQUEST_FAILED',
        status,
        { requestPayload: payload, responseData: errorData }
      );
    }
  }

  /** @inheritdoc */
  public async *generateCompletionStream(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions
  ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    this.ensureInitialized();
    const ollamaMessages = this.mapToOllamaMessages(messages);
    const ollamaTools = this.mapToolsForOllama(options.tools);

    const payload: Record<string, unknown> = {
      model: modelId,
      messages: ollamaMessages,
      stream: true,
      options: {
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.topP !== undefined && { top_p: options.topP }),
        ...(options.maxTokens !== undefined && { num_predict: options.maxTokens }),
        ...(options.presencePenalty !== undefined && { presence_penalty: options.presencePenalty }),
        ...(options.frequencyPenalty !== undefined && { frequency_penalty: options.frequencyPenalty }),
        ...(options.stopSequences !== undefined && { stop: options.stopSequences }),
        // OpenRouter-only routing controls never reach Ollama's options bag.
        ...(stripOpenRouterOnlyParams(options.customModelParams) || {}),
      },
      format: options.responseFormat?.type === 'json_object' ? 'json' : undefined,
      ...(ollamaTools.length > 0 && { tools: ollamaTools }),
    };

    let responseStream;
    try {
      // CR8: honor a per-call requestTimeout override over the client default.
      responseStream = await this.client.post('/chat', payload, { responseType: 'stream', timeout: options.requestTimeout ?? this.config.requestTimeout });
    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const errorData = axiosError.response?.data as (OllamaChatResponseChunk | undefined);
      const message = extractErrorMessage(errorData) || axiosError.message || 'Failed to connect to Ollama stream.';
      throw new OllamaProviderError(
        message,
        'STREAM_CONNECTION_FAILED',
        status,
        { requestPayload: payload, responseData: errorData }
      );
    }

    const stream = responseStream.data as NodeJS.ReadableStream & { destroy?: () => void };
    let accumulatedContent = "";
    const accumulatedToolCalls: ChatMessage['tool_calls'] & Array<any> = [];
    let finalUsage: ModelUsage | undefined;
    let responseId = `ollama-stream-${modelId}-${Date.now()}`;

    const abortSignal = options.abortSignal;
    if (abortSignal?.aborted) {
      yield { id: `ollama-abort-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), modelId, choices: [], error: { message: 'Stream aborted prior to first chunk', type: 'abort' }, isFinal: true };
      return;
    }
    const abortHandler = () => {
      // We rely on loop check to emit final chunk; no direct stream destroy to keep portability.
    };
    abortSignal?.addEventListener('abort', abortHandler, { once: true });

    try {
      for await (const chunk of stream) {
        if (abortSignal?.aborted) {
          yield { id: `ollama-abort-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), modelId, choices: [], error: { message: 'Stream aborted by caller', type: 'abort' }, isFinal: true };
          break;
        }
        const chunkString = chunk.toString();
        // Ollama stream sends multiple JSON objects, newline-separated.
        const jsonObjects = chunkString.split('\n').filter(Boolean);

        for (const jsonObjStr of jsonObjects) {
          try {
            const parsedChunk = JSON.parse(jsonObjStr) as OllamaChatResponseChunk;
            responseId = `ollama-stream-${parsedChunk.model || modelId}-${new Date(parsedChunk.created_at).getTime()}`;

            if (parsedChunk.error) {
                yield {
                    id: responseId, object: 'chat.completion.chunk', created: new Date(parsedChunk.created_at).getTime()/1000,
                    modelId: parsedChunk.model || modelId, choices: [], isFinal: true,
                    error: { message: parsedChunk.error, type: 'ollama_api_error' }
                };
                return; // Terminate stream on error
            }

            const deltaContent = parsedChunk.message?.content || "";
            if (deltaContent) accumulatedContent += deltaContent;

            // Handle tool_calls in stream chunks
            const chunkToolCalls = parsedChunk.message?.tool_calls;
            const normalizedChunkToolCalls = this.normalizeToolCalls(chunkToolCalls);
            const hasChunkToolCalls = normalizedChunkToolCalls.length > 0;
            if (hasChunkToolCalls) {
              accumulatedToolCalls.push(...normalizedChunkToolCalls);
            }

            const isFinalChunk = parsedChunk.done;
            if (isFinalChunk) {
              const promptTokens = parsedChunk.prompt_eval_count || 0;
              const completionTokens = parsedChunk.eval_count || 0;
              finalUsage = {
                promptTokens,
                completionTokens,
                totalTokens: promptTokens + completionTokens,
                costUSD: 0,
              };
            }

            const hasAnyToolCalls = accumulatedToolCalls.length > 0;

            yield {
              id: responseId,
              object: 'chat.completion.chunk',
              created: new Date(parsedChunk.created_at).getTime() / 1000,
              modelId: parsedChunk.model || modelId,
              choices: parsedChunk.message ? [{
                index: 0,
                message: {
                  role: parsedChunk.message.role || 'assistant',
                  content: accumulatedContent,
                  ...(isFinalChunk && hasAnyToolCalls && { tool_calls: accumulatedToolCalls }),
                },
                finishReason: isFinalChunk ? (hasAnyToolCalls ? 'tool_calls' : 'stop') : null,
              }] : [],
              responseTextDelta: deltaContent,
              isFinal: isFinalChunk,
              usage: isFinalChunk ? finalUsage : undefined,
            };

            if (isFinalChunk) return;
          } catch (parseError: unknown) {
            console.warn('OllamaProvider: Could not parse stream chunk JSON:', jsonObjStr, parseError);
            // Optionally yield an error chunk or decide to continue
          }
        }
      }
    } catch (streamError: unknown) {
      const message = streamError instanceof Error ? streamError.message : 'Ollama stream processing error';
      console.error(`OllamaProvider stream error for model ${modelId}:`, message, streamError);
      // Yield a final error chunk to the consumer
      yield {
        id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        modelId: modelId, choices: [], isFinal: true,
        error: { message, type: 'STREAM_PROCESSING_ERROR' }
      };
    } finally {
        stream?.destroy?.();
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
      throw new OllamaProviderError('Input texts array cannot be empty for embeddings.', 'EMBEDDING_NO_INPUT');
    }
    // Ollama's /api/embeddings endpoint currently takes one prompt (text) at a time.
    // We need to batch these requests if multiple texts are provided.
    const embeddingsData: EmbeddingObject[] = [];
    const totalPromptTokens = 0; // Ollama doesn't provide token counts for embeddings yet.

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const payload: OllamaEmbeddingRequest = {
        model: modelId,
        prompt: text,
        // Pass through custom model options minus OpenRouter routing controls.
        options: stripOpenRouterOnlyParams(options?.customModelParams),
      };

      try {
        const response = await this.client.post('/embeddings', payload);
        const embeddingResponse = response.data as OllamaEmbeddingResponse;
        embeddingsData.push({
          object: 'embedding',
          embedding: embeddingResponse.embedding,
          index: i,
        });
        // totalPromptTokens += calculate_tokens_for(text); // Hypothetical token calculation
      } catch (error: unknown) {
        const axiosError = error as AxiosError;
        const status = axiosError.response?.status;
        const errorData = axiosError.response?.data as Record<string, unknown> | undefined;
        const message =
          extractErrorMessage(errorData) || axiosError.message || `Failed to generate embedding for text index ${i}`;
        throw new OllamaProviderError(
          message,
          'EMBEDDING_FAILED',
          status,
          { requestPayload: payload, textIndex: i, responseData: errorData }
        );
      }
    }

    return {
      object: 'list',
      data: embeddingsData,
      model: modelId,
      usage: {
        prompt_tokens: totalPromptTokens, // This will be 0 until Ollama provides this info or we add local tokenization
        total_tokens: totalPromptTokens,
        costUSD: 0, // Local embeddings
      },
    };
  }

  /** @inheritdoc */
  public async listAvailableModels(filter?: { capability?: string }): Promise<ModelInfo[]> {
    this.ensureInitialized();
    try {
      const response = await this.client.get('/tags');
      const apiModels = (response.data as OllamaListTagsResponse).models;

      const modelInfos: ModelInfo[] = apiModels.map((model: OllamaModelTag) => {
        const capabilities: ModelInfo['capabilities'] = ['chat', 'completion'];
        if (model._details?.families?.includes('clip') || model.name.includes('llava') || model.name.includes('bakllava')) {
            capabilities.push('vision_input');
        }

        // Tool calling support — Ollama supports tools for most modern chat models.
        // Models that support tool calling include qwen2.5+, qwen3, llama3.1+, mistral,
        // command-r+, phi3+, granite3, firefunction, hermes, etc.
        // We add tool_use for all chat models; Ollama gracefully ignores tools for
        // models that don't support them.
        capabilities.push('tool_use');

        let contextWindow: number | undefined = 4096;
        const family = model._details?.family?.toLowerCase();
        const paramSize = model._details?.parameter_size?.toLowerCase();

        if (family) {
            if (family.includes("qwen3") || family.includes("qwen2.5")) contextWindow = 32768;
            else if (family.includes("qwen2")) contextWindow = 32768;
            else if (family.includes("llama3") || family.includes("llama-3")) contextWindow = 8192;
            else if (family.includes("llama2") || family.includes("llama-2")) contextWindow = 4096;
            else if (family.includes("codellama")) contextWindow = 16000;
            else if (family.includes("mistral") && (paramSize?.includes("7b") || paramSize?.includes("8x7b"))) contextWindow = 32768;
            else if (family.includes("phi4") || family.includes("phi-4")) contextWindow = 16384;
            else if (family.includes("phi3") || family.includes("phi-3")) {
                if (paramSize?.includes("mini") && (paramSize?.includes("128k") || model.name.includes("128k"))) contextWindow = 131072;
                else if (paramSize?.includes("mini") && (paramSize?.includes("4k") || model.name.includes("4k"))) contextWindow = 4096;
                else if (paramSize?.includes("small")) contextWindow = 8192;
                else if (paramSize?.includes("medium")) contextWindow = 131072;
            }
            else if (family.includes("gemma2") || family.includes("gemma-2")) contextWindow = 8192;
            else if (family.includes("command-r")) contextWindow = 131072;
        }


        return {
          modelId: model.name, // e.g., "llama3:latest", "mistral:7b-instruct-q4_0"
          providerId: this.providerId,
          displayName: model.name,
          description: `Ollama model: ${model._details?.family || model.model} (${model._details?.parameter_size || 'size unknown'}), Format: ${model._details?.format || 'unknown'}`,
          capabilities,
          contextWindowSize: contextWindow,
          // Output/Input token limits are often the same as context window for Ollama models.
          // Pricing is not applicable for local Ollama models.
          pricePer1MTokensInput: 0,
          pricePer1MTokensOutput: 0,
          supportsStreaming: true, // Most Ollama chat models support streaming
          lastUpdated: model.modified_at,
          status: 'active',
        };
      });

      if (filter?.capability) {
        return modelInfos.filter(m => m.capabilities.includes(filter.capability!));
      }
      return modelInfos;

    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      throw new OllamaProviderError(
        `Failed to list available Ollama models: ${axiosError.message}`,
        'LIST_MODELS_FAILED',
        status,
        axiosError.response?.data
      );
    }
  }

  /** @inheritdoc */
  public async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    this.ensureInitialized();
    // Ollama's /api/show endpoint provides detailed info for a specific model
    try {
      const response = await this.client.post('/show', { name: modelId });
      const detailedInfo = response.data as { modelfile?: string; parameters?: string; template?: string; _details?: any };
      // Note: detailedInfo._details is available but not currently used; future versions may enrich ModelInfo with it.

      // Attempt to map this to ModelInfo, might need more robust parsing
      const models = await this.listAvailableModels(); // Get the base info
      const baseInfo = models.find(m => m.modelId === modelId);
      if (!baseInfo) return undefined;

      // Enrich with _details from /show if possible
      // For example, extract more specific parameter_size, quantization etc. from _details if not already in baseInfo.description
      // This is highly dependent on the output of /api/show for the specific model.
      // As a simple step, we'll return the info from listAvailableModels as it's more standardized.
      // A more advanced version would merge data from /show into the ModelInfo.
      return {
          ...baseInfo,
          description: `${baseInfo.description}. Parameters: ${detailedInfo.parameters?.split('\n').filter(Boolean).join(', ') || 'N/A'}`
      };

    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      if (axiosError.response?.status === 404) {
        return undefined; // Model not found
      }
      throw new OllamaProviderError(
        `Failed to get info for Ollama model '${modelId}': ${axiosError.message}`,
        'GET_MODEL_INFO_FAILED',
        axiosError.response?.status,
        axiosError.response?.data
      );
    }
  }

  /** @inheritdoc */
  public async checkHealth(): Promise<{ isHealthy: boolean; _details?: unknown }> {
    this.ensureInitialized(); // Ensures client is created
    try {
      const response = await this.client.get('/'); // Check base Ollama endpoint
      // Ollama returns "Ollama is running" with a 200 OK on its root path.
      if (response.status === 200 && typeof response.data === 'string' && response.data.includes("Ollama is running")) {
        return { isHealthy: true, _details: { message: response.data } };
      }
      return { isHealthy: false, _details: { status: response.status, data: response.data } };
    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      return {
        isHealthy: false,
        _details: {
          message: `Ollama health check failed: ${axiosError.message}`,
          status: axiosError.response?.status,
          data: axiosError.response?.data,
        },
      };
    }
  }

  // --------------------------------------------------------------------------
  // Tool calling helpers
  // --------------------------------------------------------------------------

  /**
   * Convert AgentOS tool definitions to Ollama's expected format.
   * Ollama uses the same schema as OpenAI: { type: 'function', function: { name, description, parameters } }
   */
  private mapToolsForOllama(tools?: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    if (!tools || tools.length === 0) return [];
    return tools.filter(t => {
      // Accept both { type: 'function', function: { name, ... } } and { name, description, inputSchema }
      const fn = (t as any)?.function;
      return fn?.name || (t as any)?.name;
    }).map(t => {
      const fn = (t as any)?.function;
      if (fn?.name) return t; // Already in OpenAI format
      // Convert from AgentOS ITool format
      return {
        type: 'function',
        function: {
          name: (t as any).name,
          description: (t as any).description ?? '',
          parameters: (t as any).inputSchema ?? (t as any).parameters ?? { type: 'object' },
        },
      };
    });
  }

  /**
   * Normalize Ollama tool_calls to IProvider ChatMessage format.
   * Ollama returns arguments as objects; IProvider expects JSON strings with stable IDs.
   */
  private normalizeToolCalls(
    toolCalls?: Array<{ id?: string; type?: string; function: { name: string; arguments: Record<string, unknown> | string } }>,
  ): NonNullable<ChatMessage['tool_calls']> {
    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) return [];
    let callIndex = 0;
    return toolCalls.map(tc => {
      const args = tc.function?.arguments;
      return {
        id: tc.id || `call_ollama_${Date.now()}_${callIndex++}`,
        type: 'function' as const,
        function: {
          name: tc.function?.name || 'unknown',
          arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        },
      };
    });
  }

  /** @inheritdoc */
  public async shutdown(): Promise<void> {
    this.isInitialized = false;
    console.log('OllamaProvider shutdown complete.');
  }
}
