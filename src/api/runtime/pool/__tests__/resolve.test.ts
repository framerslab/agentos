import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSeatCredentials, availabilityOf, agencyProviderOf } from '../resolve.js';
import { setDefaultProvider, clearDefaultProvider } from '../../global-default.js';
import { globalLLMProviderHealth } from '../../../../core/safety/LLMProviderHealthRegistry.js';
import type { AgencyOptions } from '../../../types.js';

const agency = (o: Partial<AgencyOptions>): AgencyOptions => ({ agents: {}, ...o });
beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => { vi.unstubAllEnvs(); clearDefaultProvider(); });

describe('resolveSeatCredentials', () => {
  it('provider: own, else a known prefix of model, else the agency level read the same way', () => {
    expect(resolveSeatCredentials({ provider: 'xai', model: 'grok-4', inherits: true }, agency({ provider: 'openai' }))).toMatchObject({ ok: true, value: { provider: 'xai', model: 'grok-4' } });
    expect(resolveSeatCredentials({ model: 'anthropic:claude-opus-5-5', inherits: true }, agency({ provider: 'openai' }))).toMatchObject({ ok: true, value: { provider: 'anthropic', model: 'claude-opus-5-5' } });
    expect(resolveSeatCredentials({ inherits: true }, agency({ model: 'openai:gpt-4.1' }))).toMatchObject({ ok: true, value: { provider: 'openai', model: 'gpt-4.1' } });
    expect(resolveSeatCredentials({ inherits: true }, agency({}))).toMatchObject({ ok: false, reason: 'no provider' });
    expect(agencyProviderOf(agency({ model: 'gemini:gemini-2.5-flash' }))).toBe('gemini');
  });
  it('model: own, else the agency model on the agency provider, else the provider default text model', () => {
    vi.stubEnv('XAI_API_KEY', 'x'); vi.stubEnv('ANTHROPIC_API_KEY', 'a');
    expect(resolveSeatCredentials({ provider: 'xai', inherits: true }, agency({ provider: 'anthropic', model: 'claude-opus-5-5' }))).toMatchObject({ ok: true, value: { provider: 'xai', model: 'grok-2' } });
    expect(resolveSeatCredentials({ provider: 'anthropic', inherits: true }, agency({ provider: 'anthropic', model: 'claude-opus-5-5' }))).toMatchObject({ ok: true, value: { model: 'claude-opus-5-5' } });
    expect(resolveSeatCredentials({ provider: 'stability', inherits: true }, agency({}))).toMatchObject({ ok: false, reason: 'no model' });
  });
  it('key and URL: own, the agency level only on the agency provider, a same-provider default, the environment; empty counts as missing', () => {
    vi.stubEnv('OPENAI_API_KEY', 'env-openai'); vi.stubEnv('ANTHROPIC_API_KEY', 'env-anthropic'); vi.stubEnv('OPENAI_BASE_URL', 'https://env.local/v1');
    const a = agency({ provider: 'openai', model: 'gpt-4.1', apiKey: 'agency-key', baseUrl: 'https://agency.local/v1' });
    expect(resolveSeatCredentials({ provider: 'openai', inherits: true }, a)).toMatchObject({ ok: true, value: { apiKey: 'agency-key', baseUrl: 'https://agency.local/v1' } });
    expect(resolveSeatCredentials({ provider: 'openai', apiKey: 'own', inherits: true }, a)).toMatchObject({ ok: true, value: { apiKey: 'own' } });
    expect(resolveSeatCredentials({ provider: 'openai', apiKey: '', inherits: true }, a)).toMatchObject({ ok: true, value: { apiKey: 'agency-key' } });
    expect(resolveSeatCredentials({ provider: 'anthropic', model: 'claude-opus-5-5', inherits: true }, a)).toMatchObject({ ok: true, value: { apiKey: 'env-anthropic', baseUrl: undefined } });
    expect(resolveSeatCredentials({ provider: 'openai', inherits: false }, a)).toMatchObject({ ok: true, value: { apiKey: 'env-openai', baseUrl: 'https://env.local/v1' } });
    setDefaultProvider({ provider: 'anthropic', apiKey: 'default-anthropic' });
    expect(resolveSeatCredentials({ provider: 'anthropic', model: 'x', inherits: false }, a)).toMatchObject({ ok: true, value: { apiKey: 'default-anthropic' } });
    setDefaultProvider({ apiKey: 'nameless' });
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(resolveSeatCredentials({ provider: 'anthropic', model: 'x', inherits: false }, a)).toMatchObject({ ok: true, value: { apiKey: undefined } });
  });
  it('rejects a model prefix that disagrees with an explicit provider, except under ollama', () => {
    expect(resolveSeatCredentials({ provider: 'xai', model: 'anthropic:claude', inherits: true }, agency({}))).toMatchObject({ ok: false, reason: expect.stringMatching(/names provider "anthropic"/) });
    expect(resolveSeatCredentials({ provider: 'ollama', model: 'mistral:7b', baseUrl: 'http://127.0.0.1:11434', inherits: true }, agency({}))).toMatchObject({ ok: true, value: { provider: 'ollama', model: 'mistral:7b' } });
    // An agency-level Ollama tag is never split either: a seat that names nothing runs on it whole.
    expect(resolveSeatCredentials({ inherits: true }, agency({ provider: 'ollama', model: 'mistral:7b', baseUrl: 'http://127.0.0.1:11434' }))).toMatchObject({ ok: true, value: { provider: 'ollama', model: 'mistral:7b', baseUrl: 'http://127.0.0.1:11434' } });
  });
});

describe('availabilityOf', () => {
  it('names what is missing, and an open breaker', () => {
    expect(availabilityOf({ provider: 'anthropic', model: 'x' })).toBe('no key (ANTHROPIC_API_KEY)');
    expect(availabilityOf({ provider: 'ollama', model: 'x' })).toBe('no base URL (OLLAMA_BASE_URL)');
    expect(availabilityOf({ provider: 'claude-code-cli', model: 'x' }, { binaryOnPath: () => false })).toBe('binary not found (claude)');
    expect(availabilityOf({ provider: 'gemini-cli', model: 'x' }, { binaryOnPath: () => true })).toBeUndefined();
    expect(availabilityOf({ provider: 'openai', model: 'x', apiKey: 'k' })).toBeUndefined();
    globalLLMProviderHealth.recordFailure('openai', Object.assign(new Error('401'), { httpStatus: 401 }));
    expect(availabilityOf({ provider: 'openai', model: 'x', apiKey: 'k' })).toBe('circuit open');
  });
});
