/**
 * @module learning/types
 *
 * The learning layer's contract: the host's `learning` option and the switches it resolves to, the learner a session
 * is bound to (one agent with one user, in one namespace), what a GMI asks the layer before each turn, the scope ids a
 * turn files and reads its memory under, a ledger row and the memory writes a session records, the operator's host
 * calls and what they return, what a tool call is told about its turn, and the manifest that says which loops a
 * deployment runs (docs/GMI.md, "Learning").
 */
import type { ICognitiveMemoryManager } from '../memory/CognitiveMemoryManager.js';
import type { TraceSnapshot } from '../memory/retrieval/store/tracePersistence.js';
import type { HexacoTraitValues } from '../substrate/personas/hexaco.js';
import type { LearningStore } from './store/LearningStore.js';

/**
 * `on`: everything the switches allow. `frozen`: learned state is read and no new change is made. `off`: learned
 * state is neither read nor written, the persona's authored traits render, and the self-modification tools refuse.
 */
export type LearningMode = 'on' | 'frozen' | 'off';

export const LEARNING_MODES: readonly LearningMode[] = ['on', 'frozen', 'off'];

/** Set to `1`, the environment variable that freezes the whole process. */
export const LEARNING_FREEZE_ENV = 'AGENTOS_LEARNING_FREEZE';

/** Set to `1`, the environment variable that puts every learning layer of the process in mode `off`. */
export const LEARNING_OFF_ENV = 'AGENTOS_LEARNING_OFF';

/** The user ids that never name a learner, whatever a host adds to them. */
export const DEFAULT_ANONYMOUS_USER_IDS: readonly string[] = ['', 'anonymous_user', 'anonymous', 'system', 'guest'];

/** What a ledger row records a change to. */
export type LearningKind =
  | 'trait'
  | 'lesson'
  | 'skill'
  | 'workflow'
  | 'tool_policy'
  | 'setting'
  | 'skill_toggle'
  | 'session_tool'
  | 'session_workflow'
  | 'memory_write'
  | 'memory_rewrite'
  | 'reflection_supersede'
  | 'operator_set';

/** A candidate's state: its latest verdict row decides it. */
export type LedgerVerdict = 'pending' | 'kept' | 'reverted' | 'rejected';

/** Whose a ledger row is: a learner, or, with `userId: null`, the agent (a turn with no learner, a persona-scope change). */
export interface LedgerLearner {
  namespace: string;
  agentKey: string;
  userId: string | null;
}

/** What a ledger row cites. */
export interface LedgerEvidence {
  outcomeIds?: string[];
  feedbackEventId?: string;
  signals?: Record<string, number | string>;
  probeRunId?: string;
  hiddenTestRunId?: string;
  approvalId?: string;
  note?: string;
}

/** The versions a row was written under. */
export interface LedgerVersions {
  agentos: string;
  rules: string;
  renderer: number;
  probes: string;
  writer?: string;
  model: string;
}

/** One ledger row. Rows are never updated; a verdict is a row of its own that names its candidate. */
export interface LedgerEntry {
  /** A ULID. */
  id: string;
  rowType: 'candidate' | 'verdict';
  candidateId: string;
  learner: LedgerLearner;
  kind: LearningKind;
  /** `operator:<id>`, `operator:persona`, `tool:<name>`, `memory:<writer>`, `rule:<id>@<version>`, `gate`, `user:<id>`. */
  actor: string;
  /** A trait name or `traits`, a trace id or a set's id, a setting's name. */
  subject: string;
  before: unknown;
  after: unknown;
  evidence: LedgerEvidence;
  verdict: LedgerVerdict;
  reason: string;
  versions: LedgerVersions;
  sessionId?: string;
  /** On a `userId: null` row, the explicit id of a second user whose turn it records. */
  turnUserId?: string;
  /** The hash of the chain's previous row; 64 zeros on the first. */
  prevHash: string;
  /** The row's place in its chain, from 1. */
  seq: number;
  /** On a row that changes its subject's stored state, the digest of that state after the change. */
  stateDigest?: string;
  createdAt: string;
}

