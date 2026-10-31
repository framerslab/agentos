// @ts-check
// Runs in CI (node --test).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { conflictTag } from './drop-unpublished-release-tag.mjs';

const script = fileURLToPath(new URL('./drop-unpublished-release-tag.mjs', import.meta.url));

const UUID = '108e9186e8c5677a8db39c7fde3c93014f003d52dd798931d8b898c3a0dcded186a5a1f93ef4aba3';

/**
 * semantic-release's output in Release run 41126134054 (30 October 2026), cut to its release lines and npm's error: it
 * pushed v0.15.53, then npm publish failed on the transparency log's 409.
 * @param {string[]} failure npm's error lines
 */
const run = (failure) =>
  [
    '[8:50:03 PM] [semantic-release] › ℹ  Found git tag v0.15.52 associated with version 0.15.52 on branch master',
    '[8:50:03 PM] [semantic-release] › ℹ  Found 2 commits since last release',
    '[8:50:03 PM] [semantic-release] › ℹ  The next release version is 0.15.53',
    '[8:50:06 PM] [semantic-release] › ✔  Created tag v0.15.53',
    '[8:50:06 PM] [semantic-release] [@semantic-release/npm] › ℹ  Publishing version 0.15.53 to npm registry on dist-tag latest',
    'npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access',
    ...failure,
    '[8:51:50 PM] [semantic-release] › ✘  An error occurred while running semantic-release: ExecaError: Command failed with exit code 1: npm publish',
    '',
  ].join('\n');

const CONFLICT_RUN = run([
  'npm error code TLOG_CREATE_ENTRY_ERROR',
  `npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID ${UUID}`,
  `npm error cause (409) an equivalent entry already exists in the transparency log with UUID ${UUID}`,
]);

// The same output with npm's error lines from Release run 39490192582 (npm 10 had no token): no transparency-log conflict.
const AUTH_RUN = run([
  'npm error code ENEEDAUTH',
  'npm error need auth This command requires you to be logged in to https://registry.npmjs.org/',
  'npm error need auth You need to authorize this machine using `npm adduser`',
]);

// gh and npm as the script calls them. Each records its arguments in STUB_CALLS and answers as the test sets:
// STUB_NPM_VERSIONS is what npm view prints ('' fails the way an unreachable registry does); STUB_RELEASE is 'none'
// (GitHub answers 404), 'published' or 'unreachable' (502). With STUB_MOVE_TAG set, npm view also moves v0.15.53 on
// the remote (STUB_REMOTE) to that commit, as another push between the script's look at the tag and its delete would.
const STUB = String.raw`'use strict';
const { appendFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const [name, ...args] = process.argv.slice(2);
appendFileSync(process.env.STUB_CALLS, [name, ...args].join(' ') + '\n');
function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}
const path = args[args.length - 1];
if (name === 'npm') {
  if (process.env.STUB_MOVE_TAG) {
    execFileSync('git', ['--git-dir', process.env.STUB_REMOTE, 'update-ref', 'refs/tags/v0.15.53', process.env.STUB_MOVE_TAG]);
  }
  if (!process.env.STUB_NPM_VERSIONS) fail('npm error code ECONNRESET');
  process.stdout.write(process.env.STUB_NPM_VERSIONS + '\n');
} else if (path.includes('/releases/tags/')) {
  if (process.env.STUB_RELEASE === 'published') {
    process.stdout.write(JSON.stringify({ tag_name: path.split('/').pop() }) + '\n');
  } else if (process.env.STUB_RELEASE === 'unreachable') {
    fail('gh: Bad Gateway (HTTP 502)');
  } else {
    process.stdout.write('{"message":"Not Found","status":"404"}\n');
    fail('gh: Not Found (HTTP 404)');
  }
} else {
  fail('unexpected call: ' + [name, ...args].join(' '));
}
`;

