import { describe, expect, it } from 'vitest';
import { digestOf, sha256Hex } from '../../digest.js';
import { captureAdapter, validateCaptureSet, type CaptureManifest, type CaptureRequirement } from '../CaptureEvidence.js';
import { runCaptures, selectDriver, type CaptureDriver } from '../CaptureDriver.js';
import { fixtureDigest, validateFixtureManifest, type FixtureManifest } from '../FixtureManifest.js';
import { historicalCaptureAdapter, type HistoricalCapturePayload } from '../HistoricalCaptureEvidence.js';

const sizes = [{ width: 390, height: 844, scale: 2 }, { width: 1440, height: 900, scale: 1 }];
const bytesOf = (id: string) => sha256Hex(`bytes of ${id}`);
const shot = (width: number, height: number, scale: number, look: 'light' | 'dark'): CaptureManifest => {
  const captureId = `listen-${width}x${height}-${look}`;
  return {
    captureId, sha256: bytesOf(captureId), width, height, scale, look, driverId: 'example-driver', implementation: 'service-a',
    sourceCommit: 'c'.repeat(40), executableDigest: 'e', uiDigest: 'u', harnessDigest: 'h', configurationDigest: 'g', providerFixtureDigest: 'f',
    run: { workflow: 'ci', runId: '7', attempt: 1 }, scenarioId: 'baseline', testId: 'captures > listen', claimIds: ['example-feature.primary'],
    page: { route: '/', identity: 'home' }, audience: 'visitor', servingMode: 'direct',
  };
};
const all = sizes.flatMap(({ width, height, scale }) => (['light', 'dark'] as const).map((look) => shot(width, height, scale, look)));
const requirement: CaptureRequirement = { claimIds: ['example-feature.primary'], implementation: 'service-a', audience: 'visitor', servingMode: 'direct', sizes, looks: ['light', 'dark'], drivers: ['example-driver'], candidateCommit: 'c'.repeat(40), adoptedCommits: [] };
const bytes = Object.fromEntries(all.map((m) => [m.captureId, bytesOf(m.captureId)]));

describe('capture evidence', () => {
  it('refuses a self-supplied requirement without a trusted callback result', async () => {
    const payload = { manifests: all, bytes, requirement };
    for (const adapter of [captureAdapter(), captureAdapter({ requirementFor: () => undefined })]) {
      const outcome = await adapter.check({ kind: 'capture', ref: 'listen', digest: digestOf(payload), payload }, { claimId: 'example-feature.primary', sentenceDigest: 'x', requirements: [] }, new AbortController().signal);
      expect(outcome).toEqual({ verdict: 'unverifiable', basis: 'deterministic', detail: 'no trusted capture requirement' });
    }
  });

  it('supports a complete set using only the requirement bound to the requesting claim and ref', async () => {
    expect(validateCaptureSet({ manifests: all, bytes, requirement })).toEqual([]);
    const payload = { manifests: all, bytes, requirement: { ...requirement, implementation: 'service-b' } };
    const record = { kind: 'capture' as const, ref: 'listen', digest: digestOf(payload), payload };
    Object.defineProperty(payload, 'requirement', { get: () => { throw new Error('payload requirement must not be read'); } });
    const outcome = await captureAdapter({ requirementFor: (claimId, ref) => claimId === 'example-feature.primary' && ref === 'listen' ? requirement : undefined }).check(record, { claimId: 'example-feature.primary', sentenceDigest: 'x', requirements: [] }, new AbortController().signal);
    expect(outcome.verdict).toBe('supported');
  });

  it('names a missing look, a hash that is not its bytes, the wrong mode, an unknown driver and an unadopted commit', () => {
    const problems = validateCaptureSet({
      manifests: [{ ...all[0]!, sha256: 'f'.repeat(64) }, { ...all[1]!, servingMode: 'hosted' }, { ...all[2]!, driverId: 'drawn' }, { ...all[3]!, sourceCommit: 'd'.repeat(40) }].slice(0, 4),
      bytes,
      requirement,
    });
    expect(problems).toEqual([
      'listen-390x844-light: the hash is not the bytes\' hash',
      'listen-390x844-dark: serving mode hosted, not direct',
      'listen-1440x900-light: the driver drawn is not allowed',
      'listen-1440x900-dark: made at another commit, never adopted',
    ]);
    expect(validateCaptureSet({ manifests: all.slice(1), bytes, requirement })).toEqual(['390x844@2 light: no capture']);
  });

  it('names a capture id used twice, and supports nothing when the requirement names no size or look', async () => {
    // One picture under one id, offered as both looks of a size.
    const twice = { ...all[1]!, captureId: all[0]!.captureId, sha256: all[0]!.sha256 };
    expect(validateCaptureSet({ manifests: [all[0]!, twice, all[2]!, all[3]!], bytes, requirement })).toEqual(['listen-390x844-light: named twice']);
    expect(validateCaptureSet({ manifests: [], bytes: {}, requirement: { ...requirement, sizes: [] } })).toEqual(['the requirement names no size']);
    expect(validateCaptureSet({ manifests: [], bytes: {}, requirement: { ...requirement, looks: [] } })).toEqual(['the requirement names no look']);
    const empty = { manifests: [], bytes: {}, requirement };
    const outcome = await captureAdapter({ requirementFor: () => ({ ...requirement, sizes: [], looks: [] }) }).check({ kind: 'capture', ref: 'listen', digest: digestOf(empty), payload: empty }, { claimId: 'example-feature.primary', sentenceDigest: 'x', requirements: [] }, new AbortController().signal);
    expect(outcome).toEqual({ verdict: 'contradicted', basis: 'deterministic', detail: 'the requirement names no size; the requirement names no look' });
  });
});

