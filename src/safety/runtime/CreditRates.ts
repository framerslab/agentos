/**
 * @fileoverview Money arithmetic for metered credit. A rate is rational: `micro` micro-dollars (millionths of a US
 * dollar) for every `per` units, so a price below a micro-dollar a unit is exact. A component's charge is one ceiling of
 * the exact product of its quantity and its rate, computed on BigInt, so no product is rounded by floating point before
 * that ceiling. A measured cost becomes a published rate through {@link deriveMeasuredRate}; an immutable
 * {@link RateSnapshot} names every billable component of a call with its customer and supplier rates; and
 * {@link quoteCompoundLiability} answers the most a call can cost on each side before any work starts.
 *
 * Every amount and every quantity is a whole number; anything else is refused with a RangeError, since a price passed in
 * dollars where micro-dollars are expected, or a fractional count, would bill the wrong amount silently.
 *
 * @module safety/runtime/CreditRates
 */

/** The units a rate prices. */
export type CreditUnit = 'second' | 'millisecond' | 'token' | 'character' | 'sample' | 'request';

/** The units {@link CreditUnit} allows, for a runtime check of a rate read from storage. */
export const CREDIT_UNITS: readonly CreditUnit[] = ['second', 'millisecond', 'token', 'character', 'sample', 'request'];

/** A price: `micro` whole micro-dollars for every `per` units of `unit`. */
export interface RationalRate {
  /** The unit the rate prices. */
  readonly unit: CreditUnit;
  /** Micro-dollars for `per` units: a whole number, zero or more. */
  readonly micro: number;
  /** How many units `micro` buys: a whole number, one or more. */
  readonly per: number;
}

/** One billable component of a snapshot: the customer's price and the supplier's cost for the same unit. */
export interface RateComponent {
  /** What the customer is charged. */
  readonly customer: RationalRate;
  /** What the platform pays its supplier for the same quantity. */
  readonly supplier: RationalRate;
}

/**
 * A rate version: immutable once published, and kept by a call for its whole life. A component key names a billable
 * quantity (`media_second`, `input_token`, `output_token`, `reasoning_token`, `cached_input_token`, `tts_character` and
 * so on); the host chooses the keys, and every quantity it meters must have one.
 */
export interface RateSnapshot {
  /** The version's id, unique and never reused. */
  readonly version: string;
  /** The currency every amount is in. */
  readonly currency: 'USD';
  /** The billable components, by key. */
  readonly components: Readonly<Record<string, RateComponent>>;
  /**
   * Whether the provider's output count already includes its reasoning tokens. When true, a `reasoning_token`
   * quantity is reported for visibility and not billed again, so reasoning is counted once.
   */
  readonly reasoningInOutput: boolean;
  /** A charge every attempt incurs whatever its usage (a provider's minimum charge), in micro-dollars per side. */
  readonly attemptMinimum?: { readonly customerMicro: number; readonly supplierMicro: number };
}

/** The model attempts a call may make, and the most of each component one attempt may use. */
export interface AttemptLimits {
  /** Provider attempts in all: first generations, tool continuations, retries and fallbacks alike. */
  readonly maxAttempts: number;
  /** The most of each component one attempt may use, by component key; a key no snapshot prices is refused. */
  readonly perAttempt: Readonly<Record<string, number>>;
}

/** What {@link quoteCompoundLiability} is asked to bound. */
export interface LiabilityRequest {
  /** The call's snapshot. */
  readonly rates: RateSnapshot;
  /** The authorized fallback tariffs; each attempt is bounded by the dearest of these and the primary, on each side. */
  readonly fallbackRates?: readonly RateSnapshot[];
  /** The component that prices connected time, in seconds. */
  readonly mediaComponent: string;
  /** The call's full requested duration, in whole seconds. */
  readonly durationSeconds: number;
  /** The attempts the call may make. */
  readonly attempts: AttemptLimits;
}

