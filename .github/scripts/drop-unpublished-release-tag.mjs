#!/usr/bin/env node
// @ts-check
/**
 * Deletes the release tag a failed semantic-release run pushed, when npm publish failed on a transparency-log conflict
 * and the version reached neither npm nor GitHub, so that release.yml can run semantic-release again.
 *
 * npm publish --provenance records its provenance statement in Sigstore's transparency log (Rekor) before it uploads the
 * package. When Rekor records the entry and its reply does not reach npm in time, sigstore-js sends the same entry again
 * (it retries a network error, a timeout, a 408, a 429 and a 5xx), Rekor answers the retry with 409 "an equivalent entry
 * already exists in the transparency log", and npm fails with TLOG_CREATE_ENTRY_ERROR. sigstore-js can fetch the
 * existing entry instead, but the sigstore client npm bundles turns that off (fetchOnConflict: false in its config.js:
 * sigstore 4.1.1 in npm 11.20.0 and 11.21.1, sigstore 5.0.0 in npm 12.2.1); see https://github.com/npm/cli/issues/10078
 * and https://github.com/sigstore/sigstore-js/issues/1708. semantic-release 25 pushes the release tag before its publish
 * step, so the tag stays while the version is on neither npm nor GitHub, and the next run finds no commits after it:
 * Release runs 41126134054 (v0.15.53) and 41131650556 (v0.15.54) on 30 October 2026, whose own entries Rekor holds at
 * log indexes 3602391320 and 3603223018. Another attempt signs with a new certificate, so its entry is a new one.
 *
 * The script reads the failed run's output and deletes the tag only when
 * - TLOG_CREATE_ENTRY_ERROR comes after the one "Created tag v<version>" line in it,
 * - the tag on origin points at the checked-out commit,
 * - npm has no such version of the package in ./package.json, and
 * - GitHub has no release for the tag.
 * It deletes the tag on origin with git push --force-with-lease against the checked-out commit, so a tag another push
 * moved after the check stays, and then in the checkout, where semantic-release's git fetch --tags would keep it. The
 * release checkout keeps no credentials, so git gets the job's token in its environment, as the Authorization header
 * actions/checkout sends. No GitHub API makes the release lookup and the delete one step; release.yml's concurrency
 * group keeps every other release run out of the moment between them.
 *
 * Usage: node .github/scripts/drop-unpublished-release-tag.mjs <file holding semantic-release's output>
 * GITHUB_REPOSITORY names the repository as owner/name; git and gh read the token from GITHUB_TOKEN or GH_TOKEN. Exit
 * status: 0 when it deleted the tag (run semantic-release again), 1 when it left the tags as they were, 2 on a usage or
 * read error.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = "Usage: node .github/scripts/drop-unpublished-release-tag.mjs <file holding semantic-release's output>";
const CONFLICT = 'TLOG_CREATE_ENTRY_ERROR';
const CREATED_TAG = /Created tag (\S+)/g;
const VERSION_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/**
 * The tag a semantic-release run pushed before npm publish failed on a transparency-log conflict, read from the run's
 * output.
 * @param {string} output semantic-release's output, standard output and standard error together
 * @returns {{ tag: string, version: string } | { reason: string }}
 */
export function conflictTag(output) {
  const conflict = output.lastIndexOf(CONFLICT);
  if (conflict === -1) return { reason: `the run did not fail with ${CONFLICT}` };
  const created = [...output.matchAll(CREATED_TAG)];
  const tags = [...new Set(created.map((match) => match[1]))];
  if (tags.length !== 1) return { reason: `the run names ${tags.length} created tags (${tags.join(', ') || 'none'}), not one` };
  if (conflict < (created[0].index ?? 0)) return { reason: `${CONFLICT} came before the run created ${tags[0]}` };
  const version = VERSION_TAG.exec(tags[0])?.[1];
  if (version === undefined) return { reason: `${tags[0]} is not a v<version> tag` };
  return { tag: tags[0], version };
}

/**
 * Runs a command and returns how it ended; its output is returned, not printed.
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { encoding: 'utf8', env });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error ? String(result.error) : ''}`.trim(),
  };
}

/**
 * The environment git runs in: never a password prompt, and with a token, the Authorization header actions/checkout
 * gives git for github.com, set through GIT_CONFIG_COUNT so that the token stays out of the command line.
 */
