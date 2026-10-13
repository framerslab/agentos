import { EventEmitter } from 'node:events';
import { sameVoiceGeneration, type AudioFrame, type EncodedAudioChunk, type IPlaybackTransport, type PlaybackReceipt, type ServerTextMessage, type VoiceGeneration } from '../voice-pipeline/types.js';
import type { CallEndReason, CallTransport } from './contracts/index.js';
import type { CallCredentials } from './CallCredentials.js';
import type { VoiceCallManager } from './VoiceCallManager.js';
import type { SlotLeaseHandle } from './SlotLimiter.js';
import { voiceInteger, type CredentialBinding, type StoredVoiceCall, type VoiceStore, type VoiceTransaction } from './stores/types.js';

/** Pipeline lifetime on one logical call. start is called exactly once; reattach never opens a conversation. */
export interface CallBindingPipeline {
  start(generation: VoiceGeneration): Promise<void>;
  detach(reason: string, transportEpoch: number): Promise<void>;
  reattach(generation: VoiceGeneration): Promise<void>;
}
/** Trusted worker construction, including the already acquired scope/host capacity share. */
export interface CallTransportBindingOptions {
  scopeId: string; callId: string; participantId: string; workerGeneration: number;
  store: VoiceStore; manager: VoiceCallManager; credentials: CallCredentials; slot: SlotLeaseHandle;
  now: () => number; pipeline: CallBindingPipeline;
  /** Rechecks dispatch identity and current host policy; storage work only, never network or nested transactions. */
  authorize(tx: VoiceTransaction, state: StoredVoiceCall, credential: CredentialBinding): Promise<void>;
}
/** The token is consumed once; caller ids and declared transport must match its durable binding. */
export interface CallAttachment {
  token: string; origin: string; transportEpoch: number; participantId: string;
  transport: CallTransport; physical: IPlaybackTransport;
}
/** Stable logical transport. Only end emits terminal close; a physical close initiates detach. */
export class CallTransportBinding extends EventEmitter implements IPlaybackTransport {
  readonly id: string;
  private physical?: IPlaybackTransport;
  private unlisten?: () => void;
  private current: VoiceGeneration;
  private attached = false;
  private started = false;
  private terminal = false;
  private busy = false;
  private detaching?: Promise<void>;
  private ending?: Promise<void>;
  private releasing?: Promise<void>;
  private mediaClosed = false;
  private receivedSamples = 0;
  private inputSequence = 0;
  private pendingEpoch?: number;
  constructor(private readonly options: CallTransportBindingOptions) {
    super(); voiceInteger(options.workerGeneration, 1);
    if (options.slot.scopeId !== options.scopeId || options.slot.callId !== options.callId) throw new Error('foreign slot');
    this.id = `call:${options.callId}`;
    this.current = { workerGeneration: options.workerGeneration, inferenceGeneration: 1, transportEpoch: 0 };
  }
  /** Transient detachment is connecting; closed is reserved for terminal shutdown. */
  get state(): 'connecting' | 'open' | 'closing' | 'closed' { return this.mediaClosed ? 'closed' : this.terminal ? 'closing' : this.attached ? 'open' : 'connecting'; } /** Server-owned call id for canonical media admission. */ get callId(): string { return this.options.callId; } /** Server-owned participant identity; never accepted as client-selected authority. */ get participantId(): string { return this.options.participantId; }
  /** Snapshot only; mutation cannot change the live fence. */
  get generation(): VoiceGeneration { return { ...this.current }; }
  /** Pipeline callback. Stores the fence before new inference and allows the manager's detach increment to match once. */
  async recordGeneration(g: VoiceGeneration): Promise<void> {
    for (const n of Object.values(g)) voiceInteger(n, 1);
    await this.options.store.withTransaction(this.options.scopeId, async (tx) => {
      const row = await tx.get('calls', this.options.callId); const s = row?.value;
      if (!row || !s || this.terminal || !['connecting', 'connected', 'reconnecting'].includes(s.call.state) || g.workerGeneration !== this.options.workerGeneration || s.call.workerGeneration !== g.workerGeneration || (g.transportEpoch !== s.call.transportEpoch && g.transportEpoch !== this.pendingEpoch)) throw new Error('stale generation');
      if (g.inferenceGeneration < s.call.inferenceGeneration || g.inferenceGeneration > s.call.inferenceGeneration + 1) throw new Error('stale generation');
      s.call.inferenceGeneration = g.inferenceGeneration; await tx.put('calls', row.id, s, row.version);
      this.current = { ...g };
    });
    this.emit('generation', this.generation);
  }
  private async admission(binding: CredentialBinding): Promise<void> {
    await this.options.manager.tick(this.options.scopeId, this.options.callId);
    await this.options.store.withTransaction(this.options.scopeId, async (tx) => {
      const row = await tx.get('calls', this.options.callId); const s = row?.value;
      const lease = await tx.get('slots', this.options.slot.leaseId); const expected = this.options.slot;
      if (!s || !lease || lease.value.released || lease.value.expiresAt <= this.options.now() || lease.value.callId !== expected.callId || lease.value.hostId !== expected.hostId || lease.value.holder !== expected.holder || lease.value.generation !== expected.generation) throw new Error('slot refused');
      if (this.terminal || s.preparationStep !== 3 || !['connecting', 'connected', 'reconnecting'].includes(s.call.state) || s.contentFenced || s.call.workerGeneration !== this.options.workerGeneration || binding.workerGeneration !== this.options.workerGeneration || binding.callId !== this.options.callId || binding.participantId !== this.options.participantId || binding.generation !== s.credentialGeneration || binding.transportEpoch !== s.nextTransportEpoch || binding.agentRevision !== s.call.agentRevision) throw new Error('attachment refused');
      await this.options.authorize(tx, s, binding);
    });
  }
  /** Authenticates, fences an old connection and binds one replacement without changing worker or call identity. */
  async reattach(input: CallAttachment): Promise<void> {
    if (this.busy || this.detaching) throw new Error('binding busy');
    if (this.terminal || input.participantId !== this.options.participantId || input.transportEpoch <= this.current.transportEpoch || input.physical.state !== 'open') throw new Error('attachment refused');
    this.busy = true; let consumed = false;
    try {
      const credential = await this.options.credentials.consumeMedia(this.options.scopeId, this.options.callId, input.token, input.origin, input.transportEpoch); consumed = true;
      if (credential.transport !== input.transport || credential.participantId !== input.participantId) throw new Error('attachment refused');
      await this.admission(credential);
      if (this.attached) await this.detachCurrent('replaced', this.current.transportEpoch);
      if (this.terminal || input.physical.state !== 'open') throw new Error('attachment refused');
      this.pendingEpoch = input.transportEpoch; this.physical = input.physical;
      // Watch loss during asynchronous start as well. Input remains frozen until durable readiness commits.
      const physical = input.physical; const epoch = input.transportEpoch;
      let lost = false;
      const loss = (): void => { lost = true; if (this.attached && this.physical === physical) void this.detach('media_lost', epoch).catch(() => this.close()); };
      const audio = (frame: AudioFrame): void => {
        if (!this.attached || this.physical !== physical || this.terminal) return;
        const timestamp = this.receivedSamples * 1000 / 16000; this.receivedSamples += frame.samples.length;
        this.emit('audio', { ...frame, timestamp, sequence: ++this.inputSequence, channels: 1, generation: this.generation });
      };
      const gap = (event: unknown): void => { if (this.attached && this.physical === physical && !this.terminal) this.emit('gap', event); };
      const message = (value: { type?: string; action?: { type?: string } }): void => {
        if (!this.attached || this.physical !== physical || this.terminal) return;
        if (value?.type !== 'control' || !['mute', 'unmute', 'stop'].includes(value.action?.type ?? '')) { void this.end('transport_failure').catch(() => {}); return; }
        if (value.action!.type === 'stop') { void this.end('client_stop').catch(() => {}); return; }
        this.emit('message', value);
      };
      physical.on('audio', audio); physical.on('gap', gap); physical.on('message', message); physical.on('close', loss); physical.on('error', loss);
      this.unlisten = () => { physical.off('audio', audio); physical.off('gap', gap); physical.off('message', message); physical.off('close', loss); physical.off('error', loss); physical.on('error', () => {}); };
      await physical.readyForPlayback?.();
      const state = await this.options.manager.get(this.options.scopeId, this.options.callId);
      if (!state) throw new Error('attachment refused');
      const generation = { workerGeneration: this.options.workerGeneration, inferenceGeneration: state.inferenceGeneration, transportEpoch: epoch };
      if (!this.started) { this.started = true; await this.options.pipeline.start(generation); }
      else await this.options.pipeline.reattach(generation);
      await this.admission(credential);
      if (lost || this.terminal || physical.state !== 'open') throw new Error('attachment refused');
      await this.options.manager.connected(this.options.scopeId, this.options.callId, this.options.workerGeneration, epoch);
      if (lost || this.terminal || physical.state !== 'open') throw new Error('attachment refused');
      this.current = generation; this.attached = true; this.emit('open');
    } catch (error) {
      if (consumed) await this.end('transport_failure');
      throw error;
    } finally { this.pendingEpoch = undefined; this.busy = false; }
  }
  private async detachCurrent(reason: string, epoch: number): Promise<void> {
    if (this.terminal || epoch !== this.current.transportEpoch || !this.physical) return;
    const old = this.physical; const oldGeneration = this.generation; this.attached = false;
    // Freeze synchronously, then stop authoritative time before awaited native cancellation.
    await this.options.manager.detached(this.options.scopeId, this.options.callId, this.options.workerGeneration, epoch);
    await this.options.pipeline.detach(reason, epoch);
    await old.clearPlayback(oldGeneration);
    this.unlisten?.(); this.unlisten = undefined; this.physical = undefined;
    old.close(1000, 'transport detached'); await (old as IPlaybackTransport & { whenClosed?(): Promise<void> }).whenClosed?.(); this.emit('detached', { transportEpoch: epoch });
  }
  /** Coalesces repeated physical-loss notifications. Failure leaves cleanup in the manager's ending path. */
  detach(reason: string, transportEpoch: number): Promise<void> {
    if (this.terminal || transportEpoch !== this.current.transportEpoch) return Promise.resolve();
    if (this.detaching) return this.detaching;
    this.attached = false;
    const work = this.detachCurrent(reason, transportEpoch).catch(async () => { await this.end('transport_failure'); throw new Error('detach incomplete'); });
    this.detaching = work.finally(() => { this.detaching = undefined; }); return this.detaching;
  }
  private output(generation: VoiceGeneration | undefined): IPlaybackTransport {
    if (!this.attached || this.terminal || !this.physical || !generation || !sameVoiceGeneration(generation, this.current)) throw new Error('stale transport output');
    return this.physical;
  }
  /** Requires scope/call and all generation fields on every encoded chunk. */
  async sendAudio(chunk: EncodedAudioChunk): Promise<void> {
    if (chunk.scopeId !== this.options.scopeId || chunk.callId !== this.options.callId) throw new Error('stale transport scope');
    await this.output(chunk.generation).sendAudio(chunk);
  }
  /** The pipeline attaches scope/call/generation without widening the legacy message union. */
  async sendControl(message: ServerTextMessage): Promise<void> {
    const scoped = message as ServerTextMessage & { scopeId?: string; callId?: string; generation?: VoiceGeneration };
    if (scoped.scopeId !== this.options.scopeId || scoped.callId !== this.options.callId) throw new Error('stale transport scope');
    await this.output(scoped.generation).sendControl(message);
  }
  /** A receipt from a replaced physical path cannot complete the new generation's queue. */
  async waitForPlayback(generation: VoiceGeneration, sequence: number, signal: AbortSignal): Promise<PlaybackReceipt> {
    const physical = this.output(generation); const result = await physical.waitForPlayback(generation, sequence, signal);
    if (physical !== this.output(generation) || !sameVoiceGeneration(result.generation, generation) || result.sequence !== sequence) throw new Error('stale playback receipt');
    return result;
  }
  /** Cancellation may address the preceding inference generation while input and output are frozen. */
  async clearPlayback(generation: VoiceGeneration): Promise<void> {
    if (generation.workerGeneration !== this.options.workerGeneration || generation.transportEpoch !== this.current.transportEpoch) return;
    await this.physical?.clearPlayback(generation);
  }
  /** Freezes input and commits terminal intent; the manager releases physical media after transcript drain. */
  end(reason: CallEndReason): Promise<void> {
    if (this.ending) return this.ending;
    this.terminal = true; this.attached = false;
    this.ending = this.options.manager.requestEnd(this.options.scopeId, this.options.callId, reason).then(() => {}).catch((error) => { this.ending = undefined; throw error; }); return this.ending;
  }
  /** Positive media-close barrier, invoked only in the manager's release-media phase. */
  releaseMedia(): Promise<void> {
    if (!this.releasing) this.releasing = (async () => {
      this.terminal = true; this.attached = false; this.unlisten?.(); this.unlisten = undefined;
      const physical = this.physical; physical?.close(1000, 'call ended');
      await (physical as (IPlaybackTransport & { whenClosed?(): Promise<void> }) | undefined)?.whenClosed?.();
      this.physical = undefined; this.mediaClosed = true; this.emit('close');
    })().catch((error) => { this.releasing = undefined; throw error; }); return this.releasing;
  }
  /** IStreamTransport terminal closure; errors remain observable without an unhandled rejection. */
  close(_code?: number, _reason?: string): void { void this.end('transport_failure').catch(() => this.emit('cleanup_incomplete')); }
  /** Redacts credential service, store and host callbacks. */
  toJSON(): string { return '[CallTransportBinding]'; }
}
