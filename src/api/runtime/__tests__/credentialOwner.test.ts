/**
 * @file credentialOwner.test.ts
 * Whose credentials an agent's options and a gateway's defaults hold, and
 * when a call's model takes it to another provider than the one it would
 * inherit. Model resolution is the real one; every case names a provider or
 * a model prefix, so none reads the environment.
 */
import { describe, expect, it } from 'vitest';

import { credentialsGoWith, modelNamesAnotherProvider } from '../credentialOwner';

describe('credentialsGoWith', () => {
  it('sends credentials set with no provider or model to whichever provider the call names', () => {
    expect(credentialsGoWith({}, { provider: 'anthropic', model: 'claude-x' })).toBe(true);
  });

  it('keeps credentials with the provider their owner resolves to, in any spelling', () => {
    expect(credentialsGoWith({ provider: 'openai', model: 'gpt-4o' }, { model: 'openai:gpt-4.1' })).toBe(true);
    expect(credentialsGoWith({ model: 'openai:gpt-4o' }, { provider: 'openai', model: 'gpt-4.1' })).toBe(true);
    expect(credentialsGoWith({ provider: 'openai', model: 'gpt-4o' }, { provider: 'anthropic', model: 'claude-x' })).toBe(false);
    expect(credentialsGoWith({ provider: 'openai', model: 'gpt-4o' }, { provider: 'openai', model: 'anthropic:claude-x' })).toBe(false);
  });

  it('reads the provider an owner names when its model does not resolve', () => {
    expect(credentialsGoWith({ provider: 'openai', model: 'openai:' }, { provider: 'anthropic', model: 'claude-x' })).toBe(false);
    expect(credentialsGoWith({ provider: 'openai', model: 'openai:' }, { provider: 'openai', model: 'gpt-4.1' })).toBe(true);
  });

  it('sends the credentials of an owner whose provider is not known, and leaves an unresolvable call to fail on its own', () => {
    expect(credentialsGoWith({ model: 'llama3:8b' }, { provider: 'anthropic', model: 'claude-x' })).toBe(true);
    expect(credentialsGoWith({ provider: 'openai', model: 'gpt-4o' }, { model: 'llama3:8b' })).toBe(true);
  });
});

describe('modelNamesAnotherProvider', () => {
  it("is true for a known provider's colon prefix other than the inherited provider", () => {
    expect(modelNamesAnotherProvider('openai', 'anthropic:claude-x')).toBe(true);
    expect(modelNamesAnotherProvider('openai', 'openai:gpt-4.1')).toBe(false);
    expect(modelNamesAnotherProvider('openai', 'gpt-4.1')).toBe(false);
  });

  it('is false for a gateway model id and for an Ollama tag, which stay with the inherited provider', () => {
    expect(modelNamesAnotherProvider('openrouter', 'anthropic/claude-x')).toBe(false);
    expect(modelNamesAnotherProvider('ollama', 'mistral:7b')).toBe(false);
  });
});
