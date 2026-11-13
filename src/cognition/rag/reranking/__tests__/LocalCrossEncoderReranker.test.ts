/**
 * @fileoverview Unit tests for LocalCrossEncoderReranker with a stubbed tokenizer and model.
 *
 * The stubs stand in for Transformers.js's AutoTokenizer and
 * AutoModelForSequenceClassification. They check what the provider asks of
 * them (the pairs it tokenizes, one forward pass per batch, the weights file it
 * loads) and how it turns logits into scores. The real model runs in
 * LocalCrossEncoderReranker.model.test.ts.
 *
 * @module backend/agentos/rag/reranking/tests/LocalCrossEncoderReranker.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LocalCrossEncoderReranker,
  LOCAL_RERANKER_MODELS,
  LOCAL_RERANKER_DEFAULT_WEIGHTS,
  type LocalCrossEncoderConfig,
} from '../providers/LocalCrossEncoderReranker';
import { RerankerService } from '../RerankerService';
import type { RerankerInput, RerankerRequestConfig } from '../IRerankerService';
import type { RagRetrievedChunk } from '../../IRetrievalAugmentor';

/** The logits the stub model returns for a document: a number per class. */
let logitsFor: (doc: string) => number[] = () => [0];
/** The `id2label` of the stub model's config. */
let id2label: Record<string, string> = { '0': 'LABEL_0' };

const tokenizerCalls: Array<{ texts: string[]; options: Record<string, unknown> }> = [];
const forwardCalls: Array<{ documents: string[] }> = [];

/** A tokenizer stub: records the call and hands the documents on to the model stub. */
const tokenizerStub = vi.fn((texts: string[], options: { text_pair: string[] } & Record<string, unknown>) => {
  tokenizerCalls.push({ texts, options });
  return { __documents: options.text_pair };
});

/** A model stub: one call is one forward pass over every pair it is given. */
const modelStub: any = vi.fn(async (inputs: { __documents: string[] }) => {
  forwardCalls.push({ documents: inputs.__documents });
  const rows = inputs.__documents.map((doc) => logitsFor(doc));
  const classes = rows[0]?.length ?? 1;
  return { logits: { dims: [rows.length, classes], data: Float32Array.from(rows.flat()) } };
});
modelStub.dispose = vi.fn(async () => {});

const tokenizerFromPretrained = vi.fn(async () => tokenizerStub);
/** The model a load returns; a test that needs one model per id replaces it. */
const defaultLoadModel = async (): Promise<any> => {
  modelStub.config = { id2label };
  return modelStub;
};
let loadModel: (modelId: string) => Promise<any> = defaultLoadModel;
const modelFromPretrained = vi.fn(async (...args: any[]) => loadModel(args[0]));

vi.mock('@huggingface/transformers', () => ({
  env: {},
  AutoTokenizer: { from_pretrained: tokenizerFromPretrained },
  AutoModelForSequenceClassification: { from_pretrained: modelFromPretrained },
}));

vi.mock('@xenova/transformers', () => ({
  env: {},
  AutoTokenizer: { from_pretrained: tokenizerFromPretrained },
  AutoModelForSequenceClassification: { from_pretrained: modelFromPretrained },
}));

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

