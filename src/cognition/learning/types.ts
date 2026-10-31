/**
 * @module learning/types
 *
 * The learning layer's contract: the host's `learning` option and the switches it resolves to, the learner a session
 * is bound to (one agent with one user, in one namespace), what a GMI asks the layer before each turn, what a tool
 * call is told about its turn, and the manifest that says which loops a deployment runs (docs/GMI.md, "Learning").
 */
import type { HexacoTraitValues } from '../substrate/personas/hexaco.js';

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
}

/** One session's view of the layer: what a GMI calls around its turns. */
export interface ILearnerSession {
  /** Called once per user turn, before the tool loop. */
  prepareTurn(input: TurnInputForLearning): Promise<TurnPreparation>;
  /** Ends the session. Safe to call more than once. */
  endSession(): Promise<void>;
  /** The traits the session renders. */
  currentTraits(): HexacoTraitValues;
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
  /** Releases the layer. A session asked for afterwards is refused. */
  close(): Promise<void>;
}

/** What a tool call is told about the turn it runs in: `ToolExecutionContext.sessionData.learning`. */
export interface ToolLearningContext {
  learner: 'bound' | 'none';
  mode: LearningMode;
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
}
