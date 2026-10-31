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
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { ICognitiveMemoryManager } from '../memory/CognitiveMemoryManager.js';
import { processIsFrozen, resolveLearningConfig, resolveTurnMode } from './config.js';
import { freezeCovers, type FreezeTarget } from './hostCalls.js';
import { canonicalJson } from './ledger/canonical.js';
import { Ledger, tombstoneHash } from './ledger/Ledger.js';
import { LearnerSession, type LearnerSessionHost, type SessionBinding } from './LearnerSession.js';
import { buildManifest } from './manifest.js';
import { InMemoryLearningStore } from './store/InMemoryLearningStore.js';
import type { FreezeRow, LearningStore } from './store/LearningStore.js';
import { SqlLearningStore } from './store/SqlLearningStore.js';
import {
  DEFAULT_ANONYMOUS_USER_IDS,
  type HostLoopName,
  type ILearnerSession,
  type ILearningLayer,
  type LearnerContext,
  type LearnerKey,
  type LearningConfig,
  type LearningMemoryTools,
  type LearningMode,
  type LearningProfile,
  type LoopManifest,
  type LoopState,
  type NoLearnerReason,
  type ResolvedLearning,
} from './types.js';
import { WriteChains } from './writeChains.js';

const IN_PROCESS = 'in process: the ledger and the state it records end with the process';

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

class LearningLayer implements ILearningLayer, LearnerSessionHost {
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
    });
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
    await this.storage();
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
export function createLearningLayer(options: LearningLayerOptions = {}): ILearningLayer {
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
