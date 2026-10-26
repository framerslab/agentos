/**
 * The cognitive memory a GMI built from agent options runs with: a real
 * CognitiveMemoryManager over the in-memory vector store and knowledge graph.
 * Most cases embed through an injected embedding manager (a word hash, no
 * provider); the provider cases build the embedding manager the way gmi()
 * does, from memory.embedding and the environment, over stubbed OpenAI and
 * Ollama provider modules.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => {
  /** A deterministic bag-of-words vector: texts that share words point the same way. */
  function hashEmbed(text: string, dim: number): number[] {
    const v = new Array<number>(dim).fill(0);
    for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      let h = 0;
      for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % dim] += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  }
  const embedCalls: Array<{ apiKey?: string; modelId: string; count: number }> = [];
  /** Stands in for OpenAIProvider inside AIModelProviderManager; embeds 1536 wide, as text-embedding-3-small does. */
  class OpenAIProvider {
    readonly providerId = 'openai';
    isInitialized = false;
    private apiKey?: string;
    async initialize(config: { apiKey?: string }) {
      this.apiKey = config.apiKey;
      this.isInitialized = true;
    }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async generateEmbeddings(modelId: string, texts: string[]) {
      embedCalls.push({ apiKey: this.apiKey, modelId, count: texts.length });
      return {
        object: 'list',
        data: texts.map((text, index) => ({ object: 'embedding', embedding: hashEmbed(text, 1536), index })),
        model: modelId,
        usage: { prompt_tokens: 0, total_tokens: 0 },
      };
    }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  }
  /** The models the Ollama stub has pulled; cleared after each case. */
  const pulledOllamaModels = new Set<string>();
  /**
   * Stands in for OllamaProvider: initialises whenever a base URL is given, as
   * the real one does when the server answers, embeds 768 wide with a pulled
   * model and refuses any other with Ollama's own error.
   */
  class OllamaProvider {
    readonly providerId = 'ollama';
    isInitialized = false;
    async initialize() {
      this.isInitialized = true;
    }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async generateEmbeddings(modelId: string, texts: string[]) {
      if (!pulledOllamaModels.has(modelId)) throw new Error(`model "${modelId}" not found, try pulling it first`);
      embedCalls.push({ apiKey: undefined, modelId, count: texts.length });
      return {
        object: 'list',
        data: texts.map((text, index) => ({ object: 'embedding', embedding: hashEmbed(text, 768), index })),
        model: modelId,
        usage: { prompt_tokens: 0, total_tokens: 0 },
      };
    }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  }
  /** Stands in for GeminiProvider: embeds 3072 wide, as gemini-embedding-2 does, and records each call like the OpenAI stub. */
  class GeminiProvider {
    readonly providerId = 'gemini';
    isInitialized = false;
    private apiKey?: string;
    async initialize(config: { apiKey?: string }) {
      this.apiKey = config.apiKey;
      this.isInitialized = true;
    }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async generateEmbeddings(modelId: string, texts: string[]) {
      embedCalls.push({ apiKey: this.apiKey, modelId, count: texts.length });
      return {
        object: 'list',
        data: texts.map((text, index) => ({ object: 'embedding', embedding: hashEmbed(text, 3072), index })),
        model: modelId,
        usage: { prompt_tokens: 0, total_tokens: 0 },
      };
    }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  }
  return { hashEmbed, embedCalls, OpenAIProvider, pulledOllamaModels, OllamaProvider, GeminiProvider };
});

vi.mock('../../../core/llm/providers/implementations/OpenAIProvider', () => ({ OpenAIProvider: fixtures.OpenAIProvider }));
vi.mock('../../../core/llm/providers/implementations/OllamaProvider', () => ({ OllamaProvider: fixtures.OllamaProvider }));
vi.mock('../../../core/llm/providers/implementations/GeminiProvider', () => ({ GeminiProvider: fixtures.GeminiProvider }));

import { assertEmbeddingAvailable, createAgentCognitiveMemory } from '../agentCognitiveMemory.js';
import { clearDefaultProvider, setDefaultProvider } from '../global-default.js';

const DIM = 64;
function makeEmbedder() {
  return {
    initialize: async () => undefined,
    generateEmbeddings: async (req: { texts: string | string[] }) => {
      const texts = Array.isArray(req.texts) ? req.texts : [req.texts];
      return { embeddings: texts.map((text) => fixtures.hashEmbed(text, DIM)), modelId: 'test-embed', providerId: 'test', usage: { totalTokens: 0 } };
    },
    getEmbeddingModelInfo: async () => ({ modelId: 'test-embed', providerId: 'test', dimension: DIM }),
    getEmbeddingDimension: async () => DIM,
    checkHealth: async () => ({ isHealthy: true }),
    shutdown: vi.fn(async () => undefined),
  };
}

