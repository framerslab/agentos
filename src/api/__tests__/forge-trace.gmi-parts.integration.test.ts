/**
 * @fileoverview What a host streams for a forge_tool call through
 * agent({ runtime: 'gmi' }): the `tool-result` part of a session's full stream,
 * pinned as commit fd17f220 wrote it, so a trace on a forge's result changes
 * none of it. The GMI, its tool orchestrator and the provider manager are the
 * real ones; only the provider classes are stubbed (helpers/stubProviders.ts),
 * and forge_tool runs on a real engine over a real tool executor, with a
 * scripted judge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async () => ({ AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic') }));
import { agent, type AgentOptions } from '../agent';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import {
  PINS,
  PIN_OUTCOMES,
  failNextRegistration,
  pinArgs,
  pinJudgeReply,
} from '../../cognition/emergent/__tests__/fixtures/forge-trace-pins.js';
import { directEngine, freezeClock } from '../../cognition/emergent/__tests__/helpers/forge-trace-harness.js';

/** The names only a trace carries: none may reach what a host streams. */
const TRACE_NAMES = ['traceVersion', 'forgeId', 'provenanceVersion'];

/** A part of a session's full stream, as far as the pin reads it. */
type Part = { type: string; [key: string]: unknown };

let n = 0;
const key = () => `k-forge-trace-${++n}`;
/** An agent on the GMI runtime; named, so its persona's id is the stable `forger`. */
const forger = (apiKey: string, extra: Record<string, unknown> = {}) =>
  ({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey, fallbackProviders: [], name: 'Forger', ...extra }) as unknown as AgentOptions;

describe("forge trace: what gmi() streams for forge_tool is unchanged", () => {
  let releaseClock: () => void = () => undefined;

  beforeEach(() => {
    globalLLMProviderHealth.reset();
    releaseClock = freezeClock();
  });

  afterEach(() => {
    releaseClock();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(PIN_OUTCOMES)("pin 2: gmi()'s tool-result part is unchanged (%s)", async (outcome) => {
    const k = key();
    script('openai', k, {
      replies: [reply.tools([{ id: 'call_forge', name: 'forge_tool', args: pinArgs(outcome) }]), reply.text('Done.')],
    });
    const { forgeTool } = await directEngine({ judgeReplies: [pinJudgeReply(outcome)] });
    if (outcome === 'thrown') {
      failNextRegistration();
    }
    const a = agent(forger(k, { tools: { forge_tool: forgeTool } }));

    try {
      const r = a.session('s').stream('Forge it.');
      const parts: Part[] = [];
      for await (const p of r.fullStream) {
        parts.push(p as unknown as Part);
      }

      const resultParts = parts.filter((part) => part.type === 'tool-result');
      expect(resultParts).toHaveLength(1);
      expect(resultParts[0].toolName).toBe('forge_tool');
      expect(resultParts[0].result).toEqual(PINS.gmiPart[outcome]);
      const json = JSON.stringify(resultParts[0].result);
      for (const name of TRACE_NAMES) {
        expect(json).not.toContain(name);
      }
      expect(await r.text).toBe('Done.');
    } finally {
      await a.close();
    }
  });
});
