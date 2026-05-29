/**
 * @file global-default.test.ts
 * Unit tests for the module-level default-provider registry.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setDefaultProvider,
  getDefaultProvider,
  clearDefaultProvider,
} from '../global-default.js';

describe('global default provider registry', () => {
  beforeEach(() => {
    clearDefaultProvider();
  });

  it('returns undefined when no default has been set', () => {
    expect(getDefaultProvider()).toBeUndefined();
  });

  it('stores and returns a default config', () => {
    setDefaultProvider({ provider: 'openai', apiKey: 'sk-test' });
    expect(getDefaultProvider()).toEqual({ provider: 'openai', apiKey: 'sk-test' });
  });

  it('overwrites the previous default on subsequent setDefaultProvider calls', () => {
    setDefaultProvider({ provider: 'openai', apiKey: 'sk-test-1' });
    setDefaultProvider({ provider: 'anthropic', apiKey: 'sk-ant-test' });
    expect(getDefaultProvider()).toEqual({ provider: 'anthropic', apiKey: 'sk-ant-test' });
  });

  it('clears the default when setDefaultProvider is called with undefined', () => {
    setDefaultProvider({ provider: 'openai', apiKey: 'sk-test' });
    setDefaultProvider(undefined);
    expect(getDefaultProvider()).toBeUndefined();
  });

  it('clears the default via clearDefaultProvider', () => {
    setDefaultProvider({ provider: 'openai', apiKey: 'sk-test' });
    clearDefaultProvider();
    expect(getDefaultProvider()).toBeUndefined();
  });

  it('accepts model and baseUrl alongside provider and apiKey', () => {
    setDefaultProvider({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      baseUrl: 'https://my-proxy.example.com/v1',
    });
    expect(getDefaultProvider()).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      baseUrl: 'https://my-proxy.example.com/v1',
    });
  });
});
