import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { estimateMaxTokensForZodSchema } from '../schemaTokenEstimate.js';

describe('estimateMaxTokensForZodSchema', () => {
  it('returns the minimum budget (512) for a tiny flat schema', () => {
    const schema = z.object({ ok: z.boolean() });
    const tokens = estimateMaxTokensForZodSchema(schema);
    expect(tokens).toBe(512);
  });

  it('exceeds the minimum for a moderately complex schema', () => {
    const schema = z.object({
      title: z.string(),
      sentiment: z.enum(['positive', 'negative', 'neutral', 'mixed']),
      topics: z.array(z.string()),
      confidence: z.number().min(0).max(1),
      summary: z.string(),
    });
    const tokens = estimateMaxTokensForZodSchema(schema);
    // Small flat schemas should still be at the floor, but the array+enum lift it above.
    expect(tokens).toBeGreaterThanOrEqual(512);
    expect(tokens).toBeLessThan(8192);
  });

  it('grows the budget for nested-array-of-objects schemas (the historical truncation case)', () => {
    const flat = z.object({ title: z.string(), prepTimeMinutes: z.number() });
    const nested = z.object({
      title: z.string(),
      ingredients: z.array(z.object({
        name: z.string(),
        amount: z.string(),
      })),
      steps: z.array(z.string()),
      prepTimeMinutes: z.number(),
    });

    const flatBudget = estimateMaxTokensForZodSchema(flat);
    const nestedBudget = estimateMaxTokensForZodSchema(nested);

    expect(nestedBudget).toBeGreaterThan(flatBudget);
    // The whole point of the helper: nested-array-of-objects must clear 1024
    // tokens so the JSON doesn't truncate mid-response.
    expect(nestedBudget).toBeGreaterThanOrEqual(1024);
  });

  it('sizes the budget from a string field\'s .max() so large-output schemas do not truncate', () => {
    // Regression: z.string() was treated as a flat ~30-token leaf regardless
    // of .max(), so a `source: z.string().max(80_000)` field (designed for
    // ~20K tokens of generated code) auto-estimated to the 512 floor and the
    // provider truncated the JSON mid-string. The estimate must scale with the
    // declared max length.
    const big = z.object({
      source: z.string().max(80_000),
      rationale: z.string().max(500),
    });
    const small = z.object({
      source: z.string().max(2_000),
      rationale: z.string().max(500),
    });
    const bigBudget = estimateMaxTokensForZodSchema(big);
    const smallBudget = estimateMaxTokensForZodSchema(small);
    expect(bigBudget).toBeGreaterThan(smallBudget);
    expect(bigBudget).toBeGreaterThanOrEqual(16_000);
  });

  it('clamps to the maximum (32000) for very large schemas', () => {
    // Build a wide schema with many fields and deeply nested arrays so the
    // raw walk well exceeds the 8192 cap.
    const wide = z.object({
      a: z.array(z.array(z.array(z.object({ x: z.string(), y: z.string(), z: z.string() })))),
      b: z.array(z.array(z.array(z.object({ x: z.string(), y: z.string(), z: z.string() })))),
      c: z.array(z.array(z.array(z.object({ x: z.string(), y: z.string(), z: z.string() })))),
    });
    expect(estimateMaxTokensForZodSchema(wide)).toBe(32000);
  });

  it('unwraps optional / nullable / default wrappers', () => {
    const wrapped = z.object({
      a: z.string().optional(),
      b: z.string().nullable(),
      c: z.string().default('hi'),
    });
    // Unwrapped, this is still a small flat schema, so it lands on the floor.
    expect(estimateMaxTokensForZodSchema(wrapped)).toBe(512);
  });

  it('handles ZodEnum and ZodLiteral leaves', () => {
    const schema = z.object({
      mode: z.enum(['cheap', 'balanced', 'best']),
      kind: z.literal('config'),
    });
    expect(estimateMaxTokensForZodSchema(schema)).toBe(512);
  });

  it('handles ZodUnion by budgeting for the worst-case branch', () => {
    const schema = z.object({
      result: z.union([
        z.object({ ok: z.literal(true), data: z.string() }),
        z.object({
          ok: z.literal(false),
          error: z.string(),
          stack: z.string(),
          context: z.array(z.object({ key: z.string(), value: z.string() })),
        }),
      ]),
    });
    // The error branch is materially larger than the success branch.
    // Walker should pick the larger.
    const tokens = estimateMaxTokensForZodSchema(schema);
    expect(tokens).toBeGreaterThanOrEqual(512);
  });

  it('returns the floor for a non-Zod input (defensive)', () => {
    expect(estimateMaxTokensForZodSchema(undefined)).toBe(512);
    expect(estimateMaxTokensForZodSchema(null)).toBe(512);
    expect(estimateMaxTokensForZodSchema({})).toBe(512);
    expect(estimateMaxTokensForZodSchema('not a schema')).toBe(512);
  });

  it('is bounded by MAX_DEPTH (no infinite recursion on cyclic schemas)', () => {
    // Construct a synthetic "cyclic" Zod-like node that would otherwise infinite-loop
    // by referencing itself via def.element.
    const cyclic: any = { _def: { typeName: 'ZodArray', element: null } };
    cyclic._def.element = cyclic;
    // Should return without throwing and within sane bounds.
    expect(() => estimateMaxTokensForZodSchema(cyclic)).not.toThrow();
    const tokens = estimateMaxTokensForZodSchema(cyclic);
    expect(tokens).toBeGreaterThanOrEqual(512);
    expect(tokens).toBeLessThanOrEqual(32000);
  });
});
