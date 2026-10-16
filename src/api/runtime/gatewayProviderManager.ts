/**
 * @file gatewayProviderManager.ts
 * The provider manager of a GMI whose turns run through a completion gateway.
 */
import type { AIModelProviderManager } from '../../core/llm/providers/AIModelProviderManager.js';
import type { IProvider, ModelInfo } from '../../core/llm/providers/IProvider.js';
import type { CompletionResolution } from './completionGateway.js';
import type { SpendBudget } from './spendBudget.js';
import { meteredProvider } from './agencyLaunch/meteredProviderManager.js';

/** The provider-manager calls the GMI path makes. */
type GmiProviderManagerCalls = Pick<AIModelProviderManager, 'getProvider' | 'getDefaultProvider' | 'getProviderForModel' | 'getModelInfo'>;

/**
 * The provider-manager calls the GMI, MetapromptExecutor and LLMUtilityAI make
 * (getProvider, getDefaultProvider, getProviderForModel, getModelInfo), answered
 * from the hop that serves the turn. The GMI sets the resolution before it
 * builds each prompt. Metaprompt and utility calls have no fallback of their own
 * in this increment: on a fallback hop a call that names the primary's provider
 * or model finds nothing, which the caller reports. A turn's budget, when it
 * has one, bounds these calls too (the constructor's `budgetOf`).
 */
export class GatewayProviderManager implements GmiProviderManagerCalls {
  private resolution: CompletionResolution | undefined;

  /** Present for code that checks a manager's readiness. */
  public readonly isInitialized = true;

  /**
   * @param budgetOf - The spend budget of the turn the GMI is running, read at each call. With one, each provider
   *   this manager hands out checks it before every completion request and charges every answer (`gmi.metaprompt`),
   *   so a metaprompt or self-reflection call spends inside the turn's budget; without one, the hop's own providers.
   */
  constructor(private readonly budgetOf: () => SpendBudget | undefined = () => undefined) {}

  /** Makes `resolution` the hop that answers every later call. */
  public setResolution(resolution: CompletionResolution): void {
    this.resolution = resolution;
  }

  private current(): CompletionResolution {
    if (!this.resolution) {
      throw new Error('GatewayProviderManager: no resolution yet. The GMI resolves a hop before it builds a prompt; call setResolution first.');
    }
    return this.resolution;
  }

  /** The serving hop's provider when `providerId` names it; otherwise undefined. */
  public getProvider(providerId: string): IProvider | undefined {
    const r = this.current();
    return providerId === r.providerId ? this.metered(r.providerManager.getProvider(r.providerId)) : undefined;
  }

  /** The serving hop's provider. */
  public getDefaultProvider(): IProvider | undefined {
    const r = this.current();
    return this.metered(r.providerManager.getProvider(r.providerId));
  }

  /** The serving hop's provider when `modelId` is the hop's model; otherwise undefined. */
  public getProviderForModel(modelId: string): IProvider | undefined {
    const r = this.current();
    return modelId === r.modelId ? this.metered(r.providerManager.getProvider(r.providerId)) : undefined;
  }

  /** `provider` checked against the turn's budget, when the turn has one. */
  private metered(provider: IProvider | undefined): IProvider | undefined {
    const budget = this.budgetOf();
    return provider && budget ? meteredProvider(provider, budget, 'gmi.metaprompt') : provider;
  }

  /** Model info from the serving hop's manager, for the hop's provider unless `providerId` names another. */
  public async getModelInfo(modelId: string, providerId?: string): Promise<ModelInfo | undefined> {
    const r = this.current();
    return r.providerManager.getModelInfo(modelId, providerId ?? r.providerId);
  }

  /** This adapter typed as `GMIBaseConfig.llmProviderManager` expects; it implements every method the GMI path calls. */
  public asProviderManager(): AIModelProviderManager {
    return this as unknown as AIModelProviderManager;
  }
}
