import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const require = createRequire(import.meta.url);
function command(binary, args, cwd) {
  return execFileSync(binary, args, { cwd, encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } });
}
function consume(tarball, work) {
  const consumer = resolve(work, 'consumer'); mkdirSync(consumer);
  writeFileSync(resolve(consumer, 'package.json'), JSON.stringify({ name: 'meeting-consumer', private: true, type: 'module' }));
  command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--omit=optional',
    tarball, `@types/node@${require('@types/node/package.json').version}`], consumer);
  const installed = JSON.parse(readFileSync(resolve(consumer, 'node_modules/@framers/agentos/package.json'), 'utf8'));
  assert.equal(installed.name, pkg.name); assert.equal(installed.version, pkg.version);
  for (const entry of ['./io/channels/meetings', './safety/runtime', './safety/egress']) assert.ok(installed.exports[entry], entry);
  writeFileSync(resolve(consumer, 'consumer.ts'), readFileSync(resolve(root, 'src/io/channels/meetings/__tests__/package-consumer.ts')));
  command(process.execPath, [require.resolve('typescript/bin/tsc'), '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck', '--esModuleInterop', '--types', 'node',
    '--outDir', 'compiled', 'consumer.ts'], consumer);
  const output = command(process.execPath, ['compiled/consumer.js'], consumer);
  assert.ok(output.includes('installed meeting contracts pass')); console.log(output.trim());
}
test('candidate meeting package installs independently', { skip: !process.env.CI, timeout: 600000 }, () => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const work = mkdtempSync(resolve(tmpdir(), 'meeting-package-'));
  try {
    const packed = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], root));
    assert.equal(packed.length, 1); assert.equal(packed[0].name, pkg.name); assert.equal(packed[0].version, pkg.version);
    consume(resolve(work, packed[0].filename), work);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
const published = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && (process.env.GITHUB_REF ?? '').startsWith('refs/tags/');
test('exact published meeting package passes the same consumer', { skip: !published, timeout: 600000 }, () => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.GITHUB_REF, `refs/tags/v${pkg.version}`);
  const work = mkdtempSync(resolve(tmpdir(), 'meeting-published-'));
  try {
    const metadata = JSON.parse(command('npm', ['view', `${pkg.name}@${pkg.version}`, '--json'], work));
    assert.equal(metadata.name, pkg.name); assert.equal(metadata.version, pkg.version); assert.match(metadata.dist.integrity, /^sha512-/);
    const packed = JSON.parse(command('npm', ['pack', `${pkg.name}@${pkg.version}`, '--ignore-scripts', '--json', '--pack-destination', work], work));
    assert.equal(packed.length, 1); assert.equal(packed[0].name, pkg.name); assert.equal(packed[0].version, pkg.version);
    const tarball = resolve(work, packed[0].filename);
    assert.equal('sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64'), metadata.dist.integrity);
    consume(tarball, work);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
