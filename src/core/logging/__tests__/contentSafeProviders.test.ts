import { Readable } from 'node:stream';
import axios, { type AxiosAdapter, type CreateAxiosDefaults } from 'axios';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { enableContentSafeTelemetry, type ContentSafeLogEvent } from '../contentSafeTelemetry.js';
import { OpenRouterProvider } from '../../llm/providers/implementations/OpenRouterProvider.js';
import { EmbeddingManager } from '../../../cognition/rag/EmbeddingManager.js';
import type { AIModelProviderManager } from '../../llm/providers/AIModelProviderManager.js';
import { globalLLMProviderHealth } from '../../safety/LLMProviderHealthRegistry.js';
import { generateText } from '../../../api/generateText.js';

const fake = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../../../api/model.js', () => ({
  resolveModelOption: (opts: { provider?: string; model?: string }) => ({
    providerId: opts.provider ?? 'openai', modelId: opts.model ?? 'fixture-model',
  }),
  resolveProvider: (providerId: string, modelId: string) => ({ providerId, modelId, apiKey: 'fixture-key' }),
  knownProviderPrefixOf: () => undefined,
  createProviderManager: async () => ({ getProvider: () => ({ generateCompletion: fake.complete }) }),
}));

const canary = 'fixture-private-body-7391';
const output: ContentSafeLogEvent[] = [];
const native = ['log', 'info', 'warn', 'error', 'debug'] as const;
const nativeCalls: unknown[] = [];

beforeAll(() => {
  for (const level of native) vi.spyOn(console, level).mockImplementation((...args) => {
    nativeCalls.push(args);
  });
  enableContentSafeTelemetry((event) => { output.push(event); });
});
afterAll(() => { vi.restoreAllMocks(); });

it('keeps fallback and builder exception echoes out of every log sink', async () => {
  globalLLMProviderHealth.reset();
  fake.complete.mockImplementation(async (model: string) => {
    if (model === 'fixture-fallback') return {
      modelId: model, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      choices: [{ message: { role: 'assistant', content: 'fixture-result' }, finishReason: 'stop' }],
    };
    throw Object.assign(new Error(`503 ${canary}`), { httpStatus: 503 });
  });
  const before = output.length;
  const result = await generateText({
    provider: 'anthropic', model: 'fixture-primary', prompt: canary, cache: false,
    fallbackProviders: [{ provider: 'openai', model: 'fixture-fallback', cache: false }],
    _responseFormatBuilder: () => { throw new Error(canary); },
  });
  expect(result.text).toBe('fixture-result');
  expect(fake.complete).toHaveBeenCalled();
  expect(output.length).toBeGreaterThan(before);
  expect(JSON.stringify(output)).not.toContain(canary);
  expect(nativeCalls).toEqual([]);
});

it('intercepts actual stream parse and embedding failure diagnostics', async () => {
  const transport: AxiosAdapter = async (config) => ({
    status: 200, statusText: 'OK', headers: {}, config,
    data: config.url === '/models' ? { data: [] }
      : Readable.from([Buffer.from(`data: ${canary}\n\ndata: [DONE]\n\n`)]),
  });
  const original = axios.create.bind(axios);
  vi.spyOn(axios, 'create').mockImplementation((config?: CreateAxiosDefaults) =>
    original({ ...config, adapter: transport }));
  const before = output.length;
  const provider = new OpenRouterProvider();
  await provider.initialize({ apiKey: 'fixture-key' });
  const chunks = [];
  for await (const chunk of provider.generateCompletionStream(
    'fixture-model', [{ role: 'user', content: canary }], {},
  )) chunks.push(chunk);
  expect(chunks).toEqual([]);
  const embed = vi.fn(async () => { throw new Error(canary); });
  const manager = new EmbeddingManager();
  await manager.initialize({
    enableCache: false,
    embeddingModels: [{ modelId: 'fixture-model', providerId: 'fixture-provider', dimension: 3, isDefault: true }],
  }, { getProvider: () => ({ providerId: 'fixture-provider', generateEmbeddings: embed }) }
    as unknown as AIModelProviderManager);
  const result = await manager.generateEmbeddings({ texts: [canary] });
  expect(embed).toHaveBeenCalled();
  expect(result.errors?.length).toBe(1);
  expect(output.length).toBeGreaterThan(before);
  expect(JSON.stringify(output)).not.toContain(canary);
  expect(nativeCalls).toEqual([]);
});
