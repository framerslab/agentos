/**
 * @fileoverview Seating: for one call, which pool entry sits in every pooled
 * seat, with the resolved provider, model, key and URL written as own
 * properties onto a copy of each config seat and of the chair. Synchronous,
 * never writes the caller's objects, and commits its round-robin state and
 * the call number only when the whole seating succeeds.
 */
import type { AgencyOptions, AgencySeatConfig, AgencyStrategy, Agent, ModelPoolEntry, SeatingRecord, SeatingSeatRecord } from '../../types.js';
import { AgencySeatingError } from '../../types.js';
import type { FallbackProviderEntry } from '../../generateText.js';
import { baseUrlCredentials } from '../../../core/llm/providers/url-secrets.js';
import { isAgent } from '../strategies/shared.js';
import { resolveSeatCredentials, availabilityOf, type ResolvedCredentials } from './resolve.js';
import { vendorOf } from './vendor.js';
import { isPooledSeat } from './validate.js';
import { callRng, drawSeed, seedToUint32 } from './prng.js';

/** How a pooled seat picks among its candidates: `preferred`, `weighted`, `round-robin` or `random`. */
export type SeatingPolicy = SeatingRecord['policy'];
/** What the seats of one call are kept apart by: vendor, provider, model, or nothing (`false`). */
export type Distinct = SeatingRecord['distinct'];

/** Internal fields seating writes onto every seated config and the chair. */
export interface SeatInternals {
  /** Every hop of the seat's calls resolves its key strictly: no provider-less default, no reroute. */
  __strictCredentials: true;
  /** Masks the call's credentials out of an error before it leaves the seat. */
  __maskError: (error: unknown) => unknown;
}

/** A config seat or the chair after seating: its provider, model, key and URL as own properties, and the internal fields. */
export type SeatedConfig = AgencySeatConfig & SeatInternals;

/** Replacements for the binary probe and the breaker check. */
export interface SeatingDeps {
  /** Whether a CLI provider's binary is on PATH. Default: the cached probe. */
  binaryOnPath?: (name: string) => boolean;
  /** Whether a provider's circuit breaker is open. Default: the process-wide health registry. */
  breakerOpen?: (provider: string) => boolean;
}

/** Per-instance state: policy, seed, call counter and round-robin totals. */
export interface SeatingState {
  policy: SeatingPolicy;
  distinct: Distinct;
  /** As configured, or drawn at construction; for `weighted` and `random`. */
  seed?: number | string;
  /** The 32-bit value the draws use. */
  seedUsed?: number;
  /** The number the next call takes, from 0. */
  call: number;
  /** Per pooled seat: running totals per entry (smooth weighted round-robin). */
  roundRobin: Map<string, Map<string, number>>;
}

const weightOf = (e: ModelPoolEntry): number => e.weight ?? 1;

/**
 * Builds the state at construction: the defaults per strategy, the seed, and
 * the round-robin offsets (pooled seat number `i`, in roster order, starts `i`
 * steps ahead over its full candidate list).
 *
 * @param opts - The agency options.
 * @param strategy - The strategy the agency runs.
 * @param _deps - Unused; kept so construction and seating take the same arguments.
 * @returns The state {@link seatRoster} reads and commits to.
 */
export function createSeatingState(opts: AgencyOptions, strategy: AgencyStrategy, _deps: SeatingDeps = {}): SeatingState {
  const policy: SeatingPolicy = opts.seating?.policy ?? 'preferred';
  const configured = opts.seating?.distinct;
  const distinct: Distinct = configured !== undefined ? configured : strategy === 'panel' || strategy === 'parallel' ? 'vendor' : false;
  const state: SeatingState = { policy, distinct, call: 0, roundRobin: new Map() };
  if (policy === 'weighted' || policy === 'random') {
    const seed = opts.seating?.seed ?? drawSeed();
    state.seed = seed;
    state.seedUsed = seedToUint32(seed);
  }
  const pool = opts.modelPool;
  if (policy === 'round-robin' && pool) {
    let i = 0;
    for (const [name, seat] of Object.entries(opts.agents)) {
      if (!isPooledSeat(seat, opts)) continue;
      const candidates = seat.from ?? Object.keys(pool);
      const totals = new Map<string, number>(candidates.map((c) => [c, 0]));
      for (let step = 0; step < i; step++) roundRobinStep(totals, candidates, candidates, pool);
      state.roundRobin.set(name, totals);
      i++;
    }
  }
  return state;
}

