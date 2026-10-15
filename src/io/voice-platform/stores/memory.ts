import { VoiceStoreConflict, voiceInteger, voiceKey, type VoiceRow, type VoiceSlotLease, type VoiceStore, type VoiceTable, type VoiceTableValues, type VoiceTransaction } from './types.js';

type State = { [K in VoiceTable]: Map<string, VoiceRow<VoiceTableValues[K]>> };
function empty(): State { return { calls: new Map(), usage: new Map(), events: new Map(), idempotency: new Map(), credentials: new Map(), slots: new Map() }; }
class MemoryTransaction implements VoiceTransaction {
  live = true;
  private host: string | undefined;
  constructor(readonly scopeId: string, private readonly state: State) {}
  private check(): void { if (!this.live) throw new Error('transaction closed'); }
  async get<K extends VoiceTable>(table: K, id: string): Promise<VoiceRow<VoiceTableValues[K]> | undefined> {
    this.check();
    const row = this.state[table].get(voiceKey(this.scopeId, id));
    return row ? structuredClone(row) as VoiceRow<VoiceTableValues[K]> : undefined;
  }
  async list<K extends VoiceTable>(table: K): Promise<Array<VoiceRow<VoiceTableValues[K]>>> {
    this.check();
    return [...this.state[table].values()].filter((r) => r.scopeId === this.scopeId)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map((r) => structuredClone(r) as VoiceRow<VoiceTableValues[K]>);
  }
  async put<K extends VoiceTable>(table: K, id: string, value: VoiceTableValues[K], expectedVersion: number): Promise<void> {
    this.check(); voiceInteger(expectedVersion); voiceInteger(expectedVersion + 1);
    const map = this.state[table] as Map<string, VoiceRow<VoiceTableValues[K]>>;
    const key = voiceKey(this.scopeId, id);
    const previous = map.get(key);
    if ((previous?.version ?? 0) !== expectedVersion || (table === 'events' && previous)) throw new VoiceStoreConflict();
    if (table === 'slots') {
      const slot = value as VoiceSlotLease;
      if (this.host !== slot.hostId || (previous && (previous.value as VoiceSlotLease).hostId !== slot.hostId)) throw new Error('host lock required');
    }
    map.set(key, { scopeId: this.scopeId, id, version: expectedVersion + 1, value: structuredClone(value) });
  }
  async lockHost(hostId: string): Promise<Array<VoiceRow<VoiceSlotLease>>> {
    this.check();
    if (this.host !== undefined && this.host !== hostId) throw new Error('one host per transaction');
    this.host = hostId;
    return [...this.state.slots.values()].filter((r) => r.value.hostId === hostId).map((r) => structuredClone(r));
  }
}
/** Copy-on-write single-process store; failed transactions and escaped handles cannot change committed state. */
export class InMemoryVoiceStore implements VoiceStore {
  private state = empty();
  private queue: Promise<unknown> = Promise.resolve();
  withTransaction<T>(scopeId: string, fn: (tx: VoiceTransaction) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const tx = new MemoryTransaction(scopeId, draft);
      try { const result = await fn(tx); this.state = draft; return result; }
      finally { tx.live = false; }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  /** Never serialize stored grants or sealed recovery results through an enclosing options object. */
  toJSON(): string { return '[InMemoryVoiceStore]'; }
}
