import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DemoIntent, DemoOperation, DemoPolicy, DemoRow, IDemoRunStore } from './stores/demo.js';

const OPERATIONS = new Set<DemoOperation>(['read-status', 'read-events', 'read-usage', 'stop', 'purge']);
const opaque = (): string => randomBytes(32).toString('base64url');
const digest = (kind: string, value: string): string => createHash('sha256').update(kind).update('\0').update(value).digest('hex');
const refused = (): never => { throw new Error('demo authority refused'); };
const identifier = (value: string): string => { if (!value || value.length > 512) return refused(); return value; };
const secret = (value: string): string => { if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return refused(); return value; };

/** Credential returned once per binding or trusted recovery rotation. */
export interface DemoCredential {
  token: string;
  generation: number;
  expiresAt: number;
}
/** Host-authenticated visitor input; issuer, audience and run must match the stored binding. */
export interface DemoAuth extends DemoCredential {
  visitor: string;
  issuer: string;
  audience: string;
  runId: string;
}
/** The only content-free response a repeated destructive request can return. */
export interface DemoReceipt {
  accepted: true;
  action: 'stop' | 'purge';
  generation: number;
}
/** The scope/run pair a read may access, always derived from the durable row. */
export interface DemoReadBinding {
  scopeRef: string;
  runId: string;
  generation: number;
}
/** Server dependencies. Cleanup must be idempotent and positively acknowledge worker and content fencing. */
export interface DemoCapabilityOptions {
  store: IDemoRunStore;
  policy: DemoPolicy;
  issuer: string;
  audience: string;
  scopeRef: string;
  now(): number;
  /**
   * Resolves pending creation by operationId, prevents any subsequent dispatch, stops the worker,
   * fences delayed events and, for purge, revokes content and completes deletion. Return only after
   * those effects are acknowledged. Serialize with prepared creation using the host's owner lock.
   */
  cleanup(input: { operationId: string; runId?: string; action: 'stop' | 'purge'; generation: number }): Promise<{ connectedSeconds: number }>;
}
/** One-run authority under an immutable host policy; never a paid credential or dispatch entitlement. */
export class DemoRunCapability {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly scopeRef: string;
  private readonly policy: Readonly<DemoPolicy>;
  /** Captures server authority once; callers cannot choose another scope at issuance. */
  constructor(private readonly options: DemoCapabilityOptions) {
    this.issuer = identifier(options.issuer); this.audience = identifier(options.audience); this.scopeRef = identifier(options.scopeRef);
    const policy = structuredClone(options.policy);
    identifier(policy.version);
    for (const value of [policy.credentialMs, policy.runMs, policy.nonceMs, policy.allowanceWindowMs, policy.allowanceSeconds, policy.addressWindowMs, policy.addressAttempts, policy.maxActiveRuns, policy.controlGraceMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid demo policy');
    }
    if (policy.runMs % 1000 !== 0 || policy.credentialMs < policy.runMs + policy.controlGraceMs || !policy.operations.length || new Set(policy.operations).size !== policy.operations.length || policy.operations.some((op) => !OPERATIONS.has(op))) throw new Error('invalid demo policy');
    this.policy = Object.freeze({ ...policy, operations: Object.freeze([...policy.operations]) });
  }
  private at(): number {
    const at = this.options.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('invalid demo clock');
    return at;
  }
  private owns(row: DemoRow): boolean {
    return row.issuer === this.issuer && row.audience === this.audience && row.scopeRef === this.scopeRef;
  }
  /** Issues a short-lived, visitor-and-address-bound start nonce; no run or spend is admitted yet. */
  async createNonce(visitor: string, address: string): Promise<string> {
    const nonce = opaque(); const at = this.at();
    const row: DemoRow = { operationId: randomUUID(), issuer: this.issuer, audience: this.audience, scopeRef: this.scopeRef,
      visitorDigest: digest('visitor', identifier(visitor)), addressDigest: digest('address', identifier(address)), nonceDigest: digest('nonce', nonce),
      nonceExpiresAt: at + this.policy.nonceMs, operations: [...this.policy.operations], generation: 0, state: 'nonce', intents: [],
      policy: structuredClone(this.policy), reservedSeconds: 0, connectedSeconds: 0, usageFinal: false };
    await this.options.store.transaction((tx) => tx.put(row));
    return nonce;
  }
  /**
   * Consumes exactly once and reserves the remaining connected-time allowance. The host uses operationId
   * as the prepared manager request's idempotency key. Browser retries never recover through a nonce.
   */
  async claimStart(nonce: string, visitor: string, address: string): Promise<{ operationId: string; stopAt: number }> {
    const nonceDigest = digest('nonce', secret(nonce));
    const visitorDigest = digest('visitor', identifier(visitor)); const addressDigest = digest('address', identifier(address));
    return this.options.store.transaction(async (tx) => {
      const at = this.at(); const row = await tx.findNonce(nonceDigest);
      if (!row || !this.owns(row) || row.state !== 'nonce' || row.consumedAt !== undefined || at >= row.nonceExpiresAt || row.visitorDigest !== visitorDigest || row.addressDigest !== addressDigest) return refused();
      const rows = await tx.list();
      const admitted = rows.filter((r) => r.consumedAt !== undefined);
      const active = admitted.filter((r) => r.state === 'active' || r.intents.some((intent) => !intent.done));
      if (active.filter((r) => r.visitorDigest === visitorDigest).length >= row.policy.maxActiveRuns || active.filter((r) => r.addressDigest === addressDigest).length >= row.policy.maxActiveRuns) return refused();
      const recent = admitted.filter((r) => r.consumedAt! > at - row.policy.allowanceWindowMs || !r.usageFinal);
      const quantity = (rows: DemoRow[]) => rows.reduce((sum, r) => sum + (r.usageFinal ? r.connectedSeconds : r.reservedSeconds), 0);
      const used = Math.max(quantity(recent.filter((r) => r.visitorDigest === visitorDigest)), quantity(recent.filter((r) => r.addressDigest === addressDigest)));
      const remaining = Math.min(row.policy.runMs / 1000, row.policy.allowanceSeconds - used);
      if (!Number.isSafeInteger(remaining) || remaining <= 0) return refused();
      if (admitted.filter((r) => r.addressDigest === addressDigest && r.consumedAt! > at - row.policy.addressWindowMs).length >= row.policy.addressAttempts) return refused();
      row.reservedSeconds = remaining;
      row.consumedAt = at; row.issuedAt = at; row.expiresAt = at + row.policy.credentialMs; row.stopAt = at + remaining * 1000; row.state = 'active';
      await tx.put(row);
      return { operationId: row.operationId, stopAt: row.stopAt };
    });
  }
  /**
   * Trusted preparation/recovery only, never a browser route. Binds one manager run and rotates the
   * hash on response-loss recovery. Must run under the same host owner lock as cleanup and dispatch.
   * The host checks the remaining stopAt deadline before scheduling; issuance never extends it.
   */
  async bindRun(operationId: string, runId: string): Promise<DemoCredential> {
    identifier(runId); const token = opaque();
    return this.options.store.transaction(async (tx) => {
      const row = await tx.get(identifier(operationId));
      if (!row || !this.owns(row) || row.state !== 'active' || row.stopAt === undefined || this.at() >= row.stopAt || (row.runId !== undefined && row.runId !== runId)) return refused();
      row.runId = runId; row.tokenDigest = digest('token', token); row.generation += 1;
      row.credentialGeneration = row.generation;
      await tx.put(row);
      return { token, generation: row.generation, expiresAt: row.expiresAt! };
    });
  }
  private check(row: DemoRow | undefined, auth: DemoAuth): DemoRow {
    if (!row || !this.owns(row) || auth.issuer !== this.issuer || auth.audience !== this.audience || row.visitorDigest !== digest('visitor', identifier(auth.visitor)) || row.runId !== auth.runId || row.expiresAt === undefined || this.at() >= row.expiresAt || auth.expiresAt !== row.expiresAt) return refused();
    return row;
  }
  /**
   * Mediates one bounded read/delivery, including every streamed event. Call assertCurrent immediately
   * before writing output. Never retain the binding or enqueue a send after the callback returns.
   * Transport adapters must positively cancel blocked output before releasing their transaction.
   */
  async withRead<T>(authInput: DemoAuth, operation: Exclude<DemoOperation, 'stop' | 'purge'>, consume: (binding: DemoReadBinding, assertCurrent: () => void) => Promise<T>): Promise<T> {
    const auth = structuredClone(authInput); const tokenDigest = digest('token', secret(auth.token));
    if (!OPERATIONS.has(operation) || operation === ('stop' as DemoOperation) || operation === ('purge' as DemoOperation)) return refused();
    return this.options.store.transaction(async (tx) => {
      const row = this.check(await tx.findToken(tokenDigest), auth); if (!row.operations.includes(operation)) return refused(); let live = true;
      const assertCurrent = (): void => {
        if (!live || row.state !== 'active' || row.generation !== auth.generation || this.at() >= row.stopAt! || this.at() >= row.expiresAt!) return refused();
      };
      assertCurrent();
      try { return await consume({ scopeRef: row.scopeRef, runId: row.runId!, generation: row.generation }, assertCurrent); }
      finally { live = false; }
    });
  }
  private intent(row: DemoRow, action: 'stop' | 'purge', requestId: string): DemoIntent {
    const intent: DemoIntent = { action, requestId, authorizedGeneration: row.generation, generation: row.generation + 1, done: false };
    row.generation = intent.generation; row.state = action === 'purge' ? 'purged' : 'stopped'; row.intents.push(intent);
    if (action === 'stop') row.controlUntil = Math.min(row.expiresAt!, this.at() + row.policy.controlGraceMs);
    return intent;
  }
  /** Records revocation first; returns a receipt only when idempotent cleanup is acknowledged. */
  async control(authInput: DemoAuth, action: 'stop' | 'purge', requestId: string): Promise<DemoReceipt> {
    if (action !== 'stop' && action !== 'purge') return refused();
    identifier(requestId); const auth = structuredClone(authInput); const tokenDigest = digest('token', secret(auth.token));
    const selected = await this.options.store.transaction(async (tx) => {
      const row = this.check(await tx.findToken(tokenDigest), auth);
      if (!row.operations.includes(action)) return refused(); const previous = row.intents.find((i) => i.action === action && i.requestId === requestId && i.authorizedGeneration === auth.generation);
      if (previous) return { operationId: row.operationId, intent: previous };
      const grace = action === 'purge' && row.state === 'stopped' && this.at() < (row.controlUntil ?? 0) && auth.generation === row.credentialGeneration;
      if ((!grace && row.generation !== auth.generation) || row.state === 'purged' || (row.state === 'stopped' && action !== 'purge')) return refused();
      const intent = this.intent(row, action, requestId); intent.authorizedGeneration = auth.generation; await tx.put(row);
      return { operationId: row.operationId, intent };
    });
    await this.finish(selected.operationId, selected.intent.generation);
    return { accepted: true, action, generation: selected.intent.generation };
  }
  private async finish(operationId: string, generation: number): Promise<void> {
    const row = await this.options.store.transaction((tx) => tx.get(operationId));
    const intent = row?.intents.find((i) => i.generation === generation);
    if (!row || !intent || intent.done) return;
    const usage = await this.options.cleanup({ operationId, runId: row.runId, action: intent.action, generation });
    await this.options.store.transaction(async (tx) => {
      const current = await tx.get(operationId); const pending = current?.intents.find((i) => i.generation === generation);
      if (!current || !pending) throw new Error('demo cleanup record missing');
      if (!Number.isSafeInteger(usage.connectedSeconds) || usage.connectedSeconds < current.connectedSeconds || usage.connectedSeconds > current.reservedSeconds || (current.usageFinal && usage.connectedSeconds !== current.connectedSeconds)) throw new Error('invalid final demo usage');
      current.connectedSeconds = usage.connectedSeconds; current.usageFinal = true;
      pending.done = true; await tx.put(current);
    });
  }
  /** Host-authenticated page-away or admission-failure cleanup, also valid before run binding. */
  async abandon(operationId: string): Promise<void> {
    const generation = await this.options.store.transaction(async (tx) => {
      const row = await tx.get(identifier(operationId));
      if (!row || !this.owns(row) || row.state === 'nonce') return undefined;
      const old = row.intents.find((i) => i.action === 'purge');
      if (old) return old.generation;
      const intent = this.intent(row, 'purge', 'host-abandon'); await tx.put(row); return intent.generation;
    });
    if (generation !== undefined) await this.finish(operationId, generation);
  }
  /** Recovers pending intents and enforces the captured run, control and credential deadlines. */
  async sweep(): Promise<void> {
    const work = await this.options.store.transaction(async (tx) => {
      const at = this.at(); const jobs: Array<{ operationId: string; generation: number }> = [];
      for (const row of await tx.list()) {
        if (!this.owns(row) || row.state === 'nonce') continue;
        if ((at >= row.expiresAt! || (row.state === 'stopped' && at >= row.controlUntil!)) && row.state !== 'purged') this.intent(row, 'purge', 'host-expired');
        else if (at >= row.stopAt! && row.state === 'active') this.intent(row, 'stop', 'host-duration');
        for (const intent of row.intents) if (!intent.done) jobs.push({ operationId: row.operationId, generation: intent.generation });
        await tx.put(row);
      }
      return jobs;
    });
    const outcomes = await Promise.allSettled(work.map((job) => this.finish(job.operationId, job.generation)));
    if (outcomes.some((result) => result.status === 'rejected')) throw new Error('demo cleanup pending');
  }
  /** Never serializes server dependencies or authority rows. */
  toJSON(): string { return '[DemoRunCapability]'; }
}
