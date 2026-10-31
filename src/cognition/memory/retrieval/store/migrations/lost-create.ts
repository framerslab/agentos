/**
 * @file lost-create.ts
 * A schema step on Postgres that loses the race for an object to another session's create, and the runs that find
 * the object.
 *
 * Every brain of a Postgres database shares its tables, and `CREATE ... IF NOT EXISTS` is not atomic there: the first
 * opens of several brains, in one process or many, can each find a table or an index missing and make it at the same
 * moment. The session that writes the object's catalog row second waits for the first, and fails once the first
 * commits: on the catalog's unique index (`unique_violation`, 23505, on `pg_type_typname_nsp_index` or
 * `pg_class_relname_nsp_index`), or as `duplicate_table` (42P07), `duplicate_object` (42710) or `duplicate_column`
 * (42701). The object is committed by then, so the step, run again, finds it and goes on to its next object.
 *
 * @module memory/retrieval/store/migrations/lost-create
 */

/**
 * The most runs {@link retryLostCreate} gives a step. A step loses the race for an object at most once, since the
 * object is committed when it loses, so a step that makes n objects completes within n + 1 runs, however many other
 * sessions make them at the same moment. A step of an open's schema makes three objects at most: the one that runs
 * `ensureScopeIdColumn` makes the `scope_id` column and its two indexes, and each other step one table or one index.
 */
export const LOST_CREATE_RUNS = 8;

/**
 * Whether `error` is how Postgres fails a create that lost the race to another session's: a unique violation on an
 * index of the system catalog, `duplicate_table`, `duplicate_object` or `duplicate_column`. A unique violation on any
 * other table, such as a migration's `ADD PRIMARY KEY` over duplicate rows, fails the same way on every run, so it is
 * not one.
 */
export function isLostCreate(error: unknown): boolean {
  const { code, schema } = (error ?? {}) as { code?: unknown; schema?: unknown };
  if (code === '23505') return schema === 'pg_catalog';
  return code === '42P07' || code === '42710' || code === '42701';
}

/**
 * Runs `step`, an idempotent schema step that makes only what it finds missing, and runs it again each time it loses
 * the race for an object to another session ({@link isLostCreate}), up to {@link LOST_CREATE_RUNS} runs. Each run
 * finds the objects the runs before it lost, so a step that makes several objects, and can lose the race for each in
 * turn, completes. A step whose statements each commit on their own holds no table lock between runs; a step that
 * opens a transaction of its own, as `MigrationRunner` does on Postgres, has rolled it back before it runs again.
 *
 * @param step - The schema step.
 * @returns What the run that completes returns.
 * @throws The step's error when it is not a lost race, or when the last run loses one.
 */
export async function retryLostCreate<T>(step: () => Promise<T>): Promise<T> {
  for (let run = 1; ; run += 1) {
    try {
      return await step();
    } catch (error) {
      if (run >= LOST_CREATE_RUNS || !isLostCreate(error)) throw error;
    }
  }
}
