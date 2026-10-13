/**
 * @module safety/claims/EvidenceClaimVerifier
 *
 * The deterministic verifier for published claims. Each claim names the evidence it needs; each piece must be present,
 * unaltered (its digest recomputed from its payload) and judged `supported` on a `deterministic` basis by the one
 * adapter registered for its kind. A missing record, a missing adapter, a thrown or malformed answer, a timeout, a
 * similarity basis or any verdict but `supported` refuses the claim. There is no fallback that keeps a verdict when an
 * adapter fails, and no score that stands in for a check. The verifier calls no model and no network; adapters
 * decide what their kind means.
 */
import { canonicalJson, sha256Hex } from './digest.js';
import {
  EVIDENCE_KINDS,
  type AdapterOutcome,
  type ClaimFailure,
  type ClaimResult,
  type ClaimUnderTest,
  type EvidenceAdapter,
  type EvidenceKind,
  type EvidenceRecord,
  type InputError,
  type VerificationReport,
} from './types.js';

/** How long one adapter call may take before it is aborted and counted as a timeout. */
export const DEFAULT_ADAPTER_TIMEOUT_MS = 10_000;

/** The most records one verification takes. */
export const DEFAULT_MAX_RECORDS = 100_000;

/** The most requirements one claim takes. */
export const DEFAULT_MAX_REQUIREMENTS = 500;

/** The verifier's settings. */
export interface EvidenceClaimVerifierOptions {
  /** One adapter per kind; two for one kind, or one for an unknown kind, throws. */
  adapters: readonly EvidenceAdapter[];
  /** Milliseconds one adapter call may take before it is aborted and counted as a timeout; {@link DEFAULT_ADAPTER_TIMEOUT_MS} when omitted. */
  timeoutMs?: number;
  /** The most records one verification takes, more being an `out_of_bounds` input error; {@link DEFAULT_MAX_RECORDS} when omitted. */
  maxRecords?: number;
  /** The most requirements one claim takes, more being an `out_of_bounds` input error; {@link DEFAULT_MAX_REQUIREMENTS} when omitted. */
  maxRequirements?: number;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(EVIDENCE_KINDS);
const VERDICTS: ReadonlySet<string> = new Set(['supported', 'weak', 'unverifiable', 'contradicted']);
const BASES: ReadonlySet<string> = new Set(['deterministic', 'similarity']);
const keyOf = (kind: string, ref: string): string => `${kind}\u0000${ref}`;

type Run = { kind: 'ok'; outcome: AdapterOutcome } | { kind: 'error'; detail: string } | { kind: 'timeout' };

/** Verifies claims against evidence records, one result per claim. */
export class EvidenceClaimVerifier {
  private readonly adapters: ReadonlyMap<EvidenceKind, EvidenceAdapter>;
  private readonly timeoutMs: number;
  private readonly maxRecords: number;
  private readonly maxRequirements: number;

  /**
   * @param options - The adapters, one per kind, and the bounds.
   * @throws Error when two adapters share a kind or an adapter names an unknown kind.
   */
  constructor(options: EvidenceClaimVerifierOptions) {
    const adapters = new Map<EvidenceKind, EvidenceAdapter>();
    for (const adapter of options.adapters) {
      if (!KNOWN_KINDS.has(adapter.kind)) throw new Error(`EvidenceClaimVerifier: an adapter for the unknown kind ${String(adapter.kind)}`);
      if (adapters.has(adapter.kind)) throw new Error(`EvidenceClaimVerifier: two adapters for the kind ${adapter.kind}`);
      adapters.set(adapter.kind, adapter);
    }
    this.adapters = adapters;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxRequirements = options.maxRequirements ?? DEFAULT_MAX_REQUIREMENTS;
  }

  /**
   * Verifies every claim. Claims are checked one after another, and each requirement's adapter is called once.
   *
   * @param claims - The claims, with unique ids.
   * @param evidence - The records, unique by kind and reference.
   * @returns Input errors with no results, or one result per claim in input order.
   */
  async verify(claims: readonly ClaimUnderTest[], evidence: readonly EvidenceRecord[]): Promise<VerificationReport> {
    const inputErrors = this.inputErrors(claims, evidence);
    if (inputErrors.length > 0) return { inputErrors, results: [] };
    const records = new Map(evidence.map((record) => [keyOf(record.kind, record.ref), record] as const));
    const results: ClaimResult[] = [];
    for (const claim of claims) results.push(await this.verifyClaim(claim, records));
    return { inputErrors: [], results };
  }