// The scratch repository commits and tags without an identity or a signing key from the machine's settings.
const GIT_SETTINGS = [
  ...['-c', 'user.name=Release', '-c', 'user.email=release@example.com'],
  ...['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'],
];

/** @type {string[]} */
const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** @param {string} text */
const lines = (text) => text.split('\n').filter(Boolean);

/**
 * A checkout where semantic-release has tagged HEAD v0.15.53, one commit after v0.15.52, and pushed both tags to origin,
 * a bare repository beside it; and a directory with the gh and npm stand-ins.
 */
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), 'drop-release-tag-'));
  made.push(dir);
  const repo = join(dir, 'repo');
  const remote = join(dir, 'remote.git');
  const bin = join(dir, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  /** @param {...string} args */
  const git = (...args) => {
    const result = spawnSync('git', [...GIT_SETTINGS, ...args], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet', '--bare', remote);
  git('init', '--quiet');
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: '@framers/agentos', version: '0.0.0-development' })}\n`);
  git('add', 'package.json');
  git('commit', '--quiet', '--message', 'chore: start');
  git('tag', 'v0.15.52');
  git('commit', '--quiet', '--allow-empty', '--message', 'fix: a fix');
  git('tag', 'v0.15.53');
  git('remote', 'add', 'origin', remote);
  git('push', '--quiet', 'origin', 'refs/tags/v0.15.52', 'refs/tags/v0.15.53');
  writeFileSync(join(bin, 'stub.cjs'), STUB);
  for (const name of ['gh', 'npm']) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${join(bin, 'stub.cjs')}' ${name} "$@"\n`);
    chmodSync(path, 0o755);
  }
  return {
    dir,
    repo,
    remote,
    bin,
    head: git('rev-parse', 'HEAD'),
    first: git('rev-parse', 'v0.15.52'),
    git,
    tags: () => lines(git('tag', '--list')),
    /** Each tag on origin with the commit it points at. */
    remoteTags: () => lines(git('--git-dir', remote, 'for-each-ref', '--format=%(refname:strip=2) %(objectname)', 'refs/tags')),
  };
}

/**
 * Runs the script in the checkout on a run's output, with the stand-ins first on PATH.
 * @param {ReturnType<typeof checkout>} at
 * @param {string} output
 * @param {Record<string, string>} [stubs]
 */
function drop(at, output, stubs = {}) {
  const file = join(at.dir, 'semantic-release.log');
  const calls = join(at.dir, 'calls.log');
  writeFileSync(file, output);
  writeFileSync(calls, '');
  const result = spawnSync(process.execPath, [script, file], {
    cwd: at.repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${at.bin}${delimiter}${process.env.PATH}`,
      GITHUB_REPOSITORY: 'framerslab/agentos',
      STUB_CALLS: calls,
      STUB_REMOTE: at.remote,
      STUB_NPM_VERSIONS: JSON.stringify(['0.15.51', '0.15.52']),
      STUB_RELEASE: 'none',
      ...stubs,
    },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}`, calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean) };
}

const LOOKUPS = ['npm view @framers/agentos versions --json --prefer-online', 'gh api repos/framerslab/agentos/releases/tags/v0.15.53'];

