/**
 * @fileoverview LocalCrossEncoderReranker with Transformers.js supplied by the host through
 * `providerOptions.transformers`, as a bundled browser page does: the provider imports neither package by name at run
 * time, so here both fail to import, and the supplied module is the one the provider loads and scores with.
 *
 * @module backend/agentos/rag/reranking/tests/LocalCrossEncoderReranker.loader.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalCrossEncoderReranker } from '../providers/LocalCrossEncoderReranker';

const tokenizerStub = vi.fn((_texts: string[], options: { text_pair: string[] }) => ({ __documents: options.text_pair }));
const modelStub: any = vi.fn(async (inputs: { __documents: string[] }) => {
  const n = inputs.__documents.length;
  return { logits: { dims: [n, 1], data: Float32Array.from(new Array(n).fill(0.5)) } };
});
modelStub.dispose = vi.fn(async () => {});
modelStub.config = { id2label: { '0': 'LABEL_0' } };

const modelFromPretrained = vi.fn(async () => modelStub);

/** A Transformers.js module whose `env.version` is `version`. */
function transformersModule(version: string) {
  return {
    env: { version },
    AutoTokenizer: { from_pretrained: vi.fn(async () => tokenizerStub) },
    AutoModelForSequenceClassification: { from_pretrained: modelFromPretrained },
  };
}

vi.mock('@huggingface/transformers', () => {
  throw new Error('Cannot find package @huggingface/transformers');
});

vi.mock('@xenova/transformers', () => {
  throw new Error('Cannot find package @xenova/transformers');
});

describe('LocalCrossEncoderReranker with Transformers.js from providerOptions.transformers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('without it, neither package imports here: the provider is unavailable', async () => {
    expect(await new LocalCrossEncoderReranker({ providerId: 'local' }).isAvailable()).toBe(false);
  });

  const cases = [
    { name: 'a function that imports 3.x', supplied: () => Promise.resolve(transformersModule('3.8.1')), modelFile: 'onnx/model_fp16.onnx' },
    { name: 'the 3.x module itself', supplied: transformersModule('3.8.1'), modelFile: 'onnx/model_fp16.onnx' },
    { name: 'a function that imports 2.x', supplied: () => Promise.resolve(transformersModule('2.17.2')), modelFile: 'onnx/model.onnx' },
  ];

  for (const c of cases) {
    it(`${c.name}: available, and a rerank scores with it and names the file that version loads`, async () => {
      const reranker = new LocalCrossEncoderReranker({
        providerId: 'local',
        modelFileName: 'model',
        dtype: 'fp16',
        providerOptions: { transformers: c.supplied },
      });

      expect(await reranker.isAvailable()).toBe(true);
      const result = await reranker.rerank(
        { query: 'q', documents: [{ id: 'a', content: 'a' }, { id: 'b', content: 'b' }] },
        { providerId: 'local', modelId: '' },
      );

      expect(modelFromPretrained).toHaveBeenCalledTimes(1);
      expect(result.results.map((r) => r.id).sort()).toEqual(['a', 'b']);
      expect(result.diagnostics?.providerMetrics).toMatchObject({ modelFile: c.modelFile });
    });
  }

  it('a function that rejects: the provider is unavailable and a rerank throws', async () => {
    const reranker = new LocalCrossEncoderReranker({
      providerId: 'local',
      providerOptions: { transformers: () => Promise.reject(new Error('not bundled')) },
    });

    expect(await reranker.isAvailable()).toBe(false);
    await expect(
      reranker.rerank({ query: 'q', documents: [{ id: 'a', content: 'a' }] }, { providerId: 'local', modelId: '' }),
    ).rejects.toThrow(/Transformers\.js is not installed/);
  });
});
