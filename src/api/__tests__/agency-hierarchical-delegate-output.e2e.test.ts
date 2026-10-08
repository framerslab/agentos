/**
 * @file agency-hierarchical-delegate-output.e2e.test.ts
 * The hierarchical manager's next request carries the delegate's text and a
 * spawn's outcome. Real agency(), agent(), generateText, OpenAIProvider; only
 * fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { agency } from '../agency.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

type Json = Record<string, any>;
const KEY = 'sk-delegate-test-0001';
const USAGE = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const listing = () => jsonResponse({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] });
const text = (content: string) => jsonResponse({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: USAGE });
const toolCall = (name: string, args: Json, id: string) =>
  jsonResponse({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: USAGE });

function serve(lanes: Record<string, Array<() => Response>>, pick: (body: Json) => string): void {
  const queues: Record<string, Array<() => Response>> = Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, [...v]]));
  fetchMock.mockImplementation(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (/\/v1\/models/.test(u)) return listing();
    if (!/chat\/completions/.test(u)) throw new Error(`unexpected request ${u}`);
    const body = JSON.parse(String(init?.body)) as Json;
    const next = queues[pick(body)].shift();
    if (!next) throw new Error('script exhausted');
    return next();
  });
}
const managerBodies = () =>
  fetchMock.mock.calls.map(([, init]) => init as { body?: unknown }).filter((i) => i?.body).map((i) => JSON.parse(String(i.body)) as Json).filter((b) => (b.tools ?? []).some((t: Json) => /^delegate_to_|^spawn_specialist$/.test(t.function?.name ?? '')));
const isManager = (body: Json) => (body.tools ?? []).some((t: Json) => /^delegate_to_|^spawn_specialist$/.test(t.function?.name ?? ''));

beforeEach(() => { fetchMock.mockReset(); globalLLMProviderHealth.reset(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('the manager receives its delegates', () => {
  it("the manager's next request contains the delegate's text", async () => {
    serve({ manager: [() => toolCall('delegate_to_worker', { task: 'say hello' }, 'call_m1'), () => text('manager done')], worker: [() => text('worker says hello')] }, (b) => (isManager(b) ? 'manager' : 'worker'));
    const team = agency({ provider: 'openai', model: 'gpt-4.1', apiKey: KEY, strategy: 'hierarchical', agents: { worker: { instructions: 'Say hello.' } } });
    const result = (await team.generate('coordinate')) as Json;
    expect(result.text).toBe('manager done');
    const second = managerBodies()[1];
    const toolMsg = second.messages.find((m: Json) => m.role === 'tool');
    expect(toolMsg.content).toContain('worker says hello');
    expect(result.agentCalls).toHaveLength(1);
  });

  it("the manager's next request contains a spawn's outcome, without the key", async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-env-not-in-body-0002');
    serve({ manager: [() => toolCall('spawn_specialist', { role: 'helper', instructions: 'Help with sums.' }, 'call_m1'), () => text('spawned')] }, () => 'manager');
    const team = agency({ provider: 'openai', model: 'gpt-4.1', strategy: 'hierarchical', emergent: { enabled: true }, agents: { worker: { instructions: 'Static.' } } });
    await team.generate('grow the team');
    const second = managerBodies()[1];
    const toolMsg = second.messages.find((m: Json) => m.role === 'tool');
    expect(toolMsg.content).toMatch(/Spawned helper/);
    expect(JSON.stringify(second)).not.toContain('sk-env-not-in-body-0002');
  });

  it("a refusal reaches the manager too", async () => {
    serve({ manager: [() => toolCall('spawn_specialist', { role: 'worker', instructions: 'Dup.' }, 'call_m1'), () => text('ok')] }, () => 'manager');
    const team = agency({ provider: 'openai', model: 'gpt-4.1', apiKey: KEY, strategy: 'hierarchical', emergent: { enabled: true }, agents: { worker: { instructions: 'Static.' } } });
    await team.generate('try a duplicate');
    const toolMsg = managerBodies()[1].messages.find((m: Json) => m.role === 'tool');
    expect(toolMsg.content).toMatch(/already exists/);
  });
});