/** The most a call can cost, on each side. */
export interface CompoundLiability {
  /** The primary snapshot's version. */
  readonly rateVersion: string;
  /** The full duration's charge and cost. */
  readonly media: { readonly customerMicro: number; readonly supplierMicro: number };
  /** One attempt's maximum charge and cost under the dearest authorized snapshot. */
  readonly perAttempt: { readonly customerMicro: number; readonly supplierMicro: number };
  /** The attempts the quote covers. */
  readonly maxAttempts: number;
  /** `media.customerMicro + maxAttempts * perAttempt.customerMicro`. */
  readonly customerMicro: number;
  /** `media.supplierMicro + maxAttempts * perAttempt.supplierMicro`. */
  readonly supplierMicro: number;
}

/** A measured cost: what `quantity` units of `unit` cost to produce, with the measurement it came from. */
export interface MeasuredUnitCost {
  /** The measured cost of the work, in whole micro-dollars. */
  readonly costMicro: number;
  /** The units of work measured: one or more. */
  readonly quantity: number;
  /** The unit measured. */
  readonly unit: CreditUnit;
  /** The measurement's artifact (a digest); the rate keeps it. */
  readonly evidence: string;
}

/** A rate derived from a measurement, with the evidence and the multiplier it was derived with. */
export interface MeasuredRate extends RationalRate {
  /** The measurement's artifact. */
  readonly evidence: string;
  /** The multiplier applied to the measured cost. */
  readonly multiplier: { readonly numerator: number; readonly denominator: number };
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Throws unless `value` is a whole number at least `min`. */
function assertWhole(name: string, value: unknown, min: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be a whole number of at least ${min}, not ${String(value)}`);
  }
}

/** Throws unless `rate` is a rational rate this module can price with. */
export function assertRate(rate: RationalRate, name = 'rate'): void {
  if (!rate || !CREDIT_UNITS.includes(rate.unit)) throw new RangeError(`${name} has an unknown unit: ${String(rate?.unit)}`);
  assertWhole(`${name}.micro`, rate.micro, 0);
  assertWhole(`${name}.per`, rate.per, 1);
}

/** A BigInt that fits Number's exact range, as a number; a RangeError past it. */
function toSafeNumber(value: bigint, what: string): number {
  if (value > MAX_SAFE) throw new RangeError(`${what} is past the exact integer range`);
  return Number(value);
}

/** The ceiling of `numerator / denominator` for non-negative BigInts and a positive denominator. */
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * A component's charge: `quantity` units at `rate`, the exact product rounded up once to the micro-dollar.
 *
 * @throws {RangeError} When the quantity is not a whole number zero or more, the rate is not a {@link RationalRate},
 *   or the charge is past Number's exact integer range.
 */
export function componentMicro(quantity: number, rate: RationalRate): number {
  assertWhole('quantity', quantity, 0);
  assertRate(rate);
  if (quantity === 0 || rate.micro === 0) return 0;
  return toSafeNumber(ceilDiv(BigInt(quantity) * BigInt(rate.micro), BigInt(rate.per)), 'the charge');
}

/**
 * A published rate from a measured cost: `costMicro / quantity` per unit, times the multiplier, for every `per` units,
 * rounded up to the micro-dollar.
 *
 * @throws {RangeError} When a number is not whole, the quantity, `per` or the denominator is zero, or the evidence is empty.
 */
export function deriveMeasuredRate(
  cost: MeasuredUnitCost,
  options: { per: number; multiplier: { numerator: number; denominator: number } },
): MeasuredRate {
  assertWhole('costMicro', cost.costMicro, 0);
  assertWhole('quantity', cost.quantity, 1);
  assertWhole('per', options.per, 1);
  assertWhole('multiplier.numerator', options.multiplier.numerator, 0);
  assertWhole('multiplier.denominator', options.multiplier.denominator, 1);
  if (!CREDIT_UNITS.includes(cost.unit)) throw new RangeError(`unknown unit: ${String(cost.unit)}`);
  if (typeof cost.evidence !== 'string' || cost.evidence.length === 0) throw new RangeError('a measured rate needs its evidence');
  const numerator = BigInt(cost.costMicro) * BigInt(options.multiplier.numerator) * BigInt(options.per);
  const denominator = BigInt(cost.quantity) * BigInt(options.multiplier.denominator);
  return {
    unit: cost.unit,
    micro: toSafeNumber(ceilDiv(numerator, denominator), 'the derived rate'),
    per: options.per,
    evidence: cost.evidence,
    multiplier: { numerator: options.multiplier.numerator, denominator: options.multiplier.denominator },
  };
}

/** A snapshot's component, or a RangeError naming the key, since an unpriced unit cannot be billed as zero. */
export function rateComponent(rates: RateSnapshot, key: string): RateComponent {
  const component = Object.prototype.hasOwnProperty.call(rates.components, key) ? rates.components[key] : undefined;
  if (!component) throw new RangeError(`snapshot ${rates.version} prices no ${key}: an unknown unit cannot be priced as zero`);
  assertRate(component.customer, `${key}.customer`);
  assertRate(component.supplier, `${key}.supplier`);
  return component;
}

/** Whether a component is billed per attempt under a snapshot: reasoning is not, when output already counts it. */
export function isBilledPerAttempt(rates: RateSnapshot, key: string): boolean {
  return !(key === 'reasoning_token' && rates.reasoningInOutput);
}

/** One attempt's most under one snapshot, on each side. */
function attemptMaximum(rates: RateSnapshot, limits: AttemptLimits): { customerMicro: number; supplierMicro: number } {
  let customer = 0;
  let supplier = 0;
  for (const [key, quantity] of Object.entries(limits.perAttempt)) {
    assertWhole(`perAttempt.${key}`, quantity, 0);
    const component = rateComponent(rates, key);
    if (!isBilledPerAttempt(rates, key)) continue;
    customer += componentMicro(quantity, component.customer);
    supplier += componentMicro(quantity, component.supplier);
  }
  if (rates.attemptMinimum) {
    assertWhole('attemptMinimum.customerMicro', rates.attemptMinimum.customerMicro, 0);
    assertWhole('attemptMinimum.supplierMicro', rates.attemptMinimum.supplierMicro, 0);
    customer += rates.attemptMinimum.customerMicro;
    supplier += rates.attemptMinimum.supplierMicro;
  }
  return { customerMicro: customer, supplierMicro: supplier };
}

/**
 * The most a call can cost: its full duration at the media component, plus every permitted attempt at its maximum
 * under the dearest of the primary and the fallback snapshots, on the customer's side and the supplier's separately.
 *
 * @throws {RangeError} When a snapshot prices no component the request names, or a number is not whole.
 */
export function quoteCompoundLiability(request: LiabilityRequest): CompoundLiability {
  assertWhole('durationSeconds', request.durationSeconds, 0);
  assertWhole('maxAttempts', request.attempts.maxAttempts, 0);
  const snapshots = [request.rates, ...(request.fallbackRates ?? [])];
  let mediaCustomer = 0;
  let mediaSupplier = 0;
  let attemptCustomer = 0;
  let attemptSupplier = 0;
  for (const rates of snapshots) {
    const media = rateComponent(rates, request.mediaComponent);
    if (media.customer.unit !== 'second' || media.supplier.unit !== 'second') {
      throw new RangeError(`${request.mediaComponent} must price seconds in ${rates.version}`);
    }
    mediaCustomer = Math.max(mediaCustomer, componentMicro(request.durationSeconds, media.customer));
    mediaSupplier = Math.max(mediaSupplier, componentMicro(request.durationSeconds, media.supplier));
    const attempt = attemptMaximum(rates, request.attempts);
    attemptCustomer = Math.max(attemptCustomer, attempt.customerMicro);
    attemptSupplier = Math.max(attemptSupplier, attempt.supplierMicro);
  }
  const attempts = BigInt(request.attempts.maxAttempts);
  return {
    rateVersion: request.rates.version,
    media: { customerMicro: mediaCustomer, supplierMicro: mediaSupplier },
    perAttempt: { customerMicro: attemptCustomer, supplierMicro: attemptSupplier },
    maxAttempts: request.attempts.maxAttempts,
    customerMicro: toSafeNumber(BigInt(mediaCustomer) + attempts * BigInt(attemptCustomer), 'the customer liability'),
    supplierMicro: toSafeNumber(BigInt(mediaSupplier) + attempts * BigInt(attemptSupplier), 'the supplier liability'),
  };
}
