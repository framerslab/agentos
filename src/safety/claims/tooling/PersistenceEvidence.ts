/**
 * @module safety/claims/tooling/PersistenceEvidence
 *
 * Evidence about what a running application writes. A sink inventory names every place content could land (database,
 * file, log, telemetry, network) with the metadata fields a database sink may change; a scenario run reports whether
 * its observers attached before the first request, which sinks it observed and what it found. `verifyNoContentWrites`
 * certifies a path only when every required case ran on the expected harness, attached in time, observed every sink,
 * observed no sink outside the inventory and found nothing. Suppression results certify unavailability alone: an
 * absent capability with its absence refreshed, or a partial one with its denials, each with its tests executed. The
 * `privacy` adapter supports only a verified path; the `suppression` adapter supports only the two suppression results.
 */
import type { EvidenceAdapter } from '../types.js';

/** What a sink is. */
export type SinkKind = 'database' | 'file' | 'log' | 'telemetry' | 'network';

/** One sink. A database sink names the `table.column` fields its rows may change; others name none. */
export interface SinkInventoryEntry {
  /** The sink's id, unique in the inventory. */
  id: string;
  kind: SinkKind;
  /** Where the sink is: a path, a stream or an address. */
  location: string;
  /** The `table.column` fields a database sink's rows may change; null for the other kinds. */
  allowedFields: readonly string[] | null;
}

/** One observed finding. */
export interface SinkFinding {
  /** The sink the finding was made in. */
  sinkId: string;
  /** What was found, for example a marker in a database row. */
  code: string;
  /** Where it was found, without the content itself. */
  detail: string;
}

/** Proof that one sink was observed in one case: the channel that saw it, the trace and the completed inspection. */
export interface SinkObservation {
  sinkId: string;
  /** The observer channel that covers the sink: native writes, connections or the standard streams. */
  channel: 'nativeWrites' | 'connections' | 'streams';
  /** The digest of the observer's trace. */
  traceDigest: string;
  /** The digest of the host's completed inspection of the sink. */
  inspectionDigest: string;
}

/** What an observer covered in one run: whether it attached before the first request, and each channel it saw whole. */
export interface ObserverCoverage {
  attachedBeforeRequests: boolean;
  nativeWrites: boolean;
  connections: boolean;
  streams: boolean;
  /** The digest of the trace; empty when there is none. */
  traceDigest: string;
}

/**
 * The host supplies sink policy and completed inspections; the observer supplies channel coverage.
 *
 * @param coverage - The observer's coverage of the run; undefined when no observer reported.
 * @param inspections - Each sink's channel and the digest of its completed inspection.
 * @returns One proof per inspection whose channel the observer covered, or none when the observer did not attach before the first request or left no trace.
 */
export function sinkObservations(coverage: ObserverCoverage | undefined, inspections: readonly { sinkId: string; channel: SinkObservation['channel']; inspectionDigest: string }[]): SinkObservation[] {
  if (!coverage?.attachedBeforeRequests || !coverage.traceDigest) return [];
  return inspections.filter((i) => coverage[i.channel] && i.inspectionDigest !== '').map((i) => ({ ...i, traceDigest: coverage.traceDigest }));
}

/** One scenario case's run. */
export interface ScenarioRun {
  scenarioId: string;
  caseId: string;
  /** The identity of what ran: the source commit, the harness digest and the application digest. */
  harness: { commit: string; harnessDigest: string; applicationDigest: string };
  attachedBeforeFirstRequest: boolean;
  /** The sinks the run's observers covered. */
  observedSinks: readonly string[];
  /** The run's observation proofs, one per sink, when the observer made them. */
  observations?: readonly SinkObservation[];
  findings: readonly SinkFinding[];
  /** Anything that went wrong in the run or its observation. */
  errors: readonly string[];
}

/** The privacy result union. */
export type PrivacyResult =
  | { kind: 'verified_no_content_writes'; path: string; sinks: readonly SinkInventoryEntry[]; scenarios: readonly string[] }
  | { kind: 'absent_claim_suppressed'; absence: readonly string[]; tests: readonly string[]; denials: readonly string[] }
  | { kind: 'partial_claim_suppressed'; partial: string; tests: readonly string[]; denials: readonly string[] }
  | { kind: 'failed'; failures: readonly string[] };

