import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  CreateAgentSchema, UpdateAgentSchema, ArchiveAgentSchema, VoiceAgentSchema, VoiceCallSchema,
  CreateWebCallSchema, RenewCallGrantSchema, ConnectWebCallSchema, StopCallSchema, RenewCallControlSchema, PurgeCallSchema,
  ListQuerySchema, AgentListSchema, CallListSchema, UsageListSchema, TranscriptResultSchema, StopReceiptSchema, PurgeReceiptSchema,
  buildVoicePlatformOpenApi, type CallEvent, type VoiceAgent, type InitiatingPrincipal, type VoiceApiError,
} from '../contracts/index.js';
import { canonicalVoiceHash, requestCallEndInTransaction, type VoiceCallManager } from '../VoiceCallManager.js';
import type { CallCredentials } from '../CallCredentials.js';
import { voiceKey, type VoiceStore, type StoredVoiceCall } from '../stores/types.js';
/** Safe HTTP result; headers and serialization are owned by the server. `events`, in sequence order, marks an event-stream result. */
export interface ReferenceResponse { status: number; body: unknown; events?: CallEvent[] }
/** One parsed request; account authority is already checked against the configured key. */
export interface ReferenceRequest { method: string; url: URL; body: unknown; bearer: string; account: boolean; origin: string }
/** Internal operation error, never a provider's message. */
export class ReferenceHttpError extends Error {
  constructor(readonly status: number, readonly kind: VoiceApiError['kind']) { super(kind); }
}
/** Single-process route state and admission callbacks. The host supplies no caller-selected scope. */
export interface ReferenceRouteOptions {
  scopeId: string; principal: InitiatingPrincipal; store: VoiceStore; manager: VoiceCallManager; credentials: CallCredentials;
  allowedOrigins: ReadonlySet<string>; now(): number; active(): boolean;
  validate(agent: VoiceAgent): Promise<void>;
  drain(callId: string): Promise<void>;
}
/** Closed metadata and lifecycle routes with bounded memory and authenticated pagination. */
export class ReferenceRoutes {
  private readonly agents = new Map<string, VoiceAgent>();
  private readonly revisions = new Map<string, VoiceAgent>();
  private readonly cursorKey = randomBytes(32);
  private creating = 0; private mutations: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: ReferenceRouteOptions) {}
  /** A clone of an immutable revision, used by the preparation hook after durable call creation. */
  revision(id: string, revision: number): VoiceAgent {
    const value = this.revisions.get(JSON.stringify([id, revision])); if (!value) throw new ReferenceHttpError(404, 'not_found'); return structuredClone(value);
  }
  private async state(id: string): Promise<StoredVoiceCall> {
    const row = await this.options.store.withTransaction(this.options.scopeId, (tx) => tx.get('calls', id));
    if (!row) throw new ReferenceHttpError(404, 'not_found'); return row.value;
  }
  private page<T>(path: string, url: URL, rows: Array<{ order: string; value: T }>): { items: T[]; nextCursor: string | null } {
    const raw: Record<string, unknown> = {}; for (const [key, value] of url.searchParams) { if (key in raw) throw new ReferenceHttpError(400, 'invalid_request'); raw[key] = key === 'limit' ? Number(value) : value; }
    const query = ListQuerySchema.parse({ limit: 50, ...raw }); let after = '';
    const mac = (data: unknown) => createHmac('sha256', this.cursorKey).update(JSON.stringify(data)).digest('hex');
    if (query.cursor) {
      const parsed = z.strictObject({ data: z.tuple([z.string(), z.string(), z.string(), z.number().int()]), mac: z.string().regex(/^[a-f0-9]{64}$/) }).parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')));
      if (parsed.data[0] !== this.options.scopeId || parsed.data[1] !== path || parsed.data[3] <= this.options.now() || !timingSafeEqual(Buffer.from(parsed.mac, 'hex'), Buffer.from(mac(parsed.data), 'hex'))) throw new ReferenceHttpError(400, 'invalid_request');
      after = parsed.data[2];
    }
    const sorted = rows.filter((r) => r.order > after).sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : 0);
    const take = sorted.slice(0, query.limit); let nextCursor: string | null = null;
    if (sorted.length > take.length) { const data = [this.options.scopeId, path, take[take.length - 1]!.order, this.options.now() + 300000]; nextCursor = Buffer.from(JSON.stringify({ data, mac: mac(data) })).toString('base64url'); }
    return { items: take.map((r) => r.value), nextCursor };
  }
  private order(createdAt: number, id: string): string { return `${String(createdAt).padStart(16, '0')}:${id}`; }
  private async createCall(body: unknown): Promise<ReferenceResponse> {
    const request = CreateWebCallSchema.parse(body); const agent = this.agents.get(request.agentId);
    if (!agent || agent.state !== 'active') throw new ReferenceHttpError(404, 'not_found');
    if (!this.options.allowedOrigins.has(request.clientOrigin) || request.maxDurationSeconds > agent.limits.maxDurationSeconds) throw new ReferenceHttpError(422, 'policy_refused');
    this.creating++;
    try {
      const calls = await this.options.store.withTransaction(this.options.scopeId, (tx) => tx.list('calls'));
      const prior = await this.options.store.withTransaction(this.options.scopeId, (tx) => tx.get('idempotency', voiceKey('create', request.idempotencyKey)));
      if (!prior && calls.length + this.creating > 256) throw new ReferenceHttpError(503, 'capacity_unavailable');
      const now = this.options.now();
      const call = VoiceCallSchema.parse({ version: 1, callId: randomUUID(), scopeId: this.options.scopeId, initiatingPrincipal: this.options.principal,
        agentId: agent.agentId, agentRevision: agent.revision, requestId: randomUUID(), state: 'prepared', createdAt: now, startedAt: null, endedAt: null,
        connectionTimeline: [], workerGeneration: 0, inferenceGeneration: 0, transportEpoch: 0, attemptAllowance: { limits: agent.reasoning.attemptLimits, authorizedAttempts: 0 },
        endReason: null, usage: { connectedMs: 0, billableSeconds: 0, supplierComponents: [] }, rateVersion: 'local', contentRetention: { state: 'none', expiresAt: null } });
      const seed: StoredVoiceCall = { call, limits: { ...agent.limits, maxDurationSeconds: request.maxDurationSeconds }, clientOrigin: request.clientOrigin,
        proofKeyThumbprint: request.proofKeyThumbprint, transport: 'websocket', participantId: randomUUID(), reservationRef: null,
        preparationStep: 0, cleanupStep: 0, action: null, contentFenced: false, credentialGeneration: 1, nextTransportEpoch: 0,
        reportSequence: 0, reportHash: null, acknowledgedAt: now, leaseExpiresAt: null, disconnectedAt: null, lastUserSpeechAt: null, completedTurns: 0, endingAt: null, terminalFailed: false, fence: null };
      const created = await this.options.manager.create({ scopeId: this.options.scopeId, request, seed });
      await this.options.drain(created.callId);
      const prepared = await this.state(created.callId);
      if (prepared.preparationStep !== 3 || !['connecting', 'connected', 'reconnecting'].includes(prepared.call.state)) throw new ReferenceHttpError(503, 'capacity_unavailable');
      return { status: 201, body: await this.options.credentials.issueGrant(this.options.scopeId, created.callId, `create:${request.idempotencyKey}`) };
    } finally { this.creating--; }
  }
  private async accountStop(id: string, body: unknown, purge: boolean): Promise<ReferenceResponse> {
    const request = purge ? PurgeCallSchema.parse(body) : StopCallSchema.parse(body);
    const result = await this.options.store.withTransaction(this.options.scopeId, async (tx) => {
      const row = await tx.get('calls', id); if (!row) throw new ReferenceHttpError(404, 'not_found');
      const key = voiceKey(purge ? 'reference-purge' : 'reference-stop', id, request.idempotencyKey);
      const hash = canonicalVoiceHash([this.options.principal, id, purge, request.idempotencyKey]); const old = await tx.get('idempotency', key);
      if (old) { if (old.value.requestHash !== hash) throw new ReferenceHttpError(409, 'conflict'); return old.value.result; }
      await requestCallEndInTransaction(tx, id, purge ? 'purged' : 'client_stop', this.options.now());
      const receipt = StopReceiptSchema.parse({ callId: id, stopId: request.idempotencyKey, state: 'ending' });
      await tx.put('idempotency', key, { requestHash: hash, callId: id, result: receipt }, 0); return receipt;
    });
    if (!purge) return { status: 200, body: StopReceiptSchema.parse(result) };
    const state = await this.state(id); return { status: 202, body: PurgeReceiptSchema.parse({ callId: id, operationId: request.idempotencyKey, state: state.call.contentRetention.state === 'purged' ? 'completed' : 'pending' }) };
  }
  /** Stored lifecycle events after `afterSequence` (default 0), in sequence order; reading never creates an event. */
  private async callEvents(id: string, url: URL): Promise<ReferenceResponse> {
    const raw: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams) { if (key in raw) throw new ReferenceHttpError(400, 'invalid_request'); raw[key] = /^(?:0|[1-9][0-9]{0,15})$/.test(value) ? Number(value) : value; }
    const { afterSequence } = z.strictObject({ afterSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) }).parse(raw);
    await this.state(id);
    return { status: 200, body: null, events: (await this.options.manager.events(this.options.scopeId, id)).filter((event) => event.sequence > afterSequence) };
  }
  /** Dispatches only declared routes; narrow credentials never reach agent or usage operations. */
  handle(request: ReferenceRequest): Promise<ReferenceResponse> { if (request.method === 'GET') return this.dispatch(request); const work = this.mutations.then(() => this.dispatch(request)); this.mutations = work.then(() => undefined, () => undefined); return work; } private async dispatch(request: ReferenceRequest): Promise<ReferenceResponse> {
    if (!this.options.active()) throw new ReferenceHttpError(401, 'unauthenticated');
    const { method, url, body, bearer, account, origin } = request;
    const path = url.pathname.replace(/^\/api\/v1/, '');
    if (!url.pathname.startsWith('/api/v1/') || !/^\/[A-Za-z0-9/._:-]*$/.test(path)) throw new ReferenceHttpError(404, 'not_found');
    const parts = path.split('/').filter(Boolean); const id = parts[1];
    const connect = method === 'POST' && parts[0] === 'web-calls' && parts[2] === 'connect' && parts.length === 3;
    const control = method === 'POST' && parts[0] === 'calls' && ['stop', 'control-token'].includes(parts[2] ?? '') && parts.length === 3;
    if (!account && !connect && !control) throw new ReferenceHttpError(401, 'unauthenticated');
    const events = method === 'GET' && parts[0] === 'calls' && parts[2] === 'events' && parts.length === 3;
    if ((!['/agents', '/calls', '/usage'].includes(path) || method !== 'GET') && !events) if (url.search) throw new ReferenceHttpError(400, 'invalid_request');
    if (method === 'GET' && path === '/openapi.json') return { status: 200, body: buildVoicePlatformOpenApi() };
    if (method === 'GET' && path === '/agents') return { status: 200, body: AgentListSchema.parse(this.page(path, url, [...this.agents.values()].map((value) => ({ order: this.order(value.createdAt, value.agentId), value })))) };
    if (method === 'POST' && path === '/agents') {
      if (this.agents.size >= 128 || this.revisions.size >= 1024) throw new ReferenceHttpError(503, 'capacity_unavailable');
      const now = this.options.now(); const value = VoiceAgentSchema.parse({ ...CreateAgentSchema.parse(body), version: 1, scopeId: this.options.scopeId, agentId: randomUUID(), revision: 1, state: 'active', createdAt: now, updatedAt: now });
      await this.options.validate(value); this.agents.set(value.agentId, value); this.revisions.set(JSON.stringify([value.agentId, 1]), value); return { status: 201, body: value };
    }
    if (parts[0] === 'agents' && id && parts.length === 2) {
      const current = this.agents.get(id); if (!current) throw new ReferenceHttpError(404, 'not_found');
      if (method === 'GET') return { status: 200, body: current };
      if (method === 'PATCH' || method === 'DELETE') {
        const update = method === 'PATCH' ? UpdateAgentSchema.parse(body) : { ...ArchiveAgentSchema.parse(body), changes: {} };
        if (update.expectedRevision !== current.revision) throw new ReferenceHttpError(409, 'conflict');
        if (this.revisions.size >= 1024) throw new ReferenceHttpError(503, 'capacity_unavailable');
        const value = VoiceAgentSchema.parse({ ...current, ...update.changes, revision: current.revision + 1, updatedAt: this.options.now(), state: method === 'DELETE' ? 'archived' : current.state });
        if (method === 'PATCH') await this.options.validate(value);
        if (this.agents.get(id)?.revision !== update.expectedRevision) throw new ReferenceHttpError(409, 'conflict');
        this.agents.set(id, value); this.revisions.set(JSON.stringify([id, value.revision]), value); return { status: 200, body: value };
      }
    }
    if (method === 'POST' && path === '/web-calls') return this.createCall(body);
    if (method === 'GET' && (path === '/calls' || path === '/usage')) {
      const calls = await this.options.store.withTransaction(this.options.scopeId, (tx) => tx.list('calls'));
      if (path === '/calls') return { status: 200, body: CallListSchema.parse(this.page(path, url, calls.map((r) => ({ order: this.order(r.value.call.createdAt, r.id), value: r.value.call })))) };
      const usage = await this.options.store.withTransaction(this.options.scopeId, (tx) => tx.list('usage'));
      const created = new Map(calls.map((r) => [r.id, r.value.call.createdAt]));
      return { status: 200, body: UsageListSchema.parse(this.page(path, url, usage.map((r) => ({ order: this.order(created.get(r.id) ?? 0, r.id), value: r.value })))) };
    }
    if (parts[0] === 'web-calls' && id && parts.length === 3 && method === 'POST') {
      if (parts[2] === 'connect') {
        if (!bearer || !origin) throw new ReferenceHttpError(401, 'unauthenticated');
        const input = ConnectWebCallSchema.parse(body);
        try { return { status: 200, body: await this.options.credentials.exchange(this.options.scopeId, id, bearer, origin, input) }; }
        catch { throw new ReferenceHttpError(401, 'unauthenticated'); }
      }
      if (parts[2] === 'token') {
        const input = RenewCallGrantSchema.parse(body); const state = await this.state(id);
        if (input.clientOrigin !== state.clientOrigin || input.proofKeyThumbprint !== state.proofKeyThumbprint) throw new ReferenceHttpError(403, 'forbidden');
        return { status: 200, body: await this.options.credentials.issueGrant(this.options.scopeId, id, input.idempotencyKey) };
      }
    }
    if (parts[0] === 'calls' && id && (parts.length === 2 || parts.length === 3)) {
      if (parts.length === 2 && method === 'GET') return { status: 200, body: (await this.state(id)).call };
      if (parts.length === 2 && method === 'DELETE') return this.accountStop(id, body, true);
      if (parts[2] === 'transcript' && method === 'GET') { const s = await this.state(id); return { status: 200, body: TranscriptResultSchema.parse({ callId: id, transcript: { availability: 'unavailable', reason: s.call.contentRetention.state === 'purged' ? 'purged' : 'not_retained' } }) }; }
      if (events) return this.callEvents(id, url);
      if (parts[2] === 'stop' && method === 'POST' && account) return this.accountStop(id, body, false);
      if (method === 'POST' && ['stop', 'control-token'].includes(parts[2] ?? '')) {
        if (!bearer || !origin) throw new ReferenceHttpError(401, 'unauthenticated');
        const stop = parts[2] === 'stop' ? StopCallSchema.parse(body) : undefined;
        const renew = parts[2] === 'control-token' ? RenewCallControlSchema.parse(body) : undefined;
        try { return { status: 200, body: stop ? await this.options.credentials.stop(this.options.scopeId, id, bearer, origin, stop) : await this.options.credentials.renewControl(this.options.scopeId, id, bearer, origin, renew!) }; }
        catch { throw new ReferenceHttpError(401, 'unauthenticated'); }
      }
    }
    throw new ReferenceHttpError(404, 'not_found');
  }
}
