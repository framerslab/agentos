import { describe, expect, it } from 'vitest';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { SqlActionLimiter, actionLimiterDdl, limiterKeyOf, limiterOperationOf, type ActionLimitRule, type SqlActionLimiterOptions } from '../ActionLimiter.js';
import { defaultIdempotencyKey } from '../GovernedTool.js';

const HOUR = 3_600_000;
const room: ActionLimitRule = { id: 'mute_room_hour', scope: 'room', windowMs: HOUR, max: 3 };
const target: ActionLimitRule = { id: 'mute_target_day', scope: 'target', windowMs: 24 * HOUR, max: 1 };
const all: ActionLimitRule = { id: 'mute_all_hour', scope: 'platform', windowMs: HOUR, max: 20 };
/** A store the constructor's checks accept; no statement reaches it. */
const db = { kind: 'fixture', capabilities: new Set(['transactions']) } as unknown as StorageAdapter;
const built = (rules: ActionLimitRule[], over: Partial<SqlActionLimiterOptions> = {}) => () => new SqlActionLimiter({ db, rules, requireShared: false, ...over });

describe('the limiter keys', () => {
  it('names a rule and what it counts, and keeps dry runs apart', () => {
    expect(limiterKeyOf(room, { accountId: 'u1', roomId: 'r1' }, false)).toBe('mute_room_hour|r:r1');
    expect(limiterKeyOf(target, { accountId: 'u1', roomId: 'r1' }, false)).toBe('mute_target_day|t:u1');
    expect(limiterKeyOf(all, {}, false)).toBe('mute_all_hour|p');
    expect(limiterKeyOf(room, { accountId: 'u1', roomId: 'r1' }, true)).toBe('dry:mute_room_hour|r:r1');
    expect(limiterKeyOf(room, { accountId: 'u1' }, false)).toBeUndefined();
    expect(limiterKeyOf(target, { roomId: 'r1' }, false)).toBeUndefined();
    expect(limiterOperationOf('abc', room, false)).toBe('abc:mute_room_hour');
    expect(limiterOperationOf('abc', room, true)).toBe('dry:abc:mute_room_hour');
  });
});

describe('the default idempotency key', () => {
  const actor = { id: 'moderator-1', kind: 'agent' as const };
  const base = defaultIdempotencyKey(actor, 'mute_in_room', { accountId: 'u1', roomId: 'r1' }, ['m2', 'm1']);
  it('is the same whatever order the message ids come in', () => {
    expect(defaultIdempotencyKey(actor, 'mute_in_room', { accountId: 'u1', roomId: 'r1' }, ['m1', 'm2'])).toBe(base);
  });
  it('differs per actor, action, target, room and message', () => {
    const others = [
      defaultIdempotencyKey({ id: 'moderator-2', kind: 'agent' }, 'mute_in_room', { accountId: 'u1', roomId: 'r1' }, ['m1', 'm2']),
      defaultIdempotencyKey({ id: 'moderator-1', kind: 'system' }, 'mute_in_room', { accountId: 'u1', roomId: 'r1' }, ['m1', 'm2']),
      defaultIdempotencyKey(actor, 'hold_message', { accountId: 'u1', roomId: 'r1' }, ['m1', 'm2']),
      defaultIdempotencyKey(actor, 'mute_in_room', { accountId: 'u2', roomId: 'r1' }, ['m1', 'm2']),
      defaultIdempotencyKey(actor, 'mute_in_room', { accountId: 'u1', roomId: 'r2' }, ['m1', 'm2']),
      defaultIdempotencyKey(actor, 'mute_in_room', { accountId: 'u1' }, ['m1', 'm2']),
      defaultIdempotencyKey(actor, 'mute_in_room', { accountId: 'u1', roomId: 'r1' }, ['m1']),
    ];
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });
});

describe('what a limiter refuses to be built with', () => {
  it.each([
    ['a rule id of 20 characters', built([{ ...room, id: 'a'.repeat(20) }])],
    ['a rule id with an upper-case letter', built([{ ...room, id: 'Mute_room' }])],
    ['no rule', built([])],
    ['a lease as long as a window', built([room], { leaseMs: HOUR })],
    ['one id with two sets of numbers', built([room, { ...room, max: 4 }])],
    ['a prefix and a window whose table name runs past 38 characters', built([target], { tablePrefix: 'a_very_long_prefix_for_the_limiter' })],
  ])('%s', (_name, build) => { expect(build).toThrow(TypeError); });
  it('takes the same rule listed twice, and writes the DDL of each distinct window once', () => {
    expect(built([room, { ...room }, target])).not.toThrow();
    const ddl = actionLimiterDdl([HOUR, HOUR, 24 * HOUR], 'acts');
    expect(ddl.match(/CREATE TABLE IF NOT EXISTS acts_w3600000_meter/g)).toHaveLength(1);
    expect(ddl).toContain('acts_w86400000_reservations');
  });
});