/** One agent with one user, in one namespace: what learned state belongs to. */
export interface LearnerKey {
  /** The organization the user belongs to; `''` when the host has none. */
  namespace: string;
  /** The agent: `learning.agentKey` when the host sets it, else the id of a registered persona or a named agent. */
  agentKey: string;
  /** The user's id, as the host passes it. */
  userId: string;
}

/**
 * The `learning` option. `true` or this object turns the learning layer on; unset or `false` leaves it off, and the
 * host's GMIs run as they did before the layer existed.
 */
export interface LearningConfig {
  /** Default `'on'`. */
  mode?: LearningMode;
  /** Names the agent its learners belong to. Unset: the id of the registered persona, or of a named `gmi()` agent. */
  agentKey?: string;
  /**
   * The organization of a `gmi()` agent's learners, fixed for the agent. The full runtime takes each turn's resolved
   * organization and refuses this field.
   */
  namespace?: string;
  /** User ids that never name a learner, added to {@link DEFAULT_ANONYMOUS_USER_IDS}. */
  anonymousUserIds?: string[];
  /** Asks for trait changes. Default: asked for in the `full` profile. The manifest says whether the loop runs. */
  traits?: boolean;
  /** Asks for lessons. Default: asked for in the `full` profile. The manifest says whether the loop runs. */
  lessons?: boolean;
  /** Asks for the skill library. Default: asked for in the `full` profile. The manifest says whether the loop runs. */
  skills?: boolean;
  /** Where learned state lives. Default: SQL over the host's storage adapter, else the process. */
  store?: LearningStore;
  /**
   * Keys every ledger hash (HMAC-SHA-256), so a writer of the store that cannot read it cannot recompute the chain.
   * A secret the store never holds; without it the manifest says `ledger: unkeyed`.
   */
  ledgerKey?: string;
  /** Milliseconds since the epoch; the ledger's and the trait row's clock. Default `Date.now`. */
  clock?: () => number;
  /**
   * The `Memory` facade the host's memory tools (and, on the full runtime, its standalone retriever and sink) are built
   * over: `forgetUser` deletes the user's scopes in its Brain and `revert` undoes a memory tool's write there. The full
   * runtime fills it; `gmi()` and a host that registers the tools itself pass it.
   */
  memoryTools?: LearningMemoryTools;
}

/** What the layer calls on a memory tools facade (`Memory`); it checks each member at run time. */
export interface LearningMemoryTools {
  readonly brainId?: string;
  deleteScope?(scope: string, scopeId: string, options?: { turnUserId?: string }): Promise<{ deleted: number }>;
  deleteTraces?(traceIds: readonly string[]): Promise<{ deleted: number }>;
  forget?(traceId: string): Promise<unknown>;
  restoreTrace?(traceId: string, before: TraceSnapshot): Promise<void>;
  /** One row as a snapshot (`readTraceSnapshot`); the layer decides a crash's `pending` memory write by it. */
  readTrace?(traceId: string): Promise<TraceSnapshot | undefined>;
  /** How many live traces one scope holds: `forgetUser` counts a user's plain-form traces it leaves. */
  countScope?(scope: string, scopeId: string): Promise<number>;
  ensureEncodedScopeIds?(): Promise<number>;
}

/** The scope ids a turn files and reads its own memory under, and the turn's mode. */
export interface TurnScopes {
  learner: 'bound' | 'none';
  /**
   * The turn's mode: `off` (the config, `AGENTOS_LEARNING_OFF=1` or a suspension of the turn's scope) stops the reads
   * of learned state and the five self-modification tools; `frozen` (the config, `AGENTOS_LEARNING_FREEZE=1` or a
   * run-time freeze) stops every new self-change.
   */
  mode: LearningMode;
  /** `<u>` of `user:<u>` for the turn's learner; the session's form when it has none. */
  userScopeId: string;
  /** `<u>::<personaId>`, or `<s>::<personaId>`. */
  personaScopeId: string;
  /** The namespace the session's form uses: a reader writes the turn's own thread ids with `taggedScopeId(id, namespace)`. */
  namespace: string;
}

