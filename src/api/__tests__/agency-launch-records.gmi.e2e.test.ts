/**
 * launch_agency on gmi(), end to end: what a launch's result reports of a seat its deadline left running and of a
 * call its own token cap refused. The real gmi(), agency(), its strategies, the launch engine, the provider manager,
 * completion gateway, GMI and tool orchestrator run; only the provider classes are stubbed
 * (helpers/stubProviders.ts), at their module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { gmi } from '../gmi';
import type { GenerateTextResult } from '../generateText';
import { launchRegistry } from '../runtime/agencyLaunch/launchRegistry';
import type { LaunchAgencyResult } from '../runtime/agencyLaunch/types';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-launch-records-${++n}`;
/** A model step that calls launch_agency once with `args`. */
const launchStep = (args: Record<string, unknown>, id = 'l1') => reply.tools([{ id, name: 'launch_agency', args }]);
/** The output of a send's `i`-th tool call: a launch that started. */
const launchOf = (result: GenerateTextResult, i = 0): LaunchAgencyResult => {
  const call = result.toolCalls[i];
  expect(call?.name).toBe('launch_agency');
  expect(call?.error).toBeUndefined();
  return call.result as LaunchAgencyResult;
};
/** The parent's route, under a key of its own; no fallback, so a failed hop ends the turn. */
const route = (k: string) => ({ provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [] });

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('launch_agency on gmi(): what the result reports', () => {
  it('a seat whose call still runs when the launch returns is reported cut', async () => {
    const k = key();
    let release!: () => void;
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hang = vi.fn(async () => {
      await hanging;
      return 'done';
    });
    script('openai', k, {
      replies: [
        launchStep({
          goal: 'Draft and edit.',
          deadlineMs: 1_000,
          seats: [{ role: 'drafter', instructions: 'Call hang.', tools: ['hang'] }, { role: 'editor', instructions: 'Edit.' }],
        }),
        // The drafter's tool runs past the deadline and the grace.
        reply.tools([{ id: 'h1', name: 'hang', args: {} }]),
        reply.text('The team ran out of time.'),
      ],
    });
    const parent = gmi({
      ...route(k),
      instructions: 'Coordinate.',
      tools: { hang: { description: 'Hangs.', parameters: { type: 'object', properties: {} }, execute: hang } },
      agencies: { launch: true },
    });

    const started = Date.now();
    const result = await parent.session('p1').send('Go.');
    const out = launchOf(result);
    // The launch returned within the deadline and one grace, the drafter's tool still running (the precondition).
    expect(Date.now() - started).toBeLessThan(1_000 + 5_000 + 2_000);
    expect(hang).toHaveBeenCalledTimes(1);
    expect(launchRegistry.get(out.agencyId)?.state).toBe('closing');
    expect(out.status).toBe('timed_out');
    expect(out.seats.map((r) => [r.role, r.status, r.calls])).toEqual([
      ['drafter', 'cut', 1],
      ['editor', 'not_run', 0],
    ]);
    expect(result.text).toBe('The team ran out of time.');
    release();
    await vi.waitFor(() => expect(launchRegistry.get(out.agencyId)).toBeUndefined(), { timeout: 10_000 });
  }, 40_000);

  it("a call the launch's own token cap refuses before anything is spent is named in the refusal's words", async () => {
    const k = key();
    const s = script('openai', k, {
      replies: [
        // The seat's first step, its instructions and the goal with the output estimate, passes the 6,500-token cap.
        launchStep({ goal: 'g'.repeat(8_000), maxTokens: 6_500, seats: [{ role: 'reader', instructions: 'r'.repeat(8_192) }] }),
        reply.text('The team stopped.'),
      ],
    });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', agencies: { launch: true } });

    const result = await parent.session('p1').send('Go.');
    const out = launchOf(result);
    // The seat's step was refused before its request (the precondition): only the parent's two steps were sent.
    expect(s.seen).toHaveLength(2);
    expect(out.provenance.budget).toMatchObject({ maxTotalTokens: 6_500, tokensUsed: 0 });
    expect(out.status).toBe('budget_exhausted');
    expect(out.reason).toMatch(/^the launch's budget refused a call: \d+ tokens would pass 6500$/);
    expect(out.seats.map((r) => [r.role, r.status])).toEqual([['reader', 'cut']]);
    expect(result.text).toBe('The team stopped.');
  });
});