describe('fixtures and drivers', () => {
  const fixture: FixtureManifest = { id: 'example-fixture', files: [{ path: 'notes.json', sha256: sha256Hex('notes'), purpose: 'synthetic-notes' }], approvedFor: ['capture', 'test'] };

  it('validates a fixture manifest against the files and its approved use', () => {
    expect(validateFixtureManifest(fixture, new Map([['notes.json', sha256Hex('notes')]]), 'capture')).toEqual([]);
    expect(validateFixtureManifest(fixture, new Map([['notes.json', sha256Hex('other')]]), 'capture')).toEqual(['notes.json: the file is not the approved one']);
    expect(validateFixtureManifest({ ...fixture, approvedFor: ['test'] }, new Map([['notes.json', sha256Hex('notes')]]), 'capture')).toEqual(['the fixture is not approved for capture']);
    expect(fixtureDigest(fixture)).toBe(digestOf({ id: 'example-fixture', files: fixture.files }));
  });

  it('selects one driver per implementation and refuses a driver that is not ready or returns another shot', async () => {
    const driver = (id: string, implementation: string, ready = true): CaptureDriver => ({
      id,
      implementation,
      ready: async () => (ready ? { ok: true } : { ok: false, reason: 'the service has no Listen view' }),
      capture: async (s) => ({ file: `${s.name}.png`, manifest: { ...shot(s.width, s.height, s.scale, s.look), captureId: s.name, sha256: sha256Hex(`png ${s.name}`), driverId: id, implementation } }),
    });
    expect(selectDriver([driver('a', 'service-a'), driver('b', 'service-b')], 'service-b').id).toBe('b');
    expect(() => selectDriver([driver('a', 'service-a')], 'service-c')).toThrow(/no capture driver/);
    const context = { outputDir: 'out', run: { workflow: 'ci', runId: '7', attempt: 1, sourceCommit: 'c'.repeat(40) }, fixture };
    const shots = [{ name: 'x', claimIds: ['example-feature.primary'], route: '/', width: 390, height: 844, scale: 2, look: 'light' as const, scenarioId: 'baseline', testId: 't' }];
    const notReady = await runCaptures(driver('a', 'service-a', false), shots, context, async () => new Uint8Array());
    expect(notReady.problems).toEqual(['a is not ready: the service has no Listen view']);
    const wrongBytes = await runCaptures(driver('a', 'service-a'), shots, context, async () => new TextEncoder().encode('other'));
    expect(wrongBytes.problems).toEqual(['x: the file is not the bytes its manifest names']);
  });
});

