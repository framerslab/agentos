/**
 * @module learning/traitState
 *
 * A learner's trait state. One row per learner in `agentos_learning_traits`, written only by the layer, each
 * change in one transaction with its ledger row: the persona's authored values as the learner's baseline, the kept
 * values of the four traits a learner's history may move, the band each trait rendered last, and the floor under
 * honesty-humility. A ledger row's digest covers the fields a change sets (`baseline`, `current`, `bands`,
 * `honestyAtLastLoad`); the counters and windows the trait rules keep stay outside it, since they change with no row.
 * Honesty-humility and emotionality are never read from `current`: the operator's values come from the ledger.
 */
import {
  HEXACO_TRAIT_KEYS,
  normalizeHexacoTraits,
  type HexacoTraitKey,
  type HexacoTraitValues,
} from '../substrate/personas/hexaco.js';
import { bandOf, OPERATOR_ONLY_TRAITS, type TraitBand } from '../substrate/personas/personalityPrompt.js';
import { canonicalJson, sha256Hex } from './ledger/canonical.js';

/** The four traits a learner's history may move; honesty-humility and emotionality are the operator's. */
export const LEARNABLE_TRAITS: readonly HexacoTraitKey[] = HEXACO_TRAIT_KEYS.filter((key) => !OPERATOR_ONLY_TRAITS.includes(key));

/** How far a learnable trait may sit from its baseline over a learner's life. */
export const LIFETIME_BAND = 0.2;
/** The lowest value a learnable trait may hold. */
export const TRAIT_FLOOR = 0.05;
/** The highest value a learnable trait may hold. */
export const TRAIT_CEILING = 0.95;

/** Honesty-humility and emotionality as an operator set them (`operatorSet`), read from the ledger, never the row. */
export type OperatorTraits = Partial<Record<'honesty' | 'emotionality', number>>;

/** A learner's trait state, as `agentos_learning_traits.state` holds it. */
export interface TraitState {
  /** The registry persona's authored values at the learner's last load, 0.5 where it leaves a trait out. */
  baseline: Record<HexacoTraitKey, number>;
  /** The kept values of the four learnable traits. */
  current: Partial<Record<HexacoTraitKey, number>>;
  /** The band each trait rendered last; a render holds it until the value passes the threshold by 0.02. */
  bands: Record<HexacoTraitKey, TraitBand>;
  /** Honesty-humility at the last load: a persona value below it keeps this one rendering until the operator acts. */
  honestyAtLastLoad: number;
  /** Band-changing steps awaiting a verdict; the trait rules of a later release fill it. */
  pending: Array<{ ledgerId: string; trait: HexacoTraitKey; value: number }>;
  /** The UTC day, on the layer's clock, the movement counters belong to. */
  day: string;
  dayMovement: Partial<Record<HexacoTraitKey, number>>;
  sentimentWindow: number[];
  sessionsInWindow: number;
  ruleLastFired: Record<string, string>;
  rendererVersion: 1;
}

/** The fields a ledger row's digest covers. */
export type TraitStateDigestFields = Pick<TraitState, 'baseline' | 'current' | 'bands' | 'honestyAtLastLoad'>;

