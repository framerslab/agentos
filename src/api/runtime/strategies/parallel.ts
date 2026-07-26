/**
 * @file parallel.ts
 * Parallel strategy compiler for the Agency API.
 *
 * ## Execution model
 *
 * Runs all agents concurrently on the same prompt via `Promise.allSettled`,
 * then synthesizes their outputs into a single coherent response using the
 * agency-level model. Requires an agency-level `model` or `provider` for
 * the synthesis step.
 *
 * ## Error handling
 *
 * Individual agent failures do not abort the entire run. `Promise.allSettled`
 * collects both fulfilled and rejected outcomes. Rejected agents emit an
 * `error` callback event and are excluded from the synthesis prompt, so the
 * remaining agents' outputs still produce a valid result.
 *
 * ## HITL integration
 *
 * Each agent is gated by {@link checkBeforeAgent} before invocation. Rejected
 * agents return `null` and are filtered out before synthesis.
 *
 * @see {@link compileStrategy} -- the dispatcher that selects this compiler.
 * @see {@link compileSequential} -- the simpler alternative for ordered pipelines.
 */
import { agent as createAgent } from '../agent.js';
import type {
  AgencyOptions,
  CompiledStrategy,
  Agent,
  BaseAgentConfig,
  AgentCallRecord,
} from '../types.js';
import { AgencyConfigError } from '../types.js';
import {
  isAgent,
  mergeDefaults,
  checkBeforeAgent,
  accumulateExtraUsage,
  buildAgentCallUsage,
  enforceQuorum,
} from './shared.js';

type StrategyTotalUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUSD?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

type ResultUsageSnapshot = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUSD?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

/**
 * Compiles a parallel execution strategy.
 *
 * All agents are invoked concurrently with the same prompt via
 * `Promise.allSettled`. Once every agent has responded (or failed), a
 * synthesis agent (instantiated from the agency-level config) combines the
 * individual outputs into a single coherent response.
 *
 * @param agents - Named roster of agent configs or pre-built `Agent` instances.
 * @param agencyConfig - Agency-level configuration; must include `model` or `provider`
 *   for the synthesis step.
 * @returns A {@link CompiledStrategy} with `execute` and `stream` methods.
 * @throws {AgencyConfigError} When no agency-level model/provider is available
 *   for the synthesis step. The synthesis agent needs an LLM to combine the
 *   parallel outputs.
 *
 * @example
 * ```ts
 * const strategy = compileParallel(
 *   { factChecker: factAgent, writer: writeAgent },
 *   { model: 'openai:gpt-4o', agents: { factChecker: factAgent, writer: writeAgent } },
 * );
 * const result = await strategy.execute('Write a fact-checked article.');
 * ```
 */
