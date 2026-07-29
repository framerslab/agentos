// File: backend/agentos/core/llm/providers/implementations/LiteLLMProvider.ts

/**
 * @fileoverview Implements the IProvider interface for LiteLLM, a unified AI
 * gateway that provides access to 100+ LLM providers (Anthropic, OpenAI,
 * Google, Bedrock, Azure, Ollama, etc.) through an OpenAI-compatible proxy.
 *
 * Like {@link GroqProvider}, this is a thin wrapper around {@link OpenAIProvider}
 * since the LiteLLM proxy exposes a fully OpenAI-compatible API. The wrapper
 * exists so AIModelProviderManager can identify LiteLLM-specific configuration
 * (provider ID, dynamic model catalog via `/v1/models`, etc.).
 *
 * @module backend/agentos/core/llm/providers/implementations/LiteLLMProvider
 * @implements {IProvider}
 */

import {
  IProvider,
  ChatMessage,
  ModelCompletionOptions,
  ModelCompletionResponse,
  ModelInfo,
  ProviderEmbeddingOptions,
  ProviderEmbeddingResponse,
} from '../IProvider';
import { OpenAIProvider } from './OpenAIProvider';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the LiteLLMProvider.
 *
 * @example
 * const config: LiteLLMProviderConfig = {
 *   apiKey: process.env.LITELLM_API_KEY!,
 *   baseURL: 'http://localhost:4000/v1',
 *   defaultModelId: 'anthropic/claude-sonnet-4-6',
 * };
 */
export interface LiteLLMProviderConfig {
  /** LiteLLM proxy master key or virtual key. */
  apiKey: string;
  /**
   * Base URL of the LiteLLM proxy.
   * @default "http://localhost:4000/v1"
   */
  baseURL?: string;
  /**
   * Default model to use when none is specified.
   * Uses LiteLLM's provider-prefixed format (e.g. "anthropic/claude-sonnet-4-6").
   * @default "gpt-4o-mini"
   */
  defaultModelId?: string;
  /** Request timeout in milliseconds. @default 60000 */
  requestTimeout?: number;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * @class LiteLLMProvider
 * @implements {IProvider}
 *
 * Thin wrapper around {@link OpenAIProvider} that targets a self-hosted
 * LiteLLM proxy. All request/response handling is delegated to the
 * underlying OpenAI provider since LiteLLM exposes a fully
 * OpenAI-compatible API.
 *
 * Models are dynamic and depend on the proxy configuration. Use
 * {@link listAvailableModels} to discover what the proxy serves.
 *
 * @example
 * const litellm = new LiteLLMProvider();
 * await litellm.initialize({
 *   apiKey: process.env.LITELLM_API_KEY!,
 *   baseURL: 'http://localhost:4000/v1',
 * });
 * const res = await litellm.generateCompletion(
 *   'anthropic/claude-sonnet-4-6',
 *   messages,
 *   {}
 * );
 */
export class LiteLLMProvider implements IProvider {
  /** @inheritdoc */
  public readonly providerId: string = 'litellm';
  /** @inheritdoc */
  public isInitialized: boolean = false;
  /** @inheritdoc */
  public defaultModelId?: string;

  private delegate = new OpenAIProvider();
  private proxyBaseURL: string = 'http://localhost:4000/v1';
  private proxyApiKey: string = '';

  constructor() {}

  /**
   * Initializes the provider by configuring the underlying OpenAI delegate
   * with the LiteLLM proxy URL and API key.
   */
  public async initialize(config: LiteLLMProviderConfig): Promise<void> {
    if (!config.apiKey) {
      throw new Error(
        'API key is required for LiteLLMProvider. Set LITELLM_API_KEY.',
      );
    }

    this.defaultModelId = config.defaultModelId ?? 'gpt-4o-mini';
    this.proxyBaseURL = config.baseURL ?? 'http://localhost:4000/v1';
    this.proxyApiKey = config.apiKey;

    await this.delegate.initialize({
      apiKey: config.apiKey,
      baseURL: this.proxyBaseURL,
      defaultModelId: this.defaultModelId,
      requestTimeout: config.requestTimeout ?? 60000,
    });

    this.isInitialized = true;
    console.log(
      `LiteLLMProvider initialized. Proxy: ${this.proxyBaseURL}, default model: ${this.defaultModelId}.`,
    );
  }

  /** @inheritdoc */
  public async generateCompletion(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
  ): Promise<ModelCompletionResponse> {
    return this.delegate.generateCompletion(modelId, messages, options);
  }

  /** @inheritdoc */
  public async *generateCompletionStream(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
  ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    yield* this.delegate.generateCompletionStream(modelId, messages, options);
  }

  /** @inheritdoc */
  public async generateEmbeddings(
    modelId: string,
    texts: string[],
    options?: ProviderEmbeddingOptions,
  ): Promise<ProviderEmbeddingResponse> {
    return this.delegate.generateEmbeddings(modelId, texts, options);
  }

  /**
   * Queries the LiteLLM proxy's `/v1/models` endpoint to discover
   * available models dynamically.
   */
  public async listAvailableModels(
    filter?: { capability?: string },
  ): Promise<ModelInfo[]> {
    try {
      const url = this.proxyBaseURL.replace(/\/+$/, '') + '/models';
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.proxyApiKey}` },
      });
      if (!response.ok) {
        return [];
      }
      const data = (await response.json()) as {
        data?: Array<{ id: string; owned_by?: string }>;
      };
      const models: ModelInfo[] = (data.data ?? []).map((m) => ({
        modelId: m.id,
        providerId: 'litellm',
        displayName: m.id,
        capabilities: ['chat'] as string[],
        supportsStreaming: true,
        status: 'active' as const,
      }));
      if (filter?.capability) {
        return models.filter((m) => m.capabilities.includes(filter.capability!));
      }
      return models;
    } catch {
      return [];
    }
  }

  /** @inheritdoc */
  public async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    const models = await this.listAvailableModels();
    return models.find((m) => m.modelId === modelId);
  }

  /** @inheritdoc */
  public async checkHealth(): Promise<{ isHealthy: boolean; details?: unknown }> {
    return this.delegate.checkHealth();
  }

  /** @inheritdoc */
  public async shutdown(): Promise<void> {
    await this.delegate.shutdown();
    this.isInitialized = false;
    console.log('LiteLLMProvider shutdown complete.');
  }
}
