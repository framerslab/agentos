/**
 * @file dropNullsForOptionalFields.test.ts
 * A strict json_schema payload makes every optional property nullable, so a
 * model writes `null` for a property the caller's schema leaves out. The reply
 * readers drop that `null` before the caller's schema checks the reply: only
 * where the schema takes the property's absence and refuses `null`.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkStructuredReply, dropNullsForOptionalFields, resolveStructuredReply } from '../structuredReply.js';

const Frame = z.object({
  text: z.string().min(1),
  speaker: z.string().min(1).optional(),
  imageUrl: z.string().min(1).optional(),
  clipDurationSec: z.number().min(5).optional(),
  transition: z.object({ kind: z.enum(['cut', 'fade']), durationMs: z.number().min(150) }).optional(),
});
const Scene = z.object({
  id: z.string(),
  title: z.string().optional(),
  frames: z.array(Frame).min(1),
  note: z.string().nullable().optional(),
  caption: z.string().nullable(),
});

describe('dropNullsForOptionalFields', () => {
  it('drops a null for an optional property, so { text, speaker: null, imageUrl: null } validates', () => {
    const cleaned = dropNullsForOptionalFields({ text: 'Hello', speaker: null, imageUrl: null }, Frame);
    expect(cleaned).toEqual({ text: 'Hello' });
    expect(Frame.safeParse(cleaned).success).toBe(true);
  });

  it('reaches objects in arrays and nested optional objects, and keeps the nulls a nullable property takes', () => {
    const reply = {
      id: 's1',
      title: null,
      note: null,
      caption: null,
      frames: [
        { text: 'One', speaker: null, imageUrl: null, clipDurationSec: null, transition: null },
        { text: 'Two', speaker: 'Ana', transition: { kind: 'fade', durationMs: 300 } },
      ],
    };
    const cleaned = dropNullsForOptionalFields(reply, Scene);
    expect(cleaned).toEqual({
      id: 's1',
      note: null,
      caption: null,
      frames: [{ text: 'One' }, { text: 'Two', speaker: 'Ana', transition: { kind: 'fade', durationMs: 300 } }],
    });
    expect(Scene.safeParse(cleaned).success).toBe(true);
  });

  it('keeps a null for a required property that refuses it, so the schema still reports it', () => {
    const cleaned = dropNullsForOptionalFields({ text: null }, Frame);
    expect(cleaned).toEqual({ text: null });
    expect(Frame.safeParse(cleaned).success).toBe(false);
  });

  it("drops a null for a property with a default, so the schema's default applies", () => {
    const schema = z.object({ mode: z.enum(['a', 'b']).default('a') });
    const cleaned = dropNullsForOptionalFields({ mode: null }, schema);
    expect(schema.parse(cleaned)).toEqual({ mode: 'a' });
  });

  it('keeps a key the schema does not name, and returns the value itself when nothing is dropped', () => {
    const reply = { text: 'Hi', extra: null };
    expect(dropNullsForOptionalFields(reply, Frame)).toBe(reply);
  });

  it('never changes its input', () => {
    const reply = { id: 's1', caption: null, frames: [{ text: 'One', speaker: null }] };
    const before = JSON.stringify(reply);
    dropNullsForOptionalFields(reply, Scene);
    expect(JSON.stringify(reply)).toBe(before);
  });

  it('picks the union member that takes the value once its nulls are dropped', () => {
    const schema = z.object({
      action: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('move'), dir: z.string().min(1).optional() }),
        z.object({ kind: z.literal('wait'), ms: z.number().min(1).optional() }),
      ]),
    });
    const cleaned = dropNullsForOptionalFields({ action: { kind: 'wait', ms: null } }, schema);
    expect(cleaned).toEqual({ action: { kind: 'wait' } });
    expect(schema.safeParse(cleaned).success).toBe(true);
  });

  it('keeps a __proto__ key from JSON.parse a key, never the prototype', () => {
    const schema = z.record(z.string(), z.object({ a: z.string().optional() }));
    const reply = JSON.parse('{"__proto__":{"a":null},"x":{"a":null}}') as Record<string, unknown>;
    const cleaned = dropNullsForOptionalFields(reply, schema) as Record<string, unknown>;
    expect(Object.getPrototypeOf(cleaned)).toBe(Object.prototype);
    expect(Object.keys(cleaned)).toEqual(['__proto__', 'x']);
    expect(cleaned.x).toEqual({});
  });
});

describe("the GMI's structured-turn check (checkStructuredReply)", () => {
  it('accepts a reply whose optional properties came back null, as a strict hop writes them', () => {
    const resolved = resolveStructuredReply({ schema: Frame, name: 'frame' })!;
    const check = checkStructuredReply('{"text":"Hello","speaker":null,"imageUrl":null,"clipDurationSec":null,"transition":null}', resolved);
    expect(check).toEqual({ ok: true, value: { text: 'Hello' } });
  });
});
