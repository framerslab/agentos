/**
 * launch_agency on gmi(), end to end: a gmi() agent with agencies.launch launches a temporary agency() team from
 * inside a turn and gets one tool result, under the launch's bounds, budget, deadline, tool set and approval gate. The
 * real gmi(), agency(), its strategies, the launch engine, the provider manager, completion gateway, GMI and tool
 * orchestrator run; only the provider classes are stubbed (helpers/stubProviders.ts), at their module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { gmi } from '../gmi';
import type { GenerateTextResult } from '../generateText';
import type { LaunchAgencyResult } from '../runtime/agencyLaunch/types';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-launch-${++n}`;
type SeenCall = { messages: Array<{ role: string; content: unknown }>; options: Record<string, unknown> };
/** The system prompt a model call sent: the text of its system messages. */
const systemText = (call: SeenCall): string =>
  call.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
/** The text of a model call's last user message. */
const lastUserText = (call: SeenCall): string => {
  const users = call.messages.filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  return last ? (typeof last.content === 'string' ? last.content : JSON.stringify(last.content)) : '';
};
/** The tool names a model call offered. */
const offered = (call: SeenCall): string[] =>
  ((call.options.tools as Array<{ function: { name: string } }> | undefined) ?? []).map((tool) => tool.function.name);
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
/** The parent's route, under a key of its own; no fallback, so a failed hop ends the turn. */
const route = (k: string) => ({ provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [] });

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('launch_agency on gmi()', () => {
  it("a gmi() agent with agencies.launch launches a sequential two-seat team and gets one tool result with both seats' text", async () => {
    const k = key();
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Write a haiku about rain.', seats: [{ role: 'drafter', instructions: 'Draft a haiku.' }, { role: 'editor', instructions: 'Edit the draft.' }] }),
        reply.text('Rain taps the window.'),
        reply.text('Soft rain on the glass.'),
        reply.text('Here is the haiku.'),
      ],
    });
    const parent = gmi({ ...route(k), instructions: 'Coordinate writers.', agencies: { launch: true } });

    const result = await parent.session('p1').send('Get me a haiku.');
    expect(result.text).toBe('Here is the haiku.');
    expect(offered(s.seen[0])).toContain('launch_agency');
    const out = launchOf(result);
    expect(out).toMatchObject({ status: 'completed', text: 'Soft rain on the glass.', truncated: false });
    expect(out.reason).toBeUndefined();
    expect(out.seats.map((r) => [r.role, r.form, r.status, r.calls, r.summary])).toEqual([
      ['drafter', 'temporary', 'completed', 1, 'Rain taps the window.'],
      ['editor', 'temporary', 'completed', 1, 'Soft rain on the glass.'],
    ]);
    expect(out.seats.map((r) => r.usage.totalTokens)).toEqual([15, 15]);
    expect(out.usage.totalTokens).toBe(30);
    expect(out.provenance).toMatchObject({ strategy: 'sequential', depth: 1, parentSessionId: 'p1' });
    // Each seat is a GMI of its own instructions, and the editor's input holds the drafter's output.
    expect(systemText(s.seen[1])).toContain('Draft a haiku.');
    expect(systemText(s.seen[2])).toContain('Edit the draft.');
    expect(lastUserText(s.seen[2])).toContain('Rain taps the window.');
    // The parent's next step sees the result.
    expect(JSON.stringify(s.seen[3].messages)).toContain('Soft rain on the glass.');
    expect(s.seen).toHaveLength(4);
  });

  it('invalid arguments are a tool error, never a throw, and the parent turn finishes', async () => {
    const k = key();
    const seat = (role: string) => ({ role, instructions: `Be the ${role}.` });
    const s = script('openai', k, {
      replies: [
        reply.tools([
          { id: 'a', name: 'launch_agency', args: { goal: 'x', seats: [seat('writer'), seat('writer')] } },
          { id: 'b', name: 'launch_agency', args: { goal: 'x', strategy: 'review-loop', seats: [seat('a'), seat('b'), seat('c')] } },
          { id: 'c', name: 'launch_agency', args: { goal: 'x', seats: [seat('r'.repeat(53))] } },
          { id: 'd', name: 'launch_agency', args: { goal: 'x', seats: [seat('writer')], colour: 'blue' } },
          { id: 'e', name: 'launch_agency', args: { goal: 'x', seats: ['a', 'b', 'c', 'd', 'e', 'f'].map((role) => seat(role)) } },
        ]),
        reply.text('No team ran.'),
      ],
    });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', agencies: { launch: true, maxSeats: 5 } });

    const result = await parent.session('p1').send('Try.');
    // The schema sets no maxItems and no additionalProperties: counts and unknown keys are the engine's, with its codes.
    expect([0, 1, 2, 3, 4].map((i) => refusalOf(result, i))).toEqual(['invalid_arguments', 'invalid_arguments', 'invalid_arguments', 'invalid_arguments', 'too_many_seats']);
    expect(result.toolCalls[2].error).toContain('52 characters');
    expect(result.toolCalls[3].error).toContain("unknown argument 'colour'");
    // No seat ran: the parent's two steps are the only model calls, and the turn finished.
    expect(s.seen).toHaveLength(2);
    expect(result.text).toBe('No team ran.');
  });
});
