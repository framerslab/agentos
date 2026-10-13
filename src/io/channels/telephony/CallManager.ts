/**
 * @fileoverview Voice Call Manager — state machine for call lifecycle.
 *
 * Manages active calls, enforces monotonic state transitions, handles
 * webhook event processing, and persists call records. Provider-agnostic:
 * delegates to {@link IVoiceCallProvider} implementations for actual
 * telephony operations.
 *
 * Modeled after OpenClaw's 888-line CallManager with simplifications
 * for the AgentOS extension architecture.
 *
 * @module @framers/agentos/voice/CallManager
 */

import { randomUUID } from 'node:crypto';
import type { IVoiceCallProvider, InitiateCallInput } from './IVoiceCallProvider.js';
import type {
  CallDirection,
  CallId,
  CallMode,
  CallRecord,
  CallState,
  ITelephonyCallStore,
  NormalizedCallEvent,
  TranscriptEntry,
  VoiceCallConfig,
  VoiceProviderName,
  WebhookContext,
} from './types.js';
import {
  CONVERSATION_STATES,
  STATE_ORDER,
  TERMINAL_CALL_STATES,
} from './types.js';

// ============================================================================
// Event Emitter Types
// ============================================================================

/** Events emitted by the CallManager. */
export type CallManagerEventType =
  | 'call:initiated'
  | 'call:ringing'
  | 'call:answered'
  | 'call:active'
  | 'call:speaking'
  | 'call:listening'
  | 'call:ended'
  | 'call:error'
  | 'call:transcript'
  | 'call:speech-start'
  | 'call:dtmf'
  | 'media:connected';

export interface CallManagerEvent {
  type: CallManagerEventType;
  callId: CallId;
  call: CallRecord;
  data?: unknown;
}

export type CallManagerEventHandler = (event: CallManagerEvent) => void | Promise<void>;

// ============================================================================
// CallManager
// ============================================================================

export class CallManager {
  private readonly activeCalls = new Map<CallId, CallRecord>();
  private readonly providerCallIdMap = new Map<string, CallId>();
  private readonly processedEventIds = new Set<string>();
  private readonly providers = new Map<VoiceProviderName, IVoiceCallProvider>();
  private readonly handlers: CallManagerEventHandler[] = [];
  private readonly config: VoiceCallConfig;
  /** The store each call was last persisted to or read from: the manager's own changes to the call commit there. */
  private readonly durableStores = new Map<CallId, ITelephonyCallStore>();
  /** Bot speech recorded on such a call and not yet committed to its store, oldest first. */
  private readonly unsavedSpeech = new Map<CallId, TranscriptEntry[]>();
  /** The last of this manager's store transactions: they run one at a time, in the order requested. */
  private durableTail: Promise<void> = Promise.resolve();

  constructor(config: VoiceCallConfig) {
    this.config = config;
  }

  // ── Provider Management ──

  /**
   * Register a telephony provider.
   */
  registerProvider(provider: IVoiceCallProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Get a registered provider by name.
   */
  getProvider(name?: VoiceProviderName): IVoiceCallProvider | undefined {
    if (name) return this.providers.get(name);
    return this.providers.get(this.config.provider.provider);
  }

  // ── Event Handlers ──

  /**
   * Register a handler for call events.
   * @returns Unsubscribe function.
   */
  on(handler: CallManagerEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  private emit(event: CallManagerEvent): void {
    for (const handler of this.handlers) {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch((err) => {
            console.error('[CallManager] Event handler error:', err);
          });
        }
      } catch (err) {
        console.error('[CallManager] Event handler error:', err);
      }
    }
  }

  // ── Call Initiation ──

