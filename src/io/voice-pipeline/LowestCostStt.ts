/**
 * @module voice-pipeline/LowestCostStt
 * Price ordering over explicitly offered hosted entries. Availability and
 * credit come from the host; this module reads no environment or credentials.
 */
import { minutesMicro } from '../../safety/runtime/SpendReservations.js';
import { parseSttEntry, type SttChainVendor } from './sttEntries.js';

/** An exact hosted streaming entry and its applicable list-price row. */
export interface SttPriceRow {
  /** Built-in hosted entry in vendor:model form. */
  readonly entry: string;
  /** Whole micro-dollars per audio minute; never a USD decimal. */
  readonly microPerMinute: number;
}

/**
 * Supplier credit read under the host's reservation transaction.
 * Remaining credit already excludes settled usage not yet covered by the
 * supplier report; open reservations are stated separately and deducted once.
 */
export interface SttCreditSnapshot {
  /** The only vendor funded by this snapshot. */
  readonly vendor: SttChainVendor;
  /** Identity of the complete vendor, amount and read-instant configuration. */
  readonly version: string;
  /** UTC epoch milliseconds of the last successful usage check. */
  readonly checkedAtMs: number;
  /** Whole micro-dollars left after reconciled and locally settled usage. */
  readonly remainingMicro: number;
  /** Whole micro-dollars held by outstanding admissions, excluded only here. */
  readonly reservedMicro: number;
  /** Consecutive distinct UTC check days with a failed read, not retry count. */
  readonly failedDays: number;
}

/** Explicit inputs to one price decision. No availability is inferred. */
export interface LowestCostSttOptions {
  /** Vendors whose credentials and eligibility the host has established. */
  readonly availableVendors: readonly SttChainVendor[];
  /** Null means automatic language, never an English default. Omitted retains legacy English behavior. */
  readonly language?: string | null;
  /** UTC epoch milliseconds of this decision. */
  readonly nowMs: number;
  /** Positive estimated audio seconds the admission must fund. */
  readonly estimatedSeconds: number;
  /** Current complete credit-record version; absent for no valid record. */
  readonly creditVersion?: string;
  /** A checked snapshot of that record; absent before the first success. */
  readonly credit?: SttCreditSnapshot;
}

/** A proposed order; the host still acquires its hold before opening audio. */
export interface LowestCostSttSelection {
  /** The available entry with the lowest effective price. */
  readonly serving: string;
  /** One best available entry from each other vendor, ordered by effective price. */
  readonly fallbacks: readonly string[];
  /** List price, or zero when the complete estimate fits the valid credit. */
  readonly effectiveMicroPerMinute: number;
  /** Credit version used for this choice, or null for list-price selection. */
  readonly creditVersion: string | null;
}

/**
 * Wire options for the priced model. Nova-3's monolingual row requires an explicit
 * language; automatic language would require a separately verified model/tariff.
 * OpenAI omits the language field for automatic recognition.
 *
 * @param entry - A built-in hosted entry in vendor:model form.
 * @param language - A language tag such as `es` or `en-US`; null for automatic language; omitted for the legacy
 *   English default.
 * @returns The language option to open the entry with, or null when the entry has no priced route for automatic
 *   language (a Deepgram entry given null).
 * @throws {RangeError} For a malformed entry or a language that is not a language tag.
 */
export function sttLanguageOptions(entry: string, language?: string | null): { language?: string } | null {
  const vendor = parseSttEntry(entry).vendor;
  if (language !== undefined && language !== null && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) {
    throw new RangeError('invalid transcription language');
  }
  if (vendor === 'deepgram') return language === null ? null : { language: language ?? 'en-US' };
  return language == null ? {} : { language };
}

const CREDIT_MAX_AGE_MS = 86_400_000;

