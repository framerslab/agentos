/**
 * @file types.ts
 * @description Core types for the Hindsight 4-network typed observer.
 * Each fact lives in one of four typed banks: World (objective external
 * facts), Experience (first-person biographical), Opinion (claims with
 * confidence < 1), Observation (preference-neutral entity summaries).
 *
 * The schema follows Hindsight paper Equation 1
 * (arxiv.org/html/2512.12818v1 §2.1):
 *
 *   f = (u, b, t, v, τs, τe, τm, ℓ, c, x)
 *
 * mapped to TypeScript field names below. See spec
 * `packages/agentos-bench/docs/specs/2026-04-26-hindsight-4network-observer-design.md`
 * §2.1-§2.2 for the verbatim definition.
 *
 * @module @framers/agentos/memory/retrieval/typed-network/types
 */

/**
 * Bank identifier — one of four typed networks per Hindsight §2.2. The
 * bank determines retrieval semantics: World facts compose under
 * objective truth, Experience under first-person continuity, Opinion
 * under belief evolution, Observation under entity descriptions.
 */
export const BANK_IDS = ['WORLD', 'EXPERIENCE', 'OPINION', 'OBSERVATION'] as const;

/** {@link BANK_IDS} as a TypeScript literal type. */
export type BankId = (typeof BANK_IDS)[number];

/**
 * Type guard: narrows an arbitrary string to {@link BankId}. Use to
 * validate untrusted inputs (LLM extraction output, deserialized
 * persistence) before routing into the typed network.
 */
export function isBankId(s: string): s is BankId {
  return (BANK_IDS as readonly string[]).includes(s);
}

/**
 * Edge kind in the typed-network graph. Each kind carries a different
 * spreading-activation multiplier μ(ℓ) per Hindsight Eq. 12 (§2.4.1).
 *
 * - **temporal**: connects facts that share an occurrence-interval
 *   overlap. Weight derived from `exp(−Δt / σt)`.
 * - **semantic**: connects facts whose embeddings exceed a cosine
 *   threshold θs.
 * - **entity**: bidirectional link between facts mentioning the same
 *   named entity. Weight 1.0.
 * - **causal**: explicit reasoning marker linking premise → conclusion
 *   facts. LLM-extracted at observation time; weight 1.0.
 */
export const EDGE_KINDS = ['temporal', 'semantic', 'entity', 'causal'] as const;
/** {@link EDGE_KINDS} as a TypeScript literal type. */
export type EdgeKind = (typeof EDGE_KINDS)[number];

/**
 * Single named participant in a fact (e.g. "Alice", "the deployment
 * server"). Roles match the participant's grammatical / conversational
 * function — speaker, addressee, subject, object, etc.
 */
export interface Participant {
  /** Resolved name (after coreference). */
  name: string;
  /** Conversational or semantic role. */
  role: string;
}

/**
 * Temporal envelope per Hindsight Eq. 1 fields τs, τe, τm. ISO 8601
 * strings; missing `start` / `end` indicates an instant rather than an
 * interval. `mention` is always populated — it's the timestamp at
 * which the fact was authored.
 */
export interface FactTemporal {
  /** Interval start (inclusive). ISO 8601. Optional for instant facts. */
  start?: string;
  /** Interval end (inclusive). ISO 8601. Optional for instant facts. */
  end?: string;
  /** Mention timestamp — when the fact was first authored. ISO 8601. */
  mention: string;
}

/**
 * A typed fact in the Hindsight memory schema. Carries narrative text,
 * embedding, temporal envelope, participants, reasoning markers,
 * extracted entities, and a confidence score in [0, 1]. Confidence
 * defaults to 1.0 for World/Experience/Observation facts; the Opinion
 * bank stores `(text, confidence, timestamp)` tuples per §2.2.
 */
export interface TypedFact {
  /** Stable unique identifier. Convention: `<sessionId>-fact-<index>`. */
  id: string;
  /** Bank assignment from the LLM extractor's fact-type classification. */
  bank: BankId;
  /** Narrative text of the fact, post-coreference resolution. */
  text: string;
  /**
   * Embedding vector. {@link TypedNetworkObserver} creates each fact with an
   * empty array, and nothing in this package fills it.
   */
  embedding: number[];
  /** Temporal envelope (occurrence interval + mention timestamp). */
  temporal: FactTemporal;
  /** Named participants and their roles. */
  participants: Participant[];
  /**
   * Verbatim reasoning markers preserved from the source content
   * ("because", "since", "therefore", etc.). Used downstream to
   * extract causal edges.
   */
  reasoningMarkers: string[];
  /** Named entities mentioned in the fact (proper nouns, products, places). */
  entities: string[];
  /** Confidence ∈ [0, 1]. 1.0 for non-Opinion facts; LLM-output for Opinion. */
  confidence: number;
  /** Optional auxiliary metadata (source ID, conversation turn index, etc.). */
  metadata?: Record<string, unknown>;
}

/**
 * Typed edge between two facts in the network graph. Direction matters
 * for causal edges (premise → conclusion); other kinds are
 * bidirectional and stored as a pair of edges.
 */
export interface TypedEdge {
  /** Source fact ID. */
  fromFactId: string;
  /** Target fact ID. */
  toFactId: string;
  /** Edge kind — drives μ(ℓ) multiplier in spreading activation. */
  kind: EdgeKind;
  /** Edge weight. Composed with decay δ and μ(ℓ) at activation time. */
  weight: number;
}
