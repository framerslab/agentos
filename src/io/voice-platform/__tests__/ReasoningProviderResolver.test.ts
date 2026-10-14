import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { ReasoningProviderResolver, sealVoiceCredential, sealedVoiceCredentials, type RegisteredReasoningEndpoint } from '../ReasoningProviderResolver.js';
import { VoiceToolRegistry } from '../reasoning/tools.js';
import { ReasoningConfigSchema } from '../contracts/index.js';
import { scopeFixture } from './VoiceScopeContext.test.js';
import { captureVoiceScope } from '../VoiceScopeContext.js';
import { CountingAttemptBudget } from '../../../safety/runtime/ModelAttemptBudget.js';
import type { EgressConnector } from '../../../safety/egress/CheckedEgress.js';
const limits = { maxAttempts: 3, perAttempt: { input_token: 8192, output_token: 512, reasoning_token: 512, cached_input_token: 8192, request: 1 } };
/** Versioned synthetic endpoint used by the executable examples' CI checks. */
export function reasoningFixture(connector?: EgressConnector) {
  const stopped = vi.fn(async () => ({ stopped: true as const, evidenceRef: 'native-ack-a' }));
  const endpoint: RegisteredReasoningEndpoint = { scopeId: 'scope-a', endpointRef: 'endpoint-a', revision: 1, providerId: 'model', origin: 'https://model.example.test',
    protocol: { id: 'openai-chat-completions', version: 1 }, modelId: 'model-a', modelRevision: 'weights-a', locality: 'local', manifestDigest: 'weights-a',
    streaming: true, tools: true, cancellation: 'native_abort', usageUnits: { input_token: 'token', output_token: 'token', reasoning_token: 'token', cached_input_token: 'token', reasoningInOutput: true },
    rateVersion: 'local', conformanceRef: 'fixture-evidence', maxRequestBytes: 65536, maxResponseBytes: 65536, timeoutMs: 1000, reasoningEnabled: true };
  const registry = { get: async (_scope: string, ref: string, revision: number) => ref === endpoint.endpointRef && revision === endpoint.revision ? endpoint : undefined,
    local: async () => endpoint };
  const body = 'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17,"prompt_tokens_details":{"cached_tokens":2},"completion_tokens_details":{"reasoning_tokens":1}}}\n\n' + 'data: [DONE]\n\n';
  const send = vi.fn<EgressConnector>(connector ?? (async () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: (async function* () { yield body; })() })));
  const scope = scopeFixture(); const budget = new CountingAttemptBudget(limits); const record = vi.spyOn(budget, 'record');
  const resolver = new ReasoningProviderResolver({ registry, countInput: async () => 12, fence: stopped, lookup: async () => [{ address: '142.250.0.1', family: 4 }], connector: send });
  const config = ReasoningConfigSchema.parse({ provider: 'registered_endpoint', modelId: 'model-a', modelRevision: 'weights-a', protocol: endpoint.protocol,
    usageUnits: endpoint.usageUnits, attemptLimits: limits, cancellation: 'native_abort', endpointRef: 'endpoint-a', endpointRevision: 1, fallbacks: [] });
  const metadata = { identity: scope.policy.identity, speakers: [], endpointReason: 'silence_timeout' as const, speechDurationMs: 20, wasInterrupted: false, transcriptConfidence: 1 };
  return { scope, budget, record, resolver, endpoint, config, metadata, send, stopped };
}
describe('registered reasoning resolution', () => {
  it('counts a request once, separates cached input and keeps reasoning inside output', async () => {
    const f = reasoningFixture(); const session = await f.resolver.resolve(f.scope, f.config, f.budget, '', new VoiceToolRegistry([]));
    let text = ''; for await (const part of session.sendText('fixture', f.metadata)) text += part;
    expect(text).toBe('hello'); expect(f.record).toHaveBeenCalledWith('local_1', { input_token: 10, cached_input_token: 2, output_token: 5, reasoning_token: 1, request: 1 }, true);
    expect(JSON.parse(String(f.send.mock.calls[0]![0].body))).toMatchObject({ model: 'model-a', stream: true, stream_options: { include_usage: true }, max_completion_tokens: 512 });
    await session.whenIdle(); expect(f.stopped).not.toHaveBeenCalled();
  });
  it('seals scope and provider context and refuses copied credential rows', async () => {
    const key = { id: 'fixture', key: new Uint8Array(32).fill(1) };
    const row = sealVoiceCredential('scope-a', 'model', 'credential-a', 'not-a-real-secret', key);
    const credentials = sealedVoiceCredentials({ read: async () => row }, [key]); const f = reasoningFixture();
    const request = { scopeId: 'scope-a', callId: 'call-a', providerId: 'model', purpose: 'reasoning' as const, credentialRef: 'credential-a', signal: f.scope.signal };
    expect(await credentials.resolve(request)).toBe('not-a-real-secret');
    await expect(credentials.resolve({ ...request, scopeId: 'scope-b' })).rejects.toThrow();
    await expect(credentials.resolve({ ...request, providerId: 'other' })).rejects.toThrow();
  });
  it('freezes the admitted endpoint, rejects foreign registration and checks hosted egress before bytes', async () => {
    const f = reasoningFixture(); const session = await f.resolver.resolve(f.scope, f.config, f.budget, '', new VoiceToolRegistry([]));
    f.endpoint.origin = 'http://127.0.0.1'; let text = ''; for await (const part of session.sendText('fixture', f.metadata)) text += part;
    expect(text).toBe('hello'); expect(f.send.mock.calls[0]![0].destination.hostname).toBe('model.example.test');
    const hosted = captureVoiceScope({ ...f.scope, policy: { ...f.scope.policy, mode: 'hosted' } });
    await expect(f.resolver.resolve(hosted, f.config, f.budget, '', new VoiceToolRegistry([]))).rejects.toThrow();
    f.endpoint.scopeId = 'scope-b'; await expect(f.resolver.resolve(f.scope, f.config, f.budget, '', new VoiceToolRegistry([]))).rejects.toThrow();
  });
  it('retains unknown usage and refuses to acknowledge cancellation before native stop evidence', async () => {
    let signal: AbortSignal | undefined; let finish!: () => void;
    const f = reasoningFixture(async (request) => { signal = request.signal; return { status: 200, headers: {}, body: (async function* () {
      yield 'data: {"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\n';
      await new Promise<void>((resolve) => { if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve(), { once: true }); });
    })() }; });
    f.stopped.mockImplementation(async () => { await new Promise<void>((resolve) => { finish = resolve; }); return { stopped: true, evidenceRef: 'native-ack-b' }; });
    const session = await f.resolver.resolve(f.scope, f.config, f.budget, '', new VoiceToolRegistry([]));
    const iterator = session.sendText('fixture', f.metadata)[Symbol.asyncIterator](); expect(await iterator.next()).toMatchObject({ value: 'a' });
    session.abort(); const next = iterator.next().catch(() => ({ done: true }));
    await vi.waitFor(() => expect(f.stopped).toHaveBeenCalledOnce()); expect(signal!.aborted).toBe(true);
    let idle = false; const fence = session.whenIdle().then(() => { idle = true; }); await Promise.resolve(); expect(idle).toBe(false);
    finish(); await next; await fence; expect(f.record).not.toHaveBeenCalled();
  });
  it('refuses unknown usage units and exhausted authorization before a second request', async () => {
    const f = reasoningFixture(async () => ({ status: 200, headers: {}, body: (async function* () { yield 'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"image_tokens":4}}\n\ndata: [DONE]\n\n'; })() }));
    const session = await f.resolver.resolve(f.scope, f.config, new CountingAttemptBudget({ ...limits, maxAttempts: 1 }), '', new VoiceToolRegistry([]));
    const consume = async () => { for await (const part of session.sendText('fixture', f.metadata)) void part; };
    await expect(consume()).rejects.toThrow(); await expect(consume()).rejects.toThrow(); expect(f.send).toHaveBeenCalledOnce();
  });
  it('checks tool schema and scope before sending and cannot accept a forged destination', async () => {
    const f = reasoningFixture(); const tool = { ref: 'lookup-a', scopeId: 'scope-a', providerId: 'model', url: 'https://tools.example.test/lookup',
      input: z.strictObject({ query: z.string().max(20) }), output: z.strictObject({ answer: z.string().max(20) }), description: 'Lookup a fixture',
      fence: async () => ({ stopped: true as const, evidenceRef: 'tool-ack' }) };
    const tools = new VoiceToolRegistry([tool], { lookup: async () => [{ address: '142.250.0.1', family: 4 }], connector: f.send });
    const scope = captureVoiceScope({ ...f.scope, allowedToolRefs: ['lookup-a'] });
    await expect(tools.execute(scope, 'lookup-a', { query: 'a', url: 'http://127.0.0.1' }, 'attempt-a', scope.signal)).rejects.toThrow();
    await expect(tools.execute(scope, 'other', {}, 'attempt-a', scope.signal)).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });
});
