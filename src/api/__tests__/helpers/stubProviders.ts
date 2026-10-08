/**
 * Provider stubs for the gmi() end-to-end tests, installed with vi.mock at the
 * module boundary of each provider implementation, so the real provider
 * manager, completion gateway, GMI, prompt engine and tool orchestrator run
 * around them. Behaviour is scripted per `${providerId}:${apiKey}`: the
 * createProviderManager cache is keyed by provider, key and base URL, so every
 * test uses its own key. Not a test file (the vitest include pattern needs
 * `.test.ts`).
 *
 * ```ts
 * vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
 * ```
 */
import type { ChatMessage } from '../../../core/llm/providers/IProvider';

export interface ProviderScript {
  /** Thrown from `initialize()`: the provider never starts. Clear it to let the next start succeed. */
  initThrows?: Error;
  /** Context window the provider reports for every model. Default 128,000. */
  window?: number;
  /** One entry per model call: the chunks to stream, or an Error to throw before any chunk. */
  replies: Array<Array<Record<string, unknown>> | Error>;
  /** Every model call: the model, a copy of the messages, and the options. */
  seen: Array<{ modelId: string; messages: ChatMessage[]; options: Record<string, unknown> }>;
  /** How many embedding requests reached the provider. */
  embedCalls: number;
}

export const scripts = new Map<string, ProviderScript>();

/** Scripts the provider that starts with `apiKey`. */
export function script(providerId: string, apiKey: string, partial: Partial<ProviderScript> = {}): ProviderScript {
  const s: ProviderScript = { replies: [], seen: [], embedCalls: 0, ...partial };
  scripts.set(`${providerId}:${apiKey}`, s);
  return s;
}

const base = { id: 'stub', object: 'chat.completion.chunk', created: 0 };

/** Replies in the providers' streamed shapes. */
export const reply = {
  /** OpenAI's shape: a delta, a final chunk with the finish reason, then a trailing usage-only chunk. */
  text: (text: string, model = 'stub-model', usage = { promptTokens: 12, completionTokens: 3, totalTokens: 15 }) => [
    { ...base, modelId: model, choices: [], responseTextDelta: text },
    { ...base, modelId: model, isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: 'stop' }] },
    { ...base, modelId: model, isFinal: true, choices: [], usage },
  ],
  /** A tool-call step, optionally after streamed preamble text. */
  tools: (calls: Array<{ id: string; name: string; args: Record<string, unknown> }>, preamble?: string) => [
    ...(preamble ? [{ ...base, modelId: 'stub-model', choices: [], responseTextDelta: preamble }] : []),
    {
      ...base,
      modelId: 'stub-model',
      isFinal: true,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: preamble ?? null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) },
        finishReason: 'tool_calls',
      }],
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    },
  ],
  /** Anthropic's forced schema tool, streamed as a tool call, optionally after preamble text. */
  schemaTool: (name: string, args: Record<string, unknown>, preamble?: string) => [
    ...(preamble ? [{ ...base, modelId: 'stub-model', choices: [], responseTextDelta: preamble }] : []),
    {
      ...base,
      modelId: 'stub-model',
      isFinal: true,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: preamble ?? null, tool_calls: [{ id: 'schema_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
        finishReason: 'tool_use',
      }],
      usage: { promptTokens: 9, completionTokens: 5, totalTokens: 14 },
    },
  ],
  /** One delta, then the connection drops. */
  breakAfterFirstDelta: (text: string) => Object.assign([{ ...base, modelId: 'stub-model', choices: [], responseTextDelta: text }], { breakAfter: 1 }),
};

/** A deterministic embedding: word hashes in 1536 buckets (text-embedding-3-small's size), normalised. */
function hashEmbed(text: string, dim = 1536): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % dim] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

/**
 * A provider class whose instances play the script registered for their API
 * key. Its members are public: the class is an exported class expression.
 */
export function stubProviderClass(providerId: string) {
  return class StubProvider {
    readonly providerId = providerId;
    isInitialized = false;
    defaultModelId = 'stub-model';
    /** The script this instance plays; set by `initialize()`. */
    script: ProviderScript | undefined;

    async initialize(config: { apiKey?: string }): Promise<void> {
      const found = scripts.get(`${providerId}:${config.apiKey}`);
      if (!found) throw new Error(`no stub script for ${providerId}:${config.apiKey}`);
      if (found.initThrows) throw found.initThrows;
      this.script = found;
      this.isInitialized = true;
    }

    async listAvailableModels() {
      return [this.info('stub-model')];
    }

    async getModelInfo(modelId: string) {
      return this.info(modelId);
    }

    info(modelId: string) {
      return { modelId, providerId, contextWindowSize: this.script?.window ?? 128_000, capabilities: ['chat', 'tool_use'] };
    }

    async generateCompletion(): Promise<never> {
      throw new Error(`${providerId}: the GMI path streams`);
    }

    async *generateCompletionStream(modelId: string, messages: ChatMessage[], options: Record<string, unknown>) {
      const s = this.script!;
      s.seen.push({ modelId, messages: JSON.parse(JSON.stringify(messages)), options });
      const next = s.replies.shift();
      if (!next) throw new Error(`${providerId}: unexpected model call`);
      if (next instanceof Error) throw next;
      const breakAfter = (next as { breakAfter?: number }).breakAfter;
      for (let i = 0; i < next.length; i++) {
        yield next[i];
        if (breakAfter !== undefined && i + 1 === breakAfter) throw new Error('connection reset');
      }
    }

    async generateEmbeddings(modelId: string, texts: string[]) {
      if (providerId === 'anthropic') throw Object.assign(new Error('embeddings not supported'), { code: 'EMBEDDINGS_NOT_SUPPORTED' });
      this.script!.embedCalls += 1;
      return {
        object: 'list',
        data: texts.map((t, index) => ({ object: 'embedding', embedding: hashEmbed(t), index })),
        model: modelId,
        usage: { prompt_tokens: 0, total_tokens: 0 },
      };
    }

    async checkHealth() {
      return { isHealthy: true };
    }

    async shutdown(): Promise<void> {}
  };
}
