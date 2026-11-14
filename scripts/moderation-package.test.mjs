// Installs @framers/agentos into an empty project and runs scripts/fixtures/moderation-consumer.ts against it: the
// moderation surface reached as an application reaches it, through the package's public entry points, compiled against
// the installed declarations alone under NodeNext with strict on. With AGENTOS_PUBLISHED_VERSION unset the package is
// this checkout's packed candidate (ci.yml, "The moderation entry points run from the packed package"). With it set,
// the package is that exact version from the registry (moderation-published.yml), so the same fixture proves a
// release. Runs on GitHub Actions only, after the build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const require = createRequire(import.meta.url);
const published = process.env.AGENTOS_PUBLISHED_VERSION ?? '';

/** Runs a command; a failure carries its standard output too, where tsc writes its diagnostics and the consumer its items. */
function command(binary, args, cwd) {
  try {
    return execFileSync(binary, args, { cwd, encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } });
  } catch (error) {
    throw new Error(`${[binary, ...args].join(' ')} failed in ${cwd}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error });
  }
}

test('the moderation entry points install, compile and run as an application imports them', { skip: !process.env.CI, timeout: 600000 }, () => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  if (published) assert.match(published, /^\d+\.\d+\.\d+$/);
  const work = mkdtempSync(resolve(tmpdir(), 'moderation-package-'));
  try {
    let source = `${pkg.name}@${published}`;
    if (!published) {
      const packed = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], root));
      assert.equal(packed.length, 1); assert.equal(packed[0].name, pkg.name);
      source = resolve(work, packed[0].filename);
    }
    const consumer = resolve(work, 'consumer'); mkdirSync(consumer);
    writeFileSync(resolve(consumer, 'package.json'), JSON.stringify({ name: 'moderation-consumer', private: true, type: 'module' }));
    command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--omit=optional',
      source, `@types/node@${require('@types/node/package.json').version}`], consumer);
    const installed = JSON.parse(readFileSync(resolve(consumer, 'node_modules/@framers/agentos/package.json'), 'utf8'));
    assert.equal(installed.name, pkg.name);
    if (published) assert.equal(installed.version, published);

    writeFileSync(resolve(consumer, 'consumer.ts'), readFileSync(resolve(root, 'scripts/fixtures/moderation-consumer.ts')));
    command(process.execPath, [require.resolve('typescript/bin/tsc'), '--target', 'ES2022', '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck', '--esModuleInterop', '--types', 'node',
      '--outDir', 'compiled', 'consumer.ts'], consumer);
    const output = command(process.execPath, ['compiled/consumer.js'], consumer);
    console.log(output.trim());
    assert.match(output, /^installed moderation surface passes: \d+ items$/m);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
