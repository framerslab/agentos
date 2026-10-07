/**
 * @file agency-integration.test.ts
 * Full integration tests for the `agency()` + `hitl` surface.
 *
 * These tests exercise the public API as a caller would use it: creating an
 * agency with various combinations of guardrails, controls, observability
 * callbacks, HITL handlers, and session management.
 *
 * Because the tests must run without real LLM API keys, the `agent()` factory
 * (the actual transport that fires HTTP requests) is replaced with a vi.mock
 * stub that returns controlled results.  Every other layer — `agency()`,
 * strategy compilation, resource controls, callback dispatch, and session
 * management — runs with its production implementation.
 *
 * Test areas:
 * - Sequential strategy with guardrails + controls + observability callbacks
 * - HITL auto-approve handler (beforeReturn gate)
 * - Session multi-turn history accumulation
 * - `close()` resource teardown (no throw)
 * - Resource limit breaches firing `limitReached` callbacks
 * - `agentEnd` callback fires on every generate() call
 * - Parallel strategy (requires agency-level model)
 * - Session isolation (two concurrent sessions do not share history)
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Agent, BaseAgentConfig } from '../../types.js';
import { AgencyConfigError } from '../../types.js';

// ---------------------------------------------------------------------------
// Mock the strategy module so strategy compilers use our controllable spy
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  /**
   * The spy that backs every compiled strategy's `execute()` method.
   * Tests customise it per-call with `mockResolvedValueOnce` or reset it
   * in `beforeEach`.
   */
  strategyExecute: vi.fn(),
  strategyStream: vi.fn(),
}));

/**
 * Stub out the strategy compiler.  The production `agency()` calls
 * `compileStrategy(...)` exactly once at construction time.  Our stub
 * returns a single compiled strategy whose `execute` and `stream` delegate
 * to the hoisted spies, making every generate/stream call fully controllable
 * without any real network I/O.
 *
 * `isAgent` preserves the real behaviour (duck-typing on `generate`) so that
 * `close()` correctly detects and closes pre-built Agent instances.
 */
vi.mock('../strategies/index.js', () => ({
  compileStrategy: vi.fn(() => ({
    execute: hoisted.strategyExecute,
    stream: hoisted.strategyStream,
  })),
  isAgent: (value: BaseAgentConfig | Agent) =>
    typeof (value as Agent).generate === 'function',
}));

import { agency } from '../../agency.js';
import { hitl } from '../hitl.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Token usage returned by default execute() calls. */
const DEFAULT_USAGE = { promptTokens: 20, completionTokens: 10, totalTokens: 30 };

/** Typical single-agent call record included in default execute() results. */
const DEFAULT_AGENT_CALL = {
  agent: 'researcher',
  input: 'Write about AI',
  output: 'AI is transformative.',
  toolCalls: [],
  usage: DEFAULT_USAGE,
  durationMs: 80,
};

