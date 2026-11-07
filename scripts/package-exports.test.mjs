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

/**
 * Errors a NodeNext consumer that checks every declaration (no skipLibCheck) meets in a dependency's own
 * declarations, which this package cannot change: each names the file it sits in and its error code.
 */
const DEPENDENCY_DECLARATION_ERRORS = [
  // None. An entry reads
  // { file: /node_modules\/<package>\/<path>\.d\.ts\(/, code: 'TS<n>' }.
];

test('the built declarations resolve their own relative imports under NodeNext', () => {
  // A relative import without its file's extension does not resolve under NodeNext: a consumer that checks the
  // declarations it reads (no skipLibCheck) gets TS2834 or TS2835 for each one. The consumer also reads the learning
  // layer's types at the root and at its subpath, which must be typed and one. The consumer sits inside the repository,
  // so @framers/agentos resolves to this checkout's build through its exports, as an installed copy does. Every other
  // compiler error fails the check too (a compiler that cannot run, a missing type library, an unresolved import),
  // except the errors listed in DEPENDENCY_DECLARATION_ERRORS, which sit in a dependency's own declarations.
  const work = mkdtempSync(resolve(pkgRoot, '.declarations-consumer-'));
  try {
    writeFileSync(resolve(work, 'package.json'), JSON.stringify({ name: 'declarations-consumer', private: true, type: 'module' }));
    writeFileSync(
      resolve(work, 'consumer.ts'),
      [
        "import type { ToolExecutionContext } from '@framers/agentos';",
        "import type { EmergentConfig } from '@framers/agentos/cognition/emergent';",
        "import type { LearningLayerHandle, LearningStore } from '@framers/agentos';",
        "import type { LearningStore as LearningStoreAtSubpath, LedgerEntry } from '@framers/agentos/cognition/learning';",
        'type IsAny<T> = 0 extends 1 & T ? true : false;',
        "export const userContextIsTyped: IsAny<ToolExecutionContext['userContext']> = false;",
        'export type Config = EmergentConfig;',
        // The learning layer's types at the root are the subpath's own.
        'export const storeIsTyped: IsAny<LearningStore> = false;',
        'export const sameStore: [LearningStore] extends [LearningStoreAtSubpath] ? true : false = true;',
        "export const operatorSetIsTyped: [Awaited<ReturnType<LearningLayerHandle['operatorSet']>>] extends [LedgerEntry] ? true : false = true;",
        '',
      ].join('\n'),
    );
    let output = '';
    let exitCode = 0;
    try {
      output = execFileSync(
        process.execPath,
        [require.resolve('typescript/bin/tsc'), '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict',
          '--noEmit', '--types', 'node', 'consumer.ts'],
        { cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (error) {
      exitCode = typeof error.status === 'number' ? error.status : 1;
      output = `${error.stdout ?? ''}${error.stderr ?? ''}${error.status == null ? String(error.message ?? error) : ''}`;
    }
    const extensionless = output.split('\n').filter((line) => /error TS283[45]:/.test(line));
    assert.deepEqual(extensionless.slice(0, 20), [], `${extensionless.length} relative imports in the built declarations name no file`);
    assert.doesNotMatch(output, /consumer\.ts\(/, 'the consumer itself compiles');
    const errors = output.split('\n').filter((line) => /error TS\d+:/.test(line));
    const unlisted = errors.filter(
      (line) => !DEPENDENCY_DECLARATION_ERRORS.some(({ file, code }) => file.test(line) && line.includes(`error ${code}:`)),
    );
    assert.deepEqual(unlisted.slice(0, 20), [], `${unlisted.length} compiler errors outside the listed dependency errors`);
    // A compiler that exits with an error and prints no error line did not check the consumer.
    assert.ok(exitCode === 0 || errors.length > 0, `tsc exits with ${exitCode} and prints no error:\n${output.slice(0, 2000)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('the segmentation module resolves at its own subpath, background removal included', async () => {
  assert.deepEqual(pkg.exports['./io/segmentation'], {
    import: './dist/io/segmentation/index.js',
    default: './dist/io/segmentation/index.js',
    types: './dist/io/segmentation/index.d.ts',
  });
  // The two-segment wildcard would map the subpath to dist/io/segmentation.js, which the build does not emit.
  const segmentation = await import('@framers/agentos/io/segmentation');
  assert.equal(typeof segmentation.ReplicateSegmentationProvider, 'function');
  assert.equal(typeof segmentation.FalBackgroundRemovalProvider, 'function');
  assert.equal(typeof segmentation.registerBackgroundRemovalProvider, 'function');
  assert.equal(segmentation.FAL_BIREFNET_MODEL, 'fal-ai/birefnet/v2');
});

test('the speech module resolves at its public subpath, Deepgram pre-recorded transcription included', async () => {
  assert.deepEqual(pkg.exports['./speech'], {
    import: './dist/io/speech/index.js',
    default: './dist/io/speech/index.js',
    types: './dist/io/speech/index.d.ts',
  });
  const speech = await import('@framers/agentos/speech');
  assert.equal(typeof speech.createSpeechRuntimeFromEnv, 'function');
  assert.equal(typeof speech.DeepgramBatchSTTProvider, 'function');
  // Both keys set: OpenAI registers first, so only the preferred order puts Deepgram ahead of it.
  const runtime = speech.createSpeechRuntimeFromEnv({ OPENAI_API_KEY: 'sk-exports-check', DEEPGRAM_API_KEY: 'dg-exports-check' });
  assert.equal(runtime.getSTT({ preferredIds: ['deepgram-batch', 'openai-whisper'] })?.id, 'deepgram-batch');
});

test('the learning module resolves at its own subpath, as the emergent module does', async () => {
  assert.deepEqual(pkg.exports['./cognition/learning'], {
    import: './dist/cognition/learning/index.js',
    default: './dist/cognition/learning/index.js',
    types: './dist/cognition/learning/index.d.ts',
  });
  // The package resolves its own name through its exports, as a host's import does.
  const learning = await import('@framers/agentos/cognition/learning');
  assert.equal(typeof learning.createLearningLayer, 'function');
  assert.equal(typeof learning.deferLearnerSession, 'function');
  assert.equal(typeof learning.selfChangeRefusal, 'function');
});

test('the key probe resolves at its own subpath, as the other api modules do', async () => {
  assert.deepEqual(pkg.exports['./api/probeProviderKey'], {
    import: './dist/api/probeProviderKey.js',
    default: './dist/api/probeProviderKey.js',
    types: './dist/api/probeProviderKey.d.ts',
  });
  const probe = await import('@framers/agentos/api/probeProviderKey');
  assert.equal(typeof probe.probeProviderKey, 'function');
  assert.deepEqual([...probe.PROBEABLE_KEY_PROVIDERS], ['anthropic', 'openai', 'gemini', 'openrouter', 'requesty']);
});

test('the per-trait personality directives resolve at the package root', async () => {
  const root = await import('@framers/agentos');
  assert.equal(typeof root.renderPersonalityDirectives, 'function');
  assert.deepEqual(
    root.renderPersonalityDirectives({ honesty: 0.95 }).map((d) => [d.trait, d.line !== null]),
    [['honesty', true], ['emotionality', false], ['extraversion', false], ['agreeableness', false], ['conscientiousness', false], ['openness', false]],
  );
});
