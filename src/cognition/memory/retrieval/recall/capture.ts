/**
 * @fileoverview The per-turn recall capture: one versioned record of what a
 * memory assembly retrieved, how each candidate ranked, and which candidates
 * the block shows. It carries ids, ranks, scores, counts and timings, and never
 * a memory's text or the query's.
 *
 * `CognitiveMemoryManager.assembleForPrompt()` returns it on
 * `AssembledMemoryContext.capture` unless the manager's `recall.capture` is
 * `'off'`; a GMI turn hands it on as `GMIOutput.memoryRecall`, a `gmi()` or
 * `agent({ runtime: 'gmi' })` session's `send()` as
 * `GenerateTextResult.memoryRecall`, and, under `'metadata+stream'` only, the
 * runtime stream as a `METADATA_UPDATE` carrying `memorySources` and the
 * `FINAL_RESPONSE`'s `memoryRecall`.
 *
 * @module agentos/memory/retrieval/recall/capture
 */

import type { AssembledLineOutcome, MemoryBudgetAllocation } from '../../core/types.js';

/** The version every capture record carries. */
export const MEMORY_RECALL_CAPTURE_VERSION = 'memory-recall-capture/1' as const;

/** A recall leg: one way of finding candidates for a turn. */
export type RecallLeg = 'dense' | 'exact_words' | 'recency' | 'supplied';

/** Why a recall leg did not run. */
export type LegAbsentReason = 'no_store' | 'no_embedder' | 'no_index' | 'no_scope_filter' | 'query_error' | 'disabled';

/** Why no rerank scores were applied to a turn's candidates. */
export type RerankSkipReason = 'loading' | 'unavailable' | 'timeout' | 'error' | 'backoff' | 'none_configured';

/**
 * How much of a turn's recall is recorded: `'off'` records nothing,
 * `'metadata'` (the default) returns the record with the assembled context and
 * the turn result, `'metadata+stream'` also sends it on the runtime stream.
 */
export type RecallCaptureMode = 'off' | 'metadata' | 'metadata+stream';

/** One candidate memory of a turn: how it ranked and what became of it. */
export interface MemoryRecallCandidate {
  /** The memory trace's id. */
  id: string;
  /** Its 1-based rank in each leg that returned it; empty for a memory the block shows that no leg returned. */
  ranks: Partial<Record<RecallLeg, number>>;
  /** The score the candidates were ordered by before assembly (under dense retrieval, the trace's retrieval score). */
  fusedScore: number;
  /** The score the reranker gave it, before the blend; absent when no rerank scored it. */
  rerankScore?: number;
  /** Whether the memory block shows it. */
  outcome: 'included' | 'left_out';
  /**
   * Set for a candidate left out, and only then: `budget` when its section was
   * offered no room (or the candidate never reached a section), `section_full`
   * when it did not fit whole in the room its section was offered, `dedupe`
   * when another candidate holds the same memory (`duplicateOf`), and
   * `render_failed` on a GMI hop that was sent no block because rendering it
   * again for the hop failed (`budget.renderFailed`).
   */
  reason?: 'budget' | 'dedupe' | 'section_full' | 'render_failed';
  /**
   * The candidate it duplicates: with `reason: 'dedupe'`, or, for one the block
   * shows only through its graph association, with `outcome: 'included'`.
   */
  duplicateOf?: string;
  /** Whether a memory-question reserve added it. */
  reserve?: boolean;
  /** Tokens of its line, about 4 characters a token: as rendered when included, as it would render whole when left out. */
  tokens: number;
  /** The section of the block its line belongs to. */
  section?: keyof MemoryBudgetAllocation | 'involuntary';
}

/**
 * The reranker that scored a turn's candidates, or why none did.
 *
 * `provider` is `'local'` for the in-process cross-encoder, `'llm'` for the LLM
 * judge, `'other'` for any other provider of a `rerankerService` passed on the
 * manager (Cohere's API among them: the query and the candidates' texts went to
 * that provider), and `'none'` when no rerank scores were applied.
 */
export interface MemoryRecallReranker {
  provider: 'none' | 'local' | 'llm' | 'other';
  /** The model the provider reported. */
  model?: string;
  /** The model's revision, when one is pinned. */
  revision?: string;
  /** With `provider: 'none'`: why no rerank scores were applied. */
  reason?: RerankSkipReason;
  /** How many candidates the reranker was sent (as the provider reports it, else at most `MEMORY_RERANK_MAX_DOCUMENTS`). */
  candidates?: number;
  /** How long the rerank took, in milliseconds. */
  ms?: number;
}

