import { describe, expect, it } from 'vitest';
import {
  normalizePlaywrightReport,
  reconcileInvocations,
  requiredPassed,
  type ExpectedInvocation,
  type InvocationManifest,
  type ObservedInvocation,
} from '../BrowserEvidenceReport.js';

const result = (status: string, retry = 0) => ({ workerIndex: 0, parallelIndex: 0, status, duration: 5, error: undefined, errors: [], stdout: [], stderr: [], retry, startTime: '2026-01-01T00:00:00.000Z', attachments: [], annotations: [] });
const test = (projectName: string, status: string, results: unknown[], expectedStatus = 'passed', annotations: unknown[] = []) => ({ timeout: 30000, annotations, expectedStatus, projectName, projectId: projectName, results, status });
const report = (specs: unknown[], stats: Record<string, number>, errors: unknown[] = []) => ({
  config: { projects: [] },
  suites: [{ title: 'journey.spec.ts', file: 'journey.spec.ts', line: 0, column: 0, specs: [], suites: [{ title: 'the journey', file: 'journey.spec.ts', line: 1, column: 1, specs }] }],
  errors,
  stats: { startTime: '2026-01-01T00:00:00.000Z', duration: 10, expected: 0, unexpected: 0, flaky: 0, skipped: 0, ...stats },
});
const spec = (id: string, title: string, tests: unknown[]) => ({ tags: [], title, ok: true, tests, id, file: 'journey.spec.ts', line: 2, column: 3 });
const identity = { commit: 'c'.repeat(40), applicationDigest: 'a', harnessDigest: 'h', configurationDigest: 'g' };
const expected = (overrides: Partial<ExpectedInvocation> = {}): ExpectedInvocation => ({
  invocationId: 'main',
  ...identity,
  selection: 'every spec',
  eligible: true,
  required: [{ file: 'journey.spec.ts', title: 'the journey > signs in', projects: ['engine-a'] }],
  ...overrides,
});
const manifest = (invocations: ExpectedInvocation[]): InvocationManifest => ({ repository: 'example/repo', runId: '1', attempt: 1, commit: identity.commit, invocations });
const observed = (body: unknown, overrides: Partial<ObservedInvocation> = {}): ObservedInvocation => ({ invocationId: 'main', exitCode: 0, report: body, identity, ...overrides });
const clean = report([spec('s1', 'signs in', [test('engine-a', 'expected', [result('passed')])])], { expected: 1 });
const signsIn = { file: 'journey.spec.ts', title: 'the journey > signs in', projects: ['engine-a'] };
// Specs at the top of their file, so a test's title is the spec's own.
const topLevel = (specs: unknown[]) => ({ ...report([], { expected: specs.length }), suites: [{ title: 'journey.spec.ts', file: 'journey.spec.ts', line: 0, column: 0, specs }] });
const passing = (project: string) => test(project, 'expected', [result('passed')]);

