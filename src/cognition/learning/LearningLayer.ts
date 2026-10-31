/**
 * @module learning/LearningLayer
 *
 * The learning layer of one agent or one runtime. A host builds it only when its `learning` option is on; `gmi()`,
 * the full runtime and a product that runs its own turn loop all call the same layer. It binds each session to a
 * learner (one agent with one user, in one namespace), keeps each learner's trait row and the ledger in its learning
 * store (`learning.store`, else SQL over the host's storage adapter, else the process), reads the run-time freezes
 * and suspensions at each turn, re-files every memory Brain it is handed once, and answers with the manifest of
 * the loops the deployment runs. A store that will not open leaves the layer degraded until a later call opens it:
 * the persona's authored traits render, and the writes that need the store are refused.
 *
 * The operator's host calls run in every mode and under a freeze: a run-time freeze or suspension, `operatorSet`,
 * `revert`, the export and the import of a learner's learned state, and `forgetUser`, which takes the user's write
 * chain, commits the tombstone and deletes the user's rows and traces in every store the layer reaches. A host call
 * that needs the store fails, naming it, while the store does not open. A crash's `pending` memory write is decided at
 * the learner's next session.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { ICognitiveMemoryManager } from '../memory/CognitiveMemoryManager.js';
import type { TraceSnapshot } from '../memory/retrieval/store/tracePersistence.js';
import { processIsFrozen, resolveLearningConfig, resolveTurnMode } from './config.js';
import {
  admitImport,
  assertFreezeScope,
  assertLearnedStateDocument,
  assertLearnerKey,
  forgetTargets,
  freezeCovers,
  freezeRowOf,
  freezeScopeKey,
  invertOperatorSet,
  leftByCrash,
  memoryWriteHolds,
  operatorOf,
  parseMemoryBefore,
  parseMemoryWrite,
  plainScopesOf,
  stateOfRecord,
  undoMemoryWrite,
  type ForgetTarget,
  type FreezeTarget,
} from './hostCalls.js';
import { canonicalJson } from './ledger/canonical.js';
import { chainKeyOf, Ledger, tombstoneHash } from './ledger/Ledger.js';
import { LearnerSession, type LearnerSessionHost, type SessionBinding } from './LearnerSession.js';
import { buildManifest } from './manifest.js';
import { InMemoryLearningStore } from './store/InMemoryLearningStore.js';
import type { FreezeRow, LearningStore, SessionRow } from './store/LearningStore.js';
import { SqlLearningStore } from './store/SqlLearningStore.js';
import { latestTraitStateRow, readLearnerRecord, writeTraitRow } from './traitLoad.js';
import { withOperatorSet } from './traitState.js';
import {
  DEFAULT_ANONYMOUS_USER_IDS,
  type ForgetReport,
  type FreezeScope,
  type HostLoopName,
  type ILearnerSession,
  type ImportReport,
  type LearnedStateDocument,
  type LearnerContext,
  type LearnerKey,
  type LearningConfig,
  type LearningLayerHandle,
  type LearningMemoryTools,
  type LearningMode,
  type LearningProfile,
  type LedgerEntry,
  type LoopManifest,
  type LoopState,
  type MemoryWriteChange,
  type NoLearnerReason,
  type OperatorSetInput,
  type ResolvedLearning,
} from './types.js';
import { sessionChainKey, userChainKey, WriteChains } from './writeChains.js';

const IN_PROCESS = 'in process: the ledger and the state it records end with the process';

/** A crash's `pending` memory write is decided once it is this old on the layer's clock. */
const PENDING_AGE_MS = 15 * 60_000;

/** The rows a load or a re-anchor writes, which `revert` refuses: an operator sets the learner instead. */
const LOAD_REASONS: readonly string[] = ['created', 'persona_changed', 'floor_raised', 'reanchor'];

/** The stores `forgetUser` does not reach, with why. */
const UNREACHED_STORES: ReadonlyArray<{ store: string; reason: string }> = [
  { store: 'the memory archive', reason: 'an archived original carries no scope id to find it by' },
  {
    store: "a conversation's own history",
    reason:
      "the full runtime's conversation store and a gmi() session's history keep a conversation's messages until the host deletes them, and a later compaction summarizes them again",
  },
  { store: "memory's observer and reflector buffers and prospective reminders", reason: 'they carry no user id' },
  { store: "a session's forged tools", reason: 'they carry no user id' },
  { store: "an organization scope a host's policy shares", reason: "it is the organization's, which the host's shareWithOrganization policy files into" },
];

/** A Brain-like reader: a count over one brain's traces. */
async function countOn(db: { get<T>(sql: string, params?: unknown[]): Promise<T | null | undefined> }, brainId: string, scope: string, scopeId: string): Promise<number> {
  const row = await db.get<{ n: number | string }>(
    'SELECT count(*) AS n FROM memory_traces WHERE brain_id = ? AND scope = ? AND scope_id = ? AND deleted = 0',
    [brainId, scope, scopeId],
  );
  return Number(row?.n ?? 0);
}

