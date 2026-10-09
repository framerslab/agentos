/**
 * agency() with a roster member served by GMIs, end to end: the real agency(),
 * its strategy, agent(), gmi(), provider manager, completion gateway, GMI and
 * tool orchestrator. Only the provider classes are stubbed
 * (helpers/stubProviders.ts), at their module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { agency } from '../agency';
import { agent } from '../agent';
import type { ApprovalDecision, ApprovalRequest } from '../types';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-agency-${++n}`;
/** The system prompt a model call sent: the text of its system messages. */
const systemText = (call: { messages: Array<{ role: string; content: unknown }> }): string =>
  call.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

/** A search tool whose runs are recorded in `order`. */
const searchTools = (order: string[]) => ({
  search: {
    description: 'Search.',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    execute: vi.fn(async (args: { q?: string }) => {
      order.push(`ran ${args.q}`);
      return 'one hit';
    }),
  },
});

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('agency() with a member served by GMIs', () => {
  it("a roster seat written as a config that sets runtime: 'gmi' type-checks, and a GMI serves it", async () => {
    const k = key();
    // No `whole`: the stub answers streamed calls only.
    const s = script('openai', k, { replies: [reply.text('Three sources.')] });
    // The seat as docs/orchestration/AGENCY_API.md and docs/GMI.md write it, with no cast:
    // `runtime` and `cognition` are options of a seat config.
    const team = agency({
      provider: 'openai',
      model: 'stub-model',
      apiKey: k,
      strategy: 'sequential',
      agents: { researcher: { runtime: 'gmi', cognition: 'light', instructions: 'Research.' } },
    });

    const result = (await team.generate('Find sources.')) as { text: string; agentCalls: Array<{ agent: string; output: string }> };
    expect(result.text).toBe('Three sources.');
    expect(result.agentCalls.map((call) => [call.agent, call.output])).toEqual([['researcher', 'Three sources.']]);
    // A GMI streams every model call; a seat on agent()'s own path asks generate() for a whole response.
    expect(s.seen.map((call) => call.streamed)).toEqual([true]);
    expect(systemText(s.seen[0])).toContain('Research.');
  });

  it('a GMI member of an agency whose hitl lists its tool: the handler is asked before the tool runs', async () => {
    const k = key();
    script('openai', k, { replies: [reply.tools([{ id: 'c1', name: 'search', args: { q: 'x' } }]), reply.text('Found x.')] });
    const order: string[] = [];
    const handler = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      order.push(`asked ${request.action}`);
      return { approved: true };
    };
    // The review's input: a sequential agency with beforeTool, and a pre-built GMI seat.
    const team = agency({
      provider: 'openai',
      model: 'stub-model',
      apiKey: k,
      strategy: 'sequential',
      hitl: { approvals: { beforeTool: ['search'] }, handler },
      agents: { a: agent({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'x', tools: searchTools(order) }) },
    });

    const result = (await team.generate('find x')) as { text: string };
    expect(result.text).toBe('Found x.');
    expect(order).toEqual(['asked search', 'ran x']);
  });

  it('a GMI member of an agency whose handler denies its tool: the tool does not run, and the model is told why', async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.tools([{ id: 'c1', name: 'search', args: { q: 'x' } }]), reply.text('I may not search.')] });
    const order: string[] = [];
    const handler = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      order.push(`asked ${request.action}`);
      return { approved: false, reason: 'searches are paused' };
    };
    const team = agency({
      provider: 'openai',
      model: 'stub-model',
      apiKey: k,
      strategy: 'sequential',
      hitl: { approvals: { beforeTool: ['search'] }, handler },
      agents: { a: agent({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'x', tools: searchTools(order) }) },
    });

    // As on agent()'s own path, the denied call is skipped and the turn goes on.
    const result = (await team.generate('find x')) as { text: string };
    expect(result.text).toBe('I may not search.');
    expect(order).toEqual(['asked search']);
    const toolMessage = s.seen[1].messages.find((m) => m.role === 'tool');
    expect(String(toolMessage?.content)).toContain('searches are paused');
  });
});
