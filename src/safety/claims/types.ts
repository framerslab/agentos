/**
 * @module safety/claims/types
 *
 * The shapes of deterministic claim evidence: what a claim needs, what a piece of evidence is, what an adapter answers
 * and what the verifier reports. A claim is authorized only when every piece of evidence it names is present,
 * unaltered and judged `supported` on a deterministic basis by the adapter for its kind; the verdicts are the citation
 * pipeline's vocabulary, so a similarity score can be reported in the same terms and still never authorize.
 */
import type { ClaimVerdictKind } from '../../cognition/rag/citation/types.js';

/** The kinds of evidence the verifier knows; `historical-capture` is the history-only picture class. */
export const EVIDENCE_KINDS = [
  'route',
  'test',
  'capture',
  'historical-capture',
  'deployment',
  'activation',
  'setting',
  'request',
  'absence',
  'privacy',
  'suppression',
  'cold-read',
  'specification',
  'source',
  'offer',
] as const;

/** One kind of evidence. */
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** A piece of evidence: its kind, a reference unique within the kind, the digest of its payload and the payload. */
export interface EvidenceRecord<P = unknown> {
  /** What the evidence is. */
  kind: EvidenceKind;
  /** Its reference, unique among records of the same kind. */
  ref: string;
  /** `digestOf(payload)`: the SHA-256 of the payload's canonical JSON in lower-case hex; a record whose payload no longer matches is refused. */
  digest: string;
  /** What the adapter for the kind reads. */
  payload: P;
}

/** One piece of evidence a claim needs, named by kind and reference. */
export interface EvidenceRequirement {
  kind: EvidenceKind;
  ref: string;
}

/** A claim as the verifier receives it: its id, the digest of the sentence it would authorize and what it needs. */
export interface ClaimUnderTest {
  /** An atomic claim id, unique in one verification. */
  claimId: string;
  /** The digest of the approved sentence the claim would authorize; it is carried into the result unchanged. */
  sentenceDigest: string;
  /** The evidence the claim needs; a claim with none is refused. */
  requirements: readonly EvidenceRequirement[];
}

/** How an adapter reached its verdict: a deterministic check, or a similarity score, which never authorizes. */
export type EvidenceBasis = 'deterministic' | 'similarity';

/** An adapter's answer for one record and one claim. */
export interface AdapterOutcome {
  /** The citation pipeline's verdict; only `supported` can authorize. */
  verdict: ClaimVerdictKind;
  /** Only `deterministic` can authorize. */
  basis: EvidenceBasis;
  /** A short reason that holds no content of the evidence's subject. */
  detail: string;
}

/** Checks the records of one kind. It is given an abort signal that fires at the verifier's timeout. */
export interface EvidenceAdapter {
  kind: EvidenceKind;
  check(record: EvidenceRecord, claim: ClaimUnderTest, signal: AbortSignal): Promise<AdapterOutcome>;
}

/** Why a claim was refused. */
export type ClaimFailureCode =
  | 'no_requirements'
  | 'duplicate_requirement'
  | 'missing_evidence'
  | 'altered_evidence'
  | 'missing_adapter'
  | 'adapter_error'
  | 'adapter_timeout'
  | 'similarity_basis'
  | 'not_supported';

/** One reason a claim was refused, with the requirement it concerns when there is one. */
export interface ClaimFailure {
  code: ClaimFailureCode;
  kind: EvidenceKind | null;
  ref: string | null;
  detail: string;
}

/** The verdict on one claim. */
export interface ClaimResult {
  claimId: string;
  sentenceDigest: string;
  /** True only when `failures` is empty. */
  authorized: boolean;
  /** How many requirements reached their adapter. */
  checked: number;
  failures: readonly ClaimFailure[];
}

/** What makes a verification's input unusable as a whole. */
export type InputErrorCode = 'empty_claim_set' | 'duplicate_claim_id' | 'duplicate_evidence' | 'unknown_kind' | 'out_of_bounds';

/** One input error. */
export interface InputError {
  code: InputErrorCode;
  detail: string;
}

/** The report: with input errors, `results` is empty and nothing is authorized; otherwise one result per claim, in input order. */
export interface VerificationReport {
  inputErrors: readonly InputError[];
  results: readonly ClaimResult[];
}
