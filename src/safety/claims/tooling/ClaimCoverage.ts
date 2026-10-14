/**
 * @module safety/claims/tooling/ClaimCoverage
 *
 * Coverage accounting for published claims in two layers. The first enumerates every state, serving mode and
 * placement of every claim on its own, so each binding is checked without multiplying unrelated claims' states. The
 * second counts a bounded table of interacting scenarios per route, removes cases whose configuration and claims are
 * identical, multiplies the remainder by the browser matrix and refuses a route over its budget, so the count is known
 * before any browser starts and no case is dropped in silence. `projectRuntime` turns a measured run into a projection
 * for a larger plan.
 */
import { digestOf } from '../digest.js';

/** One claim's dimensions. */
export interface CoverageClaim {
  claimId: string;
  states: readonly string[];
  modes: readonly string[];
  placements: readonly string[];
}

/** One deterministic case. */
export interface CoverageCase {
  claimId: string;
  state: string;
  mode: string;
  placement: string;
  key: string;
}

/**
 * Every case of every claim.
 *
 * @param claims - Each claim once, with no empty dimension and no value twice within one dimension.
 * @throws Error on a claim named twice, an empty dimension or a value named twice within one dimension.
 */
export function enumerateClaimCases(claims: readonly CoverageClaim[]): CoverageCase[] {
  const seen = new Set<string>();
  const cases: CoverageCase[] = [];
  for (const claim of claims) {
    if (seen.has(claim.claimId)) throw new Error(`enumerateClaimCases: ${claim.claimId} appears twice`);
    seen.add(claim.claimId);
    for (const [name, values] of [['states', claim.states], ['modes', claim.modes], ['placements', claim.placements]] as const) {
      if (values.length === 0) throw new Error(`enumerateClaimCases: ${claim.claimId} has no ${name}`);
      // A repeated value would give two cases with one key and count the same check twice.
      const repeated = values.find((value, index) => values.indexOf(value) !== index);
      if (repeated !== undefined) throw new Error(`enumerateClaimCases: ${claim.claimId} names ${repeated} twice in its ${name}`);
    }
    for (const state of claim.states) {
      for (const mode of claim.modes) {
        for (const placement of claim.placements) cases.push({ claimId: claim.claimId, state, mode, placement, key: `${claim.claimId}|${state}|${mode}|${placement}` });
      }
    }
  }
  return cases;
}

/** One scenario case: the claims it exercises, the configuration it runs under and what it expects. */
export interface ScenarioCase {
  id: string;
  claims: readonly string[];
  configuration: Readonly<Record<string, string>>;
  expected: 'renders' | 'denied' | 'fails';
  /** Cases this one cannot run with, and why; recorded, never sampled away. */
  incompatible?: { with: readonly string[]; reason: string };
}

/** A family of scenario cases, one row of the table. */
export interface ScenarioFamily {
  id: string;
  cases: readonly ScenarioCase[];
}

/** The families a route depends on. */
export interface RouteSelection {
  route: string;
  families: readonly string[];
}

/** The browser matrix each scenario case runs in. */
export interface BrowserMatrix {
  engines: readonly string[];
  looks: readonly string[];
  sizes: readonly string[];
}

/** One route's count. */
export interface RouteCount {
  route: string;
  raw: number;
  distinct: number;
  cases: readonly string[];
}

/** The plan: per route, the totals and every problem. */
export interface ScenarioPlan {
  perRoute: readonly RouteCount[];
  scenarioCases: number;
  browserCases: number;
  problems: readonly string[];
}

/**
 * Counts the scenario cases each route runs and checks them against the budget.
 *
 * @param families - The table, each family id once.
 * @param routes - Each route's families, each route once.
 * @param matrix - The browser matrix.
 * @param budget - The most distinct cases one route may run.
 * @returns The counts and every problem: a family id or a route named twice, a family the table lacks, a case id in
 * two families, a case that names no claim, an empty matrix dimension and a route over the budget.
 */