/**
 * What a `memory_write` row's `after` records: the brain the write went to, and the traces it created, changed in
 * place (with the content it set) and deleted. A writer names its new trace ids before it writes, so a crash's
 * `pending` row can be decided by whether the traces hold the change.
 */
export interface MemoryWriteChange {
  brainId: string;
  created: string[];
  changed: Array<{ id: string; content: string }>;
  deleted: string[];
}

/** What a `memory_write` row's `before` records: every trace the write changes or deletes, as it stood. */
export interface MemoryWriteBefore {
  traces: TraceSnapshot[];
}

/** A memory write a learner session records (`memory_write`): the write itself, and how to take it back. */
export interface SessionSelfChange<T = unknown> {
  kind: 'memory_write';
  /** `tool:memory_add`, `memory:rolling_summary`. */
  actor: string;
  /** The trace id the write touches, or the id of the set it writes. */
  subject: string;
  /** What the write replaces: the snapshots of the traces it changes or deletes; `null` for a write that only adds. */
  before: MemoryWriteBefore | null;
  /** What the write sets; the layer adds `brainId`. */
  after: Omit<MemoryWriteChange, 'brainId'>;
  /** The brain the write goes to (`Memory.brainId`). */
  brainId: string;
  /** Makes the write; resolves once it has committed. */
  apply(): Promise<T>;
  /**
   * Takes back what `apply` wrote. `forgotten`: the write's user was forgotten once it had committed, so every trace
   * it created, changed or deleted is deleted for good and nothing is restored (a restore would bring back words the
   * deletion removed). `unrecorded`: its verdict could not be written, or the tombstone could not be read again, so
   * the traces it created are deleted and the ones it changed or deleted come back to their before-state.
   */
  undo(result: T, reason: 'forgotten' | 'unrecorded'): Promise<void>;
}

/**
 * What a recorded memory write came to: `kept` with its ledger row; `written` with no ledger row (mode `off` or a
 * suspension); or `rejected`, with the reason and, where one was written, the candidate's row.
 */
export type ProposalResult<T = unknown> =
  | { status: 'kept'; ledgerId: string; result: T }
  | { status: 'written'; result: T }
  | {
      status: 'rejected';
      reason: 'frozen' | 'forgotten' | 'write_failed' | 'conflict' | 'store_unavailable';
      ledgerId?: string;
      error?: unknown;
    };

/**
 * The turn a recorded or guarded write belongs to, as the GMI read it from that turn's own preparation: a learner's
 * turn keys the write to the learner; a turn with no learner keys it to the agent and the session, under the
 * session form's namespace, with a second user's explicit id in `turnUserId`.
 */
export interface SelfChangeTurn {
  learner: 'bound' | 'none';
  /** The namespace of the turn's scopes (`TurnScopes.namespace`). */
  namespace: string;
  /** On a turn with no learner: the explicit id of the user whose turn it is, when it is not the session's learner. */
  turnUserId?: string;
  /** The turn's conversation id: the session's row collects it, so `forgetUser` deletes the conversation's thread. */
  conversationId?: string;
}

/** A write of a user's memory that is not a self-change (the bridge's filing): guarded by the tombstone, never recorded. */
export interface GuardedMemoryWrite<T = unknown> {
  apply(): Promise<T>;
  undo(result: T): Promise<void>;
}

/** What a run-time freeze or suspension covers. */
export type FreezeScope = { scope: 'all' } | { agentKey: string } | { learner: LearnerKey };

/** An operator's change to a learner's traits. */
export interface OperatorSetInput {
  learner: LearnerKey;
  /** `baseline` resets the learner to the persona; a map sets those traits (honesty-humility and emotionality included). */
  traits: 'baseline' | HexacoTraitValues;
  /** The operator's id; the row's actor is `operator:<by>`. */
  by: string;
  note?: string;
}

