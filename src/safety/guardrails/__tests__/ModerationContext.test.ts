/**
 * @file ModerationContext.test.ts
 * The typed context's check: the five fields pass, and a field that is not a word or an id is named and its value is
 * never repeated.
 */
import { describe, expect, it } from 'vitest';
import { assertModerationContext, isModerationId } from '../ModerationContext';

const base = { surface: 'public_room', roomId: 'room:1/a', rating: 'standard', messageId: 'm-1', sender: { id: 'u_1', kind: 'guest' } };

describe('assertModerationContext', () => {
  it('passes the five fields, a surface of the host\'s own, and a context with a surface alone', () => {
    expect(() => assertModerationContext(base)).not.toThrow();
    expect(() => assertModerationContext({ surface: 'guild.hall' })).not.toThrow();
    expect(() => assertModerationContext({ surface: 'upload', sender: { id: 'u1' } })).not.toThrow();
  });
  it.each([
    ['surface', { ...base, surface: 'a room' }],
    ['surface', { roomId: 'r1' }],
    ['roomId', { ...base, roomId: 'r|1' }],
    ['roomId', { ...base, roomId: '' }],
    ['roomId', { ...base, roomId: 'r'.repeat(129) }],
    ['rating', { ...base, rating: 'for adults only' }],
    ['messageId', { ...base, messageId: 42 }],
    ['sender.id', { ...base, sender: { id: 'someone@example.com' } }],
    ['sender.id', { ...base, sender: {} }],
    ['sender.kind', { ...base, sender: { id: 'u1', kind: 'admin' } }],
    ['sender', { ...base, sender: 'u1' }],
  ] as const)('names %s and never the value', (field, value) => {
    let message = '';
    try { assertModerationContext(value); } catch (error) { expect(error).toBeInstanceOf(TypeError); message = (error as Error).message; }
    expect(message).toContain(`context.moderation.${field}`);
    for (const given of ['a room', 'r|1', 'for adults only', 'someone@example.com', 'admin']) expect(message).not.toContain(given);
  });
  it('refuses a value that is not an object', () => {
    for (const value of [null, 'public_room', ['public_room'], undefined]) expect(() => assertModerationContext(value)).toThrow(TypeError);
  });
});

describe('isModerationId', () => {
  it('takes letters, digits and _ . : / - up to 128, and nothing else', () => {
    expect(isModerationId('org:room/42_a.b-c')).toBe(true);
    expect(isModerationId('a'.repeat(128))).toBe(true);
    for (const value of ['', 'a'.repeat(129), 'a b', 'a|b', 'a\nb', 'meet me at the corner', 7, null]) expect(isModerationId(value)).toBe(false);
  });
});
