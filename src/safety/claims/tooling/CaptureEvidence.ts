/**
 * @module safety/claims/tooling/CaptureEvidence
 *
 * A picture of a product as evidence. Each capture's manifest binds its bytes (SHA-256) to the driver and the
 * implementation that rendered it, the source commit and the executable, interface, harness, configuration and
 * provider-fixture digests, the run, the scenario and test, the claims it shows, the page it embeds in, the audience
 * and the serving mode. A set passes when every required size and look is present exactly once and each manifest
 * matches its bytes and the requirement; a picture made at another commit passes only when that commit is named as
 * adopted, after its original provenance was verified and archived.
 */
import type { EvidenceAdapter } from '../types.js';

/** A look. */
export type Look = 'light' | 'dark';

/** A viewport size and its device scale. */
export interface CaptureSize {
  width: number;
  height: number;
  /** The device scale factor. */
  scale: number;
}

/** One capture's manifest. */
export interface CaptureManifest {
  /** The capture's id; a set's `bytes` holds the hash of its bytes under this key. */
  captureId: string;
  /** The SHA-256 of the picture's bytes, in lower-case hex. */
  sha256: string;
  width: number;
  height: number;
  scale: number;
  look: Look;
  driverId: string;
  implementation: string;
  sourceCommit: string;
  executableDigest: string;
  uiDigest: string;
  harnessDigest: string;
  configurationDigest: string;
  providerFixtureDigest: string;
  run: { workflow: string; runId: string; attempt: number };
  scenarioId: string;
  testId: string;
  /** The claims the picture shows. */
  claimIds: readonly string[];
  /** The page that embeds the picture; its identity is the page's, not the pictured implementation's. */
  page: { route: string; identity: string };
  audience: string;
  servingMode: string;
}

/** What a pictured claim needs. */
export interface CaptureRequirement {
  claimIds: readonly string[];
  implementation: string;
  audience: string;
  servingMode: string;
  sizes: readonly CaptureSize[];
  looks: readonly Look[];
  /** The ids of the drivers allowed to make the set. */
  drivers: readonly string[];
  /** The commit under test; a capture made at it needs no adoption. */
  candidateCommit: string;
  /** Commits whose captures were verified and archived with their original provenance. */
  adoptedCommits: readonly string[];
  /** Optional exact runtime tuple supplied by the caller, independent of the submitted set. */
  identity?: Pick<CaptureManifest, 'executableDigest' | 'uiDigest' | 'harnessDigest' | 'configurationDigest' | 'providerFixtureDigest'>;
}

/** A set and its bytes' hashes, by capture id. */
export interface CaptureSetPayload {
  manifests: readonly CaptureManifest[];
  /** The SHA-256 of each capture's bytes as read, by capture id. */
  bytes: Readonly<Record<string, string>>;
  requirement: CaptureRequirement;
}

const sizeLabel = (s: CaptureSize): string => `${s.width}x${s.height}@${s.scale}`;

/**
 * Every way a set falls short of its requirement.
 *
 * @param payload - The manifests, the bytes' hashes and the requirement.
 * @returns The problems, in a fixed order: per manifest, then per required size and look.
 */
export function validateCaptureSet(payload: CaptureSetPayload): string[] {
  const { manifests, bytes, requirement } = payload;
  const problems: string[] = [];
  for (const m of manifests) {
    if (bytes[m.captureId] !== m.sha256) problems.push(`${m.captureId}: the hash is not the bytes' hash`);
    if (m.implementation !== requirement.implementation) problems.push(`${m.captureId}: implementation ${m.implementation}, not ${requirement.implementation}`);
    if (m.audience !== requirement.audience) problems.push(`${m.captureId}: audience ${m.audience}, not ${requirement.audience}`);
    if (m.servingMode !== requirement.servingMode) problems.push(`${m.captureId}: serving mode ${m.servingMode}, not ${requirement.servingMode}`);
    if (!requirement.drivers.includes(m.driverId)) problems.push(`${m.captureId}: the driver ${m.driverId} is not allowed`);
    if (m.sourceCommit !== requirement.candidateCommit && !requirement.adoptedCommits.includes(m.sourceCommit)) problems.push(`${m.captureId}: made at another commit, never adopted`);
    if (!requirement.claimIds.every((id) => m.claimIds.includes(id))) problems.push(`${m.captureId}: does not show every required claim`);
    for (const field of ['executableDigest', 'uiDigest', 'harnessDigest', 'configurationDigest', 'providerFixtureDigest'] as const) {
      if (m[field] === '') problems.push(`${m.captureId}: no ${field}`);
      if (requirement.identity && m[field] !== requirement.identity[field]) problems.push(`${m.captureId}: wrong ${field}`);
    }
  }
  for (const size of requirement.sizes) {
    for (const look of requirement.looks) {
      const found = manifests.filter((m) => m.width === size.width && m.height === size.height && m.scale === size.scale && m.look === look);
      if (found.length === 0) problems.push(`${sizeLabel(size)} ${look}: no capture`);
      if (found.length > 1) problems.push(`${sizeLabel(size)} ${look}: ${found.length} captures`);
    }
  }
  return problems;
}

/** The adapter for `capture` evidence: `unverifiable` without a trusted callback requirement, otherwise `supported` or `contradicted` by the set. */
export function captureAdapter(options: { requirementFor?: (claimId: string, ref: string) => CaptureRequirement | undefined } = {}): EvidenceAdapter {
  return {
    kind: 'capture',
    check: async (record, claim) => {
      const requirement = options.requirementFor?.(claim.claimId, record.ref);
      if (!requirement) return { verdict: 'unverifiable', basis: 'deterministic', detail: 'no trusted capture requirement' };
      const payload = record.payload as CaptureSetPayload;
      const problems = validateCaptureSet({ manifests: payload.manifests, bytes: payload.bytes, requirement });
      if (!requirement.claimIds.includes(claim.claimId) || payload.manifests.some((m) => !m.claimIds.includes(claim.claimId))) problems.push('the requesting claim is not pictured');
      return problems.length === 0
        ? { verdict: 'supported', basis: 'deterministic', detail: 'every size and look, hashes matched' }
        : { verdict: 'contradicted', basis: 'deterministic', detail: problems.join('; ') };
    },
  };
}
