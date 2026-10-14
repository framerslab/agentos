/**
 * @module safety/claims/tooling/BrowserEvidenceReport
 *
 * Playwright JSON reports as claim evidence. A run declares the invocations it expects (each with its commit, its
 * application, harness and configuration digests, whether it is eligible as evidence, and the tests it must pass); each
 * invocation leaves a JSON report and an identity file. `reconcileInvocations` normalizes every report, keeps every
 * attempt of every test, and reports each way the run falls short: a report that is missing or malformed, an
 * invocation nobody expected or seen twice, a test seen twice or two tests with one id, an identity that is not the
 * expected one, a non-zero exit, report-level errors, counts that do not match, and a required test that is missing,
 * skipped, failed, flaky or marked as an expected failure. A baseline invocation is kept but never satisfies a
 * requirement. Nothing here passes for want of data.
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
  test?: string;
  detail: string;
}

/** The reconciled run: every invocation seen, every problem, and the tests that passed in an eligible invocation. */
export interface ReconciledRun {
  invocations: readonly NormalizedInvocation[];
  problems: readonly ReportProblem[];
  passed: ReadonlySet<string>;
}

const STATUSES: ReadonlySet<string> = new Set(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']);
const FINALS: ReadonlySet<string> = new Set(['expected', 'unexpected', 'flaky', 'skipped']);

/** A test's key within an invocation. */
export function testKey(file: string, title: string, project: string): string {
  return `${project} :: ${file} :: ${title}`;
}

/** A passed test's key within the run. */
export function passKey(invocationId: string, file: string, title: string, project: string): string {
  return `${invocationId} :: ${testKey(file, title, project)}`;
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
 * @param manifest - What the run expects.
 * @param observed - What each invocation left, in any order.
 */
export function reconcileInvocations(manifest: InvocationManifest, observed: readonly ObservedInvocation[]): ReconciledRun {
  const problems: ReportProblem[] = [];
  const invocations: NormalizedInvocation[] = [];
  const passed = new Set<string>();
  const expectedIds = new Set(manifest.invocations.map((i) => i.invocationId));
  const seen = new Map<string, ObservedInvocation>();
  for (const o of observed) {
    if (!expectedIds.has(o.invocationId)) {
      problems.push({ code: 'unexpected_invocation', invocationId: o.invocationId, detail: 'the manifest does not name this invocation' });
      continue;
    }
    if (seen.has(o.invocationId)) {
      problems.push({ code: 'duplicate_invocation', invocationId: o.invocationId, detail: 'two reports name this invocation' });
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
    for (const field of ['commit', 'applicationDigest', 'harnessDigest', 'configurationDigest'] as const) {
      if (id[field] !== expected[field]) problems.push({ code: 'identity_mismatch', invocationId: expected.invocationId, detail: `${field} is not the expected one` });
    }
    const normalized = normalizePlaywrightReport(expected.invocationId, o.report);
    if (!normalized.ok) {
      problems.push(normalized.problem);
      continue;
    }
    const report = normalized.value;
    invocations.push({ ...report, invocationId: expected.invocationId, eligible: expected.eligible, exitCode: o.exitCode });
    const byKey = new Map<string, NormalizedTest>();
    const bySpec = new Map<string, string>();
    for (const t of report.tests) {
      if (byKey.has(t.key)) problems.push({ code: 'duplicate_test', invocationId: expected.invocationId, test: t.key, detail: 'the test appears twice in one project' });
      byKey.set(t.key, t);
      const identity = `${t.file} :: ${t.title}`;
      const prior = bySpec.get(t.specId);
      if (prior !== undefined && prior !== identity) problems.push({ code: 'conflicting_test', invocationId: expected.invocationId, test: t.key, detail: 'one spec id names two tests' });
      bySpec.set(t.specId, identity);
    }
    const counted = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
    for (const t of report.tests) counted[t.finalStatus] += 1;
    if (Object.entries(counted).some(([k, v]) => report.stats[k as keyof typeof counted] !== v)) {
      problems.push({ code: 'stats_mismatch', invocationId: expected.invocationId, detail: 'the counts do not match the tests the report holds' });
    }
    if (report.errors > 0) problems.push({ code: 'report_errors', invocationId: expected.invocationId, detail: `${report.errors} report-level errors` });
    const allExpected = report.tests.every((t) => t.finalStatus === 'expected');
    if (o.exitCode !== 0 && allExpected) problems.push({ code: 'nonzero_exit', invocationId: expected.invocationId, detail: `exit code ${String(o.exitCode)}` });
    for (const t of report.tests) {
      const clean = t.finalStatus === 'expected' && t.expectedStatus === 'passed' && t.attempts.length > 0 && t.attempts.every((a) => a.status === 'passed');
      if (clean && expected.eligible && o.exitCode === 0) passed.add(passKey(expected.invocationId, t.file, t.title, t.project));
    }
    for (const req of expected.required) {
      if (!expected.eligible) {
        problems.push({ code: 'ineligible_required', invocationId: expected.invocationId, test: req.title, detail: 'a baseline invocation cannot carry a required test' });
        continue;
      }
      for (const project of req.projects) {
        const t = byKey.get(testKey(req.file, req.title, project));
        const label = testKey(req.file, req.title, project);
        if (t === undefined) problems.push({ code: 'missing_test', invocationId: expected.invocationId, test: label, detail: 'the required test did not run' });
        else if (t.finalStatus === 'skipped') problems.push({ code: 'skipped_required', invocationId: expected.invocationId, test: label, detail: 'the required test was skipped' });
        else if (t.expectedStatus !== 'passed') problems.push({ code: 'expected_failure_required', invocationId: expected.invocationId, test: label, detail: `expected status ${t.expectedStatus}` });
        else if (t.finalStatus === 'unexpected') problems.push({ code: 'failed_required', invocationId: expected.invocationId, test: label, detail: `last attempt ${t.attempts.at(-1)?.status ?? 'none'}` });
        else if (t.finalStatus === 'flaky') problems.push({ code: 'flaky_required', invocationId: expected.invocationId, test: label, detail: `${t.attempts.length} attempts` });
      }
    }
  }
  return { invocations, problems, passed };
}

/**
 * True when a required test passed cleanly in every project it names, in an eligible invocation.
 *
 * @param run - The reconciled run.
 * @param invocationId - The invocation.
 * @param test - The test.
 */
export function requiredPassed(run: ReconciledRun, invocationId: string, test: ExpectedTest): boolean {
  return test.projects.length > 0 && test.projects.every((project) => run.passed.has(passKey(invocationId, test.file, test.title, project)));
}
