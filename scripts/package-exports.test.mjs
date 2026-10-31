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
  // A relative import without its file's extension does not resolve under NodeNext: a consumer that checks libraries
  // fails on it, and one that skips them reads every type behind it as any. The consumer sits inside the repository, so
  // @framers/agentos resolves to this checkout's build through its exports, as an installed copy does.
  const work = mkdtempSync(resolve(pkgRoot, '.declarations-consumer-'));
  try {
    writeFileSync(resolve(work, 'package.json'), JSON.stringify({ name: 'declarations-consumer', private: true, type: 'module' }));
    writeFileSync(
      resolve(work, 'consumer.ts'),
      [
        "import type { ToolExecutionContext } from '@framers/agentos';",
        'type IsAny<T> = 0 extends 1 & T ? true : false;',
        // ToolExecutionContext comes through the root's re-export of core/tools/ITool, and its user context through
        // ITool's import of cognition/substrate/IGMI.
        "export const toolContextIsTyped: IsAny<ToolExecutionContext> = false;",
        "export const userContextIsTyped: IsAny<ToolExecutionContext['userContext']> = false;",
        '',
      ].join('\n'),
    );
    try {
      execFileSync(
        process.execPath,
        [require.resolve('typescript/bin/tsc'), '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict',
          '--skipLibCheck', '--noEmit', '--types', 'node', 'consumer.ts'],
        { cwd: work, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      );
    } catch (error) {
      assert.fail(`the consumer does not compile against the built declarations:\n${error.stdout ?? ''}${error.stderr ?? ''}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