function whole(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function usableCredit(options: LowestCostSttOptions): SttCreditSnapshot | undefined {
  const credit = options.credit;
  if (!credit || !options.creditVersion || credit.version !== options.creditVersion) return undefined;
  if (!whole(credit.checkedAtMs) || !whole(credit.remainingMicro) || !whole(credit.reservedMicro)) return undefined;
  if (!whole(credit.failedDays) || credit.failedDays >= 3 || credit.remainingMicro === 0) return undefined;
  const age = options.nowMs - credit.checkedAtMs;
  if (age < 0 || age >= CREDIT_MAX_AGE_MS) return undefined;
  return credit;
}

/**
 * Selects the lowest effective price among offered, available hosted entries.
 *
 * Equal prices keep the order of `entries`. A credited candidate costs zero
 * for selection only when its complete estimated list-price liability fits
 * after outstanding reservations. Each other vendor contributes at most its
 * best entry as a fallback; the selected vendor contributes no fallback.
 * Invalid credit is ignored, but an available offered entry with no valid
 * price is an error. Device entries belong to the host's separate policy.
 *
 * This is a pure decision, not an allocation. The host reads the snapshot and
 * acquires the resulting hold in one transaction before opening a provider.
 * Persisted usage continues using list prices and actual settlement funding.
 *
 * @param entries - Offered hosted entries, in tie-breaking order, without duplicates.
 * @param prices - Exact applicable streaming rows in whole micro-dollars per minute.
 * @param options - Availability, admission quantity, decision time and optional credit.
 * @returns A frozen selection, or undefined when no offered vendor is available.
 * @throws {RangeError} For malformed entries, duplicate entries or price rows,
 * invalid prices or admission inputs, an invalid language, an unpriced
 * available entry, or a quote outside the safe integer range.
 */
export function selectLowestCostSttEntry(
  entries: readonly string[],
  prices: readonly SttPriceRow[],
  options: LowestCostSttOptions,
): LowestCostSttSelection | undefined {
  if (!whole(options.nowMs) || !Number.isFinite(options.estimatedSeconds) || options.estimatedSeconds <= 0) {
    throw new RangeError('invalid hosted STT admission inputs');
  }
  if (new Set(entries).size !== entries.length) throw new RangeError('duplicate hosted STT entry');
  const byEntry = new Map<string, number>();
  for (const row of prices) {
    parseSttEntry(row.entry);
    if (byEntry.has(row.entry)) throw new RangeError('duplicate hosted STT price row');
    if (!whole(row.microPerMinute)) throw new RangeError('invalid hosted STT price row');
    byEntry.set(row.entry, row.microPerMinute);
  }
  const credit = usableCredit(options);
  const candidates = entries
    .map((entry, order) => ({ entry, order, vendor: parseSttEntry(entry).vendor }))
    .filter((candidate) => options.availableVendors.includes(candidate.vendor)
      && sttLanguageOptions(candidate.entry, options.language) !== null)
    .map((candidate) => {
      const microPerMinute = byEntry.get(candidate.entry);
      if (microPerMinute === undefined) throw new RangeError('hosted STT entry has no price row');
      const estimateMicro = minutesMicro(options.estimatedSeconds, microPerMinute);
      if (!whole(estimateMicro)) throw new RangeError('hosted STT estimate is outside the safe range');
      const covered = credit !== undefined
        && credit.vendor === candidate.vendor
        && estimateMicro > 0
        && credit.remainingMicro - credit.reservedMicro >= estimateMicro;
      return {
        ...candidate,
        effectiveMicroPerMinute: covered ? 0 : microPerMinute,
        creditVersion: covered ? credit.version : null,
      };
    })
    .sort((a, b) => a.effectiveMicroPerMinute - b.effectiveMicroPerMinute || a.order - b.order);
  const first = candidates[0];
  if (!first) return undefined;
  const seen = new Set<SttChainVendor>([first.vendor]);
  const fallbacks: string[] = [];
  for (const candidate of candidates.slice(1)) {
    if (seen.has(candidate.vendor)) continue;
    seen.add(candidate.vendor);
    fallbacks.push(candidate.entry);
  }
  return Object.freeze({
    serving: first.entry,
    fallbacks: Object.freeze(fallbacks),
    effectiveMicroPerMinute: first.effectiveMicroPerMinute,
    creditVersion: first.creditVersion,
  });
}
