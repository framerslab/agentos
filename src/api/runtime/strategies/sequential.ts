/**
 * @file sequential.ts
 * Sequential strategy compiler for the Agency API.
 *
 * ## Execution model
 *
 * Iterates agents in declaration order. Each agent receives the previous
 * agent's output as context, forming a chain where the final agent's response
 * is the overall result. Token usage is aggregated across all agent calls.
 *
 * This is the simplest and most common strategy -- ideal for pipelines like
 * `researcher -> editor -> reviewer` where each step builds on the previous.
 *
 * ## HITL integration
 *
 * Each agent is gated by {@link checkBeforeAgent} before invocation. If the
 * HITL handler rejects an agent, it is skipped and the chain continues with
 * the next agent using the same context (the rejected agent's contribution
 * is simply omitted).
 *
 * @see {@link compileStrategy} -- the dispatcher that selects this compiler.
 * @see {@link checkBeforeAgent} -- the HITL gate applied before each agent.
 */
import { agent as createAgent } from '../agent.js';
import type {
  AgencyOptions,
  CompiledStrategy,
  Agent,
  BaseAgentConfig,
  AgentCallRecord,
  AgencyStreamPart,
} from '../types.js';
import type { FallbackSignal } from '../generateText.js';
import { createBufferedAsyncReplay } from '../streamBuffer.js';
import {
  isAgent,
  mergeDefaults,
  checkBeforeAgent,
  accumulateExtraUsage,
  buildAgentCallUsage,
  callRecordExtras,
} from './shared.js';

type StrategyTotalUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUSD?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

/**
 * Compiles a sequential execution strategy.
 *
 * Agents are invoked one-by-one in their declared iteration order. Each agent
 * after the first receives a prompt that includes both the original task and
 * the preceding agent's output, enabling progressive refinement chains such as
 * `researcher -> editor -> reviewer`.
 *
 * @param agents - Named roster of agent configs or pre-built `Agent` instances.
 *                 Iteration order of `Object.entries()` determines execution order.
 * @param agencyConfig - Agency-level configuration providing fallback model/provider/tools.
 * @returns A {@link CompiledStrategy} with `execute` and `stream` methods.
 *
 * @example
 * ```ts
 * const strategy = compileSequential(
 *   { researcher: { instructions: 'Find info.' }, writer: { instructions: 'Write summary.' } },
 *   agencyConfig,
 * );
 * const result = await strategy.execute('Summarise recent AI research.');
 * ```
 */
