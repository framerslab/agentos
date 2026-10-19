import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyPool, keyFingerprint, keyPoolStrategyFromEnv, type ProbeResult } from '../ApiKeyPool.js';
import { InMemoryKeyPoolStateStore, type KeyState } from '../KeyPoolStateStore.js';
import type { ILogger } from '../../logging/index.js';

function recordingLogger(): { logger: ILogger; lines: Array<{ level: string; event: string; meta?: Record<string, unknown> }> } {
  const lines: Array<{ level: string; event: string; meta?: Record<string, unknown> }> = [];
  const push = (level: string) => (event: string, meta?: Record<string, unknown>) => {
    lines.push({ level, event, meta });
  };
  return { logger: { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }, lines };
}

describe('ApiKeyPool v2', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('construction and compatibility', () => {
    it('drops duplicate keys and keeps the first occurrence', () => {
      const pool = new ApiKeyPool('sk_a,sk_b,sk_a');
      expect(pool.size).toBe(2);
    });

    it('keeps the weighted round-robin as the default strategy', () => {
      const pool = new ApiKeyPool('sk_a,sk_b,sk_c', { primaryWeight: 1 });
      expect([pool.next(), pool.next(), pool.next(), pool.next()]).toEqual(['sk_a', 'sk_b', 'sk_c', 'sk_a']);
    });

    it('fingerprints a key without holding it', () => {
      const fp = keyFingerprint('sk-ant-api03-abcdef');
      expect(fp).toMatch(/^[0-9a-f]{12}$/);
      expect(fp).not.toContain('abcdef');
      expect(keyFingerprint('sk-ant-api03-abcdef')).toBe(fp);
      expect(keyFingerprint('sk-ant-api03-abcdeg')).not.toBe(fp);
    });

    it('labels keys by index and last four characters, never the key', () => {
      const pool = new ApiKeyPool('sk_credited_1234,sk_paid_5678', { strategy: 'ordered' });
      expect(pool.snapshot().map((s) => s.label)).toEqual(['k01234', 'k15678']);
      expect(JSON.stringify(pool.snapshot())).not.toContain('sk_credited');
    });
  });

  describe('ordered strategy', () => {
    it('prefers the earliest usable key and goes back to it when it is usable again', () => {
      const pool = new ApiKeyPool('sk_a,sk_b,sk_c', { strategy: 'ordered', cooldownMs: 1000 });
      expect(pool.next()).toBe('sk_a');
      expect(pool.next()).toBe('sk_a');
      pool.markFailed('sk_a', 'quota');
      expect(pool.next()).toBe('sk_b');
      vi.advanceTimersByTime(1001);
      expect(pool.next()).toBe('sk_a');
    });

    it('sends the soonest-returning resting key when none is usable, never a failed key, and nothing when every key is failed', () => {
      const pool = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered', cooldownMs: 10_000, recheckMs: 60_000 });
      pool.markFailed('sk_a', 'quota');
      vi.advanceTimersByTime(2000);
      pool.markFailed('sk_b', 'quota');
      expect(pool.next()).toBe('sk_a');
      // A revoked key beside a throttled one: the throttled one still goes out.
      pool.markFailed('sk_a', 'auth');
      expect(pool.next()).toBe('sk_b');
      pool.markFailed('sk_b', 'billing');
      expect(pool.next()).toBe('');
      expect(pool.usable()).toBe(0);
      expect(pool.soonestReturnMs()).toBe(60_000);
    });

    it('a single-key pool keeps returning its key whatever happened to it', () => {
      const pool = new ApiKeyPool('sk_only', { strategy: 'ordered' });
      pool.markFailed('sk_only', 'auth');
      expect(pool.next()).toBe('sk_only');
    });
  });

  describe('failure kinds', () => {
    it('rests a quota failure for Retry-After when given, bounded, else the cooldown', () => {
      const pool = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered', cooldownMs: 60_000, maxRetryAfterMs: 120_000 });
      pool.markFailed('sk_a', 'quota', { retryAfterMs: 5000 });
      expect(pool.snapshot()[0]).toMatchObject({ status: 'resting', kind: 'quota', until: Date.now() + 5000 });
      pool.markFailed('sk_b', 'quota', { retryAfterMs: 999_999 });
      expect(pool.snapshot()[1].until).toBe(Date.now() + 120_000);
      vi.advanceTimersByTime(5001);
      expect(pool.next()).toBe('sk_a');
      // The bound applies to what the server asked, never to the cooldown: a two-hour cooldown stays two hours.
      const long = new ApiKeyPool('sk_e,sk_f', { strategy: 'ordered', cooldownMs: 2 * 60 * 60_000 });
      long.markFailed('sk_e', 'quota');
      expect(long.snapshot()[0].until).toBe(Date.now() + 2 * 60 * 60_000);
      // A Retry-After of zero counts as none: the key rests for the cooldown, so the next draw prefers another key.
      const zero = new ApiKeyPool('sk_c,sk_d', { strategy: 'ordered', cooldownMs: 60_000 });
      zero.markFailed('sk_c', 'quota', { retryAfterMs: 0 });
      expect(zero.snapshot()[0].until).toBe(Date.now() + 60_000);
      expect(zero.next()).toBe('sk_d');
    });

    it('takes an auth or billing failure out until the recheck delay has run when there is no probe, doubling each time', () => {
      const pool = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered', recheckMs: 1000, maxRecheckMs: 3000 });
      pool.markFailed('sk_a', 'auth');
      expect(pool.next()).toBe('sk_b');
      expect(pool.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'auth', failures: 1, nextRecheckAt: Date.now() + 1000 });
      vi.advanceTimersByTime(1001);
      expect(pool.next()).toBe('sk_a');
      pool.markFailed('sk_a', 'billing');
      expect(pool.snapshot()[0]).toMatchObject({ failures: 2, nextRecheckAt: Date.now() + 2000 });
      vi.advanceTimersByTime(2001);
      pool.markFailed('sk_a', 'billing');
      expect(pool.snapshot()[0]).toMatchObject({ failures: 3, nextRecheckAt: Date.now() + 3000 });
    });

    it('counts the answers of requests that were in flight together as one failure', () => {
      const pool = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered', recheckMs: 1000, maxRecheckMs: 60_000 });
      const started = Date.now();
      vi.advanceTimersByTime(500);
      // Eight requests drew sk_a while it was ok and all started before the first answer marked it: one failure, so
      // the first recheck is recheckMs away, not the delay's ceiling.
      for (let i = 0; i < 8; i++) pool.markFailed('sk_a', 'billing', { at: started + i });
      expect(pool.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'billing', failures: 1, nextRecheckAt: Date.now() + 1000 });
      // A request that started after that record is new evidence and doubles the delay.
      vi.advanceTimersByTime(10);
      pool.markFailed('sk_a', 'billing', { at: Date.now() });
      expect(pool.snapshot()[0]).toMatchObject({ failures: 2, nextRecheckAt: Date.now() + 2000 });
    });

    it('counts an answer whose request started in the millisecond the previous failure was recorded with that failure', () => {
      const pool = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered', recheckMs: 1000, maxRecheckMs: 60_000 });
      const t = Date.now();
      pool.markFailed('sk_a', 'billing', { at: t });
      // Drew the key before that record marked it, in the same millisecond: no new evidence.
      pool.markFailed('sk_a', 'billing', { at: t });
      expect(pool.snapshot()[0]).toMatchObject({ failures: 1, nextRecheckAt: t + 1000 });
      vi.advanceTimersByTime(1);
      pool.markFailed('sk_a', 'billing', { at: Date.now() });
      expect(pool.snapshot()[0]).toMatchObject({ failures: 2, nextRecheckAt: Date.now() + 2000 });
    });

    it('a success clears the failure count and the kind', () => {
      const pool = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered', recheckMs: 1000 });
      pool.markFailed('sk_a', 'auth');
      vi.advanceTimersByTime(1001);
      pool.markSuccess('sk_a');
      expect(pool.snapshot()[0]).toMatchObject({ status: 'ok', failures: 0, lastOkAt: Date.now() });
      expect(pool.snapshot()[0].kind).toBeUndefined();
    });

    it('ignores a result older than the key\'s last recorded result', () => {
      const pool = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered' });
      const before = Date.now();
      vi.advanceTimersByTime(100);
      pool.markFailed('sk_a', 'auth');
      pool.markSuccess('sk_a', before);
      expect(pool.snapshot()[0].status).toBe('failed');
      vi.advanceTimersByTime(100);
      pool.markSuccess('sk_a');
      pool.markFailed('sk_a', 'billing', { at: before });
      expect(pool.snapshot()[0].status).toBe('ok');
    });
  });

  describe('probes', () => {
    it('keeps a failed key out until its probe passes, re-admits it on ok, and doubles the delay on a failed probe', async () => {
      const answers: ProbeResult[] = ['auth', 'ok'];
      const probed: string[] = [];
      const probe = vi.fn(async (key: string) => {
        probed.push(key);
        return answers.shift() ?? 'ok';
      });
      const pool = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered', recheckMs: 1000, probe });
      pool.markFailed('sk_a', 'auth');
      vi.advanceTimersByTime(1001);
      expect(pool.next()).toBe('sk_b'); // the probe was scheduled here, off the request path
      await pool.recheck(); // joins the probe already in flight
      expect(probe).toHaveBeenCalledTimes(1);
      expect(pool.snapshot()[0]).toMatchObject({ status: 'failed', failures: 2, nextRecheckAt: Date.now() + 2000 });
      expect(pool.next()).toBe('sk_b');
      vi.advanceTimersByTime(2001);
      await pool.recheck();
      expect(probe).toHaveBeenCalledTimes(2);
      expect(pool.snapshot()[0]).toMatchObject({ status: 'ok', failures: 0 });
      expect(pool.next()).toBe('sk_a');
      expect(probed).toEqual(['sk_a', 'sk_a']);
    });

    it('treats a probe that throws or hangs as unknown and keeps the key out', async () => {
      const probe = vi.fn(() => new Promise<ProbeResult>(() => undefined));
      const pool = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered', recheckMs: 1000, probe, probeTimeoutMs: 500 });
      pool.markFailed('sk_a', 'billing');
      vi.advanceTimersByTime(1001);
      const settled = pool.recheck();
      await vi.advanceTimersByTimeAsync(501);
      await settled;
      expect(pool.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'billing', failures: 2 });
      expect(pool.next()).toBe('sk_b');
    });

    it('nextAfterProbes() waits for the probes a due recheck just started and draws the key that came back', async () => {
      const answers: Array<(result: ProbeResult) => void> = [];
      const probe = vi.fn(() => new Promise<ProbeResult>((resolve) => {
        answers.push(resolve);
      }));
      const pool = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered', recheckMs: 1000, probe });
      pool.markFailed('sk_a', 'auth');
      pool.markFailed('sk_b', 'auth');
      // Not due: nothing to wait for, the pool answers at once.
      expect(await pool.nextAfterProbes()).toBe('');
      expect(probe).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1001);
      let drawn: string | undefined;
      const drawing = pool.nextAfterProbes().then((key) => {
        drawn = key;
      });
      await Promise.resolve();
      expect(probe).toHaveBeenCalledTimes(2);
      expect(drawn).toBeUndefined();
      for (const answer of answers) answer('ok');
      await drawing;
      expect(drawn).toBe('sk_a');
      await pool.recheck();
      expect(pool.snapshot().map((s) => s.status)).toEqual(['ok', 'ok']);
    });

    it('nextAfterProbes() draws the first key that comes back, without waiting for the probe of another key that hangs', async () => {
      const probe = vi.fn((key: string) => (key === 'sk_b' ? Promise.resolve<ProbeResult>('ok') : new Promise<ProbeResult>(() => undefined)));
      const pool = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered', recheckMs: 1000, probe, probeTimeoutMs: 10_000 });
      pool.markFailed('sk_a', 'auth');
      pool.markFailed('sk_b', 'auth');
      vi.advanceTimersByTime(1001);
      let drawn: string | undefined;
      const drawing = pool.nextAfterProbes().then((key) => {
        drawn = key;
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(drawn).toBe('sk_b');
      await drawing;
      // sk_a's probe is still out; it ends at the probe timeout as unknown and the key stays out.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pool.snapshot()[0]).toMatchObject({ status: 'failed', failures: 2 });
    });

    it('nextAfterProbes() stops waiting when the caller aborts', async () => {
      const probe = vi.fn(() => new Promise<ProbeResult>(() => undefined));
      const pool = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered', recheckMs: 1000, probe, probeTimeoutMs: 10_000 });
      pool.markFailed('sk_a', 'auth');
      pool.markFailed('sk_b', 'auth');
      vi.advanceTimersByTime(1001);
      const controller = new AbortController();
      let drawn: string | undefined;
      const drawing = pool.nextAfterProbes(controller.signal).then((key) => {
        drawn = key;
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(drawn).toBeUndefined();
      controller.abort();
      await vi.advanceTimersByTimeAsync(1);
      expect(drawn).toBe('');
      await drawing;
      // A signal that has already fired: no wait at all, though the probes are still out.
      expect(await pool.nextAfterProbes(controller.signal)).toBe('');
      expect(probe).toHaveBeenCalledTimes(2);
    });

    it('nextAfterProbes() answers \'\' once the probes it waited for fail, and a usable key at once', async () => {
      const probe = vi.fn(async (): Promise<ProbeResult> => 'auth');
      const pool = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered', recheckMs: 1000, probe });
      expect(await pool.nextAfterProbes()).toBe('sk_a');
      pool.markFailed('sk_a', 'auth');
      pool.markFailed('sk_b', 'auth');
      vi.advanceTimersByTime(1001);
      expect(await pool.nextAfterProbes()).toBe('');
      expect(probe).toHaveBeenCalledTimes(2);
      // Each failed probe pushed its key's next recheck out, so the error the provider throws now names a later return.
      expect(pool.soonestReturnMs()).toBe(2000);
    });

    it('runs one probe per key at a time', async () => {
      let resolveProbe: (r: ProbeResult) => void = () => undefined;
      const probe = vi.fn(() => new Promise<ProbeResult>((resolve) => { resolveProbe = resolve; }));
      const pool = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered', recheckMs: 1000, probe });
      pool.markFailed('sk_a', 'auth');
      vi.advanceTimersByTime(1001);
      pool.next();
      pool.next();
      const a = pool.recheck();
      expect(probe).toHaveBeenCalledTimes(1);
      resolveProbe('ok');
      await a;
      expect(pool.snapshot()[0].status).toBe('ok');
    });
  });

  describe('the recheck timer and close()', () => {
    it('refuses a zero, negative or non-finite recheck, maximum recheck or probe timeout, and a non-positive interval', () => {
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => new ApiKeyPool('sk_a,sk_b', { recheckMs: bad })).toThrow(RangeError);
        expect(() => new ApiKeyPool('sk_a,sk_b', { maxRecheckMs: bad })).toThrow(RangeError);
        expect(() => new ApiKeyPool('sk_a,sk_b', { probeTimeoutMs: bad })).toThrow(RangeError);
      }
      const pool = new ApiKeyPool('sk_a,sk_b', { recheckMs: 1000 });
      const before = vi.getTimerCount();
      expect(() => pool.startRechecks(0)).toThrow(RangeError);
      expect(() => pool.startRechecks(-5)).toThrow(RangeError);
      expect(vi.getTimerCount()).toBe(before);
    });

    it('refuses a cooldown or Retry-After bound that is not a positive number of milliseconds, and a primary weight that is not a positive whole number', () => {
      // A cooldown of zero made a throttled key usable at once, so an ordered pool re-sent the request to the key
      // that had just answered 429 and the other key never served; a primary weight of zero left the first key no
      // rotation slot, so round-robin never returned it.
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => new ApiKeyPool('sk_a,sk_b', { cooldownMs: bad })).toThrow(RangeError);
        expect(() => new ApiKeyPool('sk_a,sk_b', { maxRetryAfterMs: bad })).toThrow(RangeError);
      }
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => new ApiKeyPool('sk_a,sk_b', { primaryWeight: bad })).toThrow(RangeError);
      }
      const equal = new ApiKeyPool('sk_a,sk_b', { primaryWeight: 1 });
      expect([equal.next(), equal.next(), equal.next()]).toEqual(['sk_a', 'sk_b', 'sk_a']);
    });

    it('keeps one timer per pool: a second start replaces the first, and its stop ends it', () => {
      const pool = new ApiKeyPool('sk_a,sk_b', { recheckMs: 1000 });
      const before = vi.getTimerCount();
      pool.startRechecks();
      const stop = pool.startRechecks();
      expect(vi.getTimerCount()).toBe(before + 1);
      stop();
      expect(vi.getTimerCount()).toBe(before);
      pool.startRechecks();
      pool.stopRechecks();
      expect(vi.getTimerCount()).toBe(before);
    });

    it('probes a failed key when its recheck is due, not at the next tick of an interval fixed at start', async () => {
      // Started at T=0 with a 30-minute recheck, a key that fails at T=10 is probed at T=40, not at T=60.
      const probe = vi.fn(async (): Promise<ProbeResult> => 'ok');
      const pool = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered', recheckMs: 30 * 60_000, probe });
      pool.startRechecks();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      pool.markFailed('sk_a', 'auth');
      await vi.advanceTimersByTimeAsync(29 * 60_000 + 59_000);
      expect(probe).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1001);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(pool.snapshot()[0].status).toBe('ok');
      // Nothing is failed now: the timer only sweeps.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(probe).toHaveBeenCalledTimes(1);
      pool.stopRechecks();
    });

    it('a stop function of an earlier start leaves a later start running', async () => {
      const probe = vi.fn(async (): Promise<ProbeResult> => 'ok');
      const pool = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered', recheckMs: 1000, probe });
      const stopFirst = pool.startRechecks();
      pool.startRechecks();
      stopFirst();
      pool.markFailed('sk_a', 'auth');
      await vi.advanceTimersByTimeAsync(1001);
      expect(probe).toHaveBeenCalledTimes(1);
      pool.stopRechecks();
    });

    it('ends its timer at its next run once nothing else holds the pool', () => {
      let released = false;
      class FakeWeakRef<T> {
        constructor(private readonly value: T) {}
        deref(): T | undefined {
          return released ? undefined : this.value;
        }
      }
      vi.stubGlobal('WeakRef', FakeWeakRef);
      try {
        const probe = vi.fn(async (): Promise<ProbeResult> => 'ok');
        const pool = new ApiKeyPool('sk_a,sk_b', { recheckMs: 1000, probe });
        pool.markFailed('sk_a', 'auth');
        const before = vi.getTimerCount();
        pool.startRechecks();
        expect(vi.getTimerCount()).toBe(before + 1);
        // A collected pool: the timer finds nothing behind its weak reference and arms no other.
        released = true;
        vi.advanceTimersByTime(1001);
        expect(vi.getTimerCount()).toBe(before);
        expect(probe).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('close() stops the timer, waits for a probe in flight and saves what it found', async () => {
      const store = new InMemoryKeyPoolStateStore();
      let answer: (result: ProbeResult) => void = () => undefined;
      const probe = vi.fn(() => new Promise<ProbeResult>((resolve) => {
        answer = resolve;
      }));
      const pool = new ApiKeyPool('sk_alpha_0001,sk_beta_0002', { strategy: 'ordered', recheckMs: 1000, probe, id: 'p:close', store });
      await pool.ready();
      pool.markFailed('sk_alpha_0001', 'auth');
      pool.startRechecks();
      vi.advanceTimersByTime(1001);
      expect(probe).toHaveBeenCalledTimes(1);
      let closed = false;
      const closing = pool.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      answer('ok');
      await closing;
      expect((await store.load('p:close'))?.map((row) => row.status)).toEqual(['ok']);
      // The timer is gone: time passing starts no further probe.
      pool.markFailed('sk_alpha_0001', 'auth');
      vi.advanceTimersByTime(5000);
      expect(probe).toHaveBeenCalledTimes(1);
    });
  });

  describe('persistence', () => {
    it('saves state changes under the pool id and a new pool over the same store starts from them', async () => {
      const store = new InMemoryKeyPoolStateStore();
      const pool = new ApiKeyPool('sk_alpha_0001,sk_beta_0002', { strategy: 'ordered', id: 'anthropic:ANTHROPIC_API_KEY', store });
      await pool.ready();
      pool.markFailed('sk_alpha_0001', 'billing');
      await vi.advanceTimersByTimeAsync(300);
      const saved = await store.load('anthropic:ANTHROPIC_API_KEY');
      expect(saved).toHaveLength(1);
      expect(saved?.[0]).toMatchObject({ fingerprint: keyFingerprint('sk_alpha_0001'), status: 'failed', kind: 'billing' });
      expect(JSON.stringify(saved)).not.toContain('sk_alpha');

      vi.advanceTimersByTime(10);
      const again = new ApiKeyPool('sk_alpha_0001,sk_beta_0002', { strategy: 'ordered', id: 'anthropic:ANTHROPIC_API_KEY', store });
      await again.ready();
      expect(again.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'billing', label: 'k00001' });
      expect(again.next()).toBe('sk_beta_0002');
    });

    it('flush() writes the pending changes at once and waits for them', async () => {
      const store = new InMemoryKeyPoolStateStore();
      const pool = new ApiKeyPool('sk_alpha_0001,sk_beta_0002', { strategy: 'ordered', id: 'p:flush', store });
      await pool.ready();
      pool.markFailed('sk_alpha_0001', 'auth');
      expect((await store.load('p:flush')) ?? []).toHaveLength(0);
      await pool.flush();
      expect((await store.load('p:flush'))?.map((row) => row.status)).toEqual(['failed']);
      await pool.flush();
    });

    it('ignores rows whose fingerprint matches no configured key, and does nothing without an id', async () => {
      const store = new InMemoryKeyPoolStateStore();
      const first = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered', id: 'p', store });
      await first.ready();
      first.markFailed('sk_b', 'auth');
      await vi.advanceTimersByTimeAsync(300);
      const changed = new ApiKeyPool('sk_a,sk_c', { strategy: 'ordered', id: 'p', store });
      await changed.ready();
      expect(changed.snapshot().map((s) => s.status)).toEqual(['ok', 'ok']);
      const noId = new ApiKeyPool('sk_a,sk_b', { strategy: 'ordered', store });
      await noId.ready();
      noId.markFailed('sk_a', 'auth');
      await vi.advanceTimersByTimeAsync(300);
      expect(await store.load('')).toBeNull();
    });

    it('a load that does not answer within loadTimeoutMs leaves a fresh state and logs once; a late answer changes nothing', async () => {
      const { logger, lines } = recordingLogger();
      let answer: (rows: KeyState[] | null) => void = () => undefined;
      const store = {
        load: vi.fn(() => new Promise<KeyState[] | null>((resolve) => {
          answer = resolve;
        })),
        save: vi.fn(async () => undefined),
      };
      const pool = new ApiKeyPool('sk_alpha_0001,sk_beta_0002', { strategy: 'ordered', id: 'p:slow', store, logger, loadTimeoutMs: 1000 });
      let ready = false;
      const readying = pool.ready().then(() => {
        ready = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(ready).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await readying;
      expect(pool.snapshot().map((s) => s.status)).toEqual(['ok', 'ok']);
      const failed = lines.filter((l) => l.event === 'key_pool.store_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0].meta).toMatchObject({ op: 'load', reason: 'timeout' });
      answer([{ fingerprint: keyFingerprint('sk_alpha_0001'), label: 'k00001', status: 'failed', kind: 'auth', failures: 1, updatedAt: Date.now() + 5000, version: 1 }]);
      await vi.advanceTimersByTimeAsync(10);
      expect(pool.snapshot()[0].status).toBe('ok');
      expect(lines.filter((l) => l.event === 'key_pool.store_failed')).toHaveLength(1);
    });

    it('a store whose load throws before it returns a promise leaves a fresh state and logs once', async () => {
      const { logger, lines } = recordingLogger();
      const store = {
        load: vi.fn((): Promise<KeyState[] | null> => {
          throw new Error('not connected');
        }),
        save: vi.fn(async () => undefined),
      };
      const pool = new ApiKeyPool('sk_alpha_0001,sk_beta_0002', { strategy: 'ordered', id: 'p:sync', store, logger });
      await pool.ready();
      expect(pool.snapshot().map((s) => s.status)).toEqual(['ok', 'ok']);
      expect(lines.filter((l) => l.event === 'key_pool.store_failed' && l.meta?.op === 'load')).toHaveLength(1);
    });

    it('flush() and close() wait at most storeTimeoutMs for the store and log once when it does not answer', async () => {
      const { logger, lines } = recordingLogger();
      const store = { load: vi.fn(async () => null), save: vi.fn(() => new Promise<void>(() => undefined)) };
      const pool = new ApiKeyPool('sk_alpha_0001,sk_beta_0002', { strategy: 'ordered', id: 'p:hang', store, logger, storeTimeoutMs: 1000 });
      await pool.ready();
      pool.markFailed('sk_alpha_0001', 'auth');
      let closed = false;
      const closing = pool.close().then(() => {
        closed = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await closing;
      expect(store.save).toHaveBeenCalledTimes(1);
      expect(lines.filter((l) => l.event === 'key_pool.store_failed' && l.meta?.reason === 'timeout')).toHaveLength(1);
    });

    it('refuses a load or store deadline that is not a positive number of milliseconds', () => {
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => new ApiKeyPool('sk_a,sk_b', { loadTimeoutMs: bad })).toThrow(RangeError);
        expect(() => new ApiKeyPool('sk_a,sk_b', { storeTimeoutMs: bad })).toThrow(RangeError);
      }
    });

    it('keeps a result recorded before the load lands: an old failed row does not undo a fresh success', async () => {
      let answer: (rows: KeyState[] | null) => void = () => undefined;
      const store = {
        load: vi.fn(() => new Promise<KeyState[] | null>((resolve) => {
          answer = resolve;
        })),
        save: vi.fn(async () => undefined),
      };
      const pool = new ApiKeyPool('sk_alpha_0001,sk_beta_0002', { strategy: 'ordered', id: 'p:late', store });
      const readying = pool.ready();
      // A request served while the load is still out (a second initialize on a live provider, a cold database).
      const key = pool.next();
      expect(key).toBe('sk_alpha_0001');
      pool.markSuccess(key);
      const okAt = pool.snapshot()[0].lastOkAt;
      expect(typeof okAt).toBe('number');
      answer([{
        fingerprint: keyFingerprint('sk_alpha_0001'),
        label: 'k00001',
        status: 'failed',
        kind: 'billing',
        failures: 1,
        lastFailAt: Date.now() - 60_000,
        nextRecheckAt: Date.now() + 60_000,
        updatedAt: Date.now() - 60_000,
        version: 1,
      }]);
      await readying;
      expect(pool.snapshot()[0]).toMatchObject({ status: 'ok', failures: 0, lastOkAt: okAt });
      expect(pool.next()).toBe('sk_alpha_0001');
    });

    it('takes a row newer than the result recorded before the load', async () => {
      let answer: (rows: KeyState[] | null) => void = () => undefined;
      const store = {
        load: vi.fn(() => new Promise<KeyState[] | null>((resolve) => {
          answer = resolve;
        })),
        save: vi.fn(async () => undefined),
      };
      const pool = new ApiKeyPool('sk_alpha_0001,sk_beta_0002', { strategy: 'ordered', id: 'p:newer', store });
      const readying = pool.ready();
      pool.markSuccess('sk_alpha_0001', Date.now() - 10_000);
      // Another instance recorded a failure on the key after that success.
      answer([{
        fingerprint: keyFingerprint('sk_alpha_0001'),
        label: 'k00001',
        status: 'failed',
        kind: 'auth',
        failures: 1,
        lastFailAt: Date.now() - 5_000,
        nextRecheckAt: Date.now() + 60_000,
        updatedAt: Date.now() - 5_000,
        version: 1,
      }]);
      await readying;
      expect(pool.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'auth' });
      expect(pool.next()).toBe('sk_beta_0002');
    });

    it('orders a row and the result recorded here by their requests\' start times, never a write time against a start', async () => {
      const deferred = () => {
        let answer: (rows: KeyState[] | null) => void = () => undefined;
        const store = {
          load: vi.fn(() => new Promise<KeyState[] | null>((resolve) => {
            answer = resolve;
          })),
          save: vi.fn(async () => undefined),
        };
        return { store, answer: (rows: KeyState[] | null) => answer(rows) };
      };
      const okRow = (lastOkAt: number, updatedAt: number): KeyState => ({
        fingerprint: keyFingerprint('sk_alpha_0001'),
        label: 'k00001',
        status: 'ok',
        failures: 0,
        lastOkAt,
        updatedAt,
        version: 1,
      });

      // A request on sk_alpha_0001 goes out at `started` while the load is still out.
      const first = deferred();
      const pool = new ApiKeyPool('sk_alpha_0001,sk_beta_0002', { strategy: 'ordered', id: 'p:inflight', store: first.store });
      const readying = pool.ready();
      const started = Date.now();
      vi.advanceTimersByTime(2_000);
      // While it is out, another instance writes a success about a request that started before it.
      const writtenAt = Date.now();
      vi.advanceTimersByTime(2_000);
      // It answers 401: the key was revoked between the two requests.
      pool.markFailed('sk_alpha_0001', 'auth', { at: started });
      first.answer([okRow(started - 1_000, writtenAt)]);
      await readying;
      expect(pool.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'auth' });
      expect(pool.next()).toBe('sk_beta_0002');

      // A row about a request that started after this one's is the later result, and replaces it.
      const second = deferred();
      const other = new ApiKeyPool('sk_alpha_0001,sk_beta_0002', { strategy: 'ordered', id: 'p:inflight-2', store: second.store });
      const readyingOther = other.ready();
      const startedHere = Date.now();
      vi.advanceTimersByTime(2_000);
      other.markFailed('sk_alpha_0001', 'auth', { at: startedHere });
      second.answer([okRow(startedHere + 500, startedHere + 1_000)]);
      await readyingOther;
      expect(other.snapshot()[0]).toMatchObject({ status: 'ok', lastOkAt: startedHere + 500 });
    });

    it('keeps the process alive while it waits on the store, so a short-lived host reaches the deadline and its warning', async () => {
      vi.useRealTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const deadlineOf = (ms: number): NodeJS.Timeout => {
        const index = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === ms);
        expect(index).toBeGreaterThanOrEqual(0);
        return setTimeoutSpy.mock.results[index].value as NodeJS.Timeout;
      };
      try {
        const { logger, lines } = recordingLogger();
        // A store whose calls never settle and that holds no handle of its own.
        const store = {
          load: vi.fn(() => new Promise<KeyState[] | null>(() => undefined)),
          save: vi.fn(() => new Promise<void>(() => undefined)),
        };
        const pool = new ApiKeyPool('sk_alpha_0001,sk_beta_0002', { strategy: 'ordered', id: 'p:alive', store, logger, loadTimeoutMs: 40, storeTimeoutMs: 41 });
        const readying = pool.ready();
        expect(deadlineOf(40).hasRef()).toBe(true);
        await readying;
        pool.markFailed('sk_alpha_0001', 'auth');
        const flushing = pool.flush();
        expect(deadlineOf(41).hasRef()).toBe(true);
        await flushing;
        expect(lines.filter((l) => l.event === 'key_pool.store_failed' && l.meta?.reason === 'timeout').map((l) => l.meta?.op)).toEqual(['load', 'flush']);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it('skips a row of another version with one warning', async () => {
      const { logger, lines } = recordingLogger();
      const store = new InMemoryKeyPoolStateStore();
      await store.save('p:v', { fingerprint: keyFingerprint('sk_alpha_0001'), label: 'k00001', status: 'failed', kind: 'auth', failures: 1, updatedAt: Date.now(), version: 2 as unknown as 1 });
      const pool = new ApiKeyPool('sk_alpha_0001,sk_beta_0002', { strategy: 'ordered', id: 'p:v', store, logger });
      await pool.ready();
      expect(pool.snapshot()[0].status).toBe('ok');
      const warned = lines.filter((l) => l.event === 'key_pool.store_failed');
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatchObject({ level: 'warn', meta: { op: 'load', reason: 'version', version: 2 } });
    });

    it('a store that throws on load leaves a fresh pool and logs once; a failing save logs at most once a minute', async () => {
      const { logger, lines } = recordingLogger();
      const store = {
        load: vi.fn(async () => { throw new Error('db down'); }),
        save: vi.fn(async () => { throw new Error('db down'); }),
      };
      const pool = new ApiKeyPool('sk_alpha_0001,sk_beta_0002', { strategy: 'ordered', id: 'p', store, logger });
      await pool.ready();
      expect(pool.snapshot().map((s) => s.status)).toEqual(['ok', 'ok']);
      expect(lines.filter((l) => l.event === 'key_pool.store_failed')).toHaveLength(1);
      pool.markFailed('sk_alpha_0001', 'quota');
      await vi.advanceTimersByTimeAsync(300);
      pool.markFailed('sk_beta_0002', 'quota');
      await vi.advanceTimersByTimeAsync(300);
      expect(lines.filter((l) => l.event === 'key_pool.store_failed')).toHaveLength(2);
      expect(JSON.stringify(lines)).not.toContain('sk_alpha');
    });
  });

  describe('the strategy from the environment', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('takes the provider\'s own variable over the shared one, and names round-robin too', () => {
      vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY', 'ordered');
      expect(keyPoolStrategyFromEnv('anthropic')).toEqual({ strategy: 'ordered' });
      vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY_OPENAI', 'round-robin');
      expect(keyPoolStrategyFromEnv('openai')).toEqual({ strategy: 'round-robin' });
      expect(keyPoolStrategyFromEnv('gemini')).toEqual({ strategy: 'ordered' });
      vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY', 'nonsense');
      expect(keyPoolStrategyFromEnv('gemini')).toEqual({});
    });
  });

  describe('logging', () => {
    it('logs every transition, throttles repeats, and never writes a key', () => {
      const { logger, lines } = recordingLogger();
      const pool = new ApiKeyPool('sk_secret_a,sk_secret_b', { strategy: 'ordered', cooldownMs: 60_000, logger });
      pool.markFailed('sk_secret_a', 'auth');
      pool.markFailed('sk_secret_a', 'auth');
      pool.markFailed('sk_secret_a', 'auth');
      const failed = lines.filter((l) => l.event === 'key_pool.key_failed');
      expect(failed).toHaveLength(1);
      pool.markSuccess('sk_secret_a');
      expect(lines.filter((l) => l.event === 'key_pool.key_recovered')).toHaveLength(1);
      pool.markFailed('sk_secret_a', 'auth');
      expect(lines.filter((l) => l.event === 'key_pool.key_failed')).toHaveLength(2);
      pool.markFailed('sk_secret_b', 'billing');
      expect(lines.filter((l) => l.event === 'key_pool.all_keys_failed')).toHaveLength(1);
      // The all-keys line is written once, when the last usable key goes out, not on every repeat.
      pool.markFailed('sk_secret_b', 'billing');
      pool.markFailed('sk_secret_a', 'auth');
      expect(lines.filter((l) => l.event === 'key_pool.all_keys_failed')).toHaveLength(1);
      // A single-key pool keeps sending its key and writes no all-keys line.
      const single = recordingLogger();
      const one = new ApiKeyPool('sk_secret_only', { cooldownMs: 60_000, logger: single.logger });
      one.markExhausted('sk_secret_only');
      one.markExhausted('sk_secret_only');
      expect(single.lines.filter((l) => l.event === 'key_pool.all_keys_failed')).toHaveLength(0);
      expect(JSON.stringify(lines)).not.toContain('sk_secret');
      expect(JSON.stringify(lines)).toContain('k0et_a');
    });
  });
});
