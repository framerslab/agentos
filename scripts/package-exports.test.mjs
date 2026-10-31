import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'));
const require = createRequire(import.meta.url);

test('package exports only point at shipped files', () => {
  const missing = [];

  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const entries = typeof target === 'string' ? [target] : Object.values(target);
    for (const entry of entries) {
      if (typeof entry !== 'string') {
        continue;
      }
      if (entry.includes('*')) {
        continue;
      }
      if (entry === './package.json') {
        continue;
      }
      const absolutePath = resolve(pkgRoot, entry);
      if (!existsSync(absolutePath)) {
        missing.push(`${subpath} -> ${entry}`);
      }
    }
  }

  assert.deepEqual(missing, []);
});

test('the built declarations resolve their own relative imports under NodeNext', () => {
  // A relative import without its file's extension does not resolve under NodeNext: a consumer that checks the
  // declarations it reads (no skipLibCheck) gets TS2834 or TS2835 for each one. The consumer sits inside the repository,
  // so @framers/agentos resolves to this checkout's build through its exports, as an installed copy does. Other
  // diagnostics in the declarations are not this check's.
  const work = mkdtempSync(resolve(pkgRoot, '.declarations-consumer-'));
  try {
    writeFileSync(resolve(work, 'package.json'), JSON.stringify({ name: 'declarations-consumer', private: true, type: 'module' }));
    writeFileSync(
      resolve(work, 'consumer.ts'),
      [
        "import type { ToolExecutionContext } from '@framers/agentos';",
        "import type { EmergentConfig } from '@framers/agentos/cognition/emergent';",
        'type IsAny<T> = 0 extends 1 & T ? true : false;',
        "export const userContextIsTyped: IsAny<ToolExecutionContext['userContext']> = false;",
        'export type Config = EmergentConfig;',
        '',
      ].join('\n'),
    );
    let output = '';
    try {
      output = execFileSync(
        process.execPath,
        [require.resolve('typescript/bin/tsc'), '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict',
          '--noEmit', '--types', 'node', 'consumer.ts'],
        { cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (error) {
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
    const extensionless = output.split('\n').filter((line) => /error TS283[45]:/.test(line));
    assert.deepEqual(extensionless.slice(0, 20), [], `${extensionless.length} relative imports in the built declarations name no file`);
    assert.doesNotMatch(output, /consumer\.ts\(/, 'the consumer itself compiles');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
