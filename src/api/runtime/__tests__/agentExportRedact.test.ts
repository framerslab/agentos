import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  INSTANCE_MARKER_KEY,
  isSecretName,
  isSecretContainerName,
  isKeptSettingValue,
  isWebhookUrlName,
  copyExportTree,
} from '../../agentExportRedact.js';
import { redactUrlForExport } from '../../../core/llm/providers/url-secrets.js';

describe('the property-name rule', () => {
  it.each([
    'apiKey', 'api_key', 'api-key', 'ANTHROPIC_API_KEY', 'botToken', 'signing_secret', 'credential',
    'credentials', 'secretKey', 'aws_secret_access_key', 'Authorization', 'cookie', 'password', 'passwd',
    'privateKey', 'accessKey', 'authKey', 'tokens', 'secrets', 'passwords', 'cookies', 'apiKeys',
    'privateKeys', 'secretKeys', 'accessKeys', 'apikey', 'accesstoken', 'secretkey', 'APIKEY', 'apikeys',
    'botTokens', 'refreshTokens', 'clientSecrets', 'dbPasswords', 'sessionCookies', 'encryptionKey', 'signingKey',
    'serviceRoleKey', 'accountKey', 'Ocp-Apim-Subscription-Key', 'openAIAPIKey',
  ])('%s is a secret name', (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each([
    'maxTokens', 'promptTokens', 'tokenLimit', 'envKey', 'promptCacheKey', 'primaryKey', 'publicKey',
    'sessionKey', 'stopTokens', 'cookieName', 'authorizationHeader', 'model', 'baseUrl', 'key', 'auth',
    'completionTokens', 'reasoningTokens', 'maxTokenLimit',
  ])('%s is not a secret name', (name) => {
    expect(isSecretName(name)).toBe(false);
  });

  it.each(['credentials', 'secrets', 'apiKeys', 'tokens', 'api_keys', 'Tokens'])(
    '%s names a secret container',
    (name) => expect(isSecretContainerName(name)).toBe(true),
  );
  it.each(['stopTokens', 'maxTokens', 'channels', 'controls'])('%s does not name a container', (name) =>
    expect(isSecretContainerName(name)).toBe(false),
  );

  it('reads a webhook URL by its name, its plural, a spaced hook, or a url under an object named webhook', () => {
    for (const [name, parent] of [['webhookUrl', ''], ['webhookUrls', ''], ['webHookUrl', ''], ['WEBHOOK_URL', ''], ['webhook', ''], ['url', 'webhook']]) {
      expect(isWebhookUrlName(name, parent)).toBe(true);
    }
    for (const [name, parent] of [['callbackUrl', ''], ['url', 'slack'], ['webhookSecret', ''], ['hookUrl', '']]) {
      expect(isWebhookUrlName(name, parent)).toBe(false);
    }
  });

  it('keeps the setting values under the new words', () => {
    for (const v of ['include', 'same-origin', 'omit', 'none', 'oauth', 'bearer', 'basic', 'strict', 'lax']) {
      expect(isKeptSettingValue('credentials', v)).toBe(true);
      expect(isKeptSettingValue('authorization', v)).toBe(true);
    }
    expect(isKeptSettingValue('credentials', 'xoxb-1')).toBe(false);
    expect(isKeptSettingValue('apiKey', 'none')).toBe(false);
  });
});

describe('copyExportTree', () => {
  class Router { route() { return 'x'; } }
  const tree = {
    apiKey: 'sk-secret-1234567',
    maxTokens: 1024,
    promptCacheKey: 'pck-1',
    stopTokens: ['###'],
    tokens: ['t1'],
    apiKeys: { openai: 'sk-2' },
    credentials: { slack: 'xoxb-1' },
    secrets: { nested: { deep: 'd1' } },
    fetchCredentials: { credentials: 'include' },
    authorization: { type: 'bearer' },
    headers: { Authorization: 'Bearer abc', apikey: 'anon-key' },
    router: new Router(),
    hook: () => 1,
    rag: { url: 'https://h/x?api_key=k1&publicKey=abc' },
    channels: { x: { params: { webhookUrl: 'https://hooks.example/services/T/B/secret' } } },
    baseUrl: 'https://user:pw@proxy.local/v1',
  };
  const url = (u: string, name: string) => redactUrlForExport(u, { webhook: /webhook url$/i.test(name.replace(/([a-z])([A-Z])/g, '$1 $2')), isSecretParam: isSecretName });

  it('redacts by name at any depth, keeps settings, marks instances, drops functions in the serialized form', () => {
    const out = copyExportTree(tree, { redactSecrets: true, form: 'serialized', redactUrl: url }) as Record<string, any>;
    expect(out.apiKey).toBe(REDACTED);
    expect(out.maxTokens).toBe(1024);
    expect(out.promptCacheKey).toBe('pck-1');
    expect(out.stopTokens).toEqual(['###']);
    expect(out.tokens).toEqual([REDACTED]);
    expect(out.apiKeys).toEqual({ openai: REDACTED });
    expect(out.credentials).toEqual({ slack: REDACTED });
    expect(out.secrets).toEqual({ nested: { deep: REDACTED } });
    expect(out.fetchCredentials).toEqual({ credentials: 'include' });
    expect(out.authorization).toEqual({ type: 'bearer' });
    expect(out.headers).toEqual({ Authorization: REDACTED, apikey: REDACTED });
    expect(out.router).toEqual({ [INSTANCE_MARKER_KEY]: 'Router' });
    expect('hook' in out).toBe(false);
    expect(out.rag.url).toBe(`https://h/x?api_key=${REDACTED}&publicKey=abc`);
    expect(out.channels.x.params.webhookUrl).toBe(`https://hooks.example/${REDACTED}`);
    expect(out.baseUrl).toBe(`https://${REDACTED}@proxy.local/v1`);
    expect(JSON.stringify(out)).not.toContain('sk-secret');
  });

  it('keeps functions and instances by reference in the object form with redactSecrets false', () => {
    const out = copyExportTree(tree, { redactSecrets: false, form: 'object', redactUrl: url }) as Record<string, any>;
    expect(out.apiKey).toBe('sk-secret-1234567');
    expect(out.router).toBe(tree.router);
    expect(out.hook).toBe(tree.hook);
    expect(out).not.toBe(tree);
    expect(out.rag).not.toBe(tree.rag);
  });

  it('treats a seat or tool named like a secret container as a name, and keeps an empty secret string empty', () => {
    const out = copyExportTree(
      { agents: { authorization: { instructions: 'Decide.' } }, tools: { credentials: { description: 'Look up.' } }, botToken: '' },
      { redactSecrets: true, form: 'serialized', redactUrl: url },
    ) as Record<string, any>;
    expect(out.agents.authorization.instructions).toBe('Decide.');
    expect(out.tools.credentials.description).toBe('Look up.');
    expect(out.botToken).toBe('');
  });

  it('reads the keys of a tools list item as properties: its credentials object is a container', () => {
    const out = copyExportTree(
      { tools: [{ name: 'post', credentials: { slack: 'xoxb-1' } }], agents: { a: { tools: [{ name: 'credentials', description: 'Look up.' }] } } },
      { redactSecrets: true, form: 'serialized', redactUrl: url },
    ) as Record<string, any>;
    expect(out.tools[0]).toEqual({ name: 'post', credentials: { slack: REDACTED } });
    expect(out.agents.a.tools[0]).toEqual({ name: 'credentials', description: 'Look up.' });
  });

  it('redacts every webhook form by its path', () => {
    const out = copyExportTree(
      { webhookUrls: ['https://hooks.example/a/b'], webhook: 'https://discord.example/api/webhooks/1/t', slack: { webhook: { url: 'https://hooks.example/c' } } },
      { redactSecrets: true, form: 'serialized', redactUrl: (u, n, p) => redactUrlForExport(u, { webhook: isWebhookUrlName(n, p), isSecretParam: isSecretName }) },
    ) as Record<string, any>;
    expect(out.webhookUrls).toEqual([`https://hooks.example/${REDACTED}`]);
    expect(out.webhook).toBe(`https://discord.example/${REDACTED}`);
    expect(out.slack.webhook.url).toBe(`https://hooks.example/${REDACTED}`);
  });

  it('writes a function inside an array as null in the serialized form, so later items keep their index', () => {
    const out = copyExportTree({ handlers: [() => 1, 'kept'] }, { redactSecrets: true, form: 'serialized', redactUrl: url }) as Record<string, any>;
    expect(out.handlers).toEqual([null, 'kept']);
  });

  it('marks an instance in the serialized form even with redactSecrets false', () => {
    const out = copyExportTree(tree, { redactSecrets: false, form: 'serialized', redactUrl: url }) as Record<string, any>;
    expect(out.router).toEqual({ [INSTANCE_MARKER_KEY]: 'Router' });
    expect(out.apiKey).toBe('sk-secret-1234567');
  });

  it('keeps a setting value under the nearest secret container and redacts the rest', () => {
    const out = copyExportTree(
      { secrets: { authorization: { type: 'bearer', value: 'Bearer abc' } }, tokens: ['none'] },
      { redactSecrets: true, form: 'serialized', redactUrl: url },
    ) as Record<string, any>;
    expect(out.secrets).toEqual({ authorization: { type: 'bearer', value: REDACTED } });
    expect(out.tokens).toEqual([REDACTED]);
  });
});

describe('redactUrlForExport', () => {
  const secret = (n: string) => isSecretName(n);
  it('removes userinfo and leaves the rest byte for byte', () => {
    expect(redactUrlForExport('https://u:p@h.io/a?x=1', { isSecretParam: secret })).toBe(`https://${REDACTED}@h.io/a?x=1`);
    expect(redactUrlForExport('https://h.io/a?x=1#f', { isSecretParam: secret })).toBe('https://h.io/a?x=1#f');
  });
  it('replaces secret query and fragment parameters in any letter case', () => {
    expect(redactUrlForExport('https://h/x?API_KEY=k&Access_Token=t&key=z&sig=s&signature=g&auth=a&password=p&publicKey=ok&cacheKey=ok', { isSecretParam: secret })).toBe(
      `https://h/x?API_KEY=${REDACTED}&Access_Token=${REDACTED}&key=${REDACTED}&sig=${REDACTED}&signature=${REDACTED}&auth=${REDACTED}&password=${REDACTED}&publicKey=ok&cacheKey=ok`,
    );
    expect(redactUrlForExport('https://h/x#access_token=t&state=s', { isSecretParam: secret })).toBe(`https://h/x#access_token=${REDACTED}&state=s`);
  });
  it('keeps a webhook origin and replaces its path and query', () => {
    expect(redactUrlForExport('https://hooks.example/services/T/B/x?y=1', { webhook: true, isSecretParam: secret })).toBe(`https://hooks.example/${REDACTED}`);
    expect(redactUrlForExport('https://hooks.example', { webhook: true, isSecretParam: secret })).toBe('https://hooks.example');
    expect(redactUrlForExport('https://hooks.example/', { webhook: true, isSecretParam: secret })).toBe('https://hooks.example/');
    expect(redactUrlForExport('https://hooks.example/services/T/B/x#access_token=t&state=s', { webhook: true, isSecretParam: secret })).toBe(
      `https://hooks.example/${REDACTED}#access_token=${REDACTED}&state=s`,
    );
  });
  it('reads a parameter name percent-decoded', () => {
    expect(redactUrlForExport('https://h/x?api%5Fkey=k&ok=1', { isSecretParam: secret })).toBe(`https://h/x?api%5Fkey=${REDACTED}&ok=1`);
    expect(redactUrlForExport('https://h/x?%E0%A4%A=1', { isSecretParam: secret })).toBe('https://h/x?%E0%A4%A=1');
  });
  it('does not percent-encode the placeholder', () => {
    expect(redactUrlForExport('https://h/x?token=a%20b', { isSecretParam: secret })).toBe(`https://h/x?token=${REDACTED}`);
  });
});
