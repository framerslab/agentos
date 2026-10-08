/**
 * @file agentCognitiveMemory.ts
 * Cognitive memory for GMIs built from agent options (`agent({ runtime: 'gmi' })`,
 * spec D7): a {@link CognitiveMemoryManager} over an in-memory vector store, the
 * in-memory knowledge graph, an embedding manager for `memory.embedding`, a
 * working memory of its own and the persona's HEXACO traits.
 *
 * One manager serves every session of an agent. Each GMI's memory bridge passes
 * the session's mood on every encode, retrieve and assemble call and scopes
 * recall to the session's user and conversation, so the manager's own mood
 * callback is neutral. The memory graph runs on the `'knowledge-graph'` backend
 * over the same in-memory knowledge graph, because the `'graphology'` backend
 * needs graphology, an optional peer dependency. Consolidation runs only when
 * `memory.consolidation.enabled` is true. The build embeds one test text through
 * the embedding model it sets up, so a model that cannot answer, or answers with
 * another size than memory expects, fails the build instead of leaving memory empty.
 */
import { CognitiveMemoryManager } from '../../cognition/memory/CognitiveMemoryManager.js';
import type { CognitiveMemoryConfig, HexacoTraits, PADState } from '../../cognition/memory/core/config.js';
import type { CognitiveMechanismsConfig } from '../../cognition/memory/mechanisms/types.js';
import { KnowledgeGraph } from '../../cognition/memory/retrieval/graph/knowledge/KnowledgeGraph.js';
import { EmbeddingManager } from '../../cognition/rag/EmbeddingManager.js';
import { InMemoryVectorStore } from '../../cognition/rag/vector_stores/InMemoryVectorStore.js';
import { InMemoryWorkingMemory } from '../../cognition/substrate/memory/InMemoryWorkingMemory.js';
import { HEXACO_TRAIT_KEYS, normalizeHexacoTraits } from '../../cognition/substrate/personas/hexaco.js';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition.js';
import type { InMemoryVectorStoreConfig } from '../../core/config/VectorStoreConfiguration.js';
import type { IEmbeddingManager } from '../../core/embeddings/IEmbeddingManager.js';
import type { AIModelProviderManager } from '../../core/llm/providers/AIModelProviderManager.js';
import type { IProvider, ProviderEmbeddingResponse } from '../../core/llm/providers/IProvider.js';
import type { MemoryConfig } from '../types.js';
import { createProviderManager, resolveModelOption, resolveProvider, type ParsedModel, type ResolvedProvider } from '../model.js';

/**
 * Output sizes of the embedding models agentos knows, as each returns them when
 * no `dimensions` is requested: OpenAI's (text-embedding-3 in
 * https://developers.openai.com/api/docs/guides/embeddings; all three as
 * OpenAIProvider records them for its model listing), nomic-embed-text's
 * (https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) and Gemini's (the
 * sizes GeminiProvider's catalog records).
 */
const KNOWN_EMBEDDING_DIMENSIONS: ReadonlyMap<string, number> = new Map([
  ['text-embedding-3-small', 1536],
  ['text-embedding-3-large', 3072],
  ['text-embedding-ada-002', 1536],
  ['nomic-embed-text', 768],
  ['gemini-embedding-001', 3072],
  ['gemini-embedding-2', 3072],
]);

/** Providers whose agentos implementation has no embeddings: their `generateEmbeddings` always throws. */
const PROVIDERS_WITHOUT_EMBEDDINGS: ReadonlyMap<string, string> = new Map([
  ['anthropic', 'Anthropic'],
  ['groq', 'Groq'],
  ['xai', 'xAI'],
  ['claude-code-cli', 'The Claude Code CLI'],
  ['gemini-cli', 'The Gemini CLI'],
]);

const NEUTRAL_PAD: PADState = { valence: 0, arousal: 0, dominance: 0 };

type Env = Readonly<Record<string, string | undefined>>;