/** What an `operator_set` row's `before` and `after` hold: the digest's fields and the operator's map. */
export interface TraitStateRecord extends TraitStateDigestFields {
  operatorTraits: OperatorTraits;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** The persona's authored values under every key: a trait it leaves out is 0.5, and every value is inside [0, 1]. */
export function baselineOf(authored: unknown): Record<HexacoTraitKey, number> {
  const values = normalizeHexacoTraits(authored);
  const baseline = {} as Record<HexacoTraitKey, number>;
  for (const key of HEXACO_TRAIT_KEYS) baseline[key] = clamp01(values[key] ?? 0.5);
  return baseline;
}

/** A learnable trait's value inside its lifetime band: within 0.2 of the baseline, inside [0.05, 0.95]. */
export function clampLearnable(value: number, baselineValue: number): number {
  const v = isFiniteNumber(value) ? value : baselineValue;
  const low = Math.max(TRAIT_FLOOR, baselineValue - LIFETIME_BAND);
  const high = Math.min(TRAIT_CEILING, baselineValue + LIFETIME_BAND);
  return Math.min(high, Math.max(low, v));
}

/**
 * The traits a learner's turn renders: the four learnable traits from `current`, clamped into their band;
 * honesty-humility from the operator's value, else the persona's, held at the floor when the persona's is lower;
 * emotionality from the operator's value, else the persona's.
 */
export function renderedTraits(state: TraitState, authored: unknown, operator: OperatorTraits): Record<HexacoTraitKey, number> {
  const persona = baselineOf(authored);
  const out = {} as Record<HexacoTraitKey, number>;
  for (const key of LEARNABLE_TRAITS) out[key] = clampLearnable(state.current[key] ?? state.baseline[key], state.baseline[key]);
  out.honesty = isFiniteNumber(operator.honesty) ? clamp01(operator.honesty) : Math.max(persona.honesty, state.honestyAtLastLoad);
  out.emotionality = isFiniteNumber(operator.emotionality) ? clamp01(operator.emotionality) : persona.emotionality;
  return out;
}

/** The band each trait renders in, holding the bands rendered last. */
export function bandsFor(
  values: Record<HexacoTraitKey, number>,
  previous?: Partial<Record<HexacoTraitKey, TraitBand>>,
): Record<HexacoTraitKey, TraitBand> {
  const bands = {} as Record<HexacoTraitKey, TraitBand>;
  for (const key of HEXACO_TRAIT_KEYS) bands[key] = bandOf(values[key], previous?.[key]);
  return bands;
}

/** The UTC day of a time on the layer's clock. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A new learner's state: the persona's authored values, kept as they are. */
export function newTraitState(authored: unknown, now: number): TraitState {
  const baseline = baselineOf(authored);
  const current: Partial<Record<HexacoTraitKey, number>> = {};
  for (const key of LEARNABLE_TRAITS) current[key] = clampLearnable(baseline[key], baseline[key]);
  const state: TraitState = {
    baseline,
    current,
    bands: {} as Record<HexacoTraitKey, TraitBand>,
    honestyAtLastLoad: baseline.honesty,
    pending: [],
    day: utcDay(now),
    dayMovement: {},
    sentimentWindow: [],
    sessionsInWindow: 0,
    ruleLastFired: {},
    rendererVersion: 1,
  };
  state.bands = bandsFor(renderedTraits(state, authored, {}));
  return state;
}

/** The text a state is stored as. */
export function serializeTraitState(state: TraitState): string {
  return canonicalJson(state);
}

/**
 * Reads a stored state. A field that is missing or of the wrong type takes its default, so a row always reads; an
 * unreadable row's digest matches no ledger row, so the load check reads it as a broken chain.
 */
export function parseTraitState(text: string): TraitState {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // Defaults below.
  }
  const numbers = (value: unknown, keys: readonly HexacoTraitKey[]): Partial<Record<HexacoTraitKey, number>> => {
    const out: Partial<Record<HexacoTraitKey, number>> = {};
    if (value && typeof value === 'object') {
      for (const key of keys) {
        const v = (value as Record<string, unknown>)[key];
        if (isFiniteNumber(v)) out[key] = v;
      }
    }
    return out;
  };
  const stored = numbers(raw.baseline, HEXACO_TRAIT_KEYS);
  const baseline = {} as Record<HexacoTraitKey, number>;
  for (const key of HEXACO_TRAIT_KEYS) baseline[key] = stored[key] ?? 0.5;
  const storedBands = raw.bands && typeof raw.bands === 'object' ? (raw.bands as Record<string, unknown>) : {};
  const bands = {} as Record<HexacoTraitKey, TraitBand>;
  for (const key of HEXACO_TRAIT_KEYS) {
    const band = storedBands[key];
    bands[key] = band === 'low' || band === 'high' || band === 'moderate' ? band : 'moderate';
  }
  return {
    baseline,
    current: numbers(raw.current, LEARNABLE_TRAITS),
    bands,
    honestyAtLastLoad: isFiniteNumber(raw.honestyAtLastLoad) ? raw.honestyAtLastLoad : baseline.honesty,
    pending: Array.isArray(raw.pending) ? (raw.pending as TraitState['pending']) : [],
    day: typeof raw.day === 'string' ? raw.day : '',
    dayMovement: numbers(raw.dayMovement, HEXACO_TRAIT_KEYS),
    sentimentWindow: Array.isArray(raw.sentimentWindow) ? raw.sentimentWindow.filter(isFiniteNumber) : [],
    sessionsInWindow: isFiniteNumber(raw.sessionsInWindow) ? raw.sessionsInWindow : 0,
    ruleLastFired:
      raw.ruleLastFired && typeof raw.ruleLastFired === 'object' ? (raw.ruleLastFired as Record<string, string>) : {},
    rendererVersion: 1,
  };
}

