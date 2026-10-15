import { describe, expect, it } from 'vitest';
import {
  canDeliverSourceDerivation,
  createSourceDerivation,
  type SourceDependency,
  type SourceDependencyState,
  type SourceDeliveryContext,
  type SourceDeliverySurface,
} from '../SourceDerivations.js';

const source = (patch: Partial<SourceDependency> = {}): SourceDependency => ({
  tenantId: 'tenant-a',
  ownerId: 'owner-a',
  connectionId: 'connection-a',
  generation: 2,
  sourceId: 'thread-a',
  messageIds: ['message-a'],
  version: 'content-version-a',
  expiresAt: 4_000,
  ...patch,
});

const state = (patch: Partial<SourceDependencyState> = {}): SourceDependencyState => ({
  ...source(),
  connected: true,
  paused: false,
  searchAskEnabled: true,
  liveEnabled: true,
  ...patch,
});

const context = (patch: Partial<SourceDeliveryContext> = {}): SourceDeliveryContext => ({
  tenantId: 'tenant-a',
  ownerId: 'owner-a',
  surface: 'ask',
  liveOptIn: false,
  ...patch,
});

describe('source-derived delivery', () => {
  it('keeps every private dependency of a mixed answer and the earliest expiry', () => {
    const answer = createSourceDerivation([
      source(),
      source({ sourceId: 'thread-b', messageIds: ['message-b'], expiresAt: 3_000 }),
    ]);
    expect(answer.visibility).toBe('personal');
    expect(answer.dependencies).toHaveLength(2);
    expect(answer.expiresAt).toBe(3_000);
    expect(canDeliverSourceDerivation(answer, context(), [
      state(),
      state({ sourceId: 'thread-b', messageIds: ['message-b'], expiresAt: 3_000 }),
    ], 2_999)).toBe(true);
    expect(canDeliverSourceDerivation(answer, context(), [state()], 2_000)).toBe(false);
  });

  it('unions message provenance without retaining caller-owned arrays', () => {
    const ids = ['message-b', 'message-a'];
    const answer = createSourceDerivation([
      source({ messageIds: ids }),
      source({ messageIds: ['message-c', 'message-a'], expiresAt: 3_000 }),
    ]);
    ids.push('message-d');
    expect(answer.dependencies).toHaveLength(1);
    expect(answer.dependencies[0]?.messageIds).toEqual(['message-a', 'message-b', 'message-c']);
    expect(answer.dependencies[0]?.expiresAt).toBe(3_000);
    expect(Object.isFrozen(answer)).toBe(true);
    expect(Object.isFrozen(answer.dependencies)).toBe(true);
    expect(Object.isFrozen(answer.dependencies[0]?.messageIds)).toBe(true);
  });

  it('rejects empty, invalid or mixed-owner envelopes with a fixed error', () => {
    for (const invalid of [
      [],
      [source({ messageIds: [] })],
      [source({ generation: -1 })],
      [source({ generation: 1.5 })],
      [source({ expiresAt: Number.NaN })],
      [source({ version: '' })],
      [source(), source({ ownerId: 'owner-b' })],
      [source(), source({ tenantId: 'tenant-b' })],
      [source(), source({ version: 'different-version' })],
      [source(), source({ generation: 3 })],
    ]) {
      expect(() => createSourceDerivation(invalid)).toThrow('invalid_source_dependency');
    }
  });

  it('rejects another tenant or account even with the original dependency state', () => {
    const answer = createSourceDerivation([source()]);
    expect(canDeliverSourceDerivation(answer, context({ tenantId: 'tenant-b' }), [state()], 1_000)).toBe(false);
    expect(canDeliverSourceDerivation(answer, context({ ownerId: 'owner-b' }), [state()], 1_000)).toBe(false);
  });

  it.each<SourceDeliverySurface>(['team', 'guest', 'share', 'export', 'outbound'])(
    'rejects the entire result on %s',
    (surface) => {
      expect(canDeliverSourceDerivation(
        createSourceDerivation([source()]), context({ surface }), [state()], 1_000,
      )).toBe(false);
    },
  );

  it('requires both the saved personal-live choice and the current live switch', () => {
    const answer = createSourceDerivation([source()]);
    expect(canDeliverSourceDerivation(answer, context({ surface: 'live' }), [state()], 1_000)).toBe(false);
    expect(canDeliverSourceDerivation(answer, context({ surface: 'live', liveOptIn: true }), [state()], 1_000)).toBe(true);
    expect(canDeliverSourceDerivation(
      answer, context({ surface: 'live', liveOptIn: true }), [state({ liveEnabled: false })], 1_000,
    )).toBe(false);
  });

  it.each<SourceDeliverySurface>(['search', 'ask'])(
    'delivers a current personal result to %s',
    (surface) => {
      expect(canDeliverSourceDerivation(
        createSourceDerivation([source()]), context({ surface }), [state()], 1_000,
      )).toBe(true);
    },
  );

  it.each<SourceDeliverySurface>(['search', 'ask'])(
    'checks the current private-use switch for %s',
    (surface) => {
      expect(canDeliverSourceDerivation(
        createSourceDerivation([source()]), context({ surface }),
        [state({ searchAskEnabled: false })], 1_000,
      )).toBe(false);
    },
  );

  it('does not couple a separately enabled live source to the search/Ask switch', () => {
    expect(canDeliverSourceDerivation(
      createSourceDerivation([source()]), context({ surface: 'live', liveOptIn: true }),
      [state({ searchAskEnabled: false, liveEnabled: true })], 1_000,
    )).toBe(true);
  });

  it('denies disconnect, pause, generation change, source change or missing messages', () => {
    const answer = createSourceDerivation([source()]);
    const changed: Partial<SourceDependencyState>[] = [
      { connected: false }, { paused: true }, { generation: 3 },
      { version: 'content-version-b' }, { messageIds: ['message-b'] },
      { sourceId: 'thread-b' }, { connectionId: 'connection-b' },
    ];
    for (const patch of changed) {
      expect(canDeliverSourceDerivation(answer, context(), [state(patch)], 1_000)).toBe(false);
    }
  });

  it('expires at the boundary and never extends a result when a source is re-read', () => {
    const answer = createSourceDerivation([source()]);
    expect(canDeliverSourceDerivation(answer, context(), [state({ expiresAt: 9_000 })], 4_000)).toBe(false);
    expect(canDeliverSourceDerivation(answer, context(), [state({ expiresAt: 2_000 })], 2_000)).toBe(false);
    expect(canDeliverSourceDerivation(answer, context(), [state()], Number.NaN)).toBe(false);
  });

  it('fails closed on ambiguous current rows and an inconsistent persisted envelope', () => {
    const answer = createSourceDerivation([source()]);
    expect(canDeliverSourceDerivation(answer, context(), [state(), state()], 1_000)).toBe(false);
    expect(canDeliverSourceDerivation({ ...answer, expiresAt: 9_000 }, context(), [state()], 1_000)).toBe(false);
    expect(canDeliverSourceDerivation({ ...answer, dependencies: [] }, context(), [state()], 1_000)).toBe(false);
  });
});