export function planScenarios(families: readonly ScenarioFamily[], routes: readonly RouteSelection[], matrix: BrowserMatrix, budget: number): ScenarioPlan {
  const problems: string[] = [];
  const byId = new Map<string, ScenarioFamily>();
  const caseIds = new Set<string>();
  for (const family of families) {
    // A later family with the same id replaces the earlier one in the lookup, so the earlier one's cases would leave
    // the count without a word.
    if (byId.has(family.id)) problems.push(`the family id ${family.id} appears more than once in the table`);
    byId.set(family.id, family);
    for (const c of family.cases) {
      if (caseIds.has(c.id)) problems.push(`the case id ${c.id} appears in more than one family`);
      caseIds.add(c.id);
      if (c.claims.length === 0) problems.push(`the case ${c.id} names no claim`);
    }
  }
  if (matrix.engines.length === 0 || matrix.looks.length === 0 || matrix.sizes.length === 0) problems.push('the browser matrix has an empty dimension');
  const perRoute: RouteCount[] = [];
  const routesSeen = new Set<string>();
  for (const selection of routes) {
    // The budget holds per route: a route split over two selections would have each half checked on its own.
    if (routesSeen.has(selection.route)) problems.push(`${selection.route}: the route appears in more than one selection`);
    routesSeen.add(selection.route);
    let raw = 0;
    const distinct = new Map<string, string>();
    for (const familyId of selection.families) {
      const family = byId.get(familyId);
      if (family === undefined) {
        problems.push(`${selection.route}: the family ${familyId} is not in the table`);
        continue;
      }
      for (const c of family.cases) {
        raw += 1;
        const shape = digestOf({ configuration: c.configuration, claims: [...c.claims].sort(), expected: c.expected });
        if (!distinct.has(shape)) distinct.set(shape, c.id);
      }
    }
    if (distinct.size > budget) problems.push(`${selection.route}: ${distinct.size} distinct scenario cases exceed the budget of ${budget}`);
    perRoute.push({ route: selection.route, raw, distinct: distinct.size, cases: [...distinct.values()] });
  }
  const scenarioCases = perRoute.reduce((sum, r) => sum + r.distinct, 0);
  return { perRoute, scenarioCases, browserCases: scenarioCases * matrix.engines.length * matrix.looks.length * matrix.sizes.length, problems };
}

/** Exact browser identity; packet totals cannot substitute one tuple for another. */
export interface ScenarioTuple { route: string; scenario: string; engine: string; look: string; size: string }

/**
 * Every browser tuple a plan runs: each route's distinct cases in every engine, look and size.
 *
 * @param plan - What `planScenarios` returned.
 * @param matrix - The browser matrix the plan was counted with.
 */
export function scenarioTuples(plan: ScenarioPlan, matrix: { engines: readonly string[]; looks: readonly string[]; sizes: readonly string[] }): ScenarioTuple[] {
  return plan.perRoute.flatMap((route) => route.cases.flatMap((scenario) => matrix.engines.flatMap((engine) => matrix.looks.flatMap((look) => matrix.sizes.map((size) => ({ route: route.route, scenario, engine, look, size }))))));
}

/**
 * Matches the tuples a run observed against the tuples its plan expected, each exactly once.
 *
 * @param expected - What `scenarioTuples` listed.
 * @param observed - The tuples the run reported, one per executed case.
 * @returns One problem for each expected tuple not observed exactly once and for each unexpected tuple, each beginning
 * with the tuple as a JSON array, and one more when `expected` itself repeats a tuple; empty when the two match.
 */
export function reconcileScenarioTuples(expected: readonly ScenarioTuple[], observed: readonly ScenarioTuple[]): string[] {
  const key = (tuple: ScenarioTuple) => JSON.stringify([tuple.route, tuple.scenario, tuple.engine, tuple.look, tuple.size]);
  const counts = new Map<string, number>();
  for (const tuple of observed) counts.set(key(tuple), (counts.get(key(tuple)) ?? 0) + 1);
  const wanted = new Set(expected.map(key)); const problems: string[] = [];
  if (wanted.size !== expected.length) problems.push('duplicate expected tuple');
  for (const tuple of wanted) if (counts.get(tuple) !== 1) problems.push(tuple + ': expected one, observed ' + (counts.get(tuple) ?? 0));
  for (const tuple of counts.keys()) if (!wanted.has(tuple)) problems.push(tuple + ': unexpected tuple');
  return problems;
}

/**
 * Projects a measured run onto a plan of a different size.
 *
 * @param measured - The cases a run measured, their total time and the time spent outside them.
 * @param plannedCases - The cases the plan runs.
 * @param limitMs - The job's limit.
 * @throws Error when no case was measured.
 */
export function projectRuntime(measured: { cases: number; ms: number; fixedMs: number }, plannedCases: number, limitMs: number): { projectedMs: number; fits: boolean } {
  if (measured.cases <= 0) throw new Error('projectRuntime: no measured case to project from');
  const projectedMs = Math.ceil((measured.ms / measured.cases) * plannedCases + measured.fixedMs);
  return { projectedMs, fits: projectedMs <= limitMs };
}