/** The digest a ledger row carries for a state: SHA-256 over the canonical JSON of the fields a change sets. */
export function traitDigest(state: TraitStateDigestFields): Promise<string> {
  return sha256Hex(
    canonicalJson({
      baseline: state.baseline,
      current: state.current,
      bands: state.bands,
      honestyAtLastLoad: state.honestyAtLastLoad,
    }),
  );
}

/** What an `operator_set` row records of a state and the operator's map. */
export function traitRecord(state: TraitState, operator: OperatorTraits): TraitStateRecord {
  return {
    baseline: { ...state.baseline },
    current: { ...state.current },
    bands: { ...state.bands },
    honestyAtLastLoad: state.honestyAtLastLoad,
    operatorTraits: { ...operator },
  };
}

/** The operator's map an `operator_set` row's `after` carries; anything else reads as none. */
export function operatorTraitsOf(after: unknown): OperatorTraits {
  const map = after && typeof after === 'object' ? (after as { operatorTraits?: unknown }).operatorTraits : undefined;
  const out: OperatorTraits = {};
  if (map && typeof map === 'object') {
    for (const key of ['honesty', 'emotionality'] as const) {
      const v = (map as Record<string, unknown>)[key];
      if (isFiniteNumber(v)) out[key] = clamp01(v);
    }
  }
  return out;
}

/**
 * A load's persona rule: when the authored values differ from the baseline, the baseline moves to them and `current`
 * is clamped into the new bands; the honesty floor rises with an authored value above it and never falls here.
 *
 * @returns The state to write, or `undefined` when nothing moves.
 */
export function withPersona(state: TraitState, authored: unknown, operator: OperatorTraits): TraitState | undefined {
  const baseline = baselineOf(authored);
  const baselineMoved = HEXACO_TRAIT_KEYS.some((key) => baseline[key] !== state.baseline[key]);
  const floor = Math.max(state.honestyAtLastLoad, baseline.honesty);
  if (!baselineMoved && floor === state.honestyAtLastLoad) return undefined;
  const current: Partial<Record<HexacoTraitKey, number>> = {};
  for (const key of LEARNABLE_TRAITS) current[key] = clampLearnable(state.current[key] ?? baseline[key], baseline[key]);
  const next: TraitState = { ...state, baseline, current, honestyAtLastLoad: floor };
  next.bands = bandsFor(renderedTraits(next, authored, operator), state.bands);
  return next;
}

/**
 * An operator's change: `baseline` puts the learnable traits back at the baseline, clears the operator's map and puts
 * the honesty floor at the persona's value; a map sets each learnable trait it names, clamped into its band, and each
 * operator trait it names into the operator's map, and a honesty-humility it names becomes the floor.
 */
export function withOperatorSet(
  state: TraitState,
  traits: 'baseline' | HexacoTraitValues,
  operator: OperatorTraits,
): { state: TraitState; operator: OperatorTraits } {
  if (traits === 'baseline') {
    const current: Partial<Record<HexacoTraitKey, number>> = {};
    for (const key of LEARNABLE_TRAITS) current[key] = clampLearnable(state.baseline[key], state.baseline[key]);
    const next: TraitState = { ...state, current, honestyAtLastLoad: state.baseline.honesty, pending: [] };
    next.bands = bandsFor(renderedTraits(next, state.baseline, {}), state.bands);
    return { state: next, operator: {} };
  }
  const values = normalizeHexacoTraits(traits);
  const current = { ...state.current };
  for (const key of LEARNABLE_TRAITS) {
    const value = values[key];
    if (value !== undefined) current[key] = clampLearnable(value, state.baseline[key]);
  }
  const nextOperator: OperatorTraits = { ...operator };
  if (values.honesty !== undefined) nextOperator.honesty = clamp01(values.honesty);
  if (values.emotionality !== undefined) nextOperator.emotionality = clamp01(values.emotionality);
  const next: TraitState = { ...state, current, honestyAtLastLoad: nextOperator.honesty ?? state.honestyAtLastLoad };
  next.bands = bandsFor(renderedTraits(next, state.baseline, nextOperator), state.bands);
  return { state: next, operator: nextOperator };
}
