import { EventEmitter } from 'node:events';
import { VoiceAgentSchema, SupplierUsageComponentSchema, type VoiceAgent, type SupplierUsageComponent, type CallEndReason } from './contracts/index.js';
import { captureVoiceScope, type VoiceScopeContext } from './VoiceScopeContext.js';
import { ScopedVoiceMemory, type VoiceMemoryStore } from './ScopedVoiceMemory.js';
import { canonicalVoiceHash, type VoiceCallManager } from './VoiceCallManager.js';
import { CallTransportBinding, type CallTransportBindingOptions } from './CallTransportBinding.js';
import type { CallCredentials } from './CallCredentials.js';
import type { VoiceStore, StoredVoiceCall, CallFenceEvidence } from './stores/types.js';
import type { SlotLimiter, SlotRequest, SlotLeaseHandle } from './SlotLimiter.js';
import { VoicePipelineOrchestrator } from '../voice-pipeline/VoicePipelineOrchestrator.js';
import { sameVoiceGeneration, type AudioIdentity, type VoiceGeneration, type VadFrameEvent, type ScopedTurnCompleteEvent, type StreamingTTSUsageEvent } from '../voice-pipeline/types.js';
import type { SpeechProviderResolver, VoiceOptionsStore, FrozenVoicePlan, OpenedVoicePlan } from '../speech/SpeechProviderResolver.js';
import type { ReasoningProviderResolver, ResolvedReasoningSession } from './ReasoningProviderResolver.js';
import type { VoiceToolRegistry, VoiceNetworkDependencies } from './reasoning/tools.js';
import { AttemptBudgetExhaustedError, CountingAttemptBudget, ModelAttemptBudget, type IAttemptAuthorizer } from '../../safety/runtime/ModelAttemptBudget.js';
import type { ICompoundCreditStore } from '../../safety/runtime/CompoundCreditStore.js';
/** Explicit funding; only a local policy can choose the money-free counter. */
export type VoiceSessionFunding = { kind: 'local' } | { kind: 'credit'; store: ICompoundCreditStore; holdId: string };
/** Already reserved manager call, immutable agent revision and host-authorized capacity. */
export interface StartVoiceSession {
  scope: VoiceScopeContext; agent: VoiceAgent; funding: VoiceSessionFunding; slot: SlotRequest;
}
/** Infrastructure and content-free callbacks, never commercial prices or a process-wide provider key. */
export interface VoiceSessionFactoryOptions {
  /** Host-declared per-call synthesis bounds, independent of model-attempt admission. */
  synthesisLimits: { maxTextCharacters: number; maxSynthesisRequests: number };
  store: VoiceStore; manager: VoiceCallManager; limiter: SlotLimiter; credentials: CallCredentials;
  speech: SpeechProviderResolver; reasoning: ReasoningProviderResolver; options: VoiceOptionsStore; tools: VoiceToolRegistry;
  memory?(scope: VoiceScopeContext): VoiceMemoryStore; network?: VoiceNetworkDependencies; now(): number;
  authorizeMedia: CallTransportBindingOptions['authorize'];
  onInterrupted(identity: AudioIdentity): Promise<void>;
}
const keyOf = (scopeId: string, callId: string): string => JSON.stringify([scopeId, callId]);
/** One owner per call. Repeated preparation is deduplicated; a changed request is refused. */
export class VoiceSessionFactory {
  private readonly calls = new Map<string, { hash: string; operation: Promise<ManagedVoiceSession> }>();
  constructor(private readonly options: VoiceSessionFactoryOptions) {
    const limits = structuredClone(options.synthesisLimits);
    if (!limits || ![limits.maxTextCharacters, limits.maxSynthesisRequests].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('invalid synthesis limits');
    this.options = { ...options, synthesisLimits: Object.freeze(limits) };
  }
  /** Validates and reserves runtime capacity without starting models or accepting media. */
  startSession(request: StartVoiceSession): Promise<ManagedVoiceSession> {
    const scope = captureVoiceScope(request.scope); const agent = VoiceAgentSchema.parse(request.agent); const slot = structuredClone(request.slot); const funding: VoiceSessionFunding = request.funding.kind === 'credit' ? { kind: 'credit', store: request.funding.store, holdId: request.funding.holdId } : { kind: 'local' };
    const key = keyOf(scope.scopeId, scope.callId); const hash = canonicalVoiceHash({ agent, principal: scope.principal, providers: scope.policy.providers,
      slot, funding: funding.kind === 'credit' ? { kind: 'credit', holdId: funding.holdId } : funding });
    const old = this.calls.get(key); if (old) { if (old.hash !== hash) return Promise.reject(new Error('call preparation conflict')); return old.operation; }
    const operation = this.prepare({ scope, agent, slot, funding }); this.calls.set(key, { hash, operation });
    void operation.catch(() => { if (this.calls.get(key)?.operation === operation) this.calls.delete(key); }); return operation;
  }
  /** Reads only a call prepared by this factory; it cannot create a call from a media id. */
  async get(scopeId: string, callId: string): Promise<ManagedVoiceSession | undefined> { return this.calls.get(keyOf(scopeId, callId))?.operation; }
  /** Removes a positively stopped runtime after manager settlement; never releases capacity by itself. */
  async forget(scopeId: string, callId: string): Promise<void> {
    const runtime = await this.get(scopeId, callId); if (runtime && !runtime.released) throw new Error('runtime still owned');
    this.calls.delete(keyOf(scopeId, callId));
  }
  private async prepare(input: StartVoiceSession): Promise<ManagedVoiceSession> {
    const { scope, agent, slot, funding } = input; const state = await this.options.store.withTransaction(scope.scopeId, async (tx) => (await tx.get('calls', scope.callId))?.value);
    if (!state || !['prepared', 'connecting'].includes(state.call.state) || state.preparationStep < 1 || !state.reservationRef || state.call.agentId !== agent.agentId || state.call.agentRevision !== agent.revision || agent.scopeId !== scope.scopeId || canonicalVoiceHash(state.call.initiatingPrincipal) !== canonicalVoiceHash(scope.principal) || canonicalVoiceHash(state.call.attemptAllowance.limits) !== canonicalVoiceHash(agent.reasoning.attemptLimits) || canonicalVoiceHash(state.limits) !== canonicalVoiceHash(agent.limits) || state.call.workerGeneration !== scope.policy.identity.generation.workerGeneration) throw new Error('call authority refused');
    if (slot.scopeId !== scope.scopeId || slot.callId !== scope.callId || slot.ttlMs !== 15000) throw new Error('slot authority refused');
    let rawBudget: IAttemptAuthorizer;
    if (funding.kind === 'local') {
      if (scope.policy.mode !== 'local' || state.reservationRef !== `local:${scope.callId}` || state.call.attemptAllowance.authorizedAttempts !== 0) throw new Error('local budget refused');
      rawBudget = new CountingAttemptBudget(agent.reasoning.attemptLimits);
    } else {
      const hold = await funding.store.withTransaction((tx) => tx.getHold(funding.holdId));
      if (!hold || hold.holdId !== state.reservationRef || hold.scopeId !== scope.scopeId || hold.operationId !== scope.callId || hold.kind !== 'call' || hold.state !== 'held' || hold.expiresAt <= this.options.now() || canonicalVoiceHash(JSON.parse(hold.attemptLimits)) !== canonicalVoiceHash(agent.reasoning.attemptLimits)) throw new Error('call hold refused');
      rawBudget = new ModelAttemptBudget({ store: funding.store, holdId: funding.holdId, now: this.options.now });
    }
    const abort = new AbortController(); const captured = captureVoiceScope({ ...scope, signal: AbortSignal.any([scope.signal, abort.signal]) });
    const terminate = (reason: CallEndReason): void => { abort.abort(reason); void this.options.manager.requestEnd(scope.scopeId, scope.callId, reason).catch(() => {}); };
    const budget: IAttemptAuthorizer = {
      authorize: async (request) => {
        captured.signal.throwIfAborted();
        try {
          const grant = await rawBudget.authorize(request);
          await this.options.store.withTransaction(scope.scopeId, async (tx) => {
            const row = await tx.get('calls', scope.callId); const s = row?.value;
            if (!row || !s || !['connecting', 'connected', 'reconnecting'].includes(s.call.state) || s.preparationStep !== 3 || s.call.workerGeneration !== state.call.workerGeneration || s.call.attemptAllowance.authorizedAttempts >= s.call.attemptAllowance.limits.maxAttempts) throw new Error('attempt call fenced');
            s.call.attemptAllowance.authorizedAttempts++; await tx.put('calls', scope.callId, s, row.version);
          });
          captured.signal.throwIfAborted(); return grant;
        } catch (error) { if (error instanceof AttemptBudgetExhaustedError) terminate('budget_exhausted'); throw error; }
      }, record: async (id, usage, final) => {
        try { await rawBudget.record(id, usage, final); }
        catch (error) { if (error instanceof AttemptBudgetExhaustedError) terminate('budget_exhausted'); throw error; }
      },
    };
    const frozen = await this.options.speech.resolveVoicePlan(captured, agent, this.options.options, this.options.network);
    const reasoning = await this.options.reasoning.resolve(captured, agent.reasoning, budget, agent.prompt, this.options.tools);
    let runtime: ManagedVoiceSession | undefined;
    const admitted = await this.options.limiter.initialize(slot, { signal: captured.signal, timeoutMs: Math.min(10000, state.limits.setupTimeoutMs),
      initialize: async (lease, signal) => { signal.throwIfAborted(); runtime = new ManagedVoiceSession(this.options, captured, frozen, reasoning, budget, lease, state, abort); return runtime; },
      fence: async (lease) => {
        abort.abort(); reasoning.abort(); await reasoning.whenIdle();
        if (runtime) { await runtime.abortModelAndTools(); await runtime.cancelTts(); await runtime.releaseMedia(); await runtime.confirmStopped(); }
        return { generation: lease.generation, stopped: true, evidenceRef: `preparation-stopped:${scope.callId}:${lease.generation}` };
      } });
    admitted.value.arm(); return admitted.value;
  }
}
/** Runtime owned by one manager call, retaining history, detectors, quantities and allowance through reattachment. */
export class ManagedVoiceSession extends EventEmitter {
  readonly binding: CallTransportBinding;
  readonly orchestrator: VoicePipelineOrchestrator;
  readonly memory: ScopedVoiceMemory;
  readonly agent: VoiceAgent;
  private opened?: OpenedVoicePlan;
  private started?: Promise<void>;
  private stopping?: Promise<void>;
  private stopped?: CallFenceEvidence;
  private nativeStop?: { stopped: true; evidenceRef: string };
  private timer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private heartbeatWork?: Promise<void>;
  private finalReport?: Promise<void>;
  private queued = 0;
  private controlWork = Promise.resolve();
  private sequence: number;
  private turns: number;
  private closed = false;
  private slotReleased = false;
  private readonly quantities = new Map<string, SupplierUsageComponent>();
  constructor(private readonly options: VoiceSessionFactoryOptions, readonly scope: VoiceScopeContext, private readonly plan: FrozenVoicePlan,
    private readonly reasoning: ResolvedReasoningSession, private readonly budget: IAttemptAuthorizer, private lease: SlotLeaseHandle,
    private readonly initial: StoredVoiceCall, private readonly abort: AbortController) {
    super(); this.agent = plan.agent; this.sequence = initial.reportSequence; this.turns = initial.completedTurns;
    this.memory = new ScopedVoiceMemory(scope, options.memory?.(scope));
    for (const component of initial.call.usage.supplierComponents) this.quantities.set(this.quantityKey(component), component);
    this.orchestrator = new VoicePipelineOrchestrator({ stt: this.agent.stt.providerId, tts: this.agent.tts.providerId, language: this.agent.language, voice: this.agent.voice.id, format: 'pcm' });
    this.binding = new CallTransportBinding({ scopeId: scope.scopeId, callId: scope.callId, participantId: initial.participantId, workerGeneration: initial.call.workerGeneration,
      store: options.store, manager: options.manager, credentials: options.credentials, slot: lease, now: options.now, authorize: options.authorizeMedia,
      pipeline: { start: (generation) => this.start(generation), detach: (reason, epoch) => this.orchestrator.detach(reason, epoch), reattach: (generation) => this.orchestrator.reattach(generation) } });
    this.orchestrator.on('turn_complete', (event: ScopedTurnCompleteEvent) => {
      const count = ++this.turns;
      this.enqueue(() => options.manager.completedTurn(scope.scopeId, scope.callId, event.generation.workerGeneration, event.generation.inferenceGeneration, event.generation.transportEpoch, count));
    });
    this.orchestrator.on('usage', (event: StreamingTTSUsageEvent) => {
      if (event.scopeId !== scope.scopeId || event.callId !== scope.callId || event.generation.workerGeneration !== initial.call.workerGeneration || !Number.isSafeInteger(event.sampleRate) || event.sampleRate < 8000 || event.sampleRate > 192000 || !scope.policy.providers.some((p) => p.providerId === event.providerId && p.purposes.includes('tts'))) { this.fail('provider_failure'); return; }
      const status = event.final ? event.status === 'completed' ? 'complete' : event.status === 'cancelled' ? 'cancelled' : 'failed' : 'pending';
      this.enqueue(async () => {
        await this.supplierUsage({ providerId: event.providerId, attemptId: event.requestId, generation: event.generation.inferenceGeneration, component: 'synthesis_accepted_character', unit: 'character', quantity: event.acceptedCharacters, status });
        await this.supplierUsage({ providerId: event.providerId, attemptId: event.requestId, generation: event.generation.inferenceGeneration, component: `synthesis_sample_${event.sampleRate}`, unit: 'sample', quantity: event.generatedSamples, status });
      });
    });
    this.orchestrator.on('close', () => { if (!this.closed) this.fail('agent_completion'); });
    this.binding.on('cleanup_incomplete', () => this.fail('transport_failure')); this.binding.on('message', (message: { type?: string; action?: { type?: string } }) => { if (message.type === 'control' && message.action?.type === 'stop') this.fail('client_stop'); });
    scope.signal.addEventListener('abort', () => { if (!this.closed) this.fail(scope.signal.reason === 'budget_exhausted' ? 'budget_exhausted' : 'worker_lost'); }, { once: true });
  }
  /** Whether native stop and both capacity releases have completed. */
  get released(): boolean { return this.slotReleased; }
  private quantityKey(c: SupplierUsageComponent): string { return JSON.stringify([c.providerId, c.attemptId, c.generation, c.component, c.unit]); }
  private async supplierUsage(raw: SupplierUsageComponent): Promise<void> {
    const c = SupplierUsageComponentSchema.parse(raw); const key = this.quantityKey(c); const old = this.quantities.get(key);
    if ((!old && this.quantities.size >= 4096) || (old && (c.quantity < old.quantity || (old.status !== 'pending' && canonicalVoiceHash(old) !== canonicalVoiceHash(c))))) throw new Error('supplier cumulative report refused');
    this.quantities.set(key, c);
  }
  private enqueue(work: () => Promise<void>): void {
    if (++this.queued > 32) { this.queued--; this.fail('sink_failure'); return; }
    this.controlWork = this.controlWork.then(work).catch(() => this.fail('sink_failure')).finally(() => { this.queued--; });
  }
  private fail(reason: CallEndReason): void {
    if (this.closed) return; this.closed = true; this.stopTimers(); this.abort.abort(); this.reasoning.abort();
    void this.options.manager.requestEnd(this.scope.scopeId, this.scope.callId, reason).catch(() => { this.emit('reconciliation_required', { scopeId: this.scope.scopeId, callId: this.scope.callId }); });
    void this.cancelTts().catch(() => { this.emit('reconciliation_required', { scopeId: this.scope.scopeId, callId: this.scope.callId }); });
  }
  private stopTimers(): void { clearTimeout(this.timer); clearTimeout(this.watchdog); }
  /** Arms a periodic report and an independent hard local stop deadline. */
  arm(): void {
    if (this.closed || this.scope.signal.aborted) { this.fail('worker_lost'); return; }
    this.watchdog = setTimeout(() => this.fail('worker_lost'), Math.max(0, this.lease.expiresAt - this.options.now()));
    this.timer = setTimeout(() => { void this.heartbeat().catch(() => this.fail('worker_lost')); }, 5000);
  }
  private start(generation: VoiceGeneration): Promise<void> {
    if (this.started) return this.started;
    this.started = (async () => {
      this.scope.signal.throwIfAborted(); this.opened = await this.plan.open(this.budget, (c) => this.supplierUsage(c));
      this.scope.signal.throwIfAborted();
      this.opened.vad.on('vad', (event: VadFrameEvent) => {
        if (!event.speech || event.scopeId !== this.scope.scopeId || event.callId !== this.scope.callId || !sameVoiceGeneration(event.generation, this.binding.generation)) return;
        this.enqueue(() => this.options.manager.userSpeech(this.scope.scopeId, this.scope.callId, event.generation.workerGeneration, event.generation.transportEpoch));
      });
      await this.orchestrator.startSession(this.binding, this.reasoning, { streamingSTT: this.opened.stt, streamingTTS: this.opened.tts, callProfile: {
        identity: { scopeId: this.scope.scopeId, callId: this.scope.callId, turnId: 'turn-0', generation }, managerOwned: true, vadSession: this.opened.vad, audioEndpointDetector: this.opened.endpoint,
        maxInputFrames: 32, maxInputSamples: 32000, playback: { maxBytes: 768000, maxDurationMs: 2000 }, minSpeechMs: 120,
        maxTextCharacters: this.options.synthesisLimits.maxTextCharacters, maxSynthesisRequests: Math.min(this.options.synthesisLimits.maxSynthesisRequests, this.initial.limits.maxTurns),
        onGeneration: async (next) => { await this.controlWork; await this.binding.recordGeneration(next); },
        onInterrupted: (identity) => this.enqueue(() => this.options.onInterrupted(identity)),
        onFailure: (code) => this.fail(code === 'budget_exhausted' ? 'budget_exhausted' : code === 'transport_failure' ? 'transport_failure' : 'provider_failure'),
        fenceInference: async (old) => { this.reasoning.abort(); await Promise.all([this.reasoning.whenIdle(), this.opened!.fence(old)]); },
      } });
    })(); this.started.catch(() => this.fail('provider_failure')); return this.started;
  }
  /** One in-flight renewal/report; no interval can accumulate pending promises. */
  heartbeat(): Promise<void> {
    if (this.heartbeatWork) return this.heartbeatWork; if (this.closed) return Promise.resolve();
    this.heartbeatWork = (async () => {
      const next = await this.options.limiter.renew(this.lease, 15000); if (!next || this.closed) throw new Error('worker lease lost');
      await this.options.manager.tick(this.scope.scopeId, this.scope.callId); const state = await this.options.manager.get(this.scope.scopeId, this.scope.callId); if (state && ['connected', 'reconnecting'].includes(state.state)) await this.report(); else if (!state || !['prepared', 'connecting'].includes(state.state)) throw new Error('call stopped'); if (this.closed) throw new Error('worker lease lost'); this.lease = next;
      this.stopTimers(); this.arm();
    })().finally(() => { this.heartbeatWork = undefined; }); return this.heartbeatWork;
  }
  private async report(): Promise<void> {
    await this.options.manager.report(this.scope.scopeId, this.scope.callId, { sequence: ++this.sequence, workerGeneration: this.initial.call.workerGeneration,
      transportEpoch: this.binding.generation.transportEpoch, supplierComponents: [...this.quantities.values()] });
  }
  /** Manager cleanup step: cancel model/tools; a lost response without native proof rejects. */
  async abortModelAndTools(): Promise<void> { this.closed = true; this.stopTimers(); this.reasoning.abort(); await this.reasoning.whenIdle(); }
  /** Manager cleanup step: cancel synthesis while preserving recognition for the ordered drain. */
  cancelTts(): Promise<void> {
    if (!this.stopping) this.stopping = (async () => {
      if (this.started) { try { await this.started; } catch { /* failed start still owns any opened resources */ } }
      await this.orchestrator.cancelSynthesis(); await this.opened?.fenceSynthesis(this.binding.generation);
    })().catch((error) => { this.stopping = undefined; throw error; }); return this.stopping;
  }
  /** Manager cleanup step: await the physical receiver's clear or actual transport teardown. */
  async clearPlayback(): Promise<void> { await this.orchestrator.clearCallPlayback(); await this.binding.clearPlayback(this.binding.generation); }
  /** Ordinary-stop drain; purge callers bypass this method after fencing their content sink. */
  async drainTranscripts(signal: AbortSignal): Promise<void> { await this.orchestrator.drainRecognition(signal); await this.controlWork; }
  /** Manager cleanup step: preserve an already committed terminal reason while closing physical media. */
  async releaseMedia(): Promise<void> {
    const state = await this.options.manager.get(this.scope.scopeId, this.scope.callId);
    await this.binding.end(state?.endReason ?? 'agent_completion');
    await this.orchestrator.stopSession(); await this.binding.releaseMedia(); this.abort.abort();
  }
  /** Positive proof only after all owned work and native disposal acknowledge stop. */
  async confirmStopped(): Promise<CallFenceEvidence> {
    if (this.stopped) return this.stopped; if (!this.closed) throw new Error('stop evidence missing');
    await this.cancelTts(); await this.reasoning.whenIdle(); await this.controlWork;
    if (!this.nativeStop) {
      const evidence = this.opened ? await this.opened.fence(this.binding.generation) : { stopped: true as const, evidenceRef: 'not-started' };
      await this.opened?.dispose(); if (this.binding.state !== 'closed') throw new Error('media stop evidence missing');
      this.nativeStop = evidence;
    }
    if (!this.finalReport) this.finalReport = (async () => { if (this.heartbeatWork) await this.heartbeatWork.catch(() => {}); await this.options.store.withTransaction(this.scope.scopeId, async (tx) => { const row = await tx.get('calls', this.scope.callId); if (!row || row.value.call.state !== 'ending' || row.value.call.workerGeneration !== this.initial.call.workerGeneration) throw new Error('final supplier fence refused'); const merged = new Map(row.value.call.usage.supplierComponents.map((c) => [this.quantityKey(c), c])); for (const c of this.quantities.values()) { const old = merged.get(this.quantityKey(c)); if (old && (old.quantity > c.quantity || (old.status !== 'pending' && canonicalVoiceHash(old) !== canonicalVoiceHash(c)))) throw new Error('final supplier regression'); merged.set(this.quantityKey(c), c); } if (merged.size > 4096) throw new Error('supplier history full'); row.value.call.usage.supplierComponents = [...merged.values()]; await tx.put('calls', this.scope.callId, row.value, row.version); }); })();
    try { await this.finalReport; } catch (error) { this.finalReport = undefined; throw error; }
    this.stopped = { workerGeneration: this.initial.call.workerGeneration, workerStopped: true, mediaClosed: true, inferenceStopped: true, evidenceRef: `runtime:${this.scope.callId}:${this.nativeStop.evidenceRef}` };
    return this.stopped;
  }
  /** Releases both limits only with the same generation and acknowledged native stop. */
  async releaseSlots(): Promise<void> {
    if (this.slotReleased) return; if (!this.stopped) throw new Error('stop evidence missing');
    if (!await this.options.limiter.release(this.lease, { generation: this.lease.generation, stopped: true, evidenceRef: this.stopped.evidenceRef })) throw new Error('slot release refused');
    this.slotReleased = true;
  }
}
