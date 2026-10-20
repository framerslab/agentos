import type { ChatMessage, ModelCompletionOptions, ModelInfo } from '../IProvider';
import { OpenAIProvider, OpenAIProviderConfig } from './OpenAIProvider';

/** Configuration for MiniMax's OpenAI-compatible Chat Completions transport. */
export type MiniMaxProviderConfig = OpenAIProviderConfig;

const CURRENT_MODELS = ['MiniMax-M3.1-Flash', 'MiniMax-M3'];
const FLASH_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** MiniMax text provider with a current catalog and lossless reasoning replay. */
export class MiniMaxProvider extends OpenAIProvider {
  public readonly providerId = 'minimax';

  /** @inheritdoc */
  public override async initialize(config: MiniMaxProviderConfig): Promise<void> {
    await super.initialize({
      ...config,
      baseURL: config.baseURL ?? 'https://api.minimax.io/v1',
      defaultModelId: config.defaultModelId ?? CURRENT_MODELS[0],
    });
  }

  /** MiniMax publishes its catalog in documentation, not the inherited model API. */
  protected override async refreshAvailableModels(): Promise<void> {}

  /** @inheritdoc */
  public override async listAvailableModels(filter?: { capability?: string }): Promise<ModelInfo[]> {
    await super.listAvailableModels(filter); // Preserve the initialization guard.
    const models: ModelInfo[] = CURRENT_MODELS.map(modelId => ({
      modelId,
      providerId: this.providerId,
      displayName: modelId,
      capabilities: ['chat', 'tool_use', 'vision_input'],
      contextWindowSize: 1_000_000,
      ...(modelId === 'MiniMax-M3.1-Flash' ? { outputTokenLimit: 524_288 } : {}),
      supportsStreaming: true,
      isDefaultModel: modelId === this.defaultModelId,
      status: 'active',
    }));
    return filter?.capability
      ? models.filter(model => model.capabilities.includes(filter.capability!))
      : models;
  }

  /** Catalog membership does not restrict explicit saved or custom model requests. */
  public override async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    return (await this.listAvailableModels()).find(model => model.modelId === modelId);
  }

  /** Apply MiniMax controls after the shared transport builds tools and image parts. */
  protected override buildChatCompletionPayload(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const payload = super.buildChatCompletionPayload(modelId, messages, options, stream);
    const wireMessages = payload.messages as Record<string, unknown>[];
    // Raw custom messages retain their own fields through the existing escape hatch.
    if (!options.customModelParams?.messages) {
      messages.forEach((message, index) => {
        if (message.role === 'assistant' && message.reasoningText !== undefined) {
          wireMessages[index].reasoning_content = message.reasoningText;
        }
      });
    }
    if (CURRENT_MODELS.includes(modelId)) {
      if (options.thinking !== undefined && payload.thinking === undefined) {
        payload.thinking = { type: options.thinking === false ? 'disabled' : 'adaptive' };
      }
      if (modelId === 'MiniMax-M3.1-Flash') {
        const thinking = payload.thinking as { type?: string } | undefined;
        const effort = payload.reasoning_effort ?? options.effort;
        if ((thinking?.type !== undefined && thinking.type !== 'adaptive') || (effort !== undefined && !FLASH_EFFORTS.includes(String(effort)))) {
          throw new Error('MiniMax-M3.1-Flash requires adaptive thinking and effort low, medium, high, xhigh, or max.');
        }
        if (payload.service_tier !== undefined || payload.reasoning_split === false) {
          throw new Error('MiniMax-M3.1-Flash does not support service_tier or reasoning_split=false.');
        }
        if (effort !== undefined) payload.reasoning_effort = effort;
      }
    }
    return payload;
  }
}
