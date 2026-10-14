/**
 * @module safety/claims/tooling/PersistenceEvidence
 *
 * Evidence about what a running application writes. A sink inventory names every place content could land (database,
 * file, log, telemetry, network) with the metadata fields a database sink may change; a scenario run reports whether
 * its observers attached before the first request, which sinks it observed and what it found. `verifyNoContentWrites`
 * certifies a path only when every required case ran on the expected harness, attached in time, observed every sink,
 * observed no sink outside the inventory and found nothing. A verification that names no path, no harness identity or
 * no required case, names a case twice, or is given a run of a case it does not require fails: there is no success on
 * less evidence than asked for, and no run is left unread. Suppression results certify unavailability alone: an absent
 * capability with its absence refreshed, or a partial one (an implementation exists, the path is incomplete) with its
 * partial-implementation record and denials, each with its tests executed. The `privacy` adapter supports only a
 * verified path; the `suppression` adapter supports only the two suppression results. Each adapter reads a result
 * again rather than trusting its kind, so a kept result that lacks what its kind carries supports nothing.
 */
import type { EvidenceAdapter } from '../types.js';

/** What a sink is. */
export type SinkKind = 'database' | 'file' | 'log' | 'telemetry' | 'network';

/** Every sink kind, for reading a kept result's inventory again. */
const SINK_KINDS: ReadonlySet<string> = new Set<SinkKind>(['database', 'file', 'log', 'telemetry', 'network']);

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
  /** The cases that must each have run: at least one, each named once; a run of any other case fails the verification. */
  requiredCases: readonly string[];
  /** When true, each run must carry exactly one observation proof for every sink in the inventory. */
  requireObservationProofs?: boolean;
  runs: readonly ScenarioRun[];
  /** The harness every run must report; a blank commit or digest fails the verification. */
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
 * @returns `verified_no_content_writes` with the inventory and the cases, or `failed` with every reason, including no
 * path, an unstated harness, no required case, a required case named twice and a run of a case that is not required.
 */
export function verifyNoContentWrites(input: NoWritesInput): PrivacyResult {
  const failures = sinkInventoryProblems(input.inventory);
  const known = new Set(input.inventory.map((s) => s.id));
  if (input.path === '') failures.push('no path');
  if (input.harness.commit === '' || input.harness.harnessDigest === '' || input.harness.applicationDigest === '') failures.push('the harness names no commit, harness digest or application digest');
  if (input.requiredCases.length === 0) failures.push('no required case');
  // Each required case is checked once; a case named twice is refused, never counted twice.
  const required = new Set<string>();
  for (const caseId of input.requiredCases) {
    if (required.has(caseId)) failures.push(`${caseId}: the required case appears twice`);
    required.add(caseId);
  }
  for (const caseId of required) {
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
  for (const caseId of required) if (!input.runs.some((r) => r.caseId === caseId)) failures.push(`${caseId}: the required case did not run`);
  // A run of a case the verification does not require would otherwise go unread, findings and all.
  for (const run of input.runs) if (!required.has(run.caseId)) failures.push(`${run.caseId}: the case ran but is not required`);
  return failures.length === 0 ? { kind: 'verified_no_content_writes', path: input.path, sinks: input.inventory, scenarios: input.requiredCases } : { kind: 'failed', failures };
}

/**
 * The deliberate leaks a run of negative cases failed to detect.
 *
 * @param runs - The negative cases' runs.
 * @param expected - Each case and the sink its leak wrote to.
 * @returns One line per leak no run of its case found in its sink, or one line when no leak is named: a check of no
 * negative case shows nothing about detection.
 */
export function leakDetectionProblems(runs: readonly ScenarioRun[], expected: readonly { caseId: string; sinkId: string }[]): string[] {
  if (expected.length === 0) return ['no deliberate leak was named'];
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
  /** The partial-implementation record, for the `partial` mode; null or blank when there is none. */
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
 * @returns `absent_claim_suppressed` or `partial_claim_suppressed`, or `failed` with every reason. Absence stops
 * applying once an implementation exists, partial suppression applies only while one does, and neither applies once
 * the path is complete.
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
  if (!input.implementationPresent) failures.push('no implementation exists, so partial suppression does not apply');
  if (input.partialRecord === null || input.partialRecord === '') failures.push('no partial-implementation record');
  if (input.denials.length === 0) failures.push('no denial was executed');
  return failures.length === 0 ? { kind: 'partial_claim_suppressed', partial: input.partialRecord as string, tests: input.tests.map((t) => t.id), denials: input.denials.map((d) => d.id) } : { kind: 'failed', failures };
}

/** Whether a value read from a kept result is a sink entry: an id, a known kind, a location, and allowed fields or null. */
function isSinkEntry(value: unknown): value is SinkInventoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const { id, kind, location, allowedFields } = value as { id?: unknown; kind?: unknown; location?: unknown; allowedFields?: unknown };
  return typeof id === 'string' && typeof kind === 'string' && SINK_KINDS.has(kind) && typeof location === 'string'
    && (allowedFields === null || (Array.isArray(allowedFields) && allowedFields.every((field) => typeof field === 'string')));
}