/** The record of one memory assembly. No memory text and no query text. */
export interface MemoryRecallCapture {
  version: typeof MEMORY_RECALL_CAPTURE_VERSION;
  /** `dense` for the vector recall; `hybrid` when the recall joins several legs. */
  retrieval: 'dense' | 'hybrid';
  /** The budget the block was assembled in: the one asked for, and the one used. */
  budget: {
    /** The configured budget of the block (`recall.budget.totalTokens`, or the caller's). */
    requested: number;
    /** The budget the block was rendered in. */
    effective: number;
    /** Set when a model's share of the prompt held less than `requested`: `zero_remaining` when nothing was left. */
    clampReason?: 'prompt_share' | 'zero_remaining';
    /** The serving model's retrieved-context share, in tokens (a GMI turn's record). */
    promptShareTokens?: number;
    /** The turn's RAG and long-term-memory text, in tokens, which the share holds first (a GMI turn's record). */
    otherContextTokens?: number;
    /** The model hop the record is for, 0 for the route's primary (a GMI turn's record). */
    hop?: number;
    /** True when the block was rendered again at `effective` from the turn's recall, with no second retrieval. */
    reassembled?: boolean;
    /** True when rendering the block again for the hop failed, so the hop was sent no block (a GMI turn's record). */
    renderFailed?: boolean;
  };
  /** Estimated tokens of the block, headers included. */
  tokensUsed: number;
  /** The section shares the block was assembled with. */
  allocation: MemoryBudgetAllocation;
  /** Each leg of the recall: whether it ran, why not, how many candidates it returned, how long it took. */
  legs: Array<{ leg: RecallLeg; ran: boolean; reason?: LegAbsentReason; candidates: number; ineligible: number; ms: number }>;
  /** Counts of supplied candidates that were refused; never their ids. */
  suppliedRejected?: { outOfScope: number; ineligible: number };
  /** The full-text backend the exact-words leg read, or `none` when that leg did not run. */
  lexicalBackend: 'fts5' | 'fts4' | 'postgres_tsvector' | 'in_process' | 'none';
  /** The embedder of the dense leg, when known. */
  embedder?: { provider: string; model: string };
  reranker: MemoryRecallReranker;
  /** Whether the memory-question reserve added candidates, and how many. */
  memoryQuestionReserve: { fired: boolean; added: number };
  /** Every candidate, in the order recall ranked them, then any memory the block shows that no leg returned. */
  candidates: MemoryRecallCandidate[];
  /** Milliseconds of each stage, rounded. */
  timings: { legsMs: number; fuseMs: number; dedupeMs: number; rerankMs: number; assembleMs: number; totalMs: number };
  /**
   * What reached the model, once the prompt was built (a GMI turn's record): PromptEngine's count of the memory block,
   * which it never reduces; the other retrieved context the turn had (`ragTokens`, `longTermMemoryTokens`, by the
   * assembler's estimate) and what of it was sent (`deliveredTokens`, by PromptEngine's), with `cutBy` when PromptEngine
   * reduced it; and the codes of PromptEngine's issues about the context (`RAG_SUMMARIZATION_FAILED`,
   * `TOKEN_BUDGET_EXCEEDED_POST_OPT`). `promptReplacedByHook` is true when the host's `beforeModelCall` replaced the
   * prompt for the hop: the counts are then of the prompt PromptEngine built, and what the model received is the
   * hook's.
   */
  delivery?: {
    memoryBlockTokens: number;
    otherContext?: { ragTokens: number; longTermMemoryTokens: number; deliveredTokens: number; cutBy?: 'prompt_engine_truncate' | 'prompt_engine_summarize' };
    issueCodes?: string[];
    promptReplacedByHook?: boolean;
  };
}

/**
 * The most candidates a manager's memory recall sends its `rerankerService` (`maxDocuments` on the call): the
 * ones the dense leg ranks first. The rest keep their cognitive scores.
 */
export const MEMORY_RERANK_MAX_DOCUMENTS = 100;

/**
 * What a `CognitiveMemoryManager` retrieval reports for the recall capture, on
 * `CognitiveRetrievalResult.diagnostics.recall`: trace ids, ranks, scores and
 * a time, never a memory's text.
 */
