import type {
  VoiceCall, VoiceCallLimits, CallTransport, CallEvent, UsageRecord,
  InitiatingPrincipal, CallControlCredential, StopReceipt, CallEndedPayload,
} from '../contracts/index.js';

/** Safe store conflict; row contents and credentials never appear in the message. */
export class VoiceStoreConflict extends Error {
  constructor() { super('voice store conflict'); this.name = 'VoiceStoreConflict'; }
}
/** Epoch milliseconds, generations and counters must stay exactly representable. */
export function voiceInteger(value: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError('invalid voice integer');
  return value;
}
/** Stable tuple key without delimiter collisions. Values are internal identifiers, never bearer secrets. */
export function voiceKey(...parts: string[]): string { return JSON.stringify(parts); }
/** A persisted row version is separate from the v1 wire schema's version. */
export interface VoiceRow<T> { scopeId: string; id: string; version: number; value: T }
/** Durable controller work; expiry requests fencing, never automatic takeover. */
export interface CallAction { id: string; kind: 'prepare' | 'cleanup'; expiresAt: number }
/** Evidence from the host's authoritative worker, media and inference fences. */
export interface CallFenceEvidence {
  workerGeneration: number; workerStopped: boolean; mediaClosed: boolean;
  inferenceStopped: boolean; evidenceRef: string;
}
/** Completed transcript drain. Delivery content lives in an immutable protected object, never in metadata. */
export interface CallTranscriptDrain {
  transcript: Exclude<CallEndedPayload['transcript'], { availability: 'delivery' }>;
  deliveryRef?: string;
}
/** Internal recovery state. No transcript or provider secret belongs in this row. */
export interface StoredVoiceCall {
  transcriptDrain?: CallTranscriptDrain;
  call: VoiceCall;
  limits: VoiceCallLimits;
  clientOrigin: string;
  proofKeyThumbprint: string;
  transport: CallTransport;
  participantId: string;
  reservationRef: string | null;
  preparationStep: number;
  cleanupStep: number;
  action: CallAction | null;
  contentFenced: boolean;
  credentialGeneration: number;
  nextTransportEpoch: number;
  reportSequence: number;
  reportHash: string | null;
  acknowledgedAt: number;
  leaseExpiresAt: number | null;
  disconnectedAt: number | null;
  lastUserSpeechAt: number | null;
  completedTurns: number;
  endingAt: number | null;
  terminalFailed: boolean;
  fence: CallFenceEvidence | null;
}
/** Scoped operation identity. Recoverable bearer results are sealed, never stored here in clear. */
export interface VoiceIdempotency {
  requestHash: string; callId: string;
  result: string | StopReceipt | null;
}
/** Server bindings shared by grant, media and control credentials. */
export interface CredentialBinding {
  callId: string; agentId: string; agentRevision: number; principal: InitiatingPrincipal;
  origin: string; thumbprint: string; transport: CallTransport; participantId: string;
  generation: number; workerGeneration: number; transportEpoch: number;
}
/** Hashed bearer row. A consumed grant retains its sealed exact result only through recoveryUntil. */
export interface VoiceCredential {
  kind: 'grant' | 'media' | 'control'; secretHash: string; binding: CredentialBinding;
  expiresAt: number; revoked: boolean; consumed: boolean;
  exchangeKey: string | null; requestHash: string | null;
  sealedResult: string | null; recoveryUntil: number | null;
}
/** One slot occupies one scope and one host. Released rows preserve their generation forever. */
export interface VoiceSlotLease {
  callId: string; hostId: string; holder: string; generation: number;
  expiresAt: number; released: boolean;
}
/** Fixed table/value mapping; public API envelopes remain the canonical schemas. */
export interface VoiceTableValues {
  calls: StoredVoiceCall;
  usage: UsageRecord;
  events: CallEvent;
  idempotency: VoiceIdempotency;
  credentials: VoiceCredential;
  slots: VoiceSlotLease;
}
/** Domain table name; lock tables are private adapter machinery. */
export type VoiceTable = keyof VoiceTableValues;
/** One scope's transaction. Methods fail after the callback finishes. */
export interface VoiceTransaction {
  readonly scopeId: string;
  get<K extends VoiceTable>(table: K, id: string): Promise<VoiceRow<VoiceTableValues[K]> | undefined>;
  list<K extends VoiceTable>(table: K): Promise<Array<VoiceRow<VoiceTableValues[K]>>>;
  /** Expected 0 inserts; otherwise increments exactly the matched version. */
  put<K extends VoiceTable>(table: K, id: string, value: VoiceTableValues[K], expectedVersion: number): Promise<void>;
  /** Locks one host after the scope, returns that host's leases across scopes. Never call twice for different hosts. */
  lockHost(hostId: string): Promise<Array<VoiceRow<VoiceSlotLease>>>;
}
/** Transaction callbacks contain storage work alone, never external effects or nested transactions. */
export interface VoiceStore {
  withTransaction<T>(scopeId: string, fn: (tx: VoiceTransaction) => Promise<T>): Promise<T>;
}
/** Safe narrow renewal response is included here only for adapters composing typed results. */
export type VoiceControlResult = CallControlCredential;
