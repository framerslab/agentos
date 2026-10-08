// File: backend/agentos/core/llm/providers/implementations/MistralProvider.ts

/**
 * @fileoverview Implements the IProvider interface for Mistral AI's inference API.
 *
 * Mistral AI exposes a fully OpenAI-compatible `/v1/chat/completions` endpoint
 * at `https://api.mistral.ai`. This provider delegates to the existing
 * {@link OpenAIProvider} with Mistral's base URL and API key, providing
 * Mistral-specific provider identity and a curated model catalog.
 *
 * @module backend/agentos/core/llm/providers/implementations/MistralProvider
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
import { sha256Hex } from '../../../utils/sha256';
import { OpenAIProvider } from './OpenAIProvider';

/** Mistral accepts only tool call ids made of nine letters and digits. */
const MISTRAL_TOOL_CALL_ID = /^[A-Za-z0-9]{9}$/;

/**
 * A tool call id in the form Mistral accepts. Mistral rejects any other id
 * with HTTP 400, and a conversation can carry ids another provider issued
 * (`call_...`, `toolu_...`, `call_gemini_...`) through session history or a
 * fallback that continues after completed tool rounds. Those map to a stable
 * nine-character digest, so a call and its result keep matching ids.
 *
 * @param id Tool call id as recorded.
 * @returns The id itself when Mistral accepts it, else its digest.
 */
export function toMistralToolCallId(id: string): string {
  if (MISTRAL_TOOL_CALL_ID.test(id)) return id;
  return sha256Hex(id).slice(0, 9);
}

/** The messages with every tool call id in Mistral's form. */
function withMistralToolCallIds(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool' && m.tool_call_id) {
      return { ...m, tool_call_id: toMistralToolCallId(m.tool_call_id) };
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return { ...m, tool_calls: m.tool_calls.map((tc) => ({ ...tc, id: toMistralToolCallId(tc.id) })) };
    }
    return m;
  });
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the MistralProvider.
 *
 * @example
 * const config: MistralProviderConfig = {
 *   apiKey: process.env.MISTRAL_API_KEY!,
 *   defaultModelId: 'mistral-large-latest',
 * };
 */
export interface MistralProviderConfig {
  /** Mistral API key. Sourced from `MISTRAL_API_KEY`. */
  apiKey: string;
  /**
   * Base URL override.
   * @default "https://api.mistral.ai/v1"
   */
  baseURL?: string;
  /**
   * Default model to use when none is specified.
   * @default "mistral-large-latest"
   */
  defaultModelId?: string;
  /** Request timeout in milliseconds. @default 60000 */
  requestTimeout?: number;
}

// ---------------------------------------------------------------------------
// Known model catalog
// ---------------------------------------------------------------------------

/** Static catalog of well-known Mistral AI models. */
const MISTRAL_MODELS: ModelInfo[] = [
  {
    modelId: 'mistral-large-latest',
    providerId: 'mistral',
    displayName: 'Mistral Large',
    description: 'Most capable Mistral model for complex reasoning and multilingual tasks.',
    capabilities: ['chat', 'tool_use', 'json_mode'],
    contextWindowSize: 128000,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'mistral-medium-latest',
    providerId: 'mistral',
    displayName: 'Mistral Medium',
    description: 'Balanced Mistral model for everyday tasks.',
    capabilities: ['chat', 'tool_use', 'json_mode'],
    contextWindowSize: 32768,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'mistral-small-latest',
    providerId: 'mistral',
    displayName: 'Mistral Small',
    description: 'Fast and cost-effective Mistral model for lightweight tasks.',
    capabilities: ['chat', 'tool_use', 'json_mode'],
    contextWindowSize: 32768,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'codestral-latest',
    providerId: 'mistral',
    displayName: 'Codestral',
    description: 'Mistral model optimized for code generation and understanding.',
    capabilities: ['chat', 'completion', 'tool_use'],
    contextWindowSize: 32768,
    supportsStreaming: true,
    status: 'active',
  },
];

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * @class MistralProvider
 * @implements {IProvider}
 *
 * Thin wrapper around {@link OpenAIProvider} that targets Mistral AI's
 * OpenAI-compatible API endpoint. Mistral offers a range of proprietary
 * models known for strong multilingual capabilities and efficient inference.
 *
 * @example
 * const mistral = new MistralProvider();
 * await mistral.initialize({ apiKey: process.env.MISTRAL_API_KEY! });
 * const res = await mistral.generateCompletion('mistral-large-latest', messages, {});
 */
