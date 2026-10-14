/**
 * @module safety/claims/tooling/HistoricalCaptureEvidence
 *
 * The `historical-capture` class: an old picture of a release, valid only in a dated history placement whose caption
 * and alternative text are catalogued, and only while its original bytes, receipt and bundle remain verifiable in the
 * durable store. It never stands in for a current `capture`: the verifier keys evidence by kind, so a requirement for
 * a current picture cannot be met by this class, and an active placement is contradicted here.
 */
import type { EvidenceAdapter } from '../types.js';
import { validateCaptureSet, type CaptureManifest, type CaptureRequirement } from './CaptureEvidence.js';

/** A historical capture as evidence. */
export interface HistoricalCapturePayload {
  /** The original capture's id; its manifest and the bundle use the same id. */
  captureId: string;
  /** The SHA-256 of the original picture's bytes, in lower-case hex. */
  originalSha256: string;
  /** The UTC day the capture was first served, `YYYY-MM-DD`. */
  originalDate: string;
  /** The UTC day of the served receipt that witnessed it. */
  receiptDate: string;
  /** The digest of the durable bundle that holds the original. */
  bundleDigest: string;
  /** The digest of the original's receipt; support requires the one the caller's policy names. */
  originalReceiptDigest?: string;
  /** The original capture's manifest; support requires it. */
  originalManifest?: CaptureManifest;
  /** Where the picture is shown: the kind of page, its route and the catalogued caption and alternative-text ids. */
  placement: { kind: 'history' | 'active'; route: string; captionId: string; altId: string };
  /** The claims the original showed. */
  claimIds: readonly string[];
}

/** What the adapter needs from its host. */
export interface HistoricalCaptureOptions {
  /** Catalogued caption and alternative-text ids. */
  captions: ReadonlySet<string>;
  /** Strict historical consumers resolve this from their reviewed publication policy. */
  originalFor?: (claimId: string) => { receiptDigest: string; placement: HistoricalCapturePayload['placement']; claimIds: readonly string[]; requirement: CaptureRequirement } | undefined;
  /** True when the original receipt and capture tuple verify against what `originalFor` expects; without both callbacks nothing is supported. */
  verifyOriginal?: (payload: HistoricalCapturePayload, expected: { receiptDigest: string; placement: HistoricalCapturePayload['placement']; claimIds: readonly string[]; requirement: CaptureRequirement }) => Promise<boolean>;
  /** True when the bundle is intact in the durable store and holds the capture with this hash. */
  verifyBundleCapture: (bundleDigest: string, captureId: string, sha256: string) => Promise<boolean>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The static problems of a payload, before the store is read.
 *
 * @param payload - The historical capture.
 * @param captions - Catalogued caption and alternative-text ids.
 * @returns The problems; none for a history placement with catalogued words, `YYYY-MM-DD` dates in order and a
 *   named claim.
 */
export function historicalProblems(payload: HistoricalCapturePayload, captions: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (payload.placement.kind !== 'history') problems.push('an old capture on an active page');
  if (!captions.has(payload.placement.captionId)) problems.push('the caption is not catalogued');
  if (!captions.has(payload.placement.altId)) problems.push('the alternative text is not catalogued');
  if (!DAY.test(payload.originalDate) || !DAY.test(payload.receiptDate)) problems.push('a date is not YYYY-MM-DD');
  else if (payload.originalDate > payload.receiptDate) problems.push('the capture is dated after its receipt');
  if (payload.claimIds.length === 0) problems.push('no claim is named');
  return problems;
}

/**
 * The adapter for `historical-capture` evidence.
 *
 * @param options - The catalogued words, the original-receipt policy and the durable store check.
 * @returns An adapter that answers `unverifiable` without both policy callbacks or when the original cannot be read
 *   back, `contradicted` on any problem, and `supported` otherwise.
 */
export function historicalCaptureAdapter(options: HistoricalCaptureOptions): EvidenceAdapter {
  return {
    kind: 'historical-capture',
    check: async (record, claim) => {
      const payload = record.payload as HistoricalCapturePayload;
      const problems = historicalProblems(payload, options.captions);
      if (!payload.claimIds.includes(claim.claimId)) problems.push('the requesting claim is not in the original');
      if (!options.originalFor || !options.verifyOriginal) return { verdict: 'unverifiable', basis: 'deterministic', detail: 'original receipt policy is required' };
      if (options.originalFor) {
        const expected = options.originalFor(claim.claimId);
        if (!expected || !expected.claimIds.includes(claim.claimId) || expected.receiptDigest !== payload.originalReceiptDigest || JSON.stringify(expected.placement) !== JSON.stringify(payload.placement)) problems.push('the original receipt or historical placement differs');
        else {
          if (!payload.originalManifest || !expected.requirement.identity) problems.push('the original implementation tuple is missing');
          else problems.push(...validateCaptureSet({ manifests: [payload.originalManifest], bytes: { [payload.captureId]: payload.originalSha256 }, requirement: expected.requirement }));
          if (!await options.verifyOriginal(payload, expected)) problems.push('the original receipt and capture tuple are not verified');
        }
      }
      if (problems.length > 0) return { verdict: 'contradicted', basis: 'deterministic', detail: problems.join('; ') };
      const verified = await options.verifyBundleCapture(payload.bundleDigest, payload.captureId, payload.originalSha256);
      return verified
        ? { verdict: 'supported', basis: 'deterministic', detail: `the original of ${payload.originalDate} is intact` }
        : { verdict: 'unverifiable', basis: 'deterministic', detail: 'the original provenance cannot be read back' };
    },
  };
}
