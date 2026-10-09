/**
 * agency() with a roster member served by GMIs, end to end: the real agency(),
 * its strategy, agent(), gmi(), provider manager, completion gateway, GMI and
 * tool orchestrator. Only the provider classes are stubbed
 * (helpers/stubProviders.ts), at their module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { agency } from '../agency';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-agency-${++n}`;
/** The system prompt a model call sent: the text of its system messages. */
const systemText = (call: { messages: Array<{ role: string; content: unknown }> }): string =>
  call.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

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
});
