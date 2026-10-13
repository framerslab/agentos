import type { MeetingRunRecord } from '../types.js';
import { meetingStoreTables } from './sql.js';
import type { IRunStore } from './types.js';

/**
 * The upgrade that adds `provider_connection_ref` to a runs table an earlier `meetingStoresDdl` made, for a host's
 * migration to apply before this version's `SqlRunStore` writes the column. Applying it twice changes nothing.
 *
 * @param prefix - The prefix the stores' tables were made under.
 * @throws Error, the one {@link meetingStoreTables} throws, when the prefix is not a lower-case letter followed by at
 * most 37 lower-case letters, digits or underscores.
 */
export function meetingProvenanceDdl(prefix: string): string {
  // the stores' own check, so a prefix they would refuse is refused here before any SQL is built
  const table = meetingStoreTables(prefix).runs;
  return `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS provider_connection_ref TEXT;`;
}

/**
 * Every run an owner sent through one provider connection, whatever its state and however long ago, read through the
 * run store, ordered by run id. The connection reference outlives a run's content, so a host purging what a connection
 * gathered (its credentials revoked, say) finds the terminal runs as well as the active ones.
 *
 * @param db - Reads the runs table the run store writes.
 * @param runs - The run store the rows are read back through.
 * @param prefix - The prefix the stores' tables were made under.
 * @param ownerRef - The owner whose runs are wanted.
 * @param provider - The provider the runs were sent through.
 * @param generation - The provider's connection reference ({@link MeetingRunRecord.providerConnectionRef}).
 * @throws Error, the one {@link meetingStoreTables} throws, when the prefix is not a lower-case letter followed by at
 * most 37 lower-case letters, digits or underscores; nothing is read.
 */
export async function connectionRuns(
  db: { all<T>(sql: string, args: unknown[]): Promise<T[]> },
  runs: IRunStore, prefix: string, ownerRef: string, provider: string, generation: string,
): Promise<MeetingRunRecord[]> {
  // the stores' own check, so a prefix they would refuse is refused here before any SQL is built
  const table = meetingStoreTables(prefix).runs;
  const rows = await db.all<{ run_id: string }>(
    `SELECT run_id FROM ${table} WHERE owner_ref = ? AND provider_name = ? AND provider_connection_ref = ? ORDER BY run_id`,
    [ownerRef, provider, generation],
  );
  const found = await Promise.all(rows.map((row) => runs.get(row.run_id)));
  return found.filter((run): run is MeetingRunRecord => run !== undefined);
}
