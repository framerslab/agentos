#!/usr/bin/env node
// Example: QueryRouter with host-injected graph/rerank/research hooks
//
// Usage:
//   export OPENAI_API_KEY="sk-..."   # Required (used for embeddings + LLM)
//   node examples/query-router-host-hooks.mjs
//
// Note: If OPENROUTER_API_KEY is also set, it may be auto-detected first.
// OpenRouter doesn't support embeddings, so unset it or ensure OPENAI_API_KEY is set.

import { QueryRouter } from '../dist/index.js';

async function main() {
  const router = new QueryRouter({
    knowledgeCorpus: ['./docs', './packages/agentos/docs'],
    availableTools: ['web_search', 'deep_research'],
    graphEnabled: true,
    deepResearchEnabled: true,
    graphExpand: async (seedChunks) => {
      return [
        ...seedChunks,
        {
          id: 'host-graph-1',
          heading: 'Graph-related context',
          content: 'This chunk was added by a host-provided graph expansion hook.',
          sourcePath: '/virtual/graph-hook',
          relevanceScore: 0.73,
          matchType: 'graph',
        },
      ];
    },
    rerank: async (_query, chunks, topN) => {
      return [...chunks]
        .sort((left, right) => right.relevanceScore - left.relevanceScore)
        .slice(0, topN);
    },
    deepResearch: async (query, sources) => {
      return {
        synthesis: `Host-provided deep research synthesis for "${query}" using ${sources.join(', ')}.`,
        sources: [
          {
            id: 'host-research-1',
            heading: 'External research synthesis',
            content: 'This source came from a host-provided deep research hook.',
            sourcePath: '/virtual/deep-research-hook',
            relevanceScore: 0.84,
            matchType: 'research',
          },
        ],
      };
    },
  });

  await router.init();

  console.log('\n=== corpus stats ===\n');
  console.log(router.getCorpusStats());

  const result = await router.route(
    'Compare AgentOS memory architecture to more basic retrieval-only assistants.'
  );

  console.log('\n=== answer ===\n');
  console.log(result.answer);

  console.log('\n=== routing metadata ===\n');
  console.log('classified tier:', result.classification.tier);
  console.log('tiers used:', result.tiersUsed);
  console.log('fallbacks used:', result.fallbacksUsed);

  console.log('\n=== sources ===\n');
  for (const source of result.sources) {
    console.log(`- ${source.heading} (${source.path})`);
  }

  await router.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
