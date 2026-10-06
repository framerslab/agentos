#!/usr/bin/env node
// Runs the commit analyser and the release-notes generator from
// release.config.js over the commits since the last release tag, fed the way
// semantic-release feeds them, so a change to either plugin, to the preset or
// to their configuration is exercised before it reaches master.
//
// semantic-release's own dry run verifies push access to the repository
// before it analyses anything, so it needs a token with write permission;
// this script calls the two plugins directly and needs none. Nothing is
// tagged, published or committed.
import { execFileSync } from 'node:child_process';
import config from '../release.config.js';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const pluginConfig = (name) => {
  const entry = config.plugins.find((p) => (Array.isArray(p) ? p[0] : p) === name);
  if (!entry) throw new Error(`${name} is not in release.config.js`);
  return Array.isArray(entry) ? (entry[1] ?? {}) : {};
};

const { analyzeCommits } = await import('@semantic-release/commit-analyzer');
const { generateNotes } = await import('@semantic-release/release-notes-generator');

const tagFormat = config.tagFormat ?? 'v${version}';
const tagPrefix = tagFormat.split('${version}')[0];
let lastTag = '';
try {
  lastTag = git('describe', '--tags', '--abbrev=0', `--match=${tagPrefix}*`);
} catch {
  lastTag = '';
}

const FIELD = '\u001f';
const RECORD = '\u001e';
const format = ['%H', '%h', '%T', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%s', '%b'].join(FIELD) + RECORD;
const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
const commits = git('log', `--format=${format}`, range)
  .split(RECORD)
  .map((record) => record.trim())
  .filter(Boolean)
  .map((record) => {
    const [long, short, tree, authorName, authorEmail, authorDate, committerName, committerEmail, committerDate, subject, body = ''] =
      record.split(FIELD);
    return {
      commit: { long, short },
      tree: { long: tree, short: tree.slice(0, 7) },
      author: { name: authorName, email: authorEmail, date: authorDate },
      committer: { name: committerName, email: committerEmail, date: committerDate },
      subject,
      body,
      hash: long,
      message: body ? `${subject}\n\n${body}` : subject,
      committerDate,
    };
  });

const say = (...parts) => console.log('[release dry run]', ...parts);
const logger = { log: say, error: say, warn: say, success: say };
const lastRelease = lastTag
  ? { gitTag: lastTag, gitHead: git('rev-list', '-n', '1', lastTag), version: lastTag.slice(tagPrefix.length) }
  : {};
const context = {
  cwd: process.cwd(),
  env: process.env,
  logger,
  commits,
  lastRelease,
  options: { repositoryUrl: config.repositoryUrl, tagFormat },
};

const type = await analyzeCommits(pluginConfig('@semantic-release/commit-analyzer'), context);
say(`${commits.length} commits since ${lastTag || 'the first commit'}; release type: ${type ?? 'none'}`);

const bump = (version, releaseType) => {
  const [major, minor, patch] = version.split('.').map(Number);
  if (releaseType === 'major') return `${major + 1}.0.0`;
  if (releaseType === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};
const nextVersion = bump(lastRelease.version ?? '0.0.0', type ?? 'patch');
const notes = await generateNotes(pluginConfig('@semantic-release/release-notes-generator'), {
  ...context,
  nextRelease: { type: type ?? 'patch', version: nextVersion, gitTag: `${tagPrefix}${nextVersion}`, gitHead: git('rev-parse', 'HEAD') },
});
say(`notes for ${nextVersion}${type ? '' : ' (no release would be cut; the notes are generated to exercise the writer)'}:`);
console.log(notes);