const persona = {
  id: 'memo', name: 'Memo', description: 'd', version: '1.0.0', baseSystemPrompt: 'x',
  personalityTraits: { openness: 0.8, honestyHumility: 0.3 },
} as never;
const neutral = { valence: 0, arousal: 0, dominance: 0 };
const FACT = 'The deploy key lives in the vault under ops/deploy.';
/** A memory of Alice's, which no context assembled for Bob may carry. */
const ALICES_MEMORY = "Alice's door code is 4471.";
/**
 * A UUID in its text form, 8-4-4-4-12 hex digits in either case (RFC 9562
 * section 4, https://www.rfc-editor.org/rfc/rfc9562#section-4). A context lists
 * the trace ids in working memory, each `mt_` and a random v4 UUID
 * (generateTraceId in CognitiveMemoryManager.ts), and a UUID can hold any four
 * hex digits, 4471 among them.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The parts of Alice's memory (her sentence, its words "door code" and the
 * code) that a context carries outside its ids.
 */
function textOfAlicesMemoryIn(contextText: string): string[] {
  const text = contextText.replace(UUID, '[id]').toLowerCase();
  return [ALICES_MEMORY, 'door code', '4471'].filter((part) => text.includes(part.toLowerCase()));
}

afterEach(() => {
  vi.unstubAllEnvs();
  fixtures.pulledOllamaModels.clear();
  clearDefaultProvider();
});

