import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { InMemoryVoiceStore } from '../stores/memory.js';
import type { StoredVoiceCall } from '../stores/types.js';
import { VoiceCallManager, type CallActionContext, type VoiceCallHooks } from '../VoiceCallManager.js';
import { CallCredentials } from '../CallCredentials.js';
import { SlotLimiter, type SlotCapacity } from '../SlotLimiter.js';
import { VoiceSessionFactory, type ManagedVoiceSession, type VoiceSessionFactoryOptions } from '../VoiceSessionFactory.js';
import { WebSocketCallServer } from '../WebSocketCallServer.js';
import { VoiceApiErrorSchema, ClientOriginSchema, type CallEvent, type VoiceAgent, type InitiatingPrincipal } from '../contracts/index.js';
import { captureVoiceScope, type VoiceScopeContext } from '../VoiceScopeContext.js';
import type { SpeechProviderResolver, VoiceOptionsStore } from '../../speech/SpeechProviderResolver.js';
import type { ReasoningProviderResolver } from '../ReasoningProviderResolver.js';
import type { VoiceToolRegistry, VoiceNetworkDependencies } from '../reasoning/tools.js';
import { ReferenceRoutes, ReferenceHttpError } from './routes.js';
/** All authority and capabilities are supplied by the single-scope application's bootstrap. */
export interface ReferenceServerOptions {
  synthesisLimits: VoiceSessionFactoryOptions['synthesisLimits'];
  scopeId: string; key: string | undefined; publicOrigin: string; allowedOrigins: readonly string[]; capacity?: SlotCapacity;
  speech: SpeechProviderResolver; reasoning: ReasoningProviderResolver; options: VoiceOptionsStore; tools: VoiceToolRegistry; network?: VoiceNetworkDependencies;
  scope(agent: VoiceAgent, callId: string, principal: InitiatingPrincipal, signal: AbortSignal): VoiceScopeContext;
}
/** No implicit listen or ambient key lookup. The caller explicitly binds the returned server to loopback. */
export interface ReferenceServer {
  server: Server;
  revoke(): Promise<void>;
  drain(callId: string): Promise<void>;
  close(): Promise<void>;
}
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value));
}
/** One server-sent event per stored lifecycle event, its id the event's sequence; the response ends after them and a client resumes with afterSequence. */
function sendEvents(response: ServerResponse, status: number, events: readonly CallEvent[]): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(events.map((event) => `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!['POST', 'PATCH', 'DELETE'].includes(request.method ?? '')) { if (request.headers['content-length'] && request.headers['content-length'] !== '0') throw new ReferenceHttpError(400, 'invalid_request'); return undefined; }
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json' || request.headers['content-encoding']) throw new ReferenceHttpError(400, 'invalid_request');
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { const value = Buffer.from(chunk); bytes += value.length; if (bytes > 65536) throw new ReferenceHttpError(413, 'payload_too_large'); chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ReferenceHttpError(400, 'invalid_request'); }
}
/** Builds an authenticated local reference host over the same contracts, manager, factory and media binding. */
export function createReferenceServer(options: ReferenceServerOptions): ReferenceServer {
  if (!options.key || Buffer.byteLength(options.key) < 24 || Buffer.byteLength(options.key) > 512 || /\s/.test(options.key)) throw new Error('configured key required'); const configuredKey = options.key;
  options = Object.freeze({ ...options, allowedOrigins: Object.freeze([...options.allowedOrigins]), capacity: options.capacity ? Object.freeze({ ...options.capacity }) : undefined }); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.scopeId)) throw new Error('reference scope refused');
  const publicOrigin = ClientOriginSchema.parse(options.publicOrigin); const publicUrl = new URL(publicOrigin);
  if (publicUrl.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(publicUrl.hostname)) throw new Error('reference public origin refused');
  const allowedOrigins = new Set(options.allowedOrigins.map((origin) => ClientOriginSchema.parse(origin))); if (allowedOrigins.size === 0 || allowedOrigins.size > 32) throw new Error('reference origins refused');
  const keyHash = digest(configuredKey); const principal: InitiatingPrincipal = { kind: 'service_key', principalId: 'configured-key' };
  const store = new InMemoryVoiceStore(); const now = () => Date.now(); const lifecycle = new AbortController();
  const runtimes = new Map<string, ManagedVoiceSession>(); const completedActions = new Set<string>(); const draining = new Map<string, Promise<void>>();
  let active = true; let closing = false; let inFlight = 0;
  const state = async (id: string): Promise<StoredVoiceCall | undefined> => store.withTransaction(options.scopeId, async (tx) => (await tx.get('calls', id))?.value);
  const authorize = async (_tx: unknown, s: StoredVoiceCall): Promise<void> => {
    if (!active || s.call.scopeId !== options.scopeId || s.call.initiatingPrincipal.kind !== principal.kind || s.call.initiatingPrincipal.principalId !== principal.principalId) throw new Error('reference key revoked');
  };
  const credentials = new CallCredentials({ store, now, ttlMs: 120000, proofWindowMs: 30000, key: { id: 'process', key: randomBytes(32) }, authorize,
    issueMedia: (binding, token) => ({ token, url: `${publicUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${publicUrl.host}/api/v1/web-calls/${binding.callId}/media` }) });
  const owned = async (c: CallActionContext): Promise<ManagedVoiceSession | undefined> => runtimes.get(c.state.call.callId) ?? await factory.get(options.scopeId, c.state.call.callId);
  const safelyRejected = new Set<string>();
  const tracked = <T>(work: (c: CallActionContext) => Promise<T>, preparation = false) => async (c: CallActionContext): Promise<T> => {
    c.signal.throwIfAborted();
    try { const result = await work(c); completedActions.add(c.actionId); return result; }
    catch (error) {
      if (preparation && !runtimes.has(c.state.call.callId)) {
        const leases = await store.withTransaction(options.scopeId, (tx) => tx.list('slots'));
        // The awaited preparation has ended; every potentially owned effect required this lease.
        if (!leases.some((r) => r.value.callId === c.state.call.callId && !r.value.released)) safelyRejected.add(c.actionId);
      }
      throw error;
    }
  };
  const hooks: VoiceCallHooks = {
    reserveOnce: tracked(async (c) => `local:${c.state.call.callId}`),
    prepareOnce: tracked(async (c) => {
      if (!active) throw new Error('reference key revoked');
      const revision = routes.revision(c.state.call.agentId, c.state.call.agentRevision); const agent = { ...revision, limits: c.state.limits };
      const scope = captureVoiceScope(options.scope(agent, c.state.call.callId, principal, lifecycle.signal));
      if (scope.scopeId !== options.scopeId || scope.callId !== c.state.call.callId || scope.policy.mode !== 'local') throw new Error('reference local scope required');
      const runtime = await factory.startSession({ scope, agent, funding: { kind: 'local' }, slot: { scopeId: options.scopeId, callId: scope.callId, hostId: 'reference-host', holder: 'reference-worker', ttlMs: 15000, capacity: options.capacity } });
      runtimes.set(scope.callId, runtime);
    }, true),
    publishDispatchOnce: tracked(async (c) => { if (!runtimes.has(c.state.call.callId) || !active) throw new Error('runtime not prepared'); }),
    fenceContent: tracked(async () => {}),
    abortModelAndTools: tracked(async (c) => { await (await owned(c))?.abortModelAndTools(); }),
    cancelTts: tracked(async (c) => { await (await owned(c))?.cancelTts(); }),
    clearPlayback: tracked(async (c) => { await (await owned(c))?.clearPlayback(); }),
    drainTranscripts: tracked(async (c) => { await (await owned(c))?.drainTranscripts(c.signal); }),
    releaseMedia: tracked(async (c) => { await (await owned(c))?.releaseMedia(); }),
    confirmStopped: tracked(async (c) => {
      const runtime = await owned(c);
      if (runtime) return runtime.confirmStopped();
      const slots = await store.withTransaction(options.scopeId, (tx) => tx.list('slots'));
      if (slots.some((r) => r.value.callId === c.state.call.callId && !r.value.released)) throw new Error('reference worker fence missing');
      return { workerGeneration: c.state.call.workerGeneration, workerStopped: true, mediaClosed: true, inferenceStopped: true, evidenceRef: 'reference-never-dispatched' };
    }),
    releaseSlots: tracked(async (c) => { await (await owned(c))?.releaseSlots(); }),
    settleOnce: async (c) => { completedActions.add(c.actionId); },
    fenceAction: async (_s, action) => completedActions.has(action.id) || safelyRejected.has(action.id),
  };
  const manager = new VoiceCallManager({ store, hooks, now, workerLeaseMs: 15000 });
  const limiter = new SlotLimiter({ store, now });
  const factory = new VoiceSessionFactory({ store, manager, limiter, credentials, speech: options.speech, reasoning: options.reasoning, options: options.options, tools: options.tools,
    network: options.network, synthesisLimits: options.synthesisLimits, now, authorizeMedia: authorize, onInterrupted: async () => {} });
  const drain = (callId: string): Promise<void> => {
    const current = draining.get(callId); if (current) return current;
    const work = (async () => {
      for (let step = 0; step < 12; step++) {
        const before = await state(callId); if (!before) return;
        if (['ended', 'failed'].includes(before.call.state) && !(before.contentFenced && before.call.contentRetention.state !== 'purged')) { if (runtimes.get(callId)?.released) { await factory.forget(options.scopeId, callId); runtimes.delete(callId); } return; }
        await manager.advance(options.scopeId, callId); const after = await state(callId);
        if (!after || after.action || (after.preparationStep === 3 && after.call.state !== 'ending')) return;
      }
    })().finally(() => { draining.delete(callId); }); draining.set(callId, work); return work;
  };
  const routes = new ReferenceRoutes({ scopeId: options.scopeId, principal, store, manager, credentials, allowedOrigins, now, active: () => active,
    validate: async (agent) => {
      if (agent.providerPolicy.mode !== 'local' || agent.transcriptPolicy.mode !== 'none' || agent.webhookRef !== null) throw new ReferenceHttpError(422, 'policy_refused');
      const scope = captureVoiceScope(options.scope(agent, 'validation', principal, lifecycle.signal));
      if (scope.scopeId !== options.scopeId || scope.callId !== 'validation') throw new ReferenceHttpError(422, 'policy_refused');
      try { await options.speech.resolveVoicePlan(scope, agent, options.options, options.network); } catch { throw new ReferenceHttpError(422, 'policy_refused'); }
    }, drain });
  const media = new WebSocketCallServer({ maxConnections: 16, pathPrefix: '/api/v1/web-calls', resolveCall: (id, origin) => active && allowedOrigins.has(origin) ? runtimes.get(id)?.binding : undefined });
  const server = createServer((request, response) => {
    const requestId = randomUUID(); const safeError = (error: unknown): void => {
      const e = error instanceof ReferenceHttpError ? error : error instanceof z.ZodError || error instanceof SyntaxError ? new ReferenceHttpError(400, 'invalid_request') : new ReferenceHttpError(503, 'capacity_unavailable');
      send(response, e.status, VoiceApiErrorSchema.parse({ kind: e.kind, message: e.status === 401 ? 'Authentication required.' : e.status >= 500 ? 'Service temporarily unavailable.' : 'Request refused.', requestId, retryable: e.status === 503, retryAfterMs: e.status === 503 ? 1000 : null }));
    };
    if (closing || inFlight >= 16) { safeError(new ReferenceHttpError(503, 'capacity_unavailable')); return; }
    inFlight++; const deadline = setTimeout(() => { safeError(new ReferenceHttpError(503, 'capacity_unavailable')); request.destroy(); }, 15000);
    void (async () => {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) throw new ReferenceHttpError(403, 'forbidden');
      if (!active) throw new ReferenceHttpError(401, 'unauthenticated');
      for (const header of ['authorization', 'origin']) if (request.rawHeaders.filter((h, index) => index % 2 === 0 && h.toLowerCase() === header).length > 1) throw new ReferenceHttpError(400, 'invalid_request');
      const authorization = request.headers.authorization ?? ''; if (authorization.length > 9000) throw new ReferenceHttpError(401, 'unauthenticated');
      const bearer = /^Bearer ([^\s]+)$/.exec(authorization)?.[1] ?? ''; const account = !!bearer && timingSafeEqual(digest(bearer), keyHash);
      const url = new URL(request.url ?? '/', 'http://reference.invalid'); if (url.origin !== 'http://reference.invalid' || url.hash) throw new ReferenceHttpError(400, 'invalid_request');
      const result = await routes.handle({ method: request.method ?? '', url, bearer, account, origin: request.headers.origin ?? '', body: await readBody(request) });
      if (!active) throw new ReferenceHttpError(401, 'unauthenticated');
      if (result.events) sendEvents(response, result.status, result.events); else send(response, result.status, result.body);
    })().catch(safeError).finally(() => { clearTimeout(deadline); inFlight--; });
  });
  server.requestTimeout = 15000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxHeadersCount = 32;
  server.on('upgrade', (request, socket, head) => { if (!active || closing || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) { socket.destroy(); return; } media.handleUpgrade(request, socket, head); });
  server.on('listening', () => { const address = server.address(); if (address && typeof address !== 'string' && !['127.0.0.1', '::1'].includes(address.address)) { server.close(); throw new Error('reference server must bind loopback'); } });
  let scanning = false;
  const timer = setInterval(() => {
    if (scanning || closing) return; scanning = true;
    void store.withTransaction(options.scopeId, (tx) => tx.list('calls')).then((calls) => {
      for (const row of calls) if (!draining.has(row.id)) void drain(row.id).catch(() => {});
    }).finally(() => { scanning = false; }).catch(() => {});
  }, 250); timer.unref();
  const endAll = async (reason: 'key_revoked' | 'deployment'): Promise<void> => {
    const calls = await store.withTransaction(options.scopeId, (tx) => tx.list('calls'));
    await Promise.all(calls.filter((r) => !['ended', 'failed'].includes(r.value.call.state)).map(async (row) => { await manager.requestEnd(options.scopeId, row.id, reason); await drain(row.id); }));
  };
  return { server, drain, revoke: async () => { active = false; await endAll('key_revoked'); },
    close: async () => {
      closing = true; active = false; clearInterval(timer);
      let cleanupError: unknown; try { await endAll('deployment'); } catch (error) { cleanupError = error; } lifecycle.abort(); try { await media.close(); } catch (error) { cleanupError ??= error; }
      if (server.listening) await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeIdleConnections(); });
      if (cleanupError || [...runtimes.values()].some((runtime) => !runtime.released)) throw new Error('reference cleanup incomplete');
    } };
}
