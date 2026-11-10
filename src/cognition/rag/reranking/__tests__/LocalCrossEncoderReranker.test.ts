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
} from '../providers/LocalCrossEncoderReranker';
import type { RerankerInput, RerankerRequestConfig } from '../IRerankerService';

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
const modelFromPretrained = vi.fn(async () => {
  modelStub.config = { id2label };
  return modelStub;
});

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
  });

  describe('weights file', () => {
    it("loads the default model's quantized file, named, at fp32 so no dtype suffix is added", async () => {
      await reranker.initialize();

      expect(LOCAL_RERANKER_DEFAULT_WEIGHTS['cross-encoder/ms-marco-MiniLM-L-6-v2']).toBe('model_quint8_avx2');
      expect(modelFromPretrained).toHaveBeenCalledWith(
        'cross-encoder/ms-marco-MiniLM-L-6-v2',
        expect.objectContaining({ model_file_name: 'model_quint8_avx2', dtype: 'fp32', quantized: false }),
      );
      expect(tokenizerFromPretrained).toHaveBeenCalledWith('cross-encoder/ms-marco-MiniLM-L-6-v2', expect.anything());
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
        'cross-encoder/ms-marco-MiniLM-L-6-v2',
        expect.objectContaining({ model_file_name: 'model_qint8_arm64', dtype: 'fp32', cache_dir: '/tmp/models' }),
      );

      vi.clearAllMocks();
      const q8 = new LocalCrossEncoderReranker({ providerId: 'local', dtype: 'q8' });
      await q8.initialize();
      expect(modelFromPretrained).toHaveBeenCalledWith(
        'cross-encoder/ms-marco-MiniLM-L-6-v2',
        expect.objectContaining({ model_file_name: 'model', dtype: 'q8', quantized: true }),
      );
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
