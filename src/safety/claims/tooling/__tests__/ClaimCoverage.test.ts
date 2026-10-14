import { describe, expect, it } from 'vitest';
import { enumerateClaimCases, planScenarios, projectRuntime, scenarioTuples, reconcileScenarioTuples, type ScenarioFamily } from '../ClaimCoverage.js';

const families: ScenarioFamily[] = [
  { id: 'baseline', cases: [{ id: 'baseline', claims: ['a.primary'], configuration: {}, expected: 'renders' }] },
  {
    id: 'switch',
    cases: [
      { id: 'switch-off', claims: ['b.primary'], configuration: { SWITCH: 'off' }, expected: 'renders' },
      { id: 'switch-on', claims: ['b.primary'], configuration: { SWITCH: 'on' }, expected: 'renders' },
      { id: 'switch-on-again', claims: ['b.primary'], configuration: { SWITCH: 'on' }, expected: 'renders' },
    ],
  },
];
const matrix = { engines: ['engine-a', 'engine-b'], looks: ['light', 'dark'], sizes: ['s', 'm', 'l'] };

describe('claim coverage', () => {
  it('rejects duplicate browser tuples replacing a missing engine, look or size', () => {
    const plan = planScenarios(families, [{ route: '/', families: ['baseline'] }], matrix, 24);
    const expected = scenarioTuples(plan, matrix);
    expect(reconcileScenarioTuples(expected, expected)).toEqual([]);
    const replaced = [expected[0]!, ...expected.slice(0, -1)];
    const problems = reconcileScenarioTuples(expected, replaced);
    expect(problems).toHaveLength(2);
    expect(problems.some((p) => p.endsWith('observed 2'))).toBe(true);
    expect(problems.some((p) => p.endsWith('observed 0'))).toBe(true);
    expect(reconcileScenarioTuples(expected, [...expected, { ...expected[0]!, route: '/foreign' }])).toContain(JSON.stringify(['/foreign', 'baseline', 'engine-a', 'light', 's']) + ': unexpected tuple');
  });
  it('enumerates every state, mode and placement of every claim, with no cross product between claims', () => {
    const cases = enumerateClaimCases([
      { claimId: 'a.primary', states: ['built', 'not_offered'], modes: ['direct', 'hosted'], placements: ['page.faq'] },
      { claimId: 'b.primary', states: ['built', 'specified', 'not_offered'], modes: ['any'], placements: ['page.faq', 'page.meta'] },
    ]);
    expect(cases).toHaveLength(2 * 2 * 1 + 3 * 1 * 2);
    expect(new Set(cases.map((c) => c.key)).size).toBe(cases.length);
  });

  it('refuses a duplicate claim and an empty dimension', () => {
    expect(() => enumerateClaimCases([{ claimId: 'a.primary', states: [], modes: ['any'], placements: ['p'] }])).toThrow(/no states/);
    expect(() => enumerateClaimCases([{ claimId: 'a.primary', states: ['built'], modes: ['any'], placements: ['p'] }, { claimId: 'a.primary', states: ['built'], modes: ['any'], placements: ['p'] }])).toThrow(/twice/);
  });

  it('counts each route\'s scenario cases, deduplicates identical configurations and multiplies by the browser matrix', () => {
    const plan = planScenarios(families, [{ route: '/', families: ['baseline', 'switch'] }, { route: '/pricing', families: ['baseline'] }], matrix, 24);
    expect(plan.problems).toEqual([]);
    expect(plan.perRoute).toEqual([
      { route: '/', raw: 4, distinct: 3, cases: ['baseline', 'switch-off', 'switch-on'] },
      { route: '/pricing', raw: 1, distinct: 1, cases: ['baseline'] },
    ]);
    expect(plan.scenarioCases).toBe(4);
    expect(plan.browserCases).toBe(12 * 4);
  });

  it('fails a route over budget, an unknown family, duplicate case ids and a case with no claims', () => {
    expect(planScenarios(families, [{ route: '/', families: ['baseline', 'switch'] }], matrix, 2).problems).toEqual(['/: 3 distinct scenario cases exceed the budget of 2']);
    expect(planScenarios(families, [{ route: '/', families: ['missing'] }], matrix, 24).problems).toEqual(['/: the family missing is not in the table']);
    const doubled = [...families, { id: 'again', cases: [{ id: 'baseline', claims: ['c.primary'], configuration: {}, expected: 'renders' as const }] }];
    expect(planScenarios(doubled, [], matrix, 24).problems).toEqual(['the case id baseline appears in more than one family']);
    const bare = [{ id: 'bare', cases: [{ id: 'bare', claims: [], configuration: {}, expected: 'renders' as const }] }];
    expect(planScenarios(bare, [], matrix, 24).problems).toEqual(['the case bare names no claim']);
  });

  it('reports a family id or a route named twice, and refuses a value named twice in one dimension', () => {
    const shadowed = [...families, { id: 'switch', cases: [{ id: 'switch-other', claims: ['c.primary'], configuration: { SWITCH: 'other' }, expected: 'renders' as const }] }];
    expect(planScenarios(shadowed, [{ route: '/', families: ['switch'] }], matrix, 24).problems).toEqual(['the family id switch appears more than once in the table']);
    expect(planScenarios(families, [{ route: '/', families: ['baseline'] }, { route: '/', families: ['switch'] }], matrix, 2).problems).toEqual(['/: the route appears in more than one selection']);
    expect(() => enumerateClaimCases([{ claimId: 'a.primary', states: ['built', 'not_offered', 'built'], modes: ['any'], placements: ['p'] }])).toThrow(/a\.primary names built twice in its states/);
    expect(() => enumerateClaimCases([{ claimId: 'a.primary', states: ['built'], modes: ['any'], placements: ['p', 'p'] }])).toThrow(/a\.primary names p twice in its placements/);
  });

  it('projects the measured time per case onto a plan and says whether it fits', () => {
    expect(projectRuntime({ cases: 100, ms: 600_000, fixedMs: 300_000 }, 200, 3_600_000)).toEqual({ projectedMs: 1_500_000, fits: true });
    expect(projectRuntime({ cases: 100, ms: 600_000, fixedMs: 300_000 }, 600, 3_600_000)).toEqual({ projectedMs: 3_900_000, fits: false });
    expect(() => projectRuntime({ cases: 0, ms: 1, fixedMs: 0 }, 1, 1)).toThrow(/no measured case/);
  });
});