describe('drop-unpublished-release-tag.mjs', () => {
  test('deletes the tag a transparency-log conflict left, on origin and in the checkout (run 41126134054)', () => {
    const at = checkout();
    const result = drop(at, CONFLICT_RUN);
    assert.equal(result.status, 0, result.out);
    assert.deepEqual(result.calls, LOOKUPS);
    assert.deepEqual(at.remoteTags(), [`v0.15.52 ${at.first}`]);
    assert.deepEqual(at.tags(), ['v0.15.52']);
  });

  test('leaves the tags after any other publish failure', () => {
    const at = checkout();
    const result = drop(at, AUTH_RUN);
    assert.equal(result.status, 1, result.out);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(at.remoteTags(), [`v0.15.52 ${at.first}`, `v0.15.53 ${at.head}`]);
    assert.deepEqual(at.tags(), ['v0.15.52', 'v0.15.53']);
  });

  test('leaves a tag that points at another commit on origin', () => {
    const at = checkout();
    at.git('--git-dir', at.remote, 'update-ref', 'refs/tags/v0.15.53', at.first);
    const result = drop(at, CONFLICT_RUN);
    assert.equal(result.status, 1, result.out);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(at.remoteTags(), [`v0.15.52 ${at.first}`, `v0.15.53 ${at.first}`]);
    assert.deepEqual(at.tags(), ['v0.15.52', 'v0.15.53']);
  });

  test('leaves a tag another push moves after the script looked at it', () => {
    const at = checkout();
    const result = drop(at, CONFLICT_RUN, { STUB_MOVE_TAG: at.first });
    assert.equal(result.status, 1, result.out);
    assert.deepEqual(result.calls, LOOKUPS);
    assert.deepEqual(at.remoteTags(), [`v0.15.52 ${at.first}`, `v0.15.53 ${at.first}`]);
    assert.deepEqual(at.tags(), ['v0.15.52', 'v0.15.53']);
  });

  test('leaves a tag whose version npm has', () => {
    const at = checkout();
    const result = drop(at, CONFLICT_RUN, { STUB_NPM_VERSIONS: JSON.stringify(['0.15.52', '0.15.53']) });
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /npm has @framers\/agentos@0\.15\.53/);
    assert.deepEqual(result.calls, LOOKUPS.slice(0, 1));
    assert.deepEqual(at.remoteTags(), [`v0.15.52 ${at.first}`, `v0.15.53 ${at.head}`]);
    assert.deepEqual(at.tags(), ['v0.15.52', 'v0.15.53']);
  });

  test('leaves a tag GitHub has a release for', () => {
    const at = checkout();
    const result = drop(at, CONFLICT_RUN, { STUB_RELEASE: 'published' });
    assert.equal(result.status, 1, result.out);
    assert.deepEqual(result.calls, LOOKUPS);
    assert.deepEqual(at.remoteTags(), [`v0.15.52 ${at.first}`, `v0.15.53 ${at.head}`]);
    assert.deepEqual(at.tags(), ['v0.15.52', 'v0.15.53']);
  });

  test('leaves the tags when npm or GitHub cannot be read', () => {
    for (const [stubs, calls] of /** @type {const} */ ([
      [{ STUB_NPM_VERSIONS: '' }, LOOKUPS.slice(0, 1)],
      [{ STUB_RELEASE: 'unreachable' }, LOOKUPS],
    ])) {
      const at = checkout();
      const result = drop(at, CONFLICT_RUN, stubs);
      assert.equal(result.status, 1, result.out);
      assert.deepEqual(result.calls, calls);
      assert.deepEqual(at.remoteTags(), [`v0.15.52 ${at.first}`, `v0.15.53 ${at.head}`]);
      assert.deepEqual(at.tags(), ['v0.15.52', 'v0.15.53']);
    }
  });

  test('exits 2 without the output file', () => {
    assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 2);
  });
});

describe('conflictTag', () => {
  test('reads the tag and the version from the conflict run', () => {
    assert.deepEqual(conflictTag(CONFLICT_RUN), { tag: 'v0.15.53', version: '0.15.53' });
  });

  test('reads only a conflict that follows the one tag the run created', () => {
    assert.ok('reason' in conflictTag(AUTH_RUN));
    assert.ok('reason' in conflictTag(CONFLICT_RUN.replace('Created tag v0.15.53', 'Skip v0.15.53 tag creation in dry-run mode')));
    assert.ok('reason' in conflictTag(`[8:40:00 PM] [semantic-release] › ✔  Created tag v0.15.52\n${CONFLICT_RUN}`));
    assert.ok('reason' in conflictTag(`npm error code TLOG_CREATE_ENTRY_ERROR\n${AUTH_RUN}`));
  });
});
