/**
 * @fileoverview Construction-time validation of a pool, seating, chair,
 * panel and quorum configuration. Throws AgencyConfigError with the first
 * problem found; reads the environment for vendors and reachable providers,
 * as seating will at the call.
 */
import type { AgencyOptions, AgencySeatConfig, AgencyStrategy, Agent, ModelPoolEntry } from '../../types.js';
import { AgencyConfigError, AgencyPanelError } from '../../types.js';
import { isAgent } from '../strategies/shared.js';
import { TEXT_PROVIDER_IDS, availabilityOf, resolveSeatCredentials } from './resolve.js';
import { vendorOf } from './vendor.js';
import { knownProviderPrefixOf } from '../../model.js';

const POLICIES = new Set(['preferred', 'weighted', 'round-robin', 'random']);
const DISTINCT = new Set(['vendor', 'provider', 'model', false]);
// A function declaration with an explicit `never`, so a call narrows the code after it.
function fail(msg: string): never {
  throw new AgencyConfigError(msg);
}
const isPositiveInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 1;
/**
 * Why a config seat or the chair cannot run on the GMI path in an agency with a
 * pool or a panel: a GMI resolves its failover hops' keys from the environment,
 * with neither the strict rule nor the call's error mask that seating gives
 * every seated config.
 */
const GMI_SEAT_REASON =
  "runtime 'gmi' is not available in an agency with a pool or a panel: a GMI seat's calls skip the strict credentials " +
  "and the error mask seating gives every seat. Use runtime: 'legacy', or place a gmi() agent in the roster as a pre-built seat";
const isNonNegInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0;
/**
 * Whether `customModelParams` holds `model` or `models` as its own key: the
 * providers spread it onto the request, which copies own keys only, so an
 * inherited one never reaches the wire.
 */
const namesWireModel = (cmp: Record<string, unknown>): boolean =>
  Object.prototype.hasOwnProperty.call(cmp, 'model') || Object.prototype.hasOwnProperty.call(cmp, 'models');

/** A config seat that names neither a provider nor a model. */
export type PooledSeatConfig = AgencySeatConfig & { provider?: undefined; model?: undefined };

/** Whether a config seat is pooled: it names neither a provider nor a model, in an agency with a pool. */
export function isPooledSeat(seat: AgencySeatConfig | Agent, agency: AgencyOptions): seat is PooledSeatConfig {
  return !!agency.modelPool && !isAgent(seat) && !seat.provider && !seat.model;
}

/** True when the agency has a pool, a panel, or any pool-only option. */
export function hasPoolSurface(opts: AgencyOptions, strategy: AgencyStrategy): boolean {
  return !!opts.modelPool || strategy === 'panel' || !!opts.seating || opts.chair !== undefined || !!opts.panel || opts.quorum?.minVendors !== undefined;
}

/**
 * Checks the pool, seating, chair, panel and quorum options of an agency
 * that has a pool surface ({@link hasPoolSurface}).
 *
 * @param opts - The agency options.
 * @param strategy - The strategy the agency runs (after `adaptive`).
 * @throws {AgencyConfigError} With the first problem found.
 */
