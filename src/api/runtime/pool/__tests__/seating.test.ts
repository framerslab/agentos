import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeatingState, seatRoster, type SeatedConfig } from '../seating.js';
import { TEXT_PROVIDER_IDS } from '../resolve.js';
import { providerEnvVars } from '../../../model.js';
import { globalLLMProviderHealth } from '../../../../core/safety/LLMProviderHealthRegistry.js';
import type { AgencyOptions, AgencySeatConfig } from '../../../types.js';

const POOL = { opus: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-00000001', weight: 2 }, astra: { provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-oai-00000002', weight: 1 }, gemini: { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'gem-00000003', weight: 1 } };
const mask = (e: unknown) => e;
const seat = (opts: Partial<AgencyOptions>, strategy: AgencyOptions['strategy'] = 'sequential', callOpts: Record<string, unknown> = {}, deps: { binaryOnPath: (name: string) => boolean } = { binaryOnPath: () => false }) => {
  // A panel seats its chair from `chair` or the agency level; with neither, construction would have failed,
  // so a panel here has no chair unless the test gives one (or `chair: undefined` for the agency level).
  const agency = { agents: {}, modelPool: POOL, ...(strategy === 'panel' ? { chair: false as const } : {}), ...opts } as AgencyOptions;
  const state = createSeatingState(agency, strategy ?? 'sequential', deps);
  return { agency, state, run: () => seatRoster(agency, state, strategy ?? 'sequential', callOpts, mask, deps) };
};
const entries = (r: ReturnType<ReturnType<typeof seat>['run']>) => Object.fromEntries(Object.entries(r.record.seats).map(([k, v]) => [k, v.entry]));
const prebuilt = () => ({ generate: async () => ({}), stream: () => ({}), session: () => ({}), usage: async () => ({}), close: async () => {} });

// Seating reads keys and URLs from the environment: every text provider's variables start empty, so the
// shell that runs the tests cannot change a result.
beforeEach(() => {
  globalLLMProviderHealth.reset();
  for (const provider of TEXT_PROVIDER_IDS) {
    const { key, url } = providerEnvVars(provider);
    if (key) vi.stubEnv(key, '');
    if (url) vi.stubEnv(url, '');
  }
});
afterEach(() => vi.unstubAllEnvs());