export class MistralProvider implements IProvider {
  /** @inheritdoc */
  public readonly providerId: string = 'mistral';
  /** @inheritdoc */
  public isInitialized: boolean = false;
  /** @inheritdoc */
  public defaultModelId?: string;

  /**
   * Internal OpenAI provider instance that handles the actual API communication.
   * Mistral's API is fully OpenAI-compatible, so we reuse the OpenAI transport layer.
   */
  private delegate = new OpenAIProvider();

  constructor() {}

  /**
   * Initializes the provider by configuring the underlying OpenAI delegate
   * with Mistral's base URL and the caller's API key.
   *
   * @param {MistralProviderConfig} config - Mistral-specific configuration.
   * @returns {Promise<void>}
   * @throws {Error} If the API key is missing.
   */
  public async initialize(config: MistralProviderConfig): Promise<void> {
    if (!config.apiKey) {
      throw new Error('API key is required for MistralProvider. Set MISTRAL_API_KEY.');
    }

    this.defaultModelId = config.defaultModelId ?? 'mistral-large-latest';

    // Delegate to OpenAI provider with Mistral's endpoint
    await this.delegate.initialize({
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? 'https://api.mistral.ai/v1',
      defaultModelId: this.defaultModelId,
      requestTimeout: config.requestTimeout ?? 60000,
    });

    this.isInitialized = true;
    console.log(`MistralProvider initialized. Default model: ${this.defaultModelId}.`);
  }

  /** @inheritdoc */
  public async generateCompletion(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
  ): Promise<ModelCompletionResponse> {
    return this.delegate.generateCompletion(modelId, withMistralToolCallIds(messages), options);
  }

  /** @inheritdoc */
  public async *generateCompletionStream(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
  ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    yield* this.delegate.generateCompletionStream(modelId, withMistralToolCallIds(messages), options);
  }

  /**
   * Mistral offers an embeddings API via the OpenAI-compatible endpoint.
   *
   * @param {string} modelId - Embedding model ID (e.g., "mistral-embed").
   * @param {string[]} texts - Texts to embed.
   * @param {ProviderEmbeddingOptions} [options] - Embedding options.
   * @returns {Promise<ProviderEmbeddingResponse>} Embedding response.
   */
  public async generateEmbeddings(
    modelId: string,
    texts: string[],
    options?: ProviderEmbeddingOptions,
  ): Promise<ProviderEmbeddingResponse> {
    return this.delegate.generateEmbeddings(modelId, texts, options);
  }

  /**
   * Returns a static catalog of well-known Mistral models.
   *
   * @param {{ capability?: string }} [filter] - Optional capability filter.
   * @returns {Promise<ModelInfo[]>} Mistral model catalog.
   */
  public async listAvailableModels(filter?: { capability?: string }): Promise<ModelInfo[]> {
    if (filter?.capability) {
      return MISTRAL_MODELS.filter(m => m.capabilities.includes(filter.capability!));
    }
    return [...MISTRAL_MODELS];
  }

  /** @inheritdoc */
  public async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    return MISTRAL_MODELS.find(m => m.modelId === modelId);
  }

  /** @inheritdoc */
  public async checkHealth(): Promise<{ isHealthy: boolean; details?: unknown }> {
    return this.delegate.checkHealth();
  }

  /** @inheritdoc */
  public async shutdown(): Promise<void> {
    await this.delegate.shutdown();
    this.isInitialized = false;
    console.log('MistralProvider shutdown complete.');
  }
}
