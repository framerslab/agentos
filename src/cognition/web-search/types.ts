/**
 * @module web-search/types
 *
 * Core types for the AgentOS multi-provider web search pipeline.
 */
import type { RerankChainStage } from '../rag/reranking/IRerankerService';
import type { RerankerService } from '../rag/reranking/RerankerService';

/** A single raw result from a search provider. */
export interface WebSearchResult {
  url: string;
  title: string;
  snippet: string;
  /** Full extracted page content (Firecrawl returns this; others do not). */
  content?: string;
  /** Provider-specific relevance score. */
  relevanceScore?: number;
}

/** Enriched result after cross-provider fusion and optional reranking. */
export interface EnrichedSearchResult extends WebSearchResult {
  /** Which providers returned this result. */
  providerSources: string[];
  /** Reciprocal Rank Fusion score across providers. */
  rrfScore: number;
  /** Neural reranker relevance score (0-1). Populated after reranking. */
  rerankScore?: number;
}

/** Contract for pluggable search providers. */
export interface IWebSearchProvider {
  /** Unique provider identifier (e.g., 'firecrawl', 'tavily'). */
  readonly providerId: string;
  /** RRF weight multiplier. Firecrawl = 1.5, others = 1.0. */
  readonly weight: number;
  /** Execute a search query. Returns raw results from this provider. */
  search(query: string, limit?: number): Promise<WebSearchResult[]>;
  /** Check if this provider has valid configuration (API key present). */
  isAvailable(): boolean;
}

/** Configuration for the WebSearchService. */
export interface WebSearchConfig {
  /** Optional RerankerService for neural reranking after RRF. */
  reranker?: RerankerService;
  /** Rerank chain stages (e.g., Cohere → LLM Judge). */
  rerankChain?: RerankChainStage[];
  /** Semantic dedup cosine similarity threshold (default 0.85). */
  dedupThreshold?: number;
  /** Max results to return (default 12). */
  maxResults?: number;
}

/** Internal candidate during RRF fusion. */
export interface RRFCandidate {
  url: string;
  normalizedUrl: string;
  title: string;
  snippet: string;
  content?: string;
  providerRanks: Map<string, number>;
  providerSources: string[];
  rrfScore: number;
  relevanceScore?: number;
}
