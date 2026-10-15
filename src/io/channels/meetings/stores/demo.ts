/** Only these operations are granted by a demonstration capability. */
export type DemoOperation = 'read-status' | 'read-events' | 'read-usage' | 'stop' | 'purge';
/** Durable cleanup intent; a repeated receipt carries no content. */
export interface DemoIntent {
  action: 'stop' | 'purge';
  requestId: string;
  authorizedGeneration: number;
  generation: number;
  done: boolean;
}
/** Immutable host policy. Values belong to the host, not to this library. */
export interface DemoPolicy {
  version: string; credentialMs: number; runMs: number; nonceMs: number;
  allowanceWindowMs: number; allowanceSeconds: number; addressWindowMs: number;
  addressAttempts: number; maxActiveRuns: number; controlGraceMs: number; operations: readonly DemoOperation[];
}
/** Server-side admission row. Raw credentials, visitor cookies and network addresses are never stored. */
export interface DemoRow {
  operationId: string;
  issuer: string;
  audience: string;
  scopeRef: string;
  visitorDigest: string;
  addressDigest: string;
  nonceDigest: string;
  nonceExpiresAt: number;
  consumedAt?: number;
  runId?: string;
  tokenDigest?: string;
  issuedAt?: number;
  expiresAt?: number;
  stopAt?: number;
  generation: number;
  state: 'nonce' | 'active' | 'stopped' | 'purged';
  policy: DemoPolicy;
  reservedSeconds: number;
  connectedSeconds: number;
  usageFinal: boolean;
  credentialGeneration?: number;
  controlUntil?: number;
  operations: DemoOperation[]; intents: DemoIntent[];
}
/** A serializable transaction, including rows shared with any other demonstration channel. */
export interface DemoTransaction {
  /** Finds an opaque operation. Returned rows are detached copies. */
  get(operationId: string): Promise<DemoRow | undefined>;
  /** Finds a nonce by its digest, never by the raw browser credential. */
  findNonce(digest: string): Promise<DemoRow | undefined>;
  /** Finds a currently bound credential by its digest. */
  findToken(digest: string): Promise<DemoRow | undefined>;
  /** Returns the partition's retained rows under the same transaction barrier. */
  list(): Promise<DemoRow[]>;
  /** Inserts or replaces a row. Unique nonce/token/run bindings must be enforced. */
  put(row: DemoRow): Promise<void>;
}
/**
 * A partition transaction rolls back every write on rejection and serializes quota checks,
 * nonce consumption, binding, delivery and revocation across all instances. Hosts retain
 * admissions through their captured allowance and control windows and pending cleanup until acknowledged. A hosted adapter
 * uses database locks, including a partition anchor before the first row exists. Its bounded
 * read callback must keep that lock until output is delivered or positively cancelled.
 */
export interface IDemoRunStore {
  /** Executes one fully isolated transaction; callbacks must not recursively enter this store. */
  transaction<T>(work: (tx: DemoTransaction) => Promise<T>): Promise<T>;
}
/** Single-process reference adapter with rollback and the same transaction serialization. */
export class InMemoryDemoRunStore implements IDemoRunStore {
  private rows = new Map<string, DemoRow>();
  private tail: Promise<void> = Promise.resolve();
  /** Holds the reference transaction through awaited, bounded delivery callbacks. */
  async transaction<T>(work: (tx: DemoTransaction) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    const copy = structuredClone(this.rows);
    const find = (predicate: (row: DemoRow) => boolean): DemoRow | undefined => {
      const row = [...copy.values()].find(predicate);
      return row ? structuredClone(row) : undefined;
    };
    const tx: DemoTransaction = {
      get: async (id) => { const row = copy.get(id); return row ? structuredClone(row) : undefined; },
      findNonce: async (digest) => find((r) => r.nonceDigest === digest),
      findToken: async (digest) => find((r) => r.tokenDigest === digest),
      list: async () => structuredClone([...copy.values()]),
      put: async (row) => {
        for (const r of copy.values()) {
          if (r.operationId === row.operationId) continue;
          if (r.nonceDigest === row.nonceDigest || (row.tokenDigest !== undefined && r.tokenDigest === row.tokenDigest) || (row.runId !== undefined && r.runId === row.runId)) throw new Error('duplicate demo binding');
        }
        copy.set(row.operationId, structuredClone(row));
      },
    };
    try { const value = await work(tx); this.rows = copy; return value; }
    finally { unlock(); }
  }
  /** Does not serialize credentials, visitors or rows. */
  toJSON(): string { return '[InMemoryDemoRunStore]'; }
}
