import { OpenAIProvider, OpenAIProviderConfig } from './OpenAIProvider';

/** OpenAI-compatible MiniMax text provider for global and China endpoints. */
export interface MiniMaxProviderConfig extends OpenAIProviderConfig {}

export class MiniMaxProvider extends OpenAIProvider {
  public readonly providerId = 'minimax';

  public override async initialize(config: MiniMaxProviderConfig): Promise<void> {
    await super.initialize({
      baseURL: 'https://api.minimax.io/v1',
      defaultModelId: 'MiniMax-M3',
      ...config,
    });
  }
}
