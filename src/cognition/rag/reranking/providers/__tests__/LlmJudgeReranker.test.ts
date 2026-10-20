import { describe, it, expect, vi } from 'vitest';
import { LlmJudgeReranker } from '../LlmJudgeReranker.js';
import { RerankerService } from '../../RerankerService.js';
import type { RerankerInput, RerankerRequestConfig } from '../../IRerankerService.js';

function makeInput(n: number): RerankerInput {
  return {
    query: 'best programming languages',
    documents: Array.from({ length: n }, (_, i) => ({
      id: `doc-${i}`,
      content: `Document ${i} about programming language ${['Rust', 'Python', 'Go', 'Java', 'TypeScript', 'C++', 'Kotlin', 'Swift', 'Ruby', 'Elixir'][i % 10]}`,
    })),
  };
}

const defaultConfig: RerankerRequestConfig = {
  providerId: 'llm-judge',
  modelId: 'gpt-4o-mini',
  topN: 5,
};

describe('LlmJudgeReranker', () => {
  it('returns providerId "llm-judge"', () => {
    const reranker = new LlmJudgeReranker({ llmCallFn: vi.fn() });
    expect(reranker.providerId).toBe('llm-judge');
  });

  it('is available when llmCallFn is provided', async () => {
    const reranker = new LlmJudgeReranker({ llmCallFn: vi.fn() });
    expect(await reranker.isAvailable()).toBe(true);
  });

  it('scores documents via batch pointwise then listwise', async () => {
    const llmCallFn = vi.fn()
      .mockResolvedValueOnce('[8, 3, 7, 2, 9, 4, 6, 1, 5, 10]')
      .mockResolvedValueOnce('["doc-9", "doc-4", "doc-0", "doc-2", "doc-6"]');

    const reranker = new LlmJudgeReranker({ llmCallFn, pointwiseTopK: 5 });

    const result = await reranker.rerank(makeInput(10), defaultConfig);
    expect(result.results.length).toBe(5);
    expect(result.results[0].id).toBe('doc-9');
    expect(result.results[0].relevanceScore).toBeGreaterThan(result.results[1].relevanceScore);
    expect(llmCallFn).toHaveBeenCalledTimes(2);
  });

  it('falls back to pointwise scores when listwise fails', async () => {
    const llmCallFn = vi.fn()
      .mockResolvedValueOnce('[8, 3, 7, 2, 9]')
      .mockRejectedValueOnce(new Error('LLM timeout'));

    const reranker = new LlmJudgeReranker({ llmCallFn, pointwiseTopK: 3 });

    const result = await reranker.rerank(makeInput(5), { ...defaultConfig, topN: 3 });
    expect(result.results.length).toBe(3);
    expect(result.results[0].id).toBe('doc-4');
  });

  it('handles batch errors gracefully', async () => {
    const llmCallFn = vi.fn()
      .mockRejectedValueOnce(new Error('batch 1 failed'))
      .mockResolvedValueOnce('[5, 8, 3, 7, 2, 9, 4, 6, 1, 10]')
      .mockResolvedValueOnce('["doc-19", "doc-15", "doc-11"]');

    const reranker = new LlmJudgeReranker({ llmCallFn, pointwiseTopK: 3 });

    const result = await reranker.rerank(makeInput(20), { ...defaultConfig, topN: 3 });
    expect(result.results.length).toBe(3);
  });
});

