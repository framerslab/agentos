/**
 * @file agent-export-redaction.e2e.test.ts
 * Exports redact secrets by default and import restores them from `secrets`
 * and `values`; the live agent keeps sending its key. Real agent(), agency()
 * and OpenAIProvider; only fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { agent } from '../agent.js';
import { agency } from '../agency.js';
import { exportAgentConfig, exportAgentConfigJSON, exportAgentConfigYAML, importAgent } from '../agentExport.js';
import { REDACTED, INSTANCE_MARKER_KEY } from '../agentExportRedact.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';
import type { IModelRouter } from '../../core/llm/routing/IModelRouter.js';
import { setDefaultProvider, clearDefaultProvider } from '../runtime/global-default.js';

const KEY = 'sk-live-sentinel-0001';
const SEAT_KEY = 'sk-seat-sentinel-0002';
const CRED = 'xoxb-channel-sentinel-0003';
const TOKEN = 'tok-sentinel-0004';
const SIGNING = 'sig-sentinel-0005';
const SECRET_KEY = 'sk2-sentinel-0006';
const AWS = 'aws-sentinel-0007';
const AUTHZ = 'Bearer authz-sentinel-0008';
const USERINFO = 'user:pw-sentinel-0009';
const WEBHOOK_PATH = 'services/T0/B0/hook-sentinel-0010';
const RAG_KEY = 'rag-sentinel-0011';
const SENTINELS = [KEY, SEAT_KEY, CRED, TOKEN, SIGNING, SECRET_KEY, AWS, 'authz-sentinel-0008', 'pw-sentinel-0009', 'hook-sentinel-0010', RAG_KEY];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const listing = () => jsonResponse({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] });
const chat = (text: string) =>
  jsonResponse({
    id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'gpt-4.1',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  });
function routeOpenAI(): void {
  fetchMock.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (/\/v1\/models/.test(u)) return listing();
    if (/\/v1\/chat\/completions/.test(u)) return chat('ok');
    throw new Error(`unexpected request ${u}`);
  });
}
function authHeaderOf(pattern: RegExp): string | undefined {
  const call = fetchMock.mock.calls.find(([url, init]) => pattern.test(String(url)) && (init as { method?: string })?.method === 'POST');
  const headers = (call?.[1] as { headers?: Record<string, string> } | undefined)?.headers ?? {};
  return headers.Authorization ?? headers.authorization;
}

// A class instance, not a plain object: the export writes a plain object as a copy and an instance as a marker.
class StubRouter { async selectModel(): Promise<null> { return null; } }

function buildAgency() {
  const router = new StubRouter() as unknown as IModelRouter;
  return {
    router,
    team: agency({
      provider: 'openai', model: 'gpt-4.1', apiKey: KEY,
      maxTokens: 1024, controls: { maxTotalTokens: 50_000, maxCostUSD: 2 },
      router,
      agents: {
        support: {
          instructions: 'Help.', apiKey: SEAT_KEY, promptCacheKey: 'pck-1',
          channels: {
            slack: { credential: CRED, params: { webhookUrl: `https://hooks.example/${WEBHOOK_PATH}` }, credentials: 'include', authorization: 'bearer' },
            discord: { botToken: TOKEN, signing_secret: SIGNING, stopTokens: ['###'] },
          },
          fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: SECRET_KEY }],
        } as never,
        audit: { instructions: 'Audit.', customModelParams: { secretKey: SECRET_KEY, aws_secret_access_key: AWS, headers: { Authorization: AUTHZ } } },
      },
      baseUrl: `https://${USERINFO}@proxy.local/v1`,
      rag: { vectorStore: { provider: 'qdrant', url: `https://vec.local/x?api_key=${RAG_KEY}&publicKey=abc` } } as never,
      strategy: 'sequential',
    } as never), // `router` and `channels` are not declared on AgencyOptions at the tip; the cast keeps typecheck green
  };
}

beforeEach(() => { fetchMock.mockReset(); globalLLMProviderHealth.reset(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('export redacts by default', () => {
  it('no sentinel in the object, the JSON or the YAML; settings and limits unchanged; the webhook keeps its origin', () => {
    const { team } = buildAgency();
    const obj = exportAgentConfig(team);
    const json = exportAgentConfigJSON(team);
    const yaml = exportAgentConfigYAML(team);
    for (const doc of [JSON.stringify(obj), json, yaml]) for (const s of SENTINELS) expect(doc).not.toContain(s);
    const cfg = obj.config as Record<string, any>;
    expect(cfg.apiKey).toBe(REDACTED);
    expect(cfg.maxTokens).toBe(1024);
    expect(cfg.controls).toEqual({ maxTotalTokens: 50_000, maxCostUSD: 2 });
    expect(cfg.baseUrl).toBe(`https://${REDACTED}@proxy.local/v1`);
    expect(cfg.rag.vectorStore.url).toBe(`https://vec.local/x?api_key=${REDACTED}&publicKey=abc`);
    expect(cfg.router).toEqual({ [INSTANCE_MARKER_KEY]: 'StubRouter' });
    const support = obj.agents!.support as Record<string, any>;
    expect(support.apiKey).toBe(REDACTED);
    expect(support.promptCacheKey).toBe('pck-1');
    expect(support.channels.slack.credential).toBe(REDACTED);
    expect(support.channels.slack.params.webhookUrl).toBe(`https://hooks.example/${REDACTED}`);
    expect(support.channels.slack.credentials).toBe('include');
    expect(support.channels.slack.authorization).toBe('bearer');
    expect(support.channels.discord.stopTokens).toEqual(['###']);
    expect(support.fallbackProviders[0].apiKey).toBe(REDACTED);
    const audit = obj.agents!.audit as Record<string, any>;
    expect(audit.customModelParams).toEqual({ secretKey: REDACTED, aws_secret_access_key: REDACTED, headers: { Authorization: REDACTED } });
    // The roster is written twice; both copies are redacted.
    expect(JSON.stringify((obj.config as Record<string, any>).agents)).not.toContain(SEAT_KEY);
  });

  it('redactSecrets: false shows every sentinel and keeps the router by reference in the object form', () => {
    const { team, router } = buildAgency();
    const obj = exportAgentConfig(team, undefined, { redactSecrets: false });
    const json = exportAgentConfigJSON(team, undefined, { redactSecrets: false });
    for (const s of SENTINELS) { expect(JSON.stringify(obj, (_k, v) => (typeof v === 'function' ? undefined : v))).toContain(s); expect(json).toContain(s); }
    expect((obj.config as Record<string, any>).router).toBe(router);
    expect(JSON.parse(json).config.router).toEqual({ [INSTANCE_MARKER_KEY]: 'StubRouter' });
  });

  it('the source agent still sends its key after export()', async () => {
    routeOpenAI();
    const a = agent({ provider: 'openai', model: 'gpt-4.1', apiKey: KEY, fallbackProviders: [] });
    a.export();
    await a.generate('hi');
    expect(authHeaderOf(/chat\/completions/)).toBe(`Bearer ${KEY}`);
  });

  it('a pre-built seat is exported as { prebuilt: true }', () => {
    const inner = agent({ provider: 'openai', model: 'gpt-4.1', apiKey: KEY });
    const team = agency({ agents: { inner, other: { instructions: 'x' } }, provider: 'openai', model: 'gpt-4.1', apiKey: KEY });
    expect(exportAgentConfig(team).agents!.inner).toEqual({ prebuilt: true });
    expect(() => importAgent(exportAgentConfig(team))).toThrow(/pre-built seat "inner"/);
  });

  it('a URL with nothing to redact exports byte for byte', () => {
    const a = agent({ provider: 'openai', model: 'gpt-4.1', apiKey: KEY, baseUrl: 'https://proxy.local/v1?publicKey=abc' });
    expect((exportAgentConfig(a).config as Record<string, any>).baseUrl).toBe('https://proxy.local/v1?publicKey=abc');
  });
});

describe('import restores what export redacted', () => {
  it('a redacted provider key comes from the environment and the call carries it', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-env-restored-0012');
    routeOpenAI();
    const a = agent({ provider: 'openai', model: 'gpt-4.1', apiKey: KEY, fallbackProviders: [] });
    const restored = importAgent(exportAgentConfig(a));
    await restored.generate('hi');
    expect(authHeaderOf(/chat\/completions/)).toBe('Bearer sk-env-restored-0012');
  });

  it('a redacted channel credential with no secrets throws and lists its path; with secrets the value is restored', () => {
    const { team } = buildAgency();
    const doc = exportAgentConfig(team);
    expect(() => importAgent(doc, { values: { '/config/router': {} } })).toThrow(/\/agents\/support\/channels\/slack\/credential/);
    const restored = importAgent(doc, {
      values: { '/config/router': { selectModel: async () => null } },
      secrets: {
        '/agents/support/channels/slack/credential': CRED,
        '/agents/support/channels/slack/params/webhookUrl': `https://hooks.example/${WEBHOOK_PATH}`,
        '/agents/support/channels/discord/botToken': TOKEN,
        '/agents/support/channels/discord/signing_secret': SIGNING,
        '/agents/support/fallbackProviders/0/apiKey': SECRET_KEY,
        '/agents/audit/customModelParams/secretKey': SECRET_KEY,
        '/agents/audit/customModelParams/aws_secret_access_key': AWS,
        '/agents/audit/customModelParams/headers/Authorization': AUTHZ,
        '/config/baseUrl': `https://${USERINFO}@proxy.local/v1`,
        '/config/rag/vectorStore/url': `https://vec.local/x?api_key=${RAG_KEY}&publicKey=abc`,
        // The seat's key sits beside no provider or model, so import does not drop it for the environment: it must be supplied.
        '/agents/support/apiKey': SEAT_KEY,
      },
    });
    // No channel adapter is built from an agency config at the tip (S13): an unredacted re-export is the observable check that the restored config carries each value.
    const raw = exportAgentConfig(restored, undefined, { redactSecrets: false });
    expect((raw.agents!.support as Record<string, any>).apiKey).toBe(SEAT_KEY);
    expect((raw.agents!.support as Record<string, any>).channels.slack.credential).toBe(CRED);
    expect((raw.config as Record<string, any>).rag.vectorStore.url).toContain(RAG_KEY);
  });

  it('a redacted baseUrl imports when the provider URL variable or a same-provider default URL is set, resolves as an unset one does, and throws with neither', async () => {
    const a = agent({ provider: 'openai', model: 'gpt-4.1', apiKey: KEY, baseUrl: `https://${USERINFO}@proxy.local/v1`, fallbackProviders: [] });
    const doc = exportAgentConfig(a);
    expect(() => importAgent(doc)).toThrow(/\/config\/baseUrl/);
    try {
      // Both set: the dropped key and URL resolve as unset ones do, the applicable default first (model.ts:117-129), so the
      // request goes to the default's URL, which differs from the variable's, with the environment key (the default has none).
      vi.stubEnv('OPENAI_BASE_URL', 'https://proxy.local/v1');
      vi.stubEnv('OPENAI_API_KEY', 'sk-env-restored-0012');
      setDefaultProvider({ provider: 'openai', baseUrl: 'https://default.local/v1' });
      routeOpenAI();
      const restored = importAgent(doc);
      expect((restored.export!(undefined, { redactSecrets: false }) as Record<string, any>).config.baseUrl).toBeUndefined();
      expect((restored.export!(undefined, { redactSecrets: false }) as Record<string, any>).config.apiKey).toBeUndefined();
      await restored.generate('hi');
      expect(fetchMock.mock.calls.some(([u, i]) => /^https:\/\/default\.local\/v1\/chat\/completions/.test(String(u)) && (i as { method?: string })?.method === 'POST')).toBe(true);
      expect(authHeaderOf(/default\.local\/v1\/chat\/completions/)).toBe('Bearer sk-env-restored-0012');
      expect(JSON.stringify(fetchMock.mock.calls.map(([u]) => String(u)))).not.toContain('proxy.local');
      // The default alone, the variable unset: import passes on the default's URL. Neither: it throws and lists the path.
      vi.stubEnv('OPENAI_BASE_URL', '');
      expect(() => importAgent(doc)).not.toThrow();
      clearDefaultProvider();
      expect(() => importAgent(doc)).toThrow(/\/config\/baseUrl/);
    } finally {
      clearDefaultProvider();
    }
  });

  it('a redacted rag url or webhook url with no secrets throws and lists the path', () => {
    const { team } = buildAgency();
    const doc = exportAgentConfig(team);
    expect(() => importAgent(doc, { values: { '/config/router': {} } })).toThrow(/\/config\/rag\/vectorStore\/url/);
    expect(() => importAgent(doc, { values: { '/config/router': {} } })).toThrow(/\/agents\/support\/channels\/slack\/params\/webhookUrl/);
  });

  it('an instance marker with no values entry throws; with one the object is put back', () => {
    class StubRouter { async selectModel(): Promise<null> { return null; } }
    const router = new StubRouter();
    const a = agent({ provider: 'openai', model: 'gpt-4.1', apiKey: KEY, router: router as never });
    const doc = exportAgentConfig(a);
    expect(() => importAgent(doc)).toThrow(/\/config\/router/);
    const restored = importAgent(doc, { values: { '/config/router': router } });
    expect((restored.export!(undefined, { redactSecrets: false }) as Record<string, any>).config.router).toBe(router);
  });

  it('settings survive export and import; secret containers do not', () => {
    const { team } = buildAgency();
    const doc = exportAgentConfig(team);
    const support = doc.agents!.support as Record<string, any>;
    expect(support.channels.slack.credentials).toBe('include');
    expect(support.channels.slack.authorization).toBe('bearer');
    expect(support.channels.discord.stopTokens).toEqual(['###']);
    expect(support.channels.discord.botToken).toBe(REDACTED);
  });

  it('import matches an encoded placeholder in a URL too', () => {
    const { team } = buildAgency();
    const doc = exportAgentConfig(team);
    (doc.config as Record<string, any>).rag.vectorStore.url = 'https://vec.local/x?api_key=%3C%3CREDACTED%3E%3E';
    expect(() => importAgent(doc, { values: { '/config/router': {} } })).toThrow(/\/config\/rag\/vectorStore\/url/);
  });
});
