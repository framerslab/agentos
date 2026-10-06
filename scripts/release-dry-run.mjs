#!/usr/bin/env node
// Runs semantic-release in dry-run mode on one branch with the commit
// analyser and the release-notes generator from release.config.js, so a
// change to the release tooling or its configuration is exercised before it
// reaches master. Nothing is tagged, published or committed.
import semanticRelease from 'semantic-release';
import config from '../release.config.js';

const branch = process.argv[2] || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
if (!branch) {
  console.error('usage: node scripts/release-dry-run.mjs <branch>');
  process.exit(2);
}

const analysisPlugins = new Set([
  '@semantic-release/commit-analyzer',
  '@semantic-release/release-notes-generator',
]);
const plugins = config.plugins.filter((entry) =>
  analysisPlugins.has(Array.isArray(entry) ? entry[0] : entry),
);
if (plugins.length !== 2) {
  throw new Error(`expected both analysis plugins in release.config.js, found ${plugins.length}`);
}

const result = await semanticRelease(
  { ...config, branches: [branch], plugins, dryRun: true, ci: false },
  { cwd: process.cwd(), env: process.env, stdout: process.stdout, stderr: process.stderr },
);

if (result === false) {
  console.log(`dry run on ${branch}: the commits since the last release call for no new version`);
} else {
  const { type, version } = result.nextRelease;
  console.log(`dry run on ${branch}: a ${type} release, ${version}, would be published`);
}