export function validatePoolOptions(opts: AgencyOptions, strategy: AgencyStrategy): void {
  const pool = opts.modelPool;
  const isPanel = strategy === 'panel';
  if (pool) {
    const names = Object.keys(pool);
    if (names.length === 0) fail('modelPool must hold at least one entry');
    for (const name of names) {
      if (/^(0|[1-9]\d*)$/.test(name)) fail(`modelPool entry "${name}": a name that looks like an integer is moved to the front of the object; use a word`);
      const e = pool[name] as Partial<ModelPoolEntry>;
      if (!e.provider || !e.model) fail(`modelPool entry "${name}" needs provider and model`);
      if (!TEXT_PROVIDER_IDS.has(e.provider)) fail(`modelPool entry "${name}": provider "${e.provider}" is not one of ${[...TEXT_PROVIDER_IDS].join(', ')}`);
      // An Ollama tag is never split, so one named after a provider (`mistral:7b`) is a plain id there.
      if (e.provider !== 'ollama' && knownProviderPrefixOf(e.model)) fail(`modelPool entry "${name}": model "${e.model}" carries a provider prefix; write provider and a plain model id`);
      if (e.weight !== undefined && !(typeof e.weight === 'number' && Number.isFinite(e.weight) && e.weight > 0)) fail(`modelPool entry "${name}": weight must be a finite number greater than 0`);
      if (e.maxTokens !== undefined && !isPositiveInt(e.maxTokens)) fail(`modelPool entry "${name}": maxTokens must be a positive integer`);
    }
  }
  if (opts.seating) {
    if (!pool) fail('seating requires modelPool');
    const s = opts.seating;
    if (s.policy !== undefined && !POLICIES.has(s.policy)) fail(`seating.policy "${String(s.policy)}" is unknown`);
    if (s.distinct !== undefined && !DISTINCT.has(s.distinct)) fail(`seating.distinct "${String(s.distinct)}" is unknown`);
    if (s.seed !== undefined) {
      const okNumber = typeof s.seed === 'number' && Number.isInteger(s.seed) && s.seed >= 0 && s.seed <= 0xffffffff;
      const okString = typeof s.seed === 'string' && s.seed.length > 0;
      if (!okNumber && !okString) fail('seating.seed must be a whole number from 0 to 4294967295 or a non-empty string');
    }
  }
  if (opts.chair !== undefined && !isPanel) fail('chair is a panel option; set strategy: "panel"');
  if (opts.panel && !isPanel) fail('panel is a panel option; set strategy: "panel"');
  // `adaptive` replaces the strategy with hierarchical before this runs, so the raw option is read here;
  // validateAgencyOptions repeats the check for every agency, pool or not.
  if (opts.strategy === 'panel' && opts.adaptive) fail('strategy "panel" cannot be combined with adaptive: true');
  // The chair's record, its approval requests and its callbacks carry the name 'chair'; a roster seat of that name would share them.
  if (isPanel && Object.prototype.hasOwnProperty.call(opts.agents, 'chair')) {
    throw new AgencyPanelError('seat "chair": under strategy "panel" the chair is named "chair" in seats, approvals and callbacks; rename the seat');
  }
  if (isPanel && opts.output !== undefined) fail('output is not supported under strategy "panel" in this version; structured panel output arrives with the refuter stage');
  if (isPanel && opts.chair && typeof opts.chair === 'object' && (opts.chair as AgencySeatConfig).output !== undefined) fail('chair.output is not supported');
  if (opts.panel) {
    const p = opts.panel;
    if (p.concurrency !== undefined && !isPositiveInt(p.concurrency)) fail('panel.concurrency must be an integer of at least 1');
    if (p.minChars !== undefined && !isPositiveInt(p.minChars)) fail('panel.minChars must be an integer of at least 1');
    for (const k of ['seatDeadlineMs', 'chairDeadlineMs'] as const) {
      const v = p[k];
      if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v > 0)) fail(`panel.${k} must be a finite number greater than 0`);
    }
  }
  if (opts.quorum) {
    for (const k of ['minAgents', 'minProviders', 'minVendors'] as const) {
      const v = opts.quorum[k];
      if (v !== undefined && !isNonNegInt(v)) fail(`quorum.${k} must be a non-negative integer`);
    }
    if (opts.quorum.minVendors !== undefined && !isPanel) fail('quorum.minVendors is a panel option; set strategy: "panel"');
  }

  const seats = Object.entries(opts.agents);
  const configSeats = seats.filter((entry): entry is [string, AgencySeatConfig] => !isAgent(entry[1]));
  const pooledSurface = !!pool || isPanel;
  const reachableVendors = new Set<string>();
  const reachableProviders = new Set<string>();
  const entryVendor = new Map<string, string | undefined>();
  if (pool) {
    for (const [name, e] of Object.entries(pool)) {
      const resolved = resolveSeatCredentials({ provider: e.provider, model: e.model, apiKey: e.apiKey, baseUrl: e.baseUrl, inherits: false }, opts);
      const v = vendorOf(e.provider, e.model, { vendor: e.vendor, baseUrl: resolved.ok ? resolved.value.baseUrl : e.baseUrl });
      entryVendor.set(name, v);
    }
    // With minVendors set, every pool entry needs a known vendor, reachable by a seat or not.
    if (opts.quorum?.minVendors !== undefined) {
      for (const [name, v] of entryVendor) if (!v) fail(`modelPool entry "${name}": its vendor is unknown; declare vendor on the entry or drop quorum.minVendors`);
    }
  }
  // Each config seat's providers and vendors within reach: a seat answers once, with one of each.
  const seatProviders: Array<Set<string>> = [];
  const seatVendors: Array<Set<string>> = [];
  for (const [name, seat] of configSeats) {
    const pooled = isPooledSeat(seat, opts);
    if (seat.from !== undefined) {
      if (!pool) fail(`seat "${name}": from requires modelPool`);
      if (!Array.isArray(seat.from) || seat.from.length === 0) fail(`seat "${name}": from must name at least one pool entry`);
      for (const f of seat.from) if (!pool[f]) fail(`seat "${name}": from names "${f}", which is not in modelPool`);
      if (seat.provider || seat.model) fail(`seat "${name}": from cannot be set together with provider or model`);
    }
    if (pooled) {
      // Present counts as set, even with the value undefined.
      for (const k of ['apiKey', 'baseUrl', 'fallbackProviders', 'onFallback'] as const) {
        if (Object.prototype.hasOwnProperty.call(seat, k)) fail(`seat "${name}" is filled from the pool and cannot set ${k}`);
      }
    }
    if (pooledSurface) {
      for (const k of ['router', 'routerParams', 'hostPolicy'] as const) {
        if ((seat as Record<string, unknown>)[k] !== undefined) fail(`seat "${name}": ${k} is not allowed in an agency with a pool or a panel`);
      }
      if (seat.runtime === 'gmi') fail(`seat "${name}": ${GMI_SEAT_REASON}`);
      const cmp = seat.customModelParams;
      if ((pooled || isPanel) && cmp && namesWireModel(cmp)) fail(`seat "${name}": customModelParams.model and .models change the model on the wire behind the seating record`);
    }
    if (pooledSurface && !pooled) {
      const resolved = resolveSeatCredentials({ provider: seat.provider, model: seat.model, apiKey: seat.apiKey, baseUrl: seat.baseUrl, inherits: true }, opts);
      if (!resolved.ok) fail(`seat "${name}": ${resolved.reason}`);
      const providers = new Set<string>([resolved.value.provider]);
      const vendors = new Set<string>();
      reachableProviders.add(resolved.value.provider);
      const v = vendorOf(resolved.value.provider, resolved.value.model, { vendor: seat.vendor, baseUrl: resolved.value.baseUrl });
      if (v) vendors.add(v);
      else if (opts.quorum?.minVendors !== undefined) fail(`seat "${name}": its vendor is unknown; declare vendor on the seat or drop quorum.minVendors`);
      // A hop of the seat's own chain can answer for it, and the record then names the hop's provider and vendor.
      // Only a hop seating keeps counts: one whose key, URL or binary is unmet is dropped for the call and answers nothing.
      for (const hop of Array.isArray(seat.fallbackProviders) ? seat.fallbackProviders : []) {
        if (!hop || typeof hop.provider !== 'string') continue;
        const hopResolved = resolveSeatCredentials({ provider: hop.provider, model: hop.model, apiKey: hop.apiKey, baseUrl: hop.baseUrl, inherits: false }, opts);
        if (!hopResolved.ok || availabilityOf(hopResolved.value, { breakerOpen: () => false })) continue;
        providers.add(hopResolved.value.provider);
        reachableProviders.add(hopResolved.value.provider);
        const hopVendor = vendorOf(hopResolved.value.provider, hopResolved.value.model, { vendor: hop.vendor, baseUrl: hopResolved.value.baseUrl });
        if (hopVendor) vendors.add(hopVendor);
      }
      vendors.forEach((vendor) => reachableVendors.add(vendor));
      seatProviders.push(providers);
      seatVendors.push(vendors);
    } else if (pooled) {
      const candidates = seat.from ?? Object.keys(pool!);
      const providers = new Set<string>();
      const vendors = new Set<string>();
      for (const c of candidates) {
        providers.add(pool![c].provider);
        reachableProviders.add(pool![c].provider);
        const v = entryVendor.get(c);
        if (v) vendors.add(v);
        else if (opts.quorum?.minVendors !== undefined) fail(`modelPool entry "${c}": its vendor is unknown; declare vendor on the entry or drop quorum.minVendors`);
      }
      vendors.forEach((vendor) => reachableVendors.add(vendor));
      seatProviders.push(providers);
      seatVendors.push(vendors);
    }
  }
  if (isPanel) {
    const chair = opts.chair;
    if (chair !== false) {
      const c = (chair ?? {}) as AgencySeatConfig;
      for (const k of ['router', 'routerParams', 'hostPolicy'] as const) if ((c as Record<string, unknown>)[k] !== undefined) fail(`chair: ${k} is not allowed`);
      if (c.runtime === 'gmi') fail(`chair: ${GMI_SEAT_REASON}`);
      if (c.customModelParams && namesWireModel(c.customModelParams)) fail('chair: customModelParams.model and .models are not allowed');
      if (c.from !== undefined) {
        if (!pool) fail('chair.from requires modelPool');
        if (!Array.isArray(c.from) || c.from.length === 0) fail('chair.from must name at least one pool entry');
        for (const f of c.from) if (!pool[f]) fail(`chair.from names "${f}", which is not in modelPool`);
        if (c.provider || c.model) fail('chair.from cannot be set together with provider or model');
      } else {
        const resolved = resolveSeatCredentials({ provider: c.provider, model: c.model, apiKey: c.apiKey, baseUrl: c.baseUrl, inherits: true }, opts);
        if (!resolved.ok) fail(`chair: ${resolved.reason}`);
      }
    }
    const q = opts.quorum ?? {};
    if (q.minAgents !== undefined && q.minAgents > seats.length) fail(`quorum.minAgents (${q.minAgents}) is above the number of seats (${seats.length})`);
    if (q.minVendors !== undefined) {
      if (q.minVendors > configSeats.length) fail(`quorum.minVendors (${q.minVendors}) is above the number of config seats (${configSeats.length})`);
      // A pre-built seat's vendor is unknown and never counts, so the config seats alone answer the vendor quorum.
      const vendorsAtOnce = distinctAtOnce(seatVendors);
      if (q.minVendors > vendorsAtOnce) {
        fail(`quorum.minVendors (${q.minVendors}) is above the ${vendorsAtOnce} distinct vendor(s) the seats can answer with at once (${reachableVendors.size} vendor(s) within the config seats' reach, one per seat)`);
      }
    }
  }
  // Each seat answers once, with one provider of its own reach: the bound is the most distinct providers one assignment of
  // the config seats can answer with (a seat that reaches three providers beside two seats on one makes two, not three),
  // one more per pre-built seat, whose result names one provider the agency cannot see. A panel is checked with or
  // without a pool: its fixed seats' providers are counted above either way.
  const prebuiltSeats = seats.length - configSeats.length;
  const minProviders = opts.quorum?.minProviders;
  const providersAtOnce = distinctAtOnce(seatProviders) + prebuiltSeats;
  if ((isPanel || (strategy === 'parallel' && pool)) && minProviders !== undefined && minProviders > providersAtOnce) {
    fail(
      `quorum.minProviders (${minProviders}) is above the ${providersAtOnce} distinct provider(s) the seats can answer with at once ` +
      `(${seats.length} seat(s); ${reachableProviders.size} provider(s) within the config seats' reach, plus the ${prebuiltSeats} pre-built seat(s))`,
    );
  }
  if (pool && strategy === 'hierarchical' && !opts.model && !opts.provider) fail('Hierarchical strategy requires an agency-level model or provider for the manager agent.');
}

/**
 * The most distinct values one assignment of the seats can answer with, each
 * seat taking one value of its own set: a maximum bipartite matching of seats
 * to values, found by augmenting paths. Seats and providers are few, so the
 * plain search is enough.
 *
 * @param options - For each seat, the values it can answer with.
 * @returns How many seats can be given distinct values at once.
 */
function distinctAtOnce(options: ReadonlyArray<ReadonlySet<string>>): number {
  const holder = new Map<string, number>();
  const assign = (seat: number, tried: Set<string>): boolean => {
    for (const value of options[seat]) {
      if (tried.has(value)) continue;
      tried.add(value);
      const current = holder.get(value);
      if (current === undefined || assign(current, tried)) {
        holder.set(value, seat);
        return true;
      }
    }
    return false;
  };
  let matched = 0;
  for (let seat = 0; seat < options.length; seat += 1) if (assign(seat, new Set())) matched += 1;
  return matched;
}
