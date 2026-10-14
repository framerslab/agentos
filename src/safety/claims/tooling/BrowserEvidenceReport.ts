/**
 * @module safety/claims/tooling/BrowserEvidenceReport
 *
 * Playwright JSON reports as claim evidence. A run declares the invocations it expects (each with its commit, its
 * application, harness and configuration digests, whether it is eligible as evidence, and the tests it must pass); each
 * invocation leaves a JSON report and an identity file. `reconcileInvocations` normalizes every report, keeps every
 * attempt of every test, and reports each way the run falls short: a report that is missing or malformed, an
 * invocation nobody expected or seen twice, a test seen twice or two tests with one id, an identity that is not the
 * expected one, a non-zero or unknown exit, report-level errors, counts that do not match, and a required test that is
 * missing, skipped, failed, flaky or marked as an expected failure. A test passes only when every attempt passed, it
 * appears once in its project and its spec id names no other test, in an eligible invocation with no problem of its
 * own: an identity that is not the expected one, a second report, report-level errors, counts that do not match or an
 * exit code that is not 0. A baseline invocation is kept but never satisfies a requirement. Nothing here passes for
 * want of data.
 */

/** A result's status, as the reporter writes it. */
export type TestStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';

/** A test's status across its attempts. */
export type FinalStatus = 'expected' | 'unexpected' | 'flaky' | 'skipped';

/** A test an invocation must pass, in every project named. `title` is the describe titles and the test's, joined by ` > `. */
export interface ExpectedTest {
  file: string;
  title: string;
  projects: readonly string[];
}

/** One invocation the run expects, with the identity it must report. */
export interface ExpectedInvocation {
  invocationId: string;
  commit: string;
  applicationDigest: string;
  harnessDigest: string;
  configurationDigest: string;
  /** What the invocation selects, in words (a grep, a spec list), for the record. */
  selection: string;
  /** False for a baseline-making invocation, whose tests never satisfy a requirement. */
  eligible: boolean;
  required: readonly ExpectedTest[];
}

/** The run's declaration of what it expects. */
export interface InvocationManifest {
  repository: string;
  runId: string;
  attempt: number;
  commit: string;
  invocations: readonly ExpectedInvocation[];
}

/** What one invocation left: its exit code (null when unknown), the parsed report (null when absent) and its identity file. */
export interface ObservedInvocation {
  invocationId: string;
  exitCode: number | null;
  report: unknown;
  identity: unknown;
}

/** One attempt of one test. */
export interface NormalizedAttempt {
  retry: number;
  status: TestStatus;
  startTime: string;
  durationMs: number;
}

/** One test in one project, with every attempt. */
export interface NormalizedTest {
  /** `testKey` of the project, file and title. */
  key: string;
  specId: string;
  file: string;
  title: string;
  project: string;
  expectedStatus: TestStatus;
  finalStatus: FinalStatus;
  attempts: readonly NormalizedAttempt[];
  annotations: readonly { type: string; description?: string }[];
}

/** A normalized report. */
export interface NormalizedReport {
  startTime: string;
  durationMs: number;
  stats: { expected: number; unexpected: number; flaky: number; skipped: number };
  errors: number;
  tests: readonly NormalizedTest[];
}

/** One invocation as reconciled. */
export interface NormalizedInvocation extends NormalizedReport {
  invocationId: string;
  eligible: boolean;
  exitCode: number | null;
}

/** Each way a run falls short. */
export type ReportProblemCode =
  | 'missing_report'
  | 'malformed_report'
  | 'unexpected_invocation'
  | 'duplicate_invocation'
  | 'identity_mismatch'
  | 'duplicate_test'
  | 'conflicting_test'
  | 'stats_mismatch'
  | 'report_errors'
  | 'nonzero_exit'
  | 'unknown_exit'
  | 'missing_test'
  | 'skipped_required'
  | 'failed_required'
  | 'flaky_required'
  | 'expected_failure_required'
  | 'ineligible_required';