describe('createAgentCognitiveMemory', () => {
  it('builds an initialised manager that encodes and retrieves', async () => {
    const mem = await createAgentCognitiveMemory({ persona, memory: {}, mechanisms: {}, embeddingManager: makeEmbedder() as never });
    await mem.manager.encode(FACT, neutral, 'neutral', { type: 'episodic' });
    const hits = await mem.manager.retrieve('where is the deploy key', neutral, { topK: 3 });
    expect(hits.retrieved.map((trace) => trace.content).join('\n')).toContain('vault');
    await mem.close();
  });

  it("carries the persona's traits under their canonical names (0.5 for the ones it leaves out), runs no consolidation, uses the in-tree graph backend and a neutral mood", async () => {
    const mem = await createAgentCognitiveMemory({ persona, memory: {}, embeddingManager: makeEmbedder() as never });
    const config = mem.manager.getConfig();
    expect(config.agentId).toBe('memo');
    expect(config.traits).toEqual({ honesty: 0.3, emotionality: 0.5, extraversion: 0.5, agreeableness: 0.5, conscientiousness: 0.5, openness: 0.8 });
    expect(config.consolidation?.enabled).toBe(false);
    expect(config.graph?.backend).toBe('knowledge-graph');
    expect(config.moodProvider()).toEqual(neutral);
    await mem.close();
  });

  it("a memory context assembled for some scopes carries no associated memory of another scope, whatever the graph links", async () => {
    const mem = await createAgentCognitiveMemory({ persona, memory: {}, embeddingManager: makeEmbedder() as never });
    const alices = await mem.manager.encode(ALICES_MEMORY, neutral, 'neutral', { type: 'semantic', scope: 'user', scopeId: 'alice' });
    const bobs = await mem.manager.encode('Bob keeps the deploy key in the vault.', neutral, 'neutral', { type: 'semantic', scope: 'user', scopeId: 'bob' });
    const shared = await mem.manager.encode('The deploy key rotates every month.', neutral, 'neutral', { type: 'semantic', scope: 'persona', scopeId: 'memo' });
    // The links a caller that reads every scope leaves behind when it recalls these together.
    const graph = mem.manager.getGraph()!;
    await graph.addEdge({ sourceId: bobs.id, targetId: alices.id, type: 'CO_ACTIVATED', weight: 1, createdAt: Date.now() });
    await graph.addEdge({ sourceId: bobs.id, targetId: shared.id, type: 'CO_ACTIVATED', weight: 1, createdAt: Date.now() });

    const forBob = await mem.manager.assembleForPrompt('where is the deploy key', 1600, neutral, {
      scopes: [{ scope: 'user', scopeId: 'bob' }, { scope: 'persona', scopeId: 'memo' }],
      // Only one of the two memories in scope is recalled directly, so the other can arrive by association alone. The
      // association walk reaches Alice's too, over its link from Bob's.
      topK: 1,
    });
    expect(forBob.contextText).toContain('vault');
    expect(forBob.contextText).toContain('[associated');
    expect(forBob.contextText).toContain('rotates every month');
    expect(textOfAlicesMemoryIn(forBob.contextText), forBob.contextText).toEqual([]);
    await mem.close();
  });

  it("the check for Alice's memory passes a context that lists a trace id holding 4471 and fails one that carries her sentence", () => {
    // Bob's active context on attempt 1 of CI run 40228806208 listed this trace id, a random UUID that holds 4471.
    const listing = '## Active Context (in focus — reference directly)\n- [weak] mt_377f1b30-f9f5-4471-a0d6-9040d2bdd969 (activation: 0.39)';
    expect(textOfAlicesMemoryIn(listing)).toEqual([]);
    expect(textOfAlicesMemoryIn(`${listing}\n\n## Related Context (connected memories — use for depth)\n- [associated, activation=0.25] ${ALICES_MEMORY}`)).toEqual([ALICES_MEMORY, 'door code', '4471']);
    // The code written beside an id, outside it, is still hers.
    expect(textOfAlicesMemoryIn('- [weak] mt_377f1b30-f9f5-4471-a0d6-9040d2bdd969 4471')).toEqual(['4471']);
  });

  it('close shuts the manager down once and leaves an embedding manager it was given running', async () => {
    const embedder = makeEmbedder();
    const mem = await createAgentCognitiveMemory({ persona, memory: {}, embeddingManager: embedder as never });
    await mem.close();
    await mem.close();
    await expect(mem.manager.retrieve('anything', neutral)).rejects.toThrow(/not initialized/);
    expect(embedder.shutdown).not.toHaveBeenCalled();
  });

  it('without an embedding manager, embeds through the provider the environment names: OPENAI_API_KEY gives text-embedding-3-small at 1536', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'k-agent-memory-env');
    fixtures.embedCalls.length = 0;
    const mem = await createAgentCognitiveMemory({ persona, memory: {} });
    await mem.manager.encode(FACT, neutral, 'neutral', { type: 'episodic' });
    const hits = await mem.manager.retrieve('where is the deploy key', neutral, { topK: 3 });
    expect(hits.retrieved.map((trace) => trace.content).join('\n')).toContain('vault');
    expect(fixtures.embedCalls.length).toBeGreaterThan(0);
    expect(fixtures.embedCalls.every((call) => call.modelId === 'text-embedding-3-small' && call.apiKey === 'k-agent-memory-env')).toBe(true);
    await mem.close();
  });

  it('a named embedding provider with no credentials fails the build, naming memory.embedding and the missing key', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    await expect(createAgentCognitiveMemory({ persona, memory: { embedding: { provider: 'openai' } } })).rejects.toThrow(/memory\.embedding[\s\S]*OPENAI_API_KEY/);
  });

  it("with only OLLAMA_BASE_URL set, embeds through Ollama's default model, nomic-embed-text at 768", async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OLLAMA_BASE_URL', 'http://ollama.test:11434');
    fixtures.pulledOllamaModels.add('nomic-embed-text');
    const mem = await createAgentCognitiveMemory({ persona, memory: {} });
    await mem.manager.encode(FACT, neutral, 'neutral', { type: 'episodic' });
    const hits = await mem.manager.retrieve('where is the deploy key', neutral, { topK: 3 });
    expect(hits.retrieved.map((trace) => trace.content).join('\n')).toContain('vault');
    await mem.close();
  });

  it('with memory.embedding unset, the global default provider comes first when it has embedding models', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'k-agent-memory-global-default');
    setDefaultProvider({ provider: 'ollama', baseUrl: 'http://ollama.test:11434' });
    fixtures.pulledOllamaModels.add('nomic-embed-text');
    fixtures.embedCalls.length = 0;
    const mem = await createAgentCognitiveMemory({ persona, memory: {} });
    await mem.manager.encode(FACT, neutral, 'neutral', { type: 'episodic' });
    expect(fixtures.embedCalls.length).toBeGreaterThan(0);
    expect(fixtures.embedCalls.every((call) => call.modelId === 'nomic-embed-text')).toBe(true);
    await mem.close();
  });

  it('a global default provider without embedding models is passed over for the first provider with a key that has them, Gemini included', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OLLAMA_BASE_URL', '');
    vi.stubEnv('GEMINI_API_KEY', 'k-agent-memory-gemini-detected');
    setDefaultProvider({ provider: 'anthropic', apiKey: 'k-anthropic' });
    fixtures.embedCalls.length = 0;
    const mem = await createAgentCognitiveMemory({ persona, memory: {} });
    await mem.manager.encode(FACT, neutral, 'neutral', { type: 'episodic' });
    expect(fixtures.embedCalls.length).toBeGreaterThan(0);
    expect(fixtures.embedCalls.every((call) => call.modelId === 'gemini-embedding-2' && call.apiKey === 'k-agent-memory-gemini-detected')).toBe(true);
    await mem.close();
  });

  it('an embedding model the provider cannot serve fails the build, naming memory.embedding: the Ollama default when it was never pulled', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OLLAMA_BASE_URL', 'http://ollama.test:11434');
    await expect(createAgentCognitiveMemory({ persona, memory: {} })).rejects.toThrow(
      /memory\.embedding[\s\S]*model "nomic-embed-text" not found, try pulling it first/,
    );
  });

  it("memory.embedding: { provider: 'gemini' } with no model embeds through gemini-embedding-2, embedText's Gemini default", async () => {
    vi.stubEnv('GEMINI_API_KEY', 'k-agent-memory-gemini');
    fixtures.embedCalls.length = 0;
    const mem = await createAgentCognitiveMemory({ persona, memory: { embedding: { provider: 'gemini' } } });
    await mem.manager.encode(FACT, neutral, 'neutral', { type: 'episodic' });
    const hits = await mem.manager.retrieve('where is the deploy key', neutral, { topK: 3 });
    expect(hits.retrieved.map((trace) => trace.content).join('\n')).toContain('vault');
    expect(fixtures.embedCalls.length).toBeGreaterThan(0);
    expect(fixtures.embedCalls.every((call) => call.modelId === 'gemini-embedding-2' && call.apiKey === 'k-agent-memory-gemini')).toBe(true);
    await mem.close();
  });

  it('an embedding model that returns another size than memory expects fails the build, naming the size it returns', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'k-agent-memory-dimension');
    // The size memory.embedding.dimension declares.
    await expect(
      createAgentCognitiveMemory({ persona, memory: { embedding: { provider: 'openai', model: 'text-embedding-3-small', dimension: 256 } } }),
    ).rejects.toThrow(/returns 1536 values[\s\S]*memory\.embedding\.dimension \(256\)/);
    // The size agentos knows for the model (the stub answers 1536 for every model).
    await expect(
      createAgentCognitiveMemory({ persona, memory: { embedding: { provider: 'openai', model: 'text-embedding-3-large' } } }),
    ).rejects.toThrow(/returns 1536 values[\s\S]*expects 3072[\s\S]*memory\.embedding\.dimension to 1536/);
  });
});

