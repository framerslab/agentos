/**
 * @file no-content-on-lines.spec.ts
 * @description One case for each path where a person's words, a model's answer, a key or a phone number could reach
 * a log line. Each case drives the real code with a marker in its input and fails when the marker reaches standard
 * output, standard error or the handed-over logger, whichever way the line is written.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { markerCapture } from './markerCapture.js';
import { AgentOS } from '../../src/api/AgentOS.js';
import { GMIManager } from '../../src/cognition/substrate/GMIManager.js';
import { AgentCore } from '../../src/agents/definitions/AgentCore.js';
import { AgentPoolAgent } from '../../src/agents/definitions/AgentPoolAgent.js';
import { AgentPoolStrategy } from '../../src/agents/definitions/AgentPoolConfig.js';
import { ConversationContext } from '../../src/core/conversation/ConversationContext.js';
import { GMIChunkTransformer } from '../../src/api/runtime/GMIChunkTransformer.js';
import { VectorStoreManager } from '../../src/cognition/rag/VectorStoreManager.js';
import { ChannelRouter } from '../../src/io/channels/ChannelRouter.js';
import { LLMUtilityAI } from '../../src/cognition/nlp/ai_utilities/LLMUtilityAI.js';
import { PlanningEngine } from '../../src/orchestration/planner/PlanningEngine.js';
import { StructuredOutputManager } from '../../src/api/structured/output/StructuredOutputManager.js';
import { AgencyMemoryManager } from '../../src/agents/agency/AgencyMemoryManager.js';
import { OpenAIProvider } from '../../src/core/llm/providers/implementations/OpenAIProvider.js';
import { AnthropicProvider } from '../../src/core/llm/providers/implementations/AnthropicProvider.js';
import { GeminiProvider } from '../../src/core/llm/providers/implementations/GeminiProvider.js';
import { OllamaProvider } from '../../src/core/llm/providers/implementations/OllamaProvider.js';
import { OpenRouterProvider } from '../../src/core/llm/providers/implementations/OpenRouterProvider.js';
import axios, { AxiosError } from 'axios';
import { Readable } from 'node:stream';
const marker = 'sentinel-words-7731';
const reply = (content: string) => ({ choices: [{ message: { content }, finishReason: 'stop' }], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
function manager(content: string) { return { getProvider: () => ({ generateCompletion: async () => reply(content), checkHealth: async () => ({ isHealthy: true }) }) } as any; }
function sse(text: string) { return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } }); }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('no content on any output channel', () => {
  it('AgentOS feedback', async () => markerCapture(marker, async legacy => {
    const agent = new AgentOS(legacy);
    Object.assign(agent, { initialized: true, gmiManager: { processUserFeedback: async () => {} } });
    await agent.receiveFeedback('user-1', 'session-1', 'persona-1', { text: marker, correctedContent: marker });
  }));
  it('GMI feedback', async () => markerCapture(marker, async () => {
    const gmi = { recordUserFeedback: vi.fn(async () => {}) };
    const manager = Object.assign(Object.create(GMIManager.prototype), { isInitialized: true, managerId: 'manager-1', gmiSessionMap: new Map([['session-1', 'gmi-1']]), activeGMIs: new Map([['gmi-1', gmi]]) });
    manager.ensureInitialized = () => {};
    await manager.processUserFeedback('user-1', 'session-1', 'persona-1', { text: marker, correctedContent: marker });
    expect(gmi.recordUserFeedback).toHaveBeenCalled();
  }));
  it.each(['NONE', marker])('pool routing %s', async answer => markerCapture(marker, async () => {
    const agent = Object.assign(Object.create(AgentPoolAgent.prototype), {
      name: 'pool-1', isInitialized: true,
      poolConfig: { strategy: AgentPoolStrategy.UNIFIED_PERSONA_ROUTING, subAgentIds: ['agent-1'] },
      subAgents: new Map([['agent-1', { id: 'agent-1', name: 'specialist', description: 'Handles requests' }]]),
      callLLM: async () => reply(answer),
    });
    expect((await agent.processTurn(marker, new ConversationContext('conversation-1'))).responseText).toContain('rephrase');
  }));
  it('invalid vector store credentials', async () => markerCapture(marker, async () => {
    const store = new VectorStoreManager();
    try { await store.initialize({ providers: [{ type: 'pinecone', apiKey: marker }, { id: 'store-2', connectionString: marker }, { apiKey: marker }] } as any, []); }
    finally { await store.shutdownAllProviders(); }
  }));
  it.each(['plivo', 'whatsapp', 'signal'])('channel %s phone', async platform => markerCapture('+15555550123', async () => {
    const router = new ChannelRouter();
    router.addBinding({ bindingId: 'b1', seedId: 'seed-1', ownerUserId: 'owner-1', platform, channelId: '+15555550123', conversationType: 'direct', isActive: true, autoBroadcast: false } as any);
    router.onMessage(() => { throw Object.assign(new TypeError('Handler failed'), { phone: '+15555550123' }); });
    await router.routeInboundMessage({ messageId: 'm1', platform, conversationId: '+15555550123', conversationType: 'direct', sender: { id: '+15555550123' }, content: [{ type: 'text', text: marker }], text: marker, timestamp: new Date().toISOString() } as any);
  }));
  it('tool argument parsing', async () => markerCapture(marker, async () => {
    const agent = Object.assign(Object.create(AgentCore.prototype), { name: 'agent-1', isInitialized: true });
    expect(agent.parseLLMResponse({ id: 'reply-1', object: 'chat.completion', created: 1, modelId: 'model-1', choices: [{ index: 0, finishReason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: marker } }] } }] }).toolCalls).toBeUndefined();
  }));
  it('unhandled GMI chunk', async () => markerCapture(marker, async () => {
    const transformer = new GMIChunkTransformer(new Map(), {} as any, {} as any, false, async () => {});
    await transformer.transformAndPushGMIChunk('stream-1', { gmi: { getGMIId: () => 'gmi-1' }, personaId: 'persona-1' } as any, { type: 'unknown', content: marker } as any);
  }));
  it.each(['parseJsonSafe', 'extractKeywords', 'detectLanguage'] as const)('language %s', async method => markerCapture(marker, async () => {
    const utility = new LLMUtilityAI();
    await utility.initialize({ utilityId: 'utility-1', llmProviderManager: manager(method === 'parseJsonSafe' ? marker : JSON.stringify({ text: marker })), defaultModelId: 'model-1', defaultProviderId: 'openai' });
    if (method === 'parseJsonSafe') { expect(await utility.parseJsonSafe(marker)).toBeNull(); expect(await utility.parseJsonSafe(marker, { attemptFixWithLLM: true })).toBeNull(); }
    else await utility[method](marker);
  }));
  it('planning failure and autonomous loop', async () => markerCapture(marker, async logger => {
    const planner = new PlanningEngine({ llmProvider: manager(marker), logger });
    await expect(planner.generatePlan(marker)).rejects.toThrow();
    await planner.decomposeTask(marker).catch(() => undefined);
    expect((await planner.runAutonomousLoop(marker).next()).done).toBe(true);
  }));
  it('structured output recovery', async () => markerCapture(marker, async logger => {
    const structured = new StructuredOutputManager({ llmProviderManager: manager(marker), logger });
    await expect(structured.generate({ prompt: 'Return an object', schema: { type: 'object' }, strategy: 'json_mode', maxRetries: 0 })).rejects.toThrow();
  }));
  it('agency memory query', async () => markerCapture(marker, async logger => {
    const memory = new AgencyMemoryManager({ getDefaultProvider: () => ({ query: async () => ({ documents: [] }) }) } as any, logger);
    expect((await memory.querySharedMemory('agency-1', { query: marker, requestingGmiId: 'gmi-1', requestingRoleId: 'role-1' }, { enabled: true })).success).toBe(true);
  }));
  it.each(['chat', 'responses', 'trailing'] as const)('OpenAI %s parser', async path => markerCapture(marker, async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal('fetch', fetcher); const provider = new OpenAIProvider(); await provider.initialize({ apiKey: 'test-key' });
    const completed = `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'reply-1', status: 'completed', output: [] } })}\n\n`;
    fetcher.mockResolvedValueOnce(sse(path === 'trailing' ? marker : `data: ${marker}\n\n${path === 'responses' ? completed : ''}`));
    const options = path === 'responses' ? { effort: 'high', tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }] } : {};
    for await (const _ of provider.generateCompletionStream(path === 'responses' ? 'gpt-5.5' : 'gpt-4o', [{ role: 'user', content: 'hello' }], options as any)) { /* Drain parser. */ }
  }));
  it.each(['stream', 'completion'] as const)('Anthropic %s parser', async path => markerCapture(marker, async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const provider = new AnthropicProvider(); await provider.initialize({ apiKey: 'test-key' });
    const events = [marker, JSON.stringify({ type: 'message_start', message: { id: 'reply-1', model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 0 } } }), JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }), JSON.stringify({ type: 'message_stop' })];
    fetcher.mockResolvedValueOnce(sse(events.map(event => `data: ${event}\n\n`).join('')));
    if (path === 'completion') await provider.generateCompletion('claude-sonnet-4-6', [{ role: 'user', content: 'hello' }], { cache: false });
    else for await (const _ of provider.generateCompletionStream('claude-sonnet-4-6', [{ role: 'user', content: 'hello' }], { cache: false })) { /* Drain parser. */ }
  }));
  it('Gemini parser', async () => markerCapture(marker, async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const provider = new GeminiProvider(); await provider.initialize({ apiKey: 'test-key' });
    fetcher.mockResolvedValueOnce(sse(`data: ${marker}\n\n`));
    for await (const _ of provider.generateCompletionStream('gemini-2.5-flash', [{ role: 'user', content: 'hello' }], {})) { /* Drain parser. */ }
  }));
  it('Ollama malformed and split line', async () => markerCapture(marker, async () => {
    const create = axios.create.bind(axios);
    vi.spyOn(axios, 'get').mockResolvedValue({ data: 'Ollama is running' });
    // Buffers, as axios's http adapter delivers them. The malformed line arrives whole in the first chunk, so a warning
    // that printed it would carry the marker, and the reply line is cut nine bytes in, so its text arrives only when
    // the reader joins the two chunks.
    const body = Buffer.from(`${marker}\n${JSON.stringify({ model: 'test', message: { role: 'assistant', content: 'ok' }, done: true })}\n`);
    const cut = marker.length + 1 + 9;
    vi.spyOn(axios, 'create').mockImplementation(config => create({ ...config, adapter: async config => ({ status: 200, statusText: 'OK', headers: {}, config, data: Readable.from([body.subarray(0, cut), body.subarray(cut)]) }) }));
    const provider = new OllamaProvider(); await provider.initialize({ baseURL: 'http://localhost:11434' });
    let text = '';
    for await (const chunk of provider.generateCompletionStream('test', [{ role: 'user', content: 'hello' }], {})) text += chunk.responseTextDelta ?? '';
    expect(text).toBe('ok');
  }));
  it.each(['completion', 'embedding', 'stream'] as const)('OpenRouter %s', async kind => markerCapture(marker, async () => {
    const create = axios.create.bind(axios);
    vi.spyOn(axios, 'create').mockImplementation(config => create({ ...config, adapter: async config => {
      if (config.url === '/models') return { status: 200, statusText: 'OK', headers: {}, config, data: { data: [] } };
      if (kind === 'stream') return { status: 200, statusText: 'OK', headers: {}, config, data: Readable.from([`data: ${marker}\n\ndata: [DONE]\n\n`]) };
      throw new AxiosError('Request rejected', AxiosError.ERR_BAD_REQUEST, config, {}, { status: 400, statusText: 'Bad Request', headers: {}, config, data: { error: { message: 'Request rejected' } } });
    } }));
    const provider = new OpenRouterProvider(); await provider.initialize({ apiKey: 'test-key' });
    if (kind === 'stream') { for await (const _ of provider.generateCompletionStream('openai/gpt-4o', [{ role: 'user', content: marker }], {})) { /* Drain parser. */ } return; }
    const request: Promise<unknown> = kind === 'embedding'
      ? provider.generateEmbeddings('openai/text-embedding-3-small', [marker])
      : provider.generateCompletion('openai/gpt-4o', [{ role: 'user', content: marker }], {});
    const failure = await request.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    // AgentOS's own statements and its callers print a caught error whole, details included, so the details must not
    // carry the request's words.
    console.error('Request failed', failure);
  }));
});
