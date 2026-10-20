// @ts-nocheck
import { defineConfig } from 'vitest/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, 'src');

// Use sibling source when running inside the monorepo, fall back to the
// installed npm package when running in standalone CI.
const sqlAdapterSibling = path.resolve(__dirname, '../sql-storage-adapter/src/index.ts');
const sqlAdapterAlias = fs.existsSync(sqlAdapterSibling)
  ? [{ find: '@framers/sql-storage-adapter', replacement: sqlAdapterSibling }]
  : [];

export default defineConfig({
  server: {
    deps: {
      // Native C++ addons must not be transformed by Vite
      external: ['better-sqlite3', 'sharp'],
    },
  },
  ssr: {
    // Mark native modules as external for SSR/Node transforms
    external: ['better-sqlite3', 'sharp'],
  },
  resolve: {
    // Prefer TypeScript sources over any co-located compiled JS artifacts.
    extensions: ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
    alias: [
      { find: /^@agentos\/core\/(.*)$/, replacement: `${srcDir}/$1` },
      { find: '@framers/agentos', replacement: srcDir },
      { find: '@prisma/client', replacement: path.resolve(__dirname, 'src/stubs/prismaClient.ts') },
      ...sqlAdapterAlias,
    ],
  },
  test: {
    // Vitest 3 reads dep-externalization from test.server.deps (the root
    // server.deps block above is the Vite-level home Vitest 1 read).
    // Keep both so native C++ addons stay untransformed across majors.
    server: {
      deps: {
        external: ['better-sqlite3', 'sharp'],
      },
    },
    globals: true,
    environment: 'node',
    testTimeout: 120000, // 2 minutes — Memory facade tests take 45s+ for SQLite ops
    hookTimeout: 30000,
    // Generate the (gitignored) knowledge corpus before tests so corpus-dependent
    // tests can read it in standalone CI.
    globalSetup: ['./scripts/vitest-global-setup.mjs'],
    include: ['tests/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    exclude: [
      'dist', 'coverage', 'node_modules',
      'src/**/*.browser.test.ts',
      // onnxruntime-node native binary fails to self-register in CI (ERR_DLOPEN_FAILED)
      'src/io/media/audio/__tests__/MusicGenLocalProvider.test.ts',
      'src/io/media/audio/__tests__/AudioGenLocalProvider.test.ts',
      'src/api/runtime/__tests__/generateMusic.test.ts',
      'src/api/runtime/__tests__/generateSFX.test.ts',
      // sharp's native binary is not built in standalone CI (pnpm ignores its
      // build script), so segmentation tests that generate masks via sharp
      // cannot load it there. Excluded in CI only; they still run locally
      // where sharp is available.
      ...(process.env.CI
        ? [
            'src/io/segmentation/__tests__/ReplicateSegmentationProvider.test.ts',
            'src/io/segmentation/__tests__/maskGeometry.test.ts',
            'src/io/segmentation/__tests__/maskToEditMask.test.ts',
            'src/io/segmentation/__tests__/cropRegion.test.ts',
            'src/io/segmentation/__tests__/roundtrip.test.ts',
            // Cross-package integration tests that import sibling-package sources
            // (agentos-extensions, sql-storage-adapter internals) by relative path.
            // Those siblings are absent in standalone agentos CI, so the files cannot
            // load there. Excluded in CI only; they still run in the monorepo.
            'tests/extensions/WildsMemoryExtensions.spec.ts',
            'tests/e2e/external-tool-resume-persistence.e2e.spec.ts',
          ]
        : []),
    ],
    server: {
      deps: {
        external: ['better-sqlite3', 'sharp'],
      },
    },
    // `pnpm run test:coverage` (CI's "Test with coverage" step) turns this on.
    coverage: {
      provider: 'v8',
      // text-summary prints the totals to the log; json-summary writes the totals and
      // each file's figures to coverage/coverage-summary.json; lcovonly writes
      // coverage/lcov.info, which CI uploads to Codecov. For the HTML report, add
      // `--coverage.reporter=html`.
      reporter: ['text-summary', 'json-summary', 'lcovonly'],
      reportsDirectory: 'coverage',
      // Every source file is in the report, tested or not. Vitest leaves the test
      // files (test.include) out by itself; the helpers, fixtures and contract
      // suites beside them in __tests__ are test code too. Declaration files hold
      // no code.
      include: ['src/**/*.ts'],
      exclude: ['**/__tests__/**', '**/*.d.ts'],
      // Two points below the figures CI measured when these were last raised (run
      // 39112738248: lines 80.65, statements 78.91, functions 81.72, branches
      // 70.62 percent), so a change that takes more than that away fails the run.
      // Raise them as coverage grows; never lower them.
      thresholds: {
        lines: 78.65,
        statements: 76.91,
        functions: 79.72,
        branches: 68.62,
      },
    },
  },
});
