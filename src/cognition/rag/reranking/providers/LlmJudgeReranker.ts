/**
 * @fileoverview LLM-as-Judge Reranker — two-phase hybrid reranking using LLM calls.
 *
 * Phase 1: Batch pointwise scoring with a cheap model (gpt-4o-mini, haiku).
 *          Groups documents into batches of 10, asks LLM to score 0-10.
 * Phase 2: Listwise final ranking with a synthesis model.
 *          Takes the `pointwiseTopK` best-scored documents from phase 1, asks LLM to rank them by relevance.
 *
 * The answer holds every scored document: the ones the ranking names, in its order, then the rest by their phase 1
 * score, cut to the request's `topN` when it sets one.
 *
 * Cognitive science: Combines absolute judgment (pointwise) with comparative
 * judgment (listwise) — mirrors how human expert reviewers evaluate documents.
 *
 * References:
 * - Sun, W., et al. (2023). "Is ChatGPT Good at Search? Investigating Large
 *   Language Models as Re-Ranking Agents." arXiv:2304.09542
 * - Qin, Z., et al. (2023). "Large Language Models are Effective Text Rankers
 *   with Pairwise Ranking Prompting." arXiv:2306.17563
 *
 * @module agentos/rag/reranking/providers/LlmJudgeReranker
 */

import type {
  IRerankerProvider,
  RerankerInput,
  RerankerOutput,
  RerankerRequestConfig,
} from '../IRerankerService.js';

/** Configuration for the LLM judge reranker. */
export interface LlmJudgeRerankerConfig {
  /** LLM call function: (systemPrompt, userPrompt, model?) → response text. */
  llmCallFn: (system: string, user: string, model?: string) => Promise<string>;
  /** Model for batch pointwise scoring (cheap). Passed to `llmCallFn` as given; undefined when not set. */
  scoringModel?: string;
  /** Model for listwise final ranking (better). Passed to `llmCallFn` as given; undefined when not set. */
  rankingModel?: string;
  /** Max documents to score in phase 1; the documents past it are left out of the answer. Default 100. */
  maxPointwiseDocuments?: number;
  /** How many of the best-scored documents phase 2 ranks. Default 20. */
  pointwiseTopK?: number;
  /**
   * How long to wait for each call of `llmCallFn`, in milliseconds, when the request sets no `timeoutMs`. A scoring
   * call that runs past it scores its batch 0; a ranking call that runs past it leaves the order to the scores.
   * Default 30000.
   */
  timeoutMs?: number;
  /** Batch size for pointwise scoring. Default 10. */
  batchSize?: number;
}

/** A document with its phase 1 score. */
type ScoredDocument = RerankerInput['documents'][number] & { score: number };

const POINTWISE_SYSTEM = `You are a relevance scorer. Rate each document's relevance to the query on a scale of 0-10. 10 = perfectly relevant, 0 = completely irrelevant. Return ONLY a JSON array of integer scores, one per document, in the same order. Example: [8, 3, 7, 2, 9]`;

const LISTWISE_SYSTEM = `You are a relevance ranker. Rank the documents by relevance to the query, most relevant first. Return ONLY a JSON array of document IDs in ranked order. Example: ["doc-3", "doc-1", "doc-5"]`;

/** The reply text with a Markdown code fence around it removed. */
function stripFence(raw: string): string {
  return raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
}

/** Two-phase LLM-based reranker: batch pointwise + listwise top-K. */
export class LlmJudgeReranker implements IRerankerProvider {
  public readonly providerId = 'llm-judge' as const;

  private readonly llmCallFn: LlmJudgeRerankerConfig['llmCallFn'];
  private readonly scoringModel?: string;
  private readonly rankingModel?: string;
  private readonly maxPointwiseDocuments: number;
  private readonly pointwiseTopK: number;
  private readonly batchSize: number;
  private readonly timeoutMs: number;

