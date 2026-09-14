// File: backend/agentos/core/llm/providers/implementations/YouComProvider.ts
/**
 * @fileoverview You.com search provider integration for AgentOS. Unlike traditional LLM providers,
 * this provider focuses on exposing You.com's web and news search capabilities through the
 * Search API at https://ydc-index.io/v1/search.
 *
 * The You.com provider serves as a specialized search provider rather than a text generation
 * provider, offering agents access to:
 * - Real-time web search
 * - News search with publication metadata
 *
 * The wider You.com platform also exposes MCP tools for content extraction and research
 * synthesis, but this provider keeps the integration on the Search API path.
 *
 * This provider implements IProvider but focuses primarily on search rather than LLM completions.
 * For text generation, use a different provider and combine it with You.com search results.
 *
 * @module backend/agentos/core/llm/providers/implementations/YouComProvider
 */

import { 
  IProvider, 
  ChatMessage, 
  ModelCompletionOptions, 
  ModelCompletionResponse,
  ProviderEmbeddingOptions,
  ProviderEmbeddingResponse,
  ModelInfo 
} from '../IProvider';

/**
 * Configuration for YouComProvider
 */
export interface YouComProviderConfig {
  /** Optional You.com API key for authenticated MCP server access */
  apiKey?: string;
  /** Base URL for You.com Search API (default: https://ydc-index.io/v1/search) */
  searchApiUrl?: string;
  /** MCP server URL for authenticated access (default: https://api.you.com/mcp) */
  mcpServerUrl?: string;
  /** Fallback LLM provider for text generation when You.com is used as tool augmentation */
  fallbackProvider?: string;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * You.com search result structure
 */
interface YouComSearchResult {
  web?: Array<{
    title: string;
    url: string;
    description: string;
    snippets: string[];
  }>;
  news?: Array<{
    title: string;
    url: string;
    description: string;
    snippets: string[];
    published_at?: string;
  }>;
  metadata?: Record<string, unknown>;
}

interface RawYouComSearchResult {
  results?: {
    web?: unknown[];
    news?: unknown[];
  };
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface YouComSearchOptions {
  count?: number;
  type?: 'web' | 'news';
  freshness?: 'day' | 'week' | 'month' | 'year' | string;
}

/**
 * YouComProvider - Specialized provider for You.com search capabilities
 * 
 * This provider focuses on tool integration rather than LLM completion,
 * offering real-time web search and content access through You.com's APIs.
 */
export class YouComProvider implements IProvider {
  public readonly providerId = 'youcom';
  public readonly defaultModelId = 'youcom-search'; // Represents search capability rather than LLM model
  private config!: YouComProviderConfig;
  private _isInitialized = false;
  private static readonly REQUEST_TIMEOUT_MS = 10_000;

  public get isInitialized(): boolean {
    return this._isInitialized;
  }

  /**
   * Initialize the You.com provider with configuration
   */
  public async initialize(config: YouComProviderConfig = {}): Promise<void> {
    this.config = {
      searchApiUrl: 'https://ydc-index.io/v1/search',
      mcpServerUrl: 'https://api.you.com/mcp',
      debug: false,
      ...config
    };

    // Auto-detect API key from environment if not provided
    if (!this.config.apiKey) {
      this.config.apiKey = process.env.YDC_API_KEY || process.env.YOUCOM_API_KEY;
    }

    // Test connectivity to the Search API, but do not fail initialization if
    // the host is offline or the API is temporarily unreachable.
    await this.testSearchConnectivity(true);

    this._isInitialized = true;

    if (this.config.debug) {
      const authMode = this.config.apiKey ? 'authenticated' : 'unauthenticated';
      console.log(`YouComProvider initialized successfully in ${authMode} mode.`);
    }
  }

  /**
   * Test basic connectivity to You.com Search API
   */
  private async testSearchConnectivity(logFailures = false): Promise<boolean> {
    try {
      const url = new URL(this.config.searchApiUrl!);
      url.searchParams.set('query', 'test');
      url.searchParams.set('count', '1');

      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: this.getSearchHeaders(),
      });

      if (!response.ok && logFailures && this.config.debug) {
        console.warn(
          `YouComProvider: Search API connectivity test failed with ${response.status} ${response.statusText}.`
        );
      }

      return response.ok;
    } catch (error) {
      if (logFailures && this.config.debug) {
        console.warn('YouComProvider: Search API test failed, but continuing initialization:', error);
      }
      return false;
    }
  }

