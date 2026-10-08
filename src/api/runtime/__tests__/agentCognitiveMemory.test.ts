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
  return { hashEmbed, embedCalls, OpenAIProvider, pulledOllamaModels, OllamaProvider };
});

vi.mock('../../../core/llm/providers/implementations/OpenAIProvider', () => ({ OpenAIProvider: fixtures.OpenAIProvider }));
vi.mock('../../../core/llm/providers/implementations/OllamaProvider', () => ({ OllamaProvider: fixtures.OllamaProvider }));

import { assertEmbeddingAvailable, createAgentCognitiveMemory } from '../agentCognitiveMemory.js';

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

afterEach(() => {
  vi.unstubAllEnvs();
  fixtures.pulledOllamaModels.clear();
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

  it('an embedding model the provider cannot serve fails the build, naming memory.embedding: the Ollama default when it was never pulled', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OLLAMA_BASE_URL', 'http://ollama.test:11434');
    await expect(createAgentCognitiveMemory({ persona, memory: {} })).rejects.toThrow(
      /memory\.embedding[\s\S]*model "nomic-embed-text" not found, try pulling it first/,
    );
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
    expect(() => assertEmbeddingAvailable({ embedding: { provider: 'gemini' } }, env)).toThrow(/memory\.embedding: .*no default embedding model/);
    expect(() => assertEmbeddingAvailable({ embedding: { provider: 'ollama', model: 'mxbai-embed-large' } }, env)).toThrow(/memory\.embedding\.dimension/);
    expect(() => assertEmbeddingAvailable({ embedding: { provider: 'ollama', model: 'mxbai-embed-large', dimension: 0 } }, env)).toThrow(/positive integer/);
    expect(() => assertEmbeddingAvailable({ embedding: { provider: 'ollama', model: 'mxbai-embed-large', dimension: 1024 } }, env)).not.toThrow();
    expect(() => assertEmbeddingAvailable({ embedding: { provider: 'ollama', model: 'nomic-embed-text:latest' } }, env)).not.toThrow();
    expect(() => assertEmbeddingAvailable({ embedding: { provider: 'gemini', model: 'gemini-embedding-001' } }, env)).not.toThrow();
  });
});
