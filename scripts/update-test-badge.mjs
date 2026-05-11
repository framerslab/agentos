#!/usr/bin/env node
/**
 * Update .github/badges/tests.json with the current test signature count.
 *
 * Counts `it(`, `test(`, and `bench(` invocations across every *.test.ts and
 * *.spec.ts file in src/ and tests/. Writes a shields.io endpoint badge JSON
 * that the README references. Runs in release.yml before semantic-release so
 * the resulting JSON is included in the version-bump commit's `assets`.
 *
 * Counting strategy: grep test-signature lines instead of executing the
 * suite. Faster (sub-second vs minutes) and avoids needing API keys / DB
 * fixtures in the release job. The regex's negative lookahead excludes
 * `.skip`, `.todo`, and `.fails` modifiers so only active tests count.
 * The badge label is "tests" rather than "tests passed" because we
 * don't actually run the suite — we just count what's defined.
 *
 * Usage: node scripts/update-test-badge.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname } from 'node:path';

const BADGE_PATH = '.github/badges/tests.json';

// Find every test file under src/ and tests/.
const files = execSync(
  `find src tests -type f \\( -name "*.test.ts" -o -name "*.spec.ts" \\) 2>/dev/null`,
  { encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean);

// Count test signatures. Match `it(`, `test(`, `bench(` at the start of a
// line (preceded by whitespace only). Skip `.skip`, `.todo`, `.fails`
// modifiers — those don't run.
const PATTERN = /^\s*(it|test|bench)(?!\.(skip|todo|fails))\s*\(/;

let count = 0;
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (PATTERN.test(line)) count++;
  }
}

// Round down to nearest 100 + add "+" suffix so the badge doesn't churn
// on every single test added.
const rounded = Math.floor(count / 100) * 100;
const formatted = rounded.toLocaleString('en-US') + '+';

const badge = {
  schemaVersion: 1,
  label: 'tests',
  message: formatted,
  color: '#2ea043',
};

mkdirSync(dirname(BADGE_PATH), { recursive: true });
writeFileSync(BADGE_PATH, JSON.stringify(badge, null, 2) + '\n');

console.log(`Updated ${BADGE_PATH}: ${formatted} (raw count: ${count})`);