/** What a no-write verification reads. */
export interface NoWritesInput {
  /** The path the verification certifies. */
  path: string;
  inventory: readonly SinkInventoryEntry[];
  /** The cases that must each have run. */
  requiredCases: readonly string[];
  /** When true, each run must carry exactly one observation proof for every sink in the inventory. */
  requireObservationProofs?: boolean;
  runs: readonly ScenarioRun[];
  /** The harness every run must report. */
  harness: { commit: string; harnessDigest: string; applicationDigest: string };
}

/**
 * The inventory's own problems.
 *
 * @param inventory - The sinks.
 * @returns One line per problem; empty when the inventory holds up.
 */
export function sinkInventoryProblems(inventory: readonly SinkInventoryEntry[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const sink of inventory) {
    if (sink.kind === 'database' && (sink.allowedFields === null || sink.allowedFields.length === 0)) problems.push(`${sink.id}: a database sink names no allowed fields`);
    if (ids.has(sink.id)) problems.push(`${sink.id}: the sink id appears twice`);
    if (sink.location === '') problems.push(`${sink.id}: no location`);
    ids.add(sink.id);
  }
  if (inventory.length === 0) problems.push('the inventory is empty');
  return problems;
}

/**
 * Certifies a path's no-content-writes behavior, or fails with every reason.
 *
 * @param input - The path, its inventory, the required cases, the runs and the harness they must report.
 * @returns `verified_no_content_writes` with the inventory and the cases, or `failed` with every reason.
 */
export function verifyNoContentWrites(input: NoWritesInput): PrivacyResult {
  const failures = sinkInventoryProblems(input.inventory);
  const known = new Set(input.inventory.map((s) => s.id));
  for (const caseId of input.requiredCases) {
    const runs = input.runs.filter((r) => r.caseId === caseId);
    if (runs.length === 0) continue;
    for (const run of runs) {
      const observed = new Set<string>();
      if (input.requireObservationProofs) for (const sink of input.inventory) {
        const proofs = run.observations?.filter((proof) => proof.sinkId === sink.id && proof.traceDigest !== '' && proof.inspectionDigest !== '') ?? [];
        if (proofs.length !== 1) failures.push(`${caseId}: missing observation proof for ${sink.id}`);
      }
      if (run.harness.commit !== input.harness.commit || run.harness.harnessDigest !== input.harness.harnessDigest || run.harness.applicationDigest !== input.harness.applicationDigest) failures.push(`${caseId}: another harness ran`);
      if (!run.attachedBeforeFirstRequest) failures.push(`${caseId}: the observers attached after the first request`);
      for (const error of run.errors) failures.push(`${caseId}: ${error}`);
      for (const finding of run.findings) failures.push(`${caseId}: ${finding.code} in ${finding.sinkId} (${finding.detail})`);
      for (const sink of run.observedSinks) {
        if (!known.has(sink)) failures.push(`${caseId}: ${sink} is not in the sink inventory`);
        observed.add(sink);
      }
      for (const sink of input.inventory) if (!observed.has(sink.id)) failures.push(`${caseId}: no observer covered ${sink.id}`);
    }
  }
  for (const caseId of input.requiredCases) if (!input.runs.some((r) => r.caseId === caseId)) failures.push(`${caseId}: the required case did not run`);
  return failures.length === 0 ? { kind: 'verified_no_content_writes', path: input.path, sinks: input.inventory, scenarios: input.requiredCases } : { kind: 'failed', failures };
}

/**
 * The deliberate leaks a run of negative cases failed to detect.
 *
 * @param runs - The negative cases' runs.
 * @param expected - Each case and the sink its leak wrote to.
 * @returns One line per leak no run of its case found in its sink.
 */