/** The embedding model cognitive memory uses, with its output size. */
interface EmbeddingTarget extends ParsedModel {
  dimension: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An Error carrying the error it reports as `cause`. */
function errorWithCause(message: string, cause: unknown): Error {
  return Object.assign(new Error(message), { cause });
}

function refuseProviderWithoutEmbeddings(providerId: string): void {
  const label = PROVIDERS_WITHOUT_EMBEDDINGS.get(providerId.toLowerCase());
  if (label) {
    throw new Error(
      `gmi(): ${label} has no embedding models in agentos; set memory.embedding to a provider that has them, such as openai or ollama.`,
    );
  }
}

/** The size of a model in {@link KNOWN_EMBEDDING_DIMENSIONS}, also under a vendor prefix (`openai/...`) or an Ollama tag (`...:latest`). */
function knownDimension(modelId: string): number | undefined {
  const exact = KNOWN_EMBEDDING_DIMENSIONS.get(modelId);
  if (exact !== undefined) return exact;
  const base = modelId.slice(modelId.lastIndexOf('/') + 1).split(':')[0];
  return KNOWN_EMBEDDING_DIMENSIONS.get(base);
}

/**
 * Resolves the embedding model from `memory.embedding`, or, when it is unset,
 * from the environment: OpenAI's default embedding model when OPENAI_API_KEY is
 * set, else Ollama's when OLLAMA_BASE_URL is set. Only checks whether those two
 * are set; the provider's credentials are resolved when the memory is built.
 */
function resolveEmbeddingTarget(memory: MemoryConfig, env: Env): EmbeddingTarget {
  const requested = memory.embedding?.provider || (env.OPENAI_API_KEY ? 'openai' : env.OLLAMA_BASE_URL ? 'ollama' : undefined);
  if (!requested) {
    throw new Error(
      'gmi(): cognitive memory needs an embedding model. Set memory.embedding: { provider, model } or set OPENAI_API_KEY or OLLAMA_BASE_URL.',
    );
  }
  refuseProviderWithoutEmbeddings(requested);

  let model: ParsedModel;
  try {
    model = resolveModelOption({ provider: requested, model: memory.embedding?.model }, 'embedding');
  } catch (error) {
    throw errorWithCause(`gmi(): memory.embedding: ${messageOf(error)}`, error);
  }
  // A `provider:model` id names its own provider, which may be one that cannot embed.
  refuseProviderWithoutEmbeddings(model.providerId);

  const declared = memory.embedding?.dimension;
  if (declared !== undefined && !(Number.isInteger(declared) && declared > 0)) {
    throw new Error(`gmi(): memory.embedding.dimension must be a positive integer; got ${String(declared)}.`);
  }
  const dimension = declared ?? knownDimension(model.modelId);
  if (dimension === undefined) {
    throw new Error(
      `gmi(): set memory.embedding.dimension for the embedding model '${model.modelId}'; agentos does not know its output size.`,
    );
  }
  return { ...model, dimension };
}

/**
 * Checks, when the agent is built, that cognitive memory has an embedding model
 * it can use, so a missing or unusable one fails before the first send. Reads
 * the environment only to pick the provider when `memory.embedding` is unset;
 * credentials are read when the memory is built.
 *
 * @param memory - The agent's memory config.
 * @param env - The environment to read OPENAI_API_KEY and OLLAMA_BASE_URL from (defaults to `process.env`).
 * @throws {Error} Naming `memory.embedding` when no provider is set or detected, when the
 *   provider has no embeddings (Anthropic, Groq, xAI, the Claude Code and Gemini CLIs), when the
 *   model does not resolve, or when the model's output size is unknown and
 *   `memory.embedding.dimension` is unset or not a positive integer.
 */
export function assertEmbeddingAvailable(memory: MemoryConfig, env: Env = process.env): void {
  resolveEmbeddingTarget(memory, env);
}

export interface AgentCognitiveMemoryOptions {
  /** The agent's persona: its id is the memory's owner (`agentId`), its traits shape encoding. */
  persona: IPersonaDefinition;
  memory: MemoryConfig;
  /** The memory mechanisms to run; none when undefined. */
  mechanisms?: CognitiveMechanismsConfig;
  /**
   * An embedding manager to use instead of one built from `memory.embedding`
   * (tests, and hosts that own one). The caller keeps ownership: `close()` does not shut it down.
   */
  embeddingManager?: IEmbeddingManager;
}

export interface AgentCognitiveMemory {
  manager: CognitiveMemoryManager;
  /**
   * Shuts the manager down and releases the vector store and the embedding
   * manager this builder created. Later calls return the first call's promise.
   */
  close(): Promise<void>;
}

/** The text the build embeds once to check the embedding model. */
const PROBE_TEXT = 'cognitive memory embedding check';

/**
 * Embeds {@link PROBE_TEXT} once through the provider and model the embedding
 * manager will call, and fails when the model cannot answer (an Ollama model
 * that was never pulled, a model the provider does not serve) or answers with
 * another size than memory expects. Without this check the build succeeds and
 * memory stays empty: the embedding manager drops each failed or wrong-size
 * vector, the memory store refuses the trace, and the GMI's memory bridge only
 * records a trace warning.
 *
 * @param provider - The provider the embedding manager will call.
 * @param model - The resolved provider and model.
 * @param expected - The vector size memory expects.
 * @param declared - `memory.embedding.dimension`, when set.
 */
async function probeEmbeddingModel(
  provider: IProvider,
  model: ParsedModel,
  expected: number,
  declared: number | undefined,
): Promise<void> {
  const label = `cognitive memory's embedding model '${model.modelId}' on ${model.providerId}`;
  let response: ProviderEmbeddingResponse;
  try {
    response = await provider.generateEmbeddings(model.modelId, [PROBE_TEXT]);
  } catch (error) {
    throw errorWithCause(`gmi(): ${label} failed a test call (memory.embedding): ${messageOf(error)}`, error);
  }
  if (response?.error) {
    throw errorWithCause(`gmi(): ${label} failed a test call (memory.embedding): ${response.error.message}`, response.error);
  }
  const vector = response?.data?.[0]?.embedding;
  const size = Array.isArray(vector) ? vector.length : 0;
  if (size === 0) {
    throw new Error(`gmi(): ${label} returned no vector for a test call (memory.embedding).`);
  }
  if (size !== expected) {
    const expectation =
      declared !== undefined
        ? `memory.embedding.dimension (${declared}) declares ${declared}`
        : `agentos expects ${expected} for this model`;
    throw new Error(`gmi(): ${label} returns ${size} values, while ${expectation}; set memory.embedding.dimension to ${size}.`);
  }
}

async function buildEmbeddingManager(memory: MemoryConfig): Promise<{ manager: IEmbeddingManager; dimension: number }> {
  const target = resolveEmbeddingTarget(memory, process.env);
  let resolved: ResolvedProvider;
  let providerManager: AIModelProviderManager;
  try {
    resolved = resolveProvider(target.providerId, target.modelId);
    providerManager = await createProviderManager(resolved);
  } catch (error) {
    // The chat model may run on the same provider with other credentials; name the memory's.
    throw errorWithCause(
      `gmi(): cognitive memory could not start its embedding provider '${target.providerId}' (memory.embedding): ${messageOf(error)}`,
      error,
    );
  }
  const provider = providerManager.getProvider(resolved.providerId);
  if (!provider) {
    throw new Error(`gmi(): cognitive memory's embedding provider '${resolved.providerId}' is not available (memory.embedding).`);
  }
  await probeEmbeddingModel(provider, resolved, target.dimension, memory.embedding?.dimension);
  const manager = new EmbeddingManager();
  await manager.initialize(
    {
      embeddingModels: [{ modelId: resolved.modelId, providerId: resolved.providerId, dimension: target.dimension, isDefault: true }],
      defaultModelId: resolved.modelId,
      enableCache: true,
    },
    providerManager,
  );
  return { manager, dimension: target.dimension };
}

/**
 * Builds and initialises the cognitive memory manager an agent's GMIs share.
 *
 * @param opts - The persona, the memory config, the mechanisms and an optional embedding manager.
 * @returns The manager and a `close()` that releases it.
 * @throws {Error} When the embedding model is missing or unusable (see {@link assertEmbeddingAvailable}),
 *   when its provider has no credentials or fails to start, when a test embedding through it
 *   fails or returns another size than memory expects (skipped for an embedding manager the
 *   caller passes), or when the manager fails to initialise.
 */
export async function createAgentCognitiveMemory(opts: AgentCognitiveMemoryOptions): Promise<AgentCognitiveMemory> {
  const owned = opts.embeddingManager === undefined;
  const embedding = opts.embeddingManager
    ? { manager: opts.embeddingManager, dimension: await opts.embeddingManager.getEmbeddingDimension() }
    : await buildEmbeddingManager(opts.memory);

  const storeId = `gmi-memory-${opts.persona.id}`;
  const vectorStoreConfig: InMemoryVectorStoreConfig = {
    id: storeId,
    type: 'in_memory',
    similarityMetric: 'cosine',
    defaultEmbeddingDimension: embedding.dimension,
  };
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize(vectorStoreConfig);
  const knowledgeGraph = new KnowledgeGraph();
  await knowledgeGraph.initialize();
  const workingMemory = new InMemoryWorkingMemory();
  await workingMemory.initialize(storeId);

  // Canonical trait names (honestyHumility reads as honesty); 0.5 for a trait the persona leaves out.
  const declared = normalizeHexacoTraits(opts.persona.personalityTraits);
  const traits: HexacoTraits = {};
  for (const key of HEXACO_TRAIT_KEYS) traits[key] = declared[key] ?? 0.5;

  const consolidationEnabled = opts.memory.consolidation?.enabled === true;
  if (consolidationEnabled && opts.memory.consolidation?.interval) {
    console.warn(
      `[agentos] gmi(): memory.consolidation.interval ('${opts.memory.consolidation.interval}') is not applied; consolidation runs every hour.`,
    );
  }

  const config: CognitiveMemoryConfig = {
    workingMemory,
    knowledgeGraph,
    vectorStore,
    embeddingManager: embedding.manager,
    agentId: opts.persona.id,
    traits,
    moodProvider: () => ({ ...NEUTRAL_PAD }),
    featureDetectionStrategy: 'keyword',
    graph: { backend: 'knowledge-graph' },
    ...(opts.mechanisms ? { cognitiveMechanisms: opts.mechanisms } : {}),
    consolidation: { enabled: consolidationEnabled },
  };
  const manager = new CognitiveMemoryManager();
  await manager.initialize(config);

  let closing: Promise<void> | undefined;
  return {
    manager,
    close: () =>
      (closing ??= (async () => {
        try {
          await manager.shutdown();
        } finally {
          try {
            await vectorStore.shutdown();
          } finally {
            if (owned) await embedding.manager.shutdown?.();
          }
        }
      })()),
  };
}
