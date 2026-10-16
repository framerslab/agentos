import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createReferenceServer } from '../reference-server/server.js';
import { factoryFixture } from './factoryFixtures.js';
import { reasoningFixture } from './ReasoningProviderResolver.test.js';
import { browserIdentity } from './credentialFixtures.js';
import { captureVoiceScope } from '../VoiceScopeContext.js';
import { CreateAgentSchema } from '../contracts/index.js';
import { VoiceToolRegistry } from '../reasoning/tools.js';
const fakeKey = 'not-a-real-reference-server-secret';
async function fixture(key: string | undefined = fakeKey, capacity = 1) {
  const f = await factoryFixture(); const r = reasoningFixture();
  const reference = createReferenceServer({ scopeId: 'scope-a', key, synthesisLimits: { maxTextCharacters: 8192, maxSynthesisRequests: 96 }, publicOrigin: 'http://127.0.0.1:4300', allowedOrigins: ['https://client.example.test'],
    speech: f.speech, reasoning: r.resolver, options: { read: async () => ({}) }, tools: new VoiceToolRegistry([]),
    capacity: { version: 'fixture-bench', validUntil: Date.now() + 60000, scopeSlots: capacity, hostSlots: capacity },
    scope: (agent, callId, principal, signal) => captureVoiceScope({ ...f.request.scope, callId, principal, signal,
      policy: { ...f.request.scope.policy, identity: { ...f.request.scope.policy.identity, callId }, fallback: agent.providerPolicy.fallback } }) });
  reference.server.listen(0, '127.0.0.1'); await once(reference.server, 'listening');
  const address = reference.server.address(); if (!address || typeof address === 'string') throw new Error('fixture address');
  const url = `http://127.0.0.1:${address.port}/api/v1`;
  const request = (path: string, method = 'GET', body?: unknown, token: string | null = fakeKey) => fetch(url + path, { method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const { version: _version, agentId: _id, scopeId: _scope, revision: _revision, state: _state, createdAt: _created, updatedAt: _updated, ...editable } = f.request.agent;
  const agentInput = CreateAgentSchema.parse({ ...editable, transcriptPolicy: { mode: 'none' }, webhookRef: null });
  return { reference, request, agentInput };
}
describe('single-scope reference HTTP authority', () => {
  it('recovers a safely refused preparation without a runtime or held capacity', async () => {
    const f = await fixture(fakeKey, 0); const browser = browserIdentity(); const clock = vi.spyOn(Date, 'now');
    try {
      const agent = await (await f.request('/agents', 'POST', f.agentInput)).json();
      const input = { agentId: agent.agentId, clientOrigin: 'https://client.example.test', proofKeyThumbprint: browser.thumbprint, maxDurationSeconds: f.agentInput.limits.maxDurationSeconds, idempotencyKey: 'capacity-refused' };
      expect((await f.request('/web-calls', 'POST', input)).status).toBe(503);
      const list = await (await f.request('/calls')).json(); expect(list.items).toHaveLength(1); const id = list.items[0].callId;
      clock.mockReturnValue(Date.now() + f.agentInput.limits.setupTimeoutMs + f.agentInput.limits.cleanupTimeoutMs + 1);
      await f.reference.drain(id); await f.reference.drain(id);
      expect(await (await f.request(`/calls/${id}`)).json()).toMatchObject({ state: 'failed', usage: { connectedMs: 0, billableSeconds: 0 } });
      expect((await (await f.request('/usage')).json()).items).toHaveLength(1);
    } finally { clock.mockRestore(); await f.reference.close(); }
  });
  it('refuses startup without a configured key', async () => { await expect(fixture('')).rejects.toThrow('configured key'); });
  it('rejects absent, incorrect and revoked keys on private routes', async () => {
    const f = await fixture();
    try {
      expect((await f.request('/agents', 'GET', undefined, null)).status).toBe(401);
      expect((await f.request('/agents', 'GET', undefined, 'wrong')).status).toBe(401);
      expect((await f.request('/agents')).status).toBe(200);
      await f.reference.revoke(); expect((await f.request('/agents')).status).toBe(401);
    } finally { await f.reference.close(); }
  });
  it('keeps closed schemas, immutable revisions and route-bound cursors', async () => {
    const f = await fixture();
    try {
      expect((await f.request('/agents', 'POST', { ...f.agentInput, scopeId: 'foreign' })).status).toBe(400);
      const a = await (await f.request('/agents', 'POST', f.agentInput)).json();
      await f.request('/agents', 'POST', { ...f.agentInput, name: 'Second' });
      const page = await (await f.request('/agents?limit=1')).json(); expect(page.items).toHaveLength(1); expect(page.nextCursor).toBeTypeOf('string');
      expect((await f.request('/calls?cursor=' + page.nextCursor)).status).toBe(400);
      expect((await f.request('/agents/' + a.agentId, 'PATCH', { expectedRevision: 2, changes: { name: 'Changed' } })).status).toBe(409);
      const revised = await (await f.request('/agents/' + a.agentId, 'PATCH', { expectedRevision: 1, changes: { name: 'Changed' } })).json(); expect(revised.revision).toBe(2);
      expect((await f.request('/agents?scopeId=foreign')).status).toBe(400);
      expect((await f.request('/agents', 'POST', { ...f.agentInput, transcriptPolicy: { mode: 'retained', retentionSeconds: 60 } })).status).toBe(422);
    } finally { await f.reference.close(); }
  });
  it('returns one prepared grant, denies its use as an account key and stops idempotently without media', async () => {
    const f = await fixture(); const browser = browserIdentity();
    try {
      const agent = await (await f.request('/agents', 'POST', f.agentInput)).json();
      const input = { agentId: agent.agentId, clientOrigin: 'https://client.example.test', proofKeyThumbprint: browser.thumbprint, maxDurationSeconds: f.agentInput.limits.maxDurationSeconds, idempotencyKey: 'call-a' };
      const response = await f.request('/web-calls', 'POST', input); expect(response.status).toBe(201); const grant = await response.json();
      const retried = await (await f.request('/web-calls', 'POST', input)).json(); expect(retried).toEqual(grant);
      expect((await f.request('/agents', 'GET', undefined, grant.token)).status).toBe(401);
      const receipt = await (await f.request(`/calls/${grant.callId}/stop`, 'POST', { idempotencyKey: 'stop-a' })).json();
      expect(await (await f.request(`/calls/${grant.callId}/stop`, 'POST', { idempotencyKey: 'stop-a' })).json()).toEqual(receipt);
      await f.reference.drain(grant.callId); const call = await (await f.request(`/calls/${grant.callId}`)).json(); expect(call.state).toBe('ended');
      const usage = await (await f.request('/usage')).json(); expect(usage.items[0]).toMatchObject({ final: true, connectedMs: 0, billableSeconds: 0 });
      await f.reference.revoke(); expect((await f.request(`/web-calls/${grant.callId}/connect`, 'POST', {}, grant.token)).status).toBe(401);
    } finally { await f.reference.close(); }
  });
  it('replays stored lifecycle events after a sequence as an event stream', async () => {
    const f = await fixture(); const browser = browserIdentity();
    try {
      const agent = await (await f.request('/agents', 'POST', f.agentInput)).json();
      const input = { agentId: agent.agentId, clientOrigin: 'https://client.example.test', proofKeyThumbprint: browser.thumbprint, maxDurationSeconds: f.agentInput.limits.maxDurationSeconds, idempotencyKey: 'call-events' };
      const grant = await (await f.request('/web-calls', 'POST', input)).json();
      await f.request(`/calls/${grant.callId}/stop`, 'POST', { idempotencyKey: 'stop-events' }); await f.reference.drain(grant.callId);
      const stream = await f.request(`/calls/${grant.callId}/events`);
      expect(stream.status).toBe(200); expect(stream.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      const text = await stream.text(); const prefix = 'id: 1\ndata: ';
      expect(text.startsWith(prefix)).toBe(true); expect(text.endsWith('\n\n')).toBe(true);
      expect(JSON.parse(text.slice(prefix.length, -2))).toMatchObject({ callId: grant.callId, sequence: 1, type: 'call.ended' });
      expect(await (await f.request(`/calls/${grant.callId}/events?afterSequence=1`)).text()).toBe('');
      for (const query of ['afterSequence=-1', 'afterSequence=1.5', 'afterSequence=0&afterSequence=1', 'since=0']) expect((await f.request(`/calls/${grant.callId}/events?${query}`)).status).toBe(400);
      expect((await f.request(`/calls/${grant.callId}/events`, 'GET', undefined, null)).status).toBe(401);
      expect((await f.request(`/calls/${grant.callId}/events`, 'GET', undefined, grant.token)).status).toBe(401);
      expect((await f.request('/calls/missing-call/events')).status).toBe(404);
      await f.reference.revoke(); expect((await f.request(`/calls/${grant.callId}/events`)).status).toBe(401);
    } finally { await f.reference.close(); }
  });
});
