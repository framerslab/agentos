/**
 * @file agency-hierarchical-judge-anthropic-wire.test.ts
 * The emergent judge of a hierarchical agency on Anthropic that names no
 * judge model runs on Claude Haiku 5.5. `spawn_specialist` goes through the
 * real `generateText` and the real AnthropicProvider with only `fetch`
 * stubbed, and the test reads the request body the provider put on the wire:
 * the model, no sampling field (Claude Haiku 5.5 answers a non-default
 * `temperature`, `top_p` or `top_k` with a 400) and no `thinking` block (it
 * thinks adaptively by default, and the judge asks for no budget).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { buildHierarchicalTools } from '../strategies/hierarchical.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import type { AgencyOptions } from '../types.js';

type Json = Record<string, any>;

/** A streamed text reply from `model`, as the Messages API sends it. */
function textReply(model: string, text: string): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: `msg_${model}`, type: 'message', role: 'assistant', content: [], model,
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

interface SpawnTool {
  execute: (args: { role: string; instructions: string; justification?: string }) => Promise<{
    success: boolean;
    output?: string;
    error?: string;
  }>;
}

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-judge-wire-test');
  vi.stubEnv('ANTHROPIC_BASE_URL', '');
  // Without an Anthropic key the resolver would reroute to OpenRouter; keep it out.
  vi.stubEnv('OPENROUTER_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hierarchical emergent judge on an Anthropic agency, on the wire', () => {
  it('an agency that names no judge model sends the judge call to Claude Haiku 5.5 with no sampling field or thinking block', async () => {
    fetchMock.mockImplementation(async () =>
      textReply('claude-haiku-5-5', '{"approved": true, "reasoning": "Narrow, checkable scope."}'),
    );

    const { tools, roster } = buildHierarchicalTools(
      {},
      {
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        agents: {},
        emergent: { enabled: true, judge: true },
      } as AgencyOptions,
    );

    const spawnTool = tools.spawn_specialist as unknown as SpawnTool;
    const result = await spawnTool.execute({
      role: 'figures_checker',
      instructions: 'Check every figure in the report against its source.',
    });

    expect(result.success).toBe(true);
    expect(roster.figures_checker).toBeDefined();

    // One request, to Anthropic's own API, on the provider's small model.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [unknown, { body?: unknown }];
    expect(String(url)).toContain('api.anthropic.com/v1/messages');
    const body = JSON.parse(String(init.body)) as Json;
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
    expect(body).not.toHaveProperty('thinking');
    // The judge reads the spec it is asked about.
    expect(JSON.stringify(body.messages)).toContain('figures_checker');
  });
});