describe('policies', () => {
  const three = { a: { instructions: '1' }, b: { instructions: '2' }, c: { instructions: '3' } };
  it("preferred with distinct false puts every seat on the first available entry; under panel 'vendor' spreads them", () => {
    const s = seat({ agents: three }); expect(entries(s.run())).toEqual({ a: 'opus', b: 'opus', c: 'opus' });
    const p = seat({ agents: three }, 'panel'); expect(entries(p.run())).toEqual({ a: 'opus', b: 'astra', c: 'gemini' });
    expect(p.state.distinct).toBe('vendor'); expect(s.state.distinct).toBe(false);
  });
  it('a seed gives the same sequence on two instances and different seatings on successive calls; numeric and string seeds are reported', () => {
    const mk = () => seat({ agents: three, seating: { policy: 'weighted', seed: 7, distinct: false } });
    // One call after another: each seating is committed before the next call seats.
    const calls = (s: ReturnType<typeof mk>) => Array.from({ length: 5 }, () => { const r = s.run(); r.commit(); return entries(r); });
    const x = mk(), y = mk();
    const xs = calls(x);
    expect(xs).toEqual(calls(y));
    expect(new Set(xs.map((e) => JSON.stringify(e))).size).toBeGreaterThan(1);
    const r = x.run(); expect(r.record).toMatchObject({ seed: 7, seedUsed: 7, call: 5 });
    const str = seat({ agents: three, seating: { policy: 'random', seed: 'seven' } }).run();
    expect(str.record.seed).toBe('seven'); expect(typeof str.record.seedUsed).toBe('number'); expect(str.record.seedUsed).not.toBe(7);
    const drawn = seat({ agents: three, seating: { policy: 'weighted' } }).run();
    expect(typeof drawn.record.seed).toBe('number');
  });
  it('a 3:1 weight ratio holds over 2,000 seeded calls', () => {
    const s = seat({ modelPool: { a: { ...POOL.opus, weight: 3 }, b: { ...POOL.astra, weight: 1 } }, agents: { x: { instructions: '1' } }, seating: { policy: 'weighted', seed: 1, distinct: false } });
    let a = 0; for (let i = 0; i < 2000; i++) { const r = s.run(); r.commit(); if (r.record.seats.x.entry === 'a') a++; }
    expect(a / 2000).toBeGreaterThan(0.7); expect(a / 2000).toBeLessThan(0.8);
  });
  it('round-robin: {a: 2, b: 1} over one seat and over three seats with offsets by roster order', () => {
    const pool = { a: { ...POOL.opus, weight: 2 }, b: { ...POOL.astra, weight: 1 } };
    const one = seat({ modelPool: pool, agents: { x: { instructions: '1' } }, seating: { policy: 'round-robin', distinct: false } });
    const seq = Array.from({ length: 6 }, () => { const r = one.run(); r.commit(); return r.record.seats.x.entry; });
    expect(seq).toEqual(['a', 'b', 'a', 'a', 'b', 'a']);
    const threeSeats = seat({ modelPool: pool, agents: { s1: { instructions: '1' }, s2: { instructions: '2' }, s3: { instructions: '3' } }, seating: { policy: 'round-robin', distinct: false } });
    const rows = Array.from({ length: 3 }, () => { const r = threeSeats.run(); r.commit(); return [r.record.seats.s1.entry, r.record.seats.s2.entry, r.record.seats.s3.entry]; });
    expect(rows).toEqual([['a', 'b', 'a'], ['b', 'a', 'a'], ['a', 'a', 'b']]);
  });
  it('the debate example swaps sides by rotation over four calls', () => {
    // Equal weights, as the spec's debate example declares none: the strict alternation holds only then.
    const s = seat({ modelPool: { opus: { ...POOL.opus, weight: 1 }, gemini: { ...POOL.gemini, weight: 1 } }, agents: { proponent: { instructions: 'p' }, critic: { instructions: 'c' } }, seating: { policy: 'round-robin' } }, 'debate');
    const rows = Array.from({ length: 4 }, () => { const r = s.run(); r.commit(); return [r.record.seats.proponent.entry, r.record.seats.critic.entry]; });
    expect(rows).toEqual([['opus', 'gemini'], ['gemini', 'opus'], ['opus', 'gemini'], ['gemini', 'opus']]);
  });
  it('a passed-over candidate keeps its total; an unavailable one does not move', () => {
    const pool = { a: { ...POOL.opus, weight: 1 }, b: { ...POOL.astra, weight: 1 } };
    const s = seat({ modelPool: pool, agents: { x: { instructions: '1' } }, seating: { policy: 'round-robin', distinct: false } });
    let r = s.run(); r.commit(); expect(r.record.seats.x.entry).toBe('a');
    globalLLMProviderHealth.recordFailure('openai', Object.assign(new Error('401'), { httpStatus: 401 }));
    r = s.run(); r.commit(); expect(r.record.seats.x.entry).toBe('a'); expect(r.record.skipped).toEqual([{ entry: 'b', reason: 'circuit open' }]);
    globalLLMProviderHealth.reset();
    r = s.run(); r.commit(); expect(r.record.seats.x.entry).toBe('b');
  });
});