  private inputErrors(claims: readonly ClaimUnderTest[], evidence: readonly EvidenceRecord[]): InputError[] {
    const errors: InputError[] = [];
    if (claims.length === 0) errors.push({ code: 'empty_claim_set', detail: 'no claim was given' });
    if (evidence.length > this.maxRecords) errors.push({ code: 'out_of_bounds', detail: `${evidence.length} records exceed ${this.maxRecords}` });
    const ids = new Set<string>();
    for (const claim of claims) {
      if (ids.has(claim.claimId)) errors.push({ code: 'duplicate_claim_id', detail: `the claim ${claim.claimId} appears twice` });
      ids.add(claim.claimId);
      if (claim.requirements.length > this.maxRequirements) errors.push({ code: 'out_of_bounds', detail: `${claim.claimId} names ${claim.requirements.length} requirements` });
      for (const requirement of claim.requirements) {
        if (!KNOWN_KINDS.has(requirement.kind)) errors.push({ code: 'unknown_kind', detail: `${claim.claimId} needs evidence of the unknown kind ${String(requirement.kind)}` });
      }
    }
    const keys = new Set<string>();
    for (const record of evidence) {
      if (!KNOWN_KINDS.has(record.kind)) errors.push({ code: 'unknown_kind', detail: `a record of the unknown kind ${String(record.kind)}` });
      const key = keyOf(record.kind, record.ref);
      if (keys.has(key)) errors.push({ code: 'duplicate_evidence', detail: `two records of kind ${record.kind} named ${record.ref}` });
      keys.add(key);
    }
    return errors;
  }

  private async verifyClaim(claim: ClaimUnderTest, records: ReadonlyMap<string, EvidenceRecord>): Promise<ClaimResult> {
    const failures: ClaimFailure[] = [];
    if (claim.requirements.length === 0) {
      failures.push({ code: 'no_requirements', kind: null, ref: null, detail: 'a claim that names no evidence is never authorized' });
    }
    const seen = new Set<string>();
    let checked = 0;
    for (const { kind, ref } of claim.requirements) {
      const key = keyOf(kind, ref);
      if (seen.has(key)) {
        failures.push({ code: 'duplicate_requirement', kind, ref, detail: 'the requirement is named twice' });
        continue;
      }
      seen.add(key);
      const record = records.get(key);
      if (record === undefined) {
        failures.push({ code: 'missing_evidence', kind, ref, detail: 'no record of this kind and reference' });
        continue;
      }
      const recomputed = digestOrNull(record.payload);
      if (recomputed === null || recomputed !== record.digest) {
        failures.push({ code: 'altered_evidence', kind, ref, detail: 'the payload does not match its digest' });
        continue;
      }
      const adapter = this.adapters.get(kind);
      if (adapter === undefined) {
        failures.push({ code: 'missing_adapter', kind, ref, detail: `no adapter checks ${kind} evidence` });
        continue;
      }
      checked += 1;
      const run = await this.run(adapter, record, claim);
      if (run.kind === 'timeout') failures.push({ code: 'adapter_timeout', kind, ref, detail: `no answer within ${this.timeoutMs} ms` });
      else if (run.kind === 'error') failures.push({ code: 'adapter_error', kind, ref, detail: run.detail });
      else if (run.outcome.basis !== 'deterministic') failures.push({ code: 'similarity_basis', kind, ref, detail: 'a similarity score never authorizes a claim' });
      else if (run.outcome.verdict !== 'supported') failures.push({ code: 'not_supported', kind, ref, detail: `${run.outcome.verdict}: ${run.outcome.detail}` });
    }
    return { claimId: claim.claimId, sentenceDigest: claim.sentenceDigest, authorized: failures.length === 0, checked, failures };
  }

  private async run(adapter: EvidenceAdapter, record: EvidenceRecord, claim: ClaimUnderTest): Promise<Run> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Run>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: 'timeout' });
      }, this.timeoutMs);
    });
    const answer = adapter.check(record, claim, controller.signal).then(
      (outcome): Run => (isOutcome(outcome) ? { kind: 'ok', outcome } : { kind: 'error', detail: 'the adapter answered without a known verdict and basis' }),
      (error: unknown): Run => ({ kind: 'error', detail: error instanceof Error ? error.message : String(error) }),
    );
    try {
      return await Promise.race([answer, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function isOutcome(value: unknown): value is AdapterOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const outcome = value as Record<string, unknown>;
  return typeof outcome.verdict === 'string' && VERDICTS.has(outcome.verdict) && typeof outcome.basis === 'string' && BASES.has(outcome.basis) && typeof outcome.detail === 'string';
}

function digestOrNull(payload: unknown): string | null {
  try {
    return sha256Hex(canonicalJson(payload));
  } catch {
    return null;
  }
}

/**
 * True only for a report with no input errors, at least one result and every claim authorized.
 *
 * @param report - A verifier's report.
 */
export function allAuthorized(report: VerificationReport): boolean {
  return report.inputErrors.length === 0 && report.results.length > 0 && report.results.every((result) => result.authorized);
}