/** A memory manager's Brain, when it has one. */
function brainOfManager(manager: ICognitiveMemoryManager): { brainId: string; get<T>(sql: string, params?: unknown[]): Promise<T | null | undefined> } | undefined {
  try {
    const brain = (manager.getStore?.() as { getBrain?: () => { brainId: string; get<T>(sql: string, params?: unknown[]): Promise<T | null> } | null } | undefined)?.getBrain?.();
    return brain ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The candidate whose row carries the newest digest of the trait row: the row a change's verdict carries the digest
 * on names its candidate, whose `after` holds the state.
 */
function recordedTraitState(entries: readonly LedgerEntry[]): LedgerEntry | undefined {
  const newest = latestTraitStateRow(entries);
  if (!newest || newest.rowType === 'candidate') return newest;
  return entries.find((entry) => entry.rowType === 'candidate' && entry.id === newest.candidateId);
}

/** The JSON a stored row holds, or `undefined` when it does not parse. */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** What a layer is built from: the host's `learning` config, and what the host says about itself. */
export interface LearningLayerOptions extends LearningConfig {
  /** The host's cognition profile, which sets the switches the config leaves unset. Default `'custom'`. */
  profile?: LearningProfile;
  /** The host that builds the layer. Default `'custom'`: a product that calls the layer around its own turn loop. */
  surface?: LoopManifest['surface'];
  /** What the host's own configuration says about the loops it runs, for the manifest. */
  hostLoops?: Partial<Record<HostLoopName, LoopState>>;
  /** A memory manager the host built itself (a product that runs its own turn loop): re-filed once, and kept by the layer. */
  memory?: ICognitiveMemoryManager;
  /** The host's storage adapter: the learning store is SQL over it when `store` is unset and it has transactions. */
  storageAdapter?: StorageAdapter;
  /**
   * Opens the learning store on first use (`gmi()`: over the adapter of the Brain `memory.store` opens). A throw leaves
   * the layer degraded until a later call opens it.
   */
  openStore?: () => Promise<LearningStore>;
  /** Memory-tools facades beside `memoryTools` (the full runtime's second one): each is re-filed once and kept by its brain id. */
  memoryFacades?: LearningMemoryTools[];
}

/** Where the store comes from, and what the manifest says of it. */
interface StoreSource {
  open(): Promise<LearningStore>;
  detail(store: LearningStore): string;
}

/** What the layer keeps of the host beside its config. */
interface LayerHost {
  surface: LoopManifest['surface'];
  profile: LearningProfile;
  hostLoops?: Partial<Record<HostLoopName, LoopState>>;
  memory?: ICognitiveMemoryManager;
  storageAdapter?: StorageAdapter;
  openStore?: () => Promise<LearningStore>;
  memoryFacades?: LearningMemoryTools[];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A reference to a memory manager the layer does not keep alive. */
interface ManagerReference {
  deref(): ICognitiveMemoryManager | undefined;
}

/** A weak reference where the runtime has `WeakRef`; where it has none, the layer holds the manager for its own life. */
function referenceTo(manager: ICognitiveMemoryManager): ManagerReference {
  return typeof WeakRef === 'function' ? new WeakRef(manager) : { deref: () => manager };
}

/** The brain id a memory-tools facade names, when it names one. */
function facadeBrainId(facade: LearningMemoryTools): string | undefined {
  try {
    const brainId = facade.brainId;
    return typeof brainId === 'string' && brainId !== '' ? brainId : undefined;
  } catch {
    return undefined;
  }
}

/** The store a layer's options name: `store`, else `openStore`, else SQL over a transactional adapter, else the process. */
function storeSourceOf(store: LearningStore | undefined, host: LayerHost): StoreSource {
  if (store) return { open: async () => store, detail: (s) => (s.kind === 'sql' ? 'sql store the host passed' : IN_PROCESS) };
  if (host.openStore) {
    const open = host.openStore;
    return { open, detail: (s) => (s.kind === 'sql' ? "sql store over the agent's memory store" : IN_PROCESS) };
  }
  const adapter = host.storageAdapter;
  if (adapter) {
    if (adapter.capabilities?.has?.('transactions')) {
      const sql = new SqlLearningStore({ adapter });
      return { open: async () => sql, detail: () => "sql store over the host's storage adapter" };
    }
    // A change and its ledger row must commit together, which an adapter without transactions cannot do.
    const inProcess = new InMemoryLearningStore();
    return {
      open: async () => inProcess,
      detail: () => 'in process: the storage adapter has no transactions; the ledger and the state it records end with the process',
    };
  }
  const inProcess = new InMemoryLearningStore();
  return { open: async () => inProcess, detail: () => IN_PROCESS };
}

class LearningLayer implements LearningLayerHandle, LearnerSessionHost {
  readonly chains = new WriteChains();
  readonly inFlight = new Set<string>();
  readonly defaultNamespace: string;
  private readonly anonymous: ReadonlySet<string>;
  private readonly clock: () => number;
  private readonly source: StoreSource;
  private readonly facadeList: LearningMemoryTools[];
  private readonly turns: LoopManifest['turns'] = { prepared: 0, bound: 0, none: {} };
  private manifestLogged = false;
  private closed = false;
  private ready: { store: LearningStore; ledger: Ledger } | undefined;
  private opening: Promise<{ store: LearningStore; ledger: Ledger } | undefined> | undefined;
  private storeDetail = '';
  private storeError: string | undefined;
  /** The run-time freezes and suspensions, read at each turn and changed at once by this process's calls. */
  private freezes: FreezeRow[] = [];
  private readonly brokenChains = new Set<string>();
  private readonly epochs = new Map<string, number>();
  /** Every memory manager the layer was handed, held weakly so a shut-down GMI's manager does not live on here. */
  private managers: ManagerReference[] = [];
  /** The managers and facades whose Brain was re-filed. */
  private readonly refiled = new WeakSet<object>();
  /** The memory-tools facades by brain id. */
  private readonly facades = new Map<string, LearningMemoryTools>();

  constructor(
    private readonly config: LearningConfig,
    private readonly resolved: ResolvedLearning,
    private readonly host: LayerHost,
  ) {
    this.anonymous = new Set([...DEFAULT_ANONYMOUS_USER_IDS, ...(config.anonymousUserIds ?? [])]);
    this.defaultNamespace = config.namespace ?? '';
    this.clock = config.clock ?? Date.now;
    this.source = storeSourceOf(config.store ?? undefined, host);
    const facades = [config.memoryTools, ...(host.memoryFacades ?? [])].filter(
      (facade): facade is LearningMemoryTools => !!facade && typeof facade === 'object',
    );
    this.facadeList = [...new Set(facades)];
  }

  // --- what a learner session reads ---

  storage(): Promise<{ store: LearningStore; ledger: Ledger } | undefined> {
    if (this.ready) return Promise.resolve(this.ready);
    this.opening ??= this.openStorage().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async openStorage(): Promise<{ store: LearningStore; ledger: Ledger } | undefined> {
    let store: LearningStore;
    try {
      store = await this.source.open();
      // The first read creates a SQL store's tables and fills the freeze cache.
      this.freezes = await store.freezeRows();
    } catch (error) {
      const reason = messageOf(error);
      if (reason !== this.storeError) {
        console.warn(
          `[agentos] learning: the learning store did not open (${reason}); the persona's authored traits render, and the memory writes that need the store are refused, until a later call opens it.`,
        );
      }
      this.storeError = reason;
      return undefined;
    }
    const ledger = new Ledger({
      store,
      ledgerKey: this.config.ledgerKey ?? undefined,
      clock: this.clock,
      isFrozen: (learner) =>
        this.frozenFor(
          learner.userId === null
            ? { agentKey: learner.agentKey }
            : { agentKey: learner.agentKey, learner: { namespace: learner.namespace, agentKey: learner.agentKey, userId: learner.userId } },
        ),
      onForgottenAfterCommit: (namespace, userId) => this.purgeUserRows(namespace, userId),
    });
    this.storeError = undefined;
    this.storeDetail = this.source.detail(store);
    this.ready = { store, ledger };
    return this.ready;
  }

  async refreshFreezes(): Promise<void> {
    const ready = await this.storage();
    if (!ready) return;
    try {
      this.freezes = await ready.store.freezeRows();
    } catch (error) {
      console.warn(`[agentos] learning: the run-time freezes were not read (${messageOf(error)}); the turn reads the last ones read.`);
    }
  }

  modeFor(target: FreezeTarget): LearningMode {
    const base = resolveTurnMode(this.resolved.mode).mode;
    if (base === 'off' || this.covered('off', target)) return 'off';
    if (base === 'frozen' || this.covered('frozen', target)) return 'frozen';
    return 'on';
  }

  frozenFor(target: FreezeTarget): boolean {
    return this.resolved.mode === 'frozen' || processIsFrozen() || this.covered('frozen', target);
  }

  private covered(mode: FreezeRow['mode'], target: FreezeTarget): boolean {
    return this.freezes.some((row) => row.mode === mode && freezeCovers(row, target));
  }

  countTurn(reason: NoLearnerReason | undefined): void {
    this.turns.prepared += 1;
    if (reason) this.turns.none[reason] = (this.turns.none[reason] ?? 0) + 1;
    else this.turns.bound += 1;
  }

  isAnonymous(userId: string): boolean {
    return userId.trim() === '' || this.anonymous.has(userId);
  }

  now(): number {
    return this.clock();
  }

  private learnerId(key: LearnerKey): string {
    return canonicalJson([key.namespace, key.agentKey, key.userId]);
  }

  traitEpoch(key: LearnerKey): number {
    return this.epochs.get(this.learnerId(key)) ?? 0;
  }

  noteChain(key: LearnerKey, broken: boolean): void {
    const id = this.learnerId(key);
    if (broken) this.brokenChains.add(id);
    else this.brokenChains.delete(id);
  }

  async purgeUserRows(namespace: string, userId: string): Promise<void> {
    const ready = await this.storage();
    if (!ready) return;
    try {
      await ready.store.deleteUserRows(namespace, userId);
    } catch (error) {
      const hash = (await tombstoneHash(namespace, userId)).slice(0, 16);
      console.warn(`[agentos] learning: the rows of a forgotten user (tombstone ${hash}) were not deleted again (${messageOf(error)}); a second forgetUser call deletes them.`);
    }
  }

  /** The memory managers the layer was handed that are still alive. */
  private liveManagers(): ICognitiveMemoryManager[] {
    const live: ICognitiveMemoryManager[] = [];
    this.managers = this.managers.filter((ref) => {
      const manager = ref.deref();
      if (manager) live.push(manager);
      return manager !== undefined;
    });
    return live;
  }

  async adoptMemory(memory: ICognitiveMemoryManager): Promise<void> {
    if (!this.liveManagers().includes(memory)) this.managers.push(referenceTo(memory));
    await this.refile(memory, 'a memory manager');
  }

  /** Re-files a manager's or a facade's Brain once; a failure is tried again at the next session. */
  private async refile(target: { ensureEncodedScopeIds?: () => Promise<number> }, what: string): Promise<void> {
    if (this.refiled.has(target)) return;
    if (typeof target.ensureEncodedScopeIds !== 'function') {
      this.refiled.add(target);
      return;
    }
    try {
      await target.ensureEncodedScopeIds();
      this.refiled.add(target);
    } catch (error) {
      console.warn(
        `[agentos] learning: ${what}'s Brain was not re-filed (${messageOf(error)}); its traces under ids that hold '/', '%' or ':' are read once a later session re-files it.`,
      );
    }
  }

  /** Registers each memory-tools facade by its brain id and re-files its Brain once. */
  private async adoptFacades(): Promise<void> {
    for (const facade of this.facadeList) {
      const brainId = facadeBrainId(facade);
      if (brainId && !this.facades.has(brainId)) this.facades.set(brainId, facade);
      await this.refile(facade, "the memory tools' facade");
    }
  }

  // --- the layer ---

  async manifest(): Promise<LoopManifest> {
    const ready = await this.storage();
    return buildManifest({
      surface: this.host.surface,
      profile: this.host.profile,
      resolved: this.resolved,
      hostLoops: this.host.hostLoops,
      turns: this.turns,
      ledger: this.ledgerLoop(ready),
      ...(ready ? {} : { traitsDegraded: this.storeError ?? 'the learning store did not open' }),
      forgetUnreached: this.unreachedStores().map(({ store, reason }) => `${store}: ${reason}`),
    });
  }

  /** The stores `forgetUser` does not reach, with why: this release's, and the facades the layer was or was not handed. */
  private unreachedStores(): Array<{ store: string; reason: string }> {
    const unreached = [...UNREACHED_STORES];
    if (this.facadeList.length === 0) {
      unreached.push({
        store: 'a memory tools facade the layer was not handed',
        reason: 'a host that registers the memory tools itself passes their facade as learning.memoryTools',
      });
    }
    for (const facade of this.facadeList) {
      if (typeof facade.deleteScope !== 'function') unreached.push({ store: this.facadeName(facade), reason: 'it has no deleteScope' });
    }
    return unreached;
  }

  private facadeName(facade: LearningMemoryTools): string {
    const brainId = facadeBrainId(facade);
    return brainId ? `memory tools facade of brain ${brainId}` : 'memory tools facade';
  }

  private ledgerLoop(ready: { ledger: Ledger } | undefined): LoopState {
    if (!ready) return { live: false, detail: `store unavailable: ${this.storeError ?? 'not opened'}` };
    const parts = [this.storeDetail, ready.ledger.keyed ? 'keyed' : 'unkeyed'];
    const broken = this.brokenChains.size;
    if (broken > 0) parts.push(`chain broken for ${broken} ${broken === 1 ? 'learner' : 'learners'}`);
    return { live: true, detail: parts.join('; ') };
  }

  async forLearner(key: LearnerKey | null, context: LearnerContext): Promise<ILearnerSession> {
    if (this.closed) throw new Error('The learning layer is closed.');
    // Opens the store and reads the run-time freezes and suspensions again, so one another process set since this
    // process last read them holds from the session's open: a suspended learner's open reads and writes no learned state.
    await this.refreshFreezes();
    await this.adoptFacades();
    if (this.host.memory) await this.adoptMemory(this.host.memory);
    if (!this.manifestLogged) {
      this.manifestLogged = true;
      console.log(`[agentos] learning layer manifest: ${JSON.stringify(await this.manifest())}`);
    }
    const session = new LearnerSession(this, this.bindingFor(key, context), context, this.agentKeyFor(key, context));
    await session.open();
    return session;
  }

  /**
   * The learner a key names. A blank or anonymous user id names none, and neither does a key with no agent: the
   * host's `learning.agentKey` wins over the key's, and the host's `learning.namespace` fills a key that has none.
   * The namespace the caller passed is kept apart: the session's turns are read against it.
   */
  private bindingFor(key: LearnerKey | null, context: LearnerContext): SessionBinding {
    if (!key) return { reason: context.noLearnerReason ?? 'no_user_id' };
    const userId = typeof key.userId === 'string' ? key.userId : '';
    if (this.isAnonymous(userId)) return { reason: 'placeholder_user' };
    const agentKey = (this.config.agentKey ?? key.agentKey ?? '').trim();
    if (!agentKey) return { reason: 'no_agent_key' };
    const openedUnder = typeof key.namespace === 'string' ? key.namespace : '';
    return { key: { namespace: openedUnder || this.defaultNamespace, agentKey, userId }, openedUnder };
  }

  /** The agent a session's writes with no learner are recorded under: the learner's agent, else the persona. */
  private agentKeyFor(key: LearnerKey | null, context: LearnerContext): string {
    return (this.config.agentKey ?? key?.agentKey ?? '').trim() || context.personaId;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  // --- the host calls: every one runs in every mode and under a freeze ---

  /** The store and the ledger for a host call, with every facade and memory manager the layer was handed adopted. */
  private async requireStorage(call: string): Promise<{ store: LearningStore; ledger: Ledger }> {
    const ready = await this.storage();
    if (!ready) throw new Error(`${call}: the learning store is unavailable (${this.storeError ?? 'it did not open'}).`);
    await this.adoptFacades();
    if (this.host.memory) await this.adoptMemory(this.host.memory);
    return ready;
  }

  /** A learner key a host call names: well formed, and naming a user. */
  private learnerOf(key: unknown, call: string): LearnerKey {
    assertLearnerKey(key, call);
    if (this.isAnonymous(key.userId)) throw new Error(`${call}: user id '${key.userId}' names no learner.`);
    return { namespace: key.namespace, agentKey: key.agentKey, userId: key.userId };
  }

  private async refuseForgotten(store: LearningStore, user: { namespace: string; userId: string }, call: string): Promise<void> {
    if (await store.isForgotten(await tombstoneHash(user.namespace, user.userId))) {
      throw new Error(`${call}: the user is forgotten in this namespace; nothing is written for them again.`);
    }
  }

  private async refuseUnlessKept(ledger: Ledger, candidateId: string, call: string): Promise<void> {
    const verdict = await ledger.latestVerdict(candidateId);
    if (verdict !== 'kept') throw new Error(`${call}: candidate ${candidateId} is ${verdict ?? 'unknown'}; only a kept change is reverted.`);
  }

  /** A learner's trait row changed through an operator call of this process: its sessions read it again. */
  private bumpTraitEpoch(key: LearnerKey): void {
    const id = this.learnerId(key);
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
  }

  async freeze(scope: FreezeScope, by?: string): Promise<void> {
    await this.setFreeze(scope, 'frozen', by, 'freeze');
  }

  async unfreeze(scope: FreezeScope): Promise<void> {
    await this.clearFreeze(scope, 'frozen', 'unfreeze');
  }

  async suspend(scope: FreezeScope, by?: string): Promise<void> {
    await this.setFreeze(scope, 'off', by, 'suspend');
  }

  async unsuspend(scope: FreezeScope): Promise<void> {
    await this.clearFreeze(scope, 'off', 'unsuspend');
  }

  private async setFreeze(scope: FreezeScope, mode: FreezeRow['mode'], by: string | undefined, call: string): Promise<void> {
    assertFreezeScope(scope, call);
    const ready = await this.requireStorage(call);
    const row = freezeRowOf(scope, mode, by, this.clock());
    const write = async (): Promise<void> => {
      await ready.store.insertFreeze(row);
      if (!this.freezes.some((r) => r.scopeKey === row.scopeKey && r.mode === mode)) this.freezes = [...this.freezes, row];
    };
    if (!('learner' in scope)) return write();
    // A learner's row names its user: inside the user's write chain, a forgotten user gets none.
    const { namespace, userId } = scope.learner;
    return this.chains.run(userChainKey(namespace, userId), async () => {
      await this.refuseForgotten(ready.store, { namespace, userId }, call);
      await write();
    });
  }

  private async clearFreeze(scope: FreezeScope, mode: FreezeRow['mode'], call: string): Promise<void> {
    assertFreezeScope(scope, call);
    const ready = await this.requireStorage(call);
    const scopeKey = freezeScopeKey(scope);
    await ready.store.deleteFreeze(scopeKey, mode);
    this.freezes = this.freezes.filter((r) => !(r.scopeKey === scopeKey && r.mode === mode));
  }

  async operatorSet(input: OperatorSetInput): Promise<LedgerEntry> {
    const call = 'operatorSet';
    const key = this.learnerOf(input?.learner, call);
    const by = operatorOf(input.by, call);
    const traits = input.traits;
    if (traits !== 'baseline' && (traits === null || typeof traits !== 'object' || Array.isArray(traits))) {
      throw new TypeError(`${call}: traits must be 'baseline' or a map of trait values.`);
    }
    const ready = await this.requireStorage(call);
    return this.chains.run(userChainKey(key.namespace, key.userId), async () => {
      await this.refuseForgotten(ready.store, key, call);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const record = await readLearnerRecord(ready.store, ready.ledger, key);
        // A record that does not verify is re-anchored from what is still trustworthy: where the chain verifies and the
        // row does not match it, the row was edited outside the layer, so the state the ledger recorded last (the
        // `after` of the candidate whose verdict carries the newest digest); where the chain itself does not verify, the
        // row as stored. A learner with neither has no row to set.
        const recorded = stateOfRecord(recordedTraitState(record.entries)?.after);
        const base = !record.verified && record.chainOk && recorded ? recorded : (record.state ?? recorded);
        if (!base) {
          throw new Error(`${call}: learner '${key.userId}' of agent '${key.agentKey}' has no trait row; it is written at the learner's first session.`);
        }
        const { state: next, operator } = withOperatorSet(base, traits, record.operator);
        const written = await writeTraitRow({
          ledger: ready.ledger,
          key,
          personaId: record.row?.personaId ?? '',
          now: this.clock,
          ...(record.row && record.state ? { current: { row: record.row, state: record.state } } : {}),
          before: { state: base, operator: record.operator },
          next,
          operator,
          actor: `operator:${by}`,
          reason: !record.verified ? 'reanchor' : traits === 'baseline' ? 'baseline' : 'set',
          ...(input.note ? { evidence: { note: input.note } } : {}),
        });
        if (written === 'moved') continue;
        if (written === 'forgotten') throw new Error(`${call}: the user is forgotten in this namespace; nothing is written for them again.`);
        if (written === 'conflict') throw new Error(`${call}: other writers held the learner's ledger chain; call again.`);
        this.bumpTraitEpoch(key);
        this.noteChain(key, false);
        return written.entry;
      }
      throw new Error(`${call}: the trait row kept moving; call again.`);
    });
  }

  async revert(ledgerId: string, by: string): Promise<LedgerEntry> {
    const call = 'revert';
    const operator = operatorOf(by, call);
    if (typeof ledgerId !== 'string' || ledgerId === '') throw new TypeError(`${call}: name the candidate by its ledger id.`);
    const ready = await this.requireStorage(call);
    const stored = await ready.store.ledgerRow(ledgerId);
    const original = stored?.rowType === 'candidate' ? (parseJson(stored.body) as LedgerEntry | undefined) : undefined;
    if (!original) throw new Error(`${call}: no candidate ${ledgerId} in the ledger.`);
    if (original.kind === 'operator_set') return this.revertOperatorSet(ready, original, operator);
    if (original.kind === 'memory_write') return this.revertMemoryWrite(ready, original, operator);
    throw new Error(`${call}: a ${original.kind} change is reverted by the release that records it.`);
  }

  /** The inverse of each trait step and each operator trait, with the original's `reverted` verdict, in one transaction. */
  private async revertOperatorSet(ready: { store: LearningStore; ledger: Ledger }, original: LedgerEntry, by: string): Promise<LedgerEntry> {
    const call = 'revert';
    if (LOAD_REASONS.includes(original.reason)) {
      const writer = original.reason === 'reanchor' ? 'from which the learner\'s record verifies' : 'which a load writes';
      throw new Error(`${call}: candidate ${original.id} is the trait row's ${original.reason} row, ${writer}; set the learner with operatorSet instead.`);
    }
    const userId = original.learner.userId;
    if (userId === null) throw new Error(`${call}: candidate ${original.id} names no learner.`);
    const key: LearnerKey = { namespace: original.learner.namespace, agentKey: original.learner.agentKey, userId };
    return this.chains.run(userChainKey(key.namespace, key.userId), async () => {
      await this.refuseForgotten(ready.store, key, call);
      await this.refuseUnlessKept(ready.ledger, original.id, call);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const record = await readLearnerRecord(ready.store, ready.ledger, key);
        if (!record.verified) throw new Error(`${call}: the learner's record does not verify (${record.reason}); re-anchor it with operatorSet first.`);
        if (!record.row || !record.state) throw new Error(`${call}: learner '${key.userId}' of agent '${key.agentKey}' has no trait row.`);
        const inverse = invertOperatorSet(original, record.state, record.operator);
        const written = await writeTraitRow({
          ledger: ready.ledger,
          key,
          personaId: record.row.personaId,
          now: this.clock,
          current: { row: record.row, state: record.state },
          before: { state: record.state, operator: record.operator },
          next: inverse.state,
          operator: inverse.operator,
          actor: `operator:${by}`,
          reason: 'revert',
          evidence: { note: `revert of ${original.id}` },
          alsoDecide: [{ candidateId: original.id, verdict: 'reverted', reason: 'reverted' }],
        });
        if (written === 'moved') continue;
        if (written === 'forgotten') throw new Error(`${call}: the user is forgotten in this namespace; nothing is written for them again.`);
        if (written === 'conflict') throw new Error(`${call}: other writers held the learner's ledger chain; call again.`);
        this.bumpTraitEpoch(key);
        return written.entry;
      }
      throw new Error(`${call}: the trait row kept moving; call again.`);
    });
  }

  /**
   * In the brain the row names, through that brain's facade: a pending row, the undo (the written traces deleted,
   * the before-state restored), then `kept`, then the original's `reverted` verdict. The revert's row records every
   * trace it touches as it stands before the undo, so a revert of the revert, or a crash's recovery of it, puts each
   * back. A user forgotten while it ran, in this process or another, gets nothing back, and a verdict that does not land
   * fails the call. A write of several traces is taken back as its kept verdict records it: what it inserted goes, and
   * only the traces it changed or forgot come back.
   */
  private async revertMemoryWrite(ready: { store: LearningStore; ledger: Ledger }, original: LedgerEntry, by: string): Promise<LedgerEntry> {
    const call = 'revert';
    // What the write did: its kept verdict's record where it has one (a write of several traces), else its plan.
    const kept = await ready.ledger.latestVerdictEntry(original.id);
    const change = parseMemoryWrite(kept?.after) ?? parseMemoryWrite(original.after);
    if (!change) throw new Error(`${call}: candidate ${original.id} records no memory write the layer can read.`);
    const facade = this.facades.get(change.brainId);
    if (!facade) throw new Error(`${call}: the layer holds no memory tools facade of brain ${change.brainId}.`);
    // Only the traces the write changed or deleted come back: one it meant to forget and did not is left as it is.
    const touched = new Set([...change.deleted, ...change.changed.map((trace) => trace.id)]);
    const recorded = parseMemoryBefore(original.before);
    const before = recorded ? { traces: recorded.traces.filter((trace) => touched.has(trace.id)) } : null;
    const namespace = original.learner.namespace;
    const owner = original.learner.userId ?? original.turnUserId ?? null;
    const chainKey = owner ? userChainKey(namespace, owner) : sessionChainKey(original.sessionId ?? '');
    return this.chains.run(chainKey, async () => {
      if (owner) await this.refuseForgotten(ready.store, { namespace, userId: owner }, call);
      await this.refuseUnlessKept(ready.ledger, original.id, call);
      // What the revert's own row records, so a revert of it, or a crash's recovery of it, puts each trace back: every
      // trace it touches by its snapshot now (a deleted one is deleted again); a trace it restores as changed, and as
      // created where it is gone; and a trace it deletes, a created one of the original's or one the original found
      // deleted, as deleted.
      const snapshots: TraceSnapshot[] = [];
      for (const id of change.created) {
        const snapshot = await facade.readTrace?.(id);
        if (snapshot && !snapshot.deleted) snapshots.push(snapshot);
      }
      const created: string[] = [];
      const changed: Array<{ id: string; content: string }> = [];
      const deleted = [...change.created];
      for (const trace of before?.traces ?? []) {
        const snapshot = await facade.readTrace?.(trace.id);
        if (snapshot) snapshots.push(snapshot);
        if (trace.deleted) deleted.push(trace.id);
        else if (snapshot) changed.push({ id: trace.id, content: trace.content });
        else created.push(trace.id);
      }
      const own: MemoryWriteChange = { brainId: change.brainId, created, changed, deleted };
      const ownBefore = { traces: snapshots };
      const proposed = await ready.ledger.propose(
        {
          learner: original.learner,
          kind: 'memory_write',
          actor: `operator:${by}`,
          subject: original.subject,
          before: ownBefore,
          after: own,
          evidence: { note: `revert of ${original.id}` },
          ...(original.sessionId !== undefined ? { sessionId: original.sessionId } : {}),
          ...(original.turnUserId ? { turnUserId: original.turnUserId } : {}),
        },
        { operator: true },
      );
      if (!('candidate' in proposed)) throw new Error(`${call}: the revert's row was not written (${proposed.status}).`);
      const id = proposed.candidate.id;
      const restored = (before?.traces ?? []).filter((trace) => !trace.deleted).map((trace) => trace.id);
      const forgottenNow = async (): Promise<boolean> =>
        owner !== null && (await ready.store.isForgotten(await tombstoneHash(namespace, owner)));
      // The user was forgotten while the revert ran: what it restored is deleted again, with the user's rows.
      const takeBackForgotten = async (): Promise<never> => {
        await facade.deleteTraces?.(restored);
        if (owner) await this.purgeUserRows(namespace, owner);
        throw new Error(`${call}: the user was forgotten while the revert ran; what it restored is deleted again.`);
      };
      this.inFlight.add(id);
      try {
        try {
          await undoMemoryWrite(facade, change, before);
        } catch (error) {
          await ready.ledger.decide(id, 'rejected', 'write_failed').catch(() => undefined);
          throw error;
        }
        if (await forgottenNow()) return await takeBackForgotten();
        // A verdict is refused on a chain another process's forgetUser marked or deleted meanwhile.
        const kept = await ready.ledger.decide(id, 'kept', 'reverted');
        if (kept.status !== 'kept') {
          if (kept.status === 'forgotten' || (await forgottenNow())) return await takeBackForgotten();
          await undoMemoryWrite(facade, own, ownBefore);
          await ready.ledger.decide(id, 'rejected', 'write_failed').catch(() => undefined);
          throw new Error(`${call}: the revert's verdict was not written (${kept.status}); what it changed is put back; call again.`);
        }
        const reverted = await ready.ledger.decide(original.id, 'reverted', `reverted by ${id}`);
        if (reverted.status !== 'reverted') {
          if (reverted.status === 'forgotten' || (await forgottenNow())) return await takeBackForgotten();
          throw new Error(`${call}: candidate ${original.id} did not take its reverted verdict (${reverted.status}); the revert ${id} is kept.`);
        }
        return proposed.candidate;
      } finally {
        this.inFlight.delete(id);
      }
    });
  }

  async exportLearnedState(key: LearnerKey): Promise<LearnedStateDocument> {
    const call = 'exportLearnedState';
    const learner = this.learnerOf(key, call);
    const ready = await this.requireStorage(call);
    const exportedAt = new Date(this.clock()).toISOString();
    // A forgotten user's document is empty: the rows a forgetUser keeps while a store it must reach fails are kept for
    // its second call, never handed out.
    if (await ready.store.isForgotten(await tombstoneHash(learner.namespace, learner.userId))) {
      return { version: 1, learner, personaId: null, traitState: null, lessons: [], skills: [], ledger: [], outcomes: [], exportedAt };
    }
    const read = await ready.store.transaction(async (tx) => ({
      row: await tx.traitRow(learner.namespace, learner.agentKey, learner.userId),
      ledger: await tx.learnerLedgerRows(learner.namespace, learner.agentKey, learner.userId),
      lessons: await tx.learnerDocs('lessons', learner.namespace, learner.agentKey, learner.userId),
      skills: await tx.learnerDocs('skills', learner.namespace, learner.agentKey, learner.userId),
      outcomes: await tx.learnerDocs('outcomes', learner.namespace, learner.agentKey, learner.userId),
    }));
    const bodyOf = (doc: { id: string; body: string }): unknown => parseJson(doc.body) ?? { id: doc.id, body: doc.body };
    const traitState = read.row ? parseJson(read.row.state) : undefined;
    return {
      version: 1,
      learner,
      personaId: read.row?.personaId ?? null,
      traitState: traitState && typeof traitState === 'object' ? (traitState as Record<string, unknown>) : null,
      lessons: read.lessons.map(bodyOf),
      skills: read.skills.map(bodyOf),
      ledger: read.ledger.map((row) => ({ ...(JSON.parse(row.body) as LedgerEntry), hash: row.hash })),
      outcomes: read.outcomes.map(bodyOf),
      exportedAt,
    };
  }

  async importLearnedState(doc: LearnedStateDocument, target?: LearnerKey): Promise<ImportReport> {
    const call = 'importLearnedState';
    assertLearnedStateDocument(doc, call);
    const key = this.learnerOf(target ?? doc.learner, call);
    if (!target && this.config.agentKey && key.agentKey !== this.config.agentKey) {
      throw new Error(`${call}: the document is for agent '${key.agentKey}' and this layer serves '${this.config.agentKey}'; name the target to import it here.`);
    }
    const ready = await this.requireStorage(call);
    return this.chains.run(userChainKey(key.namespace, key.userId), async () => {
      await this.refuseForgotten(ready.store, key, call);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const record = await readLearnerRecord(ready.store, ready.ledger, key);
        if (!record.verified) throw new Error(`${call}: the target's learning record does not verify (${record.reason}); re-anchor it with operatorSet first.`);
        const admission = admitImport(doc, record.state, record.operator, this.clock());
        const imported = { taken: admission.taken, refused: admission.refused };
        const evidence = {
          note: `import: took ${admission.taken.length} item(s), refused ${admission.refused.length}`,
        };
        if (!admission.next) {
          // Nothing of the trait state to take: the import's row records what it refused.
          const result = await ready.ledger.propose(
            { learner: key, kind: 'operator_set', actor: 'operator:import', subject: 'import', before: null, after: { imported }, evidence },
            { verdict: 'kept', reason: 'import', operator: true },
          );
          if (!('candidate' in result)) throw new Error(`${call}: the import's row was not written (${result.status}).`);
          return { target: key, ...imported, ledgerId: result.candidate.id };
        }
        const written = await writeTraitRow({
          ledger: ready.ledger,
          key,
          personaId: record.row?.personaId ?? doc.personaId ?? '',
          now: this.clock,
          ...(record.row && record.state ? { current: { row: record.row, state: record.state }, before: { state: record.state, operator: record.operator } } : {}),
          next: admission.next,
          operator: record.operator,
          actor: 'operator:import',
          reason: 'import',
          evidence,
          afterExtra: { imported },
        });
        if (written === 'moved') continue;
        if (written === 'forgotten') throw new Error(`${call}: the user is forgotten in this namespace; nothing is written for them again.`);
        if (written === 'conflict') throw new Error(`${call}: other writers held the learner's ledger chain; call again.`);
        this.bumpTraitEpoch(key);
        return { target: key, ...imported, ledgerId: written.entry.id };
      }
      throw new Error(`${call}: the trait row kept moving; call again.`);
    });
  }

  /**
   * Deletes a user: takes the user's write chain, so every write this process admitted for the user reaches
   * its verdict first; commits the tombstone that every later write for the user in the namespace reads; marks the
   * user's chain heads forgotten; then deletes, one transaction per store: the user's traces in every memory manager
   * still alive and every facade the layer holds (a second user's traces on another user's session by `turnUserId`,
   * and the traces its ledger rows name), the brains its session rows name that neither holds, through the host's
   * storage adapter, and last every learning-store row of the user. Names every store it did not reach. While a store it
   * must reach fails, the user's learning-store rows stay: they are the index of what the call deletes (the user's
   * sessions, their forms and threads, the traces a second user's rows name), and a second call reads them to delete
   * what the first could not.
   */
  async forgetUser(userId: string, options: { namespace?: string } = {}): Promise<ForgetReport> {
    const call = 'forgetUser';
    if (typeof userId !== 'string' || userId.trim() === '') throw new TypeError(`${call}: name the user by a non-blank id.`);
    const namespace = options?.namespace ?? '';
    if (typeof namespace !== 'string') throw new TypeError(`${call}: options.namespace must be a string.`);
    const ready = await this.requireStorage(call);
    return this.chains.run(userChainKey(namespace, userId), () => this.forgetInChain(ready, namespace, userId));
  }

  private async forgetInChain(ready: { store: LearningStore; ledger: Ledger }, namespace: string, userId: string): Promise<ForgetReport> {
    const { store } = ready;
    // Committed before any delete starts, so a write in another process that commits during the deletion finds it.
    await store.insertForgotten(await tombstoneHash(namespace, userId), new Date(this.clock()).toISOString());
    await store.markHeadsForgotten(namespace, userId);
    const rows = await store.sessionRowsOf(namespace, userId);
    const named = await this.tracesNamedForVisitor(store, namespace, userId, rows);
    const targets = forgetTargets(namespace, userId, rows);
    const stores: ForgetReport['stores'] = [];
    const reached = new Set<string>();
    /** The brains whose delete failed here; a failure in a store with no brain id is `failedElsewhere`. */
    const failed = new Set<string>();
    let failedElsewhere = false;

    for (const manager of this.liveManagers()) {
      const brain = brainOfManager(manager);
      const name = brain ? `memory manager of brain ${brain.brainId}` : 'memory manager with no Brain';
      if (typeof manager.deleteScope !== 'function') {
        stores.push({ store: name, reached: false, reason: 'it has no deleteScope' });
        continue;
      }
      try {
        let deleted = 0;
        let graph = true;
        for (const target of targets) {
          const result = await manager.deleteScope(target.scope, target.scopeId, target.turnUserId ? { turnUserId: target.turnUserId } : undefined);
          deleted += result.deleted;
          graph &&= result.graph === 'reached';
        }
        const ids = brain ? named.get(brain.brainId) : undefined;
        if (ids?.size && manager.deleteTraces) deleted += (await manager.deleteTraces([...ids])).deleted;
        stores.push({ store: name, reached: true, deleted });
        if (!graph) stores.push({ store: `the knowledge graph of the ${name}`, reached: false, reason: 'it has no deleteMemories, so the episodic copies of the deleted traces stay' });
        if (brain) reached.add(brain.brainId);
      } catch (error) {
        stores.push({ store: name, reached: false, reason: messageOf(error) });
        if (brain) failed.add(brain.brainId);
        else failedElsewhere = true;
      }
    }

    for (const facade of this.facadeList) {
      const name = this.facadeName(facade);
      if (typeof facade.deleteScope !== 'function') continue; // named among the unreached stores below
      try {
        let deleted = 0;
        for (const target of targets) {
          deleted += (await facade.deleteScope(target.scope, target.scopeId, target.turnUserId ? { turnUserId: target.turnUserId } : {})).deleted;
        }
        const brainId = facadeBrainId(facade);
        const ids = brainId ? named.get(brainId) : undefined;
        if (ids?.size && facade.deleteTraces) deleted += (await facade.deleteTraces([...ids])).deleted;
        stores.push({ store: name, reached: true, deleted });
        if (brainId) reached.add(brainId);
      } catch (error) {
        stores.push({ store: name, reached: false, reason: messageOf(error) });
        const brainId = facadeBrainId(facade);
        if (brainId) failed.add(brainId);
        else failedElsewhere = true;
      }
    }

    const failedHere = new Set(failed);
    for (const brainId of new Set([...rows.flatMap((row) => row.brainIds), ...named.keys(), ...failedHere])) {
      if (reached.has(brainId)) continue;
      const { entry, failed: adapterFailed } = await this.forgetOnAdapter(brainId, targets, named.get(brainId));
      if (entry.reached) reached.add(brainId);
      if (adapterFailed) failed.add(brainId);
      // A brain whose manager or facade failed above is named once, by that failure, unless the adapter reached it.
      if (entry.reached || adapterFailed || !failedHere.has(brainId)) stores.push(entry);
    }

    // The learning store last: its rows are the index of everything above, so they stay while a store above failed.
    if (failedElsewhere || [...failed].some((brainId) => !reached.has(brainId))) {
      stores.push({
        store: 'learning store',
        reached: false,
        reason: "the user's rows are the index of the stores above that failed, so they stay until a call reaches each of them: call forgetUser again",
      });
    } else {
      stores.push({ store: 'learning store', reached: true, deleted: await store.deleteUserRows(namespace, userId) });
    }
    for (const { store: unreached, reason } of this.unreachedStores()) stores.push({ store: unreached, reached: false, reason });

    let plainFormLeft = 0;
    if (namespace !== '') {
      const plain = await this.countPlainForm(userId, rows);
      plainFormLeft = plain.left;
      if (plain.left > 0) {
        // A line about a forgotten user names the tombstone, never the user: the caller holds the id it deleted.
        const hash = (await tombstoneHash(namespace, userId)).slice(0, 16);
        console.warn(
          `[agentos] learning: forgetUser (tombstone ${hash}) left ${plain.left} trace(s) filed before the namespace, under the user's plain id in its ${plain.scopes.join(' and ')}; re-file them in the namespaced form with MemoryStore.refileScope, then call forgetUser again.`,
        );
      }
    }

    await this.refreshFreezes();
    for (const agentKey of new Set([...rows.map((row) => row.agentKey), ...(this.config.agentKey ? [this.config.agentKey] : [])])) {
      const key = { namespace, agentKey, userId };
      this.noteChain(key, false);
      this.bumpTraitEpoch(key);
    }
    return { userId, namespace, stores, plainFormLeft };
  }

  /** The traces a user's rows as a second user name (`turnUserId` chains), by brain id, read before the rows go. */
  private async tracesNamedForVisitor(store: LearningStore, namespace: string, userId: string, rows: readonly SessionRow[]): Promise<Map<string, Set<string>>> {
    const named = new Map<string, Set<string>>();
    const agents = new Set([...rows.map((row) => row.agentKey), ...(this.config.agentKey ? [this.config.agentKey] : [])]);
    for (const agentKey of agents) {
      for (const stored of await store.chainRows(chainKeyOf({ namespace, agentKey, userId: null }, userId))) {
        if (stored.rowType !== 'candidate' || stored.kind !== 'memory_write') continue;
        const change = parseMemoryWrite((parseJson(stored.body) as { after?: unknown } | undefined)?.after);
        if (!change) continue;
        const ids = named.get(change.brainId) ?? new Set<string>();
        for (const id of [...change.created, ...change.changed.map((c) => c.id)]) ids.add(id);
        named.set(change.brainId, ids);
      }
    }
    return named;
  }

  /**
   * Deletes in a brain no live manager or facade reached, through a facade over the host's storage adapter when the
   * adapter holds that brain's traces. The facade is never closed: closing its Brain would close the host's adapter.
   *
   * @returns The brain's report entry, and whether the delete failed there (a second call tries it again).
   */
  private async forgetOnAdapter(
    brainId: string,
    targets: readonly ForgetTarget[],
    ids: Set<string> | undefined,
  ): Promise<{ entry: ForgetReport['stores'][number]; failed: boolean }> {
    const adapter = this.host.storageAdapter;
    const unreached = (reason: string, failed = false) => ({ entry: { store: `brain ${brainId}`, reached: false as const, reason }, failed });
    if (!adapter) return unreached('no memory manager or facade of it is alive here, and the layer has no storage adapter to open it on');
    try {
      const held = await adapter.get<{ id: string }>('SELECT id FROM memory_traces WHERE brain_id = ? LIMIT 1', [brainId]);
      if (!held) return unreached("no memory manager or facade of it is alive here, and the host's storage adapter holds none of its traces");
      const { Memory } = await import('../memory/io/facade/Memory.js');
      const facade = await Memory.createWithAdapter(adapter, { brainId, selfImprove: false });
      let deleted = 0;
      for (const target of targets) {
        deleted += (await facade.deleteScope(target.scope, target.scopeId, target.turnUserId ? { turnUserId: target.turnUserId } : {})).deleted;
      }
      if (ids?.size) deleted += (await facade.deleteTraces([...ids])).deleted;
      return { entry: { store: `brain ${brainId} on the host's storage adapter`, reached: true, deleted }, failed: false };
    } catch (error) {
      return unreached(messageOf(error), true);
    }
  }

  /** The user's plain-form traces left on the brains the layer reaches: counted, never deleted by a namespaced call. */
  private async countPlainForm(userId: string, rows: readonly SessionRow[]): Promise<{ left: number; scopes: string[] }> {
    const scopes = plainScopesOf(userId, rows);
    const holding = new Set<string>();
    let left = 0;
    const tally = async (count: Promise<number>, label: string): Promise<void> => {
      const n = await count.catch(() => 0);
      if (n > 0) {
        left += n;
        holding.add(label);
      }
    };
    for (const manager of this.liveManagers()) {
      const brain = brainOfManager(manager);
      if (!brain) continue;
      for (const { scope, scopeId, label } of scopes) await tally(countOn(brain, brain.brainId, scope, scopeId), label);
    }
    for (const facade of this.facadeList) {
      if (typeof facade.countScope !== 'function') continue;
      for (const { scope, scopeId, label } of scopes) await tally(facade.countScope(scope, scopeId), label);
    }
    return { left, scopes: [...holding] };
  }

  /** When this layer last began deciding the pending memory writes of each agent's chains with no learner, on its clock. */
  private readonly agentChainReads = new Map<string, number>();

  /**
   * Decides a crash's pending memory writes: a row older than 15 minutes on the layer's clock that no write of this
   * process holds is `kept` where its traces hold the change, and otherwise `rejected` (`write_failed`) and taken
   * back as far as the write itself left its traces (`leftByCrash`: a trace a later write of its chain names, or one
   * the write did not leave, stays); a row whose brain the layer holds no facade of stays pending. The learner's own
   * chain is decided before the open goes on. The agent's chains with no learner in that namespace (its own, which
   * holds every recorded write with no user, and each second user's) grow with the agent's anonymous sessions and its
   * visitors, so their pending rows are read alone and decided off the open's path, at most once per 15 minutes per
   * agent and namespace: an open's cost stays bounded by its learner's own history, but for a row whose traces do not
   * hold it, whose chain is read once more for the later writes that name its traces. Never throws.
   */
  async recoverPending(key: LearnerKey): Promise<void> {
    const ready = await this.storage();
    if (!ready) return;
    const agentChains = chainKeyOf({ namespace: key.namespace, agentKey: key.agentKey, userId: null });
    const lastRead = this.agentChainReads.get(agentChains);
    if (lastRead === undefined || this.clock() - lastRead >= PENDING_AGE_MS) {
      this.agentChainReads.set(agentChains, this.clock());
      void this.decideAgentPending(ready.ledger, key).catch((error) => {
        console.warn(`[agentos] learning: the agent's pending memory writes were not decided (${messageOf(error)}); a later session tries again.`);
      });
    }
    await this.decidePendingOf(ready.ledger, chainKeyOf(key));
  }

  /** Decides the pending memory writes of the agent's chains with no learner in the learner's namespace. Never throws. */
  private async decideAgentPending(ledger: Ledger, key: LearnerKey): Promise<void> {
    let pending: LedgerEntry[];
    try {
      pending = await ledger.agentPending(key.namespace, key.agentKey, new Date(this.clock() - PENDING_AGE_MS).toISOString());
    } catch (error) {
      console.warn(`[agentos] learning: the agent's pending memory writes were not read (${messageOf(error)}); a later session reads them again.`);
      return;
    }
    await this.decideEach(ledger, pending);
  }

  /** Decides the pending memory writes of one chain. Never throws. */
  private async decidePendingOf(ledger: Ledger, chainKey: string): Promise<void> {
    let pending: LedgerEntry[];
    try {
      pending = await ledger.pendingCandidates(chainKey);
    } catch (error) {
      console.warn(`[agentos] learning: the pending memory writes were not read (${messageOf(error)}); a later session reads them again.`);
      return;
    }
    await this.decideEach(ledger, pending);
  }

  /** Decides each pending memory write old enough, in its owner's write chain. Never throws. */
  private async decideEach(ledger: Ledger, pending: readonly LedgerEntry[]): Promise<void> {
    const cutoff = this.clock() - PENDING_AGE_MS;
    for (const entry of pending) {
      if (entry.kind !== 'memory_write' || this.inFlight.has(entry.id) || Date.parse(entry.createdAt) > cutoff) continue;
      const change = parseMemoryWrite(entry.after);
      const facade = change ? this.facades.get(change.brainId) : undefined;
      if (!change || !facade || typeof facade.readTrace !== 'function') continue;
      const owner = entry.learner.userId ?? entry.turnUserId;
      const chain = owner ? userChainKey(entry.learner.namespace, owner) : sessionChainKey(entry.sessionId ?? '');
      try {
        await this.chains.run(chain, () => this.decidePending(ledger, entry, change, facade));
      } catch (error) {
        console.warn(`[agentos] learning: a pending memory write was not decided (${messageOf(error)}); a later session tries again.`);
      }
    }
  }

  private async decidePending(ledger: Ledger, entry: LedgerEntry, change: MemoryWriteChange, facade: LearningMemoryTools): Promise<void> {
    // Another process may have decided it since it was read.
    if ((await ledger.latestVerdict(entry.id)) !== 'pending') return;
    if (await memoryWriteHolds(change, (id) => facade.readTrace!(id))) {
      await ledger.decide(entry.id, 'kept', 'recovered');
      return;
    }
    // The verdict before the undo: a writer in another process that decides its write first keeps it, and the write
    // stays; one that decides after finds this verdict and takes its write back itself.
    const decided = await ledger.decide(entry.id, 'rejected', 'write_failed');
    if (decided.status !== 'rejected') return;
    try {
      // Only what the write itself left is taken back: a change made after the crash stays.
      const named = await this.namedLater(ledger, entry, change.brainId);
      const left = await leftByCrash(change, parseMemoryBefore(entry.before), (id) => facade.readTrace!(id), named);
      await undoMemoryWrite(facade, left.change, left.before);
    } catch (error) {
      console.warn(
        `[agentos] learning: a crash's pending memory write is rejected, and what it wrote in brain ${change.brainId} was not taken back (${messageOf(error)}).`,
      );
    }
  }

  /** The traces of one brain that the memory writes after `entry` on its chain name, but for a write rejected since. */
  private async namedLater(ledger: Ledger, entry: LedgerEntry, brainId: string): Promise<Set<string>> {
    const rows = await ledger.entries(chainKeyOf(entry.learner, entry.turnUserId ?? null));
    const rejected = new Set(rows.filter((row) => row.rowType === 'verdict' && row.verdict === 'rejected').map((row) => row.candidateId));
    const named = new Set<string>();
    for (const row of rows) {
      if (row.rowType !== 'candidate' || row.kind !== 'memory_write' || row.seq <= entry.seq || rejected.has(row.id)) continue;
      const later = parseMemoryWrite(row.after);
      if (!later || later.brainId !== brainId) continue;
      for (const id of [...later.created, ...later.changed.map((c) => c.id), ...later.deleted]) named.add(id);
    }
    return named;
  }
}

/**
 * Builds a learning layer.
 *
 * `gmi()` builds one per agent and the full runtime one per `AgentOS` when their `learning` option is on. A product
 * that builds its own memory manager and runs its own turn loop calls this itself, with `memory` and its
 * `storageAdapter`: `forLearner()` for each session, `prepareTurn()` before each turn, and the personality section it
 * returns goes into the system prompt.
 *
 * An option set to `null` reads as unset, as one read from JSON or YAML writes it, and takes its default.
 *
 * @throws {Error} Naming the field, when the config is not valid ({@link resolveLearningConfig}).
 */
export function createLearningLayer(options: LearningLayerOptions = {}): LearningLayerHandle {
  const { profile: givenProfile, surface: givenSurface, hostLoops, memory, storageAdapter, openStore, memoryFacades, ...config } = options;
  const profile = givenProfile ?? 'custom';
  return new LearningLayer(config, resolveLearningConfig(config, profile), {
    surface: givenSurface ?? 'custom',
    profile,
    hostLoops: hostLoops ?? undefined,
    memory: memory ?? undefined,
    storageAdapter: storageAdapter ?? undefined,
    openStore: openStore ?? undefined,
    memoryFacades: memoryFacades ?? undefined,
  });
}
