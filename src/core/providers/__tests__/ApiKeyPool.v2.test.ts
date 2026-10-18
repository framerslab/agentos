import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyPool, keyFingerprint, keyPoolStrategyFromEnv, type ProbeResult } from '../ApiKeyPool.js';
import { InMemoryKeyPoolStateStore } from '../KeyPoolStateStore.js';
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
