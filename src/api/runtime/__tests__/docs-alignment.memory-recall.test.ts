import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_RECALL_BUDGET_TOKENS } from '../../../cognition/memory/retrieval/recall/budget';
import { RECALL_CONSTANTS } from '../../../cognition/memory/retrieval/recall/fuse';
import { RERANK_DEFAULTS } from '../../../cognition/memory/retrieval/recall/rerank';

/** A docs page, by its path from the package root. */
function doc(fromPackageRoot: string): string {
  return readFileSync(new URL(`../../../../${fromPackageRoot}`, import.meta.url), 'utf8');
}

/** The one line of `page` that starts with `prefix`. */
function lineOf(page: string, prefix: string): string {
  const lines = doc(page).split('\n').filter((line) => line.startsWith(prefix));
  expect(lines, `${page}: lines starting with ${JSON.stringify(prefix)}`).toHaveLength(1);
  return lines[0];
}

describe('memory recall docs', () => {
  it("say a gmi() agent builds its memory manager inside its first session's first turn and has no recallReady(), wherever recallReady() is the warm-up", () => {
    // gmi() and agent({ runtime: 'gmi' }) build the manager on first use (src/api/gmi.ts, memoryForSessions) and
    // expose no recallReady(): a server that builds an agent per request with rerank { kind: 'local' } loads the model
    // again for each agent, and each turn whose recall ends before the load records { provider: 'none', reason: 'loading' }.
    const loadingRow = lineOf('docs/text/RERANKING.md', '| `loading` |');
    expect(loadingRow).toContain('`recallReady()`');
    expect(loadingRow).toContain("A `gmi()` or `agent({ runtime: 'gmi' })` agent builds its manager inside its first session's first turn and has no `recallReady()`");
    expect(loadingRow).toContain('keeps one agent per process');

    const rerankRow = lineOf('docs/getting-started/HIGH_LEVEL_API.md', '| `rerank` |');
    expect(rerankRow).toContain("The agent builds its memory manager, and starts the local model's load, inside its first session's first turn, and has no `recallReady()`");
    expect(rerankRow).toContain('keep one agent per process');
    expect(rerankRow).toContain("`reranker: { provider: 'none', reason: 'loading' }`");
  });

  it("names the hybrid exception where docs/GMI.md gives the rerank blend: under 'hybrid' a rerank changes the order and no score", () => {
    // Under retrieval: 'hybrid' the blend orders the reranked cut and each candidate keeps its fused score, so a
    // host that reads retrievalScore after a rerank finds it unchanged.
    const step = lineOf('docs/GMI.md', '4. **Reranking (optional).**');
    expect(step).toContain("Under `retrieval: 'dense'`");
    expect(step).toContain("Under `'hybrid'` the blend sets the order alone");
    expect(step).toContain('keeps its fused score');
    expect(step).not.toContain('their final score blends 0.7 cognitive and 0.3 reranker');
  });

  it('say the in-process exact-words index serves a store with no Brain and holds the traces this process filed or loaded', () => {
    // pipeline.ts uses the in-process index whenever MemoryStore.getBrain() returns null, a store over a vector index
    // that outlives the process included, and lexical.ts fills it from this process's writes and loads alone: a
    // trace another process filed into that index is not in it.
    const memory = 'docs/memory/COGNITIVE_MEMORY.md';
    const lines = [
      lineOf('docs/architecture/hybrid-retriever.md', '`HybridRetriever` and [`SessionRetriever`]'),
      lineOf('docs/text/LEXICAL_AND_HYBRID_SEARCH.md', "- Cognitive memory's `recall.retrieval: 'hybrid'`"),
      lineOf(memory, '| `exact_words` | '),
    ];
    for (const line of lines) {
      expect(line).toContain('a store with no Brain');
      expect(line).toContain('the traces this process filed or loaded');
      expect(line).not.toContain('a memory with no store');
    }
    expect(lineOf(memory, '| `lexicalBackend` | ')).toContain('`in_process` (a store with no Brain)');
  });

  it("say hybrid's exact-words and recency legs carry a turn alone whenever the dense leg returns nothing, a dense search with a vector included", () => {
    // pipeline.ts runs the three legs side by side: the dense leg also returns nothing with a usable query vector when
    // the turn's scopes hold no vector match or a scope's vector query throws (read as a scope with no memories), and
    // the other two legs then carry the turn alone.
    const line = lineOf('docs/memory/COGNITIVE_MEMORY.md', '**A host with no embedding model.**');
    expect(line).not.toContain('only when');
    expect(line).toContain('whenever the dense leg returns nothing');
    expect(line).toContain('the vector search finds no memory in the turn\'s scopes');
  });

  it('state the numbers the source holds: the default budget, the hybrid recall constants and the rerank bounds', () => {
    // A constant a measured run moves (RECALL_CONSTANTS, RERANK_DEFAULTS) must move in these tables with it.
    const cell = (row: string, n: number) => row.split('|')[n].trim();
    const thousands = (n: number) => n.toLocaleString('en-US');

    const memory = 'docs/memory/COGNITIVE_MEMORY.md';
    expect(cell(lineOf(memory, '| `budget.totalTokens` | '), 3)).toBe(thousands(DEFAULT_RECALL_BUDGET_TOKENS));
    expect(cell(lineOf('docs/getting-started/HIGH_LEVEL_API.md', '| `budget.totalTokens` | '), 2)).toBe(String(DEFAULT_RECALL_BUDGET_TOKENS));
    for (const [name, value] of Object.entries(RECALL_CONSTANTS)) {
      // The near-duplicate index is written to two places, as the dedupe rule states it.
      expect(cell(lineOf(memory, `| \`${name}\` | `), 2), name).toBe(name === 'nearDuplicate' ? value.toFixed(2) : String(value));
    }
    const legSize = `\`topK × overFetch\` (${RECALL_CONSTANTS.topK * RECALL_CONSTANTS.overFetch})`;
    expect(cell(lineOf(memory, '| `dense` | The vector index'), 3)).toBe(legSize);
    expect(cell(lineOf(memory, '| `exact_words` | '), 3)).toBe(legSize);
    expect(cell(lineOf(memory, '| `recency` | The newest traces'), 3)).toBe(`\`recentTopK\` (${RECALL_CONSTANTS.recentTopK})`);

    const reranking = 'docs/text/RERANKING.md';
    const timeouts = lineOf(reranking, '| `timeoutMs` (one rerank) | ');
    expect([cell(timeouts, 3), cell(timeouts, 4)]).toEqual([thousands(RERANK_DEFAULTS.localTimeoutMs), thousands(RERANK_DEFAULTS.llmTimeoutMs)]);
    const candidates = lineOf(reranking, "| `maxCandidates` (the recall's best) | ");
    expect([cell(candidates, 3), cell(candidates, 4)]).toEqual([String(RERANK_DEFAULTS.maxCandidates), String(RERANK_DEFAULTS.maxCandidates)]);
    expect(lineOf(reranking, '**What a turn does.**')).toContain(
      `\`${RERANK_DEFAULTS.blendScore} × the score each holds + ${RERANK_DEFAULTS.blendRerank} × its rerank score\``,
    );
    expect(RERANK_DEFAULTS.failuresToBackOff).toBe(3);
    expect(lineOf(reranking, '| `backoff` | ')).toContain(`Three failures or timeouts in a row: the provider is not called for ${RERANK_DEFAULTS.backoffMs / 1000} seconds`);
  });
});
