import { describe, expect, it } from 'vitest';
import { digestOf } from '../../digest.js';
import {
  leakDetectionProblems,
  persistenceAdapter,
  suppressionAdapter,
  suppressionResult,
  verifyNoContentWrites,
  sinkObservations,
  type ScenarioRun,
  type SinkInventoryEntry,
} from '../PersistenceEvidence.js';

const harness = { commit: 'c'.repeat(40), harnessDigest: 'h', applicationDigest: 'a' };
const inventory: SinkInventoryEntry[] = [
  { id: 'db', kind: 'database', location: 'state/app.db', allowedFields: ['accounts.id', 'sessions.started_at'] },
  { id: 'log', kind: 'log', location: 'stdout', allowedFields: null },
];
const run = (caseId: string, overrides: Partial<ScenarioRun> = {}): ScenarioRun => ({ scenarioId: 'example-no-writes', caseId, harness, attachedBeforeFirstRequest: true, observedSinks: ['db', 'log'], findings: [], errors: [], ...overrides });
const claim = { claimId: 'example-no-keep.direct', sentenceDigest: 'x', requirements: [] };
const check = (adapter: ReturnType<typeof persistenceAdapter>, payload: unknown) => adapter.check({ kind: adapter.kind, ref: 'r', digest: digestOf(payload), payload }, claim, new AbortController().signal);

