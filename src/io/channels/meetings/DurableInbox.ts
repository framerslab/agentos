/** One delivery an inbox accepted: its id (the replay key), when it was accepted, and the payload. */
export interface InboxEntry<T> { id: string; acceptedAt: number; value: T; }

/**
 * Deliveries a receiver has accepted and not yet acted on. A payload stays pending until the receiver acknowledges it,
 * so work interrupted by a restart is found again; an acknowledged entry keeps only its id, so a replay of it is refused.
 */
export interface IDurableInbox<T> {
  /** Stores a new entry; false, and nothing changes, when an entry with its id was accepted before (acknowledged or not). */
  accept(entry: InboxEntry<T>): Promise<boolean>;
  /** The entries accepted and not yet acknowledged, oldest first. */
  pending(): Promise<InboxEntry<T>[]>;
  /** Drops the entry's payload once the receiver has acted on it; its id stays, so a replay is still refused. */
  acknowledge(id: string): Promise<void>;
}

/** An inbox in memory, for tests and single-process hosts: entries are copied in and out. */
export class MemoryDurableInbox<T> implements IDurableInbox<T> {
  private rows = new Map<string, InboxEntry<T> | null>();
  async accept(entry: InboxEntry<T>): Promise<boolean> {
    if (this.rows.has(entry.id)) return false;
    this.rows.set(entry.id, structuredClone(entry));
    return true;
  }
  async pending(): Promise<InboxEntry<T>[]> {
    return [...this.rows.values()].flatMap((row) => row === null ? [] : [structuredClone(row)]);
  }
  async acknowledge(id: string): Promise<void> { this.rows.set(id, null); }
}

/** What {@link SqlDurableInbox} needs of a database: a statement that answers the rows it changed, and a query. */
export interface InboxDb {
  run(sql: string, params?: unknown[]): Promise<{ changes?: number }>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

function tableOf(prefix: string): string {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(prefix)) throw new Error('invalid inbox prefix');
  return `${prefix}_inbox`;
}

/**
 * The inbox's Postgres table, `<prefix>_inbox`, for a host's migration.
 *
 * @param prefix - A lower-case letter followed by at most 39 lower-case letters, digits or underscores.
 * @throws Error when the prefix does not fit.
 */
export function durableInboxDdl(prefix: string): string {
  return `CREATE TABLE IF NOT EXISTS ${tableOf(prefix)} (
    id TEXT PRIMARY KEY, sequence BIGSERIAL UNIQUE NOT NULL,
    accepted_at BIGINT NOT NULL, payload TEXT
  );`;
}

/** The sealer keeps credentials in pending deliveries encrypted at rest. */
export class SqlDurableInbox<T> implements IDurableInbox<T> {
  private readonly table: string;
  /**
   * @param db - The database holding the table {@link durableInboxDdl} makes.
   * @param prefix - The prefix the table was made under.
   * @param box - Seals each payload before it is stored and opens it on read (a `SecretBox`, for one).
   */
  constructor(private readonly db: InboxDb, prefix: string,
    private readonly box: { seal(value: string): string; open(value: string): string }) {
    this.table = tableOf(prefix);
  }
  async accept(entry: InboxEntry<T>): Promise<boolean> {
    const result = await this.db.run(
      `INSERT INTO ${this.table} (id, accepted_at, payload) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      [entry.id, entry.acceptedAt, this.box.seal(JSON.stringify(entry.value))]);
    return (result.changes ?? 0) === 1;
  }
  async pending(): Promise<InboxEntry<T>[]> {
    const rows = await this.db.all<{ id: string; accepted_at: string | number; payload: string }>(
      `SELECT id, accepted_at, payload FROM ${this.table} WHERE payload IS NOT NULL ORDER BY sequence`);
    return rows.map((row) => ({ id: row.id, acceptedAt: Number(row.accepted_at), value: JSON.parse(this.box.open(row.payload)) as T }));
  }
  async acknowledge(id: string): Promise<void> {
    await this.db.run(`UPDATE ${this.table} SET payload = NULL WHERE id = ?`, [id]);
  }
}
