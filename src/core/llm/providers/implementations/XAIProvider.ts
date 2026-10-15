// File: backend/agentos/core/llm/providers/implementations/XAIProvider.ts

/**
 * @fileoverview Implements the IProvider interface for xAI's Grok API.
 *
 * xAI exposes a fully OpenAI-compatible `/v1/chat/completions` endpoint at
 * `https://api.x.ai`. This provider delegates to the existing {@link OpenAIProvider}
 * with xAI's base URL and credentials, providing xAI-specific provider identity
 * and a curated catalog of Grok models.
 *
 * @module backend/agentos/core/llm/providers/implementations/XAIProvider
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
import { contentSafeConsole as console } from '../../../logging/contentSafeConsole.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the XAIProvider.
 *
 * @example
 * const config: XAIProviderConfig = {
 *   apiKey: process.env.XAI_API_KEY!,
 *   defaultModelId: 'grok-2',
 * };
 */
export interface XAIProviderConfig {
  /** xAI API key. Sourced from `XAI_API_KEY`. */
  apiKey: string;
  /**
   * Base URL override.
   * @default "https://api.x.ai/v1"
   */
  baseURL?: string;
  /**
   * Default model to use when none is specified.
   * @default "grok-2"
   */
  defaultModelId?: string;
  /** Request timeout in milliseconds. @default 60000 */
  requestTimeout?: number;
}

// ---------------------------------------------------------------------------
// Known model catalog
// ---------------------------------------------------------------------------

/** Static catalog of well-known xAI Grok models. */
const XAI_MODELS: ModelInfo[] = [
  {
    modelId: 'grok-2',
    providerId: 'xai',
    displayName: 'Grok 2',
    description: 'xAI flagship model with strong reasoning and real-time knowledge.',
    capabilities: ['chat', 'tool_use'],
    contextWindowSize: 131072,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'grok-2-mini',
    providerId: 'xai',
    displayName: 'Grok 2 Mini',
    description: 'Smaller, faster xAI model for cost-effective everyday tasks.',
    capabilities: ['chat', 'tool_use'],
    contextWindowSize: 131072,
    supportsStreaming: true,
    status: 'active',
  },
];

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * @class XAIProvider
 * @implements {IProvider}
 *
 * Thin wrapper around {@link OpenAIProvider} that targets xAI's
 * OpenAI-compatible Grok API endpoint. xAI's Grok models are known for
 * wit, real-time knowledge, and strong reasoning capabilities.
 *
 * @example
 * const xai = new XAIProvider();
 * await xai.initialize({ apiKey: process.env.XAI_API_KEY! });
 * const res = await xai.generateCompletion('grok-2', messages, {});
 */
export class XAIProvider implements IProvider {
  /** @inheritdoc */
  public readonly providerId: string = 'xai';
  /** @inheritdoc */
  public isInitialized: boolean = false;
  /** @inheritdoc */
  public defaultModelId?: string;

  /**
   * Internal OpenAI provider instance that handles the actual API communication.
   * xAI's API is fully OpenAI-compatible, so we reuse the OpenAI transport layer.
   */
  private delegate = new OpenAIProvider();

  constructor() {}

  /**
   * Initializes the provider by configuring the underlying OpenAI delegate
   * with xAI's base URL and the caller's API key.
   *
   * @param {XAIProviderConfig} config - xAI-specific configuration.
   * @returns {Promise<void>}
   * @throws {Error} If the API key is missing.
   */
  public async initialize(config: XAIProviderConfig): Promise<void> {
    if (!config.apiKey) {
      throw new Error('API key is required for XAIProvider. Set XAI_API_KEY.');
    }

    this.defaultModelId = config.defaultModelId ?? 'grok-2';

    // Delegate to OpenAI provider with xAI's endpoint
    await this.delegate.initialize({
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? 'https://api.x.ai/v1',
      defaultModelId: this.defaultModelId,
      requestTimeout: config.requestTimeout ?? 60000,
    });

    this.isInitialized = true;
    console.log(`XAIProvider initialized. Default model: ${this.defaultModelId}.`);
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

  /**
   * xAI does not currently offer an embeddings API.
   *
   * @throws {Error} Always — embeddings are not supported on xAI.
   */
  public async generateEmbeddings(
    _modelId: string,
    _texts: string[],
    _options?: ProviderEmbeddingOptions,
  ): Promise<ProviderEmbeddingResponse> {
    throw new Error('xAI does not currently support embeddings. Use a dedicated embedding provider.');
  }

  /**
   * Returns a static catalog of known xAI Grok models.
   *
   * @param {{ capability?: string }} [filter] - Optional capability filter.
   * @returns {Promise<ModelInfo[]>} xAI model catalog.
   */
  public async listAvailableModels(filter?: { capability?: string }): Promise<ModelInfo[]> {
    if (filter?.capability) {
      return XAI_MODELS.filter(m => m.capabilities.includes(filter.capability!));
    }
    return [...XAI_MODELS];
  }

  /** @inheritdoc */
  public async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    return XAI_MODELS.find(m => m.modelId === modelId);
  }

  /** @inheritdoc */
  public async checkHealth(): Promise<{ isHealthy: boolean; details?: unknown }> {
    return this.delegate.checkHealth();
  }

  /** @inheritdoc */
  public async shutdown(): Promise<void> {
    await this.delegate.shutdown();
    this.isInitialized = false;
    console.log('XAIProvider shutdown complete.');
  }
}
