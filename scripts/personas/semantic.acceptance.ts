import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GROUNDING_FIXTURES } from './grounding-fixtures.ts';
import {
  profiles,
  runSemanticAcceptance,
  type SemanticRecord,
} from './semantic.ts';

const grounded = {
  grounded: true, complete: true, unsupported: [], missing: [],
  rationale: 'All fixture requirements are preserved.',
};
const ungrounded = {
  grounded: false, complete: true,
  unsupported: ['The answer adds a suggestion or changes an obligation.'],
  missing: [], rationale: 'The source does not support the added meaning.',
};

/** This judge is only a runner test. The keyed workflow never imports it. */
const fakeJudge = async (input: { source: string; answer: string }) => {
  const fixture = GROUNDING_FIXTURES.find((entry) => entry.source === input.source);
  assert.ok(fixture);
  return fixture.rejected.includes(input.answer) ? ungrounded : grounded;
};

test('covers every trait in every band and the preset and two combined corners', () => {
  const entries = profiles();
  assert.equal(entries.length, 21);
  for (const trait of ['honesty', 'emotionality', 'extraversion', 'agreeableness', 'conscientiousness', 'openness']) {
    for (const band of ['low', 'moderate', 'high']) {
      assert.ok(entries.some((entry) => entry.id === `${trait}:${band}`));
    }
  }
  for (const entry of entries) {
    assert.ok(entry.section.startsWith('## Personality & Communication Style\n\nChange only how grounded material is presented:'));
  }
});

test('calibrates the grounded controls once and judges the planted controls and an answer for every profile', async () => {
  const records: SemanticRecord[] = [];
  let writes = 0;
  let judgments = 0;
  const result = await runSemanticAcceptance({
    write: async ({ source, section }) => {
      writes += 1;
      assert.ok(section.includes('never change its meaning'));
      return GROUNDING_FIXTURES.find((entry) => entry.source === source)!.accepted[0]!;
    },
    judge: async (input) => { judgments += 1; return fakeJudge(input); },
    record: async (record) => { records.push(record); },
  });
  assert.deepEqual(result, { profiles: 21, fixtures: 2, generated: 42, judgments: 130 });
  assert.equal(writes, 42);
  assert.equal(judgments, 130);
  assert.equal(records.length, 130);
  assert.ok(records.every((record) => record.passed));
  // The four grounded controls come first, under the preset's section; then, for every profile and fixture, both
  // planted controls under that profile's own section and its generated answer.
  const calibration = records.slice(0, 4);
  assert.ok(calibration.every((record) => record.profile === 'preset'));
  assert.deepEqual(calibration.map((record) => record.case), ['grounded-1', 'grounded-2', 'grounded-1', 'grounded-2']);
  const perProfile = records.slice(4);
  assert.deepEqual(
    perProfile.map((record) => record.case),
    Array.from({ length: 42 }, () => ['planted-1', 'planted-2', 'generated']).flat(),
  );
  const sections = new Map(profiles().map((entry): [string, string] => [entry.id, entry.section]));
  assert.ok(perProfile.every((record) => record.section === sections.get(record.profile)));
  assert.equal(new Set(perProfile.map((record) => record.profile)).size, 21);
});

test('fails when a planted suggestion is accepted', async () => {
  await assert.rejects(runSemanticAcceptance({
    write: async () => 'Unused', judge: async () => grounded, record: async () => {},
  }), /semantic acceptance failed/);
});

test('fails when a grounded paraphrase is refused', async () => {
  await assert.rejects(runSemanticAcceptance({
    write: async () => 'Unused', judge: async () => ungrounded, record: async () => {},
  }), /semantic acceptance failed/);
});

test('fails on an invented generated answer after successful calibration', async () => {
  await assert.rejects(runSemanticAcceptance({
    write: async ({ source }) => GROUNDING_FIXTURES.find((entry) => entry.source === source)!.rejected[0]!,
    judge: fakeJudge, record: async () => {},
  }), /semantic acceptance failed: .*:generated/);
});

test('does not interpret a malformed judgment as a rejection that passes calibration', async () => {
  for (const reply of [null, {}, { ...ungrounded, rationale: '' }, { ...ungrounded, grounded: 'false' }]) {
    // Every other judgment is valid and correct, so only the malformed reply to a planted control can stop the run,
    // and it must stop it as malformed, not as a verdict that failed or passed.
    await assert.rejects(runSemanticAcceptance({
      write: async ({ source }) => GROUNDING_FIXTURES.find((entry) => entry.source === source)!.accepted[0]!,
      judge: async (input) => {
        const verdict = await fakeJudge(input);
        return verdict === ungrounded ? reply : verdict;
      },
      record: async () => {},
    }), (error: unknown) => !(error instanceof Error && /semantic acceptance failed/.test(error.message)));
  }
});

test('propagates provider failure and never retries it as a passing result', async () => {
  let calls = 0;
  await assert.rejects(runSemanticAcceptance({
    write: async () => 'Unused',
    judge: async () => { calls += 1; throw new Error('fixture provider unavailable'); },
    record: async () => {},
  }), /fixture provider unavailable/);
  assert.equal(calls, 1);
});

/** The published-package check, which the dispatched workflow runs as a script. */
const verifier = fileURLToPath(new URL('./verify-release.ts', import.meta.url));
/** Answers every registry read with a 404, so a version the gate lets through stops at the next check, offline. */
const offlineRegistry = `--import=data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => new Response(null, { status: 404 });')}`;

/** Runs the published-package check for one version and returns its exit status and error output. */
function verifyRelease(version: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', offlineRegistry, verifier], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PERSONAS_VERSION: version,
      PERSONAS_MERGE: '0'.repeat(40),
      PERSONAS_PACKAGE_DIR: join(tmpdir(), 'personas-release-gate'),
      GITHUB_OUTPUT: '',
    },
  });
  return { status: result.status, stderr: result.stderr };
}

test('refuses a 0.14.x patch before reading the registry and lets 0.15.0 or later on to it', () => {
  // The persona change is breaking, so it ships in a new minor: a 0.14.x patch is refused even when it holds the merge.
  for (const version of ['0.13.165', '0.14.25', '0.14.26', '0.14.27']) {
    const run = verifyRelease(version);
    assert.notEqual(run.status, 0, `${version} passed the release check`);
    assert.match(run.stderr, /a new minor after 0\.14\.x is required/);
    assert.doesNotMatch(run.stderr, /not yet on the registry/);
  }
  for (const version of ['0.15.0', '0.15.4', '1.0.0']) {
    const run = verifyRelease(version);
    assert.notEqual(run.status, 0, `${version} passed the release check with no registry`);
    assert.doesNotMatch(run.stderr, /a new minor after/);
    assert.match(run.stderr, /the exact release is not yet on the registry/);
  }
});