  /**
   * Initiate an outbound phone call.
   *
   * Creates a CallRecord in 'initiated' state, delegates to the provider
   * to place the call, and returns the internal call ID.
   */
  async initiateCall(params: {
    toNumber: string;
    fromNumber?: string;
    mode?: CallMode;
    message?: string;
    seedId?: string;
    providerName?: VoiceProviderName;
  }): Promise<CallRecord> {
    const provider = this.getProvider(params.providerName);
    if (!provider) {
      throw new Error(
        `No provider registered for "${params.providerName || this.config.provider.provider}"`,
      );
    }

    const callId = randomUUID();
    const fromNumber = params.fromNumber || this.getDefaultFromNumber();
    const mode = params.mode || this.config.defaultMode || 'conversation';

    const call: CallRecord = {
      callId,
      provider: provider.name,
      state: 'initiated',
      direction: 'outbound',
      mode,
      fromNumber,
      toNumber: params.toNumber,
      seedId: params.seedId,
      transcript: [],
      processedEventIds: [],
      createdAt: Date.now(),
    };

    this.activeCalls.set(callId, call);

    // Build webhook URLs
    const baseUrl = this.config.webhookBaseUrl || 'http://localhost:3000';
    const webhookUrl = `${baseUrl}/voice/webhook/${provider.name}`;
    const statusCallbackUrl = `${baseUrl}/voice/status/${provider.name}`;
    const mediaStreamUrl = this.config.streaming?.enabled
      ? `${baseUrl.replace('http', 'ws')}${this.config.streaming.wsPath || '/voice/media-stream'}`
      : undefined;

    const input: InitiateCallInput = {
      callId,
      fromNumber,
      toNumber: params.toNumber,
      mode,
      message: params.message,
      notifyVoice: this.config.tts?.voice,
      webhookUrl,
      statusCallbackUrl,
      mediaStreamUrl,
      mediaStreamToken: callId, // Use callId as token for validation
    };

    try {
      const result = await provider.initiateCall(input);

      if (!result.success) {
        this.transitionState(call, 'failed');
        call.errorMessage = result.error;
        this.emit({ type: 'call:error', callId, call, data: { error: result.error } });
        return call;
      }

      call.providerCallId = result.providerCallId;
      call.providerRequestId = result.providerRequestId;
      this.providerCallIdMap.set(result.providerCallId, callId);
      this.emit({ type: 'call:initiated', callId, call });
    } catch (err) {
      this.transitionState(call, 'error');
      call.errorMessage = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'call:error', callId, call, data: { error: call.errorMessage } });
    }

    return call;
  }

  // ── Call Control ──

  /**
   * Hang up a call. Transitions to 'hangup-bot' terminal state.
   *
   * A call persisted with {@link persistCall} or read by {@link processWebhookDurable} ends in its store: the
   * end, with any bot speech not yet committed, commits there before the carrier is asked to hang up, so the
   * completion callback the hangup causes, like any callback after the commit, finds the call ended and changes
   * nothing, whichever manager processes it. `call:ended` is emitted after the carrier request returns. The carrier
   * is asked even when that commit fails, and the promise then rejects with the commit's error. A call the store
   * already holds as ended keeps its stored outcome and emits nothing.
   */
  async hangupCall(callId: CallId): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call) return;
    if (TERMINAL_CALL_STATES.has(call.state)) return;

    const store = this.durableStores.get(callId);
    if (store) {
      await this.hangupDurable(call, store);
      return;
    }

    await this.requestCarrierHangup(call.provider, call.providerCallId);
    this.transitionState(call, 'hangup-bot');
    call.endedAt = Date.now();
    this.finalizeCall(call);
    this.emit({ type: 'call:ended', callId, call });
  }

  /**
   * Add a bot speech entry to the transcript and transition to speaking.
   *
   * On a call persisted with {@link persistCall} or read by {@link processWebhookDurable}, the entry and the speaking
   * state also commit to the call's store, after the manager's earlier store transactions; until one commits them,
   * every later transaction for the call carries them, so a callback does not drop them from the manager's record.
   * A failed commit is written to the console and left to the next transaction.
   */
  speakText(callId: CallId, text: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || TERMINAL_CALL_STATES.has(call.state)) return;

    const entry = this.addTranscriptEntry(call, 'bot', text);
    this.transitionState(call, 'speaking');
    const store = this.durableStores.get(callId);
    if (store) {
      this.unsavedSpeech.set(callId, [...(this.unsavedSpeech.get(callId) ?? []), entry]);
      void this.saveSpeech(call.provider, callId, store);
    }
    this.emit({ type: 'call:speaking', callId, call, data: { text } });
  }

  // ── Webhook Processing ──

  /**
   * Process an incoming webhook from a telephony provider.
   *
   * Verifies the signature, parses events, and applies state transitions.
   * Idempotent — duplicate event IDs are silently skipped.
   */
  processWebhook(providerName: VoiceProviderName, ctx: WebhookContext): void {
    const provider = this.providers.get(providerName);
    if (!provider) {
      console.warn(`[CallManager] Unknown provider: ${providerName}`);
      return;
    }

    // Verify webhook signature
    const verification = provider.verifyWebhook(ctx);
    if (!verification.valid) {
      console.warn(`[CallManager] Webhook verification failed: ${verification.error}`);
      return;
    }

    // Parse events
    const { events } = provider.parseWebhookEvent(ctx);

    for (const event of events) {
      this.processNormalizedEvent({ ...event, provider: providerName });
    }
  }

  /**
   * Process a single normalized call event.
   *
   * With `eventHandling: 'carrier'` the event is matched to a call by its
   * provider and call id (or its request id), bound to that call's carrier
   * identity and applied once per record: a state the call has passed emits
   * nothing, a call emits one terminal notification, and the record stays in
   * the manager. This repairs transitions in process and adds no restart
   * durability; see {@link processWebhookDurable}. Otherwise the original
   * handling below applies.
   */
  processNormalizedEvent(event: NormalizedCallEvent): void {
    if (this.config.eventHandling === 'carrier') {
      const call = [...this.activeCalls.values()].find((candidate) => (!event.provider || candidate.provider === event.provider) && (candidate.providerCallId === event.providerCallId || (event.providerRequestId !== undefined && candidate.providerRequestId === event.providerRequestId)));
      if (!call) return;
      this.bindCarrierIdentity(call, event);
      for (const notification of this.applyCarrierEvent(call, event)) this.emit(notification);
      return;
    }
    // Idempotency check
    if (this.processedEventIds.has(event.eventId)) return;
    this.processedEventIds.add(event.eventId);

    // Look up call by provider call ID
    const call = this.findCallByProviderCallId(event.providerCallId);
    if (!call) {
      // Could be an inbound call — create record if policy allows
      console.warn(
        `[CallManager] Event for unknown call: ${event.providerCallId} (kind: ${event.kind})`,
      );
      return;
    }

    call.processedEventIds.push(event.eventId);

    switch (event.kind) {
      case 'call-ringing':
        this.transitionState(call, 'ringing');
        this.emit({ type: 'call:ringing', callId: call.callId, call });
        break;

      case 'call-answered':
        this.transitionState(call, 'answered');
        this.emit({ type: 'call:answered', callId: call.callId, call });
        // Auto-transition to active then listening for conversation mode
        if (call.mode === 'conversation') {
          this.transitionState(call, 'active');
          this.emit({ type: 'call:active', callId: call.callId, call });
          this.transitionState(call, 'listening');
          this.emit({ type: 'call:listening', callId: call.callId, call });
        }
        break;

      case 'call-completed':
        this.transitionState(call, 'completed');
        call.endedAt = Date.now();
        this.finalizeCall(call);
        this.emit({ type: 'call:ended', callId: call.callId, call });
        break;

      case 'call-failed':
        this.transitionState(call, 'failed');
        call.errorMessage = event.reason;
        call.endedAt = Date.now();
        this.finalizeCall(call);
        this.emit({ type: 'call:error', callId: call.callId, call, data: { error: event.reason } });
        break;

      case 'call-busy':
        this.transitionState(call, 'busy');
        call.endedAt = Date.now();
        this.finalizeCall(call);
        this.emit({ type: 'call:ended', callId: call.callId, call });
        break;

      case 'call-no-answer':
        this.transitionState(call, 'no-answer');
        call.endedAt = Date.now();
        this.finalizeCall(call);
        this.emit({ type: 'call:ended', callId: call.callId, call });
        break;

      case 'call-voicemail':
        this.transitionState(call, 'voicemail');
        call.endedAt = Date.now();
        this.finalizeCall(call);
        this.emit({ type: 'call:ended', callId: call.callId, call });
        break;

      case 'call-hangup-user':
        this.transitionState(call, 'hangup-user');
        call.endedAt = Date.now();
        this.finalizeCall(call);
        this.emit({ type: 'call:ended', callId: call.callId, call });
        break;

      case 'call-error':
        this.transitionState(call, 'error');
        call.errorMessage = event.error;
        call.endedAt = Date.now();
        this.finalizeCall(call);
        this.emit({ type: 'call:error', callId: call.callId, call, data: { error: event.error } });
        break;

      case 'transcript':
        if (event.isFinal) {
          this.addTranscriptEntry(call, 'user', event.text);
          this.transitionState(call, 'listening');
        }
        this.emit({
          type: 'call:transcript',
          callId: call.callId,
          call,
          data: { text: event.text, isFinal: event.isFinal },
        });
        break;

      case 'speech-start':
        this.emit({ type: 'call:speech-start', callId: call.callId, call });
        break;

      case 'media-stream-connected':
        call.streamSid = event.streamSid;
        this.emit({
          type: 'media:connected',
          callId: call.callId,
          call,
          data: { streamSid: event.streamSid },
        });
        break;

      case 'call-dtmf':
        // DTMF key-presses are informational events -- they do NOT trigger a
        // state transition. The call remains in its current state (typically
        // 'listening' or 'active') because pressing a phone key is not a
        // lifecycle event. Higher-level logic (IVR menus, PIN entry, etc.)
        // subscribes to the 'call:dtmf' event to react to caller input.
        //
        // The `digit` field contains '0'-'9', '*', '#', or rarely 'A'-'D'.
        // The `durationMs` field is set only when the provider's message carries
        // one: Twilio's documented media-stream `dtmf` message does not, and
        // Telnyx and Plivo webhooks omit it.
        this.emit({
          type: 'call:dtmf',
          callId: call.callId,
          call,
          data: { digit: event.digit, durationMs: event.durationMs },
        });
        break;
    }
  }

  /** Checks an event against the record's carrier identity, binding a pending `request:` identity to its call leg once. */
  private bindCarrierIdentity(call: CallRecord, event: NormalizedCallEvent): void {
    if (event.provider && event.provider !== call.provider) throw new Error('carrier provider mismatch');
    if (event.providerRequestId !== undefined && call.providerRequestId !== event.providerRequestId) throw new Error('carrier request mismatch');
    if (call.providerCallId !== event.providerCallId) {
      if (!call.providerRequestId || !event.providerRequestId || call.providerCallId !== `request:${call.providerRequestId}`) throw new Error('carrier call identity conflict');
      call.providerCallId = event.providerCallId;
    }
  }
  /** Applies one stable event to the record and returns its notifications; a processed id or a terminal record yields none. */
  private applyCarrierEvent(call: CallRecord, event: NormalizedCallEvent): CallManagerEvent[] {
    if (call.processedEventIds.includes(event.eventId) || TERMINAL_CALL_STATES.has(call.state)) return [];
    if (call.processedEventIds.length >= 10000) throw new Error('carrier event retention bound');
    call.processedEventIds.push(event.eventId);
    const out: CallManagerEvent[] = [];
    const emit = (type: CallManagerEventType, data?: unknown): void => { out.push({ type, callId: call.callId, call: structuredClone(call), data }); };
    const move = (state: CallState, type: CallManagerEventType): boolean => { const old = call.state; this.transitionState(call, state); if (old === call.state) return false; emit(type); return true; };
    const end = (state: CallState, error?: string): void => { this.transitionState(call, state); call.endedAt = event.timestamp; if (error) call.errorMessage = error; emit(error ? 'call:error' : 'call:ended', error ? { error } : undefined); };
    switch (event.kind) {
      case 'call-ringing': move('ringing', 'call:ringing'); break;
      case 'call-answered':
        if (move('answered', 'call:answered') && call.mode === 'conversation') { move('active', 'call:active'); move('listening', 'call:listening'); }
        break;
      case 'call-completed': end('completed'); break;
      case 'call-failed': end('failed', event.reason ?? 'call failed'); break;
      case 'call-busy': end('busy'); break;
      case 'call-no-answer': end('no-answer'); break;
      case 'call-voicemail': end('voicemail'); break;
      case 'call-hangup-user': end('hangup-user'); break;
      case 'call-error': end('error', event.error); break;
      case 'transcript':
        if (event.isFinal) { call.transcript.push({ timestamp: event.timestamp, speaker: 'user', text: event.text, isFinal: true }); this.transitionState(call, 'listening'); }
        emit('call:transcript', { text: event.text, isFinal: event.isFinal }); break;
      case 'speech-start': emit('call:speech-start'); break;
      case 'media-stream-connected': call.streamSid = event.streamSid; emit('media:connected', { streamSid: event.streamSid }); break;
      case 'call-dtmf': emit('call:dtmf', { digit: event.digit, durationMs: event.durationMs }); break;
    }
    return out;
  }
  /** Inserts an admitted call once. A callback that races admission must be retried, never acknowledged. */
  async persistCall(callId: CallId, store: ITelephonyCallStore): Promise<CallRecord> {
    return this.durable(async () => {
      const local = this.activeCalls.get(callId);
      if (!local) throw new Error('unknown local call'); const snapshot = structuredClone(local);
      const saved = await store.withProvider(snapshot.provider, async (tx) => {
        const existing = await tx.get(callId); if (existing) return existing;
        await tx.put(snapshot); return snapshot;
      });
      this.refreshDurable(saved, store, []); return saved;
    });
  }
  /**
   * Verifies, binds and applies callbacks in the store transaction. State and dedupe commit together.
   * Unknown admission throws so the host returns a retryable response. Notifications happen only after
   * commit and are best-effort; financial/external effects must consume durable records, not handlers.
   * A call's bot speech not yet committed commits first, and the manager's record of each call becomes the
   * committed one with the speech recorded since on top; the manager's store transactions run one at a time.
   */
  async processWebhookDurable(providerName: VoiceProviderName, context: WebhookContext, store: ITelephonyCallStore): Promise<{ accepted: boolean; applied: number }> {
    const provider = this.providers.get(providerName);
    if (!provider || provider.webhookIdentity !== 'stable-v1') throw new Error('stable carrier provider required');
    if (!provider.verifyWebhook(context).valid) return { accepted: false, applied: 0 };
    const events = provider.parseWebhookEvent(context).events;
    return this.durable(async () => {
      const committed = await store.withProvider(providerName, async (tx) => {
        const notifications: CallManagerEvent[] = []; const calls = new Map<string, CallRecord>(); const speech = new Map<string, TranscriptEntry[]>(); let applied = 0;
        for (const event of events) {
          if (event.provider !== providerName || !event.eventId.startsWith(`${providerName}:v1:`)) throw new Error('unstable carrier event');
          const call = await tx.find(event.providerCallId) ?? (event.providerRequestId ? await tx.find(`request:${event.providerRequestId}`) : undefined);
          if (!call) throw new Error('unknown carrier call');
          if (!speech.has(call.callId)) speech.set(call.callId, this.applyUnsavedSpeech(call));
          this.bindCarrierIdentity(call, event);
          const changed = this.applyCarrierEvent(call, event); if (changed.length) applied += 1;
          await tx.put(call); calls.set(call.callId, call); notifications.push(...changed);
        }
        return { applied, notifications, calls: [...calls.values()], speech };
      });
      for (const call of committed.calls) this.refreshDurable(call, store, committed.speech.get(call.callId) ?? []);
      for (const event of committed.notifications) this.emit(event);
      return { accepted: true, applied: committed.applied };
    });
  }
  /** Runs `work` once this manager's earlier store transactions, and the refreshes after them, have finished. */
  private durable<T>(work: () => Promise<T>): Promise<T> {
    const run = this.durableTail.then(work);
    this.durableTail = run.then(() => undefined, () => undefined);
    return run;
  }
  /** Adds the call's unsaved bot speech to a stored record that has not ended, and returns the entries it took. */
  private applyUnsavedSpeech(call: CallRecord): TranscriptEntry[] {
    const speech = [...(this.unsavedSpeech.get(call.callId) ?? [])];
    if (!TERMINAL_CALL_STATES.has(call.state)) for (const entry of speech) { call.transcript.push(structuredClone(entry)); this.transitionState(call, 'speaking'); }
    return speech;
  }
  /**
   * Makes a committed record the manager's record of the call: the speech the commit took leaves the unsaved list,
   * and speech recorded since stays on top until a later transaction commits it. An ended call keeps none.
   */
  private refreshDurable(call: CallRecord, store: ITelephonyCallStore, committed: TranscriptEntry[]): void {
    const unsaved = TERMINAL_CALL_STATES.has(call.state) ? [] : (this.unsavedSpeech.get(call.callId) ?? []).filter((entry) => !committed.includes(entry));
    if (unsaved.length) this.unsavedSpeech.set(call.callId, unsaved); else this.unsavedSpeech.delete(call.callId);
    const local = structuredClone(call);
    for (const entry of unsaved) { local.transcript.push(structuredClone(entry)); this.transitionState(local, 'speaking'); }
    this.activeCalls.set(call.callId, local); this.durableStores.set(call.callId, store);
    if (local.providerCallId) this.providerCallIdMap.set(local.providerCallId, local.callId);
  }
  /** Commits the call's unsaved bot speech after the manager's earlier store transactions; a failure leaves it unsaved. */
  private async saveSpeech(provider: VoiceProviderName, callId: CallId, store: ITelephonyCallStore): Promise<void> {
    try {
      await this.durable(async () => {
        if (!this.unsavedSpeech.get(callId)?.length) return;
        const committed = await store.withProvider(provider, async (tx) => {
          const stored = await tx.get(callId);
          if (!stored) throw new Error('unknown durable call');
          const speech = this.applyUnsavedSpeech(stored); await tx.put(stored); return { stored, speech };
        });
        this.refreshDurable(committed.stored, store, committed.speech);
      });
    } catch (err) {
      console.error('[CallManager] Saving bot speech failed:', err);
    }
  }
  /**
   * Ends a call held in a store. The end commits first, behind the manager's earlier store transactions, so the
   * completion callback the carrier sends for the hangup finds the call ended. The carrier is asked next, outside the
   * store queue and also when the commit failed, and `call:ended` follows the request. Rejects with the commit's error.
   */
  private async hangupDurable(call: CallRecord, store: ITelephonyCallStore): Promise<void> {
    const committed = await this.durable(async () => {
      const result = await store.withProvider(call.provider, async (tx) => {
        const stored = await tx.get(call.callId);
        if (!stored) throw new Error('unknown durable call');
        const speech = this.applyUnsavedSpeech(stored); const ended = !TERMINAL_CALL_STATES.has(stored.state);
        if (ended) { this.transitionState(stored, 'hangup-bot'); stored.endedAt = Date.now(); }
        await tx.put(stored); return { stored, speech, ended };
      });
      this.refreshDurable(result.stored, store, result.speech);
      return result;
    }).catch(async (error: unknown) => {
      await this.requestCarrierHangup(call.provider, call.providerCallId);
      throw error;
    });
    await this.requestCarrierHangup(call.provider, committed.stored.providerCallId);
    if (committed.ended) this.emit({ type: 'call:ended', callId: call.callId, call: structuredClone(committed.stored) });
  }
  /** Asks the call's carrier to hang up. A failed request is written to the console; the call ends here regardless. */
  private async requestCarrierHangup(providerName: VoiceProviderName, providerCallId: string | undefined): Promise<void> {
    const provider = this.getProvider(providerName);
    if (!provider || !providerCallId) return;
    try {
      await provider.hangupCall({ providerCallId });
    } catch (err) {
      console.error('[CallManager] Hangup failed:', err);
    }
  }

  // ── Query ──

  /** Get a call by internal ID. */
  getCall(callId: CallId): CallRecord | undefined {
    return this.activeCalls.get(callId);
  }

  /** Find a call by provider-assigned call ID. */
  findCallByProviderCallId(providerCallId: string): CallRecord | undefined {
    const callId = this.providerCallIdMap.get(providerCallId);
    if (callId) return this.activeCalls.get(callId);

    // Fallback linear search for edge cases
    for (const call of this.activeCalls.values()) {
      if (call.providerCallId === providerCallId) return call;
    }
    return undefined;
  }

  /** Get all active (non-terminal) calls. */
  getActiveCalls(): CallRecord[] {
    return Array.from(this.activeCalls.values());
  }

  // ── Inbound Call Handling ──

  /**
   * Handle an inbound call based on the configured policy.
   * Creates a CallRecord if the call is accepted.
   */
  handleInboundCall(params: {
    providerCallId: string;
    provider: VoiceProviderName;
    fromNumber: string;
    toNumber: string;
    seedId?: string;
  }): CallRecord | null {
    const policy = this.config.inboundPolicy || 'disabled';

    if (policy === 'disabled') return null;

    if (policy === 'allowlist') {
      const allowed = this.config.allowedNumbers || [];
      if (!allowed.includes(params.fromNumber)) return null;
    }

    const callId = randomUUID();
    const call: CallRecord = {
      callId,
      providerCallId: params.providerCallId,
      provider: params.provider,
      state: 'ringing',
      direction: 'inbound',
      mode: 'conversation',
      fromNumber: params.fromNumber,
      toNumber: params.toNumber,
      seedId: params.seedId,
      transcript: [],
      processedEventIds: [],
      createdAt: Date.now(),
    };

    this.activeCalls.set(callId, call);
    this.providerCallIdMap.set(params.providerCallId, callId);
    this.emit({ type: 'call:ringing', callId, call });

    return call;
  }

  // ── State Machine ──

  /**
   * Transition call state with monotonic enforcement.
   *
   * Rules:
   * 1. No-op for same state or already terminal.
   * 2. Terminal states can always be reached from non-terminal.
   * 3. Speaking ↔ Listening can cycle (conversation turns).
   * 4. Otherwise, only forward transitions in STATE_ORDER.
   */
  private transitionState(call: CallRecord, newState: CallState): void {
    // No-op for same state or already terminal
    if (call.state === newState || TERMINAL_CALL_STATES.has(call.state)) return;

    // Terminal states can always be reached
    if (TERMINAL_CALL_STATES.has(newState)) {
      call.state = newState;
      return;
    }

    // Allow cycling between speaking and listening
    if (CONVERSATION_STATES.has(call.state) && CONVERSATION_STATES.has(newState)) {
      call.state = newState;
      return;
    }

    // Only allow forward transitions
    const currentIndex = STATE_ORDER.indexOf(call.state);
    const newIndex = STATE_ORDER.indexOf(newState);
    if (newIndex > currentIndex) {
      call.state = newState;
    }
  }

  /** Add a transcript entry and return it. */
  private addTranscriptEntry(call: CallRecord, speaker: 'bot' | 'user', text: string): TranscriptEntry {
    const entry: TranscriptEntry = {
      timestamp: Date.now(),
      speaker,
      text,
      isFinal: true,
    };
    call.transcript.push(entry);
    return entry;
  }

  /** Move a call from active tracking after terminal state. */
  private finalizeCall(call: CallRecord): void {
    // Keep in activeCalls briefly for status queries, then clean up
    // In production, this would persist to DB and then remove
    if (call.providerCallId) {
      this.providerCallIdMap.delete(call.providerCallId);
    }
    for (const eventId of call.processedEventIds) {
      this.processedEventIds.delete(eventId);
    }
    // Remove from active calls after a brief delay for status queries
    setTimeout(() => {
      this.activeCalls.delete(call.callId);
    }, 30_000);
  }

  /** Get the default "from" number from config. */
  private getDefaultFromNumber(): string {
    const prov = this.config.provider;
    if (prov.provider === 'mock') return '';
    return prov.config.fromNumber || '';
  }

  /** Clean up all state (for shutdown). */
  dispose(): void {
    this.activeCalls.clear();
    this.providerCallIdMap.clear();
    this.processedEventIds.clear();
    this.providers.clear();
    this.handlers.length = 0;
    this.durableStores.clear();
    this.unsavedSpeech.clear();
  }
}

