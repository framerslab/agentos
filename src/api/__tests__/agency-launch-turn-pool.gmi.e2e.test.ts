/**
 * launch_agency on gmi(), end to end: the launch pool of a turn lasts the whole turn. A turn's root launches draw on one
 * pool capped at `maxLaunchTokens`, however many other root scopes launch between two of its launches. The real gmi(),
 * agency(), the launch engine and its registry, the completion gateway, GMI and tool orchestrator run; only the
 * provider classes are stubbed (helpers/stubProviders.ts), at their module boundary. Its own file, so the registry's
 * module state holds no other case's scopes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { gmi } from '../gmi';
import type { GenerateTextResult } from '../generateText';
import type { LaunchAgencyResult } from '../runtime/agencyLaunch/types';
import { resolveLaunchLimits } from '../runtime/agencyLaunch/types';
import { MAX_POOL_SCOPES, launchRegistry } from '../runtime/agencyLaunch/launchRegistry';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

const k = 'k-launch-turn-pool';
/** A model step that calls launch_agency once with `args`. */
const launchStep = (args: Record<string, unknown>, id: string) => reply.tools([{ id, name: 'launch_agency', args }]);
/** The refusal code of a send's `i`-th tool call, or '' for a call that was not refused. */
const refusalOf = (result: GenerateTextResult, i: number): string => String(result.toolCalls[i]?.error ?? '').split(':')[0];

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => vi.restoreAllMocks());

describe("launch_agency on gmi(): a turn's launch pool", () => {
  it('lasts the whole turn: past the bound on root scopes, a second launch of the turn still draws on what the first left', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seat = { role: 'writer', instructions: 'Write.' };
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Draft the notice.', seats: [seat] }, 'l1'),
        // The seat's answer uses 6,500 of the turn's 8,000 launch tokens: 1,500 are left, below one call's 2,100.
        reply.text('Notice drafted.', 'stub-model', { promptTokens: 6_450, completionTokens: 50, totalTokens: 6_500 }),
        reply.tools([{ id: 'c1', name: 'crowd', args: {} }]),
        launchStep({ goal: 'Draft it again.', seats: [seat] }, 'l2'),
        reply.text('Done.'),
        // Read only when the second launch runs a seat, which takes the reply above.
        reply.text('Spare.'),
      ],
    });
    // Between the turn's two launches, more root scopes than the registry's bound open a launch pool each, as other
    // sessions' launches do.
    const crowdLimits = resolveLaunchLimits({});
    const crowd = {
      description: 'Other sessions launch.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        for (let i = 0; i <= MAX_POOL_SCOPES; i += 1) launchRegistry.rootPool(`gmi:crowd-${i}`, undefined, crowdLimits);
        return 'crowded';
      },
    };
    const parent = gmi({
      provider: 'openai',
      model: 'stub-model',
      apiKey: k,
      fallbackProviders: [],
      instructions: 'Coordinate.',
      maxTokens: 100,
      tools: { crowd },
      agencies: { launch: true, maxLaunchTokens: 8_000 },
    });

    const result = await parent.session('p1').send('Draft the notice twice.');
    expect(result.toolCalls.map((call) => call.name)).toEqual(['launch_agency', 'crowd', 'launch_agency']);
    expect((result.toolCalls[0].result as LaunchAgencyResult).status).toBe('completed');
    // The second launch draws on the 1,500 tokens the first left in the turn's pool: too few for one call.
    expect(refusalOf(result, 2)).toBe('budget_unavailable');
    expect(result.toolCalls[2].error).toContain('1500');
    expect(result.text).toBe('Done.');
    expect(s.seen).toHaveLength(5);
  });
});
