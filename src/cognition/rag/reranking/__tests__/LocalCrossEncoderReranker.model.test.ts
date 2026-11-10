/**
 * Real-model test of LocalCrossEncoderReranker on cross-encoder/ms-marco-MiniLM-L-6-v2.
 *
 * Nothing is stubbed: Transformers.js loads the model's tokenizer and ONNX
 * weights and the provider reranks 20 texts, one of which answers the query.
 * The answer must come first and the 20 scores must differ, for the default
 * weights (the repository's onnx/model_quint8_avx2.onnx) and for the
 * full-precision onnx/model.onnx. Two more cases take the paths a host
 * uses: RerankerService.rerankChunks with the provider registered, and
 * RetrievalAugmentor.retrieveContext with rerank on, where the augmentor
 * registers the local provider from its rerankerServiceConfig (its
 * embeddings and vector store are stand-ins; the rerank stage is the real
 * model).
 *
 * It runs when AGENTOS_TEST_CROSS_ENCODER_CACHE names a Transformers.js cache
 * folder holding the model's files at
 * cross-encoder/ms-marco-MiniLM-L-6-v2/{config.json, tokenizer.json,
 * tokenizer_config.json, onnx/model.onnx, onnx/model_quint8_avx2.onnx};
 * CI's Test & Lint job fetches them, checked against pinned sha256 sums, and
 * sets it. Remote downloads are turned off for the test, so the files it
 * scores with are the pinned ones. Without the variable the suite is
 * skipped; with it set to a folder that lacks a file, the suite fails naming
 * the file, so a broken fetch never passes as a skip.
 */

import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalCrossEncoderReranker, type LocalCrossEncoderConfig } from '../providers/LocalCrossEncoderReranker';
import { RerankerService } from '../RerankerService';
import { RetrievalAugmentor } from '../../RetrievalAugmentor';
import type { RagRetrievedChunk } from '../../IRetrievalAugmentor';
import type { IEmbeddingManager } from '../../IEmbeddingManager';
import type { IVectorStoreManager } from '../../IVectorStoreManager';

const CACHE_DIR = process.env.AGENTOS_TEST_CROSS_ENCODER_CACHE ?? '';
const MODEL_ID = 'cross-encoder/ms-marco-MiniLM-L-6-v2';
const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model.onnx',
  'onnx/model_quint8_avx2.onnx',
];

