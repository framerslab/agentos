// Installs the package into an empty project and runs scripts/fixtures/transcription-consumer.ts against it. A pull
// request or a push packs the candidate built in the workspace; a run dispatched on a release tag downloads that exact
// version from the registry and checks its tarball against the registry's integrity first. Runs on GitHub Actions only
// (.github/workflows/transcription-package.yml); the registry is read anonymously.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'package acceptance runs only in GitHub Actions');
const root = process.env.GITHUB_WORKSPACE;
assert.ok(root, 'workspace required');
const repo = root;
const require = createRequire(resolve(repo, 'package.json'));
const pkg = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')) as { name: string; version: string };
assert.equal(pkg.name, '@framers/agentos');
const mode = process.env.TRANSCRIPTION_PACKAGE_SOURCE;
assert.ok(mode === 'candidate' || mode === 'published', 'TRANSCRIPTION_PACKAGE_SOURCE is candidate or published');

function command(binary: string, args: string[], cwd: string): string {
  return execFileSync(binary, args, { cwd, encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } });
}
/** One entry of `npm pack --json`. */
interface Packed { name: string; version: string; filename: string; integrity: string }
const work = mkdtempSync(resolve(tmpdir(), 'transcription-package-'));
try {
  let metadata: { name: string; version: string; dist: { integrity: string; shasum: string } } | undefined;
  let packed: Packed[];
  if (mode === 'published') {
    assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
    assert.equal(process.env.GITHUB_REF, `refs/tags/v${pkg.version}`);
    metadata = JSON.parse(command('npm', ['view', `${pkg.name}@${pkg.version}`, '--json'], work));
    assert.ok(metadata);
    assert.equal(metadata.name, pkg.name); assert.equal(metadata.version, pkg.version);
    assert.match(metadata.dist.integrity, /^sha512-/);
    packed = JSON.parse(command('npm', ['pack', `${pkg.name}@${pkg.version}`, '--ignore-scripts', '--json',
      '--pack-destination', work], work));
  } else {
    packed = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], repo));
  }
  assert.equal(packed.length, 1);
  const archive = packed[0]!;
  assert.equal(archive.name, pkg.name); assert.equal(archive.version, pkg.version);
  assert.equal(archive.filename.includes('/'), false);
  const tarball = resolve(work, archive.filename);
  const integrity = 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64');
  assert.equal(integrity, archive.integrity);
  if (metadata) assert.equal(integrity, metadata.dist.integrity);

  const consumer = resolve(work, 'consumer'); mkdirSync(consumer);
  writeFileSync(resolve(consumer, 'package.json'), JSON.stringify({ name: 'transcription-consumer', private: true, type: 'module' }));
  const nodeTypes = require('@types/node/package.json') as { version: string };
  command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--omit=optional',
    tarball, `@types/node@${nodeTypes.version}`], consumer);
  const installed = JSON.parse(readFileSync(resolve(consumer, 'node_modules/@framers/agentos/package.json'), 'utf8')) as
    { name: string; version: string; exports: Record<string, unknown> };
  assert.equal(installed.name, pkg.name); assert.equal(installed.version, pkg.version);
  for (const entry of ['./io/voice-pipeline', './safety/runtime']) assert.ok(installed.exports[entry], entry);
  writeFileSync(resolve(consumer, 'consumer.ts'), readFileSync(resolve(repo, 'scripts/fixtures/transcription-consumer.ts')));
  command(process.execPath, [require.resolve('typescript/bin/tsc'), '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck', '--esModuleInterop', '--types', 'node',
    '--outDir', 'compiled', 'consumer.ts'], consumer);
  const output = command(process.execPath, ['compiled/consumer.js'], consumer);
  assert.ok(output.includes('installed transcription contracts pass'));
  console.log(output.trim());

  const report = { package: pkg.name, version: pkg.version, source: mode, integrity,
    commit: process.env.GITHUB_SHA, ref: process.env.GITHUB_REF, runId: process.env.GITHUB_RUN_ID,
    exports: ['./io/voice-pipeline', './safety/runtime'], result: 'pass' };
  writeFileSync(resolve(repo, 'transcription-package-evidence.json'), JSON.stringify(report, null, 2) + '\n');
} finally { rmSync(work, { recursive: true, force: true }); }
