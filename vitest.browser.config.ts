import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { playwright } from '@vitest/browser-playwright';
import type { BrowserCommand } from 'vitest/node';
import { defineConfig } from 'vitest/config';

/**
 * The folder of sql.js's browser build and its WebAssembly, resolved from @framers/sql-storage-adapter, whose
 * dependency sql.js is: it is not one of this package's, so from the package root it does not resolve. A browser test
 * that opens the adapter's IndexedDB database points sql.js at the files there, through Vite's `/@fs/` prefix.
 */
const sqlJsDist: BrowserCommand<[]> = () => {
  const adapterManifest = createRequire(import.meta.url).resolve('@framers/sql-storage-adapter/package.json');
  return dirname(createRequire(adapterManifest).resolve('sql.js'));
};

export default defineConfig({
  optimizeDeps: {
    // Bundled before the first test runs, so no test reloads the page when Vite meets them mid-run.
    include: ['@framers/sql-storage-adapter/kv', '@framers/sql-storage-adapter/indexeddb'],
  },
  test: {
    include: ['src/**/*.browser.test.ts'],
    testTimeout: 120_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }, { browser: 'webkit' }],
      commands: { sqlJsDist },
    },
  },
});
