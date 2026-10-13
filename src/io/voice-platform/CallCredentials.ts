import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { mintWorkerToken, hashWorkerToken, workerTokenMatches } from '../channels/meetings/signing.js';
import { sealSecret, openSecret, type SealingKey } from '../../core/llm/auth/sealing.js';
import {
  BrowserProofSchema, CallGrantSchema, CallControlCredentialSchema, ConnectWebCallSchema, StopCallSchema, StopReceiptSchema,
  RenewCallControlSchema, WebCallConnectionSchema,
  type BrowserProof, type CallGrant, type CallControlCredential, type ConnectWebCall, type StopCall, type StopReceipt, type RenewCallControl, type WebCallConnection,
} from './contracts/index.js';
import { canonicalVoiceHash, requestCallEndInTransaction } from './VoiceCallManager.js';
import { voiceInteger, voiceKey, type CredentialBinding, type StoredVoiceCall, type VoiceCredential, type VoiceRow, type VoiceStore, type VoiceTransaction } from './stores/types.js';

/** Explicit operation names make proofs unusable on another route. */
export type CallProofOperation = 'connect' | 'stop' | 'renew_control';
/** The exact public data signed by a browser. No bearer secret is part of the signed payload. */
export interface CallProofInput {
  operation: CallProofOperation; callId: string; credentialId: string; origin: string;
  operationKey: string; requestHash: string; issuedAt: number; nonce: string;
}
/** UTF-8 JSON tuple signed with ECDSA P-256/SHA-256, in IEEE P1363 format. */
export function callProofPayload(i: CallProofInput): string {
  return JSON.stringify(['agentos.voice.proof.v1', i.operation, i.callId, i.credentialId, i.origin, i.operationKey, i.requestHash, i.issuedAt, i.nonce]);
}
/** Canonical exchange digest, excluding the rotating proof timestamp and signature. */
export function exchangeRequestHash(callId: string, grantId: string, exchangeKey: string, origin: string): string {
  return canonicalVoiceHash(['agentos.voice.exchange.v1', callId, grantId, exchangeKey, origin]);
}
/** Canonical digest for one stop or control-renewal operation. */
export function controlRequestHash(operation: 'stop' | 'renew_control', callId: string, credentialId: string, operationKey: string, origin: string): string {
  return canonicalVoiceHash(['agentos.voice.control.v1', operation, callId, credentialId, operationKey, origin]);
}
function canonicalBytes(value: string, size: number): Buffer {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== size || bytes.toString('base64url') !== value) throw new Error('proof refused');
  return bytes;
}
/** RFC 7638 public P-256 thumbprint; rejects private material through the canonical closed schema. */
export function proofKeyThumbprint(publicKey: BrowserProof['publicKey']): string {
  const key = BrowserProofSchema.shape.publicKey.parse(publicKey);
  canonicalBytes(key.x, 32); canonicalBytes(key.y, 32);
  return createHash('sha256').update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y })).digest('base64url');
}
/** Verifies a proof's key binding, canonical encoding, timestamp and operation-specific signature. */
export function verifyCallProof(proof: BrowserProof, expectedThumbprint: string, input: Omit<CallProofInput, 'issuedAt' | 'nonce'>, now: number, windowMs: number): void {
  try {
    const p = BrowserProofSchema.parse(proof); voiceInteger(now); voiceInteger(windowMs, 1);
    if (proofKeyThumbprint(p.publicKey) !== expectedThumbprint || Math.abs(now - p.issuedAt) > windowMs) throw new Error('proof refused');
    const signature = canonicalBytes(p.signature, 64);
    const key = createPublicKey({ key: p.publicKey, format: 'jwk' });
    if (!verify('sha256', Buffer.from(callProofPayload({ ...input, issuedAt: p.issuedAt, nonce: p.nonce })), { key, dsaEncoding: 'ieee-p1363' }, signature)) throw new Error('proof refused');
  } catch { throw new Error('proof refused'); }
}
/** Credential dependencies. authorize rechecks current principal/workspace policy on every operation, including retry. */
export interface CallCredentialsOptions {
  store: VoiceStore; now: () => number; ttlMs: number; proofWindowMs: number;
  key: SealingKey; previousKeys?: readonly SealingKey[];
  authorize(tx: VoiceTransaction, state: StoredVoiceCall): Promise<void>;
  /** Pure synchronous signing for the bound existing room/participant; must preserve the exact expiry. */
  issueMedia(binding: CredentialBinding, opaqueToken: string, expiresAt: number): { url: string; token: string };
}
function bearerId(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[a-f0-9-]{36}$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) throw new Error('credential refused');
  return parts[0]!;
}
function active(s: StoredVoiceCall): boolean { return ['connecting', 'connected', 'reconnecting'].includes(s.call.state) && s.preparationStep === 3; }
function credential(kind: VoiceCredential['kind'], token: string, binding: CredentialBinding, expiresAt: number): VoiceCredential {
  return { kind, secretHash: hashWorkerToken(token), binding, expiresAt, revoked: false, consumed: false, exchangeKey: null, requestHash: null, sealedResult: null, recoveryUntil: null };
}
/** Recoverable, scoped call credentials using the library's existing hashing and at-rest sealing primitives. */
export class CallCredentials {
  private readonly keys: SealingKey[];
  constructor(private readonly options: CallCredentialsOptions) {
    voiceInteger(options.ttlMs, 1); voiceInteger(options.proofWindowMs, 1);
    this.keys = [options.key, ...(options.previousKeys ?? [])].map((k) => {
      if (k.key.length !== 32 || !/^[A-Za-z0-9_-]{1,32}$/.test(k.id)) throw new Error('invalid sealing key');
      return { id: k.id, key: Uint8Array.from(k.key) };
    });
    if (new Set(this.keys.map((k) => k.id)).size !== this.keys.length) throw new Error('duplicate sealing key id');
  }
  private seal(value: unknown, context: string): string { const key = this.keys[0]!; return sealSecret(JSON.stringify(value), key.key, key.id, context); }
  private open(value: string, context: string): unknown { return JSON.parse(Buffer.from(openSecret(value, this.keys, context)).toString('utf8')); }
  private async state(tx: VoiceTransaction, callId: string): Promise<VoiceRow<StoredVoiceCall>> {
    const row = await tx.get('calls', callId); if (!row) throw new Error('credential refused');
    await this.options.authorize(tx, row.value); return row;
  }
  private async read(tx: VoiceTransaction, callId: string, token: string, kind: VoiceCredential['kind'], origin: string): Promise<VoiceRow<VoiceCredential>> {
    const id = kind === 'media' ? hashWorkerToken(token) : bearerId(token);
    const row = await tx.get('credentials', id);
    if (!row || row.value.kind !== kind || row.value.binding.callId !== callId || row.value.binding.origin !== origin || row.value.revoked || row.value.expiresAt <= this.options.now() || !workerTokenMatches(token, row.value.secretHash)) throw new Error('credential refused');
    return row;
  }
  private binding(s: StoredVoiceCall, epoch: number): CredentialBinding {
    return { callId: s.call.callId, agentId: s.call.agentId, agentRevision: s.call.agentRevision, principal: s.call.initiatingPrincipal,
      origin: s.clientOrigin, thumbprint: s.proofKeyThumbprint, transport: s.transport, participantId: s.participantId,
      generation: s.credentialGeneration, workerGeneration: s.call.workerGeneration, transportEpoch: epoch };
  }
  private admitting(s: StoredVoiceCall): void {
    const now = voiceInteger(this.options.now());
    if (!active(s) || (s.call.startedAt === null && now >= s.call.createdAt + s.limits.setupTimeoutMs) || (s.call.startedAt !== null && now >= s.call.startedAt + s.limits.maxDurationSeconds * 1000) || (s.disconnectedAt !== null && now >= s.disconnectedAt + s.limits.reconnectGraceMs) || (s.leaseExpiresAt !== null && now >= s.leaseExpiresAt)) throw new Error('credential refused');
  }
  private current(s: StoredVoiceCall, c: VoiceCredential): void {
    if (!active(s) || c.binding.generation !== s.credentialGeneration || c.binding.workerGeneration !== s.call.workerGeneration || c.binding.agentRevision !== s.call.agentRevision || c.binding.thumbprint !== s.proofKeyThumbprint || c.binding.participantId !== s.participantId || canonicalVoiceHash(c.binding.principal) !== canonicalVoiceHash(s.call.initiatingPrincipal)) throw new Error('credential refused');
  }
  private async proof(tx: VoiceTransaction, row: VoiceRow<VoiceCredential>, proof: BrowserProof, operation: CallProofOperation, operationKey: string, requestHash: string): Promise<void> {
    const b = row.value.binding;
    verifyCallProof(proof, b.thumbprint, { operation, callId: b.callId, credentialId: row.id, origin: b.origin, operationKey, requestHash }, this.options.now(), this.options.proofWindowMs);
    const key = voiceKey('proof', row.id, proof.nonce);
    const identity = canonicalVoiceHash([operation, operationKey, requestHash]);
    const old = await tx.get('idempotency', key);
    if (old && old.value.requestHash !== identity) throw new Error('proof replay');
    if (!old) await tx.put('idempotency', key, { requestHash: identity, callId: b.callId, result: null }, 0);
  }
  /** Reauthorization issues a grant for the same prepared call; no reservation or dispatch is performed. */
  async issueGrant(scopeId: string, callId: string, operationKey: string): Promise<CallGrant> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationKey)) throw new Error('invalid operation key');
    return this.options.store.withTransaction(scopeId, async (tx) => {
      const row = await this.state(tx, callId); const s = row.value;
      this.admitting(s);
      const key = voiceKey('grant', callId, operationKey); const context = voiceKey(scopeId, key);
      const hash = canonicalVoiceHash(this.binding(s, 0)); const previous = await tx.get('idempotency', key);
      if (previous) {
        if (previous.value.requestHash !== hash || typeof previous.value.result !== 'string') throw new Error('grant conflict');
        const result = CallGrantSchema.parse(this.open(previous.value.result, context));
        const saved = await tx.get('credentials', result.grantId);
        if (result.expiresAt <= this.options.now() || !saved || saved.value.revoked) throw new Error('credential refused');
        return result;
      }
      for (const old of await tx.list('credentials')) if (old.value.binding.callId === callId && old.value.kind !== 'control' && !old.value.revoked) {
        await tx.put('credentials', old.id, { ...old.value, revoked: true }, old.version);
      }
      const grantId = randomUUID(); const token = `${grantId}.${mintWorkerToken()}`; const expiresAt = voiceInteger(this.options.now() + this.options.ttlMs);
      const grant = CallGrantSchema.parse({ kind: 'call_grant', grantId, callId, agentId: s.call.agentId, agentRevision: s.call.agentRevision, transport: s.transport, token, expiresAt });
      await tx.put('credentials', grantId, credential('grant', token, this.binding(s, 0), expiresAt), 0);
      await tx.put('idempotency', key, { requestHash: hash, callId, result: this.seal(grant, context) }, 0);
      return grant;
    });
  }
  /** Atomically consumes a grant and stores the exact sealed exchange result for matching authenticated retries. */
  async exchange(scopeId: string, callId: string, token: string, origin: string, input: ConnectWebCall): Promise<WebCallConnection> {
    const request = ConnectWebCallSchema.parse(input);
    return this.options.store.withTransaction(scopeId, async (tx) => {
      const call = await this.state(tx, callId); const grant = await this.read(tx, callId, token, 'grant', origin); this.current(call.value, grant.value); this.admitting(call.value);
      const hash = exchangeRequestHash(callId, grant.id, request.exchangeKey, origin);
      if (hash !== request.requestHash) throw new Error('request hash mismatch');
      await this.proof(tx, grant, request.proof, 'connect', request.exchangeKey, hash);
      const context = voiceKey(scopeId, grant.id, request.exchangeKey, hash);
      if (grant.value.consumed) {
        if (grant.value.exchangeKey !== request.exchangeKey || grant.value.requestHash !== hash) throw new Error('exchange conflict');
        if (!grant.value.sealedResult || (grant.value.recoveryUntil ?? 0) <= this.options.now()) throw new Error('recovery expired');
        return WebCallConnectionSchema.parse(this.open(grant.value.sealedResult, context));
      }
      const s = call.value; const epoch = voiceInteger(s.nextTransportEpoch + 1, 1); const binding = this.binding(s, epoch);
      const expiresAt = Math.min(grant.value.expiresAt, voiceInteger(this.options.now() + this.options.ttlMs));
      const media = this.options.issueMedia(binding, `${randomUUID()}.${mintWorkerToken()}`, expiresAt);
      const controlId = randomUUID(); const controlToken = `${controlId}.${mintWorkerToken()}`;
      const result = WebCallConnectionSchema.parse({ transport: s.transport, url: media.url, token: media.token, callId, expiresAt, transportEpoch: epoch,
        controlCredential: { kind: 'call_control', token: controlToken, expiresAt, operations: ['stop', 'renew_control'] } });
      await tx.put('credentials', hashWorkerToken(media.token), credential('media', media.token, binding, expiresAt), 0);
      await tx.put('credentials', controlId, credential('control', controlToken, binding, expiresAt), 0);
      await tx.put('credentials', grant.id, { ...grant.value, consumed: true, exchangeKey: request.exchangeKey, requestHash: hash, sealedResult: this.seal(result, context), recoveryUntil: expiresAt }, grant.version);
      s.nextTransportEpoch = epoch; await tx.put('calls', callId, s, call.version);
      return result;
    });
  }
  /** One-use admission for the first WebSocket frame or an authenticated host media admission callback. */
  async consumeMedia(scopeId: string, callId: string, token: string, origin: string, transportEpoch: number): Promise<CredentialBinding> {
    return this.options.store.withTransaction(scopeId, async (tx) => {
      const call = await this.state(tx, callId); const media = await this.read(tx, callId, token, 'media', origin); this.current(call.value, media.value); this.admitting(call.value);
      if (media.value.consumed || media.value.binding.transportEpoch !== transportEpoch || transportEpoch !== call.value.nextTransportEpoch || transportEpoch <= call.value.call.transportEpoch) throw new Error('credential refused');
      await tx.put('credentials', media.id, { ...media.value, consumed: true }, media.version); return media.value.binding;
    });
  }
  /** Stops with narrow proof-bound authority after media has closed; the receipt and end intent commit together. */
  async stop(scopeId: string, callId: string, token: string, origin: string, input: StopCall): Promise<StopReceipt> {
    const request = StopCallSchema.parse(input); if (!request.proof) throw new Error('proof refused');
    const proof = request.proof;
    return this.options.store.withTransaction(scopeId, async (tx) => {
      const call = await this.state(tx, callId); const control = await this.read(tx, callId, token, 'control', origin);
      if (control.value.consumed) throw new Error('credential refused');
      const hash = controlRequestHash('stop', callId, control.id, request.idempotencyKey, origin);
      await this.proof(tx, control, proof, 'stop', request.idempotencyKey, hash);
      const key = voiceKey('stop', callId, control.id, request.idempotencyKey); const old = await tx.get('idempotency', key);
      if (old) {
        if (old.value.requestHash !== hash || call.value.credentialGeneration !== control.value.binding.generation + 1) throw new Error('stop conflict');
        return StopReceiptSchema.parse(old.value.result);
      }
      this.current(call.value, control.value);
      await requestCallEndInTransaction(tx, callId, 'client_stop', this.options.now());
      const receipt = StopReceiptSchema.parse({ callId, stopId: request.idempotencyKey, state: 'ending' });
      await tx.put('idempotency', key, { requestHash: hash, callId, result: receipt }, 0);
      return receipt;
    });
  }
  /** Consumes current control authority for one exact recoverable replacement, never for new media. */
  async renewControl(scopeId: string, callId: string, token: string, origin: string, input: RenewCallControl): Promise<CallControlCredential> {
    const request = RenewCallControlSchema.parse(input);
    return this.options.store.withTransaction(scopeId, async (tx) => {
      const call = await this.state(tx, callId); const old = await this.read(tx, callId, token, 'control', origin); this.current(call.value, old.value); this.admitting(call.value);
      const hash = controlRequestHash('renew_control', callId, old.id, request.idempotencyKey, origin);
      await this.proof(tx, old, request.proof, 'renew_control', request.idempotencyKey, hash);
      const context = voiceKey(scopeId, old.id, request.idempotencyKey, hash);
      if (old.value.consumed) {
        if (old.value.exchangeKey !== request.idempotencyKey || old.value.requestHash !== hash || !old.value.sealedResult || (old.value.recoveryUntil ?? 0) <= this.options.now()) throw new Error('renewal conflict');
        return CallControlCredentialSchema.parse(this.open(old.value.sealedResult, context));
      }
      const id = randomUUID(); const replacement = `${id}.${mintWorkerToken()}`; const expiresAt = voiceInteger(this.options.now() + this.options.ttlMs);
      const result = CallControlCredentialSchema.parse({ kind: 'call_control', token: replacement, expiresAt, operations: ['stop', 'renew_control'] });
      await tx.put('credentials', id, credential('control', replacement, old.value.binding, expiresAt), 0);
      await tx.put('credentials', old.id, { ...old.value, consumed: true, exchangeKey: request.idempotencyKey, requestHash: hash, sealedResult: this.seal(result, context), recoveryUntil: Math.min(old.value.expiresAt, expiresAt) }, old.version);
      return result;
    });
  }
  /** Immediate durable revocation plus an independent server-side stop intent. */
  async revokeCall(scopeId: string, callId: string): Promise<void> {
    await this.options.store.withTransaction(scopeId, async (tx) => {
      const call = await tx.get('calls', callId); if (!call) return;
      for (const row of await tx.list('credentials')) if (row.value.binding.callId === callId && !row.value.revoked) await tx.put('credentials', row.id, { ...row.value, revoked: true, sealedResult: null }, row.version);
      call.value.credentialGeneration = voiceInteger(call.value.credentialGeneration + 1, 1);
      await tx.put('calls', callId, call.value, call.version);
      await requestCallEndInTransaction(tx, callId, 'key_revoked', this.options.now());
    });
  }
  /** Redacts all keys, callbacks, adapters and clock configuration. */
  toJSON(): string { return '[CallCredentials]'; }
}
