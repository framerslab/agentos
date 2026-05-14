/**
 * Unit tests for {@link scopeToMetadataFilter} + {@link mergeMetadataFilters}.
 * Validates the trust-ordering semantics for classification (public → restricted),
 * the default status filter, and the merge rule (caller wins on conflict).
 */

import { describe, expect, it } from 'vitest';
import { mergeMetadataFilters, scopeToMetadataFilter } from './scopeFilter.js';

describe('scopeToMetadataFilter', () => {
  it('returns the default status filter when scope is empty', () => {
    // Even an empty scope adds the lifecycle constraint so archived/draft
    // chunks don't leak by default. Callers who explicitly want archived
    // material set `status: [...]` themselves.
    const filter = scopeToMetadataFilter({});
    expect(filter).toEqual({ status: { $in: ['active'] } });
  });

  it('returns undefined when scope itself is undefined', () => {
    expect(scopeToMetadataFilter(undefined)).toBeUndefined();
  });

  it('emits $eq on tenantId when set', () => {
    const filter = scopeToMetadataFilter({ tenantId: 'acme' });
    expect(filter?.tenantId).toEqual({ $eq: 'acme' });
  });

  it('emits $in on aclGroups when non-empty', () => {
    const filter = scopeToMetadataFilter({ aclGroups: ['legal', 'support-tier-2'] });
    expect(filter?.aclGroups).toEqual({ $in: ['legal', 'support-tier-2'] });
  });

  it('omits aclGroups when the principal has no groups', () => {
    const filter = scopeToMetadataFilter({ aclGroups: [] });
    expect(filter?.aclGroups).toBeUndefined();
  });

  it('translates maxClassification into an ordered $in subset', () => {
    expect(scopeToMetadataFilter({ maxClassification: 'public' })?.classification).toEqual({
      $in: ['public'],
    });
    expect(scopeToMetadataFilter({ maxClassification: 'internal' })?.classification).toEqual({
      $in: ['public', 'internal'],
    });
    expect(scopeToMetadataFilter({ maxClassification: 'confidential' })?.classification).toEqual({
      $in: ['public', 'internal', 'confidential'],
    });
    expect(scopeToMetadataFilter({ maxClassification: 'restricted' })?.classification).toEqual({
      $in: ['public', 'internal', 'confidential', 'restricted'],
    });
  });

  it('overrides the default status when caller supplies a list', () => {
    const filter = scopeToMetadataFilter({ status: ['active', 'archived'] });
    expect(filter?.status).toEqual({ $in: ['active', 'archived'] });
  });

  it('emits validity-window conditions when now is provided', () => {
    const now = '2026-05-14T12:00:00.000Z';
    const filter = scopeToMetadataFilter({ now });
    expect(filter?.effectiveDate).toEqual({ $lte: now });
    expect(filter?.expiresAt).toEqual({ $gte: now });
  });

  it('does not emit validity-window conditions when now is absent', () => {
    const filter = scopeToMetadataFilter({ tenantId: 'acme' });
    expect(filter?.effectiveDate).toBeUndefined();
    expect(filter?.expiresAt).toBeUndefined();
  });

  it('composes all fields together', () => {
    const filter = scopeToMetadataFilter({
      tenantId: 'acme',
      aclGroups: ['legal'],
      maxClassification: 'internal',
      status: ['active'],
      now: '2026-05-14T12:00:00.000Z',
    });
    expect(filter).toEqual({
      tenantId: { $eq: 'acme' },
      aclGroups: { $in: ['legal'] },
      classification: { $in: ['public', 'internal'] },
      status: { $in: ['active'] },
      effectiveDate: { $lte: '2026-05-14T12:00:00.000Z' },
      expiresAt: { $gte: '2026-05-14T12:00:00.000Z' },
    });
  });
});

describe('mergeMetadataFilters', () => {
  it('returns scope when caller is undefined', () => {
    const scope = { tenantId: { $eq: 'acme' } };
    expect(mergeMetadataFilters(undefined, scope)).toBe(scope);
  });

  it('returns caller when scope is undefined', () => {
    const caller = { foo: 'bar' };
    expect(mergeMetadataFilters(caller, undefined)).toBe(caller);
  });

  it('returns undefined when both are undefined', () => {
    expect(mergeMetadataFilters(undefined, undefined)).toBeUndefined();
  });

  it('caller wins on conflicting keys', () => {
    const caller = { tenantId: { $eq: 'partner' } };
    const scope = { tenantId: { $eq: 'acme' } };
    expect(mergeMetadataFilters(caller, scope)).toEqual({ tenantId: { $eq: 'partner' } });
  });

  it('unifies non-conflicting keys from both', () => {
    const caller = { foo: 'bar' };
    const scope = { tenantId: { $eq: 'acme' }, status: { $in: ['active'] } };
    expect(mergeMetadataFilters(caller, scope)).toEqual({
      foo: 'bar',
      tenantId: { $eq: 'acme' },
      status: { $in: ['active'] },
    });
  });
});
