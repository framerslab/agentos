/**
 * The provider policy and the STT entry parser in a browser: neither reads
 * process state nor imports a provider SDK, so a browser bundle can check a
 * policy at the call boundary and parse a registered entry.
 */
import { describe, expect, it } from 'vitest';
import { freezeProviderPolicy, assertCallProviderPolicy, legacyProviderPolicy } from '../ProviderPolicy.js';
import { parseSttEntry } from '../sttEntries.js';

describe('browser-safe policy and registered entry contracts', () => {
  it('imports without process/environment discovery or provider SDKs', () => {
    expect(freezeProviderPolicy(legacyProviderPolicy).mode).toBe('legacy');
    expect(() => assertCallProviderPolicy(legacyProviderPolicy)).toThrow();
    expect(parseSttEntry('local-a:model', ['local-a'])).toEqual({ vendor: 'local-a', model: 'model' });
  });
});
