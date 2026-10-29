/**
 * A team launched from a seat of a launched team, on gmi() end to end: while that team's seat outlives the grace (its
 * tool runs past the deadline), the launch the team came from stays closing as well, so the launching session's next
 * launch is refused until the seat is released, as it is for a seat of the launch's own team. The real gmi(),
 * agency(), its strategies, the launch engine, the provider manager, completion gateway, GMI and tool orchestrator run;
 * only the provider classes are stubbed (helpers/stubProviders.ts), at their module boundary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { gmi } from '../gmi';
import type { GenerateTextResult } from '../generateText';
import type { ITool } from '../../core/tools/ITool';
import { launchRegistry } from '../runtime/agencyLaunch/launchRegistry';
import type { AgencyLaunchFrame, LaunchAgencyResult } from '../runtime/agencyLaunch/types';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

/** The parent's route, under a key of its own; no fallback, so a failed hop ends the turn. */
const route = (k: string) => ({ provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [] });
/** A model step that calls launch_agency once with `args`. */
const launchStep = (args: Record<string, unknown>, id = 'l1') => reply.tools([{ id, name: 'launch_agency', args }]);
/** The output of a send's `i`-th tool call: a launch that started. */
const launchOf = (result: GenerateTextResult, i = 0): LaunchAgencyResult => {
  const call = result.toolCalls[i];
  expect(call?.name).toBe('launch_agency');
  expect(call?.error).toBeUndefined();
  return call.result as LaunchAgencyResult;
};
/** The refusal code of a send's `i`-th tool call (its error reads `<code>: <reason>`). */
const refusalOf = (result: GenerateTextResult, i: number): string => String(result.toolCalls[i]?.error ?? '').split(':')[0];

beforeEach(() => globalLLMProviderHealth.reset());

describe('a team launched from a seat', () => {
  it("keeps the launch it came from closing while its seat outlives the grace, so the session's next launch waits for that seat", async () => {
    const k = 'k-nested-closing-1';
    let release!: () => void;
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The frame of each call of the tool: the team its seat sits in.
    const frames: AgencyLaunchFrame[] = [];
    // An ITool, so `execute` receives the call's context. It runs past the deadline and the grace until released.
    const hang: ITool = {
      id: 'hang-v1',
      name: 'hang',
      displayName: 'Hang',
      description: 'Waits.',
      inputSchema: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: async (_args, context) => {
        frames.push(context.sessionData?.agencyLaunch as AgencyLaunchFrame);
        await hanging;
        return { success: true, output: 'done' };
      },
    };
    const oneSeat = { goal: 'Answer.', seats: [{ role: 'second', instructions: 'Answer.' }] };
    const s = script('openai', k, {
      replies: [
        // The root's step: a team whose lead may hang and launch.
        launchStep({ goal: 'Wait.', deadlineMs: 1_000, seats: [{ role: 'lead', instructions: 'Lead.', tools: ['hang', 'launch_agency'] }] }),
        // The lead's step: a team of its own, whose waiter calls hang.
        launchStep({ goal: 'Wait longer.', seats: [{ role: 'waiter', instructions: 'Call hang.', tools: ['hang'] }] }, 'n1'),
        // The waiter's step: its tool runs past the deadline and the grace.
        reply.tools([{ id: 'h1', name: 'hang', args: {} }]),
        reply.text('Timed out.'),
        // The next send's launch, while the waiter's seat is held.
        launchStep(oneSeat, 'l2'),
        reply.text('Still busy.'),
        // Once the seat is released, the session launches again.
        launchStep(oneSeat, 'l3'),
        reply.text('Answered.'),
        reply.text('Now it ran.'),
      ],
    });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', tools: { hang }, agencies: { launch: true } });
    const session = parent.session('p1');

    const first = await session.send('Start.');
    const root = launchOf(first);
    expect(root.status).toBe('timed_out');
    // The waiter's tool runs in the lead's team (the precondition), and that team is closing.
    expect(frames).toEqual([expect.objectContaining({ role: 'waiter', depth: 2 })]);
    const nestedId = frames[0].launchId;
    expect(launchRegistry.get(nestedId)?.state).toBe('closing');
    // The root's own seat is released within microtasks of its team's result: half a second covers it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The launch the lead's team came from stays closing for the waiter's seat, and counts toward the session's one
    // launch in flight.
    expect(launchRegistry.get(root.agencyId)?.state).toBe('closing');
    const second = await session.send('Again.');
    expect(refusalOf(second, 0)).toBe('concurrency_exceeded');
    release();
    await vi.waitFor(() => expect(launchRegistry.get(nestedId)).toBeUndefined(), { timeout: 10_000 });
    await vi.waitFor(() => expect(launchRegistry.get(root.agencyId)).toBeUndefined(), { timeout: 10_000 });
    const third = await session.send('Once more.');
    expect(launchOf(third).status).toBe('completed');
    // The tool ran once: no retry seated another waiter.
    expect(frames).toHaveLength(1);
    // Root, lead, waiter, root; root, root; root, the second team's seat, root.
    expect(s.seen).toHaveLength(9);
  }, 40_000);
});