/** A learner's learned state as one JSON document. */
export interface LearnedStateDocument {
  version: 1;
  learner: LearnerKey;
  personaId: string | null;
  /** The learner's stored trait state, or `null` for a learner with none. */
  traitState: Record<string, unknown> | null;
  lessons: unknown[];
  skills: unknown[];
  /** The learner's ledger rows, each with its hash. */
  ledger: Array<LedgerEntry & { hash: string }>;
  outcomes: unknown[];
  exportedAt: string;
}

/** What an import took and what it refused, and why. */
export interface ImportReport {
  target: LearnerKey;
  taken: Array<{ item: string; detail?: string }>;
  refused: Array<{ item: string; reason: string }>;
  /** The `operator_set` row the import wrote. */
  ledgerId?: string;
}

/** What `forgetUser` deleted, per store, and the stores it did not reach. */
export interface ForgetReport {
  userId: string;
  namespace: string;
  stores: Array<
    | { store: string; reached: true; deleted: number | Record<string, number> }
    | { store: string; reached: false; reason: string }
  >;
  /** With a namespace: the plain-form traces of the user id left on the Brains it reached. */
  plainFormLeft: number;
}

/** The cognition profile of the host that builds a layer; it sets the switches a config leaves unset. */
export type LearningProfile = 'light' | 'full' | 'custom';

/** The switches a host's `learning` option resolves to. */
export interface ResolvedLearning {
  mode: LearningMode;
  traits: boolean;
  lessons: boolean;
  skills: boolean;
}

/** Why a session, or one turn of it, has no learner. */
export type NoLearnerReason =
  /** The session was opened without a user id (`gmi()`), or the call is `generate()` or `stream()`. */
  | 'no_user_id'
  /** The user id is blank or one of the anonymous ids. */
  | 'placeholder_user'
  /** The agent has no stable id: a `gmi()` agent without a name and without `learning.agentKey`. */
  | 'no_agent_key'
  /**
   * A GMI built for a workflow role, a turn that carries `metadata.workflowId`, or a seat's session in an agency
   * (`sessionSeat()`, `launch_agency`), whatever user that session runs as.
   */
  | 'workflow_seat'
  /** The turn's user is not the session's first user; every later turn of the session has no learner either. */
  | 'other_user'
  /** The turn's namespace is not the session's; every later turn of the session has no learner either. */
  | 'other_namespace';

/** What the layer is told about the session a learner session serves. */
export interface LearnerContext {
  sessionId: string;
  personaId: string;
  /** The registry persona's traits, never a role overlay's. */
  authoredTraits: HexacoTraitValues;
  /** A workflow role overlay's patch, rendered for this session only. */
  overlayTraits?: HexacoTraitValues;
  /** Why the caller passes no key; read only when the key is `null`. Default `'no_user_id'`. */
  noLearnerReason?: NoLearnerReason;
  /** The host's cognition profile. Default: the layer's. */
  profile?: LearningProfile;
  /** The GMI's memory manager: hydrated for the learner, and reached by `forgetUser`. */
  memory?: ICognitiveMemoryManager;
}

/** What a GMI, or a product's own turn loop, tells its learner session before a turn. */
export interface TurnInputForLearning {
  turnId: string;
  /** This turn's own user; `null` for a turn that names none. */
  userId: string | null;
  /**
   * This turn's own namespace: on the full runtime the turn's resolved organization id, `''` when it has none; on
   * `gmi()`, whose turns carry no organization, `''`. Every turn is read against the namespace the session was opened
   * under.
   */
  namespace: string;
  /** The user's text; `null` for a tool continuation or a turn whose input is not plain text. */
  text: string | null;
  /** The models the turn may run on, primary first; empty when the caller resolves none before the turn. */
  modelIds: string[];
  /** True for a turn that carries `metadata.workflowId`. */
  workflowSeat: boolean;
  /** True for a tool continuation: it belongs to the turn it continues and is never read as another user's turn. */
  continuation?: boolean;
}

