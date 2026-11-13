import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

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
});