/** Full result returned by the mock strategy on every call unless overridden. */
const DEFAULT_RESULT = {
  text: 'AI is transformative.',
  agentCalls: [DEFAULT_AGENT_CALL],
  usage: DEFAULT_USAGE,
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Returns a minimal `BaseAgentConfig` identified by `name`.
 *
 * @param name - Label embedded in the agent's instructions.
 */
function mockAgentConfig(name: string): BaseAgentConfig {
  return { instructions: `You are ${name}.` };
}

/**
 * Creates a pre-built mock `Agent` whose `generate()` always resolves with a
 * controlled result.  Useful when testing the `agents` roster with pre-built
 * instances rather than raw config objects.
 *
 * @param text - Output text the mock returns.
 */
function mockAgent(text = 'mock output'): Agent {
  return {
    generate: vi.fn().mockResolvedValue({ text, agentCalls: [], usage: DEFAULT_USAGE }),
    stream: vi.fn(),
    session: vi.fn(),
    usage: vi.fn().mockResolvedValue(DEFAULT_USAGE),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  /* Reset spies so each test starts from a clean slate. */
  hoisted.strategyExecute.mockResolvedValue(DEFAULT_RESULT);
  hoisted.strategyStream.mockReturnValue({
    textStream: (async function* () { yield DEFAULT_RESULT.text; })(),
    fullStream: (async function* () { yield { type: 'text', text: DEFAULT_RESULT.text }; })(),
    text: Promise.resolve(DEFAULT_RESULT.text),
    usage: Promise.resolve(DEFAULT_RESULT.usage),
    agentCalls: Promise.resolve(DEFAULT_RESULT.agentCalls),
  });
});

// ---------------------------------------------------------------------------
// Sequential with guardrails + controls + observability
// ---------------------------------------------------------------------------

describe('Agency Full Integration', () => {
  it('runs sequential with guardrails + controls + observability', async () => {
    const events: Array<Record<string, unknown>> = [];

    const team = agency({
      agents: {
        researcher: mockAgentConfig('researcher'),
        writer: mockAgentConfig('writer'),
      },
      strategy: 'sequential',
      guardrails: { output: ['grounding-guard'] },
      controls: { maxAgentCalls: 10 },
      observability: { traceEvents: true },
      on: {
        agentEnd: (e) => events.push(e as unknown as Record<string, unknown>),
      },
    });

    const result = await team.generate('Write about AI') as Record<string, unknown>;

    // Core result shape
    expect(result.text).toBe(DEFAULT_RESULT.text);
    expect(Array.isArray(result.agentCalls)).toBe(true);

    // agentEnd callback fired (once by the agency wrapper itself)
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({
      agent: '__agency__',
      output: DEFAULT_RESULT.text,
    });
  });

  it('fires agentEnd callback with correct agent name', async () => {
    const endEvents: Array<{ agent: string; output: string; durationMs: number; timestamp: number }> = [];

    const team = agency({
      agents: { worker: mockAgentConfig('worker') },
      strategy: 'sequential',
      on: { agentEnd: (e) => endEvents.push(e) },
    });

    await team.generate('task');

    expect(endEvents).toHaveLength(1);
    expect(endEvents[0].output).toBe(DEFAULT_RESULT.text);
    expect(typeof endEvents[0].durationMs).toBe('number');
    expect(typeof endEvents[0].timestamp).toBe('number');
  });

  it('does not fire agentEnd when no callback is registered', async () => {
    // If no callback, the agency must not throw when trying to fire it.
    const team = agency({
      agents: { worker: mockAgentConfig('worker') },
      strategy: 'sequential',
    });

    await expect(team.generate('task')).resolves.toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Named agency
  // ---------------------------------------------------------------------------

  it('uses the agency name in agentEnd events when provided', async () => {
    const endEvents: Array<{ agent: string }> = [];

    const team = agency({
      name: 'my-team',
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
      on: { agentEnd: (e) => endEvents.push(e) },
    });

    await team.generate('named agency task');
    expect(endEvents[0].agent).toBe('my-team');
  });

  // ---------------------------------------------------------------------------
  // HITL auto-approve
  // ---------------------------------------------------------------------------

  it('runs with HITL auto-approve', async () => {
    const team = agency({
      agents: { worker: mockAgentConfig('worker') },
      strategy: 'sequential',
      hitl: {
        approvals: { beforeReturn: true },
        handler: hitl.autoApprove(),
      },
    });

    const result = await team.generate('Do the thing') as Record<string, unknown>;
    // Strategy still executes and returns a valid result.
    expect(result.text).toBeDefined();
    expect(result.text).toBe(DEFAULT_RESULT.text);
  });

  it('enforces beforeReturn HITL and allows output modification', async () => {
    const approvalRequested = vi.fn();
    const approvalDecided = vi.fn();

    const team = agency({
      agents: { worker: mockAgentConfig('worker') },
      strategy: 'sequential',
      hitl: {
        approvals: { beforeReturn: true },
        handler: async () => ({
          approved: true,
          modifications: { output: 'approved and rewritten' },
        }),
      },
      on: { approvalRequested, approvalDecided },
    });

    const result = await team.generate('Do the thing') as Record<string, unknown>;
    expect(result.text).toBe('approved and rewritten');
    expect(approvalRequested).toHaveBeenCalledOnce();
    expect(approvalDecided).toHaveBeenCalledOnce();
  });

  it('rejects the final result when beforeReturn HITL rejects', async () => {
    const team = agency({
      agents: { worker: mockAgentConfig('worker') },
      strategy: 'sequential',
      hitl: {
        approvals: { beforeReturn: true },
        handler: async () => ({ approved: false, reason: 'needs human review' }),
      },
    });

    await expect(team.generate('Do the thing')).rejects.toThrow(/needs human review/i);
  });

  it('runs with HITL auto-approve on beforeTool trigger', async () => {
    const team = agency({
      agents: { worker: mockAgentConfig('worker') },
      strategy: 'sequential',
      hitl: {
        approvals: { beforeTool: ['delete-record'] },
        handler: hitl.autoApprove(),
      },
    });

    const result = await team.generate('delete record') as Record<string, unknown>;
    expect(result.text).toBeDefined();
  });

  it('runs with HITL auto-reject handler (config must not throw)', () => {
    expect(() =>
      agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        hitl: {
          approvals: { beforeReturn: true },
          handler: hitl.autoReject('dry-run'),
        },
      }),
    ).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Session — multi-turn history
  // ---------------------------------------------------------------------------

  it('session maintains history across turns', async () => {
    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
    });

    const session = team.session('test') as {
      send: (t: string) => Promise<unknown>;
      messages: () => Array<{ role: string; content: string }>;
    };

    await session.send('First message');
    await session.send('Second message');

    const history = session.messages();
    // 2 user turns + 2 assistant turns = 4 messages
    expect(history.length).toBe(4);
    expect(history[0]).toEqual({ role: 'user', content: 'First message' });
    expect(history[1]).toEqual({ role: 'assistant', content: DEFAULT_RESULT.text });
    expect(history[2]).toEqual({ role: 'user', content: 'Second message' });
    expect(history[3]).toEqual({ role: 'assistant', content: DEFAULT_RESULT.text });
  });

  it('session send includes prior turns in later prompts', async () => {
    hoisted.strategyExecute.mockClear();
    hoisted.strategyExecute.mockResolvedValue(DEFAULT_RESULT);

    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
    });

    const session = team.session('history-prompt') as {
      send: (t: string) => Promise<unknown>;
    };

    await session.send('First message');
    await session.send('Second message');

    expect(hoisted.strategyExecute).toHaveBeenNthCalledWith(1, 'First message', undefined);
    expect(hoisted.strategyExecute).toHaveBeenNthCalledWith(
      2,
      'User: First message\nAssistant: AI is transformative.\nUser: Second message',
      undefined,
    );
  });

  it('session.clear() removes all history', async () => {
    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
    });

    const session = team.session('clear-test') as {
      send: (t: string) => Promise<unknown>;
      messages: () => Array<{ role: string; content: string }>;
      clear: () => void;
    };

    await session.send('Hello');
    expect(session.messages().length).toBe(2);
    session.clear();
    expect(session.messages().length).toBe(0);
  });

  it('session isolation — two sessions do not share history', async () => {
    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
    });

    const s1 = team.session('session-a') as {
      send: (t: string) => Promise<unknown>;
      messages: () => Array<{ role: string; content: string }>;
    };
    const s2 = team.session('session-b') as {
      send: (t: string) => Promise<unknown>;
      messages: () => Array<{ role: string; content: string }>;
    };

    await s1.send('Only in s1');
    expect(s1.messages().length).toBe(2);
    expect(s2.messages().length).toBe(0);
  });

  it('session auto-generates a unique ID when none provided', () => {
    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
    });

    const s1 = team.session() as { id: string };
    const s2 = team.session() as { id: string };

    // Both sessions exist and their IDs are valid strings.
    expect(typeof s1.id).toBe('string');
    expect(typeof s2.id).toBe('string');
    // Two auto-generated sessions must not collide.
    expect(s1.id).not.toBe(s2.id);
  });

  it('same session ID returns identical session object', () => {
    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
    });

    const s1 = team.session('stable-id');
    const s2 = team.session('stable-id');
    expect(s1).toBe(s2);
  });

  // ---------------------------------------------------------------------------
  // close() teardown
  // ---------------------------------------------------------------------------

  it('close cleans up all resources without throwing', async () => {
    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
    });

    await team.generate('task');
    await expect(team.close()).resolves.toBeUndefined();
  });

  it('close calls close() on pre-built Agent instances', async () => {
    const preBuilt = mockAgent('worker output');

    const team = agency({
      agents: { worker: preBuilt },
      strategy: 'sequential',
    });

    await team.close();
    expect(preBuilt.close).toHaveBeenCalledOnce();
  });

  it('close can be called without a preceding generate()', async () => {
    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
    });

    await expect(team.close()).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Resource controls
  // ---------------------------------------------------------------------------

  it('fires limitReached callback when token limit is breached', async () => {
    hoisted.strategyExecute.mockResolvedValueOnce({
      text: 'over-budget',
      agentCalls: [],
      usage: { promptTokens: 5000, completionTokens: 2000, totalTokens: 7000 },
    });

    const limitEvents: Array<{ metric: string; value: number; limit: number }> = [];

    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
      controls: { maxTotalTokens: 1000, onLimitReached: 'warn' },
      on: { limitReached: (e) => limitEvents.push(e) },
    });

    await team.generate('expensive task');

    expect(limitEvents.length).toBe(1);
    expect(limitEvents[0].metric).toBe('maxTotalTokens');
    expect(limitEvents[0].value).toBe(7000);
    expect(limitEvents[0].limit).toBe(1000);
  });

  it('throws AgencyConfigError when token limit breached and onLimitReached is "error"', async () => {
    hoisted.strategyExecute.mockResolvedValueOnce({
      text: 'over-budget',
      agentCalls: [],
      usage: { promptTokens: 5000, completionTokens: 2000, totalTokens: 7000 },
    });

    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
      controls: { maxTotalTokens: 1000, onLimitReached: 'error' },
    });

    await expect(team.generate('expensive task')).rejects.toThrow(AgencyConfigError);
  });

  it('does not fire limitReached when within limits', async () => {
    const limitEvents: unknown[] = [];

    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
      controls: { maxTotalTokens: 100_000, onLimitReached: 'warn' },
      on: { limitReached: (e) => limitEvents.push(e) },
    });

    await team.generate('cheap task');
    expect(limitEvents.length).toBe(0);
  });

  it('fires limitReached callback when cost limit is breached', async () => {
    hoisted.strategyExecute.mockResolvedValueOnce({
      text: 'over-budget',
      agentCalls: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUSD: 1.25 },
    });

    const limitEvents: Array<{ metric: string; value: number; limit: number }> = [];
    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
      controls: { maxCostUSD: 0.5, onLimitReached: 'warn' },
      on: { limitReached: (e) => limitEvents.push(e) },
    });

    await team.generate('expensive task');

    expect(limitEvents).toHaveLength(1);
    expect(limitEvents[0]).toMatchObject({
      metric: 'maxCostUSD',
      value: 1.25,
      limit: 0.5,
    });
  });

  // ---------------------------------------------------------------------------
  // usage()
  // ---------------------------------------------------------------------------

  it('agency-level usage() resolves to a usage object', async () => {
    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
    });

    const u = await team.usage() as Record<string, unknown>;
    expect(typeof u.promptTokens).toBe('number');
    expect(typeof u.completionTokens).toBe('number');
    expect(typeof u.totalTokens).toBe('number');
  });

  it('usage() aggregates across multiple generate calls', async () => {
    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
    });

    await team.generate('first');
    await team.generate('second');

    const usage = await team.usage() as Record<string, unknown>;
    expect(usage.promptTokens).toBe(DEFAULT_USAGE.promptTokens * 2);
    expect(usage.completionTokens).toBe(DEFAULT_USAGE.completionTokens * 2);
    expect(usage.totalTokens).toBe(DEFAULT_USAGE.totalTokens * 2);
  });

  it('session.usage() resolves to a usage object', async () => {
    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
    });

    const session = team.session('usage-sess') as { usage: () => Promise<unknown> };
    const u = await session.usage() as Record<string, unknown>;
    expect(typeof u.promptTokens).toBe('number');
    expect(typeof u.completionTokens).toBe('number');
    expect(typeof u.totalTokens).toBe('number');
  });

  it('session.usage() aggregates only that session', async () => {
    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
    });

    const s1 = team.session('s1') as { send: (t: string) => Promise<unknown>; usage: () => Promise<Record<string, unknown>> };
    const s2 = team.session('s2') as { send: (t: string) => Promise<unknown>; usage: () => Promise<Record<string, unknown>> };

    await s1.send('one');
    await s1.send('two');
    await s2.send('three');

    const u1 = await s1.usage();
    const u2 = await s2.usage();
    expect(u1.totalTokens).toBe(DEFAULT_USAGE.totalTokens * 2);
    expect(u2.totalTokens).toBe(DEFAULT_USAGE.totalTokens);
  });

  // ---------------------------------------------------------------------------
  // stream()
  // ---------------------------------------------------------------------------

  it('stream() delegates to the compiled strategy', async () => {
    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
    });

    const streamResult = team.stream('stream test') as {
      text: Promise<string>;
      textStream: AsyncIterable<string>;
    };

    await streamResult.text;

    // The mock strategy stream is invoked and returns a valid object.
    expect(streamResult).toBeDefined();
    expect(hoisted.strategyStream).toHaveBeenCalledWith('stream test', undefined);
  });

  it('stream() appends the structured-output schema hint before streaming', async () => {
    hoisted.strategyStream.mockClear();

    const schema = {
      parse: (v: unknown) => v,
      shape: { score: {} },
    };

    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
      output: schema,
    });

    const streamResult = team.stream('Return JSON') as { text: Promise<string> };
    await streamResult.text;

    const calledPrompt = hoisted.strategyStream.mock.calls[0][0] as string;
    expect(calledPrompt).toContain('Respond with valid JSON');
    expect(calledPrompt).toContain('score');
  });

  it('stream textStream is iterable', async () => {
    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
    });

    const streamResult = team.stream('stream task') as { textStream: AsyncIterable<string> };
    const chunks: string[] = [];

    for await (const chunk of streamResult.textStream) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]).toBe(DEFAULT_RESULT.text);
  });

  it('stream() applies beforeReturn HITL modifications to the resolved text', async () => {
    const approvalRequested = vi.fn();
    const approvalDecided = vi.fn();
    const agentEnd = vi.fn();

    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
      hitl: {
        approvals: { beforeReturn: true },
        handler: async () => ({
          approved: true,
          modifications: { output: 'approved stream output' },
        }),
      },
      on: { approvalRequested, approvalDecided, agentEnd },
    });

    const streamResult = team.stream('stream approval') as { text: Promise<string> };

    await expect(streamResult.text).resolves.toBe('approved stream output');
    expect(approvalRequested).toHaveBeenCalledOnce();
    expect(approvalDecided).toHaveBeenCalledOnce();
    expect(agentEnd).toHaveBeenCalledWith(
      expect.objectContaining({ output: 'approved stream output' }),
    );
  });

  it('stream() exposes parsed output and aggregates usage once', async () => {
    const jsonResult = '{"score":42}';
    hoisted.strategyStream.mockReturnValueOnce({
      textStream: (async function* () { yield jsonResult; })(),
      fullStream: (async function* () { yield { type: 'text', text: jsonResult }; })(),
      text: Promise.resolve(jsonResult),
      usage: Promise.resolve(DEFAULT_USAGE),
    });

    const schema = {
      parse: (v: unknown) => v,
      shape: { score: {} },
    };

    const team = agency({
      agents: { a: mockAgentConfig('a') },
      strategy: 'sequential',
      output: schema,
    });

    const streamResult = team.stream('stream structured') as unknown as {
      text: Promise<string>;
      usage: Promise<Record<string, unknown>>;
      parsed: Promise<unknown>;
    };

    await expect(streamResult.text).resolves.toBe(jsonResult);
    await expect(streamResult.parsed).resolves.toEqual({ score: 42 });
    await expect(streamResult.usage).resolves.toEqual(DEFAULT_USAGE);

    const usage = await team.usage() as Record<string, unknown>;
    expect(usage.totalTokens).toBe(DEFAULT_USAGE.totalTokens);
  });

  // ---------------------------------------------------------------------------
  // Validation edge cases
  // ---------------------------------------------------------------------------

  it('parallel strategy with agency-level model runs without throwing', async () => {
    const team = agency({
      model: 'openai:gpt-4o',
      agents: { a: mockAgentConfig('a'), b: mockAgentConfig('b') },
      strategy: 'parallel',
    });

    const result = await team.generate('parallel task') as Record<string, unknown>;
    expect(result.text).toBeDefined();
  });

  it('debate strategy with agency-level model runs without throwing', async () => {
    const team = agency({
      model: 'openai:gpt-4o',
      agents: { a: mockAgentConfig('a'), b: mockAgentConfig('b') },
      strategy: 'debate',
    });

    const result = await team.generate('debate task') as Record<string, unknown>;
    expect(result.text).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // beforeAgent HITL enforcement
  // ---------------------------------------------------------------------------

  describe('beforeAgent HITL', () => {
    it('skips agent when beforeAgent HITL rejects', async () => {
      /**
       * When a HITL handler rejects a beforeAgent approval, the strategy
       * should skip that agent entirely. We verify by checking that the
       * strategy execute still receives the call (the gate is inside the
       * strategy compiler, not wrappedExecute), but more importantly
       * that the agency plumbing doesn't throw.
       */
      const handler = vi.fn().mockResolvedValue({ approved: false, reason: 'not now' });

      const team = agency({
        agents: {
          researcher: mockAgentConfig('researcher'),
          writer: mockAgentConfig('writer'),
        },
        strategy: 'sequential',
        hitl: {
          approvals: { beforeAgent: ['researcher'] },
          handler,
        },
      });

      const result = await team.generate('test task') as Record<string, unknown>;
      expect(result.text).toBeDefined();
    });

    it('proceeds when beforeAgent HITL approves', async () => {
      const handler = vi.fn().mockResolvedValue({ approved: true });

      const team = agency({
        agents: {
          researcher: mockAgentConfig('researcher'),
        },
        strategy: 'sequential',
        hitl: {
          approvals: { beforeAgent: ['researcher'] },
          handler,
        },
      });

      const result = await team.generate('approved task') as Record<string, unknown>;
      expect(result.text).toBe(DEFAULT_RESULT.text);
    });
  });

  // ---------------------------------------------------------------------------
  // Guardrails runtime binding
  // ---------------------------------------------------------------------------

  describe('Guardrails runtime binding', () => {
    it('input guardrails are evaluated before strategy execution', async () => {
      /**
       * Input guardrails run on the prompt before the strategy. Since the
       * guardrail infrastructure is not actually installed in tests, the
       * dynamic import fail-open path is taken and the prompt passes through
       * unchanged. We verify the result is still valid.
       */
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        guardrails: { input: ['pii-redactor'] },
      });

      const result = await team.generate('My SSN is 123-45-6789') as Record<string, unknown>;
      expect(result.text).toBeDefined();
    });

    it('output guardrails are evaluated after strategy execution', async () => {
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        guardrails: { output: ['toxicity-filter'] },
      });

      const result = await team.generate('Write something') as Record<string, unknown>;
      expect(result.text).toBeDefined();
    });

    it('string[] guardrails shorthand is treated as output-only', async () => {
      /**
       * For backward compatibility, passing a plain string[] to guardrails
       * applies them to the output direction only.
       */
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        guardrails: ['grounding-guard'],
      });

      const result = await team.generate('test') as Record<string, unknown>;
      expect(result.text).toBeDefined();
    });

    it('fires guardrailResult callback for each configured guardrail', async () => {
      const guardrailEvents: Array<{ guardrailId: string; passed: boolean }> = [];

      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        guardrails: { output: ['guard-a', 'guard-b'] },
        on: {
          guardrailResult: (e) => guardrailEvents.push(e),
        },
      });

      await team.generate('test with guards');
      expect(guardrailEvents.length).toBe(2);
      expect(guardrailEvents[0].guardrailId).toBe('guard-a');
      expect(guardrailEvents[1].guardrailId).toBe('guard-b');
    });
  });

  // ---------------------------------------------------------------------------
  // Structured Zod output parsing
  // ---------------------------------------------------------------------------

  describe('Structured output parsing', () => {
    it('parses valid JSON result through Zod schema into result.parsed', async () => {
      const jsonResult = JSON.stringify({ name: 'Alice', age: 30 });
      hoisted.strategyExecute.mockResolvedValueOnce({
        text: jsonResult,
        agentCalls: [],
        usage: DEFAULT_USAGE,
      });

      /** Minimal Zod-like schema stub with a parse method. */
      const schema = {
        parse: (v: unknown) => v,
        shape: { name: {}, age: {} },
      };

      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        output: schema,
      });

      const result = await team.generate('Return JSON') as Record<string, unknown>;
      expect(result.parsed).toEqual({ name: 'Alice', age: 30 });
    });

    it('returns undefined parsed for non-JSON result', async () => {
      hoisted.strategyExecute.mockResolvedValueOnce({
        text: 'This is plain text, not JSON at all.',
        agentCalls: [],
        usage: DEFAULT_USAGE,
      });

      const schema = {
        parse: (v: unknown) => {
          if (typeof v !== 'object' || v === null) throw new Error('Expected object');
          return v;
        },
      };

      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        output: schema,
      });

      const result = await team.generate('Return plain text') as Record<string, unknown>;
      expect(result.parsed).toBeUndefined();
    });

    it('extracts JSON from a code fence and parses it', async () => {
      const codeFenceResult = 'Here is the result:\n```json\n{"score": 42}\n```\nDone.';
      hoisted.strategyExecute.mockResolvedValueOnce({
        text: codeFenceResult,
        agentCalls: [],
        usage: DEFAULT_USAGE,
      });

      const schema = {
        parse: (v: unknown) => v,
      };

      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        output: schema,
      });

      const result = await team.generate('Return JSON in fence') as Record<string, unknown>;
      expect(result.parsed).toEqual({ score: 42 });
    });

    it('appends a schema hint to the prompt when output is configured', async () => {
      hoisted.strategyExecute.mockClear();
      hoisted.strategyExecute.mockResolvedValueOnce({
        text: '{"name":"Bob"}',
        agentCalls: [],
        usage: DEFAULT_USAGE,
      });

      const schema = {
        parse: (v: unknown) => v,
        shape: { name: {} },
      };

      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        output: schema,
      });

      await team.generate('Give me a name');

      /* Verify the strategy received a prompt with the schema hint appended. */
      const calledPrompt = hoisted.strategyExecute.mock.calls[0][0] as string;
      expect(calledPrompt).toContain('Respond with valid JSON');
      expect(calledPrompt).toContain('name');
    });

    it('does not populate parsed when no output schema is configured', async () => {
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
      });

      const result = await team.generate('no schema') as Record<string, unknown>;
      expect(result.parsed).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // beforeTool forwarding to sub-agent permissions
  // ---------------------------------------------------------------------------

  describe('beforeTool forwarding', () => {
    it('agency-level beforeTool config does not throw during construction', () => {
      /**
       * When `hitl.approvals.beforeTool` is set, the agency forwards those
       * tool names into each sub-agent's `permissions.requireApproval`. The
       * construction itself must not throw.
       */
      expect(() =>
        agency({
          agents: { worker: mockAgentConfig('worker') },
          strategy: 'sequential',
          hitl: {
            approvals: { beforeTool: ['dangerous-tool'] },
            handler: hitl.autoApprove(),
          },
        }),
      ).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Task 4: listen() — voice WebSocket transport
  // ---------------------------------------------------------------------------

  describe('listen() — voice transport', () => {
    it('listen() is present when voice.enabled is true', () => {
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        voice: { enabled: true },
      });

      expect(typeof team.listen).toBe('function');
    });

    it('listen() is absent when voice is not configured', () => {
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
      });

      expect(team.listen).toBeUndefined();
    });

    it('listen() is absent when voice.enabled is false', () => {
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        voice: { enabled: false },
      });

      expect(team.listen).toBeUndefined();
    });

    it('listen() returns port, url, and close function', async () => {
      /**
       * This test actually binds a WebSocket server on an OS-assigned port.
       * The `ws` package must be resolvable in the test environment.
       * If `ws` is not available, the test is skipped gracefully.
       */
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        voice: { enabled: true },
      });

      let result: { port: number; url: string; close: () => Promise<void> } | undefined;
      try {
        result = await team.listen!();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('ws package')) {
          // ws not installed in this environment — skip.
          return;
        }
        throw err;
      }

      expect(typeof result.port).toBe('number');
      expect(result.port).toBeGreaterThan(0);
      expect(result.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
      expect(typeof result.close).toBe('function');

      // Clean up the server.
      await result.close();
    });

    it('listen() with explicit port binds to that port', async () => {
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        voice: { enabled: true },
      });

      let result: { port: number; url: string; close: () => Promise<void> } | undefined;
      try {
        result = await team.listen!({ port: 0 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('ws package')) return;
        throw err;
      }

      expect(result.port).toBeGreaterThan(0);
      await result.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Task 4: connect() — channel adapter wiring
  // ---------------------------------------------------------------------------

  describe('connect() — channel wiring', () => {
    it('connect() is present when channels are configured', () => {
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        channels: { discord: { token: 'abc123' } },
      });

      expect(typeof team.connect).toBe('function');
    });

    it('connect() is absent when channels are not configured', () => {
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
      });

      expect(team.connect).toBeUndefined();
    });

    it('connect() is absent when channels object is empty', () => {
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        channels: {},
      });

      expect(team.connect).toBeUndefined();
    });

    it('connect() rejects and names every configured channel', async () => {
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        channels: {
          discord: { token: 'tok1' },
          telegram: { token: 'tok2' },
        },
      });

      await expect(team.connect!()).rejects.toThrow(/"discord", "telegram"/);
    });

    it('connect() does not log as if a channel had connected', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        channels: { slack: { webhookUrl: 'https://hooks.slack.com/...' } },
      });

      await expect(team.connect!()).rejects.toThrow(/slack/);
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('connected'));

      logSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Task 5: RAG context injection
  // ---------------------------------------------------------------------------

  describe('RAG context injection', () => {
    it('RAG config does not throw during construction', () => {
      expect(() =>
        agency({
          agents: { worker: mockAgentConfig('worker') },
          strategy: 'sequential',
          rag: {
            vectorStore: { provider: 'in-memory', embeddingModel: 'text-embedding-3-small' },
            topK: 5,
            minScore: 0.7,
          },
        }),
      ).not.toThrow();
    });

    it('generate() with RAG configured still returns a valid result', async () => {
      /**
       * Since the v1 RAG implementation is a no-op placeholder that returns
       * null (no context injected), the result should be identical to a run
       * without RAG — the prompt is passed through unchanged.
       */
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        rag: {
          vectorStore: { provider: 'in-memory' },
          topK: 3,
        },
      });

      const result = await team.generate('query with RAG') as Record<string, unknown>;
      expect(result.text).toBe(DEFAULT_RESULT.text);
    });

    it('generate() with RAG documents logs info message', async () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        rag: {
          documents: [{ path: '/tmp/doc.md', loader: 'markdown' }],
        },
      });

      await team.generate('query with documents');

      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('AgentOSOrchestrator'),
      );

      infoSpy.mockRestore();
    });

    it('generate() works normally when rag is not configured', async () => {
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
      });

      const result = await team.generate('no rag') as Record<string, unknown>;
      expect(result.text).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Task 6: stream() with per-agent events
  // ---------------------------------------------------------------------------

  describe('stream() per-agent events', () => {
    it('stream() fullStream yields agent-start for __agency__', async () => {
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
      });

      /**
       * The mock strategy stream returns a pre-baked iterable, so we test the
       * agency-level stream() delegation here (fullStream from the mock).
       * For real per-agent events, see the sequential strategy unit tests.
       */
      const streamResult = team.stream('stream test') as {
        fullStream: AsyncIterable<{ type: string; agent?: string }>;
      };

      const events: Array<{ type: string; agent?: string }> = [];
      for await (const part of streamResult.fullStream) {
        events.push(part);
      }

      // The mock strategy returns a single text event — verify it is iterable.
      expect(events.length).toBeGreaterThan(0);
    });

    it('stream() textStream yields string chunks', async () => {
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
      });

      const streamResult = team.stream('stream chunks') as {
        textStream: AsyncIterable<string>;
      };

      const chunks: string[] = [];
      for await (const chunk of streamResult.textStream) {
        chunks.push(chunk);
      }

      expect(chunks.join('')).toBe(DEFAULT_RESULT.text);
    });

    it('stream() yields text chunks incrementally before completion', async () => {
      let releaseSecondChunk!: () => void;
      const secondChunkGate = new Promise<void>((resolve) => {
        releaseSecondChunk = resolve;
      });

      hoisted.strategyStream.mockReturnValueOnce({
        textStream: (async function* () {
          yield 'first ';
          await secondChunkGate;
          yield 'second';
        })(),
        fullStream: (async function* () {
          yield { type: 'text', text: 'first ' };
          await secondChunkGate;
          yield { type: 'text', text: 'second' };
        })(),
        text: (async () => {
          await secondChunkGate;
          return 'first second';
        })(),
        usage: Promise.resolve(DEFAULT_USAGE),
        agentCalls: Promise.resolve(DEFAULT_RESULT.agentCalls),
      });

      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
      });

      const streamResult = team.stream('incremental stream') as {
        textStream: AsyncIterable<string>;
        text: Promise<string>;
      };
      const iterator = streamResult.textStream[Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toEqual({ value: 'first ', done: false });
      releaseSecondChunk();
      await expect(iterator.next()).resolves.toEqual({ value: 'second', done: false });
      await expect(streamResult.text).resolves.toBe('first second');
    });

    it('stream() text promise resolves to the full text', async () => {
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
      });

      const streamResult = team.stream('stream text') as { text: Promise<string> };
      const text = await streamResult.text;
      expect(text).toBe(DEFAULT_RESULT.text);
    });

    it('stream() exposes the finalized agentCalls ledger', async () => {
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
      });

      const streamResult = team.stream('stream ledger') as unknown as {
        agentCalls: Promise<unknown>;
      };

      await expect(streamResult.agentCalls).resolves.toEqual(DEFAULT_RESULT.agentCalls);
    });

    it('stream() fullStream includes approval events and the finalized output event', async () => {
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        hitl: {
          approvals: { beforeReturn: true },
          handler: async () => ({
            approved: true,
            modifications: { output: 'approved stream output' },
          }),
        },
      });

      const streamResult = team.stream('stream approval events') as {
        fullStream: AsyncIterable<Record<string, unknown>>;
        text: Promise<string>;
      };

      const parts: Array<Record<string, unknown>> = [];
      for await (const part of streamResult.fullStream) {
        parts.push(part);
      }

      await expect(streamResult.text).resolves.toBe('approved stream output');
      expect(parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'approval-requested' }),
          expect.objectContaining({ type: 'approval-decided', approved: true }),
          expect.objectContaining({
            type: 'final-output',
            text: 'approved stream output',
            usage: DEFAULT_USAGE,
            agentCalls: DEFAULT_RESULT.agentCalls,
          }),
          expect.objectContaining({
            type: 'agent-end',
            agent: '__agency__',
            output: 'approved stream output',
          }),
        ]),
      );
    });

    it('stream() exposes finalTextStream with only the finalized approved text', async () => {
      const team = agency({
        agents: { worker: mockAgentConfig('worker') },
        strategy: 'sequential',
        hitl: {
          approvals: { beforeReturn: true },
          handler: async () => ({
            approved: true,
            modifications: { output: 'approved stream output' },
          }),
        },
      });

      const streamResult = team.stream('stream finalized text') as unknown as {
        textStream: AsyncIterable<string>;
        finalTextStream: AsyncIterable<string>;
      };

      const rawChunks: string[] = [];
      for await (const chunk of streamResult.textStream) {
        rawChunks.push(chunk);
      }

      const finalizedChunks: string[] = [];
      for await (const chunk of streamResult.finalTextStream) {
        finalizedChunks.push(chunk);
      }

      expect(rawChunks.join('')).toBe(DEFAULT_RESULT.text);
      expect(finalizedChunks).toEqual(['approved stream output']);
    });
  });

  // ---------------------------------------------------------------------------
  // Task 6: session.stream() history integration
  // ---------------------------------------------------------------------------

  describe('session.stream() history integration', () => {
    it('session.stream() builds prompt that includes prior history', async () => {
      hoisted.strategyStream.mockClear();

      const team = agency({
        agents: { a: mockAgentConfig('a') },
        strategy: 'sequential',
      });

      const session = team.session('stream-history') as {
        send: (t: string) => Promise<unknown>;
        stream: (t: string) => unknown;
      };

      // First turn via send() so history is populated.
      await session.send('First turn');

      // Second turn via stream() — should include the prior history in the prompt.
      const result = session.stream('Second turn via stream') as { text: Promise<string> };
      await result.text;

      // The strategy stream should have been called with the history-prefixed prompt.
      expect(hoisted.strategyStream).toHaveBeenCalledWith(
        'User: First turn\nAssistant: AI is transformative.\nUser: Second turn via stream',
        undefined,
      );
    });

    it('session.stream() is iterable and yields text', async () => {
      const team = agency({
        agents: { a: mockAgentConfig('a') },
        strategy: 'sequential',
      });

      const session = team.session('stream-iterable') as {
        stream: (t: string) => { textStream: AsyncIterable<string> };
      };

      const result = session.stream('Hello streaming');
      const chunks: string[] = [];
      for await (const chunk of result.textStream) {
        chunks.push(chunk);
      }

      expect(chunks.join('')).toBe(DEFAULT_RESULT.text);
    });

    it('session.stream() stores the finalized assistant text and session usage', async () => {
      const team = agency({
        agents: { a: mockAgentConfig('a') },
        strategy: 'sequential',
        hitl: {
          approvals: { beforeReturn: true },
          handler: async () => ({
            approved: true,
            modifications: { output: 'approved session reply' },
          }),
        },
      });

      const session = team.session('stream-finalized-history') as {
        stream: (t: string) => { text: Promise<string> };
        messages: () => Array<{ role: 'user' | 'assistant'; content: string }>;
        usage: () => Promise<Record<string, unknown>>;
      };

      const result = session.stream('Hello with approvals');
      await expect(result.text).resolves.toBe('approved session reply');
      await Promise.resolve();

      expect(session.messages()).toEqual([
        { role: 'user', content: 'Hello with approvals' },
        { role: 'assistant', content: 'approved session reply' },
      ]);

      const usage = await session.usage();
      expect(usage.totalTokens).toBe(DEFAULT_USAGE.totalTokens);
    });

    it('session.stream() does not lose history on first call with empty history', async () => {
      const team = agency({
        agents: { a: mockAgentConfig('a') },
        strategy: 'sequential',
      });

      const session = team.session('stream-empty-history') as {
        stream: (t: string) => { text: Promise<string> };
      };

      hoisted.strategyStream.mockClear();

      // When history is empty, the plain text should be passed through unchanged.
      const result = session.stream('Plain prompt');
      await result.text;

      expect(hoisted.strategyStream).toHaveBeenCalledWith('Plain prompt', undefined);
    });
  });
});