  /**
   * Get headers for You.com Search API requests
   */
  private getSearchHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': 'AgentOS/1.0 (YouComProvider)',
      'Accept': 'application/json',
    };

    if (this.config.apiKey) {
      headers['X-API-Key'] = this.config.apiKey;
    }

    return headers;
  }

  private async fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), YouComProvider.REQUEST_TIMEOUT_MS);

    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private validateCount(count: number): void {
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      throw new Error('You.com search count must be an integer between 1 and 100.');
    }
  }

  private normalizeResultSection(section: unknown): Array<{
    title: string;
    url: string;
    description: string;
    snippets: string[];
    published_at?: string;
  }> {
    if (!Array.isArray(section)) {
      return [];
    }

    return section.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') {
        return [];
      }

      const result = entry as Record<string, unknown>;
      const title = typeof result.title === 'string' ? result.title : '';
      const url = typeof result.url === 'string' ? result.url : '';

      if (!title || !url) {
        return [];
      }

      const description = this.pickFirstString(result.description, result.snippet, '');
      const snippets = this.normalizeSnippets(result.snippets, description);
      const publishedAt = this.pickFirstString(result.published_at, result.page_age);

      return [
        {
          title,
          url,
          description,
          snippets,
          ...(publishedAt ? { published_at: publishedAt } : {}),
        },
      ];
    });
  }

  private normalizeSnippets(value: unknown, fallback: string): string[] {
    if (Array.isArray(value)) {
      const snippets = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
      if (snippets.length > 0) {
        return snippets;
      }
    }

    if (typeof value === 'string' && value.trim()) {
      return [value.trim()];
    }

    return fallback ? [fallback] : [];
  }

  private pickFirstString(...values: unknown[]): string {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return '';
  }

  /**
   * Perform You.com web search
   */
  public async search(query: string, options: YouComSearchOptions = {}): Promise<YouComSearchResult> {
    if (!this._isInitialized) {
      throw new Error('YouComProvider is not initialized. Call initialize() first.');
    }

    const { count = 10, type = 'web', freshness } = options;
    this.validateCount(count);
    
    try {
      const url = new URL(this.config.searchApiUrl!);
      url.searchParams.set('query', query);
      url.searchParams.set('count', count.toString());
      const effectiveFreshness = freshness ?? (type === 'news' ? 'week' : undefined);
      if (effectiveFreshness) {
        url.searchParams.set('freshness', effectiveFreshness);
      }
      
      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: this.getSearchHeaders(),
      });

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error('You.com Search API rate limit exceeded. Consider using an API key for higher quotas.');
        }
        throw new Error(`Search request failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as RawYouComSearchResult;
      const results = (data.results ?? data) as { web?: unknown[]; news?: unknown[] };

      return {
        web: this.normalizeResultSection(results.web),
        news: this.normalizeResultSection(results.news),
        ...(data.metadata ? { metadata: data.metadata } : {}),
      };
    } catch (error) {
      throw new Error(`You.com search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Generate completion - YouComProvider primarily provides tools, not LLM completion
   * This method can integrate search context into responses or delegate to fallback providers
   */
  public async generateCompletion(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions
  ): Promise<ModelCompletionResponse> {
    if (!this._isInitialized) {
      throw new Error('YouComProvider is not initialized. Call initialize() first.');
    }

    // YouComProvider is designed for search tools, not LLM completion
    throw new Error("YouComProvider does not support text completion. Use search() method or configure a different provider for text generation.");
  }

  /**
   * Streaming completion - Not implemented for YouComProvider
   */
  public async *generateCompletionStream(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions
  ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    // YouComProvider does not support streaming, yield single error response
    const errorResponse: ModelCompletionResponse = {
      id: `youcom-error-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      modelId,
      choices: [],
      usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
      error: {
        message: "YouComProvider does not support streaming completion. Use search() method instead.",
        type: "unsupported_operation"
      },
      isFinal: true
    };
    yield errorResponse;
  }

  /**
   * Generate embeddings - Not supported by You.com API
   */
  public async generateEmbeddings(
    modelId: string,
    texts: string[],
    options?: ProviderEmbeddingOptions
  ): Promise<ProviderEmbeddingResponse> {
    throw new Error('You.com does not provide embedding models. Use search and content tools instead.');
  }

  /**
   * List available "models" - YouComProvider exposes search capabilities as model-like endpoints
   */
  public async listAvailableModels(): Promise<ModelInfo[]> {
    return [
      {
        modelId: 'youcom-search',
        providerId: this.providerId,
        displayName: 'You.com Web Search',
        description: 'Real-time web search with snippets and source URLs',
        capabilities: ['search', 'tool_use'],
        contextWindowSize: undefined,
        supportsStreaming: false,
        status: 'active',
        pricePer1MTokensInput: 0, // Keyless tier is free up to quota
        lastUpdated: new Date().toISOString()
      },
      {
        modelId: 'youcom-news',
        providerId: this.providerId,
        displayName: 'You.com News Search',
        description: 'Real-time news search with timestamps and sources',
        capabilities: ['search', 'tool_use'],
        contextWindowSize: undefined,
        supportsStreaming: false,
        status: 'active',
        pricePer1MTokensInput: 0,
        lastUpdated: new Date().toISOString()
      }
    ];
  }

  /**
   * Get model info for You.com search capabilities
   */
  public async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    const models = await this.listAvailableModels();
    return models.find(model => model.modelId === modelId);
  }

  /**
   * Check provider health
   */
  public async checkHealth(): Promise<{ isHealthy: boolean; details?: unknown }> {
    const isHealthy = await this.testSearchConnectivity(false);
    return {
      isHealthy,
      details: { apiKeyConfigured: Boolean(this.config.apiKey) }
    };
  }

  /**
   * Shutdown provider
   */
  public async shutdown(): Promise<void> {
    this._isInitialized = false;
    if (this.config.debug) {
      console.log('YouComProvider shutdown complete.');
    }
  }
}
