/**
 * @file gatewayProviderManager.ts
 * The provider manager of a GMI whose turns run through a completion gateway.
 */
import type { AIModelProviderManager } from '../../core/llm/providers/AIModelProviderManager.js';
import type { IProvider, ModelInfo } from '../../core/llm/providers/IProvider.js';
import type { CompletionResolution } from './completionGateway.js';

/** The provider-manager calls the GMI path makes. */
type GmiProviderManagerCalls = Pick<AIModelProviderManager, 'getProvider' | 'getDefaultProvider' | 'getProviderForModel' | 'getModelInfo'>;

/**
 * The provider-manager calls the GMI, MetapromptExecutor and LLMUtilityAI make
 * (getProvider, getDefaultProvider, getProviderForModel, getModelInfo), answered
 * from the hop that serves the turn. The GMI sets the resolution before it
 * builds each prompt. Metaprompt and utility calls have no fallback of their own
 * in this increment: on a fallback hop a call that names the primary's provider
 * or model finds nothing, which the caller reports.
 */
export class GatewayProviderManager implements GmiProviderManagerCalls {
  private resolution: CompletionResolution | undefined;

  /** Present for code that checks a manager's readiness. */
  public readonly isInitialized = true;

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
    return providerId === r.providerId ? r.providerManager.getProvider(r.providerId) : undefined;
  }

  /** The serving hop's provider. */
  public getDefaultProvider(): IProvider | undefined {
    const r = this.current();
    return r.providerManager.getProvider(r.providerId);
  }

  /** The serving hop's provider when `modelId` is the hop's model; otherwise undefined. */
  public getProviderForModel(modelId: string): IProvider | undefined {
    const r = this.current();
    return modelId === r.modelId ? r.providerManager.getProvider(r.providerId) : undefined;
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
