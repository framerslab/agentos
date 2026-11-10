/**
 * @fileoverview LocalCrossEncoderReranker on the Transformers.js 2.x fallback (`@xenova/transformers`).
 *
 * `@huggingface/transformers` fails to import here, so the provider loads through the
 * `@xenova/transformers` stub. Transformers.js 2.x reads `quantized` and not `dtype`: it
 * loads `onnx/<model_file_name>_quantized.onnx` when `quantized` is true and
 * `onnx/<model_file_name>.onnx` otherwise. The diagnostics must name that file.
 *
 * @module backend/agentos/rag/reranking/tests/LocalCrossEncoderReranker.xenova.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalCrossEncoderReranker, type LocalCrossEncoderConfig } from '../providers/LocalCrossEncoderReranker';

const tokenizerStub = vi.fn((_texts: string[], options: { text_pair: string[] }) => ({ __documents: options.text_pair }));
const modelStub: any = vi.fn(async (inputs: { __documents: string[] }) => {
  const n = inputs.__documents.length;
  return { logits: { dims: [n, 1], data: Float32Array.from(new Array(n).fill(0.5)) } };
});
modelStub.dispose = vi.fn(async () => {});
modelStub.config = { id2label: { '0': 'LABEL_0' } };

const modelFromPretrained = vi.fn(async () => modelStub);

vi.mock('@huggingface/transformers', () => {
  throw new Error('Cannot find package @huggingface/transformers');
});

vi.mock('@xenova/transformers', () => ({
  env: {},
  AutoTokenizer: { from_pretrained: vi.fn(async () => tokenizerStub) },
  AutoModelForSequenceClassification: { from_pretrained: modelFromPretrained },
}));

describe('LocalCrossEncoderReranker on @xenova/transformers 2.x', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const cases: Array<{ name: string; config: Omit<Partial<LocalCrossEncoderConfig>, 'providerId'>; modelFile: string }> = [
    { name: 'the default model', config: {}, modelFile: 'onnx/model_quint8_avx2.onnx' },
    { name: "dtype 'q8'", config: { dtype: 'q8' }, modelFile: 'onnx/model_quantized.onnx' },
    { name: "dtype 'fp16', which 2.x does not read", config: { dtype: 'fp16' }, modelFile: 'onnx/model.onnx' },
    { name: "modelFileName 'model_qint8_arm64' with dtype 'uint8'", config: { modelFileName: 'model_qint8_arm64', dtype: 'uint8' }, modelFile: 'onnx/model_qint8_arm64.onnx' },
  ];

  for (const c of cases) {
    it(`${c.name}: the diagnostics name the file 2.x loads, ${c.modelFile}`, async () => {
      const reranker = new LocalCrossEncoderReranker({ providerId: 'local', ...c.config });
      const result = await reranker.rerank(
        { query: 'q', documents: [{ id: 'a', content: 'a' }] },
        { providerId: 'local', modelId: '' },
      );

      expect(modelFromPretrained).toHaveBeenCalledTimes(1);
      const options = (modelFromPretrained.mock.calls[0] as any[])[1];
      expect(`onnx/${options.model_file_name}${options.quantized ? '_quantized' : ''}.onnx`).toBe(c.modelFile);
      expect(result.diagnostics?.providerMetrics).toMatchObject({ modelFile: c.modelFile });
    });
  }
});
