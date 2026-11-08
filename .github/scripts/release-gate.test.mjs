// The daily release's gate, run on repositories of its own: each test commits files, tags a
// release and reads the decision release-gate.mjs makes from the commits after the tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import config from '../../release.config.js';
import { BUILD_INPUTS, decide, ships } from './release-gate.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'release-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'master');
  git('config', 'user.email', 'gate@example.com');
  git('config', 'user.name', 'gate');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  const commit = (message, files) => {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  commit('feat: first', { 'src/index.ts': 'export {};\n', 'docs/guide.md': 'guide\n' });
  git('tag', 'v0.1.0');
  return { dir, git, commit, decision: (force = false) => decide({ cwd: dir, force, pkg, config }) };
}

test('a fix to the source after the last tag releases', (t) => {
  const repo = repository(t);
  const sha = repo.commit('fix(api): keep the old default', { 'src/index.ts': 'export const a = 1;\n' });
  const result = repo.decision();
  assert.equal(result.releasable, true);
  assert.equal(result.lastTag, 'v0.1.0');
  assert.deepEqual(result.releasing.map((c) => [c.sha, c.why, c.files]), [[sha, 'fix', ['src/index.ts']]]);
});

test('a type that releases nothing does not release, whatever it changes', (t) => {
  const repo = repository(t);
  repo.commit('docs: explain the option', { 'src/index.ts': '// a comment\nexport {};\n' });
  repo.commit('chore(deps): bump a dev tool', { 'package.json': '{}\n' });
  repo.commit('ci: cache the store', { '.github/workflows/ci.yml': 'name: CI\n' });
  const result = repo.decision();
  assert.equal(result.releasable, false);
  assert.equal(result.commits, 3);
  assert.match(result.reason, /none of the 3 commits since v0\.1\.0/);
});

test('a releasing type that changes nothing the package ships does not release', (t) => {
  const repo = repository(t);
  repo.commit('fix: correct the guide', { 'docs/guide.md': 'fixed\n' });
  repo.commit('fix: cover the default', { 'src/__tests__/index.test.ts': 'test\n', 'src/index.spec.ts': 'spec\n' });
  repo.commit('feat: a new example', { 'examples/new.mjs': 'x\n' });
  assert.equal(repo.decision().releasable, false);
});

test('a breaking marker releases whatever the type: ! in the header or a note in the body', (t) => {
  const bang = repository(t);
  bang.commit('chore(api)!: drop the old option', { 'src/index.ts': 'export const b = 2;\n' });
  assert.deepEqual(bang.decision().releasing.map((c) => c.why), ['chore!']);

  const note = repository(t);
  note.commit('docs: move the option\n\nBREAKING CHANGE: callers pass the new option', { 'package.json': '{"a":1}\n' });
  assert.deepEqual(note.decision().releasing.map((c) => c.why), ['breaking-change note']);
});

test('a revert releases, as git writes it or as a revert: header', (t) => {
  const repo = repository(t);
  const reverted = repo.commit('feat(memory): add the reader', { 'src/reader.ts': 'export {};\n' });
  repo.git('tag', 'v0.1.1');
  repo.git('revert', '--no-edit', reverted);
  assert.match(repo.git('log', '-1', '--format=%s'), /^Revert "feat\(memory\): add the reader"$/);
  assert.deepEqual(repo.decision().releasing.map((c) => c.why), ['revert']);
});

test('a fix to the badge script releases, since the release writes the badge the package ships', (t) => {
  const repo = repository(t);
  repo.commit('fix: count skipped tests in the badge', { 'scripts/update-test-badge.mjs': 'x\n' });
  assert.equal(repo.decision().releasable, true);
});

test('a dependency fix releases through package.json or the lockfile', (t) => {
  const repo = repository(t);
  repo.commit('fix(deps): take the patched parser', { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' });
  assert.equal(repo.decision().releasable, true);
});

test('the commits a merge brings in count, each with its own change', (t) => {
  const repo = repository(t);
  repo.git('checkout', '-q', '-b', 'feature');
  const sha = repo.commit('feat(memory): add the reader', { 'src/reader.ts': 'export {};\n' });
  repo.git('checkout', '-q', 'master');
  repo.commit('docs: a note', { 'docs/guide.md': 'note\n' });
  repo.git('merge', '-q', '--no-ff', '--no-edit', '-m', 'Merge pull request #1 from feature', 'feature');
  const result = repo.decision();
  assert.equal(result.releasable, true);
  assert.deepEqual(result.releasing.map((c) => c.sha), [sha]);
});

test('the last tag is the highest version reachable from HEAD', (t) => {
  const repo = repository(t);
  repo.commit('fix: one', { 'src/index.ts': 'export const c = 3;\n' });
  repo.git('tag', 'v0.1.9');
  repo.commit('fix: two', { 'src/index.ts': 'export const c = 4;\n' });
  repo.git('tag', 'v0.1.10');
  repo.git('tag', 'not-a-release');
  repo.commit('test: more cases', { 'src/__tests__/a.test.ts': 'x\n' });
  const result = repo.decision();
  assert.equal(result.lastTag, 'v0.1.10');
  assert.equal(result.commits, 1);
  assert.equal(result.releasable, false);
});

test('with no release tag, or with force, the run releases', (t) => {
  const repo = repository(t);
  repo.git('tag', '-d', 'v0.1.0');
  assert.match(repo.decision().reason, /no release tag/);
  repo.git('tag', 'v0.1.0');
  const forced = repo.decision(true);
  assert.equal(forced.releasable, true);
  assert.match(forced.reason, /force/);
});

test('what ships follows package.json and the build', () => {
  for (const path of ['src/a/b.ts', 'src/data.json', 'package.json', 'README.md', 'LICENSE', 'tsconfig.build.json', 'dist/index.js', '.github/badges/tests.json']) {
    assert.equal(ships(path, pkg), true, path);
  }
  for (const path of ['src/a/__tests__/b.ts', 'src/a.test.ts', 'docs/README.md', 'tests/basic.spec.ts', 'scripts/other.mjs', 'srcfoo/a.ts', 'CHANGELOG.md']) {
    assert.equal(ships(path, pkg), false, path);
  }
});

test('every build input the gate names exists in this repository', () => {
  for (const path of BUILD_INPUTS) assert.ok(existsSync(join(root, path)), `${path} is missing: update BUILD_INPUTS in release-gate.mjs`);
});
