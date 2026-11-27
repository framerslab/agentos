/**
 * @module @framers/agentos/cognition/web-search
 *
 * Multi-provider web search with RRF fusion, semantic dedup, and neural reranking.
 * Supports Firecrawl (primary), SpecStream, Tavily, Serper, and Brave search providers.
 *
 * @example
 * ```typescript
 * import { WebSearchService, FirecrawlProvider, TavilyProvider } from '@framers/agentos/cognition/web-search';
 *
 * const service = new WebSearchService();
 * service.registerProvider(new FirecrawlProvider(process.env.FIRECRAWL_API_KEY!));
 * service.registerProvider(new TavilyProvider(process.env.TAVILY_API_KEY!));
 *
 * const results = await service.search('quantum computing breakthroughs 2026');
 * // Results are deduped, RRF-scored, and optionally reranked
 * ```
 */

// Types
export type {
  IWebSearchProvider,
  WebSearchResult,
  EnrichedSearchResult,
  WebSearchConfig,
  RRFCandidate,
} from './types';

// Service
export { WebSearchService } from './WebSearchService';

// Providers
export { FirecrawlProvider } from './providers/FirecrawlProvider';
export { SpecStreamProvider } from './providers/SpecStreamProvider';
export { TavilyProvider } from './providers/TavilyProvider';
export { SerperProvider } from './providers/SerperProvider';
export { BraveProvider } from './providers/BraveProvider';

// Fusion utilities
export { normalizeUrl, computeRRF, computeWeightedRRF } from './fusion';

// Dedup utilities
export { semanticDedup, buildVocabulary, buildTfVector } from './dedup';
