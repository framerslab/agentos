import { createHash, randomUUID } from 'node:crypto';
import { CallEventSchema, CreateWebCallSchema, VoiceCallSchema, VoiceCallLimitsSchema, TranscriptAvailabilitySchema, type CallEndReason, type CallEvent, type CreateWebCall, type UsageRecord, type VoiceCall } from './contracts/index.js';
import type { CallTranscriptDrain } from './stores/types.js';
import { CallMinuteMeter, type CallQuantityReport } from './CallMinuteMeter.js';
import { voiceInteger, voiceKey, type CallAction, type CallFenceEvidence, type StoredVoiceCall, type VoiceRow, type VoiceStore, type VoiceTransaction } from './stores/types.js';

/** Stable, content-free client messages, exhaustive over the canonical terminal-reason union. */
export const CALL_END_MESSAGES: Readonly<Record<CallEndReason, string>> = {
  client_stop: 'Call stopped.', agent_completion: 'The agent finished.', duration_limit: 'The call reached its duration limit.',
  silence_limit: 'The call ended after silence.', budget_exhausted: 'The call reached its budget.', turn_limit: 'The call reached its turn limit.',
  workspace_stopped: 'Calls are stopped for this workspace.', agent_stopped: 'This agent was stopped.', key_revoked: 'Call authorization was revoked.',
  participant_disconnected: 'The participant disconnected.', setup_timeout: 'The call could not connect in time.', provider_failure: 'A speech or reasoning provider failed.',
  transport_failure: 'The media connection failed.', sink_failure: 'Transcript delivery failed.', worker_lost: 'The call worker stopped responding.', deployment: 'The call ended for maintenance.', purged: 'Call content was deleted.',
};
/** Canonical JSON digest of validated JSON values; object key order cannot change an operation's identity. */
export function canonicalVoiceHash(value: unknown): string {
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    if (item && typeof item === 'object') return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`).join(',')}}`;
    throw new Error('non-JSON operation input');
  };
  return createHash('sha256').update(encode(value)).digest('hex');
}
const terminal = (s: StoredVoiceCall): boolean => s.call.state === 'ended' || s.call.state === 'failed';
const meter = new CallMinuteMeter();
const failureReasons = new Set<CallEndReason>(['setup_timeout', 'provider_failure', 'transport_failure', 'sink_failure', 'worker_lost']);
/** A fenced, bounded external action. Hosts use operationId for deduplication and actionId for controller fencing. */
export interface CallActionContext {
  state: StoredVoiceCall; operationId: string; actionId: string; signal: AbortSignal;
}
/** Idempotent host bindings; no hook may start billable work before the committed dispatch intent. */
export interface VoiceCallHooks {
  reserveOnce(c: CallActionContext): Promise<string>;
  prepareOnce(c: CallActionContext): Promise<void>;
  publishDispatchOnce(c: CallActionContext): Promise<void>;
  /** Resolves only after the content fence, key revocation and journal-backed deletion are acknowledged. */ fenceContent(c: CallActionContext): Promise<void>;
  abortModelAndTools(c: CallActionContext): Promise<void>;
  cancelTts(c: CallActionContext): Promise<void>;
  clearPlayback(c: CallActionContext): Promise<void>;
  drainTranscripts(c: CallActionContext): Promise<void | CallTranscriptDrain>;
  releaseMedia(c: CallActionContext): Promise<void>;
  confirmStopped(c: CallActionContext): Promise<CallFenceEvidence>;
  releaseSlots(c: CallActionContext): Promise<void>;
  /** Resolve reservation by scope/call even when its response was lost; settle or release exactly once. */
  settleOnce(c: CallActionContext, usage: UsageRecord): Promise<void>;
  /** True proves this controller action and all its outstanding effects are permanently fenced. */
  fenceAction(state: StoredVoiceCall, action: CallAction): Promise<boolean>;
}
/** Manager dependencies. Numeric lease policy is explicit and not a commercial default. */
export interface VoiceCallManagerOptions { store: VoiceStore; hooks: VoiceCallHooks; now: () => number; workerLeaseMs: number }
/** Host-authorized seed; the manager replaces identity, counters and timestamps before storing it. */
export interface PrepareVoiceCall { scopeId: string; request: CreateWebCall; seed: StoredVoiceCall }