describe('LlmJudgeReranker results', () => {
  // Scores 8, 3, 7, 2, 9: by score, doc-4, doc-0, doc-2, doc-1, doc-3.
  const scores = '[8, 3, 7, 2, 9]';
  const ids = (results: Array<{ id: string }>) => results.map((result) => result.id);
  const request = { providerId: 'llm-judge', modelId: 'gpt-4o-mini' };

  it('answers every passage it scored when the request sets no topN: the ranked ones, then the rest by score', async () => {
    const llmCallFn = vi.fn().mockResolvedValueOnce(scores).mockResolvedValueOnce('["doc-4", "doc-0"]');
    const reranker = new LlmJudgeReranker({ llmCallFn, pointwiseTopK: 3 });
    const { results } = await reranker.rerank(makeInput(5), request);
    // The ranking left doc-2 out of the three it was given; it follows them by its score.
    expect(ids(results)).toEqual(['doc-4', 'doc-0', 'doc-2', 'doc-1', 'doc-3']);
    const relevance = results.map((result) => result.relevanceScore);
    expect([...relevance].sort((a, b) => b - a)).toEqual(relevance);
    expect(new Set(relevance).size).toBe(relevance.length);
  });

  it('answers up to topN, past pointwiseTopK', async () => {
    const llmCallFn = vi.fn().mockResolvedValueOnce(scores).mockResolvedValueOnce('["doc-0", "doc-4"]');
    const reranker = new LlmJudgeReranker({ llmCallFn, pointwiseTopK: 2 });
    const { results } = await reranker.rerank(makeInput(5), { ...request, topN: 4 });
    expect(ids(results)).toEqual(['doc-0', 'doc-4', 'doc-2', 'doc-1']);
  });

  it('keeps one copy of an id the ranking repeats and passes over one it was not given', async () => {
    const llmCallFn = vi.fn().mockResolvedValueOnce(scores).mockResolvedValueOnce('["doc-4", "doc-4", "doc-9", "doc-0"]');
    const reranker = new LlmJudgeReranker({ llmCallFn, pointwiseTopK: 3 });
    const { results } = await reranker.rerank(makeInput(5), { ...request, topN: 3 });
    expect(ids(results)).toEqual(['doc-4', 'doc-0', 'doc-2']);
  });

  it('stops waiting for a model call after timeoutMs, and the scores order the passages', async () => {
    const llmCallFn = vi.fn().mockResolvedValueOnce(scores).mockReturnValueOnce(new Promise<string>(() => {}));
    const reranker = new LlmJudgeReranker({ llmCallFn, pointwiseTopK: 3, timeoutMs: 50 });
    const { results } = await reranker.rerank(makeInput(5), { ...request, topN: 2 });
    expect(ids(results)).toEqual(['doc-4', 'doc-0']);
  }, 5000);

  it("takes the request's timeoutMs before its own", async () => {
    const llmCallFn = vi.fn()
      .mockReturnValueOnce(new Promise<string>(() => {}))
      .mockResolvedValueOnce('["doc-1", "doc-0"]');
    const reranker = new LlmJudgeReranker({ llmCallFn, timeoutMs: 60_000 });
    const { results } = await reranker.rerank(makeInput(2), { ...request, timeoutMs: 50 });
    // The scoring call never answered, so both passages scored 0; the ranking call answered.
    expect(ids(results)).toEqual(['doc-1', 'doc-0']);
  }, 5000);
});

describe('LlmJudgeReranker through RerankerService', () => {
  const ids = (results: Array<{ id: string }>) => results.map((result) => result.id);

  /** A judge whose scoring call never answers and whose ranking call orders doc-1 before doc-0. */
  function stalledJudge(timeoutMs: number): LlmJudgeReranker {
    const llmCallFn = vi.fn()
      .mockReturnValueOnce(new Promise<string>(() => {}))
      .mockResolvedValueOnce('["doc-1", "doc-0"]');
    return new LlmJudgeReranker({ llmCallFn, timeoutMs });
  }

  it("waits for the judge's own timeoutMs when neither the call nor the provider's settings name one", async () => {
    const service = new RerankerService({ config: { providers: [] } });
    service.registerProvider(stalledJudge(50));
    const { results } = await service.rerank(makeInput(2), { providerId: 'llm-judge' });
    // The scoring call was given up after the judge's 50 ms, not a default of the service.
    expect(ids(results)).toEqual(['doc-1', 'doc-0']);
  }, 2000);

  it("takes the provider settings' defaultTimeoutMs before the judge's own", async () => {
    const service = new RerankerService({ config: { providers: [{ providerId: 'llm-judge', defaultTimeoutMs: 50 }] } });
    service.registerProvider(stalledJudge(60_000));
    const { results } = await service.rerank(makeInput(2), { providerId: 'llm-judge' });
    expect(ids(results)).toEqual(['doc-1', 'doc-0']);
  }, 2000);
});