/** What a learner session prepares for a turn. Every model step of the turn uses the one preparation. */
export interface TurnPreparation {
  /** The personality section, when the traits render one: priority 2, source `learning:personality`. */
  systemPrompts: Array<{ content: string; priority: number; source: string }>;
  /** `none`: the authored traits render, nothing is learned from the turn, and the self-modification tools refuse. */
  learner: 'bound' | 'none';
  /** Set when `learner` is `none`. */
  noLearnerReason?: NoLearnerReason;
  /** The turn's mode: the configured mode with the process switches applied. */
  mode: LearningMode;
  /** The turn's scope ids, which the GMI puts on every tool call. */
  scopes?: TurnScopes;
  /**
   * On a turn with no learner: the turn's user id when it is explicit, outside the anonymous ids and not the session's
   * learner's. A write of the turn records it, so `forgetUser` for that user finds the write.
   */
  turnUserId?: string;
}

/** One session's view of the layer: what a GMI calls around its turns. */
export interface ILearnerSession {
  /** Called once per user turn, before the tool loop. */
  prepareTurn(input: TurnInputForLearning): Promise<TurnPreparation>;
  /** Ends the session. Safe to call more than once. */
  endSession(): Promise<void>;
  /** The traits the session renders. */
  currentTraits(): HexacoTraitValues;
  /**
   * The scope ids of a turn, by the session's rule, without counting the turn: the pipeline asks it for the standalone
   * retriever and sink before the GMI prepares the turn, and a turn of another user or namespace latches the session's
   * loss of its learner here as `prepareTurn` does.
   */
  scopesFor?(turn: { userId: string | null; namespace: string; workflowSeat: boolean }): TurnScopes;
  /**
   * Records a memory write: the freeze, the tombstone, a `pending` row, the write, the tombstone again, the verdict.
   * `turn` is the turn the write belongs to; without it, the session's own state (its learner unless a turn of
   * another user or namespace ended it).
   */
  recordSelfChange?<T>(input: SessionSelfChange<T>, turn?: SelfChangeTurn): Promise<ProposalResult<T>>;
  /**
   * Runs a write of the user's memory inside the user's write chain, with the tombstone read before and after it. A
   * store that cannot be read refuses the write (`store_unavailable`), so nothing is filed that a deletion could miss.
   */
  guardMemoryWrite?<T>(
    input: GuardedMemoryWrite<T>,
    turn?: SelfChangeTurn,
  ): Promise<{ status: 'written'; result: T } | { status: 'rejected'; reason: 'forgotten' | 'store_unavailable' }>;
  /**
   * Whether a freeze holds right now (`AGENTOS_LEARNING_FREEZE=1`, mode `frozen`, a run-time freeze) for the turn's
   * scope: the learner's on a learner's turn, the agent's on a turn with none; without `turn`, the session's own.
   */
  isFrozen?(turn?: SelfChangeTurn): boolean;
}

/** The learning layer of one agent or one runtime. */
export interface ILearningLayer {
  /** Which loops this deployment runs, and for each one that is off, why. */
  manifest(): Promise<LoopManifest>;
  /**
   * A learner session for one session of the host. `key` names the learner; `null`, a blank or anonymous user id,
   * or no agent key gives a session with no learner, which renders the authored traits and learns nothing.
   */
  forLearner(key: LearnerKey | null, context: LearnerContext): Promise<ILearnerSession>;
  /** Freezes learning for a scope at run time, persisted in the store; every new self-change of the scope is refused. */
  freeze?(scope: FreezeScope, by?: string): Promise<void>;
  unfreeze?(scope: FreezeScope): Promise<void>;
  /** Mode `off` at run time, persisted like a freeze. */
  suspend?(scope: FreezeScope, by?: string): Promise<void>;
  unsuspend?(scope: FreezeScope): Promise<void>;
  operatorSet?(input: OperatorSetInput): Promise<LedgerEntry>;
  revert?(ledgerId: string, by: string): Promise<LedgerEntry>;
  exportLearnedState?(key: LearnerKey): Promise<LearnedStateDocument>;
  importLearnedState?(doc: LearnedStateDocument, target?: LearnerKey): Promise<ImportReport>;
  forgetUser?(userId: string, options?: { namespace?: string }): Promise<ForgetReport>;
  /** Releases the layer. A session asked for afterwards is refused. */
  close(): Promise<void>;
}