// ============================================================================
// Host manager binding
// ============================================================================

/** Minimal typed tool target shared by carrier packs and a host-owned manager. */
export interface VoiceCallToolHandler {
  /** Starts a call through the binding's provider. */
  initiateCall(toNumber: string, message?: string, mode?: CallMode): Promise<CallRecord>;
  /** Adds the bot's text to the manager's conversation; media synthesis remains host wiring. */
  speakText(callId: string, text: string): void;
  /** Hangs up the selected call. */
  hangupCall(callId: string): Promise<void>;
  /** Returns the host manager's current record. */
  getCallStatus(callId: string): CallRecord | undefined;
  /** Returns the host manager's retained records. */
  getActiveCalls(): CallRecord[];
}
/** Public carrier binding; tools and webhook hosts share the actual manager instance. */
export interface VoiceProviderBinding {
  /** The provider registered on the selected manager. */
  readonly provider: IVoiceCallProvider;
  /** The current host-owned manager. */
  readonly manager: CallManager;
  /** Stable proxy object whose operations use the current manager. */
  readonly toolHandler: VoiceCallToolHandler;
  /** Explicitly rebinds tools; the caller disposes the old manager when it owns its lifetime. */
  setManager(manager: CallManager): void;
}
/** Registers the provider and exposes a replaceable manager binding without a private hidden instance. */
export function bindVoiceProvider(provider: IVoiceCallProvider, initial: CallManager): VoiceProviderBinding {
  let manager = initial; manager.registerProvider(provider);
  const toolHandler: VoiceCallToolHandler = {
    initiateCall: (toNumber, message, mode) => manager.initiateCall({ toNumber, message, mode, providerName: provider.name }),
    speakText: (id, text) => manager.speakText(id, text), hangupCall: (id) => manager.hangupCall(id),
    getCallStatus: (id) => manager.getCall(id), getActiveCalls: () => manager.getActiveCalls(),
  };
  return { provider, get manager() { return manager; }, toolHandler, setManager: (next) => { next.registerProvider(provider); manager = next; } };
}