export function compileSequential(
  agents: Record<string, BaseAgentConfig | Agent>,
  agencyConfig: AgencyOptions,
): CompiledStrategy {
  return {
    async execute(prompt, opts) {
      const agentCalls: AgentCallRecord[] = [];
      let context = prompt;
      let lastResult: Record<string, unknown> | null = null;
      const totalUsage: StrategyTotalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      for (const [name, agentOrConfig] of Object.entries(agents)) {
        // HITL: check beforeAgent gate before invoking this agent.
        // Returns null when no gate applies; returns a decision when the
        // agent is in the approval list.
        const decision = await checkBeforeAgent(name, context, agentCalls, agencyConfig);
        if (decision && !decision.approved) {
          // Agent was rejected by HITL -- skip and continue to the next
          // agent in the chain. The context remains unchanged.
          continue;
        }

        const a: Agent = isAgent(agentOrConfig)
          ? agentOrConfig
          : createAgent({ ...mergeDefaults(agentOrConfig, agencyConfig) });

        // Apply instruction modifications from the approval decision if any.
        // This allows the human reviewer to inject additional guidance into
        // the agent's context without modifying the original prompt.
        const effectiveContext = decision?.modifications?.instructions
          ? `${context}\n\n[Additional instructions]: ${decision.modifications.instructions}`
          : context;

        const start = Date.now();
        const result = (await a.generate(effectiveContext, opts)) as Record<string, unknown>;
        const durationMs = Date.now() - start;

        const resultText = (result.text as string) ?? '';
        const resultUsage = (result.usage as {
          promptTokens?: number;
          completionTokens?: number;
          totalTokens?: number;
          costUSD?: number;
          cacheReadTokens?: number;
          cacheCreationTokens?: number;
        }) ?? {};
        const resultToolCalls = (result.toolCalls as Array<{ name: string; args: unknown; result?: unknown; error?: string }>) ?? [];

        agentCalls.push({
          agent: name,
          input: context,
          output: resultText,
          toolCalls: resultToolCalls,
          usage: buildAgentCallUsage(resultUsage),
          durationMs,
          ...callRecordExtras(result),
        });

        totalUsage.promptTokens += resultUsage.promptTokens ?? 0;
        totalUsage.completionTokens += resultUsage.completionTokens ?? 0;
        totalUsage.totalTokens += resultUsage.totalTokens ?? 0;
        accumulateExtraUsage(totalUsage, resultUsage);

        // Chain: subsequent agents see the original task plus previous output.
        // This ensures each agent has full context without losing the original prompt.
        context = `Original task: ${prompt}\n\nPrevious agent (${name}) output:\n${resultText}`;
        lastResult = result;
      }

      return { ...lastResult, agentCalls, usage: totalUsage };
    },

    stream(prompt, opts) {
      /**
       * Real streaming for the sequential strategy: yields per-agent
       * `agent-start` and `agent-end` events bracketing each agent's text
       * tokens, plus agency-level start/end events wrapping the whole run.
       *
       * `fullStream` emits the full {@link AgencyStreamPart} union so callers
       * can observe every agent transition. `textStream` filters to just the
       * `text` parts so the result stays compatible with `StreamTextResult`.
       *
       * Usage accounting is collected per-agent and summed into a final total.
       * All promises resolve once the generator has been fully consumed.
       */
      const startMs = Date.now();
      const totalUsage: StrategyTotalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      const agentCalls: AgentCallRecord[] = [];

      /**
       * Internal generator that drives the sequential run and yields
       * structured {@link AgencyStreamPart} events.
       */
      async function* streamGenerator(): AsyncGenerator<AgencyStreamPart> {
        let currentPrompt = prompt;
        let finalText = '';

        yield { type: 'agent-start' as const, agent: '__agency__', input: prompt };

        for (const [name, agentOrConfig] of Object.entries(agents)) {
          const decision = await checkBeforeAgent(name, currentPrompt, agentCalls, agencyConfig);
          if (decision && !decision.approved) {
            continue;
          }

          const effectivePrompt = decision?.modifications?.instructions
            ? `${currentPrompt}\n\n[Additional instructions]: ${decision.modifications.instructions}`
            : currentPrompt;
          const agentStart = Date.now();

          yield { type: 'agent-start' as const, agent: name, input: effectivePrompt };

          // Resolve agent instance (pre-built or config-based).
          const a: Agent = isAgent(agentOrConfig)
            ? agentOrConfig
            : createAgent({ ...mergeDefaults(agentOrConfig as BaseAgentConfig, agencyConfig) });

          // Delegate to the agent's stream if available, otherwise use generate().
          let agentText = '';
          let resultUsage: {
            promptTokens?: number;
            completionTokens?: number;
            totalTokens?: number;
            costUSD?: number;
            cacheReadTokens?: number;
            cacheCreationTokens?: number;
          } = {};
          let resultToolCalls: Array<{ name: string; args: unknown; result?: unknown; error?: string }> = [];
          let recordExtras: ReturnType<typeof callRecordExtras>;
          try {
            const agentStream = a.stream(effectivePrompt, opts) as {
              textStream?: AsyncIterable<string>;
              text?: Promise<string>;
              usage?: Promise<{
                promptTokens?: number;
                completionTokens?: number;
                totalTokens?: number;
                costUSD?: number;
                cacheReadTokens?: number;
                cacheCreationTokens?: number;
              }>;
              toolCalls?: Promise<Array<{ name: string; args: unknown; result?: unknown; error?: string }>>;
              provider?: Promise<string>;
              model?: Promise<string>;
              finishReason?: Promise<string>;
              fallback?: Promise<FallbackSignal | undefined>;
            } | null;

            if (agentStream?.textStream) {
              for await (const chunk of agentStream.textStream) {
                yield { type: 'text' as const, text: chunk, agent: name };
                agentText += chunk;
              }
              // If textStream didn't give us the full text, resolve the promise.
              if (!agentText && agentStream.text) {
                agentText = await agentStream.text;
                if (agentText) {
                  yield { type: 'text' as const, text: agentText, agent: name };
                }
              }
              resultUsage = (await Promise.resolve(agentStream.usage)) ?? {};
              resultToolCalls = (await Promise.resolve(agentStream.toolCalls)) ?? [];
              // Who answered: the leg that served when the seat's chain fired.
              const [streamProvider, streamModel, streamFinish, streamFallback] = await Promise.all([
                Promise.resolve(agentStream.provider),
                Promise.resolve(agentStream.model),
                Promise.resolve(agentStream.finishReason),
                Promise.resolve(agentStream.fallback),
              ]);
              recordExtras = callRecordExtras({
                provider: streamFallback?.finalProvider ?? streamProvider,
                model: streamFallback?.finalModel ?? streamModel,
                finishReason: streamFinish,
                fallback: streamFallback,
              });
            } else {
              // Fallback: non-streaming generate() call.
              const result = (await a.generate(effectivePrompt, opts)) as Record<string, unknown>;
              agentText = (result.text as string) ?? '';
              if (agentText) {
                yield { type: 'text' as const, text: agentText, agent: name };
              }
              resultUsage = (result.usage as typeof resultUsage) ?? {};
              resultToolCalls = (result.toolCalls as Array<{ name: string; args: unknown; result?: unknown; error?: string }>) ?? [];
              recordExtras = callRecordExtras(result);
            }

            agentCalls.push({
              agent: name,
              input: currentPrompt,
              output: agentText,
              toolCalls: resultToolCalls,
              usage: buildAgentCallUsage(resultUsage),
              durationMs: Date.now() - agentStart,
              ...recordExtras,
            });

            totalUsage.promptTokens += resultUsage.promptTokens ?? 0;
            totalUsage.completionTokens += resultUsage.completionTokens ?? 0;
            totalUsage.totalTokens += resultUsage.totalTokens ?? 0;
            accumulateExtraUsage(totalUsage, resultUsage);
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            yield { type: 'error' as const, error, agent: name };
          }

          const durationMs = Date.now() - agentStart;
          yield { type: 'agent-end' as const, agent: name, output: agentText, durationMs };

          finalText = agentText;
          currentPrompt = `Original task: ${prompt}\n\nPrevious agent (${name}) output:\n${agentText}`;
        }

        const totalDurationMs = Date.now() - startMs;
        yield {
          type: 'agent-end' as const,
          agent: '__agency__',
          output: finalText,
          durationMs: totalDurationMs,
        };
      }

      /**
       * Because an `AsyncGenerator` can only be iterated once, we materialise
       * a single generator and share it between `fullStream`, `textStream`,
       * `text`, and `usage` by buffering all events.
       */
      const replay = createBufferedAsyncReplay(streamGenerator());

      /** Resolves with the concatenated final text. */
      const textPromise: Promise<string> = replay.ensureDraining().then(() =>
        replay
          .getBuffered()
          .filter((p): p is { type: 'text'; text: string; agent?: string } => p.type === 'text')
          .map((p) => p.text)
          .join(''),
      );

      const usagePromise: Promise<StrategyTotalUsage> =
        replay.ensureDraining().then(() => ({ ...totalUsage }));

      const agentCallsPromise: Promise<AgentCallRecord[]> =
        replay.ensureDraining().then(() => [...agentCalls]);

      return {
        textStream: (async function* () {
          for await (const part of replay.iterable) {
            if (part.type === 'text') {
              yield part.text;
            }
          }
        })(),
        fullStream: replay.iterable,
        text: textPromise,
        usage: usagePromise,
        agentCalls: agentCallsPromise,
        toolCalls: Promise.resolve([]),
      };
    },
  };
}