describe('browser evidence reports', () => {
  it('normalizes a report: the title path, every attempt and the final status', () => {
    const body = report([spec('s1', 'signs in', [test('engine-a', 'flaky', [result('failed', 0), result('passed', 1)])])], { flaky: 1 });
    const normalized = normalizePlaywrightReport('main', body);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.tests).toEqual([
      expect.objectContaining({ title: 'the journey > signs in', project: 'engine-a', finalStatus: 'flaky', attempts: [expect.objectContaining({ retry: 0, status: 'failed' }), expect.objectContaining({ retry: 1, status: 'passed' })] }),
    ]);
  });

  it('passes a required test that passed in every project it names', () => {
    const run = reconcileInvocations(manifest([expected()]), [observed(report([spec('s1', 'signs in', [test('engine-a', 'expected', [result('passed')])])], { expected: 1 }))]);
    expect(run.problems).toEqual([]);
    expect(requiredPassed(run, 'main', { file: 'journey.spec.ts', title: 'the journey > signs in', projects: ['engine-a'] })).toBe(true);
  });

  it('refuses a skipped, failed, flaky or expected-failure required test, each by its code', () => {
    const cases: [string, unknown, string][] = [
      ['skipped', test('engine-a', 'skipped', [result('skipped')], 'skipped'), 'skipped_required'],
      ['failed', test('engine-a', 'unexpected', [result('failed')]), 'failed_required'],
      ['flaky', test('engine-a', 'flaky', [result('failed'), result('passed', 1)]), 'flaky_required'],
      ['expected failure', test('engine-a', 'expected', [result('failed')], 'failed'), 'expected_failure_required'],
    ];
    for (const [name, t, code] of cases) {
      const stats = { skipped: name === 'skipped' ? 1 : 0, unexpected: name === 'failed' ? 1 : 0, flaky: name === 'flaky' ? 1 : 0, expected: name === 'expected failure' ? 1 : 0 };
      const run = reconcileInvocations(manifest([expected()]), [observed(report([spec('s1', 'signs in', [t])], stats))]);
      expect(run.problems.map((p) => p.code), name).toContain(code);
    }
  });

  it('fails a missing report, a missing test, a duplicate test, a conflicting id and an unexpected invocation', () => {
    expect(reconcileInvocations(manifest([expected()]), []).problems.map((p) => p.code)).toEqual(['missing_report']);
    expect(reconcileInvocations(manifest([expected()]), [observed(null, { exitCode: null })]).problems.map((p) => p.code)).toEqual(['missing_report']);
    const empty = reconcileInvocations(manifest([expected()]), [observed(report([], {}))]);
    expect(empty.problems.map((p) => p.code)).toEqual(['missing_test']);
    const twice = report([spec('s1', 'signs in', [test('engine-a', 'expected', [result('passed')]), test('engine-a', 'expected', [result('passed')])])], { expected: 2 });
    expect(reconcileInvocations(manifest([expected()]), [observed(twice)]).problems.map((p) => p.code)).toContain('duplicate_test');
    const conflict = report([spec('s1', 'signs in', [test('engine-a', 'expected', [result('passed')])]), spec('s1', 'signs out', [test('engine-a', 'expected', [result('passed')])])], { expected: 2 });
    expect(reconcileInvocations(manifest([expected()]), [observed(conflict)]).problems.map((p) => p.code)).toContain('conflicting_test');
    const stray = reconcileInvocations(manifest([expected()]), [observed(report([spec('s1', 'signs in', [test('engine-a', 'expected', [result('passed')])])], { expected: 1 })), observed(report([], {}), { invocationId: 'other' })]);
    expect(stray.problems.map((p) => p.code)).toEqual(['unexpected_invocation']);
  });

  it('fails a wrong identity, a non-zero exit with every test passed, report errors, a stats mismatch and malformed JSON', () => {
    const good = report([spec('s1', 'signs in', [test('engine-a', 'expected', [result('passed')])])], { expected: 1 });
    expect(reconcileInvocations(manifest([expected()]), [observed(good, { identity: { ...identity, commit: 'd'.repeat(40) } })]).problems.map((p) => p.code)).toEqual(['identity_mismatch']);
    expect(reconcileInvocations(manifest([expected()]), [observed(good, { exitCode: 1 })]).problems.map((p) => p.code)).toEqual(['nonzero_exit']);
    expect(reconcileInvocations(manifest([expected()]), [observed({ ...good, errors: [{ message: 'config' }] })]).problems.map((p) => p.code)).toEqual(['report_errors']);
    expect(reconcileInvocations(manifest([expected()]), [observed({ ...good, stats: { ...good.stats, expected: 4 } })]).problems.map((p) => p.code)).toEqual(['stats_mismatch']);
    expect(reconcileInvocations(manifest([expected()]), [observed({ suites: 'no' })]).problems.map((p) => p.code)).toEqual(['malformed_report']);
  });

  it('keeps a baseline invocation and its tests but never lets them satisfy a requirement', () => {
    const body = report([spec('s1', 'signs in', [test('engine-a', 'expected', [result('passed')])])], { expected: 1 });
    const run = reconcileInvocations(manifest([expected({ eligible: false, required: [] })]), [observed(body)]);
    expect(run.invocations[0]?.tests).toHaveLength(1);
    expect(requiredPassed(run, 'main', { file: 'journey.spec.ts', title: 'the journey > signs in', projects: ['engine-a'] })).toBe(false);
    const asked = reconcileInvocations(manifest([expected({ eligible: false })]), [observed(body)]);
    expect(asked.problems.map((p) => p.code)).toEqual(['ineligible_required']);
  });

  const invocationLevel: [string, ObservedInvocation[], string[]][] = [
    ['an identity that is not the expected one', [observed(clean, { identity: { ...identity, commit: 'b'.repeat(40) } })], ['identity_mismatch']],
    ['no identity file', [observed(clean, { identity: null })], ['identity_mismatch', 'identity_mismatch', 'identity_mismatch', 'identity_mismatch']],
    ['a second report', [observed(clean), observed(clean)], ['duplicate_invocation']],
    ['report-level errors', [observed({ ...clean, errors: [{ message: 'Worker crashed' }] })], ['report_errors']],
    ['counts that do not match its tests', [observed({ ...clean, stats: { ...clean.stats, expected: 99 } })], ['stats_mismatch']],
  ];
  it.each(invocationLevel)('lets no test of an invocation with %s satisfy a requirement', (_name, seen, codes) => {
    const run = reconcileInvocations(manifest([expected()]), seen);
    expect(run.problems.map((p) => p.code)).toEqual(codes);
    expect(requiredPassed(run, 'main', signsIn)).toBe(false);
    expect(run.passed.size).toBe(0);
  });

  it('reports a non-zero exit whatever the other tests did', () => {
    const mixed = report([spec('s1', 'signs in', [test('engine-a', 'expected', [result('passed')])]), spec('s2', 'other', [test('engine-a', 'unexpected', [result('failed')])])], { expected: 1, unexpected: 1 });
    const run = reconcileInvocations(manifest([expected()]), [observed(mixed, { exitCode: 1 })]);
    expect(run.problems.map((p) => p.code)).toEqual(['nonzero_exit']);
    expect(requiredPassed(run, 'main', signsIn)).toBe(false);
  });

  it('reports an unknown exit as unknown, not as non-zero, and passes nothing of it', () => {
    const run = reconcileInvocations(manifest([expected()]), [observed(clean, { exitCode: null })]);
    expect(run.problems.map((p) => p.code)).toEqual(['unknown_exit']);
    expect(requiredPassed(run, 'main', signsIn)).toBe(false);
  });

  it('reports a non-zero exit beside a missing or malformed report, but an unknown exit only beside a readable one', () => {
    const crashed = reconcileInvocations(manifest([expected()]), [observed(null, { exitCode: 137 })]);
    expect(crashed.problems.map((p) => p.code)).toEqual(['missing_report', 'nonzero_exit']);
    expect(crashed.problems[1]).toEqual({ code: 'nonzero_exit', invocationId: 'main', detail: 'exit code 137' });
    const broken = (exitCode: number | null) => reconcileInvocations(manifest([expected()]), [observed({ suites: 'no' }, { exitCode })]).problems.map((p) => p.code);
    expect(broken(1)).toEqual(['malformed_report', 'nonzero_exit']);
    expect(broken(null)).toEqual(['malformed_report']);
  });

  it('checks every instance of a test seen twice in one project, and passes no test seen twice or under a shared spec id', () => {
    const hidden = report([spec('s1', 'signs in', [test('engine-a', 'unexpected', [result('failed')])]), spec('s2', 'signs in', [test('engine-a', 'expected', [result('passed')])])], { expected: 1, unexpected: 1 });
    const run = reconcileInvocations(manifest([expected()]), [observed(hidden)]);
    expect(run.problems.map((p) => p.code)).toEqual(['duplicate_test', 'failed_required']);
    expect(requiredPassed(run, 'main', signsIn)).toBe(false);
    const twice = report([spec('s1', 'signs in', [test('engine-a', 'expected', [result('passed')]), test('engine-a', 'expected', [result('passed')])])], { expected: 2 });
    expect(requiredPassed(reconcileInvocations(manifest([expected()]), [observed(twice)]), 'main', signsIn)).toBe(false);
    const shared = report([spec('s1', 'signs in', [test('engine-a', 'expected', [result('passed')])]), spec('s1', 'signs out', [test('engine-a', 'expected', [result('passed')])])], { expected: 2 });
    expect(requiredPassed(reconcileInvocations(manifest([expected()]), [observed(shared)]), 'main', signsIn)).toBe(false);
  });

  it('keeps two tests apart when their project, file and title join to the same text', () => {
    const apart = topLevel([{ ...spec('s1', 'c', [passing('p')]), file: 'a :: b' }, { ...spec('s2', 'c', [passing('p :: a')]), file: 'b' }]);
    const required = [{ file: 'a :: b', title: 'c', projects: ['p'] }, { file: 'b', title: 'c', projects: ['p :: a'] }];
    const run = reconcileInvocations(manifest([expected({ required })]), [observed(apart)]);
    expect(run.problems).toEqual([]);
    expect(required.map((t) => requiredPassed(run, 'main', t))).toEqual([true, true]);
    const oneId = topLevel([{ ...spec('s1', 'c', [passing('p')]), file: 'a :: b' }, { ...spec('s1', 'b :: c', [passing('p')]), file: 'a' }]);
    expect(reconcileInvocations(manifest([expected({ required: [] })]), [observed(oneId)]).problems.map((p) => p.code)).toEqual(['conflicting_test']);
  });

  it('never lets a pass in one invocation answer for another whose id and project join to the same text', () => {
    const run = reconcileInvocations(
      manifest([expected({ required: [] }), expected({ invocationId: 'main :: engine-b', required: [] })]),
      [observed(report([], {})), observed(clean, { invocationId: 'main :: engine-b' })],
    );
    expect(run.problems).toEqual([]);
    expect(requiredPassed(run, 'main', { ...signsIn, projects: ['engine-b :: engine-a'] })).toBe(false);
    expect(requiredPassed(run, 'main :: engine-b', signsIn)).toBe(true);
  });
});