describe('assertEmbeddingAvailable', () => {
  it('refuses memory with no embedding source and names the option', () => {
    const env = { OPENAI_API_KEY: undefined, OLLAMA_BASE_URL: undefined };
    expect(() => assertEmbeddingAvailable({}, env)).toThrow(/memory\.embedding/);
    expect(() => assertEmbeddingAvailable({ embedding: { provider: 'anthropic' } }, env)).toThrow(/Anthropic/);
    expect(() => assertEmbeddingAvailable({}, { OPENAI_API_KEY: 'k' })).not.toThrow();
    expect(() => assertEmbeddingAvailable({}, { OLLAMA_BASE_URL: 'http://localhost:11434' })).not.toThrow();
    expect(() => assertEmbeddingAvailable({ embedding: { provider: 'openai' } }, env)).not.toThrow();
  });

  it('refuses a provider that cannot embed, a model it cannot resolve and a model of unknown size, naming the option', () => {
    const env = {};
    expect(() => assertEmbeddingAvailable({ embedding: { provider: 'groq' } }, env)).toThrow(/Groq has no embedding models/);
    expect(() => assertEmbeddingAvailable({ embedding: { provider: 'openai', model: 'anthropic:claude-x' } }, env)).toThrow(/Anthropic/);
    // Gemini without a model takes embedText's default, gemini-embedding-2.
    expect(() => assertEmbeddingAvailable({ embedding: { provider: 'gemini' } }, env)).not.toThrow();
    expect(() => assertEmbeddingAvailable({ embedding: { provider: 'ollama', model: 'mxbai-embed-large' } }, env)).toThrow(/memory\.embedding\.dimension/);
    expect(() => assertEmbeddingAvailable({ embedding: { provider: 'ollama', model: 'mxbai-embed-large', dimension: 0 } }, env)).toThrow(/positive integer/);
    expect(() => assertEmbeddingAvailable({ embedding: { provider: 'ollama', model: 'mxbai-embed-large', dimension: 1024 } }, env)).not.toThrow();
    expect(() => assertEmbeddingAvailable({ embedding: { provider: 'ollama', model: 'nomic-embed-text:latest' } }, env)).not.toThrow();
    expect(() => assertEmbeddingAvailable({ embedding: { provider: 'gemini', model: 'gemini-embedding-001' } }, env)).not.toThrow();
  });

  it('refuses Together AI, which serves no embedding model, before the memory is built', () => {
    // With a model and its size the provider passed, and the memory's first build
    // sent a test embedding to Together that no model there can answer.
    const env = {};
    expect(() =>
      assertEmbeddingAvailable({ embedding: { provider: 'together', model: 'embedding-model', dimension: 768 } }, env),
    ).toThrow(/Together AI has no embedding models/);
    expect(() => assertEmbeddingAvailable({ embedding: { provider: 'together' } }, env)).toThrow(/Together AI has no embedding models/);
  });
});
