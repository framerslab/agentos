/**
 * Unit tests for the MemoryTrustPolicy capability gate. Verifies the
 * source-type defaults, the staleness window via
 * `requiresReverificationAfterMs`, and the fallback when policy is absent.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRUST_POLICY_BY_SOURCE,
  canUseFor,
  type MemoryTrace,
  type MemoryTrustPolicy,
} from '../types.js';

function traceWith(
  partial: Omit<Partial<MemoryTrace>, 'provenance'> & {
    provenance?: Partial<MemoryTrace['provenance']>;
  },
): Pick<MemoryTrace, 'policy' | 'provenance'> {
  return {
    policy: partial.policy,
    provenance: {
      sourceType: 'tool_result',
      sourceTimestamp: 0,
      confidence: 1,
      verificationCount: 0,
      ...(partial.provenance ?? {}),
    },
  };
}

describe('DEFAULT_TRUST_POLICY_BY_SOURCE', () => {
  it('blocks user_statement from authorization and fact-claim', () => {
    const p = DEFAULT_TRUST_POLICY_BY_SOURCE.user_statement;
    expect(p.usableForAuthorization).toBe(false);
    expect(p.usableForFactClaim).toBe(false);
    expect(p.usableForPersonalization).toBe(true);
  });

  it('gives tool_result full trust', () => {
    const p = DEFAULT_TRUST_POLICY_BY_SOURCE.tool_result;
    expect(p.usableForAuthorization).toBe(true);
    expect(p.usableForPersonalization).toBe(true);
    expect(p.usableForFactClaim).toBe(true);
  });

  it('allows retrieved_document only for fact-claim with a 24h reverify window', () => {
    const p = DEFAULT_TRUST_POLICY_BY_SOURCE.retrieved_document;
    expect(p.usableForAuthorization).toBe(false);
    expect(p.usableForPersonalization).toBe(false);
    expect(p.usableForFactClaim).toBe(true);
    expect(p.requiresReverificationAfterMs).toBe(86_400_000);
  });

  it('treats external as zero-trust for every capability', () => {
    const p = DEFAULT_TRUST_POLICY_BY_SOURCE.external;
    expect(p.usableForAuthorization).toBe(false);
    expect(p.usableForPersonalization).toBe(false);
    expect(p.usableForFactClaim).toBe(false);
  });
});

describe('canUseFor', () => {
  it('returns true when no policy is set (no gating)', () => {
    const trace = traceWith({});
    expect(canUseFor(trace, 'authorization')).toBe(true);
    expect(canUseFor(trace, 'factClaim')).toBe(true);
  });

  it('respects a flag set to false', () => {
    const policy: MemoryTrustPolicy = {
      usableForAuthorization: false,
      usableForPersonalization: true,
      usableForFactClaim: false,
    };
    const trace = traceWith({ policy });
    expect(canUseFor(trace, 'authorization')).toBe(false);
    expect(canUseFor(trace, 'factClaim')).toBe(false);
    expect(canUseFor(trace, 'personalization')).toBe(true);
  });

  it('returns false when the staleness window has expired', () => {
    const policy: MemoryTrustPolicy = {
      usableForAuthorization: true,
      usableForPersonalization: true,
      usableForFactClaim: true,
      requiresReverificationAfterMs: 1_000,
    };
    const trace = traceWith({
      policy,
      provenance: { lastVerifiedAt: 100, sourceTimestamp: 0 },
    });
    // 100 + 1000 = 1100. now=2000 is past the window.
    expect(canUseFor(trace, 'authorization', 2_000)).toBe(false);
    // now=500 is inside.
    expect(canUseFor(trace, 'authorization', 500)).toBe(true);
  });

  it('uses sourceTimestamp when lastVerifiedAt is absent', () => {
    const policy: MemoryTrustPolicy = {
      usableForAuthorization: true,
      usableForPersonalization: true,
      usableForFactClaim: true,
      requiresReverificationAfterMs: 1_000,
    };
    const trace = traceWith({
      policy,
      provenance: { sourceTimestamp: 0, lastVerifiedAt: undefined },
    });
    // 0 + 1000 = 1000. now=2000 is past the window.
    expect(canUseFor(trace, 'authorization', 2_000)).toBe(false);
    expect(canUseFor(trace, 'authorization', 500)).toBe(true);
  });
});