export interface RetrievalRecallReport {
  /**
   * Each returned trace's 1-based rank in the dense leg: the order the vector
   * recall's cognitive scores (and the graph's activation) gave the traces,
   * before any rerank.
   */
  denseRanks: Record<string, number>;
  /**
   * Milliseconds of the dense leg: the query's embedding (and its HyDE
   * hypothesis, when one is asked for), the vector search, the scoring and
   * the graph's activation, not the co-activation the graph records after.
   */
  denseMs: number;
  /**
   * Each recall leg of the retrieval, as the capture reports it: whether it ran, why not (`no_embedder` when the
   * embedding manager gave the query no vector), how many candidates it returned, how many the eligibility checks
   * dropped (for the dense leg, the trust-policy filter), and its time. `CognitiveMemoryManager` always sets it.
   */
  legs?: MemoryRecallCapture['legs'];
  /** Each trace the reranker scored, with the score it gave before the blend. Absent when no rerank answered. */
  rerankScores?: Record<string, number>;
  /** `hybrid` when the retrieval fused the dense, exact-words and recency legs; `dense` (or absent) otherwise. */
  retrieval?: 'dense' | 'hybrid';
  /**
   * Under `hybrid`: the whole recall pool in fused order, the candidates the cut at `topK` left out and the ones the
   * dedupe dropped (`duplicateOf`) included, each with its ranks and fused score.
   */
  ranked?: RankedRecallCandidate[];
  /** Under `hybrid`: the full-text backend the exact-words leg read, or `none` when that leg did not run. */
  lexicalBackend?: MemoryRecallCapture['lexicalBackend'];
  /** Under `hybrid`: milliseconds of the legs (run together), the fusion and the dedupe. */
  timings?: { legsMs: number; fuseMs: number; dedupeMs: number };
}

/** A ranked candidate before assembly. */
export interface RankedRecallCandidate {
  id: string;
  ranks: MemoryRecallCandidate['ranks'];
  fusedScore: number;
  rerankScore?: number;
  /** Set when the hybrid recall's dedupe dropped it: the candidate that holds the same memory. */
  duplicateOf?: string;
}

/**
 * The candidates' outcomes from the assembler's line report.
 *
 * A ranked candidate the dedupe dropped (`duplicateOf`) is left out for
 * `dedupe`, with 0 tokens, unless the block shows it through another line (an
 * association in Related Context): then it takes that line's outcome, tokens
 * and section, and keeps its `duplicateOf`. Each other ranked candidate takes
 * its line's outcome, reason, tokens and section; one the assembler gave no
 * line is left out for `budget`, with 0 tokens. A
 * line for a memory no leg returned (an association's trace, the involuntary
 * memory) is added after the ranked candidates, with empty `ranks` and a
 * `fusedScore` of 0, so the included candidates are every memory the block
 * shows.
 *
 * @param ranked - The candidates in the order recall ranked them.
 * @param lines - The assembler's `lineOutcomes`.
 */
export function candidatesFrom(
  ranked: ReadonlyArray<RankedRecallCandidate>,
  lines: ReadonlyArray<AssembledLineOutcome>,
): MemoryRecallCandidate[] {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const candidates: MemoryRecallCandidate[] = ranked.map((candidate) => {
    const line = byId.get(candidate.id);
    const shown = line?.outcome === 'included';
    if (candidate.duplicateOf !== undefined && !shown) return { ...candidate, outcome: 'left_out' as const, reason: 'dedupe' as const, tokens: 0 };
    return line
      ? { ...candidate, outcome: line.outcome, ...(line.reason ? { reason: line.reason } : {}), tokens: line.tokens, section: line.section }
      : { ...candidate, outcome: 'left_out' as const, reason: 'budget' as const, tokens: 0 };
  });
  const rankedIds = new Set(ranked.map((candidate) => candidate.id));
  for (const line of lines) {
    if (rankedIds.has(line.id)) continue;
    candidates.push({
      id: line.id,
      ranks: {},
      fusedScore: 0,
      outcome: line.outcome,
      ...(line.reason ? { reason: line.reason } : {}),
      tokens: line.tokens,
      section: line.section,
    });
  }
  return candidates;
}

/**
 * The reranker record of a rerank that answered, from the provider id and the
 * model the provider reported: `local` for the cross-encoder, `llm` for the
 * LLM judge, `other` for any other provider.
 */
export function rerankerRecordOf(
  providerId: string | undefined,
  modelId: string | undefined,
  candidates: number,
  ms: number,
): MemoryRecallReranker {
  const provider: MemoryRecallReranker['provider'] = providerId === 'local' ? 'local' : providerId === 'llm-judge' ? 'llm' : 'other';
  return { provider, ...(modelId ? { model: modelId } : {}), candidates, ms: Math.round(ms) };
}