export function compileParallel(
  agents: Record<string, BaseAgentConfig | Agent>,
  agencyConfig: AgencyOptions,
): CompiledStrategy {
  if (!agencyConfig.model && !agencyConfig.provider) {
    throw new AgencyConfigError(
      'Parallel strategy requires an agency-level model or provider for result synthesis.',
    );
  }

  return {
    async execute(prompt, opts) {
      // Run every agent concurrently, gated by beforeAgent HITL.
      // Promise.allSettled is used (not Promise.all) so that individual
      // agent failures don't abort the entire parallel run.
      const entries = Object.entries(agents);
      const allSettled = await Promise.allSettled(
        entries.map(async ([name, agentOrConfig]) => {
          // HITL: check beforeAgent gate before invoking this agent.
          const decision = await checkBeforeAgent(name, prompt, [], agencyConfig);
          if (decision && !decision.approved) {
            // Agent was rejected -- exclude from results.
            return null;
          }

          const a: Agent = isAgent(agentOrConfig)
            ? agentOrConfig
            : createAgent({ ...mergeDefaults(agentOrConfig, agencyConfig) });

          // Apply instruction modifications from the approval decision if any.
          const effectivePrompt = decision?.modifications?.instructions
            ? `${prompt}\n\n[Additional instructions]: ${decision.modifications.instructions}`
            : prompt;

          const start = Date.now();
          const result = (await a.generate(effectivePrompt, opts)) as Record<string, unknown>;
          const durationMs = Date.now() - start;
          return { name, result, durationMs };
        }),
      );

      // Log errors from rejected agents and keep only fulfilled results.
      // This two-pass approach lets us collect error telemetry while still
      // producing a valid synthesis from the successful agents.
      const settled: Array<{ name: string; result: Record<string, unknown>; durationMs: number }> = [];
      for (let i = 0; i < allSettled.length; i++) {
        const outcome = allSettled[i];
        if (outcome.status === 'rejected') {
          const agentName = entries[i][0];
          const error = outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason));
          console.error(`[AgentOS][Parallel] Agent "${agentName}" failed:`, error.message);
          agencyConfig.on?.error?.({
            agent: agentName,
            error,
            timestamp: Date.now(),
          });
          continue;
        }
        // Skip null results (HITL-rejected agents).
        if (outcome.value !== null) {
          settled.push(outcome.value);
        }
      }

      // Quorum enforcement (optional): a panel that lost too many seats — or
      // collapsed to a single provider — must not synthesize a false
      // consensus. Throws AgencyQuorumError before any synthesis spend.
      enforceQuorum(agencyConfig.quorum, settled, entries.length);

      // Collect agent call records and aggregate usage.
      const agentCalls: AgentCallRecord[] = [];
      const totalUsage: StrategyTotalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      for (const { name, result, durationMs } of settled) {
        const resultUsage = (result.usage as ResultUsageSnapshot) ?? {};
        const resultToolCalls = (result.toolCalls as Array<{ name: string; args: unknown; result?: unknown; error?: string }>) ?? [];

        agentCalls.push({
          agent: name,
          input: prompt,
          output: (result.text as string) ?? '',
          toolCalls: resultToolCalls,
          usage: buildAgentCallUsage(resultUsage),
          durationMs,
        });

        totalUsage.promptTokens += resultUsage.promptTokens ?? 0;
        totalUsage.completionTokens += resultUsage.completionTokens ?? 0;
        totalUsage.totalTokens += resultUsage.totalTokens ?? 0;
        accumulateExtraUsage(totalUsage, resultUsage);
      }

      // Synthesize outputs using the agency-level model.
      // Each agent's output is labeled with its name so the synthesizer
      // knows which perspective came from which agent.
      const agentOutputsBlock = settled
        .map(({ name, result }) => `--- ${name} ---\n${(result.text as string) ?? ''}`)
        .join('\n\n');

      const synthInstructions = agencyConfig.instructions
        ? `\n\n${agencyConfig.instructions}`
        : '';

      const synthPrompt =
        `Multiple agents analyzed the following task:\n"${prompt}"\n\n` +
        `${agentOutputsBlock}\n\n` +
        `Synthesize these into a single coherent response.${synthInstructions}`;

      // Create a fresh single-step synthesizer agent. maxSteps: 1 because
      // the synthesis should be a single LLM call, not an agentic loop.
      const synthesizer = createAgent({
        model: agencyConfig.model,
        provider: agencyConfig.provider,
        apiKey: agencyConfig.apiKey,
        baseUrl: agencyConfig.baseUrl,
        maxSteps: 1,
      });

      const synthesis = (await synthesizer.generate(synthPrompt, opts)) as unknown as Record<string, unknown>;
      const synthUsage = (synthesis.usage as ResultUsageSnapshot) ?? {};

      totalUsage.promptTokens += synthUsage.promptTokens ?? 0;
      totalUsage.completionTokens += synthUsage.completionTokens ?? 0;
      totalUsage.totalTokens += synthUsage.totalTokens ?? 0;
      accumulateExtraUsage(totalUsage, synthUsage);

      return { ...synthesis, agentCalls, usage: totalUsage };
    },

    stream(prompt, opts) {
      /**
       * For v1: streaming delegates to execute() and wraps the resolved text
       * as a single-chunk async iterable. A future version will stream the
       * synthesis step in real-time.
       */
      const resultPromise = this.execute(prompt, opts) as Promise<Record<string, unknown>>;
      const textPromise = resultPromise.then((r) => (r.text as string) ?? '');

      return {
        textStream: (async function* () {
          yield await textPromise;
        })(),
        fullStream: (async function* () {
          const text = await textPromise;
          yield { type: 'text' as const, text };
        })(),
        text: textPromise,
        usage: resultPromise.then((r) => r.usage as StrategyTotalUsage),
        agentCalls: resultPromise.then((r) => (r.agentCalls as AgentCallRecord[] | undefined) ?? []),
      };
    },
  };
}
