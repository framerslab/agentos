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
