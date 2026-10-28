/**
 * launch_agency on gmi(), end to end: the route a launched team's coordinator runs on, and the budgets a persistent
 * member's seat runs under. The real gmi(), agency(), its strategies, agent(), the launch engine, the provider manager,
 * completion gateway, GMI and tool orchestrator run; only the provider classes are stubbed (helpers/stubProviders.ts),
 * at their module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { gmi } from '../gmi';
import type { GenerateTextResult } from '../generateText';
import type { LaunchAgencyResult } from '../runtime/agencyLaunch/types';
import { clearProviderPriority, setProviderPriority } from '../runtime/provider-priority';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-launch-route-${++n}`;
type SeenCall = { messages: Array<{ role: string; content: unknown }> };
/** The text of a model call's last user message. */
const lastUserText = (call: SeenCall): string => {
  const users = call.messages.filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  return last ? (typeof last.content === 'string' ? last.content : JSON.stringify(last.content)) : '';
};
/** A model step that calls launch_agency once with `args`. */
const launchStep = (args: Record<string, unknown>, id = 'l1') => reply.tools([{ id, name: 'launch_agency', args }]);
/** The output of a send's `i`-th tool call: a launch that started. */
const launchOf = (result: GenerateTextResult, i = 0): LaunchAgencyResult => {
  const call = result.toolCalls[i];
  expect(call?.name).toBe('launch_agency');
  expect(call?.error).toBeUndefined();
  return call.result as LaunchAgencyResult;
};

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearProviderPriority();
});

describe('launch_agency on gmi(): the coordinator route and the budgets of a seat', () => {
  it('an agent whose provider and model come from the environment launches a parallel team, which synthesizes on that route', async () => {
    const k = key();
    // Only OPENAI_API_KEY is probed, so a CLI on the runner's PATH cannot answer.
    setProviderPriority(['openai']);
    vi.stubEnv('OPENAI_API_KEY', k);
    const s = script('openai', k, {
      replies: [
        launchStep({
          goal: 'Name a colour.',
          strategy: 'parallel',
          seats: [{ role: 'warm', instructions: 'Name a warm colour.' }, { role: 'cool', instructions: 'Name a cool colour.' }],
        }),
        reply.text('Red.'),
        reply.text('Blue.'),
        reply.text('Red and blue.'),
        reply.text('Two colours.'),
      ],
      // The synthesizer runs on agent()'s legacy path, which asks for a whole response; a GMI streams every call.
      whole: true,
    });
    // No provider and no model: the agent's first call resolves them from the environment.
    const parent = gmi({ instructions: 'Coordinate.', fallbackProviders: [], agencies: { launch: true } });

    const result = await parent.session('p1').send('Name two colours.');
    const out = launchOf(result);
    expect(out).toMatchObject({ status: 'completed', text: 'Red and blue.' });
    // The seats answer at once, so either may take either reply.
    expect(out.seats.map((r) => [r.role, r.status])).toEqual([['warm', 'completed'], ['cool', 'completed']]);
    expect(out.seats.map((r) => r.summary).sort()).toEqual(['Blue.', 'Red.']);
    // The parent's step, the two seats, the synthesizer (a whole response), the parent's last step: every call on the
    // model the parent's first call resolved.
    expect(s.seen.map((call) => call.streamed)).toEqual([true, true, true, false, true]);
    expect(new Set(s.seen.map((call) => call.modelId))).toEqual(new Set([s.seen[0].modelId]));
    expect(lastUserText(s.seen[3])).toContain('Synthesize these into a single coherent response.');
    expect(result.text).toBe('Two colours.');
  });
});
