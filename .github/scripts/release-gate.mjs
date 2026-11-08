#!/usr/bin/env node
// Decides whether master holds a change to release since the last release tag, before the daily
// release installs anything. A commit counts when its message carries a type release.config.js
// releases (or a breaking-change marker) and it changes a file the package ships or a file the
// build turns into one. Merge commits count through the commits they bring in, as semantic-release
// reads them. The decision errs towards releasing: semantic-release reads the same commits again
// and publishes nothing when none of them releases.
//
// FORCE=true skips the check. The result goes to $GITHUB_OUTPUT as releasable=true|false, and the
// reason to the log and the run's summary. It needs git and node only.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The files the build reads to make what ships, besides the package's own files: `build` compiles
// src/ with tsconfig.build.json (which extends tsconfig.json) and rewrites the imports with
// fix-esm-imports.mjs; `prepublishOnly` writes knowledge/ with build-knowledge-corpus.mjs; the
// release job writes .github/badges/tests.json with update-test-badge.mjs. A dependency change
// counts through package.json or the lockfile, so a `fix(deps)` commit releases.
export const BUILD_INPUTS = [
  'src',
  'tsconfig.json',
  'tsconfig.build.json',
  'scripts/fix-esm-imports.mjs',
  'scripts/build-knowledge-corpus.mjs',
  'scripts/update-test-badge.mjs',
  'pnpm-lock.yaml',
];

// The conventionalcommits preset's header and revert patterns, and the line a breaking-change note
// starts with (conventional-commits-parser 6: `^(?:\*\s+)?(<keywords>):\s*(.*)`, case-insensitive).
const HEADER = /^(\w*)(?:\((.*)\))?(!?): (.*)$/;
const REVERT = /^(?:Revert|revert:)\s"?([\s\S]+?)"?\s*This reverts commit (\w*)\./i;
const DEFAULT_NOTE_KEYWORDS = ['BREAKING CHANGE', 'BREAKING-CHANGE'];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a repository path is a test, which the build leaves out of dist. */
export function isTestPath(path) {
  return /(^|\/)__tests__\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

/** Whether a change to `path` changes what the package publishes. */
export function ships(path, pkg) {
  if (isTestPath(path)) return false;
  if (path === 'package.json') return true;
  // npm packs these whatever "files" says.
  if (/^(README|LICEN[CS]E)(\.[^/]*)?$/i.test(path)) return true;
  if (pkg.main && path === pkg.main.replace(/^\.\//, '')) return true;
  const roots = [...(pkg.files ?? []), ...BUILD_INPUTS].map((entry) => entry.replace(/^\.\//, '').replace(/\/$/, ''));
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/** The commit types release.config.js releases, and its breaking-change note keywords. */
export function releaseRulesOf(config) {
  const analyzer = config.plugins.find((p) => (Array.isArray(p) ? p[0] : p) === '@semantic-release/commit-analyzer');
  const options = Array.isArray(analyzer) ? (analyzer[1] ?? {}) : {};
  const types = new Set(
    (options.releaseRules ?? []).filter((rule) => rule.type && rule.release).map((rule) => rule.type),
  );
  // commit-analyzer falls back to its own rules for a commit no configured rule matches.
  for (const type of ['feat', 'fix', 'perf', 'revert']) types.add(type);
  const noteKeywords = options.parserOpts?.noteKeywords ?? DEFAULT_NOTE_KEYWORDS;
  return { types, noteKeywords };
}

/** How a commit message releases: a type, `!`, or a breaking-change note; null when it does not. */
export function releaseReason(message, { types, noteKeywords }) {
  const [header = '', ...rest] = message.split('\n');
  const notes = new RegExp(`^(?:\\*\\s+)?(${noteKeywords.map(escape).join('|')}):\\s*`, 'i');
  if (rest.some((line) => notes.test(line))) return 'breaking-change note';
  // git's `Revert "<header>"` message; commit-analyzer's own rules release a revert as a patch.
  if (REVERT.test(message)) return 'revert';
  const match = HEADER.exec(header);
  if (!match) return null;
  if (match[3] === '!') return `${match[1]}!`;
  return types.has(match[1]) ? match[1] : null;
}

/** The newest release tag reachable from HEAD, by version, or '' when there is none. */
export function lastReleaseTag(git, tagFormat) {
  const [prefix, suffix = ''] = tagFormat.split('${version}');
  const pattern = new RegExp(`^${escape(prefix)}(\\d+)\\.(\\d+)\\.(\\d+)${escape(suffix)}$`);
  const tags = git('tag', '--merged', 'HEAD')
    .split('\n')
    .map((tag) => [tag, pattern.exec(tag.trim())])
    .filter(([, match]) => match)
    .map(([tag, match]) => ({ tag: tag.trim(), version: match.slice(1, 4).map(Number) }));
  tags.sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2]);
  return tags[0]?.tag ?? '';
}

/**
 * Reads the commits after the last release tag and decides.
 * @returns {{ releasable: boolean, reason: string, lastTag: string, commits: number, releasing: Array<{sha: string, header: string, why: string, files: string[]}> }}
 */
export function decide({ cwd, force = false, pkg, config }) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  const lastTag = lastReleaseTag(git, config.tagFormat ?? 'v${version}');
  if (force) {
    return { releasable: true, reason: 'the force input skips the check', lastTag, commits: 0, releasing: [] };
  }
  if (!lastTag) {
    return { releasable: true, reason: 'no release tag is reachable from master', lastTag, commits: 0, releasing: [] };
  }
  const rules = releaseRulesOf(config);
  const shas = git('rev-list', `${lastTag}..HEAD`).split('\n').filter(Boolean);
  const releasing = [];
  for (const sha of shas) {
    const message = git('log', '-1', '--format=%B', sha);
    const why = releaseReason(message, rules);
    if (!why) continue;
    const parent = git('rev-list', '--parents', '-n', '1', sha).split(' ')[1];
    // A merge commit's own change is the one its first parent lacks.
    const changed = parent
      ? git('diff-tree', '-r', '--no-commit-id', '--name-only', '--no-renames', parent, sha)
      : git('ls-tree', '-r', '--name-only', sha);
    const files = changed.split('\n').filter((path) => path && ships(path, pkg));
    if (files.length) releasing.push({ sha, header: message.split('\n')[0], why, files });
  }
  const reason = releasing.length
    ? `${releasing.length} of ${shas.length} commits since ${lastTag} release and change what the package ships`
    : `none of the ${shas.length} commits since ${lastTag} both carries a releasing type and changes what the package ships`;
  return { releasable: releasing.length > 0, reason, lastTag, commits: shas.length, releasing };
}

async function main() {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const { default: config } = await import(pathToFileURL(resolve(root, 'release.config.js')).href);
  const result = decide({ cwd: root, force: process.env.FORCE === 'true', pkg, config });
  const lines = [`Releasable: ${result.releasable ? 'yes' : 'no'}. ${result.reason}.`];
  for (const commit of result.releasing) {
    lines.push(`- ${commit.sha.slice(0, 7)} ${commit.header} (${commit.why}): ${commit.files.slice(0, 5).join(', ')}${commit.files.length > 5 ? `, and ${commit.files.length - 5} more` : ''}`);
  }
  console.log(lines.join('\n'));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `releasable=${result.releasable}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
