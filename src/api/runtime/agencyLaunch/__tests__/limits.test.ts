/**
 * resolveLaunchLimits: the defaults of every bound, a RangeError naming the field for a value outside its
 * range, an AgencyConfigError for approvals with no handler, and the members rule. Pure logic.
 */
import { describe, expect, it } from 'vitest';
import { AgencyConfigError } from '../../../types.js';
import { resolveLaunchLimits, type AgencyLaunchOptions } from '../types.js';

/** A stand-in for a gmi() handle: the mark gmi() sets and the options it was built with. */
const handle = (config: Record<string, unknown> = {}) =>
  Object.defineProperties({ generate: async () => ({}) }, { __gmiHandle: { value: true }, __config: { value: config } }) as unknown as NonNullable<AgencyLaunchOptions['members']>[string];

describe('resolveLaunchLimits', () => {
  it('applies the defaults', () => {
    expect(resolveLaunchLimits({ launch: true })).toEqual({
      maxDepth: 2,
      maxSeats: 5,
      maxConcurrent: 1,
      budgetShare: 0.5,
      maxLaunchTokens: 200_000,
      defaultDeadlineMs: 120_000,
      maxDeadlineMs: 600_000,
    });
    // A lower ceiling lowers the default deadline with it.
    expect(resolveLaunchLimits({ maxDeadlineMs: 60_000 }).defaultDeadlineMs).toBe(60_000);
  });

  it('refuses a value outside its range, naming the field', () => {
    const cases: Array<[AgencyLaunchOptions, string]> = [
      [{ maxDepth: 0 }, 'maxDepth'],
      [{ maxDepth: 5 }, 'maxDepth'],
      [{ maxDepth: 1.5 }, 'maxDepth'],
      [{ maxSeats: 13 }, 'maxSeats'],
      [{ maxConcurrent: 0 }, 'maxConcurrent'],
      [{ budgetShare: 0 }, 'budgetShare'],
      [{ budgetShare: 1.2 }, 'budgetShare'],
      [{ maxLaunchTokens: 1_999 }, 'maxLaunchTokens'],
      [{ maxLaunchCostUSD: 0 }, 'maxLaunchCostUSD'],
      [{ maxDeadlineMs: 3_600_001 }, 'maxDeadlineMs'],
      [{ defaultDeadlineMs: 999 }, 'defaultDeadlineMs'],
      [{ defaultDeadlineMs: 700_000 }, 'defaultDeadlineMs'],
    ];
    for (const [options, field] of cases) {
      expect(() => resolveLaunchLimits(options), field).toThrow(RangeError);
      expect(() => resolveLaunchLimits(options), field).toThrow(`agencies.${field}`);
    }
  });

  it('reads null as unset in every field, as a JSON or YAML config writes "unset"', () => {
    const nulls = {
      maxDepth: null,
      maxSeats: null,
      maxConcurrent: null,
      budgetShare: null,
      maxLaunchTokens: null,
      maxLaunchCostUSD: null,
      maxDeadlineMs: null,
      defaultDeadlineMs: null,
    } as unknown as AgencyLaunchOptions;
    expect(resolveLaunchLimits(nulls)).toEqual(resolveLaunchLimits({}));
  });

  it('refuses approvals with no handler, as agency() does', () => {
    expect(() => resolveLaunchLimits({ hitl: { approvals: { beforeTool: ['send_email'] } } })).toThrow(AgencyConfigError);
    expect(resolveLaunchLimits({ hitl: { approvals: { beforeTool: ['send_email'] }, handler: async () => ({ approved: true }) } }).hitl).toBeDefined();
  });

  it('takes only gmi() handles as members, each under its own learning key', () => {
    expect(() => resolveLaunchLimits({ members: { tutor: { generate: async () => ({}) } as never } })).toThrow('agencies.members.tutor');
    expect(() => resolveLaunchLimits({ members: { coach: handle({ learning: { agentKey: 'tutor' } }) } })).toThrow(/agencies\.members\.coach.*tutor/);
    expect(() => resolveLaunchLimits({ members: { tutor: handle({ learning: { agentKey: 'tutor' } }), helper: handle() } })).not.toThrow();
  });
});