  constructor(config: LlmJudgeRerankerConfig) {
    this.llmCallFn = config.llmCallFn;
    this.scoringModel = config.scoringModel;
    this.rankingModel = config.rankingModel;
    this.maxPointwiseDocuments = config.maxPointwiseDocuments ?? 100;
    this.pointwiseTopK = config.pointwiseTopK ?? 20;
    this.batchSize = config.batchSize ?? 10;
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  async isAvailable(): Promise<boolean> {
    return typeof this.llmCallFn === 'function';
  }

  /**
   * Scores the first `maxPointwiseDocuments` documents, ranks the `pointwiseTopK` best of them, and answers every
   * scored document: the ones the ranking names, in its order (an id it repeats once, an id it was not given passed
   * over), then the rest by score, the input order breaking a tie. When the ranking call fails, runs past the
   * timeout or does not answer a JSON array, the scores order them all. With `topN` the answer is cut to that many.
   * `relevanceScore` is `1 - i / n` for the answer's `i`-th document (from 0) of `n`.
   */
  async rerank(input: RerankerInput, config: RerankerRequestConfig): Promise<RerankerOutput> {
    const timeoutMs = config.timeoutMs ?? this.timeoutMs;
    const documents = input.documents.slice(0, this.maxPointwiseDocuments);

    // Phase 1: batch pointwise scoring, best score first (the sort is stable, so a tie keeps the input order).
    const scored = await this.batchPointwiseScore(input.query, documents, timeoutMs);
    scored.sort((a, b) => b.score - a.score);
    const candidates = scored.slice(0, this.pointwiseTopK);

    // Phase 2: listwise ranking of the best-scored candidates.
    let ranked: ScoredDocument[] = [];
    if (candidates.length > 0) {
      try {
        ranked = await this.listwiseRank(input.query, candidates, timeoutMs);
      } catch {
        ranked = [];
      }
    }

    const placed = new Set(ranked);
    const ordered = [...ranked, ...scored.filter((doc) => !placed.has(doc))];
    const answered = typeof config.topN === 'number' ? ordered.slice(0, Math.max(0, config.topN)) : ordered;

    return {
      results: answered.map((doc, i) => ({
        id: doc.id,
        content: doc.content,
        relevanceScore: 1 - i / answered.length,
        originalScore: doc.originalScore,
        metadata: doc.metadata,
      })),
    };
  }

  /** One call of `llmCallFn`, refused when it runs past `timeoutMs`. */
  private async call(system: string, user: string, model: string | undefined, timeoutMs: number): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`LlmJudgeReranker: no answer within ${timeoutMs} ms.`)), timeoutMs);
    });
    try {
      return await Promise.race([this.llmCallFn(system, user, model), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Phase 1: Score documents in batches. A batch whose call fails or does not parse scores 0. */
  private async batchPointwiseScore(
    query: string,
    documents: RerankerInput['documents'],
    timeoutMs: number,
  ): Promise<ScoredDocument[]> {
    const batches: RerankerInput['documents'][] = [];
    for (let i = 0; i < documents.length; i += this.batchSize) {
      batches.push(documents.slice(i, i + this.batchSize));
    }

    const results: ScoredDocument[] = [];

    for (const batch of batches) {
      const docList = batch
        .map((d, i) => `[${i + 1}] ${d.content.slice(0, 200)}`)
        .join('\n');
      const userPrompt = `Query: "${query}"\n\nDocuments:\n${docList}`;

      try {
        const raw = await this.call(POINTWISE_SYSTEM, userPrompt, this.scoringModel, timeoutMs);
        const parsed: unknown = JSON.parse(stripFence(raw));
        const scores: unknown[] = Array.isArray(parsed) ? parsed : [];

        for (let i = 0; i < batch.length; i++) {
          const score = scores[i];
          results.push({ ...batch[i], score: typeof score === 'number' && Number.isFinite(score) ? score : 0 });
        }
      } catch {
        for (const doc of batch) {
          results.push({ ...doc, score: 0 });
        }
      }
    }

    return results;
  }

  /**
   * Phase 2: the candidates the ranking names, in its order, each once.
   *
   * @throws {Error} When the call fails, runs past the timeout, or answers something other than a JSON array.
   */
  private async listwiseRank(query: string, candidates: ScoredDocument[], timeoutMs: number): Promise<ScoredDocument[]> {
    const docList = candidates
      .map((d) => `[${d.id}] ${d.content.slice(0, 200)}`)
      .join('\n');
    const userPrompt = `Query: "${query}"\n\nDocuments:\n${docList}`;

    const raw = await this.call(LISTWISE_SYSTEM, userPrompt, this.rankingModel, timeoutMs);
    const ranking: unknown = JSON.parse(stripFence(raw));
    if (!Array.isArray(ranking)) {
      throw new Error('LlmJudgeReranker: the ranking is not a JSON array.');
    }

    const byId = new Map(candidates.map((c) => [c.id, c]));
    const ranked: ScoredDocument[] = [];
    const seen = new Set<ScoredDocument>();
    for (const id of ranking) {
      const doc = typeof id === 'string' ? byId.get(id) : undefined;
      if (doc && !seen.has(doc)) {
        seen.add(doc);
        ranked.push(doc);
      }
    }
    return ranked;
  }
}