describe('persistence evidence', () => {
  it('cannot manufacture observation proof from a declared sink or missing native attachment', () => {
    expect(sinkObservations(undefined, [{ sinkId: 'db', channel: 'nativeWrites', inspectionDigest: 'i' }])).toEqual([]);
    const result = verifyNoContentWrites({ path: 'direct', inventory, requiredCases: ['success'], runs: [run('success')], harness, requireObservationProofs: true });
    expect(result).toEqual({ kind: 'failed', failures: ['success: missing observation proof for db', 'success: missing observation proof for log'] });
  });
  it('refuses a missing observer and coverage split between different cases', () => {
    const split = verifyNoContentWrites({ path: 'direct', inventory, requiredCases: ['success', 'restart'], runs: [run('success', { observedSinks: ['db'] }), run('restart', { observedSinks: ['log'] })], harness });
    expect(split).toEqual({ kind: 'failed', failures: ['success: no observer covered log', 'restart: no observer covered db'] });
    const missing = verifyNoContentWrites({ path: 'direct', inventory, requiredCases: ['success'], runs: [run('success', { attachedBeforeFirstRequest: false, observedSinks: [] })], harness });
    expect(missing).toEqual({ kind: 'failed', failures: ['success: the observers attached after the first request', 'success: no observer covered db', 'success: no observer covered log'] });
  });
  it('verifies no content writes when every required case ran attached, observed every sink and found nothing', async () => {
    const result = verifyNoContentWrites({ path: 'direct', inventory, requiredCases: ['success', 'restart'], runs: [run('success'), run('restart')], harness });
    expect(result).toEqual({ kind: 'verified_no_content_writes', path: 'direct', sinks: inventory, scenarios: ['success', 'restart'] });
    expect((await check(persistenceAdapter(), result)).verdict).toBe('supported');
  });

  it('fails a missing case, a late observer, a finding, an unknown sink, an unobserved sink and another harness', () => {
    const result = verifyNoContentWrites({
      path: 'direct',
      inventory,
      requiredCases: ['success', 'restart', 'timeout'],
      runs: [
        run('success', { attachedBeforeFirstRequest: false }),
        run('restart', { findings: [{ sinkId: 'db', code: 'marker_in_database', detail: 'sessions.note' }], observedSinks: ['db', 'tmp'] }),
      ],
      harness: { ...harness, harnessDigest: 'other' },
    });
    expect(result.kind).toBe('failed');
    expect(result.kind === 'failed' && result.failures).toEqual([
      'success: another harness ran',
      'success: the observers attached after the first request',
      'restart: another harness ran',
      'restart: marker_in_database in db (sessions.note)',
      'restart: tmp is not in the sink inventory',
      'restart: no observer covered log',
      'timeout: the required case did not run',
    ]);
  });

  it('refuses a database sink without allowed fields and a duplicate sink id', () => {
    const result = verifyNoContentWrites({ path: 'direct', inventory: [{ id: 'db', kind: 'database', location: 'x', allowedFields: null }, { id: 'db', kind: 'log', location: 'y', allowedFields: null }], requiredCases: ['success'], runs: [run('success', { observedSinks: ['db'] })], harness });
    expect(result.kind === 'failed' && result.failures.slice(0, 2)).toEqual(['db: a database sink names no allowed fields', 'db: the sink id appears twice']);
  });

  it('says a deliberate leak went undetected', () => {
    expect(leakDetectionProblems([run('leak-db', { findings: [{ sinkId: 'db', code: 'marker_in_database', detail: 'x' }] }), run('leak-log')], [{ caseId: 'leak-db', sinkId: 'db' }, { caseId: 'leak-log', sinkId: 'log' }])).toEqual(['leak-log: the deliberate leak into log was not detected']);
  });

  it('suppresses an absent claim only with passing tests and denials and no implementation, and never as privacy evidence', async () => {
    const absent = suppressionResult({ mode: 'absent', absenceDigests: ['d'], partialRecord: null, tests: [{ id: 'absence-suppression', passed: true }], denials: [{ id: 'link-denied', passed: true }], implementationPresent: false, completePath: false });
    expect(absent.kind).toBe('absent_claim_suppressed');
    expect((await check(suppressionAdapter(), absent)).verdict).toBe('supported');
    expect((await check(persistenceAdapter(), absent)).verdict).toBe('unverifiable');
    expect(suppressionResult({ mode: 'absent', absenceDigests: ['d'], partialRecord: null, tests: [{ id: 't', passed: true }], denials: [], implementationPresent: true, completePath: false }).kind).toBe('failed');
    const partial = suppressionResult({ mode: 'partial', absenceDigests: [], partialRecord: 'p', tests: [{ id: 'partial-suppression', passed: true }], denials: [{ id: 'route-denied', passed: true }], implementationPresent: true, completePath: false });
    expect(partial.kind).toBe('partial_claim_suppressed');
    expect(suppressionResult({ mode: 'partial', absenceDigests: [], partialRecord: 'p', tests: [{ id: 't', passed: true }], denials: [{ id: 'd', passed: true }], implementationPresent: true, completePath: true }).kind).toBe('failed');
  });

  it('refuses a verification that rests on no case, names a case twice, leaves a run unread or states no path or harness', () => {
    expect(verifyNoContentWrites({ path: 'direct', inventory, requiredCases: [], runs: [], harness })).toEqual({ kind: 'failed', failures: ['no required case'] });
    expect(verifyNoContentWrites({ path: 'direct', inventory, requiredCases: ['success', 'success'], runs: [run('success')], harness })).toEqual({ kind: 'failed', failures: ['success: the required case appears twice'] });
    const unread = run('extra', { findings: [{ sinkId: 'log', code: 'marker_in_stream', detail: 'stdout' }] });
    expect(verifyNoContentWrites({ path: 'direct', inventory, requiredCases: ['success'], runs: [run('success'), unread], harness })).toEqual({ kind: 'failed', failures: ['extra: the case ran but is not required'] });
    const unstated = { commit: '', harnessDigest: 'h', applicationDigest: 'a' };
    expect(verifyNoContentWrites({ path: '', inventory, requiredCases: ['success'], runs: [run('success', { harness: unstated })], harness: unstated })).toEqual({ kind: 'failed', failures: ['no path', 'the harness names no commit, harness digest or application digest'] });
  });

  it('names a missing negative case when no deliberate leak is expected', () => {
    expect(leakDetectionProblems([run('leak-db')], [])).toEqual(['no deliberate leak was named']);
  });

  it('refuses a partial suppression with no implementation or a blank partial-implementation record', () => {
    const partial = { mode: 'partial' as const, absenceDigests: [], partialRecord: 'p', tests: [{ id: 't', passed: true }], denials: [{ id: 'd', passed: true }], implementationPresent: true, completePath: false };
    expect(suppressionResult({ ...partial, implementationPresent: false })).toEqual({ kind: 'failed', failures: ['no implementation exists, so partial suppression does not apply'] });
    expect(suppressionResult({ ...partial, partialRecord: '' })).toEqual({ kind: 'failed', failures: ['no partial-implementation record'] });
  });

  it('reads a result again before either adapter supports it', async () => {
    const verified = { kind: 'verified_no_content_writes', path: 'direct', sinks: inventory, scenarios: ['success'] };
    expect(await check(persistenceAdapter(), verified)).toEqual({ verdict: 'supported', basis: 'deterministic', detail: '1 cases on direct' });
    const verifiedFaults: [unknown, string][] = [
      [{ kind: 'verified_no_content_writes' }, 'the result lacks its path, sinks or cases'],
      [{ ...verified, path: '' }, 'the result names no path'],
      [{ ...verified, scenarios: [] }, 'the result names no case'],
      [{ ...verified, scenarios: ['success', 'success'] }, 'the result names a case twice'],
      [{ ...verified, sinks: [{ id: 'db', kind: 'database', location: 'state/app.db' }] }, 'the result holds a sink that is not a sink entry'],
      [{ ...verified, sinks: [] }, 'the inventory is empty'],
    ];
    for (const [payload, detail] of verifiedFaults) expect(await check(persistenceAdapter(), payload)).toEqual({ verdict: 'unverifiable', basis: 'deterministic', detail });
    const absent = { kind: 'absent_claim_suppressed', absence: ['d'], tests: ['absence-suppression'], denials: ['link-denied'] };
    const partial = { kind: 'partial_claim_suppressed', partial: 'p', tests: ['partial-suppression'], denials: ['route-denied'] };
    expect((await check(suppressionAdapter(), absent)).verdict).toBe('supported');
    expect((await check(suppressionAdapter(), partial)).verdict).toBe('supported');
    const suppressionFaults: [unknown, string][] = [
      [{ ...absent, absence: [] }, 'the result names no refreshed absence record'],
      [{ ...absent, tests: [] }, 'the result names no executed test'],
      [{ ...partial, denials: [] }, 'the result names no executed denial'],
      [{ ...partial, partial: '' }, 'the result names no partial-implementation record'],
      [{ kind: 'partial_claim_suppressed', partial: 'p' }, 'the result names no executed test'],
    ];
    for (const [payload, detail] of suppressionFaults) expect(await check(suppressionAdapter(), payload)).toEqual({ verdict: 'unverifiable', basis: 'deterministic', detail });
  });
});
