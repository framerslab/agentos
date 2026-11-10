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
  /** The rerank score, when a rerank scored this candidate. */
  rerankScore?: number;
  /** Whether the memory block shows it. */
  outcome: 'included' | 'left_out';
  /**
   * Set for a candidate left out, and only then: `budget` when its section was
   * offered no room (or the candidate never reached a section), `section_full`
   * when it did not fit whole in the room its section was offered, `dedupe`
   * when another candidate holds the same memory (`duplicateOf`).
   */
  reason?: 'budget' | 'dedupe' | 'section_full';
  /** The candidate it duplicates, with `reason: 'dedupe'`. */
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
  /** How many candidates were sent to the reranker. */
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
    requested: number;
    effective: number;
    clampReason?: 'prompt_share' | 'zero_remaining';
    promptShareTokens?: number;
    otherContextTokens?: number;
    hop?: number;
    reassembled?: boolean;
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
  /** What reached the model, once the prompt was built. */
  delivery?: {
    memoryBlockTokens: number;
    otherContext?: { ragTokens: number; longTermMemoryTokens: number; deliveredTokens: number; cutBy?: 'prompt_engine_truncate' | 'prompt_engine_summarize' };
    issueCodes?: string[];
  };
}

/** A ranked candidate before assembly. */
export interface RankedRecallCandidate {
  id: string;
  ranks: MemoryRecallCandidate['ranks'];
  fusedScore: number;
  rerankScore?: number;
}

/**
 * The candidates' outcomes from the assembler's line report.
 *
 * Each ranked candidate takes its line's outcome, reason, tokens and section;
 * one the assembler gave no line is left out for `budget`, with 0 tokens. A
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
