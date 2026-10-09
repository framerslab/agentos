/**
 * @fileoverview The structured reply's parsers and checks: JSON found in plain text, a fence or between braces; the
 * string-encoded container repair; a Zod and a JSON Schema check; the spec's resolution and defaults; the repair
 * message; the check after an output guardrail.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  checkStructuredReply,
  extractJson,
  recheckStructuredReply,
  resolveStructuredReply,
  resolveStructuredReplySpec,
  StructuredReplyConfigError,
  structuredRepairMessage,
} from '../structuredReply';

const plan = z.object({ items: z.array(z.object({ date: z.string(), title: z.string(), heavy: z.boolean() })), note: z.string().optional() });

describe('extractJson', () => {
  it('reads plain JSON, a fenced block and an object inside prose, and refuses text without one', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n```json\n{"a": 2}\n```\nDone.')).toEqual({ a: 2 });
    expect(extractJson('The plan is {"a": 3} as asked.')).toEqual({ a: 3 });
    expect(() => extractJson('no json here')).toThrow(SyntaxError);
  });
});

describe('resolveStructuredReply', () => {
  it('takes a Zod schema with its defaults, clamps the retries and names the reply', () => {
    const resolved = resolveStructuredReply({ schema: plan })!;
    expect(resolved).toMatchObject({ name: 'reply', maxRetries: 2, onExhausted: 'error', streamDeltas: false });
    expect(resolved.zod).toBe(plan);
    expect(resolved.jsonSchema).toMatchObject({ type: 'object' });
    expect(resolved.instruction).toContain('The JSON MUST conform to this JSON Schema:');
    expect(resolveStructuredReply({ schema: plan, name: ' week ', maxRetries: 9, onExhausted: 'return_invalid', streamDeltas: true })).toMatchObject({ name: 'week', maxRetries: 5, onExhausted: 'return_invalid', streamDeltas: true });
    expect(resolveStructuredReply({ schema: plan, maxRetries: -3 })).toMatchObject({ maxRetries: 0 });
    expect(resolveStructuredReply(undefined)).toBeNull();
  });

  it('takes a JSON Schema and checks with it, and refuses a spec with no schema, a bad ref or a schema that is neither', () => {
    const resolved = resolveStructuredReply({ schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false }, name: 'count' })!;
    expect(resolved.zod).toBeUndefined();
    expect(resolved.checkValue({ n: 3 })).toEqual({ ok: true, value: { n: 3 } });
    const bad = resolved.checkValue({ n: 'three', extra: 1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.join('\n')).toMatch(/\/n: must be integer|<root>: must NOT have additional properties/);
    expect(() => resolveStructuredReply({})).toThrow(StructuredReplyConfigError);
    expect(() => resolveStructuredReplySpec({ schemaRef: 'missing' }, new Map())).toThrow(/"missing" is not in AgentOSConfig.structuredSchemas/);
    expect(resolveStructuredReplySpec({ schemaRef: 'plan' }, new Map([['plan', plan]])).schema).toBe(plan);
    expect(() => resolveStructuredReplySpec({ schema: 'nope' as never })).toThrow(/Zod schema or a JSON Schema object/);
    expect(() => resolveStructuredReply({ schema: { type: 'object', properties: { n: { type: 'not-a-type' } } } })).toThrow(/not a valid JSON Schema/);
  });
});

describe('checkStructuredReply', () => {
  const resolved = resolveStructuredReply({ schema: plan, name: 'week' })!;

  it('passes a matching reply, repairs a string-encoded container, and names the issues of one that does not match', () => {
    expect(checkStructuredReply('{"items":[{"date":"2026-10-13","title":"Drill","heavy":false}]}', resolved)).toEqual({ ok: true, value: { items: [{ date: '2026-10-13', title: 'Drill', heavy: false }] } });
    // the model double-encoded the array: the repair reads it in place
    expect(checkStructuredReply('{"items":"[{\\"date\\":\\"2026-10-13\\",\\"title\\":\\"Drill\\",\\"heavy\\":true}]"}', resolved)).toEqual({ ok: true, value: { items: [{ date: '2026-10-13', title: 'Drill', heavy: true }] } });
    const bad = checkStructuredReply('{"items":[{"date":"2026-10-13","title":"Drill"}]}', resolved);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.join('\n')).toContain('items.0.heavy');
      expect(bad.value).toEqual({ items: [{ date: '2026-10-13', title: 'Drill' }] });
    }
    const prose = checkStructuredReply('Sure! Monday: a drill.', resolved);
    expect(prose.ok).toBe(false);
    if (!prose.ok) expect(prose.issues[0]).toMatch(/the reply is not JSON/);
  });

  it('writes the repair message from the issues and the reply, and rechecks after a guardrail rewrote the text', () => {
    const message = structuredRepairMessage(['- items.0.heavy: Required'], resolved, 'x'.repeat(600));
    expect(message).toContain('did not match the required JSON schema for "week"');
    expect(message).toContain('- items.0.heavy: Required');
    expect(message).toContain('(truncated, 100 more chars)');
    expect(message).toMatch(/ONLY the corrected JSON object/);
    const previous = { value: { items: [] }, meta: { schemaName: 'week', valid: true, attempts: 1, enforcement: 'prompt_only' as const, stage: 'model' as const } };
    expect(recheckStructuredReply('{"items":[]}', previous, resolved)).toEqual({ value: { items: [] }, meta: { ...previous.meta, stage: 'post_guardrail', issues: undefined } });
    const broken = recheckStructuredReply('[the reply was replaced]', previous, resolved);
    expect(broken.meta).toMatchObject({ valid: false, stage: 'post_guardrail' });
    expect(broken.meta.issues?.[0]).toMatch(/not JSON/);
  });
});