function gitEnvironment() {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) return env;
  const index = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  env.GIT_CONFIG_COUNT = String(index + 1);
  env[`GIT_CONFIG_KEY_${index}`] = 'http.https://github.com/.extraheader';
  env[`GIT_CONFIG_VALUE_${index}`] = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  return env;
}

/** @param {string} text */
function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Deletes the tag on origin and in the checkout when the version it names reached neither npm nor GitHub.
 * @param {string} repository owner/name
 * @param {{ tag: string, version: string }} release
 * @returns {string | undefined} why the tag stays; undefined once it is deleted
 */
function drop(repository, { tag, version }) {
  const git = gitEnvironment();
  const ref = `refs/tags/${tag}`;
  const head = run('git', ['rev-parse', 'HEAD']);
  if (!head.ok) return `git rev-parse HEAD failed: ${head.stderr}`;
  const commit = head.stdout.trim();
  const remote = run('git', ['ls-remote', 'origin', ref], git);
  if (!remote.ok) return `git ls-remote origin failed: ${remote.stderr}`;
  const tagged = remote.stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .find(([, name]) => name === ref)?.[0];
  if (tagged === undefined) return 'origin has no such tag';
  if (tagged !== commit) return `on origin it points at ${tagged}, not at the checked-out commit ${commit}`;

  /** @type {unknown} */
  let name;
  try {
    name = JSON.parse(readFileSync('package.json', 'utf8')).name;
  } catch (error) {
    return `./package.json cannot be read: ${error instanceof Error ? error.message : error}`;
  }
  if (typeof name !== 'string' || name === '') return './package.json names no package';
  const npm = run('npm', ['view', name, 'versions', '--json', '--prefer-online']);
  if (!npm.ok) return `npm view ${name} failed: ${npm.stderr}`;
  const versions = json(npm.stdout);
  if (!Array.isArray(versions) && typeof versions !== 'string') return `npm view ${name} printed no version list`;
  if ([versions].flat().includes(version)) return `npm has ${name}@${version}`;

  const release = run('gh', ['api', `repos/${repository}/releases/tags/${tag}`]);
  if (release.ok) return 'GitHub has a release for it';
  // gh api prints "gh: Not Found (HTTP 404)", or "gh: HTTP 404" for a body with no message.
  if (!/\bHTTP 404\b/.test(release.stderr)) return `GitHub did not say whether it has a release: ${release.stderr}`;

  // The lease makes the push delete the tag only while origin still has it at the commit checked above.
  const deleted = run('git', ['push', '--quiet', `--force-with-lease=${ref}:${commit}`, 'origin', `:${ref}`], git);
  if (!deleted.ok) return `git push did not delete it on origin: ${deleted.stderr}`;
  const local = run('git', ['tag', '--delete', tag]);
  if (!local.ok) return `it is deleted on origin, but git tag --delete failed: ${local.stderr}`;
  return undefined;
}

/** @param {string[]} argv */
function main(argv) {
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    console.error(USAGE);
    return 2;
  }
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    console.error(`GITHUB_REPOSITORY must name the repository as owner/name.\n${USAGE}`);
    return 2;
  }
  let output;
  try {
    output = readFileSync(argv[0], 'utf8');
  } catch (error) {
    console.error(`${argv[0]} cannot be read: ${error instanceof Error ? error.message : error}`);
    return 2;
  }
  const release = conflictTag(output);
  if ('reason' in release) {
    console.log(`Leaving the tags as they are: ${release.reason}.`);
    return 1;
  }
  const kept = drop(repository, release);
  if (kept !== undefined) {
    console.log(`Leaving ${release.tag}: ${kept}.`);
    return 1;
  }
  const message =
    `npm publish failed with ${CONFLICT} after semantic-release pushed ${release.tag}. The tag is deleted on GitHub and ` +
    `in the checkout (npm and GitHub have no ${release.version}), so semantic-release can run again.`;
  console.log(message);
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning title=Transparency-log conflict::${message}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
