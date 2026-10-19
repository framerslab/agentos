/**
 * @module core/providers/ApiKeyPool
 *
 * A pool of API keys for one provider: several keys, a strategy that picks
 * one for each attempt, failure kinds that take a key out of rotation and
 * the rules that bring it back, probes that re-admit a failed key only when
 * it works again, and state that a host may persist across restarts.
 *
 * Accepts a single key or comma-separated keys. The default strategy is the
 * weighted round-robin of the first version (the first key gets higher
 * rotation weight, configurable); `ordered` prefers the earliest usable key
 * in the configured order, so a list is a cost order (credited keys first,
 * the paid key last) and a working key keeps being used until it fails.
 *
 * This is a core AgentOS primitive -- every provider that accepts an API key
 * uses it for multi-key rotation and failover.
 *
 * @example
 * ```ts
 * // Single key, zero rotation overhead:
 * const pool = new ApiKeyPool('sk_abc');
 * pool.next(); // 'sk_abc'
 *
 * // Several keys, round-robin with first-key priority (the default):
 * const pool = new ApiKeyPool('sk_primary,sk_backup,sk_overflow');
 * pool.next(); // weighted rotation, primary selected ~2x more
 *
 * // Several keys in cost order, failing over on any key failure:
 * const pool = new ApiKeyPool('sk_credited,sk_paid', { strategy: 'ordered', probe });
 * pool.markFailed('sk_credited', 'billing'); // out until the probe passes
 * pool.next(); // 'sk_paid'
 * ```
 */

import { createLogger, type ILogger } from '../logging/index.js';
import type { KeyPoolStateStore, KeyState } from './KeyPoolStateStore.js';
import type { KeyFailureKind } from './quotaErrors.js';

/** What a probe of a failed key answers: it works, it still fails in a kind, or the probe itself failed. */
export type ProbeResult = 'ok' | KeyFailureKind | 'unknown';

/** Configuration for an ApiKeyPool instance. */
export interface ApiKeyPoolConfig {
  /** Cooldown before retrying a quota-exhausted key, a positive number of milliseconds. Default: 15 minutes. */
  cooldownMs?: number;
  /** Weight multiplier for the first key under round-robin, a positive whole number. Default: 2. Set to 1 for equal weighting. */
  primaryWeight?: number;
  /** `round-robin` (default, the first version's behaviour) or `ordered` (the earliest usable key in the configured order). */
  strategy?: 'round-robin' | 'ordered';
  /** The first recheck delay of a key failed for auth or billing; doubles on each failed return. Default: 30 minutes. */
  recheckMs?: number;
  /** The recheck delay's ceiling. Default: 6 hours. */
  maxRecheckMs?: number;
  /** The longest rest a Retry-After may ask for, a positive number of milliseconds. Default: 1 hour. */
  maxRetryAfterMs?: number;
  /** How long a probe may run before it counts as `unknown`. Default: 10 seconds. */
  probeTimeoutMs?: number;
  /** Probes a failed key off the request path, told the kind of its last failure; without one, failed keys return by time. */
  probe?: (key: string, kind: KeyFailureKind | undefined) => Promise<ProbeResult>;
  /** Persists the pool's state; used only with `id`. */
  store?: KeyPoolStateStore;
  /** The pool's identity for its store and its log lines. */
  id?: string;
  /** The logger the pool writes its state changes to. Default: the library's `key-pool` logger. */
  logger?: ILogger;
}

interface Entry {
  key: string;
  state: KeyState;
}

const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const DEFAULT_PRIMARY_WEIGHT = 2;
const DEFAULT_RECHECK_MS = 30 * 60_000;
const DEFAULT_MAX_RECHECK_MS = 6 * 60 * 60_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 60 * 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const SAVE_DEBOUNCE_MS = 250;
const STORE_FAILURE_LOG_INTERVAL_MS = 60_000;

