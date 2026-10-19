// @ts-check
// check-workflow-pushes.mjs against its fixtures: a refused fixture reports exactly the lines it marks with
// `lint-expect`, an allowed fixture reports nothing, and the command exits 1 on a push to master, 0 without one and
// 2 when it finds no workflow to read.
// Run: node --test .github/scripts/check-workflow-pushes.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkFiles, workflowFiles } from './check-workflow-pushes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures', 'workflow-pushes');
const script = join(here, 'check-workflow-pushes.mjs');

/**
 * The lines a fixture marks as reported.
 * @param {string} file
 */
const marked = (file) =>
  readFileSync(file, 'utf8').split('\n').flatMap((line, i) => (line.includes('lint-expect') ? [i + 1] : []));

/**
 * The workflow fixtures in a directory.
 * @param {string} dir
 */
const yamlIn = (dir) => readdirSync(dir).filter((name) => name.endsWith('.yml')).sort().map((name) => join(dir, name));

/**
 * @param {string[]} args
 * @param {Record<string, string>} env
 */
const run = (args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '', DEFAULT_BRANCH: 'master', ...env },
  });

const refusedCases = [
  ...yamlIn(join(fixtures, 'refused')).map((file) => ({ file, root: join(fixtures, 'refused') })),
  { file: join(fixtures, 'refused', 'semantic-release', 'release.yml'), root: join(fixtures, 'refused', 'semantic-release') },
];
const allowedCases = [
  ...yamlIn(join(fixtures, 'allowed')).map((file) => ({ file, root: join(fixtures, 'allowed') })),
  { file: join(fixtures, 'allowed', 'semantic-release', 'release.yml'), root: join(fixtures, 'allowed', 'semantic-release') },
];

for (const { file, root } of refusedCases) {
  test(`reports each marked line of ${file.slice(fixtures.length + 1)}`, () => {
    const expected = marked(file);
    assert.ok(expected.length > 0, 'a refused fixture marks the lines it expects reported');
    const findings = checkFiles([file], { root, defaultBranch: 'master' });
    assert.deepEqual(
      findings.map((f) => f.line),
      expected,
      findings.map((f) => `${f.line}: ${f.message}`).join('\n'),
    );
  });
}

for (const { file, root } of allowedCases) {
  test(`reports nothing in ${file.slice(fixtures.length + 1)}`, () => {
    const findings = checkFiles([file], { root, defaultBranch: 'master' });
    assert.deepEqual(findings.map((f) => `${f.line}: ${f.message}`), []);
  });
}

test('the default branch is the one DEFAULT_BRANCH names, and master and main stay refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-pushes-'));
  try {
    const file = join(dir, 'trunk.yml');
    writeFileSync(file, [
      'on:',
      '  pull_request:',
      'jobs:',
      '  push:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: git push origin HEAD:trunk',
      '      - run: git push origin HEAD:main',
      '',
    ].join('\n'));
    assert.deepEqual(checkFiles([file], { root: dir, defaultBranch: 'trunk' }).map((f) => f.line), [7, 8]);
    assert.deepEqual(checkFiles([file], { root: dir, defaultBranch: 'master' }).map((f) => f.line), [8]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a semantic-release package script with @semantic-release/git in package.json is a run that commits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-pushes-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { release: 'semantic-release', 'release:check': 'semantic-release --dry-run' },
      release: { plugins: ['@semantic-release/npm', '@semantic-release/git'] },
    }));
    const file = join(dir, 'release.yml');
    writeFileSync(file, [
      'on:',
      '  push:',
      '    branches: [master]',
      'jobs:',
      '  release:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: NPM_CONFIG_PROVENANCE=true pnpm run release',
      '      - run: pnpm run release:check',
      '',
    ].join('\n'));
    const findings = checkFiles([file], { root: dir, defaultBranch: 'master' });
    assert.deepEqual(findings.map((f) => f.line), [8]);
    assert.match(findings[0].message, /package\.json \(release\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflowFiles reads .github/workflows and the composite actions under .github/actions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-pushes-'));
  try {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    mkdirSync(join(dir, '.github', 'actions', 'publish'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'on: [push]\n');
    writeFileSync(join(dir, '.github', 'workflows', 'notes.md'), '# not a workflow\n');
    writeFileSync(join(dir, '.github', 'actions', 'publish', 'action.yml'), 'runs:\n  using: composite\n  steps:\n    - run: git push\n      shell: bash\n');
    const files = workflowFiles(dir).map((f) => f.slice(dir.length + 1));
    assert.deepEqual(files, [join('.github', 'workflows', 'ci.yml'), join('.github', 'actions', 'publish', 'action.yml')]);
    // A composite action has no trigger of its own, so it is read as one that can run on master.
    assert.deepEqual(checkFiles(workflowFiles(dir), { root: dir }).map((f) => f.line), [4]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the command exits 1 and names the file and line of each push to master', () => {
  const file = join(fixtures, 'refused', 'registry-retry.yml');
  const result = run(['--root', dirname(file), file]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`registry-retry\\.yml:${marked(file)[0]}: git push HEAD:\\$GITHUB_REF pushes the branch the run is on`));
  assert.match(result.stdout, /^1 push to master in 1 workflow file\.$/m);
});

test('the command writes a GitHub error annotation for each finding when it runs in Actions', () => {
  const file = join(fixtures, 'refused', 'push-actions.yml');
  const result = run(['--root', dirname(file), file], { GITHUB_ACTIONS: 'true' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const annotations = result.stdout.split('\n').filter((line) => line.startsWith('::error file='));
  assert.equal(annotations.length, marked(file).length);
  assert.match(annotations[0], /^::error file=[^,]*push-actions\.yml,line=\d+::peaceiris\/actions-gh-pages@v4 pushes to master \(publish_branch\)/);
});

test('the command exits 0 on workflows that push only elsewhere', () => {
  const result = run(['--root', join(fixtures, 'allowed'), ...yamlIn(join(fixtures, 'allowed'))]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /none pushes to master\.$/m);
});

test('the command exits 2 when it finds no workflow to read', () => {
  const result = run(['--root', join(fixtures, 'allowed')]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /no workflow files under/);
});

test('the command exits 2 on an unknown option', () => {
  const result = run(['--fix']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option --fix/);
});
