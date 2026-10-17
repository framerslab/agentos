/**
 * @fileoverview Registry of all schema migrations in version order.
 *
 * Adding a new schema version: implement `v3-to-v4.ts` exporting a
 * `Migration` object, then append it to the `MIGRATIONS` array here.
 * Both `Brain._initialize` (for `runPending`) and `Brain._seedMeta` (for
 * the schema_version seed value) pick up the change automatically.
 *
 * @module memory/retrieval/store/migrations
 */

import type { Migration } from './types.js';
import { v1ToV2 } from './v1-to-v2.js';
import { v2ToV3 } from './v2-to-v3.js';

export type { Migration } from './types.js';
export { MigrationRunner } from './MigrationRunner.js';

export const MIGRATIONS: Migration[] = [v1ToV2, v2ToV3];

/**
 * The highest schema version among registered migrations. Used by
 * `Brain._seedMeta` to seed `schema_version` on fresh databases.
 */
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