/** A short non-reversible digest of a key (FNV-1a, 64 bits, 12 hex characters), an identity that holds no secret. */
export function keyFingerprint(key: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < key.length; i++) {
    hash ^= BigInt(key.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0').slice(0, 12);
}

/**
 * The pool strategy the environment asks for when a provider's config names
 * none: `AGENTOS_KEY_POOL_STRATEGY_<PROVIDER>` (ANTHROPIC, OPENAI, GEMINI,
 * OPENROUTER, REQUESTY) for one provider, else `AGENTOS_KEY_POOL_STRATEGY` for
 * every provider; `ordered` prefers the earliest usable key (a cost order:
 * credited keys first, the paid key last), `round-robin` spreads load.
 */
export function keyPoolStrategyFromEnv(providerId?: string): Pick<ApiKeyPoolConfig, 'strategy'> {
  if (typeof process === 'undefined') return {};
  const own = providerId ? process.env[`AGENTOS_KEY_POOL_STRATEGY_${providerId.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`] : undefined;
  const value = own || process.env.AGENTOS_KEY_POOL_STRATEGY;
  if (value === 'ordered') return { strategy: 'ordered' };
  if (value === 'round-robin') return { strategy: 'round-robin' };
  return {};
}

/**
 * A timing option as a positive, finite number of milliseconds, or the default when it is not given. Anything else
 * is refused: a zero or negative recheck makes every failed key due at once and an interval of zero fires without
 * pause, so a probe would follow a probe; a zero probe timeout makes every probe unknown.
 */
function positiveMs(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`ApiKeyPool: ${name} must be a positive number of milliseconds (got ${String(value)})`);
  }
  return value;
}

