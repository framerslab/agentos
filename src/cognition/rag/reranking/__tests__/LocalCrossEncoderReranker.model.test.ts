/**
 * Real-model test of LocalCrossEncoderReranker on cross-encoder/ms-marco-MiniLM-L-6-v2.
 *
 * Nothing is stubbed: Transformers.js loads the model's tokenizer and ONNX
 * weights and the provider reranks 20 texts, one of which answers the query.
 * The answer must come first and the 20 scores must differ, for the default
 * weights (the repository's onnx/model_quint8_avx2.onnx) and for the
 * full-precision onnx/model.onnx.
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
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalCrossEncoderReranker } from '../providers/LocalCrossEncoderReranker';

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

  const cases: Array<{ name: string; modelFileName?: string; batchSize?: number }> = [
    { name: 'default weights (onnx/model_quint8_avx2.onnx)' },
    { name: 'full precision (onnx/model.onnx), batches of 8', modelFileName: 'model', batchSize: 8 },
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
          modelFile: `onnx/${c.modelFileName ?? 'model_quint8_avx2'}.onnx`,
        });
      } finally {
        await reranker.dispose();
      }
    });
  }
});
