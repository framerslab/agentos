import { describe, expect, it } from 'vitest';
import { digestOf } from '../digest.js';
import { allAuthorized, EvidenceClaimVerifier } from '../EvidenceClaimVerifier.js';
import type { AdapterOutcome, ClaimUnderTest, EvidenceAdapter, EvidenceKind, EvidenceRecord } from '../types.js';

const record = (kind: EvidenceKind, ref: string, payload: unknown): EvidenceRecord => ({ kind, ref, digest: digestOf(payload), payload });
const answering = (kind: EvidenceKind, outcome: AdapterOutcome): EvidenceAdapter => ({ kind, check: async () => outcome });
const supported = (kind: EvidenceKind) => answering(kind, { verdict: 'supported', basis: 'deterministic', detail: 'ok' });
const claim = (claimId: string, ...requirements: [EvidenceKind, string][]): ClaimUnderTest => ({
  claimId,
  sentenceDigest: digestOf({ sentence: claimId }),
  requirements: requirements.map(([kind, ref]) => ({ kind, ref })),
});

describe('the evidence-claim contract', () => {
  it('authorizes a claim whose every piece of evidence is present, unaltered and supported', async () => {
    const verifier = new EvidenceClaimVerifier({ adapters: [supported('route'), supported('test')] });
    const report = await verifier.verify([claim('example-feature.primary', ['route', 'GET /example'], ['test', 'example journey'])], [
      record('route', 'GET /example', { status: 200 }),
      record('test', 'example journey', { passed: true }),
    ]);
    expect(report.inputErrors).toEqual([]);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({ claimId: 'example-feature.primary', authorized: true, checked: 2, failures: [] });
    expect(allAuthorized(report)).toBe(true);
  });

  it('refuses missing evidence, a missing adapter and an altered digest, each by its own code', async () => {
    const verifier = new EvidenceClaimVerifier({ adapters: [supported('route')] });
    const altered = { ...record('route', 'GET /b', { status: 200 }), payload: { status: 404 } };
    const report = await verifier.verify(
      [claim('a.primary', ['route', 'GET /a']), claim('b.primary', ['route', 'GET /b']), claim('c.primary', ['capture', 'shot-1'])],
      [altered, record('capture', 'shot-1', { sha256: 'x' })],
    );
    expect(report.results.map((r) => r.failures.map((f) => f.code))).toEqual([['missing_evidence'], ['altered_evidence'], ['missing_adapter']]);
    expect(allAuthorized(report)).toBe(false);
  });

  it('refuses weak, unverifiable and contradicted verdicts and a similarity basis, whatever its verdict', async () => {
    for (const outcome of [
      { verdict: 'weak', basis: 'deterministic' },
      { verdict: 'unverifiable', basis: 'deterministic' },
      { verdict: 'contradicted', basis: 'deterministic' },
      { verdict: 'supported', basis: 'similarity' },
    ] as const) {
      const verifier = new EvidenceClaimVerifier({ adapters: [answering('test', { ...outcome, detail: 'scored' })] });
      const report = await verifier.verify([claim('a.primary', ['test', 't'])], [record('test', 't', {})]);
      const code = outcome.basis === 'similarity' ? 'similarity_basis' : 'not_supported';
      expect(report.results[0]?.failures.map((f) => f.code), `${outcome.verdict} ${outcome.basis}`).toEqual([code]);
    }
  });

  it('turns a thrown adapter, a malformed answer and a timeout into failures, never a pass', async () => {
    const thrower: EvidenceAdapter = { kind: 'route', check: async () => { throw new Error('read failed'); } };
    const malformed: EvidenceAdapter = { kind: 'test', check: async () => ({ verdict: 'fine' }) as unknown as AdapterOutcome };
    const hanging: EvidenceAdapter = { kind: 'capture', check: (_r, _c, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) };
    const verifier = new EvidenceClaimVerifier({ adapters: [thrower, malformed, hanging], timeoutMs: 20 });
    const report = await verifier.verify(
      [claim('a.primary', ['route', 'r']), claim('b.primary', ['test', 't']), claim('c.primary', ['capture', 'c'])],
      [record('route', 'r', {}), record('test', 't', {}), record('capture', 'c', {})],
    );
    expect(report.results.map((r) => r.failures[0]?.code)).toEqual(['adapter_error', 'adapter_error', 'adapter_timeout']);
  });

  it('refuses a claim with no requirements and a requirement named twice', async () => {
    const verifier = new EvidenceClaimVerifier({ adapters: [supported('route')] });
    const report = await verifier.verify([claim('a.primary'), claim('b.primary', ['route', 'r'], ['route', 'r'])], [record('route', 'r', {})]);
    expect(report.results.map((r) => r.failures.map((f) => f.code))).toEqual([['no_requirements'], ['duplicate_requirement']]);
  });

  it('reports input errors and authorizes nothing: an empty set, a duplicate claim, duplicate evidence, an unknown kind', async () => {
    const verifier = new EvidenceClaimVerifier({ adapters: [supported('route')] });
    expect((await verifier.verify([], [])).inputErrors.map((e) => e.code)).toEqual(['empty_claim_set']);
    const twice = await verifier.verify([claim('a.primary', ['route', 'r']), claim('a.primary', ['route', 'r'])], [record('route', 'r', {})]);
    expect(twice.inputErrors.map((e) => e.code)).toEqual(['duplicate_claim_id']);
    expect(twice.results).toEqual([]);
    const dup = await verifier.verify([claim('a.primary', ['route', 'r'])], [record('route', 'r', {}), record('route', 'r', {})]);
    expect(dup.inputErrors.map((e) => e.code)).toEqual(['duplicate_evidence']);
    const unknown = await verifier.verify([claim('a.primary', ['route', 'r'])], [{ kind: 'similarity' as EvidenceKind, ref: 'x', digest: digestOf({}), payload: {} }]);
    expect(unknown.inputErrors.map((e) => e.code)).toEqual(['unknown_kind']);
    expect(allAuthorized(unknown)).toBe(false);
  });

  it('refuses two adapters for one kind and an adapter for an unknown kind', () => {
    expect(() => new EvidenceClaimVerifier({ adapters: [supported('route'), supported('route')] })).toThrow(/two adapters/);
    expect(() => new EvidenceClaimVerifier({ adapters: [supported('similarity' as EvidenceKind)] })).toThrow(/unknown kind/);
  });
});