/** One smooth weighted round-robin step over `available`, choosing among `allowed`; returns the winner. */
function roundRobinStep(totals: Map<string, number>, available: string[], allowed: string[], pool: Record<string, ModelPoolEntry>): string {
  let sum = 0;
  for (const c of available) {
    totals.set(c, (totals.get(c) ?? 0) + weightOf(pool[c]));
    sum += weightOf(pool[c]);
  }
  let winner = allowed[0];
  for (const c of allowed) if ((totals.get(c) ?? 0) > (totals.get(winner) ?? 0)) winner = c;
  totals.set(winner, (totals.get(winner) ?? 0) - sum);
  return winner;
}

/** What one call's seating produced. */
export interface SeatedRoster {
  /** The roster in the caller's order: seated copies of the config seats, pre-built seats as they are; no unseated seat. */
  roster: Record<string, SeatedConfig | Agent>;
  /** The seated chair config, `false` for no chair, undefined outside `panel`. */
  chair?: SeatedConfig | false;
  record: SeatingRecord;
  /** Seats that could not be seated, with the reason (panel only; elsewhere seating throws). */
  unseated: Record<string, string>;
  /** Every key and URL credential resolved for a seat, a hop or the chair. */
  secrets: string[];
  /** The mask every seated config carries; the panel and the hierarchical delegate tool apply it to errors of agents that were never seated. */
  mask: (error: unknown) => unknown;
  /** Applies the round-robin totals and the call number. Called once per successful seating. */
  commit(): void;
}

interface Candidate { name: string; entry: ModelPoolEntry; creds: ResolvedCredentials; vendor?: string }

function distinctKey(distinct: Distinct, c: { provider: string; model: string; vendor?: string }): string | undefined {
  if (distinct === false) return undefined;
  if (distinct === 'provider') return `provider:${c.provider}`;
  if (distinct === 'model') return `model:${c.model.slice(c.model.lastIndexOf('/') + 1).toLowerCase()}`;
  // An unknown vendor is compared by provider and model.
  return c.vendor ? `vendor:${c.vendor}` : `unknown:${c.provider}/${c.model}`;
}

/**
 * Seats the roster for one call. Throws {@link AgencySeatingError} outside
 * `panel` for a seat with no available candidate or a fixed seat whose
 * provider's requirement is unmet, and for an unseatable chair under `panel`.
 * Nothing is committed until {@link SeatedRoster.commit} runs.
 *
 * @param opts - The agency options; never written.
 * @param state - The instance's state from {@link createSeatingState}.
 * @param strategy - The strategy the agency runs.
 * @param callOpts - The call's own options; a per-call `effort` sets every hop's.
 * @param mask - The call's error mask, written onto every seated config.
 * @param deps - Replacements for the binary probe and the breaker check.
 * @returns The seated roster, the chair, the record and what the redactor needs.
 */
