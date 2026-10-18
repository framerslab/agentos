import { describe, expect, it } from 'vitest';

import { computeRRF, computeWeightedRRF, normalizeUrl } from '../fusion';
import { semanticDedup } from '../dedup';
import type { RRFCandidate } from '../types';

function candidate(url: string, snippet: string, ranks: Array<[provider: string, rank: number]>): RRFCandidate {
  return {
    url,
    normalizedUrl: '',
    title: url,
    snippet,
    providerRanks: new Map(ranks),
    providerSources: ranks.map(([provider]) => provider),
    rrfScore: 0,
  };
}

describe('normalizeUrl', () => {
  it('drops the scheme, a leading www., the tracking parameters and the slashes the path ends with', () => {
    expect(normalizeUrl('https://www.example.com/page/?utm_source=x')).toBe('example.com/page');
    expect(normalizeUrl('http://example.com/page')).toBe('example.com/page');
    // The parameters that stay keep their order, behind a ? of their own.
    expect(normalizeUrl('https://example.com/a?utm_medium=y&id=5&ref=feed&page=2')).toBe('example.com/a?id=5&page=2');
    expect(normalizeUrl('https://example.com/docs/#install')).toBe('example.com/docs#install');
  });
});

describe('computeRRF and computeWeightedRRF', () => {
  it('sums 1 / (k + rank) over the providers, with no provider weight', () => {
    const [both, one] = computeRRF([
      candidate('https://a.example/one', 'one', [['firecrawl', 3]]),
      candidate('https://a.example/both', 'both', [['firecrawl', 0], ['tavily', 1]]),
    ]);
    expect(both.url).toBe('https://a.example/both');
    expect(both.rrfScore).toBe(1 / 60 + 1 / 61);
    expect(one.rrfScore).toBe(1 / 63);
  });

  it('multiplies each provider term by its weight, 1 for a provider without one', () => {
    const [scored] = computeWeightedRRF([candidate('https://a.example', 'a', [['firecrawl', 0], ['tavily', 1]])], { firecrawl: 1.5 }, 10);
    expect(scored.rrfScore).toBe(1.5 / 10 + 1 / 11);
  });
});

describe('semanticDedup', () => {
  it('merges snippets by the cosine of their term frequencies, with no inverse document frequency', () => {
    // The three snippets share three of their four words. Weighed by term frequency their cosine is 0.75; under
    // TF-IDF the shared words, in every snippet, would weigh nothing and the cosine would be 0.
    const merged = semanticDedup(
      [
        candidate('https://news.example/a', 'breaking news today markets', [['firecrawl', 0]]),
        candidate('https://wire.example/b', 'breaking news today weather', [['tavily', 0]]),
        candidate('https://blog.example/c', 'breaking news today sports', [['serper', 0]]),
      ],
      0.7,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].providerSources).toEqual(['firecrawl', 'tavily', 'serper']);
  });

  it('merges two results with one address before it compares snippets', () => {
    const merged = semanticDedup([
      candidate('https://www.example.com/page/?utm_source=x', 'first', [['firecrawl', 0]]),
      candidate('http://example.com/page', 'second', [['tavily', 2]]),
    ]);
    expect(merged).toHaveLength(1);
    expect([...merged[0].providerRanks]).toEqual([['firecrawl', 0], ['tavily', 2]]);
  });

  it('leaves the candidates it is given as they were', () => {
    // One address merge (first and second), then one snippet merge (third), both into the first candidate's group.
    const first = candidate('https://www.example.com/page/', 'breaking news today markets', [['firecrawl', 0]]);
    const second = candidate('http://example.com/page', 'another snippet entirely', [['tavily', 2]]);
    const third = candidate('https://wire.example/b', 'breaking news today markets', [['serper', 1]]);
    const merged = semanticDedup([first, second, third]);
    expect(merged).toHaveLength(1);
    expect([...merged[0].providerRanks]).toEqual([['firecrawl', 0], ['tavily', 2], ['serper', 1]]);
    expect(merged[0].providerSources).toEqual(['firecrawl', 'tavily', 'serper']);
    expect([...first.providerRanks]).toEqual([['firecrawl', 0]]);
    expect(first.providerSources).toEqual(['firecrawl']);
    expect([...second.providerRanks]).toEqual([['tavily', 2]]);
    expect([...third.providerRanks]).toEqual([['serper', 1]]);
  });
});