export function leakDetectionProblems(runs: readonly ScenarioRun[], expected: readonly { caseId: string; sinkId: string }[]): string[] {
  return expected
    .filter(({ caseId, sinkId }) => !runs.some((r) => r.caseId === caseId && r.findings.some((f) => f.sinkId === sinkId)))
    .map(({ caseId, sinkId }) => `${caseId}: the deliberate leak into ${sinkId} was not detected`);
}

/** What a suppression result reads. */
export interface SuppressionInput {
  /** `absent` when the path does not exist, `partial` when part of it does. */
  mode: 'absent' | 'partial';
  /** The digests of the refreshed absence records, for the `absent` mode. */
  absenceDigests: readonly string[];
  /** The partial-implementation record, for the `partial` mode. */
  partialRecord: string | null;
  /** The suppression tests that ran, each with whether it passed. */
  tests: readonly { id: string; passed: boolean }[];
  /** The denials that were executed, each with whether it held. */
  denials: readonly { id: string; passed: boolean }[];
  /** True when any implementation of the path exists. */
  implementationPresent: boolean;
  /** True when a complete runnable path exists, which only a real no-write run can certify. */
  completePath: boolean;
}

/**
 * The suppression result of a hosted path that is absent or partly built.
 *
 * @param input - The mode, the absence or partial record, the executed tests and denials, and what exists.
 * @returns `absent_claim_suppressed` or `partial_claim_suppressed`, or `failed` with every reason.
 */
export function suppressionResult(input: SuppressionInput): PrivacyResult {
  const failures: string[] = [];
  if (input.tests.length === 0) failures.push('no suppression test was executed');
  for (const t of input.tests) if (!t.passed) failures.push(`${t.id}: the suppression test failed`);
  for (const d of input.denials) if (!d.passed) failures.push(`${d.id}: the denial failed`);
  if (input.completePath) failures.push('a complete path exists: only its real no-write run can certify it');
  if (input.mode === 'absent') {
    if (input.implementationPresent) failures.push('an implementation exists, so absence no longer applies');
    if (input.absenceDigests.length === 0) failures.push('no refreshed absence record');
    if (input.denials.length === 0) failures.push('no denial was executed');
    return failures.length === 0 ? { kind: 'absent_claim_suppressed', absence: input.absenceDigests, tests: input.tests.map((t) => t.id), denials: input.denials.map((d) => d.id) } : { kind: 'failed', failures };
  }
  if (input.partialRecord === null) failures.push('no partial-implementation record');
  if (input.denials.length === 0) failures.push('no denial was executed');
  return failures.length === 0 ? { kind: 'partial_claim_suppressed', partial: input.partialRecord as string, tests: input.tests.map((t) => t.id), denials: input.denials.map((d) => d.id) } : { kind: 'failed', failures };
}

/** The adapter for `privacy` evidence: only a verified no-write result supports a no-write claim. */
export function persistenceAdapter(): EvidenceAdapter {
  return {
    kind: 'privacy',
    check: async (record) => {
      const result = record.payload as PrivacyResult;
      if (result.kind === 'verified_no_content_writes') return { verdict: 'supported', basis: 'deterministic', detail: `${result.scenarios.length} cases on ${result.path}` };
      if (result.kind === 'failed') return { verdict: 'contradicted', basis: 'deterministic', detail: result.failures.slice(0, 5).join('; ') };
      return { verdict: 'unverifiable', basis: 'deterministic', detail: 'a suppression result certifies unavailability, not behavior' };
    },
  };
}

/** The adapter for `suppression` evidence: an absent or partial path whose suppression was executed and held. */
export function suppressionAdapter(): EvidenceAdapter {
  return {
    kind: 'suppression',
    check: async (record) => {
      const result = record.payload as PrivacyResult;
      if (result.kind === 'absent_claim_suppressed' || result.kind === 'partial_claim_suppressed') return { verdict: 'supported', basis: 'deterministic', detail: result.kind };
      if (result.kind === 'failed') return { verdict: 'contradicted', basis: 'deterministic', detail: result.failures.slice(0, 5).join('; ') };
      return { verdict: 'unverifiable', basis: 'deterministic', detail: 'a verified path is not a suppression' };
    },
  };
}