function parseKeys(keys: string | string[]): string[] {
  const list = Array.isArray(keys) ? keys.map((k) => k.trim()) : keys.split(',').map((k) => k.trim());
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of list) {
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export class ApiKeyPool {
  private readonly entries: Entry[];
  private readonly weightedSlots: number[];
  private slotIndex = 0;
  private readonly cooldownMs: number;
  private readonly strategy: 'round-robin' | 'ordered';
  private readonly recheckMs: number;
  private readonly maxRecheckMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly probeTimeoutMs: number;
  private readonly probe?: (key: string, kind: KeyFailureKind | undefined) => Promise<ProbeResult>;
  private readonly store?: KeyPoolStateStore;
  private readonly id: string;
  private loggerInstance?: ILogger;
  private readonly configuredLogger?: ILogger;
  private readyPromise?: Promise<void>;
  private readonly inFlightProbes = new Map<string, Promise<void>>();
  /** The interval `startRechecks()` runs, if any: one per pool. */
  private recheckTimer: ReturnType<typeof setInterval> | undefined;
  private readonly pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlightSaves = new Set<Promise<void>>();
  private readonly lastLogged = new Map<string, number>();
  private lastStoreFailureLog = 0;

  constructor(keys: string | string[], config?: ApiKeyPoolConfig) {
    // A cooldown of zero makes a throttled key usable at once, so an ordered pool re-sends to the key that has just
    // answered 429 and the other key never serves; a Retry-After bound of zero does the same for a key the server
    // asked to rest. Both are refused with the other timings.
    this.cooldownMs = positiveMs('cooldownMs', config?.cooldownMs, DEFAULT_COOLDOWN_MS);
    this.strategy = config?.strategy ?? 'round-robin';
    this.recheckMs = positiveMs('recheckMs', config?.recheckMs, DEFAULT_RECHECK_MS);
    this.maxRecheckMs = positiveMs('maxRecheckMs', config?.maxRecheckMs, DEFAULT_MAX_RECHECK_MS);
    this.maxRetryAfterMs = positiveMs('maxRetryAfterMs', config?.maxRetryAfterMs, DEFAULT_MAX_RETRY_AFTER_MS);
    this.probeTimeoutMs = positiveMs('probeTimeoutMs', config?.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
    this.probe = config?.probe;
    this.id = config?.id ?? '';
    this.store = config?.id ? config?.store : undefined;
    this.configuredLogger = config?.logger;
    const primaryWeight = config?.primaryWeight ?? DEFAULT_PRIMARY_WEIGHT;
    // The first key's rotation slots: zero or a fraction leaves it none, so round-robin never returns it.
    if (!Number.isInteger(primaryWeight) || primaryWeight < 1) {
      throw new RangeError(`ApiKeyPool: primaryWeight must be a positive whole number (got ${String(primaryWeight)})`);
    }

    const now = Date.now();
    this.entries = parseKeys(keys).map((key, index) => ({
      key,
      state: {
        fingerprint: keyFingerprint(key),
        label: `k${index}${key.length >= 4 ? key.slice(-4) : ''}`,
        status: 'ok',
        failures: 0,
        updatedAt: now,
        version: 1,
      },
    }));

    // Build weighted slot array: first key appears `primaryWeight` times, rest once each.
    this.weightedSlots = [];
    for (let i = 0; i < this.entries.length; i++) {
      const times = i === 0 ? primaryWeight : 1;
      for (let t = 0; t < times; t++) {
        this.weightedSlots.push(i);
      }
    }
  }

  /** Number of keys in the pool (including resting and failed ones). */
  get size(): number {
    return this.entries.length;
  }

  /** Whether any key exists at all. */
  get hasKeys(): boolean {
    return this.entries.length > 0;
  }

  /** Whether this key is one of the pool's (a per-request override or an OAuth token is not). */
  has(key: string): boolean {
    return this.entries.some((entry) => entry.key === key);
  }

  /**
   * Loads the persisted state once, when the pool has a store and an id; the
   * providers await it in `initialize()` before the first `next()`. Resolves
   * at once without a store. A load that throws leaves a fresh state and
   * logs one warning.
   */
  ready(): Promise<void> {
    this.readyPromise ??= this.loadState();
    return this.readyPromise;
  }

  /**
   * The next key by the strategy. A single-key pool returns its key. With
   * several keys: a usable key, or, when none is usable, the resting key
   * whose rest ends first (a throttled key still goes out and its answer
   * updates the state; a failed key never does); `''` when every key is
   * failed, which the provider turns into its all-keys-failed error. A failed
   * key whose recheck is due has a probe scheduled here, off the request path.
   */
  next(): string {
    if (this.entries.length === 0) return '';
    if (this.entries.length === 1) return this.entries[0].key;

    const now = Date.now();
    this.scheduleDueRechecks(now);

    if (this.strategy === 'ordered') {
      for (const entry of this.entries) {
        if (this.isUsable(entry, now)) return entry.key;
      }
    } else {
      const totalSlots = this.weightedSlots.length;
      for (let i = 0; i < totalSlots; i++) {
        const slotIdx = (this.slotIndex + i) % totalSlots;
        const entry = this.entries[this.weightedSlots[slotIdx]];
        if (this.isUsable(entry, now)) {
          this.slotIndex = (slotIdx + 1) % totalSlots;
          return entry.key;
        }
      }
    }

    // None usable. A resting key is merely throttled: the one whose rest ends
    // soonest goes out (the first version's behaviour), never a failed key (a
    // revoked or unpaid credential). Every key failed: nothing, so the
    // provider throws instead of sending such a credential again.
    const resting = this.entries.filter((entry) => entry.state.status === 'resting');
    if (resting.length === 0) return '';
    resting.sort((a, b) => (a.state.until ?? 0) - (b.state.until ?? 0));
    return resting[0].key;
  }

  /** How many keys `next()` may hand out now. */
  usable(): number {
    const now = Date.now();
    return this.entries.filter((entry) => this.isUsable(entry, now)).length;
  }

  /** Marks a key quota-exhausted: it rests for the cooldown, then re-enters rotation. */
  markExhausted(key: string): void {
    this.markFailed(key, 'quota');
  }

  /**
   * Records a key-scoped failure. `quota` rests the key (Retry-After when
   * given, else the cooldown); `auth` and `billing` take it out until a probe
   * passes, or until the recheck delay has run when there is no probe. A
   * result whose `at` is older than the key's last recorded result is
   * ignored, so an old answer never undoes a newer one.
   */
  markFailed(key: string, kind: KeyFailureKind, detail?: { retryAfterMs?: number; status?: number; at?: number }): void {
    const entry = this.entries.find((e) => e.key === key);
    if (!entry) return;
    const now = Date.now();
    const at = detail?.at ?? now;
    const { state } = entry;
    if (at < (state.lastOkAt ?? 0) || at < (state.lastFailAt ?? 0)) return;
    const usableBefore = this.usable();

    const previous = state.status;
    state.lastFailAt = at;
    state.kind = kind;
    if (kind === 'quota') {
      // A Retry-After of zero (or none) rests the key for the cooldown: the
      // point of the rest is that the next draw prefers another key. The bound
      // applies to what the server asked, never to the configured cooldown.
      const asked = detail?.retryAfterMs;
      const rest = asked !== undefined && asked > 0 ? Math.min(asked, this.maxRetryAfterMs) : this.cooldownMs;
      state.status = 'resting';
      state.until = now + rest;
      state.nextRecheckAt = undefined;
    } else {
      state.failures += 1;
      state.status = 'failed';
      state.until = undefined;
      state.nextRecheckAt = now + this.recheckDelay(state.failures);
    }
    state.updatedAt = now;
    // A transition: the status changed (a key that was ok always changes here).
    this.log('warn', 'key_pool.key_failed', entry, previous !== state.status, {
      kind,
      status: detail?.status,
      retryAfterMs: kind === 'quota' ? (state.until ?? now) - now : undefined,
      failures: state.failures,
      nextRecheckAt: state.nextRecheckAt,
    });
    // One line when the last usable key goes out, never for a single-key pool
    // (which keeps sending its key) and never again while the pool stays out.
    if (this.entries.length > 1 && usableBefore > 0 && this.usable() === 0) {
      this.log('warn', 'key_pool.all_keys_failed', undefined, true, { kinds: this.kindsSeen(), retryAfterMs: this.soonestReturnMs(now) });
    }
    this.scheduleSave(entry);
  }

  /** Records a success: the key is usable, its failure count cleared, its last-good time kept. */
  markSuccess(key: string, at?: number): void {
    const entry = this.entries.find((e) => e.key === key);
    if (!entry) return;
    const now = Date.now();
    const when = at ?? now;
    const { state } = entry;
    if (when < (state.lastFailAt ?? 0)) return;
    const previous = state.status;
    state.lastOkAt = when;
    if (state.status !== 'ok' || state.failures !== 0) {
      state.status = 'ok';
      state.failures = 0;
      state.kind = undefined;
      state.until = undefined;
      state.nextRecheckAt = undefined;
      state.updatedAt = now;
      if (previous !== 'ok') this.log('info', 'key_pool.key_recovered', entry, true, { by: 'success' });
      this.scheduleSave(entry);
    }
  }

  /**
   * Probes every failed key whose recheck is due (one probe per key at a
   * time, each under the probe timeout) and applies the answers. Settles when
   * the probes this call started have settled. Without a probe, does nothing:
   * failed keys then return by time.
   */
  async recheck(): Promise<void> {
    if (!this.probe) return;
    const now = Date.now();
    const started: Promise<void>[] = [];
    for (const entry of this.entries) {
      if (entry.state.status !== 'failed') continue;
      if ((entry.state.nextRecheckAt ?? 0) > now) continue;
      started.push(this.probeEntry(entry));
    }
    await Promise.all(started);
  }

  /**
   * Runs `recheck()` on an interval that never keeps the process alive, one
   * interval per pool (a second call replaces the first); returns the function
   * that stops it. The interval holds the pool weakly where the runtime has
   * `WeakRef`: a pool nothing else holds (a provider dropped without
   * `shutdown()`, a manager evicted from `createProviderManager()`'s cache)
   * ends its interval on the next tick instead of being kept alive by it.
   */
  startRechecks(intervalMs: number = this.recheckMs): () => void {
    const every = positiveMs('the recheck interval', intervalMs, this.recheckMs);
    this.stopRechecks();
    const ref = typeof WeakRef === 'function' ? new WeakRef<ApiKeyPool>(this) : undefined;
    const strong = ref ? undefined : this;
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      const pool = ref ? ref.deref() : strong;
      if (!pool) {
        clearInterval(timer);
        return;
      }
      void pool.recheck().catch(() => undefined);
    }, every);
    const maybeUnref = timer as unknown as { unref?: () => void };
    if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
    this.recheckTimer = timer;
    return () => {
      if (this.recheckTimer === timer) this.stopRechecks();
      else clearInterval(timer);
    };
  }

  /** Stops the interval `startRechecks()` started, if any. Probes already running finish. */
  stopRechecks(): void {
    if (this.recheckTimer === undefined) return;
    clearInterval(this.recheckTimer);
    this.recheckTimer = undefined;
  }

  /**
   * Ends the pool's work for a host that is shutting down: stops the recheck
   * interval, waits for the probes in flight (each bounded by the probe
   * timeout), then writes every pending state change, so what a probe found
   * during shutdown is kept. The providers' `shutdown()` calls it.
   */
  async close(): Promise<void> {
    this.stopRechecks();
    await Promise.allSettled(Array.from(this.inFlightProbes.values()));
    await this.flush();
  }

  /** A copy of every key's state, for hosts and tests. */
  snapshot(): KeyState[] {
    return this.entries.map((entry) => ({ ...entry.state }));
  }

  /**
   * Writes every pending state change now and waits for the writes in
   * flight, so a host that is shutting down keeps the keys' standing; the
   * providers' `shutdown()` calls it. Resolves at once without a store.
   */
  async flush(): Promise<void> {
    const pending = Array.from(this.pendingSaves.keys());
    for (const timer of this.pendingSaves.values()) clearTimeout(timer);
    this.pendingSaves.clear();
    for (const key of pending) {
      const entry = this.entries.find((e) => e.key === key);
      if (entry) void this.saveNow(entry);
    }
    await Promise.all(Array.from(this.inFlightSaves));
  }

  // ---------------------------------------------------------------------------

  private isUsable(entry: Entry, now: number): boolean {
    const { state } = entry;
    if (state.status === 'ok') return true;
    if (state.status === 'resting') return (state.until ?? 0) <= now;
    // failed: with a probe, only a passed probe re-admits; without one, time does.
    if (this.probe) return false;
    return (state.nextRecheckAt ?? 0) <= now;
  }

  private recheckDelay(failures: number): number {
    const doublings = Math.max(0, Math.min(failures - 1, 20));
    return Math.min(this.recheckMs * 2 ** doublings, this.maxRecheckMs);
  }

  private kindsSeen(): KeyFailureKind[] {
    const kinds = new Set<KeyFailureKind>();
    for (const entry of this.entries) if (entry.state.kind) kinds.add(entry.state.kind);
    return Array.from(kinds);
  }

  /** The soonest a key may come back, in ms from `now`, for an all-keys-failed error. */
  soonestReturnMs(now: number = Date.now()): number | undefined {
    let soonest: number | undefined;
    for (const entry of this.entries) {
      const { state } = entry;
      const at = state.status === 'resting' ? state.until : state.status === 'failed' ? state.nextRecheckAt : undefined;
      if (at === undefined) continue;
      const ms = Math.max(0, at - now);
      if (soonest === undefined || ms < soonest) soonest = ms;
    }
    return soonest;
  }

  private scheduleDueRechecks(now: number): void {
    if (!this.probe) return;
    for (const entry of this.entries) {
      if (entry.state.status !== 'failed') continue;
      if ((entry.state.nextRecheckAt ?? 0) > now) continue;
      if (this.inFlightProbes.has(entry.key)) continue;
      void this.probeEntry(entry).catch(() => undefined);
    }
  }

  private probeEntry(entry: Entry): Promise<void> {
    const inFlight = this.inFlightProbes.get(entry.key);
    if (inFlight) return inFlight;
    const run = this.runProbe(entry).finally(() => {
      this.inFlightProbes.delete(entry.key);
    });
    this.inFlightProbes.set(entry.key, run);
    return run;
  }

  private async runProbe(entry: Entry): Promise<void> {
    if (!this.probe) return;
    const startedAt = Date.now();
    let result: ProbeResult = 'unknown';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        this.probe(entry.key, entry.state.kind),
        new Promise<ProbeResult>((resolve) => {
          timer = setTimeout(() => resolve('unknown'), this.probeTimeoutMs);
        }),
      ]);
    } catch {
      result = 'unknown';
    } finally {
      if (timer) clearTimeout(timer);
    }
    const { state } = entry;
    // A newer result (a request's success or failure after the probe began) wins over the probe.
    if (startedAt < (state.lastFailAt ?? 0) || startedAt < (state.lastOkAt ?? 0)) return;
    const now = Date.now();
    if (result === 'ok') {
      state.status = 'ok';
      state.failures = 0;
      state.kind = undefined;
      state.until = undefined;
      state.nextRecheckAt = undefined;
      state.lastOkAt = startedAt;
      state.updatedAt = now;
      this.log('info', 'key_pool.key_recovered', entry, true, { by: 'probe' });
      this.scheduleSave(entry);
      return;
    }
    if (result === 'quota') {
      state.status = 'resting';
      state.kind = 'quota';
      state.until = now + this.cooldownMs;
      state.nextRecheckAt = undefined;
      state.updatedAt = now;
      this.log('warn', 'key_pool.probe_failed', entry, true, { result });
      this.scheduleSave(entry);
      return;
    }
    // auth, billing or unknown: still out; the next recheck waits longer.
    state.failures += 1;
    if (result !== 'unknown') state.kind = result;
    state.nextRecheckAt = now + this.recheckDelay(state.failures);
    state.updatedAt = now;
    this.log('warn', 'key_pool.probe_failed', entry, false, { result, failures: state.failures, nextRecheckAt: state.nextRecheckAt });
    this.scheduleSave(entry);
  }

  private async loadState(): Promise<void> {
    if (!this.store || !this.id || this.entries.length === 0) return;
    let rows: KeyState[] | null = null;
    try {
      rows = await this.store.load(this.id);
    } catch (error) {
      this.logger().warn('key_pool.store_failed', { poolId: this.id, op: 'load', error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!rows) return;
    let applied = 0;
    for (const row of rows) {
      if (row.version !== 1) continue;
      const entry = this.entries.find((e) => e.state.fingerprint === row.fingerprint);
      if (!entry) continue;
      if (row.updatedAt <= entry.state.updatedAt && entry.state.status !== 'ok') continue;
      entry.state = { ...row, label: entry.state.label };
      applied += 1;
    }
    this.logger().debug?.('key_pool.state_loaded', { poolId: this.id, rows: rows.length, applied });
  }

  private scheduleSave(entry: Entry): void {
    if (!this.store || !this.id) return;
    const pending = this.pendingSaves.get(entry.key);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.pendingSaves.delete(entry.key);
      void this.saveNow(entry);
    }, SAVE_DEBOUNCE_MS);
    const maybeUnref = timer as unknown as { unref?: () => void };
    if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
    this.pendingSaves.set(entry.key, timer);
  }

  /** Writes one key's state to the store now; the write is tracked so `flush()` can wait for it. */
  private saveNow(entry: Entry): Promise<void> {
    const store = this.store;
    if (!store || !this.id) return Promise.resolve();
    const snapshot = { ...entry.state };
    const write: Promise<void> = store.save(this.id, snapshot)
      .then(() => this.logger().debug?.('key_pool.state_saved', { poolId: this.id, label: snapshot.label, status: snapshot.status }))
      .catch((error: unknown) => {
        const now = Date.now();
        if (now - this.lastStoreFailureLog < STORE_FAILURE_LOG_INTERVAL_MS) return;
        this.lastStoreFailureLog = now;
        this.logger().warn('key_pool.store_failed', { poolId: this.id, op: 'save', error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        this.inFlightSaves.delete(write);
      });
    this.inFlightSaves.add(write);
    return write;
  }

  private logger(): ILogger {
    this.loggerInstance ??= this.configuredLogger ?? createLogger('key-pool');
    return this.loggerInstance;
  }

  /**
   * One line per state transition; a repeat of the same event for the same
   * key without a transition is throttled to once per cooldown.
   */
  private log(level: 'info' | 'warn', event: string, entry: Entry | undefined, transition: boolean, meta: Record<string, unknown>): void {
    const throttleKey = `${event}:${entry?.state.fingerprint ?? '*'}`;
    const now = Date.now();
    if (!transition) {
      const last = this.lastLogged.get(throttleKey) ?? 0;
      if (now - last < this.cooldownMs) return;
    }
    this.lastLogged.set(throttleKey, now);
    const fields: Record<string, unknown> = { poolId: this.id || undefined, label: entry?.state.label, keyStatus: entry?.state.status };
    for (const [k, v] of Object.entries(meta)) if (v !== undefined) fields[k] = v;
    this.logger()[level](event, fields);
  }
}
