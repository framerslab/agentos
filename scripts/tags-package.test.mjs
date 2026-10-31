// Installs the packed candidate into an empty project and runs scripts/fixtures/tags-consumer.ts against it: the tags
// module reached as an application reaches it, through @framers/agentos/cognition/library/tags, compiled against the
// installed declarations alone under NodeNext with strict on, and run with network access refused. Runs on GitHub
// Actions only, after the build (ci.yml, "The tags module runs from the packed package").
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

/** Runs a command; a failure carries its standard output too, where tsc writes its diagnostics and the consumer its items. */
function command(binary, args, cwd) {
  try {
    return execFileSync(binary, args, { cwd, encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } });
  } catch (error) {
    throw new Error(`${[binary, ...args].join(' ')} failed in ${cwd}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error });
  }
}

test('the packed tags module installs, compiles and runs as an application imports it', { skip: !process.env.CI, timeout: 600000 }, () => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const work = mkdtempSync(resolve(tmpdir(), 'tags-package-'));
  try {
    const packed = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], root));
    assert.equal(packed.length, 1); assert.equal(packed[0].name, pkg.name); assert.equal(packed[0].version, pkg.version);
    const shipped = new Set(packed[0].files.map((file) => file.path));
    for (const file of ['dist/cognition/library/tags.js', 'dist/cognition/library/tags.d.ts']) assert.ok(shipped.has(file), `${file} is not in the tarball`);

    const consumer = resolve(work, 'consumer'); mkdirSync(consumer);
    writeFileSync(resolve(consumer, 'package.json'), JSON.stringify({ name: 'tags-consumer', private: true, type: 'module' }));
    command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--omit=optional',
      resolve(work, packed[0].filename), `@types/node@${require('@types/node/package.json').version}`], consumer);
    const installed = JSON.parse(readFileSync(resolve(consumer, 'node_modules/@framers/agentos/package.json'), 'utf8'));
    assert.equal(installed.name, pkg.name); assert.equal(installed.version, pkg.version);

    writeFileSync(resolve(consumer, 'consumer.ts'), readFileSync(resolve(root, 'scripts/fixtures/tags-consumer.ts')));
    command(process.execPath, [require.resolve('typescript/bin/tsc'), '--target', 'ES2022', '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck', '--esModuleInterop', '--types', 'node',
      '--outDir', 'compiled', 'consumer.ts'], consumer);
    const output = command(process.execPath, ['compiled/consumer.js'], consumer);
    console.log(output.trim());
    assert.match(output, /^installed tags module passes: \d+ items$/m);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