describe('distinct and filling order', () => {
  it('fills the most constrained seat first and holds fixed seats vendors first', () => {
    const s = seat({ agents: { free: { instructions: 'f' }, pinned: { instructions: 'p', from: ['opus'] }, fixed: { provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-fixed-00000004', instructions: 'x' } } }, 'panel');
    const r = s.run();
    expect(r.record.seats.pinned.entry).toBe('opus');
    expect(r.record.seats.free.entry).toBe('gemini');
    expect(r.record.seats.fixed).toMatchObject({ fixed: true, provider: 'openai', vendor: 'openai' });
  });
  it('the three-step preference: a new group, then a new entry, then any', () => {
    const pool = { a1: POOL.opus, a2: { ...POOL.opus, apiKey: 'sk-ant-00000005' }, b: POOL.astra };
    const s = seat({ modelPool: pool, agents: { s1: { instructions: '1' }, s2: { instructions: '2' }, s3: { instructions: '3' }, s4: { instructions: '4' } } }, 'panel');
    expect(Object.values(entries(s.run()))).toEqual(['a1', 'b', 'a2', 'a1']);
  });
  it('unknown vendors compare by provider and model; distinct model equates gpt-4.1 with openai/gpt-4.1', () => {
    const pool = { o1: { provider: 'ollama', model: 'llama3.2', baseUrl: 'http://127.0.0.1:11434' }, o2: { provider: 'ollama', model: 'qwen2.5:7b', baseUrl: 'http://127.0.0.1:11434' } };
    const s = seat({ modelPool: pool, agents: { s1: { instructions: '1' }, s2: { instructions: '2' } } }, 'panel');
    expect(Object.values(entries(s.run()))).toEqual(['o1', 'o2']);
    const m = seat({ modelPool: { a: POOL.astra, b: { provider: 'openrouter', model: 'openai/gpt-4.1', apiKey: 'sk-or-00000006' }, c: POOL.opus }, agents: { s1: { instructions: '1' }, s2: { instructions: '2' } }, seating: { distinct: 'model' } }, 'panel');
    expect(Object.values(entries(m.run()))).toEqual(['a', 'c']);
  });
  it('a changed set of available entries gives a different, still deterministic seating; skipped entries carry reasons', () => {
    const mk = () => seat({ modelPool: { opus: { provider: 'anthropic', model: 'claude-opus-5-5' }, astra: POOL.astra, gemini: POOL.gemini }, agents: { s1: { instructions: '1' }, s2: { instructions: '2' } }, seating: { policy: 'weighted', seed: 3 } }, 'panel');
    const without = mk().run();
    expect(without.record.skipped).toEqual([{ entry: 'opus', reason: 'no key (ANTHROPIC_API_KEY)' }]);
    expect(without.record.available).toEqual(['astra', 'gemini']);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env-00000007');
    const withKey = mk().run();
    expect(withKey.record.available).toEqual(['opus', 'astra', 'gemini']);
    expect(mk().run().record.seats).toEqual(withKey.record.seats);
  });
});

describe('what seating writes', () => {
  it('the seated config holds provider, model, apiKey and baseUrl as own properties, the entry defaults, strict and the mask', () => {
    const s = seat({ modelPool: { astra: { ...POOL.astra, effort: 'high', maxTokens: 500 } }, agents: { x: { instructions: 'i', maxTokens: 900 } }, apiKey: 'sk-agency-00000008', baseUrl: 'https://agency.local/v1' });
    const cfg = s.run().roster.x as SeatedConfig;
    for (const k of ['provider', 'model', 'apiKey', 'baseUrl']) expect(Object.prototype.hasOwnProperty.call(cfg, k)).toBe(true);
    expect(cfg).toMatchObject({ provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-oai-00000002', baseUrl: undefined, effort: 'high', maxTokens: 900, __strictCredentials: true });
    expect(typeof cfg.__maskError).toBe('function');
    expect(cfg.from).toBeUndefined();
  });
  it('the seated roster, the record and the unseated list keep the roster order, whatever the filling order', () => {
    const agents = { free: { instructions: 'f' }, pinned: { instructions: 'p', from: ['opus'] }, cut: { provider: 'mistral', model: 'mistral-large-latest', instructions: 'm' }, fixed: { provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-fixed-00000015', instructions: 'x' }, pre: prebuilt() };
    const r = seat({ agents: agents as never }, 'panel').run();
    expect(Object.keys(r.roster)).toEqual(['free', 'pinned', 'fixed', 'pre']);
    expect(Object.keys(r.record.seats)).toEqual(['free', 'pinned', 'cut', 'fixed', 'pre']);
    expect(r.unseated).toEqual({ cut: 'no key (MISTRAL_API_KEY)' });
  });
  it('the failover chain of a pooled seat outside panel: other available candidates, each with its key, effort from the call, the seat, then the entry', () => {
    const pool = { opus: { ...POOL.opus, effort: 'low' }, astra: { ...POOL.astra, effort: 'medium' }, gemini: POOL.gemini };
    const chain = (callOpts: Record<string, unknown>, seatEffort?: string) => (seat({ modelPool: pool, agents: { x: { instructions: 'i', ...(seatEffort ? { effort: seatEffort } : {}) } }, seating: { policy: 'preferred', distinct: false } }, 'sequential', callOpts).run().roster.x as AgencySeatConfig).fallbackProviders!;
    expect(chain({}).map((h) => [h.provider, h.model, h.apiKey, h.effort])).toEqual([['openai', 'gpt-4.1', 'sk-oai-00000002', 'medium'], ['gemini', 'gemini-2.5-flash', 'gem-00000003', undefined]]);
    expect(chain({}, 'high').map((h) => h.effort)).toEqual(['high', 'high']);
    expect(chain({ effort: 'xhigh' }, 'high').map((h) => h.effort)).toEqual(['xhigh', 'xhigh']);
    const byWeight = seat({ modelPool: { a: { ...POOL.gemini, weight: 1 }, b: { ...POOL.opus, weight: 5 }, c: { ...POOL.astra, weight: 2 } }, agents: { x: { instructions: 'i', from: ['a', 'b', 'c'] } }, seating: { policy: 'random', seed: 1, distinct: false } }).run();
    const x = byWeight.roster.x as AgencySeatConfig;
    const others = ['a', 'b', 'c'].filter((e) => e !== byWeight.record.seats.x.entry);
    const expectedOrder = others.sort((p, q) => ({ a: 1, b: 5, c: 2 })[q as 'a' | 'b' | 'c'] - ({ a: 1, b: 5, c: 2 })[p as 'a' | 'b' | 'c']);
    expect(x.fallbackProviders!.map((h) => ({ a: 'gemini', b: 'anthropic', c: 'openai' })[expectedOrder.shift()! as 'a' | 'b' | 'c'] === h.provider)).toEqual([true, true]);
    const single = seat({ modelPool: { astra: POOL.astra }, agents: { x: { instructions: 'i' } } }).run().roster.x as AgencySeatConfig;
    expect(single.fallbackProviders).toEqual([]);
    const underPanel = seat({ modelPool: pool, agents: { x: { instructions: 'i' } } }, 'panel').run().roster.x as AgencySeatConfig;
    expect(underPanel.fallbackProviders).toEqual([]);
  });
  it("a fixed seat's own chain is resolved hop by hop; a keyless hop is dropped and listed; no chain means [] under panel and the default outside", () => {
    vi.stubEnv('GEMINI_API_KEY', 'gem-env-00000009');
    const chain = Object.freeze([{ provider: 'mistral', model: 'mistral-large-latest' }, { provider: 'gemini', model: 'gemini-2.5-flash' }]);
    const r = seat({ agents: { f: { provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-fixed-00000010', instructions: 'x', fallbackProviders: chain as never } } }, 'panel').run();
    const f = r.roster.f as AgencySeatConfig;
    expect(f.fallbackProviders).toEqual([{ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'gem-env-00000009', baseUrl: undefined }]);
    expect(r.record.skipped).toContainEqual({ entry: 'f/fallbackProviders/0', reason: 'no key (MISTRAL_API_KEY)' });
    expect(chain).toHaveLength(2);
    expect((seat({ agents: { f: { provider: 'openai', model: 'gpt-4.1', apiKey: 'k-00000011', instructions: 'x' } } }, 'panel').run().roster.f as AgencySeatConfig).fallbackProviders).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(seat({ agents: { f: { provider: 'openai', model: 'gpt-4.1', apiKey: 'k-00000011', instructions: 'x' } } }).run().roster.f, 'fallbackProviders')).toBe(false);
    // Only the key and URL are written into a hop: one with no model keeps none, so the walker runs the
    // provider's default model, even on the agency-level provider.
    const modelless = seat({ provider: 'openai', model: 'gpt-4.1', agents: { f: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-00000013', instructions: 'x', fallbackProviders: [{ provider: 'openai', apiKey: 'sk-oai-00000014' }] } } }).run();
    expect((modelless.roster.f as AgencySeatConfig).fallbackProviders).toEqual([{ provider: 'openai', apiKey: 'sk-oai-00000014', baseUrl: undefined }]);
  });
  it("a fixed seat's hop is kept on the availability rule, not on a key: an Ollama hop with a URL and a CLI hop with its binary stay; a CLI hop without it is dropped", () => {
    const chain = [{ provider: 'ollama', model: 'llama3.2', baseUrl: 'http://127.0.0.1:11434' }, { provider: 'claude-code-cli', model: 'claude-sonnet-4-6' }];
    const cfg = { agents: { f: { provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-fixed-00000010', instructions: 'x', fallbackProviders: chain as never } } };
    const kept = seat(cfg, 'panel', {}, { binaryOnPath: () => true }).run();
    expect((kept.roster.f as AgencySeatConfig).fallbackProviders!.map((h) => h.provider)).toEqual(['ollama', 'claude-code-cli']);
    expect((kept.roster.f as AgencySeatConfig).fallbackProviders![0].baseUrl).toBe('http://127.0.0.1:11434');
    expect((kept.roster.f as AgencySeatConfig).fallbackProviders![0].apiKey).toBeUndefined();
    expect(kept.record.skipped).toEqual([]);
    const dropped = seat(cfg, 'panel').run();
    expect((dropped.roster.f as AgencySeatConfig).fallbackProviders!.map((h) => h.provider)).toEqual(['ollama']);
    expect(dropped.record.skipped).toContainEqual({ entry: 'f/fallbackProviders/1', reason: 'binary not found (claude)' });
  });
  it('a seat that cannot be seated: unseated under panel, AgencySeatingError elsewhere, and a failed seating commits nothing', () => {
    const pool = { opus: { provider: 'anthropic', model: 'claude-opus-5-5' }, astra: POOL.astra };
    const p = seat({ modelPool: pool, agents: { x: { instructions: 'i', from: ['opus'] }, y: { instructions: 'j' } }, seating: { policy: 'round-robin' } }, 'panel').run();
    expect(p.record.seats.x).toEqual({ unseated: true, reason: 'no available entry (opus: no key (ANTHROPIC_API_KEY))' });
    expect(p.unseated).toEqual({ x: 'no available entry (opus: no key (ANTHROPIC_API_KEY))' });
    const s = seat({ modelPool: pool, agents: { x: { instructions: 'i', from: ['opus'] } }, seating: { policy: 'round-robin' } });
    expect(() => s.run()).toThrow(/cannot be seated/);
    expect(s.state.call).toBe(0);
    const fixedNoKey = seat({ agents: { f: { provider: 'mistral', model: 'mistral-large-latest', instructions: 'x' } } }, 'panel').run();
    expect(fixedNoKey.record.seats.f).toEqual({ unseated: true, reason: 'no key (MISTRAL_API_KEY)' });
  });
  it('the chair is seated from its from list with the preferred rule, or from the agency level; an unseatable chair throws', () => {
    const r = seat({ agents: { x: { instructions: 'i' } }, chair: { from: ['gemini', 'opus'], instructions: 'merge' } }, 'panel').run();
    expect(r.chair).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'gem-00000003', instructions: 'merge', fallbackProviders: [], __strictCredentials: true });
    // The entry's defaults reach the chair for what it sets none of; its own values win.
    const defaults = { gemini: { ...POOL.gemini, effort: 'low', thinking: false as const, maxTokens: 700 } };
    expect(seat({ modelPool: defaults, agents: { x: { instructions: 'i' } }, chair: { from: ['gemini'] } }, 'panel').run().chair).toMatchObject({ effort: 'low', thinking: false, maxTokens: 700 });
    expect(seat({ modelPool: defaults, agents: { x: { instructions: 'i' } }, chair: { from: ['gemini'], maxTokens: 300 } }, 'panel').run().chair).toMatchObject({ effort: 'low', maxTokens: 300 });
    const level = seat({ provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-agency-00000012', agents: { x: { instructions: 'i' } }, chair: undefined }, 'panel').run();
    expect(level.chair).toMatchObject({ provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-agency-00000012' });
    expect(() => seat({ modelPool: { opus: { provider: 'anthropic', model: 'claude-opus-5-5' }, astra: POOL.astra }, agents: { x: { instructions: 'i' } }, chair: { from: ['opus'] } }, 'panel').run()).toThrow(/Seat "chair" cannot be seated/);
    expect(seat({ agents: { x: { instructions: 'i' } }, chair: false }, 'panel').run().chair).toBe(false);
  });
  it("the chair's line names the entry it sat on and that entry's declared vendor, or its own provider, model and vendor", () => {
    const pool = { ...POOL, local: { provider: 'ollama', model: 'llama3.2', baseUrl: 'http://127.0.0.1:11434', vendor: 'meta' } };
    const onEntry = seat({ modelPool: pool, agents: { x: { instructions: 'i' } }, chair: { from: ['local'] } }, 'panel').run();
    expect(onEntry.chairSeat).toEqual({ entry: 'local', provider: 'ollama', model: 'llama3.2', vendor: 'meta', fixed: false });
    const level = seat({ provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-agency-00000012', agents: { x: { instructions: 'i' } }, chair: undefined }, 'panel').run();
    expect(level.chairSeat).toEqual({ provider: 'openai', model: 'gpt-4.1', vendor: 'openai', fixed: true });
    const own = seat({ agents: { x: { instructions: 'i' } }, chair: { provider: 'ollama', model: 'qwen2.5:7b', baseUrl: 'http://127.0.0.1:11434', vendor: 'Qwen' } }, 'panel').run();
    expect(own.chairSeat).toEqual({ provider: 'ollama', model: 'qwen2.5:7b', vendor: 'qwen', fixed: true });
    expect(seat({ agents: { x: { instructions: 'i' } }, chair: false }, 'panel').run().chairSeat).toBeUndefined();
  });
  it('seating never writes the roster, and the record names pre-built seats', () => {
    const pre = prebuilt();
    const roster = { x: { instructions: 'i' }, pre };
    const snapshot = JSON.stringify(roster);
    const r = seat({ agents: roster as never }, 'panel').run();
    expect(JSON.stringify(roster)).toBe(snapshot);
    expect(r.roster.pre).toBe(pre);
    expect(r.record.seats.pre).toEqual({ prebuilt: true });
    expect(r.secrets).toEqual(expect.arrayContaining(['sk-ant-00000001']));
  });
});
