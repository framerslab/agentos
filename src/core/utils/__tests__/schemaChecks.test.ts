/**
 * @fileoverview SchemaChecks over the real Ajv, with the schemas each Ajv instance compiles counted. An instance keeps
 * every schema it compiles, in the code its checks share, for as long as it lives, so a caller that writes its schema
 * anew for every check would grow a single instance without end.
 */
import { describe, expect, it, vi } from 'vitest';

/** The schemas each Ajv instance compiled, in the order the instances were made. */
const compiles = vi.hoisted(() => [] as number[]);

vi.mock('ajv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ajv')>();
  const RealAjv = actual.default;
  class CountedAjv extends RealAjv {
    constructor(...args: ConstructorParameters<typeof RealAjv>) {
      super(...args);
      const instance = compiles.push(0) - 1;
      const compile = this.compile.bind(this);
      this.compile = ((...compileArgs: Parameters<typeof compile>) => {
        compiles[instance] += 1;
        return compile(...compileArgs);
      }) as typeof compile;
    }
  }
  return { ...actual, default: CountedAjv };
});

import { SchemaChecks, checkValue } from '../schemaChecks';

describe('SchemaChecks', () => {
  it('compiles at most 100 schemas on one Ajv instance, and a check compiled on an earlier one keeps working', () => {
    const checks = new SchemaChecks({ allErrors: true, coerceTypes: true, strict: false });
    const first = {
      $id: 'urn:example:reply',
      type: 'object',
      required: ['at'],
      properties: { at: { type: 'string', format: 'date-time' }, n: { type: 'number' } },
    };
    const firstCheck = checks.check(first);
    for (let call = 0; call < 250; call += 1) {
      // A schema read from each request is a new object every time, under the same $id.
      const check = checks.check({ $id: 'urn:example:reply', type: 'object', required: ['ok'] });
      expect(check({ ok: true })).toBe(true);
      expect(check({})).toBe(false);
    }
    expect(compiles.reduce((sum, count) => sum + count, 0)).toBe(251);
    expect(compiles.length).toBeGreaterThan(1);
    expect(Math.max(...compiles)).toBeLessThanOrEqual(100);

    // The first schema's check came from the first instance: it is the same check, and still checks its format and
    // coerces its number.
    expect(checks.check(first)).toBe(firstCheck);
    expect(checkValue(firstCheck, { at: '2026-10-18T03:00:00Z', n: '5' })).toEqual({
      valid: true,
      value: { at: '2026-10-18T03:00:00Z', n: 5 },
    });
    expect(firstCheck({ at: 'yesterday' })).toBe(false);
  });
});
