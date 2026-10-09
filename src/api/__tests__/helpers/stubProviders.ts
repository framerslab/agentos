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
  /**
   * One entry per model call: the chunks to stream, or an Error to throw before
   * any chunk. An Error among the chunks is thrown at that point of the stream.
   */
  replies: Array<Array<Record<string, unknown> | Error> | Error>;
  /** Every model call: the model, a copy of the messages, and the options. */
  seen: Array<{ modelId: string; messages: ChatMessage[]; options: Record<string, unknown> }>;
  /** How many embedding requests reached the provider. */
  embedCalls: number;
  /**
   * Every text the provider embedded, in order. The memory build's test text is
   * one of them, so a case that checks memory itself embedded here looks for its
   * own words.
   */
  embedded: string[];
  /** How many requests ended because the caller aborted them: held ones (see `reply.hold`) and ones aborted before they started. */
  aborts: number;
  /**
   * True to answer `generateCompletion` as well, which agent()'s legacy path
   * calls: the next reply's chunks folded into one response. Unset, it throws,
   * because the GMI path streams.
   */
  whole?: boolean;
}

/** A held reply's second half: it is sent once `gate` resolves, unless the request is aborted first. */
interface Hold {
  gate: Promise<void>;
  after: Array<Record<string, unknown>>;
  /** True for a provider that reads the abort signal only when an event arrives (see `reply.stall`). */
  ignoresSignal?: boolean;
}

export const scripts = new Map<string, ProviderScript>();

/** Scripts the provider that starts with `apiKey`. */
export function script(providerId: string, apiKey: string, partial: Partial<ProviderScript> = {}): ProviderScript {
  const s: ProviderScript = { replies: [], seen: [], embedCalls: 0, embedded: [], aborts: 0, ...partial };
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
  /**
   * Streams `before`, then holds the request open until `gate` resolves and
   * streams `after`; aborted first (`options.abortSignal`), it ends with the
   * terminal abort chunk the provider contract asks for and counts the abort.
   */
  hold: (before: Array<Record<string, unknown>>, gate: Promise<void>, after: Array<Record<string, unknown>> = []) =>
    Object.assign([...before], { hold: { gate, after } satisfies Hold }),
  /**
   * As `hold`, for a provider that reads the abort signal only when an event
   * arrives, as Anthropic, Gemini and Ollama stream: the request stays open
   * until `gate` resolves, aborted or not, and then ends with the abort chunk
   * if the caller aborted meanwhile.
   */
  stall: (before: Array<Record<string, unknown>>, gate: Promise<void>, after: Array<Record<string, unknown>> = []) =>
    Object.assign([...before], { hold: { gate, after, ignoresSignal: true } satisfies Hold }),
  /** One delta, then the provider throws `error` (a refusal that reports its usage in `details.usage`, a dropped connection). */
  textThenThrow: (text: string, error: Error) => [{ ...base, modelId: 'stub-model', choices: [], responseTextDelta: text }, error],
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

    async generateCompletion(modelId: string, messages: ChatMessage[], options: Record<string, unknown>) {
      const s = this.script;
      if (!s?.whole) throw new Error(`${providerId}: the GMI path streams`);
      s.seen.push({ modelId, messages: JSON.parse(JSON.stringify(messages)), options });
      const next = s.replies.shift();
      if (!next) throw new Error(`${providerId}: unexpected model call`);
      if (next instanceof Error) throw next;
      // The streamed reply as one response: its last choice and its last usage.
      let choice: unknown;
      let usage: unknown;
      for (const chunk of next) {
        if (chunk instanceof Error) throw chunk;
        const choices = chunk.choices as unknown[] | undefined;
        if (choices?.length) choice = choices[0];
        if (chunk.usage) usage = chunk.usage;
      }
      return { ...base, object: 'chat.completion', modelId, choices: choice ? [choice] : [], ...(usage ? { usage } : {}) };
    }

    async *generateCompletionStream(modelId: string, messages: ChatMessage[], options: Record<string, unknown>) {
      const s = this.script!;
      s.seen.push({ modelId, messages: JSON.parse(JSON.stringify(messages)), options });
      const next = s.replies.shift();
      if (!next) throw new Error(`${providerId}: unexpected model call`);
      const signal = options.abortSignal as AbortSignal | undefined;
      // The provider contract: a request aborted before it starts ends with the terminal abort chunk.
      if (signal?.aborted) {
        s.aborts += 1;
        yield { ...base, modelId, choices: [], isFinal: true, error: { message: 'Request aborted', type: 'abort' } };
        return;
      }
      if (next instanceof Error) throw next;
      const breakAfter = (next as { breakAfter?: number }).breakAfter;
      for (let i = 0; i < next.length; i++) {
        const chunk = next[i];
        if (chunk instanceof Error) throw chunk;
        yield chunk;
        if (breakAfter !== undefined && i + 1 === breakAfter) throw new Error('connection reset');
      }
      const hold = (next as { hold?: Hold }).hold;
      if (!hold) return;
      const aborted = await new Promise<boolean>((resolve) => {
        if (!hold.ignoresSignal) {
          if (signal?.aborted) return resolve(true);
          signal?.addEventListener('abort', () => resolve(true), { once: true });
        }
        void hold.gate.then(() => resolve(Boolean(signal?.aborted)));
      });
      if (aborted) {
        s.aborts += 1;
        yield { ...base, modelId, choices: [], isFinal: true, error: { message: 'Request aborted', type: 'abort' } };
        return;
      }
      yield* hold.after;
    }

    async generateEmbeddings(modelId: string, texts: string[]) {
      if (providerId === 'anthropic') throw Object.assign(new Error('embeddings not supported'), { code: 'EMBEDDINGS_NOT_SUPPORTED' });
      this.script!.embedCalls += 1;
      this.script!.embedded.push(...texts);
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