async function putState(tx: VoiceTransaction, row: VoiceRow<StoredVoiceCall>, final = false): Promise<void> {
  VoiceCallSchema.parse(row.value.call);
  const usage = meter.snapshot(row.value, final);
  row.value.call.usage = { connectedMs: usage.connectedMs, billableSeconds: usage.billableSeconds, supplierComponents: usage.supplierComponents };
  await tx.put('calls', row.id, row.value, row.version);
  const old = await tx.get('usage', row.id);
  await tx.put('usage', row.id, usage, old?.version ?? 0);
}
/**
 * Atomic end intent, shared with the credential stop transaction. A terminal call is immutable here.
 * Purge fences content immediately; an active cleanup repeats from its first step after that stronger request.
 */
export async function requestCallEndInTransaction(tx: VoiceTransaction, callId: string, reason: CallEndReason, now: number): Promise<VoiceCall> {
  const row = await tx.get('calls', callId);
  if (!row) throw new Error('call not found');
  const s = row.value; voiceInteger(now);
  if (terminal(s)) return s.call;
  if (s.call.state === 'ending' && (reason !== 'purged' || s.contentFenced)) return s.call;
  const wasEnding = s.call.state === 'ending';
  meter.close(s, now, reason === 'worker_lost');
  s.call.state = 'ending'; s.call.endReason = reason; s.endingAt ??= now;
  s.terminalFailed = failureReasons.has(reason); s.call.inferenceGeneration = voiceInteger(s.call.inferenceGeneration + 1);
  if (!wasEnding || reason === 'purged') s.credentialGeneration = voiceInteger(s.credentialGeneration + 1, 1);
  if (reason === 'purged') { s.contentFenced = true; s.call.contentRetention.state = 'revoking'; s.cleanupStep = 0; }
  await putState(tx, row);
  return s.call;
}
/** Durable call manager. Restarting it loses no lifecycle, quantity, deadline or action ownership state. */
export class VoiceCallManager {
  constructor(private readonly options: VoiceCallManagerOptions) { voiceInteger(options.workerLeaseMs, 1); }
  /** Reads only metadata in the authenticated scope. */
  async get(scopeId: string, callId: string): Promise<VoiceCall | undefined> {
    return this.options.store.withTransaction(scopeId, async (tx) => (await tx.get('calls', callId))?.value.call);
  }
  /** Ordered lifecycle delivery intents. Authorization remains the caller's responsibility. */
  async events(scopeId: string, callId: string): Promise<CallEvent[]> {
    return this.options.store.withTransaction(scopeId, async (tx) => (await tx.list('events')).map((r) => r.value).filter((e) => e.callId === callId).sort((a, b) => a.sequence - b.sequence));
  }
  /** Resolves protected delivery only for a host-authorized delivery operation, never for metadata reads. */
  async withTerminalDelivery(scopeId: string, callId: string,
    open: (reference: string, consume: (segments: unknown) => Promise<void>) => Promise<void>,
    deliver: (event: CallEvent) => Promise<void>): Promise<void> {
    const read = () => this.options.store.withTransaction(scopeId, async (tx) => ({ state: (await tx.get('calls', callId))?.value, event: (await tx.get('events', voiceKey(callId, 'terminal')))?.value }));
    const initial = await read(); if (!initial.state || !initial.event) throw new Error('terminal delivery unavailable');
    const ref = initial.state.transcriptDrain?.deliveryRef;
    if (!ref || initial.state.contentFenced) { await deliver(initial.event); return; }
    await open(ref, async (segments) => {
      const current = await read();
      if (!current.state || current.state.contentFenced || current.state.transcriptDrain?.deliveryRef !== ref || current.event?.eventId !== initial.event!.eventId) throw new Error('terminal delivery fenced');
      const transcript = TranscriptAvailabilitySchema.parse({ availability: 'delivery', segments });
      await deliver(CallEventSchema.parse({ ...initial.event, payload: { ...initial.event!.payload, transcript } }));
    });
  }
  /** Commits one prepared call and creation key before any external effect. */
  async create(input: PrepareVoiceCall): Promise<VoiceCall> {
    const request = CreateWebCallSchema.parse(input.request);
    const hash = canonicalVoiceHash({ request, principal: input.seed.call.initiatingPrincipal });
    return this.options.store.withTransaction(input.scopeId, async (tx) => {
      const key = voiceKey('create', request.idempotencyKey);
      const previous = await tx.get('idempotency', key);
      if (previous) {
        if (previous.value.requestHash !== hash) throw new Error('idempotency conflict');
        const existing = await tx.get('calls', previous.value.callId);
        if (!existing) throw new Error('creation record incomplete');
        return existing.value.call;
      }
      const now = voiceInteger(this.options.now()); const s = structuredClone(input.seed);
      s.limits = VoiceCallLimitsSchema.parse(s.limits); voiceInteger(now + s.limits.maxDurationSeconds * 1000); voiceInteger(now + s.limits.setupTimeoutMs); voiceInteger(now + s.limits.cleanupTimeoutMs);
      if (s.call.scopeId !== input.scopeId || s.call.agentId !== request.agentId || request.maxDurationSeconds < s.limits.maxDurationSeconds) throw new Error('unauthorized call seed');
      s.call = VoiceCallSchema.parse({ ...s.call, callId: randomUUID(), requestId: randomUUID(), state: 'prepared', createdAt: now, startedAt: null, endedAt: null,
        connectionTimeline: [], workerGeneration: 0, inferenceGeneration: 0, transportEpoch: 0, endReason: null,
        usage: { connectedMs: 0, billableSeconds: 0, supplierComponents: [] }, attemptAllowance: { ...s.call.attemptAllowance, authorizedAttempts: 0 } });
      s.clientOrigin = request.clientOrigin; s.proofKeyThumbprint = request.proofKeyThumbprint;
      s.participantId = randomUUID(); s.reservationRef = null; s.preparationStep = 0; s.cleanupStep = 0; s.action = null;
      s.contentFenced = false; s.transcriptDrain = undefined; s.credentialGeneration = 1; s.nextTransportEpoch = 0; s.reportSequence = 0; s.reportHash = null;
      s.acknowledgedAt = now; s.leaseExpiresAt = null; s.disconnectedAt = null; s.lastUserSpeechAt = null;
      s.completedTurns = 0; s.endingAt = null; s.terminalFailed = false; s.fence = null;
      await tx.put('calls', s.call.callId, s, 0);
      await tx.put('usage', s.call.callId, meter.snapshot(s, false), 0);
      await tx.put('idempotency', key, { requestHash: hash, callId: s.call.callId, result: null }, 0);
      return s.call;
    });
  }
  /** Performs at most one recoverable preparation or cleanup step. Concurrent takers see the persisted action. */
  async advance(scopeId: string, callId: string): Promise<void> {
    await this.tick(scopeId, callId);
    const claimed = await this.options.store.withTransaction(scopeId, async (tx) => {
      const row = await tx.get('calls', callId); if (!row || terminal(row.value) || row.value.action) return undefined;
      const s = row.value;
      const kind = s.call.state === 'ending' ? 'cleanup' : 'prepare';
      if (kind === 'prepare' && s.preparationStep >= 3) return undefined;
      const step = kind === 'prepare' ? s.preparationStep : s.cleanupStep;
      const now = voiceInteger(this.options.now());
      const action: CallAction = { id: randomUUID(), kind, expiresAt: voiceInteger(now + s.limits.cleanupTimeoutMs) };
      s.action = action; await tx.put('calls', callId, s, row.version);
      return { state: s, action, step };
    });
    if (!claimed) return;
    const { state, action, step } = claimed;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const context: CallActionContext = { state, actionId: action.id, operationId: voiceKey(callId, action.kind, String(step)), signal: controller.signal };
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('call action timed out')); }, Math.max(1, action.expiresAt - this.options.now()));
    });
    let reservation: string | undefined; let fence: CallFenceEvidence | undefined; let transcriptDrain: CallTranscriptDrain | undefined;
    try {
      await Promise.race([deadline, (async () => {
        const h = this.options.hooks;
        if (action.kind === 'prepare') {
          if (step === 0) reservation = await h.reserveOnce(context);
          else if (step === 1) await h.prepareOnce(context);
          else await h.publishDispatchOnce(context);
        } else {
          switch (step) {
            case 0: if (state.contentFenced) await h.fenceContent(context); break;
            case 1: await h.abortModelAndTools(context); break;
            case 2: await h.cancelTts(context); break;
            case 3: await h.clearPlayback(context); break;
            case 4: if (!state.contentFenced) {
              const result = await h.drainTranscripts(context);
              if (result) {
                const transcript = TranscriptAvailabilitySchema.parse(result.transcript);
                if (transcript.availability === 'delivery' || (transcript.availability === 'unavailable' && transcript.reason === 'pending') || (result.deliveryRef !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.deliveryRef) || transcript.availability !== 'unavailable' || transcript.reason !== 'not_retained'))) throw new Error('invalid transcript drain');
                transcriptDrain = { transcript, ...(result.deliveryRef ? { deliveryRef: result.deliveryRef } : {}) };
              } else if (state.call.contentRetention.state !== 'none') throw new Error('retained transcript drain missing');
            } break;
            case 5: await h.releaseMedia(context); break;
            case 6:
              fence = await h.confirmStopped(context);
              if (!fence.workerStopped || !fence.mediaClosed || !fence.inferenceStopped || fence.workerGeneration !== state.call.workerGeneration || !fence.evidenceRef) throw new Error('fence incomplete');
              break;
            case 7: await h.releaseSlots(context); break;
            case 8: await h.settleOnce(context, meter.snapshot(state, true)); break;
            default: throw new Error('invalid cleanup step');
          }
        }
      })()]);
    } finally { if (timer) clearTimeout(timer); }
    await this.options.store.withTransaction(scopeId, async (tx) => {
      const row = await tx.get('calls', callId); if (!row || row.value.action?.id !== action.id) return;
      const s = row.value; s.action = null;
      if (action.kind === 'prepare') {
        if (step === 0) { if (!reservation) throw new Error('missing reservation reference'); s.reservationRef = reservation; }
        if (s.call.state !== 'ending') {
          s.preparationStep = step + 1;
          if (step === 0) { s.call.workerGeneration = 1; s.call.inferenceGeneration = 1; }
          if (step === 1) s.call.state = 'connecting';
        }
      } else if (s.cleanupStep === step && s.contentFenced === state.contentFenced) {
        if (fence) s.fence = fence;
        if (step === 4 && !s.contentFenced) s.transcriptDrain = transcriptDrain ?? { transcript: { availability: 'unavailable', reason: 'not_retained' } };
        s.cleanupStep = step + 1;
        if (s.cleanupStep === 9) {
          s.call.state = s.terminalFailed ? 'failed' : 'ended'; s.call.endedAt = voiceInteger(this.options.now());
          if (s.contentFenced) { s.call.contentRetention.state = 'purged'; s.call.contentRetention.expiresAt = null; }
          const started = await tx.get('events', voiceKey(callId, 'started'));
          const event = CallEventSchema.parse({ version: 1, eventId: randomUUID(), scopeId, callId,
            workerGeneration: s.call.workerGeneration, inferenceGeneration: s.call.inferenceGeneration, transportEpoch: s.call.transportEpoch,
            sequence: started ? 2 : 1, type: s.terminalFailed ? 'call.failed' : 'call.ended', occurredAt: s.call.endedAt,
            payload: { durationMs: s.call.startedAt === null ? 0 : Math.max(0, (s.endingAt ?? s.call.endedAt) - s.call.startedAt),
              connectedSeconds: meter.snapshot(s, true).billableSeconds, endReason: s.call.endReason,
              transcript: s.contentFenced ? { availability: 'unavailable', reason: 'purged' } : s.transcriptDrain?.transcript ?? { availability: 'unavailable', reason: 'not_retained' } } });
          await tx.put('events', voiceKey(callId, 'terminal'), event, 0);
        }
      }
      await putState(tx, row, terminal(s));
    });
  }
  /** Expired controller actions remain owned until their external fence is positively acknowledged. */
  async recoverAction(scopeId: string, callId: string): Promise<boolean> {
    const row = await this.options.store.withTransaction(scopeId, (tx) => tx.get('calls', callId));
    const action = row?.value.action;
    if (!row || !action || action.expiresAt > this.options.now()) return false;
    if (!await this.options.hooks.fenceAction(row.value, action)) return false;
    return this.options.store.withTransaction(scopeId, async (tx) => {
      const current = await tx.get('calls', callId);
      if (!current || current.value.action?.id !== action.id) return false;
      current.value.action = null; await tx.put('calls', callId, current.value, current.version); return true;
    });
  }
  /** Called only after intended participant, worker and media readiness are authenticated by the transport binding. */
  async connected(scopeId: string, callId: string, workerGeneration: number, transportEpoch: number): Promise<void> { await this.tick(scopeId, callId);
    await this.options.store.withTransaction(scopeId, async (tx) => {
      const row = await tx.get('calls', callId); if (!row) throw new Error('call not found'); const s = row.value; const now = voiceInteger(this.options.now());
      if (s.preparationStep !== 3 || s.call.workerGeneration !== workerGeneration || !['connecting', 'connected', 'reconnecting'].includes(s.call.state)) throw new Error('call not ready');
      if (s.leaseExpiresAt !== null && s.leaseExpiresAt <= now) throw new Error('lease expired');
      if (s.call.state === 'connected' && s.call.transportEpoch === transportEpoch) return;
      if (transportEpoch <= s.call.transportEpoch) throw new Error('stale transport');
      if (s.call.startedAt === null && now >= s.call.createdAt + s.limits.setupTimeoutMs) throw new Error('setup expired');
      if (s.disconnectedAt !== null && now >= s.disconnectedAt + s.limits.reconnectGraceMs) throw new Error('reconnect expired');
      if (s.call.startedAt !== null && now >= s.call.startedAt + s.limits.maxDurationSeconds * 1000) throw new Error('duration expired');
      s.call.transportEpoch = voiceInteger(transportEpoch, 1); s.nextTransportEpoch = Math.max(s.nextTransportEpoch, transportEpoch);
      s.call.state = 'connected'; s.disconnectedAt = null; s.leaseExpiresAt = voiceInteger(now + this.options.workerLeaseMs);
      meter.open(s, now);
      if (s.call.startedAt === null) {
        s.call.startedAt = now; s.lastUserSpeechAt = now;
        await tx.put('events', voiceKey(callId, 'started'), CallEventSchema.parse({ version: 1, eventId: randomUUID(), scopeId, callId,
          workerGeneration, inferenceGeneration: s.call.inferenceGeneration, transportEpoch, sequence: 1, type: 'call.started', occurredAt: now,
          payload: { agentId: s.call.agentId, agentRevision: s.call.agentRevision, connectedAt: now } }), 0);
      }
      await putState(tx, row);
    });
  }
  /** Records a transient detach without a terminal event. The binding aborts work and clears audio before reattachment. */
  async detached(scopeId: string, callId: string, workerGeneration: number, transportEpoch: number): Promise<void> {
    await this.options.store.withTransaction(scopeId, async (tx) => {
      const row = await tx.get('calls', callId); if (!row) throw new Error('call not found'); const s = row.value;
      if (s.call.workerGeneration !== workerGeneration || s.call.transportEpoch !== transportEpoch || s.call.state !== 'connected') return;
      const now = voiceInteger(this.options.now()); meter.close(s, now);
      s.call.state = 'reconnecting'; s.disconnectedAt = now; s.call.inferenceGeneration = voiceInteger(s.call.inferenceGeneration + 1);
      await putState(tx, row);
    });
  }
  /** Accepts a new cumulative report and renews only its live worker lease. Exact retries cannot keep a worker alive. */
  async report(scopeId: string, callId: string, report: CallQuantityReport): Promise<void> { await this.tick(scopeId, callId);
    await this.options.store.withTransaction(scopeId, async (tx) => {
      const row = await tx.get('calls', callId); if (!row) throw new Error('call not found'); const s = row.value; const now = voiceInteger(this.options.now());
      if (s.leaseExpiresAt === null || s.leaseExpiresAt <= now) throw new Error('lease expired');
      if (!meter.acknowledge(s, report, now)) return;
      s.leaseExpiresAt = voiceInteger(now + this.options.workerLeaseMs); await putState(tx, row);
    });
  }
  /** Only authenticated user audio activity resets silence; greetings, mute and tool work do not call this method. */
  async userSpeech(scopeId: string, callId: string, workerGeneration: number, transportEpoch: number): Promise<void> { await this.tick(scopeId, callId);
    await this.options.store.withTransaction(scopeId, async (tx) => {
      const row = await tx.get('calls', callId); if (!row) throw new Error('call not found'); const s = row.value;
      if (s.call.state !== 'connected' || s.call.workerGeneration !== workerGeneration || s.call.transportEpoch !== transportEpoch) throw new Error('stale activity');
      s.lastUserSpeechAt = voiceInteger(this.options.now()); await tx.put('calls', callId, s, row.version);
    });
  }
  /**
   * Cumulative turn count, not an increment. Repeated completion cannot consume another turn.
   * The count that reaches `limits.maxTurns` commits the `turn_limit` end intent with it, so no later turn starts on a connected call.
   */
  async completedTurn(scopeId: string, callId: string, workerGeneration: number, inferenceGeneration: number, transportEpoch: number, count: number): Promise<void> { await this.tick(scopeId, callId);
    voiceInteger(count);
    await this.options.store.withTransaction(scopeId, async (tx) => {
      const row = await tx.get('calls', callId); if (!row) throw new Error('call not found'); const s = row.value;
      if (s.call.state !== 'connected' || s.call.workerGeneration !== workerGeneration || s.call.inferenceGeneration !== inferenceGeneration || s.call.transportEpoch !== transportEpoch) throw new Error('stale turn');
      s.completedTurns = Math.max(s.completedTurns, count); await tx.put('calls', callId, s, row.version);
      if (s.completedTurns >= s.limits.maxTurns) await requestCallEndInTransaction(tx, callId, 'turn_limit', this.options.now());
    });
  }
  /** Commits the stop intent; advance performs cleanup, with no successful terminal event before it finishes. */
  requestEnd(scopeId: string, callId: string, reason: CallEndReason): Promise<VoiceCall> {
    return this.options.store.withTransaction(scopeId, (tx) => requestCallEndInTransaction(tx, callId, reason, this.options.now()));
  }
  /** Rechecks durable deadlines under the same lock as a heartbeat; no stale scan can end a newly renewed lease. */
  async tick(scopeId: string, callId: string): Promise<void> {
    await this.options.store.withTransaction(scopeId, async (tx) => {
      const row = await tx.get('calls', callId); if (!row || terminal(row.value) || row.value.call.state === 'ending') return;
      const s = row.value; const now = voiceInteger(this.options.now()); let reason: CallEndReason | undefined;
      if (s.call.startedAt === null && now >= s.call.createdAt + s.limits.setupTimeoutMs) reason = 'setup_timeout';
      else if (s.leaseExpiresAt !== null && now >= s.leaseExpiresAt) reason = 'worker_lost';
      else if (s.call.startedAt !== null && now >= s.call.startedAt + s.limits.maxDurationSeconds * 1000) reason = 'duration_limit';
      else if (s.disconnectedAt !== null && now >= s.disconnectedAt + s.limits.reconnectGraceMs) reason = 'participant_disconnected';
      else if (s.lastUserSpeechAt !== null && now >= s.lastUserSpeechAt + s.limits.silenceTimeoutMs) reason = 'silence_limit';
      else if (s.completedTurns >= s.limits.maxTurns) reason = 'turn_limit';
      if (reason) await requestCallEndInTransaction(tx, callId, reason, now);
    });
    await this.recoverAction(scopeId, callId);
  }
}