describe('LocalCrossEncoderReranker', () => {
  let reranker: LocalCrossEncoderReranker;

  beforeEach(() => {
    vi.clearAllMocks();
    tokenizerCalls.length = 0;
    forwardCalls.length = 0;
    id2label = { '0': 'LABEL_0' };
    logitsFor = (doc) => [doc.length / 10];
    loadModel = defaultLoadModel;
    reranker = new LocalCrossEncoderReranker({ providerId: 'local' });
  });

  describe('initialization', () => {
    it('has providerId local and loads nothing before the first use', () => {
      expect(reranker.providerId).toBe('local');
      expect(modelFromPretrained).not.toHaveBeenCalled();
    });

    it('isAvailable() is true when Transformers.js imports', async () => {
      expect(await reranker.isAvailable()).toBe(true);
    });

    it('lists the supported models', () => {
      expect(reranker.getSupportedModels()).toEqual([...LOCAL_RERANKER_MODELS]);
    });

    it('lists exactly the three models whose licences were read, by their canonical ids', () => {
      expect([...LOCAL_RERANKER_MODELS]).toEqual([
        'cross-encoder/ms-marco-MiniLM-L6-v2',
        'cross-encoder/ms-marco-MiniLM-L12-v2',
        'BAAI/bge-reranker-base',
      ]);
    });
  });

  describe('revision and local files', () => {
    it('a provider built without defaultModelId loads the canonical cross-encoder/ms-marco-MiniLM-L6-v2', async () => {
      await reranker.initialize();
      expect(modelFromPretrained).toHaveBeenCalledWith('cross-encoder/ms-marco-MiniLM-L6-v2', expect.anything());
      expect(tokenizerFromPretrained).toHaveBeenCalledWith('cross-encoder/ms-marco-MiniLM-L6-v2', expect.anything());
    });

    it('passes a pinned revision to the tokenizer and the model loads, and passes none without one', async () => {
      const pinned = new LocalCrossEncoderReranker({ providerId: 'local', revision: 'abc' } as LocalCrossEncoderConfig);
      await pinned.initialize();
      expect(modelFromPretrained.mock.calls[0][1]).toMatchObject({ revision: 'abc' });
      expect((tokenizerFromPretrained.mock.calls[0] as unknown[])[1]).toMatchObject({ revision: 'abc' });

      vi.clearAllMocks();
      await reranker.initialize();
      expect(modelFromPretrained.mock.calls[0][1]).not.toHaveProperty('revision');
      expect((tokenizerFromPretrained.mock.calls[0] as unknown[])[1]).not.toHaveProperty('revision');
    });

    it('localFilesOnly loads from the cache alone (local_files_only), on both loads', async () => {
      const offline = new LocalCrossEncoderReranker({ providerId: 'local', localFilesOnly: true, cacheDir: '/tmp/models' } as LocalCrossEncoderConfig);
      await offline.initialize();
      expect(modelFromPretrained.mock.calls[0][1]).toMatchObject({ local_files_only: true, cache_dir: '/tmp/models' });
      expect((tokenizerFromPretrained.mock.calls[0] as unknown[])[1]).toMatchObject({ local_files_only: true, cache_dir: '/tmp/models' });

      vi.clearAllMocks();
      await reranker.initialize();
      expect(modelFromPretrained.mock.calls[0][1]).not.toHaveProperty('local_files_only');
    });
  });

  describe('weights file', () => {
    it("loads the default model's quantized file, named, at fp32 so no dtype suffix is added", async () => {
      await reranker.initialize();

      expect(LOCAL_RERANKER_DEFAULT_WEIGHTS['cross-encoder/ms-marco-MiniLM-L6-v2']).toBe('model_quint8_avx2');
      expect(LOCAL_RERANKER_DEFAULT_WEIGHTS['cross-encoder/ms-marco-MiniLM-L-6-v2']).toBe('model_quint8_avx2');
      expect(modelFromPretrained).toHaveBeenCalledWith(
        'cross-encoder/ms-marco-MiniLM-L6-v2',
        expect.objectContaining({ model_file_name: 'model_quint8_avx2', dtype: 'fp32', quantized: false }),
      );
      expect(tokenizerFromPretrained).toHaveBeenCalledWith('cross-encoder/ms-marco-MiniLM-L6-v2', expect.anything());
    });

    it('loads onnx/model.onnx at fp32 for a model with no listed quantized file', async () => {
      await reranker.initialize('BAAI/bge-reranker-base');

      expect(modelFromPretrained).toHaveBeenCalledWith(
        'BAAI/bge-reranker-base',
        expect.objectContaining({ model_file_name: 'model', dtype: 'fp32' }),
      );
    });

    it('takes modelFileName and dtype from the config over the default', async () => {
      const custom = new LocalCrossEncoderReranker({
        providerId: 'local',
        modelFileName: 'model_qint8_arm64',
        cacheDir: '/tmp/models',
      });
      await custom.initialize();

      expect(modelFromPretrained).toHaveBeenCalledWith(
        'cross-encoder/ms-marco-MiniLM-L6-v2',
        expect.objectContaining({ model_file_name: 'model_qint8_arm64', dtype: 'fp32', cache_dir: '/tmp/models' }),
      );

      vi.clearAllMocks();
      const q8 = new LocalCrossEncoderReranker({ providerId: 'local', dtype: 'q8' });
      await q8.initialize();
      expect(modelFromPretrained).toHaveBeenCalledWith(
        'cross-encoder/ms-marco-MiniLM-L6-v2',
        expect.objectContaining({ model_file_name: 'model', dtype: 'q8', quantized: true }),
      );
    });

    it('takes modelFileName as a path or with the .onnx extension and loads the same file', async () => {
      for (const modelFileName of ['onnx/model_quint8_avx2.onnx', 'model_quint8_avx2.onnx', 'onnx/model_quint8_avx2']) {
        vi.clearAllMocks();
        const named = new LocalCrossEncoderReranker({ providerId: 'local', modelFileName });
        const result = await named.rerank(
          { query: 'q', documents: [{ id: 'a', content: 'aa' }] },
          { providerId: 'local', modelId: '' },
        );

        expect(modelFromPretrained).toHaveBeenCalledWith(
          'cross-encoder/ms-marco-MiniLM-L6-v2',
          expect.objectContaining({ model_file_name: 'model_quint8_avx2', dtype: 'fp32' }),
        );
        expect(result.diagnostics?.providerMetrics).toMatchObject({ modelFile: 'onnx/model_quint8_avx2.onnx' });
      }
    });

    it('loads the model once for repeated reranks', async () => {
      const input: RerankerInput = { query: 'q', documents: [{ id: 'a', content: 'aa' }] };
      await reranker.rerank(input, { providerId: 'local', modelId: '' });
      await reranker.rerank(input, { providerId: 'local', modelId: '' });
      expect(modelFromPretrained).toHaveBeenCalledTimes(1);
      expect(tokenizerFromPretrained).toHaveBeenCalledTimes(1);
    });
  });

  describe('batching', () => {
    const docs = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `d${i}`, content: `document number ${i}` }));
    const config: RerankerRequestConfig = { providerId: 'local', modelId: 'cross-encoder/ms-marco-MiniLM-L-6-v2' };

    it('scores N pairs up to batchSize in one forward pass, as (query, document) pairs', async () => {
      await reranker.rerank({ query: 'the query', documents: docs(20) }, config);

      expect(forwardCalls).toHaveLength(1);
      expect(forwardCalls[0].documents).toHaveLength(20);
      expect(tokenizerCalls).toHaveLength(1);
      const { texts, options } = tokenizerCalls[0];
      expect(texts).toEqual(new Array(20).fill('the query'));
      expect(options).toMatchObject({
        text_pair: docs(20).map((d) => d.content),
        padding: true,
        truncation: true,
        max_length: 512,
      });
      expect(texts.some((t) => t.includes('[SEP]'))).toBe(false);
    });

    it('runs one forward pass per batch of batchSize', async () => {
      const small = new LocalCrossEncoderReranker({ providerId: 'local', batchSize: 8, maxSequenceLength: 128 });
      const result = await small.rerank({ query: 'q', documents: docs(20) }, config);

      expect(forwardCalls.map((c) => c.documents.length)).toEqual([8, 8, 4]);
      expect(tokenizerCalls.every((c) => c.options.max_length === 128)).toBe(true);
      expect(result.results).toHaveLength(20);
      expect(result.diagnostics?.providerMetrics).toMatchObject({ batchSize: 8, forwardPasses: 3 });
    });

    it('falls back to batches of 32 for a batchSize that is not a positive number', async () => {
      for (const batchSize of [0, Number.NaN, -4]) {
        forwardCalls.length = 0;
        const odd = new LocalCrossEncoderReranker({ providerId: 'local', batchSize });
        const result = await odd.rerank({ query: 'q', documents: docs(40) }, config);
        expect(forwardCalls.map((c) => c.documents.length)).toEqual([32, 8]);
        expect(result.results.every((r) => typeof r.relevanceScore === 'number')).toBe(true);
      }
    });

    it('returns no results and runs no forward pass for no documents', async () => {
      const result = await reranker.rerank({ query: 'q', documents: [] }, config);
      expect(result.results).toEqual([]);
      expect(forwardCalls).toHaveLength(0);
    });
  });

  describe('scores', () => {
    const config: RerankerRequestConfig = { providerId: 'local', modelId: 'cross-encoder/ms-marco-MiniLM-L-6-v2' };

    it('one-logit model: the score is the sigmoid of the raw logit, and the order follows the logits', async () => {
      const logits: Record<string, number> = { low: -9.3, answer: 6.68, mid: -1.2 };
      logitsFor = (doc) => [logits[doc]];
      const result = await reranker.rerank(
        {
          query: 'q',
          documents: [
            { id: 'low', content: 'low', originalScore: 0.9, metadata: { source: 'wiki' } },
            { id: 'answer', content: 'answer', originalScore: 0.1 },
            { id: 'mid', content: 'mid' },
          ],
        },
        config,
      );

      expect(result.results.map((r) => r.id)).toEqual(['answer', 'mid', 'low']);
      for (const r of result.results) {
        expect(r.relevanceScore).toBeCloseTo(sigmoid(logits[r.id]), 6);
        expect(r.relevanceScore).toBeGreaterThan(0);
        expect(r.relevanceScore).toBeLessThan(1);
      }
      expect(result.results.find((r) => r.id === 'low')?.originalScore).toBe(0.9);
      expect(result.results.find((r) => r.id === 'low')?.metadata).toEqual({ source: 'wiki' });
    });

    it("two-logit model: the score is the positive class's softmax probability", async () => {
      id2label = { '0': 'LABEL_0', '1': 'LABEL_1' };
      const logits: Record<string, [number, number]> = { yes: [-2, 3], no: [4, -1] };
      logitsFor = (doc) => logits[doc];
      const result = await reranker.rerank(
        { query: 'q', documents: [{ id: 'no', content: 'no' }, { id: 'yes', content: 'yes' }] },
        config,
      );

      const softmaxPositive = ([a, b]: [number, number]) => Math.exp(b) / (Math.exp(a) + Math.exp(b));
      expect(result.results.map((r) => r.id)).toEqual(['yes', 'no']);
      expect(result.results[0].relevanceScore).toBeCloseTo(softmaxPositive(logits.yes), 6);
      expect(result.results[1].relevanceScore).toBeCloseTo(softmaxPositive(logits.no), 6);
    });

    it('two-logit model whose labels name the positive class first reads that class', async () => {
      id2label = { '0': 'relevant', '1': 'irrelevant' };
      logitsFor = (doc) => (doc === 'yes' ? [3, -2] : [-1, 4]);
      const result = await reranker.rerank(
        { query: 'q', documents: [{ id: 'no', content: 'no' }, { id: 'yes', content: 'yes' }] },
        config,
      );
      expect(result.results.map((r) => r.id)).toEqual(['yes', 'no']);
    });

    it('applies topN and reports diagnostics', async () => {
      const result = await reranker.rerank(
        {
          query: 'q',
          documents: [
            { id: 'a', content: 'a' },
            { id: 'bbbbbb', content: 'bbbbbb' },
            { id: 'ccc', content: 'ccc' },
          ],
        },
        { ...config, topN: 2 },
      );

      expect(result.results.map((r) => r.id)).toEqual(['bbbbbb', 'ccc']);
      expect(result.diagnostics).toMatchObject({
        providerId: 'local',
        modelId: 'cross-encoder/ms-marco-MiniLM-L-6-v2',
        documentsProcessed: 3,
      });
      expect(result.diagnostics?.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('throws when the model returns fewer scores than pairs', async () => {
      modelStub.mockImplementationOnce(async () => ({ logits: { dims: [1, 1], data: Float32Array.from([1]) } }));
      await expect(
        reranker.rerank(
          { query: 'q', documents: [{ id: 'a', content: 'a' }, { id: 'b', content: 'b' }] },
          config,
        ),
      ).rejects.toThrow(/logits/);
    });
  });

  describe('non-finite logits', () => {
    const config: RerankerRequestConfig = { providerId: 'local', modelId: 'cross-encoder/ms-marco-MiniLM-L-6-v2' };
    const input: RerankerInput = { query: 'q', documents: [{ id: 'a', content: 'a' }, { id: 'b', content: 'b' }] };

    it('one-logit model: a NaN or infinite logit throws instead of returning a NaN score', async () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        logitsFor = (doc) => [doc === 'b' ? bad : 1];
        await expect(reranker.rerank(input, config)).rejects.toThrow(/non-finite logit .* pair 1 of 2/);
      }
    });

    it('two-logit model: a NaN or infinite logit throws', async () => {
      id2label = { '0': 'LABEL_0', '1': 'LABEL_1' };
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const r = new LocalCrossEncoderReranker({ providerId: 'local' });
        logitsFor = (doc) => (doc === 'a' ? [0, bad] : [0, 1]);
        await expect(r.rerank(input, config)).rejects.toThrow(/non-finite logit .* pair 0 of 2/);
      }
    });
  });

  describe('concurrent loads and reranks', () => {
    /** A model stub of its own whose logit is `logit` for every pair; `gate` holds its forward passes. */
    const makeModel = (logit: number) => {
      const passes: number[] = [];
      let gate: Promise<void> = Promise.resolve();
      const model: any = vi.fn(async (inputs: { __documents: string[] }) => {
        passes.push(inputs.__documents.length);
        await gate;
        const n = inputs.__documents.length;
        return { logits: { dims: [n, 1], data: Float32Array.from(new Array(n).fill(logit)) } };
      });
      model.dispose = vi.fn(async () => {});
      model.config = { id2label: { '0': 'LABEL_0' } };
      model.passes = passes;
      model.hold = () => {
        let release!: () => void;
        gate = new Promise<void>((resolve) => (release = resolve));
        return () => release();
      };
      return model;
    };

    it('loads one model at a time, in the order asked, and leaves the last one loaded', async () => {
      const models: Record<string, any> = { A: makeModel(1), B: makeModel(2), C: makeModel(3) };
      let loading = 0;
      let mostAtOnce = 0;
      const order: string[] = [];
      loadModel = async (id) => {
        loading++;
        mostAtOnce = Math.max(mostAtOnce, loading);
        await new Promise((resolve) => setTimeout(resolve, 5));
        loading--;
        order.push(id);
        return models[id];
      };

      // B and C are asked for while A is still loading.
      await Promise.all([reranker.initialize('A'), reranker.initialize('B'), reranker.initialize('C')]);

      expect(mostAtOnce).toBe(1);
      expect(order).toEqual(['A', 'B', 'C']);
      const result = await reranker.rerank(
        { query: 'q', documents: [{ id: 'a', content: 'a' }] },
        { providerId: 'local', modelId: 'A' },
      );
      expect(result.diagnostics?.modelId).toBe('C');
      expect(result.results[0].relevanceScore).toBeCloseTo(sigmoid(3), 6);
      expect(models.A.dispose).toHaveBeenCalledTimes(1);
      expect(models.B.dispose).toHaveBeenCalledTimes(1);
      expect(models.C.dispose).not.toHaveBeenCalled();
    });

    it('a rerank keeps scoring with its model while another loads, and the old model is disposed after it', async () => {
      const models: Record<string, any> = { A: makeModel(1), B: makeModel(-1) };
      loadModel = async (id) => models[id];
      const r = new LocalCrossEncoderReranker({ providerId: 'local', defaultModelId: 'A', batchSize: 8 });
      await r.initialize();

      const release = models.A.hold();
      const docs = Array.from({ length: 16 }, (_, i) => ({ id: `d${i}`, content: `doc ${i}` }));
      const running = r.rerank({ query: 'q', documents: docs }, { providerId: 'local', modelId: 'A' });
      await vi.waitFor(() => expect(models.A.passes).toHaveLength(1));

      await r.initialize('B');
      expect(models.A.dispose).not.toHaveBeenCalled();

      release();
      const result = await running;
      expect(models.A.passes).toEqual([8, 8]);
      expect(models.B.passes).toEqual([]);
      expect(result.diagnostics?.modelId).toBe('A');
      for (const doc of result.results) expect(doc.relevanceScore).toBeCloseTo(sigmoid(1), 6);
      expect(models.A.dispose).toHaveBeenCalledTimes(1);

      const next = await r.rerank({ query: 'q', documents: docs.slice(0, 2) }, { providerId: 'local', modelId: 'A' });
      expect(next.diagnostics?.modelId).toBe('B');
      expect(next.results[0].relevanceScore).toBeCloseTo(sigmoid(-1), 6);
    });
  });

  describe('session options', () => {
    const MODEL = 'cross-encoder/ms-marco-MiniLM-L6-v2';

    it('passes intraOpNumThreads and interOpNumThreads to the ONNX session', async () => {
      const threaded = new LocalCrossEncoderReranker({ providerId: 'local', intraOpNumThreads: 1, interOpNumThreads: 1 });
      await threaded.initialize();

      expect(modelFromPretrained).toHaveBeenCalledWith(
        MODEL,
        expect.objectContaining({ session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 } }),
      );
    });

    it('passes only the thread counts given, as whole numbers', async () => {
      const threaded = new LocalCrossEncoderReranker({ providerId: 'local', intraOpNumThreads: 2.9 });
      await threaded.initialize();

      expect(modelFromPretrained.mock.calls[0][1].session_options).toEqual({ intraOpNumThreads: 2 });
    });

    it('sets no session options without a positive thread count, so onnxruntime sizes its own pool', async () => {
      for (const threads of [undefined, 0, -1, Number.NaN]) {
        vi.clearAllMocks();
        const plain = new LocalCrossEncoderReranker({
          providerId: 'local',
          intraOpNumThreads: threads,
          interOpNumThreads: threads,
        });
        await plain.initialize();

        expect(modelFromPretrained).toHaveBeenCalledTimes(1);
        expect(modelFromPretrained.mock.calls[0][1]).not.toHaveProperty('session_options');
      }
    });
  });

  describe('best-piece scoring (pieceMaxChars)', () => {
    const config: RerankerRequestConfig = { providerId: 'local', modelId: 'cross-encoder/ms-marco-MiniLM-L-6-v2' };
    /** The texts the tokenizer was handed as `text_pair`, one array per forward pass. */
    const pairsByPass = () => tokenizerCalls.map((c) => c.options.text_pair as string[]);

    it('splits a document longer than pieceMaxChars at sentence ends, each piece at most that long', async () => {
      const split = new LocalCrossEncoderReranker({ providerId: 'local', pieceMaxChars: 40 });
      await split.rerank(
        {
          query: 'q',
          documents: [{ id: 'a', content: 'Alpha beta gamma. Delta epsilon zeta eta. Theta iota kappa lambda mu nu xi.' }],
        },
        config,
      );

      expect(pairsByPass()).toEqual([['Alpha beta gamma.', 'Delta epsilon zeta eta.', 'Theta iota kappa lambda mu nu xi.']]);
    });

    it('packs short sentences together, splits a long sentence at spaces and cuts only a word longer than a piece', async () => {
      const cases: Array<{ max: number; content: string; pieces: string[] }> = [
        { max: 60, content: 'One. Two. Three is here.\nFour on a new line. Five and six and seven and eight and nine.', pieces: ['One. Two. Three is here. Four on a new line.', 'Five and six and seven and eight and nine.'] },
        { max: 20, content: 'One two three four five six. Seven.', pieces: ['One two three four', 'five six. Seven.'] },
        { max: 10, content: 'aaaa bbbb cccc ddddddddddddddd', pieces: ['aaaa bbbb', 'cccc', 'dddddddddd', 'ddddd'] },
        // A cut never splits a character outside the Basic Multilingual Plane (two UTF-16 units).
        { max: 3, content: '\u{1F600}\u{1F600}\u{1F600}', pieces: ['\u{1F600}', '\u{1F600}', '\u{1F600}'] },
      ];
      for (const c of cases) {
        tokenizerCalls.length = 0;
        const split = new LocalCrossEncoderReranker({ providerId: 'local', pieceMaxChars: c.max });
        await split.rerank({ query: 'q', documents: [{ id: 'a', content: c.content }] }, config);

        expect(pairsByPass()).toEqual([c.pieces]);
        for (const piece of c.pieces) expect(piece.length).toBeLessThanOrEqual(c.max);
      }
    });

    it('keeps a character outside the Basic Multilingual Plane whole, even at pieceMaxChars 1', async () => {
      const split = new LocalCrossEncoderReranker({ providerId: 'local', pieceMaxChars: 1 });
      await split.rerank({ query: 'q', documents: [{ id: 'a', content: 'a\u{1F600}b' }] }, config);

      expect(pairsByPass()).toEqual([['a', '\u{1F600}', 'b']]);
    });

    it("scores every piece of every document in the same batches and gives a document its best piece's score", async () => {
      const best = 'The answer sits right here.';
      logitsFor = (piece) => [piece === best ? 5 : piece === 'short note' ? 1 : -3];
      const split = new LocalCrossEncoderReranker({ providerId: 'local', pieceMaxChars: 30, batchSize: 4 });
      const long = `First filler sentence here. ${best} Last filler bit.`;
      const result = await split.rerank(
        {
          query: 'the query',
          documents: [
            { id: 'short', content: 'short note' },
            { id: 'long', content: long },
            { id: 'two', content: 'Another long note goes here. And it ends here.' },
          ],
        },
        config,
      );

      expect(pairsByPass()).toEqual([
        ['short note', 'First filler sentence here.', best, 'Last filler bit.'],
        ['Another long note goes here.', 'And it ends here.'],
      ]);
      expect(tokenizerCalls.every((c) => c.texts.every((t) => t === 'the query'))).toBe(true);
      expect(result.results.map((r) => r.id)).toEqual(['long', 'short', 'two']);
      expect(result.results[0].content).toBe(long);
      expect(result.results[0].relevanceScore).toBeCloseTo(sigmoid(5), 6);
      expect(result.results[1].relevanceScore).toBeCloseTo(sigmoid(1), 6);
      expect(result.results[2].relevanceScore).toBeCloseTo(sigmoid(-3), 6);
      expect(result.diagnostics?.providerMetrics).toMatchObject({
        batchSize: 4,
        forwardPasses: 2,
        pairsScored: 6,
        pieceMaxChars: 30,
      });
    });

    it('is off by default and for a pieceMaxChars that is not a positive number: each document is one pair', async () => {
      const content = 'First filler sentence here. The answer sits right here. Last filler bit.';
      for (const pieceMaxChars of [undefined, 0, -5, Number.NaN]) {
        tokenizerCalls.length = 0;
        const plain = new LocalCrossEncoderReranker({ providerId: 'local', pieceMaxChars });
        const result = await plain.rerank({ query: 'q', documents: [{ id: 'a', content }] }, config);

        expect(pairsByPass()).toEqual([[content]]);
        expect(result.diagnostics?.providerMetrics).toMatchObject({ forwardPasses: 1, pairsScored: 1 });
        expect(result.diagnostics?.providerMetrics).not.toHaveProperty('pieceMaxChars');
      }
    });
  });

  describe('a load that fails half way', () => {
    const input: RerankerInput = { query: 'q', documents: [{ id: 'a', content: 'a' }] };
    const config: RerankerRequestConfig = { providerId: 'local', modelId: '' };

    it('disposes the model that loaded when the tokenizer fails, on every retry', async () => {
      const tokenizerError = new Error('tokenizer.json could not be fetched');
      tokenizerFromPretrained.mockRejectedValueOnce(tokenizerError).mockRejectedValueOnce(tokenizerError);
      // The model finishes loading after the tokenizer has failed.
      loadModel = async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return defaultLoadModel();
      };

      await expect(reranker.rerank(input, config)).rejects.toBe(tokenizerError);
      await expect(reranker.rerank(input, config)).rejects.toBe(tokenizerError);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(modelFromPretrained).toHaveBeenCalledTimes(2);
      expect(modelStub.dispose).toHaveBeenCalledTimes(2);

      // Once the tokenizer loads, the reranker scores and keeps its model.
      const result = await reranker.rerank(input, config);
      expect(result.results).toHaveLength(1);
      expect(modelStub.dispose).toHaveBeenCalledTimes(2);
    });

    it('rejects as soon as the tokenizer fails, and disposes the model when its load ends later', async () => {
      const tokenizerError = new Error('tokenizer.json could not be fetched');
      tokenizerFromPretrained.mockRejectedValueOnce(tokenizerError);
      // The model's download stalls until the test lets it finish.
      let finishModelLoad!: () => void;
      const modelLoaded = new Promise<void>((resolve) => (finishModelLoad = resolve));
      loadModel = async () => {
        await modelLoaded;
        return defaultLoadModel();
      };

      const outcome = await Promise.race([
        reranker.rerank(input, config).then(() => 'scored', (error: unknown) => error),
        new Promise((resolve) => setTimeout(() => resolve('still waiting for the model'), 200)),
      ]);
      expect(outcome).toBe(tokenizerError);
      expect(modelStub.dispose).not.toHaveBeenCalled();

      finishModelLoad();
      await vi.waitFor(() => expect(modelStub.dispose).toHaveBeenCalledTimes(1));
    });

    it('starts the next load only after a model that loads after its tokenizer failed has been disposed', async () => {
      const tokenizerError = new Error('tokenizer.json could not be fetched');
      tokenizerFromPretrained.mockRejectedValueOnce(tokenizerError);
      let finishModelLoad!: () => void;
      const modelLoaded = new Promise<void>((resolve) => (finishModelLoad = resolve));
      loadModel = async () => {
        await modelLoaded;
        return defaultLoadModel();
      };

      await expect(reranker.rerank(input, config)).rejects.toBe(tokenizerError);
      // The retry is asked for while the first model is still loading: it waits, so two loads never overlap.
      const retry = reranker.rerank(input, config);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(modelFromPretrained).toHaveBeenCalledTimes(1);

      finishModelLoad();
      const result = await retry;
      expect(result.results).toHaveLength(1);
      expect(modelFromPretrained).toHaveBeenCalledTimes(2);
      expect(modelStub.dispose).toHaveBeenCalledTimes(1);
      expect(modelStub.dispose.mock.invocationCallOrder[0]).toBeLessThan(
        modelFromPretrained.mock.invocationCallOrder[1],
      );
    });

    it("keeps the tokenizer's error when disposing the model throws or rejects", async () => {
      const tokenizerError = new Error('tokenizer.json could not be fetched');
      const failures: Array<() => unknown> = [
        () => {
          throw new Error('release failed at once');
        },
        async () => {
          throw new Error('release failed later');
        },
      ];
      for (const [k, failure] of failures.entries()) {
        tokenizerFromPretrained.mockRejectedValueOnce(tokenizerError);
        modelStub.dispose.mockImplementationOnce(failure);

        await expect(reranker.rerank(input, config)).rejects.toBe(tokenizerError);
        await vi.waitFor(() => expect(modelStub.dispose).toHaveBeenCalledTimes(k + 1));
      }
    });

    it("passes the model's error on when the model fails and the tokenizer loads", async () => {
      const modelError = new Error('onnx/model_quint8_avx2.onnx could not be read');
      modelFromPretrained.mockRejectedValueOnce(modelError);

      await expect(reranker.rerank(input, config)).rejects.toBe(modelError);
      expect(modelStub.dispose).not.toHaveBeenCalled();
    });
  });

  describe('a provider that fails to load, through RerankerService', () => {
    const chunks: RagRetrievedChunk[] = [
      { id: 'c0', content: 'first', originalDocumentId: 'd0', relevanceScore: 0.9 },
      { id: 'c1', content: 'second', originalDocumentId: 'd1', relevanceScore: 0.5 },
      { id: 'c2', content: 'third', originalDocumentId: 'd2', relevanceScore: 0.1 },
    ];

    it('rerankChunks passes the load error on; rerankChain keeps the order and the scores it was given', async () => {
      const loadError = new Error('Unauthorized access to file: "tokenizer.json"');
      tokenizerFromPretrained.mockRejectedValueOnce(loadError).mockRejectedValueOnce(loadError);
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const service = new RerankerService({
        config: { providers: [{ providerId: 'local' }], defaultProviderId: 'local' },
        logger,
      });
      service.registerProvider(reranker);

      await expect(service.rerankChunks('q', chunks)).rejects.toBe(loadError);
      expect(logger.error).toHaveBeenCalledWith(
        "RerankerService: Reranking failed with provider 'local'",
        { error: loadError.message },
      );

      const kept = await service.rerankChain('q', chunks, [{ provider: 'local', topK: 2 }]);
      expect(kept.map((c) => c.id)).toEqual(['c0', 'c1', 'c2']);
      expect(kept.map((c) => c.relevanceScore)).toEqual([0.9, 0.5, 0.1]);
      expect(kept.every((c) => c.metadata?._rerankerChainStages === '')).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Stage 'local' failed"));
    });
  });

  describe('initialize() with no model id', () => {
    it('loads the default model in place of another model loaded before', async () => {
      await reranker.initialize('BAAI/bge-reranker-base');
      await reranker.initialize();

      expect(modelFromPretrained.mock.calls.map((call) => call[0])).toEqual([
        'BAAI/bge-reranker-base',
        'cross-encoder/ms-marco-MiniLM-L6-v2',
      ]);
      const result = await reranker.rerank({ query: 'q', documents: [{ id: 'a', content: 'a' }] }, { providerId: 'local', modelId: '' });
      expect(result.diagnostics?.modelId).toBe('cross-encoder/ms-marco-MiniLM-L6-v2');
    });
  });

  describe('dispose', () => {
    it('disposes the model and loads it again on the next use', async () => {
      await reranker.initialize();
      await reranker.dispose();
      expect(modelStub.dispose).toHaveBeenCalledTimes(1);

      await reranker.initialize();
      expect(modelFromPretrained).toHaveBeenCalledTimes(2);
    });
  });
});