/** Whether a value read from a kept result is a list of at least one name. */
function isNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((name) => typeof name === 'string');
}

/**
 * Why a kept result that says `verified_no_content_writes` cannot support a claim, or null when it holds up. The
 * result is the JSON a caller kept, so what its kind carries is read again rather than trusted: a path, at least one
 * case and none twice, and a sink inventory with no problems.
 *
 * @param result - The result as the evidence holds it.
 */
function verifiedFault(result: { path?: unknown; sinks?: unknown; scenarios?: unknown }): string | null {
  const { path, sinks, scenarios } = result;
  if (typeof path !== 'string' || !Array.isArray(sinks) || !Array.isArray(scenarios) || !scenarios.every((s) => typeof s === 'string')) return 'the result lacks its path, sinks or cases';
  if (path === '') return 'the result names no path';
  if (scenarios.length === 0) return 'the result names no case';
  if (new Set(scenarios).size !== scenarios.length) return 'the result names a case twice';
  if (!sinks.every(isSinkEntry)) return 'the result holds a sink that is not a sink entry';
  const problems = sinkInventoryProblems(sinks);
  return problems.length === 0 ? null : problems.join('; ');
}

/**
 * Why a kept suppression result cannot support a claim, or null when it holds up: an absent result names its refreshed
 * absence records, a partial one its partial-implementation record, and both their executed tests and denials.
 *
 * @param result - The result as the evidence holds it.
 */
function suppressedFault(result: { kind: 'absent_claim_suppressed' | 'partial_claim_suppressed'; absence?: unknown; partial?: unknown; tests?: unknown; denials?: unknown }): string | null {
  if (result.kind === 'absent_claim_suppressed' && !isNames(result.absence)) return 'the result names no refreshed absence record';
  if (result.kind === 'partial_claim_suppressed' && (typeof result.partial !== 'string' || result.partial === '')) return 'the result names no partial-implementation record';
  if (!isNames(result.tests)) return 'the result names no executed test';
  if (!isNames(result.denials)) return 'the result names no executed denial';
  return null;
}

/**
 * The adapter for `privacy` evidence: only a verified no-write result supports a no-write claim, and only when it
 * names its path, its cases and a sound sink inventory.
 */
export function persistenceAdapter(): EvidenceAdapter {
  return {
    kind: 'privacy',
    check: async (record) => {
      const result = record.payload as PrivacyResult;
      if (result.kind === 'verified_no_content_writes') {
        const fault = verifiedFault(result);
        if (fault !== null) return { verdict: 'unverifiable', basis: 'deterministic', detail: fault };
        return { verdict: 'supported', basis: 'deterministic', detail: `${result.scenarios.length} cases on ${result.path}` };
      }
      if (result.kind === 'failed') return { verdict: 'contradicted', basis: 'deterministic', detail: result.failures.slice(0, 5).join('; ') };
      return { verdict: 'unverifiable', basis: 'deterministic', detail: 'a suppression result certifies unavailability, not behavior' };
    },
  };
}

/**
 * The adapter for `suppression` evidence: an absent or partial path whose suppression was executed and held, and only
 * when the result names its absence or partial-implementation record, its tests and its denials.
 */
export function suppressionAdapter(): EvidenceAdapter {
  return {
    kind: 'suppression',
    check: async (record) => {
      const result = record.payload as PrivacyResult;
      if (result.kind === 'absent_claim_suppressed' || result.kind === 'partial_claim_suppressed') {
        const fault = suppressedFault(result);
        if (fault !== null) return { verdict: 'unverifiable', basis: 'deterministic', detail: fault };
        return { verdict: 'supported', basis: 'deterministic', detail: result.kind };
      }
      if (result.kind === 'failed') return { verdict: 'contradicted', basis: 'deterministic', detail: result.failures.slice(0, 5).join('; ') };
      return { verdict: 'unverifiable', basis: 'deterministic', detail: 'a verified path is not a suppression' };
    },
  };
}