/** The first model file `dir` lacks or holds empty, named; `undefined` when it holds them all. */
function missingNote(dir: string): string | undefined {
  for (const file of MODEL_FILES) {
    const stat = statSync(join(dir, MODEL_ID, file), { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile() || stat.size === 0) {
      return `AGENTOS_TEST_CROSS_ENCODER_CACHE=${dir} lacks ${MODEL_ID}/${file} (missing or empty)`;
    }
  }
  return undefined;
}


const QUERY = 'What is the name of the clinic where my dog got her vaccines last month?';
const ANSWER_ID = 'answer';
const TEXTS = [
  'My dog loves the long walk along the river path, especially on cool mornings when the ducks are out.',
  'My sister works night shifts at the city hospital and says the emergency room was packed last month.',
  'I need to buy a new bag of dog food; the brand she likes was out of stock at the corner shop.',
  'Last spring my cousin and I drove to the coast and it rained the whole time, so we stayed in and played cards.',
  'The kitchen repaint took two weekends. The blue paint looked gray under the evening light.',
  'My manager moved the quarterly budget review to Thursday, and the draft slides are due the day before.',
  'I adopted a gray kitten from the shelter in March; she sleeps on the radiator most afternoons.',
  'The pottery class meets on Wednesdays. My first bowl cracked in the kiln but the second one held.',
  'We booked a cabin near the lake for the long weekend and split the cost four ways.',
  'The landlord finally fixed the leaking sink after three reminders and a photo of the puddle.',
  'My neighbor lent me a ladder to clean the gutters; I owe him a loaf of banana bread.',
  'The noodle place downtown has a lunch special on weekdays, and the spicy broth is worth it.',
  'I renewed my library card and borrowed two books about sailing for the trip in the summer.',
  'Last month I took my dog Biscuit for her yearly vaccines at a small clinic called Willow Paws Animal Care, on the corner by the bakery. The visit cost ninety dollars and the next booster is due in the spring.',
  'The bike needs new brake pads before winter; the shop quoted forty dollars including labor.',
  'My brother started a new job at a logistics company and says the commute is shorter now.',
  'The plants on the balcony need water twice a week, more often when the weather turns hot.',
  'A coworker from the design team recommended a podcast about city planning and old train lines.',
  'The hotel near the station had free breakfast and a quiet courtyard with a small fountain.',
  'I cleaned out the garage and found my old camping stove, still working after ten years.',
];
const ANSWER_INDEX = 13;
const DOCUMENTS = TEXTS.map((content, i) => ({ id: i === ANSWER_INDEX ? ANSWER_ID : `t${i}`, content }));

/** The texts that mention no dog, clinic or vaccine: the filler in front of the answer in the long note. */
const OFF_TOPIC = [3, 4, 5, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19].map((i) => TEXTS[i]);
/** Every text but the answer: the long notes that do not answer, some about a dog or a hospital. */
const NEAR_TOPIC = TEXTS.filter((_, i) => i !== ANSWER_INDEX);

/** `texts` from index `start` on, joined by spaces and repeated as needed, cut to `length` characters. */
function fill(texts: string[], start: number, length: number): string {
  let text = '';
  for (let k = 0; text.length < length; k++) text += (text ? ' ' : '') + texts[(start + k) % texts.length];
  return text.slice(0, length);
}

describe.skipIf(!CACHE_DIR)(`LocalCrossEncoderReranker on the real ${MODEL_ID}`, () => {
  let transformersEnv: { allowRemoteModels: boolean } | undefined;
  let allowRemoteBefore = true;

  beforeAll(async () => {
    const missing = missingNote(CACHE_DIR);
    if (missing) throw new Error(missing);
    const transformers: any = await import('@huggingface/transformers');
    transformersEnv = transformers.env;
    allowRemoteBefore = transformersEnv!.allowRemoteModels;
    transformersEnv!.allowRemoteModels = false;
  });

  afterAll(() => {
    if (transformersEnv) transformersEnv.allowRemoteModels = allowRemoteBefore;
  });

  const cases: Array<{ name: string; modelFileName?: string; batchSize?: number; loads: string }> = [
    { name: 'default weights (onnx/model_quint8_avx2.onnx)', loads: 'model_quint8_avx2' },
    { name: 'full precision (onnx/model.onnx), batches of 8', modelFileName: 'model', batchSize: 8, loads: 'model' },
    { name: "the weights named as a path ('onnx/model_quint8_avx2.onnx')", modelFileName: 'onnx/model_quint8_avx2.onnx', loads: 'model_quint8_avx2' },
  ];

  for (const c of cases) {
    it(`${c.name}: the answering text ranks first of 20 and the scores are distinct`, async () => {
      const reranker = new LocalCrossEncoderReranker({
        providerId: 'local',
        cacheDir: CACHE_DIR,
        ...(c.modelFileName ? { modelFileName: c.modelFileName } : {}),
        ...(c.batchSize ? { batchSize: c.batchSize } : {}),
      });
      try {
        const result = await reranker.rerank(
          { query: QUERY, documents: DOCUMENTS },
          { providerId: 'local', modelId: MODEL_ID },
        );

        expect(result.results).toHaveLength(20);
        expect(result.results[0].id).toBe(ANSWER_ID);
        const scores = result.results.map((r) => r.relevanceScore);
        expect(new Set(scores).size).toBe(20);
        for (const s of scores) {
          expect(s).toBeGreaterThan(0);
          expect(s).toBeLessThan(1);
        }
        for (let i = 1; i < scores.length; i++) expect(scores[i - 1]).toBeGreaterThan(scores[i]);
        expect(result.results[0].relevanceScore).toBeGreaterThan(0.5);
        expect(result.diagnostics?.providerMetrics).toMatchObject({
          forwardPasses: Math.ceil(20 / (c.batchSize ?? 32)),
          modelFile: `onnx/${c.loads}.onnx`,
        });
      } finally {
        await reranker.dispose();
      }
    });
  }

  it('with intraOpNumThreads 1 and interOpNumThreads 1: onnxruntime gets both and the answer ranks first', async () => {
    // Transformers.js creates its sessions with onnxruntime-node's InferenceSession.create; this records the options.
    const fromTransformers = createRequire(createRequire(import.meta.url).resolve('@huggingface/transformers'));
    const { InferenceSession } = fromTransformers('onnxruntime-node');
    const create = InferenceSession.create;
    const sessionOptions: unknown[] = [];
    InferenceSession.create = function (this: unknown, ...args: unknown[]) {
      sessionOptions.push(args[1]);
      return create.apply(this, args);
    };
    const reranker = new LocalCrossEncoderReranker({
      providerId: 'local',
      cacheDir: CACHE_DIR,
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    });
    try {
      const result = await reranker.rerank({ query: QUERY, documents: DOCUMENTS }, { providerId: 'local', modelId: MODEL_ID });

      expect(sessionOptions).toHaveLength(1);
      expect(sessionOptions[0]).toMatchObject({ intraOpNumThreads: 1, interOpNumThreads: 1 });
      expectAnswerFirstWithDistinctScores(
        result.results.map((r) => r.id),
        result.results.map((r) => r.relevanceScore),
      );
    } finally {
      InferenceSession.create = create;
      await reranker.dispose();
    }
  });

  it('a 1,024-character note whose answer sits past a 128-token window: low with whole notes, first with pieceMaxChars 300', async () => {
    const answerNote = `${fill(OFF_TOPIC, 0, 1024 - TEXTS[ANSWER_INDEX].length - 1)} ${TEXTS[ANSWER_INDEX]}`;
    expect(answerNote).toHaveLength(1024);
    const notes = TEXTS.map((_, i) =>
      i === ANSWER_INDEX ? { id: ANSWER_ID, content: answerNote } : { id: `n${i}`, content: fill(NEAR_TOPIC, i, 1024) },
    );
    for (const note of notes) expect(note.content).toHaveLength(1024);

    const whole = new LocalCrossEncoderReranker({ providerId: 'local', cacheDir: CACHE_DIR, maxSequenceLength: 128 });
    const pieces = new LocalCrossEncoderReranker({
      providerId: 'local',
      cacheDir: CACHE_DIR,
      maxSequenceLength: 128,
      pieceMaxChars: 300,
    });
    try {
      // The tokenizer keeps the first 128 tokens of each pair, which end long before the answer.
      const cut = await whole.rerank({ query: QUERY, documents: notes }, { providerId: 'local', modelId: MODEL_ID });
      const cutAnswer = cut.results.find((r) => r.id === ANSWER_ID)!;
      expect(cut.results[0].id).not.toBe(ANSWER_ID);
      expect(cutAnswer.relevanceScore).toBeLessThan(0.5);

      // Notes cut from the same rotation of texts can share their best piece, so scores may tie.
      const split = await pieces.rerank({ query: QUERY, documents: notes }, { providerId: 'local', modelId: MODEL_ID });
      expect(split.results).toHaveLength(20);
      expect(split.results[0].id).toBe(ANSWER_ID);
      expect(split.results[0].relevanceScore).toBeGreaterThan(0.5);
      expect(split.results[1].relevanceScore).toBeLessThan(split.results[0].relevanceScore);
      for (const r of split.results) {
        expect(r.relevanceScore).toBeGreaterThan(0);
        expect(r.relevanceScore).toBeLessThan(1);
      }
      expect(split.results[0].content).toBe(answerNote);
      const metrics = split.diagnostics?.providerMetrics as { pairsScored: number; forwardPasses: number };
      expect(metrics.pairsScored).toBeGreaterThanOrEqual(20 * Math.ceil(1024 / 300));
      expect(metrics.forwardPasses).toBe(Math.ceil(metrics.pairsScored / 32));
    } finally {
      await whole.dispose();
      await pieces.dispose();
    }
  });

  /** Asserts the answer leads and the 20 scores are distinct, in 0..1 and descending. */
  function expectAnswerFirstWithDistinctScores(ids: string[], scores: Array<number | undefined>): void {
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe(ANSWER_ID);
    expect(new Set(ids).size).toBe(20);
    expect(new Set(scores).size).toBe(20);
    for (const s of scores) {
      expect(typeof s).toBe('number');
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
    }
    for (let i = 1; i < scores.length; i++) expect(scores[i - 1]!).toBeGreaterThan(scores[i]!);
  }

  it('through RerankerService.rerankChunks (the host path): the answering chunk ranks first of 20 with distinct scores', async () => {
    const localConfig: LocalCrossEncoderConfig = { providerId: 'local', defaultModelId: MODEL_ID, cacheDir: CACHE_DIR };
    const service = new RerankerService({ config: { providers: [localConfig], defaultProviderId: 'local' } });
    const reranker = new LocalCrossEncoderReranker(localConfig);
    service.registerProvider(reranker);
    // The vector store's order: the answer sits 14th with a low similarity score.
    const chunks: RagRetrievedChunk[] = DOCUMENTS.map((d, i) => ({
      id: d.id,
      content: d.content,
      originalDocumentId: d.id,
      relevanceScore: 0.9 - i * 0.01,
    }));
    try {
      const reranked = await service.rerankChunks(QUERY, chunks);

      expectAnswerFirstWithDistinctScores(
        reranked.map((c) => c.id),
        reranked.map((c) => c.relevanceScore),
      );
      expect(reranked[0].relevanceScore).toBeGreaterThan(0.5);
      expect(reranked[0].metadata?._rerankerProviderId).toBe('local');
      expect(reranked[0].metadata?._rerankerOriginalScore).toBeCloseTo(0.9 - ANSWER_INDEX * 0.01, 10);
    } finally {
      await reranker.dispose();
    }
  });

  it('through RerankerService.rerankChunks with intraOpNumThreads 1 and pieceMaxChars 300: the long note that answers ranks first', async () => {
    const fromTransformers = createRequire(createRequire(import.meta.url).resolve('@huggingface/transformers'));
    const { InferenceSession } = fromTransformers('onnxruntime-node');
    const create = InferenceSession.create;
    const sessionOptions: unknown[] = [];
    InferenceSession.create = function (this: unknown, ...args: unknown[]) {
      sessionOptions.push(args[1]);
      return create.apply(this, args);
    };

    // The same 1,024-character notes as above: the answering sentence starts past a 128-token window.
    const answerNote = `${fill(OFF_TOPIC, 0, 1024 - TEXTS[ANSWER_INDEX].length - 1)} ${TEXTS[ANSWER_INDEX]}`;
    const notes = TEXTS.map((_, i) => (i === ANSWER_INDEX ? answerNote : fill(NEAR_TOPIC, i, 1024)));
    // The vector store's order: the answering note sits 14th with a low similarity score.
    const chunks: RagRetrievedChunk[] = notes.map((content, i) => {
      const id = i === ANSWER_INDEX ? ANSWER_ID : `n${i}`;
      return { id, content, originalDocumentId: id, relevanceScore: 0.9 - i * 0.01 };
    });

    const localConfig: LocalCrossEncoderConfig = {
      providerId: 'local',
      defaultModelId: MODEL_ID,
      cacheDir: CACHE_DIR,
      maxSequenceLength: 128,
      intraOpNumThreads: 1,
      pieceMaxChars: 300,
    };
    const service = new RerankerService({ config: { providers: [localConfig], defaultProviderId: 'local' } });
    const reranker = new LocalCrossEncoderReranker(localConfig);
    service.registerProvider(reranker);
    try {
      const reranked = await service.rerankChunks(QUERY, chunks);

      expect(sessionOptions).toHaveLength(1);
      expect(sessionOptions[0]).toMatchObject({ intraOpNumThreads: 1 });
      expect(reranked).toHaveLength(20);
      expect(new Set(reranked.map((c) => c.id)).size).toBe(20);
      expect(reranked[0].id).toBe(ANSWER_ID);
      expect(reranked[0].content).toBe(answerNote);
      expect(reranked[0].relevanceScore).toBeGreaterThan(0.5);
      expect(reranked[1].relevanceScore).toBeLessThan(reranked[0].relevanceScore!);
      for (const c of reranked) {
        expect(c.relevanceScore).toBeGreaterThan(0);
        expect(c.relevanceScore).toBeLessThan(1);
      }
      expect(reranked[0].metadata?._rerankerProviderId).toBe('local');
      expect(reranked[0].metadata?._rerankerOriginalScore).toBeCloseTo(0.9 - ANSWER_INDEX * 0.01, 10);
    } finally {
      InferenceSession.create = create;
      await reranker.dispose();
    }
  });

  it('through RetrievalAugmentor.retrieveContext with rerank on: the auto-registered local provider puts the answer first', async () => {
    // Embeddings and the vector store are stand-ins: they hand the augmentor the 20
    // texts in a fixed similarity order with the answer 14th. The rerank stage is real.
    const embeddingManager = {
      initialize: async () => undefined,
      generateEmbeddings: async () => ({
        embeddings: [[0.1, 0.2, 0.3]],
        modelId: 'stand-in-embedding',
        providerId: 'stand-in',
        usage: { totalTokens: 1 },
      }),
      getEmbeddingModelInfo: async () => ({ modelId: 'stand-in-embedding', providerId: 'stand-in', dimension: 3 }),
      getEmbeddingDimension: async () => 3,
      checkHealth: async () => ({ isHealthy: true }),
      shutdown: async () => undefined,
    } as unknown as IEmbeddingManager;
    const store = {
      query: async () => ({
        documents: DOCUMENTS.map((d, i) => ({
          id: d.id,
          embedding: [0.1, 0.2, 0.3],
          similarityScore: 0.9 - i * 0.01,
          textContent: d.content,
          metadata: { originalDocumentId: d.id },
        })),
      }),
    };
    const vectorStoreManager = {
      initialize: async () => undefined,
      getStoreForDataSource: async () => ({ store, collectionName: 'notes', dimension: 3 }),
      listDataSourceIds: () => ['notes'],
      checkHealth: async () => ({ isOverallHealthy: true }),
      shutdownAllProviders: async () => undefined,
    } as unknown as IVectorStoreManager;

    const localConfig: LocalCrossEncoderConfig = { providerId: 'local', defaultModelId: MODEL_ID, cacheDir: CACHE_DIR };
    const augmentor = new RetrievalAugmentor();
    await augmentor.initialize(
      {
        defaultQueryEmbeddingModelId: 'stand-in-embedding',
        categoryBehaviors: [],
        rerankerServiceConfig: { providers: [localConfig], defaultProviderId: 'local' },
        defaultRerankerProviderId: 'local',
      },
      embeddingManager,
      vectorStoreManager,
    );
    try {
      const result = await augmentor.retrieveContext(QUERY, {
        targetDataSourceIds: ['notes'],
        topK: 20,
        rerankerConfig: { enabled: true },
      });

      const messages = result.diagnostics?.messages ?? [];
      expect(messages.some((m) => m.includes('Reranking failed'))).toBe(false);
      expect(messages.some((m) => m.includes("Reranking applied with provider 'local'"))).toBe(true);
      expectAnswerFirstWithDistinctScores(
        result.retrievedChunks.map((c) => c.id),
        result.retrievedChunks.map((c) => c.relevanceScore),
      );
      expect(result.augmentedContext.startsWith(TEXTS[ANSWER_INDEX])).toBe(true);
    } finally {
      const provider = (augmentor as any).rerankerService?.getProvider('local') as LocalCrossEncoderReranker | undefined;
      await provider?.dispose();
      await augmentor.shutdown();
    }
  });
});
