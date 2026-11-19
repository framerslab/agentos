/**
 * @fileoverview Types for the citation verification pipeline.
 *
 * Used by CitationVerifier (core) and verify_citations tool (extension).
 *
 * @module agentos/rag/citation/types
 */

/**
 * Canonical verdict vocabulary shared across all grounding/citation pipelines
 * in the AgentOS ecosystem ({@link CitationVerifier} core, the Grounding
 * Guard extension, future implementations).
 *
 * - `'supported'`    — the claim is entailed by at least one source.
 * - `'weak'`         — confidence sits between the support and unverifiable
 *                      thresholds. Some implementations (e.g. the NLI-based
 *                      Grounding Guard) collapse this into `'unverifiable'`;
 *                      cosine-similarity-based pipelines surface it as its
 *                      own bucket.
 * - `'unverifiable'` — no source supports or contradicts the claim with
 *                      sufficient confidence.
 * - `'contradicted'` — at least one source contradicts the claim.
 */
export type ClaimVerdictKind = 'supported' | 'weak' | 'unverifiable' | 'contradicted';

/** Verdict for a single verified claim. */
export interface ClaimVerdict {
  /** The atomic claim text. */
  text: string;
  /** Verification verdict. */
  verdict: ClaimVerdictKind;
  /** Cosine similarity to best-matching source (0-1). 0 and not a score when `scored` is false. */
  confidence: number;
  /**
   * False when no cosine was computed: with `pickOnly` and a single source, the source is named without an embedding
   * and `confidence` is 0. Left out when the verdict was scored.
   */
  scored?: false;
  /** Index of the best-matching source in the input array. */
  sourceIndex?: number;
  /** The matching source fragment (truncated to 200 chars). */
  sourceSnippet?: string;
  /** Source URL or file path. */
  sourceRef?: string;
  /** True if this claim was verified via web search fallback. */
  webVerified?: boolean;
}

/** Aggregated verification result for a text. */
export interface VerifiedResponse {
  /** Per-claim verification results. */
  claims: ClaimVerdict[];
  /** True if no claims are contradicted. */
  overallGrounded: boolean;
  /** Ratio of supported claims to total (0-1). */
  supportedRatio: number;
  /** Total claims extracted. */
  totalClaims: number;
  /** Counts by verdict type. */
  supportedCount: number;
  contradictedCount: number;
  unverifiableCount: number;
  weakCount: number;
}

/** A source document for verification. */
export interface VerificationSource {
  /** Source text content. */
  content: string;
  /** Source title or heading. */
  title?: string;
  /** Source URL or file path. */
  url?: string;
  /**
   * The source's vector, made by the same model as the claims' vectors. A source that carries one is not sent to
   * `embedFn`; its length must equal the claims' vectors' length.
   */
  embedding?: readonly number[];
}

/** Configuration for CitationVerifier. */
export interface CitationVerifierConfig {
  /** Batch embedding function: texts → embedding vectors. */
  embedFn: (texts: string[]) => Promise<number[][]>;
  /** Cosine similarity threshold for "supported". Default: 0.6 */
  supportThreshold?: number;
  /** Below this threshold, claim is "unverifiable". Default: 0.3 */
  unverifiableThreshold?: number;
  /** Optional NLI function for contradiction detection. */
  nliFn?: (premise: string, hypothesis: string) => Promise<{
    label: 'entailment' | 'contradiction' | 'neutral';
    score: number;
  }>;
  /** Optional claim extractor. Falls back to sentence splitting. */
  extractClaims?: (text: string) => Promise<string[]>;
  /**
   * For a host that uses the cosine only to choose a source. With exactly one source, no embedding is made: every
   * claim names that source with `confidence: 0` and `scored: false`, and `nliFn`, when given, decides the verdict
   * (entailment above 0.7 supported, contradiction above 0.7 contradicted, anything else unverifiable). Without
   * `nliFn` the verdict is unverifiable. With more than one source the cosine ranks them as usual.
   */
  pickOnly?: boolean;
}