/** One shortfall. */
export interface ReportProblem {
  code: ReportProblemCode;
  invocationId: string;
  /** The test's key (`testKey`), or the required title for `ineligible_required`. */
  test?: string;
  detail: string;
}

/**
 * The reconciled run: every invocation seen, every problem, and the `passKey` of each test that passed cleanly, once,
 * in an eligible invocation with no problem of its own.
 */
export interface ReconciledRun {
  invocations: readonly NormalizedInvocation[];
  problems: readonly ReportProblem[];
  passed: ReadonlySet<string>;
}

const STATUSES: ReadonlySet<string> = new Set(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']);
const FINALS: ReadonlySet<string> = new Set(['expected', 'unexpected', 'flaky', 'skipped']);

/** A test's key within an invocation: its project, file and title as a JSON array, so no part can run into another. */
export function testKey(file: string, title: string, project: string): string {
  return JSON.stringify([project, file, title]);
}

/** A passed test's key within the run: its invocation, project, file and title as a JSON array. */
export function passKey(invocationId: string, file: string, title: string, project: string): string {
  return JSON.stringify([invocationId, project, file, title]);
}

type Raw = Record<string, unknown>;
const isRaw = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Normalizes one Playwright JSON report.
 *
 * @param invocationId - The invocation the report belongs to, for the problem it may raise.
 * @param report - The parsed JSON.
 */
export function normalizePlaywrightReport(invocationId: string, report: unknown): { ok: true; value: NormalizedReport } | { ok: false; problem: ReportProblem } {
  const malformed = (detail: string) => ({ ok: false as const, problem: { code: 'malformed_report' as const, invocationId, detail } });
  if (!isRaw(report) || !Array.isArray(report.suites) || !isRaw(report.stats) || !Array.isArray(report.errors)) return malformed('the report lacks suites, stats or errors');
  const stats = report.stats;
  const counts = { expected: num(stats.expected), unexpected: num(stats.unexpected), flaky: num(stats.flaky), skipped: num(stats.skipped) };
  const startTime = str(stats.startTime);
  const durationMs = num(stats.duration);
  if (Object.values(counts).some((n) => n === null) || startTime === null || durationMs === null) return malformed('the stats are incomplete');
  const tests: NormalizedTest[] = [];
  const walk = (suite: unknown, titles: readonly string[], top: boolean): string | null => {
    if (!isRaw(suite) || !Array.isArray(suite.specs)) return 'a suite without specs';
    const here = top ? titles : [...titles, str(suite.title) ?? ''];
    for (const spec of suite.specs) {
      if (!isRaw(spec) || !Array.isArray(spec.tests)) return 'a spec without tests';
      const specId = str(spec.id);
      const file = str(spec.file);
      const leaf = str(spec.title);
      if (specId === null || file === null || leaf === null) return 'a spec without its id, file or title';
      const title = [...here, leaf].filter((part) => part !== '').join(' > ');
      for (const t of spec.tests) {
        if (!isRaw(t) || !Array.isArray(t.results)) return 'a test without results';
        const project = str(t.projectName);
        const expectedStatus = str(t.expectedStatus);
        const finalStatus = str(t.status);
        if (project === null || expectedStatus === null || !STATUSES.has(expectedStatus) || finalStatus === null || !FINALS.has(finalStatus)) return 'a test without its project or statuses';
        const attempts: NormalizedAttempt[] = [];
        for (const r of t.results) {
          if (!isRaw(r)) return 'a result that is not an object';
          const status = str(r.status);
          const retry = num(r.retry);
          if (status === null || !STATUSES.has(status) || retry === null) return 'a result without its status or retry';
          attempts.push({ retry, status: status as TestStatus, startTime: str(r.startTime) ?? '', durationMs: num(r.duration) ?? 0 });
        }
        const annotations = Array.isArray(t.annotations)
          ? t.annotations.filter(isRaw).map((a) => ({ type: str(a.type) ?? '', ...(str(a.description) === null ? {} : { description: str(a.description) as string }) }))
          : [];
        tests.push({ key: testKey(file, title, project), specId, file, title, project, expectedStatus: expectedStatus as TestStatus, finalStatus: finalStatus as FinalStatus, attempts, annotations });
      }
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) {
      const problem = walk(child, here, false);
      if (problem !== null) return problem;
    }
    return null;
  };
  for (const suite of report.suites) {
    const problem = walk(suite, [], true);
    if (problem !== null) return malformed(problem);
  }
  return {
    ok: true,
    value: { startTime, durationMs, stats: counts as NormalizedReport['stats'], errors: report.errors.length, tests },
  };
}

/**
 * Reconciles a run's expected invocations with what each left.
 *
 * Every problem is reported. A test enters `passed` only when every attempt passed, its key appears once in the report
 * and its spec id names no other test, in an eligible invocation observed once, whose identity is the expected one and
 * whose report has no report-level errors, counts that match its tests and an exit code of 0.
 *
 * @param manifest - What the run expects.
 * @param observed - What each invocation left, in any order.
 */
export function reconcileInvocations(manifest: InvocationManifest, observed: readonly ObservedInvocation[]): ReconciledRun {
  const problems: ReportProblem[] = [];
  const invocations: NormalizedInvocation[] = [];
  const passed = new Set<string>();
  const expectedIds = new Set(manifest.invocations.map((i) => i.invocationId));
  const seen = new Map<string, ObservedInvocation>();
  // An invocation named by two reports is still reconciled from the first, so its own problems are reported, but none
  // of its tests passes: nothing says which report is the invocation's.
  const repeated = new Set<string>();
  for (const o of observed) {
    if (!expectedIds.has(o.invocationId)) {
      problems.push({ code: 'unexpected_invocation', invocationId: o.invocationId, detail: 'the manifest does not name this invocation' });
      continue;
    }
    if (seen.has(o.invocationId)) {
      problems.push({ code: 'duplicate_invocation', invocationId: o.invocationId, detail: 'two reports name this invocation' });
      repeated.add(o.invocationId);
      continue;
    }
    seen.set(o.invocationId, o);
  }
  for (const expected of manifest.invocations) {
    const o = seen.get(expected.invocationId);
    if (o === undefined || o.report === null || o.report === undefined) {
      problems.push({ code: 'missing_report', invocationId: expected.invocationId, detail: 'no report: a cancelled or crashed invocation is a failure, never an empty success' });
      continue;
    }
    const id = isRaw(o.identity) ? o.identity : {};
    let identityMatches = true;
    for (const field of ['commit', 'applicationDigest', 'harnessDigest', 'configurationDigest'] as const) {
      if (id[field] !== expected[field]) {
        problems.push({ code: 'identity_mismatch', invocationId: expected.invocationId, detail: `${field} is not the expected one` });
        identityMatches = false;
      }
    }
    const normalized = normalizePlaywrightReport(expected.invocationId, o.report);
    if (!normalized.ok) {
      problems.push(normalized.problem);
      continue;
    }
    const report = normalized.value;
    invocations.push({ ...report, invocationId: expected.invocationId, eligible: expected.eligible, exitCode: o.exitCode });
    // Every instance of each key, so a test seen twice is checked in each and passes in none.
    const byKey = new Map<string, NormalizedTest[]>();
    const bySpec = new Map<string, string>();
    // Spec ids that name more than one test: the report cannot say which test such an id is, so none of them passes.
    const conflicted = new Set<string>();
    for (const t of report.tests) {
      const instances = byKey.get(t.key);
      if (instances === undefined) byKey.set(t.key, [t]);
      else {
        problems.push({ code: 'duplicate_test', invocationId: expected.invocationId, test: t.key, detail: 'the test appears twice in one project' });
        instances.push(t);
      }
      const identity = JSON.stringify([t.file, t.title]);
      const prior = bySpec.get(t.specId);
      if (prior !== undefined && prior !== identity) {
        problems.push({ code: 'conflicting_test', invocationId: expected.invocationId, test: t.key, detail: 'one spec id names two tests' });
        conflicted.add(t.specId);
      }
      bySpec.set(t.specId, identity);
    }
    const counted = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
    for (const t of report.tests) counted[t.finalStatus] += 1;
    const countsMatch = Object.entries(counted).every(([k, v]) => report.stats[k as keyof typeof counted] === v);
    if (!countsMatch) problems.push({ code: 'stats_mismatch', invocationId: expected.invocationId, detail: 'the counts do not match the tests the report holds' });
    if (report.errors > 0) problems.push({ code: 'report_errors', invocationId: expected.invocationId, detail: `${report.errors} report-level errors` });
    if (o.exitCode === null) problems.push({ code: 'unknown_exit', invocationId: expected.invocationId, detail: 'the exit code is unknown' });
    else if (o.exitCode !== 0) problems.push({ code: 'nonzero_exit', invocationId: expected.invocationId, detail: `exit code ${String(o.exitCode)}` });
    // A problem of the invocation as a whole keeps every one of its tests out of passed.
    const admissible = expected.eligible && !repeated.has(expected.invocationId) && identityMatches && countsMatch && report.errors === 0 && o.exitCode === 0;
    for (const t of report.tests) {
      const clean = t.finalStatus === 'expected' && t.expectedStatus === 'passed' && t.attempts.length > 0 && t.attempts.every((a) => a.status === 'passed');
      const once = byKey.get(t.key)?.length === 1 && !conflicted.has(t.specId);
      if (clean && once && admissible) passed.add(passKey(expected.invocationId, t.file, t.title, t.project));
    }
    for (const req of expected.required) {
      if (!expected.eligible) {
        problems.push({ code: 'ineligible_required', invocationId: expected.invocationId, test: req.title, detail: 'a baseline invocation cannot carry a required test' });
        continue;
      }
      for (const project of req.projects) {
        const label = testKey(req.file, req.title, project);
        const instances = byKey.get(label) ?? [];
        if (instances.length === 0) problems.push({ code: 'missing_test', invocationId: expected.invocationId, test: label, detail: 'the required test did not run' });
        // Each instance of a test seen twice is checked, so a passing one cannot hide a failed one.
        for (const t of instances) {
          if (t.finalStatus === 'skipped') problems.push({ code: 'skipped_required', invocationId: expected.invocationId, test: label, detail: 'the required test was skipped' });
          else if (t.expectedStatus !== 'passed') problems.push({ code: 'expected_failure_required', invocationId: expected.invocationId, test: label, detail: `expected status ${t.expectedStatus}` });
          else if (t.finalStatus === 'unexpected') problems.push({ code: 'failed_required', invocationId: expected.invocationId, test: label, detail: `last attempt ${t.attempts.at(-1)?.status ?? 'none'}` });
          else if (t.finalStatus === 'flaky') problems.push({ code: 'flaky_required', invocationId: expected.invocationId, test: label, detail: `${t.attempts.length} attempts` });
        }
      }
    }
  }
  return { invocations, problems, passed };
}

/**
 * True when a required test passed cleanly in every project it names, once in each, in an eligible invocation with no
 * problem of its own (as `reconcileInvocations` decides).
 *
 * @param run - The reconciled run.
 * @param invocationId - The invocation.
 * @param test - The test.
 */
export function requiredPassed(run: ReconciledRun, invocationId: string, test: ExpectedTest): boolean {
  return test.projects.length > 0 && test.projects.every((project) => run.passed.has(passKey(invocationId, test.file, test.title, project)));
}