describe('claim-bound capture adapters', () => {
  it('rejects another claim and a payload-chosen implementation', async () => {
    const bytes = { image: 'a'.repeat(64) };
    const requirement: CaptureRequirement = { claimIds: ['example-feature.primary'], implementation: 'service-a', audience: 'account', servingMode: 'direct', sizes: [], looks: [], drivers: ['a'], candidateCommit: 'c', adoptedCommits: [], identity: { executableDigest: 'e', uiDigest: 'u', harnessDigest: 'h', configurationDigest: 'g', providerFixtureDigest: 'p' } };
    // Deliberately partial: the requirement names no size or look, so nothing reads the fields it leaves out.
    const manifest = { captureId: 'image', sha256: bytes.image, implementation: 'service-b', audience: 'visitor', servingMode: 'hosted', driverId: 'a', sourceCommit: 'c', claimIds: ['sibling.primary'], ...requirement.identity } as unknown as CaptureManifest;
    const payload = { manifests: [manifest], bytes, requirement: { ...requirement, implementation: 'service-b', audience: 'visitor', servingMode: 'hosted', claimIds: ['sibling.primary'] } };
    const result = await captureAdapter({ requirementFor: () => requirement }).check({ kind: 'capture', ref: 'image', digest: digestOf(payload), payload }, { claimId: 'example-feature.primary', sentenceDigest: 'x', requirements: [] }, new AbortController().signal);
    expect(result.verdict).toBe('contradicted');
    expect(result.detail).toContain('requesting claim');
    expect(result.detail).toContain('implementation');
  });
});

describe('historical captures', () => {
  const original: CaptureManifest = { captureId: 'release-1', sha256: 'a'.repeat(64), width: 1, height: 1, scale: 1, look: 'light', driverId: 'example', implementation: 'service-a', sourceCommit: 'c', executableDigest: 'e', uiDigest: 'u', harnessDigest: 'h', configurationDigest: 'g', providerFixtureDigest: 'p', run: { workflow: 'capture', runId: '1', attempt: 1 }, scenarioId: 'example', testId: 'example', claimIds: ['example-feature.primary'], page: { route: '/', identity: 'page' }, audience: 'account', servingMode: 'direct' };
  const required: CaptureRequirement = { claimIds: original.claimIds, implementation: original.implementation, audience: original.audience, servingMode: original.servingMode, sizes: [{ width: 1, height: 1, scale: 1 }], looks: ['light'], drivers: ['example'], candidateCommit: 'c', adoptedCommits: [], identity: { executableDigest: 'e', uiDigest: 'u', harnessDigest: 'h', configurationDigest: 'g', providerFixtureDigest: 'p' } };
  const payload: HistoricalCapturePayload = {
    originalManifest: original, originalReceiptDigest: 'r', captureId: 'release-1', originalSha256: 'a'.repeat(64), originalDate: '2026-11-02', receiptDate: '2026-11-02', bundleDigest: 'b'.repeat(64),
    placement: { kind: 'history', route: '/whats-new/example', captionId: 'history.caption.example', altId: 'history.alt.example' }, claimIds: ['example-feature.primary'],
  };
  const check = (p: HistoricalCapturePayload, verified = true) =>
    historicalCaptureAdapter({ captions: new Set(['history.caption.example', 'history.alt.example']), verifyBundleCapture: async () => verified, originalFor: () => ({ receiptDigest: 'r', placement: payload.placement, claimIds: payload.claimIds, requirement: required }), verifyOriginal: async () => true }).check(
      { kind: 'historical-capture', ref: p.captureId, digest: digestOf(p), payload: p }, { claimId: 'example-feature.primary', sentenceDigest: 'x', requirements: [] }, new AbortController().signal);

  it('rejects a sibling original, changed receipt and unauthorized history route', async () => {
    expect((await check({ ...payload, claimIds: ['sibling.primary'] })).verdict).toBe('contradicted');
    const expected = { receiptDigest: 'r', placement: payload.placement, claimIds: payload.claimIds, requirement: required };
    const adapter = historicalCaptureAdapter({ captions: new Set(['history.caption.example', 'history.alt.example']), verifyBundleCapture: async () => true, originalFor: () => expected, verifyOriginal: async () => true });
    for (const changed of [{ ...payload, originalReceiptDigest: 'wrong' }, { ...payload, originalReceiptDigest: 'r', placement: { ...payload.placement, route: '/other-history' } }]) {
      expect((await adapter.check({ kind: 'historical-capture', ref: changed.captureId, digest: digestOf(changed), payload: changed }, { claimId: 'example-feature.primary', sentenceDigest: 'x', requirements: [] }, new AbortController().signal)).verdict).toBe('contradicted');
    }
  });
  it('supports a verified original in a dated history placement with catalogued words', async () => {
    expect((await check(payload)).verdict).toBe('supported');
  });
  it('contradicts an active placement and an uncatalogued caption, and cannot verify a lost original', async () => {
    expect((await check({ ...payload, placement: { ...payload.placement, kind: 'active' } })).verdict).toBe('contradicted');
    expect((await check({ ...payload, placement: { ...payload.placement, captionId: 'free.text' } })).verdict).toBe('contradicted');
    expect((await check(payload, false)).verdict).toBe('unverifiable');
  });
});
