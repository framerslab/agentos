/**
 * @file GovernedTool.postgres.e2e.test.ts
 * The governed-tool suite on Postgres, where several processes share the limiter's counts. Gated on
 * AGENTOS_TEST_POSTGRES_URL (CI's service container); skipped without it. Every test's tables carry a prefix of this
 * run's own and are dropped after it.
 */
import { describe, it } from 'vitest';
import { createPostgresAdapter } from '@framers/sql-storage-adapter';
import { runGovernedToolSuite } from './GovernedTool.contract.js';
import { DAY, HOUR } from './governedFixtures.js';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let made = 0;

if (POSTGRES_URL) {
  runGovernedToolSuite('Postgres', async () => {
    const db = createPostgresAdapter({ connectionString: POSTGRES_URL, max: 5 });
    await db.open();
    const prefixes: string[] = [];
    return {
      db,
      prefix: () => { const prefix = `gt_${RUN}_${(made += 1)}`; prefixes.push(prefix); return prefix; },
      close: async () => {
        for (const prefix of prefixes) for (const windowMs of [HOUR, DAY]) {
          await db.exec(`DROP TABLE IF EXISTS ${prefix}_w${windowMs}_reservations; DROP TABLE IF EXISTS ${prefix}_w${windowMs}_meter;`);
        }
        await db.close();
      },
    };
  });
} else {
  describe.skip('a governed tool under generateText(), Postgres', () => { it('needs AGENTOS_TEST_POSTGRES_URL', () => undefined); });
}
