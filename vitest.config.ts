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
    coverage: {
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      all: true,
      exclude: [
        'src/stubs/**',
        'src/server/**',
        'src/services/user_auth/**',
        'src/extensions/builtin/**',
        'src/core/memory_lifecycle/**',
        'src/core/language/**',
        'src/core/storage/**',
        'src/core/ai_utilities/**',
        'src/core/llm/routing/**',
        'src/core/llm/streaming/**',
        'src/core/llm/providers/implementations/**',
        'src/core/llm/providers/AIModelProviderManager.ts',
        'src/core/llm/providers/errors/**',
        'src/core/agents/**',
        'src/core/usage/**',
        'src/core/workflows/storage/**',
        'src/core/workflows/runtime/**',
        'src/core/evaluation/LLMJudge.ts',
        'src/core/sandbox/**',
        'src/core/cognitive_substrate/**',
        'src/extensions/RegistryLoader.ts',
        'src/extensions/RegistryConfig.ts',
        'src/rag/implementations/**',
        'src/rag/RetrievalAugmentor.ts',
        'src/rag/EmbeddingManager.ts',
        'src/config/AgentOSConfig.ts',
        'src/utils/uuid.ts',
        'src/api/AgentOS.ts',
        'src/types/**',
        '**/*.d.ts',
        '**/index.ts',
        'scripts/**',
        'drizzle.config.js',
        'node_modules/**',
      ],
      thresholds: {
        statements: 65,
        branches: 65,
        functions: 69,
        lines: 65,
      },
    },
  },
});
