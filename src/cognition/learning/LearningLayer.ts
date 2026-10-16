/**
 * @module learning/LearningLayer
 *
 * The learning layer of one agent or one runtime. A host builds it only when its `learning` option is on; `gmi()`,
 * the full runtime and a product that runs its own turn loop all call the same layer. It binds each session to a
 * learner (one agent with one user, in one namespace), renders the personality section for every turn, and answers
 * with the manifest of the loops the deployment runs. It keeps no store: nothing here outlives the process.
 */
import { resolveLearningConfig, resolveTurnMode } from './config.js';
import { LearnerSession, type LearnerSessionHost, type SessionBinding } from './LearnerSession.js';
import { buildManifest } from './manifest.js';
import {
  DEFAULT_ANONYMOUS_USER_IDS,
  type HostLoopName,
  type ILearnerSession,
  type ILearningLayer,
  type LearnerContext,
  type LearnerKey,
  type LearningConfig,
  type LearningMode,
  type LearningProfile,
  type LoopManifest,
  type LoopState,
  type NoLearnerReason,
  type ResolvedLearning,
} from './types.js';

/** What a layer is built from: the host's `learning` config, and what the host says about itself. */
export interface LearningLayerOptions extends LearningConfig {
  /** The host's cognition profile, which sets the switches the config leaves unset. Default `'custom'`. */
  profile?: LearningProfile;
  /** The host that builds the layer. Default `'custom'`: a product that calls the layer around its own turn loop. */
  surface?: LoopManifest['surface'];
  /** What the host's own configuration says about the loops it runs, for the manifest. */
  hostLoops?: Partial<Record<HostLoopName, LoopState>>;
}

class LearningLayer implements ILearningLayer, LearnerSessionHost {
  private readonly anonymous: ReadonlySet<string>;
  private readonly turns: LoopManifest['turns'] = { prepared: 0, bound: 0, none: {} };
  private manifestLogged = false;
  private closed = false;

  constructor(
    private readonly config: LearningConfig,
    private readonly resolved: ResolvedLearning,
    private readonly surface: LoopManifest['surface'],
    private readonly profile: LearningProfile,
    private readonly hostLoops: Partial<Record<HostLoopName, LoopState>> | undefined,
  ) {
    this.anonymous = new Set([...DEFAULT_ANONYMOUS_USER_IDS, ...(config.anonymousUserIds ?? [])]);
  }

  turnMode(): LearningMode {
    return resolveTurnMode(this.resolved.mode).mode;
  }

  countTurn(reason: NoLearnerReason | undefined): void {
    this.turns.prepared += 1;
    if (reason) this.turns.none[reason] = (this.turns.none[reason] ?? 0) + 1;
    else this.turns.bound += 1;
  }

  async manifest(): Promise<LoopManifest> {
    return buildManifest({
      surface: this.surface,
      profile: this.profile,
      resolved: this.resolved,
      hostLoops: this.hostLoops,
      turns: this.turns,
    });
  }

  async forLearner(key: LearnerKey | null, context: LearnerContext): Promise<ILearnerSession> {
    if (this.closed) throw new Error('The learning layer is closed.');
    if (!this.manifestLogged) {
      this.manifestLogged = true;
      console.log(`[agentos] learning layer manifest: ${JSON.stringify(await this.manifest())}`);
    }
    return new LearnerSession(this, this.bindingFor(key, context), context);
  }

  /**
   * The learner a key names. A blank or anonymous user id names none, and neither does a key with no agent: the
   * host's `learning.agentKey` wins over the key's, and the host's `learning.namespace` fills a key that has none.
   * The namespace the caller passed is kept apart: the session's turns are read against it.
   */
  private bindingFor(key: LearnerKey | null, context: LearnerContext): SessionBinding {
    if (!key) return { reason: context.noLearnerReason ?? 'no_user_id' };
    const userId = typeof key.userId === 'string' ? key.userId : '';
    if (userId.trim() === '' || this.anonymous.has(userId)) return { reason: 'placeholder_user' };
    const agentKey = (this.config.agentKey ?? key.agentKey ?? '').trim();
    if (!agentKey) return { reason: 'no_agent_key' };
    const openedUnder = typeof key.namespace === 'string' ? key.namespace : '';
    return { key: { namespace: openedUnder || this.config.namespace || '', agentKey, userId }, openedUnder };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * Builds a learning layer.
 *
 * `gmi()` builds one per agent and the full runtime one per `AgentOS` when their `learning` option is on. A product
 * that builds its own memory manager and runs its own turn loop calls this itself: `forLearner()` for each session,
 * `prepareTurn()` before each turn, and the personality section it returns goes into the system prompt.
 *
 * @throws {Error} Naming the field, when the config is not valid ({@link resolveLearningConfig}).
 */
export function createLearningLayer(options: LearningLayerOptions = {}): ILearningLayer {
  const { profile = 'custom', surface = 'custom', hostLoops, ...config } = options;
  return new LearningLayer(config, resolveLearningConfig(config, profile), surface, profile, hostLoops);
}