export function seatRoster(
  opts: AgencyOptions,
  state: SeatingState,
  strategy: AgencyStrategy,
  callOpts: Record<string, unknown> | undefined,
  mask: (error: unknown) => unknown,
  deps: SeatingDeps = {},
): SeatedRoster {
  const pool = opts.modelPool ?? {};
  const poolOrder = Object.keys(pool);
  const isPanel = strategy === 'panel';
  const secrets = new Set<string>();
  const skipped: SeatingRecord['skipped'] = [];
  const addSecrets = (c: { apiKey?: string; baseUrl?: string }) => {
    if (c.apiKey) secrets.add(c.apiKey);
    const credentials = baseUrlCredentials(c.baseUrl);
    if (credentials) secrets.add(credentials);
  };
  // A fixed seat and a hop are kept on the availability rule alone: the breaker is not consulted for
  // them at seating, since the walker's own check skips an open provider at call time.
  const ruleOnly: SeatingDeps = { ...deps, breakerOpen: () => false };
  const effortOption = callOpts?.effort;
  const callEffort = typeof effortOption === 'string' ? effortOption : undefined;

  // 1. Availability of every pool entry, in pool order.
  const available: Candidate[] = [];
  const skipReason = new Map<string, string>();
  for (const [name, entry] of Object.entries(pool)) {
    const resolved = resolveSeatCredentials({ provider: entry.provider, model: entry.model, apiKey: entry.apiKey, baseUrl: entry.baseUrl, inherits: false }, opts);
    const reason = resolved.ok ? availabilityOf(resolved.value, deps) : resolved.reason;
    if (!resolved.ok || reason) {
      skipped.push({ entry: name, reason: reason ?? 'unavailable' });
      skipReason.set(name, reason ?? 'unavailable');
      continue;
    }
    addSecrets(resolved.value);
    available.push({ name, entry, creds: resolved.value, vendor: vendorOf(resolved.value.provider, resolved.value.model, { vendor: entry.vendor, baseUrl: resolved.value.baseUrl }) });
  }
  const availableByName = new Map<string, Candidate>(available.map((c) => [c.name, c]));
  const noEntryReason = (names: string[]): string => `no available entry (${names.map((c) => `${c}: ${skipReason.get(c) ?? 'unavailable'}`).join('; ')})`;

  const seats: Record<string, SeatingSeatRecord> = {};
  const roster: Record<string, SeatedConfig | Agent> = {};
  const unseated: Record<string, string> = {};
  const held = new Set<string>();        // distinct keys held
  const heldEntries = new Set<string>(); // entry names held
  const rng = state.seedUsed !== undefined ? callRng(state.seedUsed, state.call) : undefined;
  const nextTotals = new Map<string, Map<string, number>>();

  // A new array of new entries: a hop that fails the availability rule (a key for an API provider, a URL
  // for ollama, the binary for a CLI provider) is dropped for this call and listed; a kept hop gets its key
  // and URL written in, and keeps the rest as written (its model, a declared vendor, its effort).
  const resolveHops = (owner: string, chain: FallbackProviderEntry[] | undefined): FallbackProviderEntry[] | undefined => {
    if (!chain) return undefined;
    const out: FallbackProviderEntry[] = [];
    chain.forEach((hop, i) => {
      const r = resolveSeatCredentials({ provider: hop.provider, model: hop.model, apiKey: hop.apiKey, baseUrl: hop.baseUrl, inherits: false }, opts);
      const reason = r.ok ? availabilityOf(r.value, ruleOnly) : r.reason;
      if (!r.ok || reason) {
        skipped.push({ entry: `${owner}/fallbackProviders/${i}`, reason: reason ?? 'unavailable' });
        return;
      }
      addSecrets(r.value);
      out.push({ ...hop, apiKey: r.value.apiKey, baseUrl: r.value.baseUrl });
    });
    return out;
  };

  const seatFixedLike = (name: string, cfg: AgencySeatConfig, inherits: boolean): SeatedConfig | string => {
    const r = resolveSeatCredentials({ provider: cfg.provider, model: cfg.model, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, inherits }, opts);
    if (!r.ok) return r.reason;
    const reason = availabilityOf(r.value, ruleOnly);
    if (reason) return reason;
    addSecrets(r.value);
    const chain = resolveHops(name, cfg.fallbackProviders);
    const { from: _from, vendor: _vendor, ...rest } = cfg;
    return {
      ...rest,
      provider: r.value.provider, model: r.value.model, apiKey: r.value.apiKey, baseUrl: r.value.baseUrl,
      // No chain of its own: none under panel, the default chain elsewhere.
      ...(chain !== undefined ? { fallbackProviders: chain } : isPanel ? { fallbackProviders: [] } : {}),
      __strictCredentials: true,
      __maskError: mask,
    };
  };

  // 2. Fixed and pre-built seats first: a fixed seat holds its vendor before any pooled seat is filled.
  const pooledNames: string[] = [];
  for (const [name, seat] of Object.entries(opts.agents)) {
    if (isAgent(seat)) { roster[name] = seat; seats[name] = { prebuilt: true }; continue; }
    if (isPooledSeat(seat, opts)) { pooledNames.push(name); continue; }
    const seated = seatFixedLike(name, seat, true);
    if (typeof seated === 'string') {
      if (!isPanel) throw new AgencySeatingError(name, seated);
      unseated[name] = seated; seats[name] = { unseated: true, reason: seated };
      continue;
    }
    const vendor = vendorOf(seated.provider!, seated.model!, { vendor: seat.vendor, baseUrl: seated.baseUrl });
    const key = distinctKey(state.distinct, { provider: seated.provider!, model: seated.model!, vendor });
    if (key) held.add(key);
    roster[name] = seated;
    seats[name] = { provider: seated.provider, model: seated.model, vendor, fixed: true };
  }

  // 3. Pooled seats, the most constrained first (ties in roster order).
  const candidatesOf = (name: string): string[] => (opts.agents[name] as AgencySeatConfig).from ?? poolOrder;
  const order = pooledNames
    .map((name, i) => ({ name, i, n: candidatesOf(name).filter((c) => availableByName.has(c)).length }))
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .map((x) => x.name);
  for (const name of order) {
    const seat = opts.agents[name] as AgencySeatConfig;
    const all = candidatesOf(name);
    const cands = all.map((c) => availableByName.get(c)).filter((c): c is Candidate => c !== undefined);
    if (cands.length === 0) {
      const reason = noEntryReason(all);
      if (!isPanel) throw new AgencySeatingError(name, reason);
      unseated[name] = reason; seats[name] = { unseated: true, reason };
      continue;
    }
    const keyOf = (c: Candidate) => distinctKey(state.distinct, { provider: c.creds.provider, model: c.creds.model, vendor: c.vendor });
    // The first group that is not empty: candidates whose vendor (provider, model) no seat holds yet,
    // then candidates whose entry no seat holds yet, then any. The policy picks within it.
    const group = state.distinct === false
      ? cands
      : [cands.filter((c) => !held.has(keyOf(c)!)), cands.filter((c) => !heldEntries.has(c.name)), cands].find((g) => g.length > 0)!;
    let pick: Candidate;
    if (state.policy === 'preferred') pick = group[0];
    else if (state.policy === 'round-robin') {
      const base = state.roundRobin.get(name) ?? new Map<string, number>(all.map((c) => [c, 0]));
      const totals = new Map<string, number>(base);
      nextTotals.set(name, totals);
      const winner = roundRobinStep(totals, cands.map((c) => c.name), group.map((c) => c.name), pool);
      pick = availableByName.get(winner)!;
    } else {
      const weights = group.map((c) => (state.policy === 'random' ? 1 : weightOf(c.entry)));
      const total = weights.reduce((a, b) => a + b, 0);
      let r = rng!() * total;
      pick = group[group.length - 1];
      for (let i = 0; i < group.length; i++) { r -= weights[i]; if (r < 0) { pick = group[i]; break; } }
    }
    const picked = pick;
    const key = keyOf(picked);
    if (key) held.add(key);
    heldEntries.add(picked.name);
    // The chain: the seat's other available candidates, in preference order under `preferred`, by weight
    // then pool order otherwise; none under panel. Each hop's effort: the call's, else the seat's, else its entry's.
    const others = cands.filter((c) => c.name !== picked.name);
    if (state.policy !== 'preferred') others.sort((a, b) => weightOf(b.entry) - weightOf(a.entry) || poolOrder.indexOf(a.name) - poolOrder.indexOf(b.name));
    const chain: FallbackProviderEntry[] = isPanel ? [] : others.map((c) => {
      const effort = callEffort ?? seat.effort ?? c.entry.effort;
      return {
        provider: c.creds.provider, model: c.creds.model, apiKey: c.creds.apiKey, baseUrl: c.creds.baseUrl,
        ...(c.entry.vendor ? { vendor: c.entry.vendor } : {}),
        ...(effort !== undefined ? { effort } : {}),
      };
    });
    const { from: _from, vendor: _vendor, ...rest } = seat;
    roster[name] = {
      ...rest,
      provider: picked.creds.provider, model: picked.creds.model, apiKey: picked.creds.apiKey, baseUrl: picked.creds.baseUrl,
      // The entry's defaults, for what the seat sets none of.
      ...(seat.effort === undefined && picked.entry.effort !== undefined ? { effort: picked.entry.effort } : {}),
      ...(seat.thinking === undefined && picked.entry.thinking !== undefined ? { thinking: picked.entry.thinking } : {}),
      ...(seat.maxTokens === undefined && picked.entry.maxTokens !== undefined ? { maxTokens: picked.entry.maxTokens } : {}),
      fallbackProviders: chain,
      __strictCredentials: true,
      __maskError: mask,
    };
    seats[name] = { entry: picked.name, provider: picked.creds.provider, model: picked.creds.model, vendor: picked.vendor, fixed: false };
  }

  // 4. The chair, under panel: `from` with the preferred rule (distinct does not apply to it), else
  //    resolved as a fixed seat from its own config or the agency level.
  let chair: SeatedConfig | false | undefined;
  if (isPanel) {
    if (opts.chair === false) chair = false;
    else {
      const cfg: AgencySeatConfig = opts.chair ?? {};
      if (cfg.from) {
        const first = cfg.from.map((c) => availableByName.get(c)).find((c): c is Candidate => c !== undefined);
        if (!first) throw new AgencySeatingError('chair', noEntryReason(cfg.from));
        const seated = seatFixedLike('chair', { ...cfg, provider: first.creds.provider, model: first.creds.model, apiKey: first.creds.apiKey, baseUrl: first.creds.baseUrl, from: undefined }, false);
        if (typeof seated === 'string') throw new AgencySeatingError('chair', seated);
        // The entry's defaults, for what the chair sets none of, as for a pooled seat.
        chair = {
          ...seated,
          ...(seated.effort === undefined && first.entry.effort !== undefined ? { effort: first.entry.effort } : {}),
          ...(seated.thinking === undefined && first.entry.thinking !== undefined ? { thinking: first.entry.thinking } : {}),
          ...(seated.maxTokens === undefined && first.entry.maxTokens !== undefined ? { maxTokens: first.entry.maxTokens } : {}),
        };
      } else {
        const seated = seatFixedLike('chair', cfg, true);
        if (typeof seated === 'string') throw new AgencySeatingError('chair', seated);
        chair = seated;
      }
    }
  }

  // The roster, the record and the unseated list keep the caller's roster order, whatever the filling
  // order: sequential, review-loop, debate, parallel and hierarchical run their seats in that order.
  const orderedRoster: Record<string, SeatedConfig | Agent> = {};
  const orderedSeats: Record<string, SeatingSeatRecord> = {};
  const orderedUnseated: Record<string, string> = {};
  for (const name of Object.keys(opts.agents)) {
    if (Object.prototype.hasOwnProperty.call(roster, name)) orderedRoster[name] = roster[name];
    if (Object.prototype.hasOwnProperty.call(unseated, name)) orderedUnseated[name] = unseated[name];
    orderedSeats[name] = seats[name];
  }

  const record: SeatingRecord = {
    policy: state.policy,
    ...(state.seed !== undefined ? { seed: state.seed, seedUsed: state.seedUsed } : {}),
    call: state.call,
    distinct: state.distinct,
    available: available.map((c) => c.name),
    seats: orderedSeats,
    skipped,
  };
  let committed = false;
  return {
    roster: orderedRoster,
    chair,
    record,
    unseated: orderedUnseated,
    secrets: [...secrets],
    mask,
    commit() {
      if (committed) return;
      committed = true;
      for (const [name, totals] of nextTotals) state.roundRobin.set(name, totals);
      state.call += 1;
    },
  };
}
