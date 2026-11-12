/**
 * @file index.ts
 * @description Barrel exports for hybrid BM25 + dense retrieval
 * (Step 3 of the RAG stack sequenced rollout).
 *
 * @module agentos/memory/retrieval/hybrid
 */

export { HybridRetriever } from './HybridRetriever.js';
export type {
  HybridRetrieverOptions,
  HybridRetrieveOptions,
} from './HybridRetriever.js';

export { reciprocalRankFusion, fuseRankedLists } from './reciprocalRankFusion.js';
export type {
  FusedDoc,
  RankedDoc,
  RRFOptions,
  RRFResult,
} from './reciprocalRankFusion.js';