/** The layer `createLearningLayer` returns: every host call is there. */
export type LearningLayerHandle = ILearningLayer &
  Required<
    Pick<
      ILearningLayer,
      | 'freeze'
      | 'unfreeze'
      | 'suspend'
      | 'unsuspend'
      | 'operatorSet'
      | 'revert'
      | 'exportLearnedState'
      | 'importLearnedState'
      | 'forgetUser'
    >
  >;

/** What a tool call is told about the turn it runs in: `ToolExecutionContext.sessionData.learning`. */
export interface ToolLearningContext {
  learner: 'bound' | 'none';
  mode: LearningMode;
  /** The turn's scope ids; with them the memory tools file and read the turn's own memory. */
  scopes?: TurnScopes;
  /** The session's recorder, bound by the GMI to the call's own turn: the memory tools write through it. */
  recordSelfChange?: <T>(input: SessionSelfChange<T>) => Promise<ProposalResult<T>>;
  /** On a second user's turn with no learner: that user's explicit id, written into each trace a memory tool files. */
  turnUserId?: string;
  /** Whether a freeze holds right now; read at the call. */
  frozen?: () => boolean;
}

/** The host's loops a manifest names. */
export const HOST_LOOP_NAMES = [
  'memory',
  'memory_mechanisms',
  'memory_observer_reflector',
  'memory_store',
  'sentiment',
  'metaprompts',
  'emergent_tools',
  'self_improvement_tools',
  'forged_code_executor',
  'hitl',
  'tool_policy',
  'rag',
] as const;

/** The learning layer's own loops. */
export const LEARNING_LOOP_NAMES = [
  'personality_rendering',
  'outcomes',
  'trait_changes',
  'lessons',
  'skills',
  'ledger',
] as const;

export type HostLoopName = (typeof HOST_LOOP_NAMES)[number];
export type LearningLoopName = (typeof LEARNING_LOOP_NAMES)[number];
export type LoopName = HostLoopName | LearningLoopName;

/** One loop's state in a manifest. */
export interface LoopState {
  /** Whether the loop runs. `'varies'`: a persona or a factory the host passes decides it per GMI. */
  live: boolean | 'varies';
  /** Why the loop is off, or what decides it. */
  detail?: string;
}

/** Which loops a deployment runs. */
export interface LoopManifest {
  manifestVersion: 1;
  /** The host that built the layer; `custom` is a product that calls the layer around its own turn loop. */
  surface: 'gmi' | 'runtime' | 'custom';
  profile: LearningProfile;
  /** The mode in effect: the configured mode with the process switches applied. */
  mode: LearningMode;
  /** What set the mode: the host's option, or the environment variable that overrides it. */
  modeSetBy: 'config' | typeof LEARNING_OFF_ENV | typeof LEARNING_FREEZE_ENV;
  loops: Record<LoopName, LoopState>;
  /** Whether the guardrails the self-change kinds wait for are in place. */
  guardrails: { complete: boolean; detail: string };
  /** The turns the layer prepared since it was built, and how many had no learner, by reason. */
  turns: { prepared: number; bound: number; none: Partial<Record<NoLearnerReason, number>> };
  /** The stores `forgetUser` does not reach, by name and why. */
  forgetUnreached?: string[];
  /** What a host must do itself for the loops to hold (a host that registers the memory tools itself). */
  notes?: string[];
}
