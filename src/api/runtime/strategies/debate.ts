/**
 * @file debate.ts
 * Debate strategy compiler for the Agency API.
 *
 * ## Execution model
 *
 * Agents argue in rounds over a shared task. Each round, every agent sees all
 * prior arguments from every other agent, enabling progressive refinement
 * through adversarial discourse. After all rounds complete, a synthesizer
 * distils the collected arguments into a single coherent response.
 *
 * ## Why debate?
 *
 * Debate is effective for tasks where multiple perspectives lead to better
 * outcomes: ethical reasoning, policy analysis, creative brainstorming,
 * risk assessment. Each agent is forced to defend its position while
 * considering others, reducing blind spots.
 *
 * ## Round structure
 *
 * For `N` agents and `R` rounds, the total agent calls are `N * R` plus one
 * synthesis call. In each round, agents are called in declaration order.
 * Each agent receives the full argument history from all prior agents/rounds.
 *
 * @see {@link compileStrategy} -- the dispatcher that selects this compiler.
 * @see {@link compileReviewLoop} -- an alternative iterative strategy with explicit approval.
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
  resolveAgent,
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

type ResultUsageSnapshot = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUSD?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

/**
 * Compiles a debate execution strategy.
 *
 * Agents are iterated in rounds. During each round, every agent receives the
 * original task plus all previously collected arguments, and contributes its
 * own perspective. After `maxRounds` complete, a synthesizer agent (using the
 * agency-level model) distils all arguments into a final answer.
 *
 * @param agents - Named roster of agent configs or pre-built `Agent` instances.
 * @param agencyConfig - Agency-level configuration providing fallback model/provider/tools.
 *   Must include `model` or `provider` for the synthesis step.
 * @returns A {@link CompiledStrategy} with `execute` and `stream` methods.
 * @throws {AgencyConfigError} When no agency-level model/provider is available
 *   for the synthesis step.
 *
 * @example
 * ```ts
 * const strategy = compileDebate(
 *   { optimist: { instructions: 'Argue the positive case.' }, pessimist: { instructions: 'Argue the risks.' } },
 *   { model: 'openai:gpt-4o', maxRounds: 2, agents: { ... } },
 * );
 * const result = await strategy.execute('Should we adopt this new technology?');
 * ```
 */
export function compileDebate(
  agents: Record<string, BaseAgentConfig | Agent>,
  agencyConfig: AgencyOptions,
): CompiledStrategy {
  if (!agencyConfig.model && !agencyConfig.provider) {
    throw new AgencyConfigError(
      'Debate strategy requires an agency-level model or provider for result synthesis.',
    );
  }

  // Default to 3 rounds when not specified -- enough for meaningful discourse
  // without excessive token consumption.
  const maxRounds = agencyConfig.maxRounds ?? 3;

  return {
    async execute(prompt, opts) {
      const agentCalls: AgentCallRecord[] = [];
      const entries = Object.entries(agents);
      const totalUsage: StrategyTotalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      const collectedArguments: string[] = [];

      for (let round = 0; round < maxRounds; round++) {
        for (const [name, agentOrConfig] of entries) {
          // HITL: check beforeAgent gate before invoking this agent.
          const decision = await checkBeforeAgent(name, prompt, agentCalls, agencyConfig);
          if (decision && !decision.approved) {
            // Agent was rejected -- skip this agent in this round.
            continue;
          }

          const a = resolveAgent(agentOrConfig, agencyConfig);

          // Build the debate context: original task + transcript of prior
          // arguments. The framing is intentionally adversarial — agents are
          // told to take a side and rebut, not to "present a perspective" or
          // produce a balanced summary. The synthesis step is what unifies
          // the back-and-forth; the per-agent turns must stay sharp.
          const isOpening = collectedArguments.length === 0;
          const turnLabel = `Round ${round + 1} of ${maxRounds}`;
          const debateContext = isOpening
            ? [
                `Debate motion: ${prompt}`,
                ``,
                `You are "${name}". This is the OPENING statement (${turnLabel}).`,
                `Take a clear, defensible side on the motion above. Do NOT hedge,`,
                `do NOT produce a balanced summary, and do NOT acknowledge counterpoints`,
                `that have not yet been raised. State your position in one sentence,`,
                `then back it with your strongest 2–4 reasons. Speak in the first person.`,
              ].join('\n')
            : [
                `Debate motion: ${prompt}`,
                ``,
                `Transcript of arguments so far:`,
                collectedArguments.join('\n---\n'),
                ``,
                `You are "${name}" (${turnLabel}). This is a REBUTTAL turn.`,
                `1. Quote or paraphrase the SINGLE strongest opposing claim made above.`,
                `2. Attack it directly — name the flaw, the missing evidence, or the`,
                `   counter-example. Be specific; do not restate generalities.`,
                `3. Advance ONE new point of your own that the other side has not`,
                `   addressed. Do not repeat earlier rounds.`,
                `Stay in character as "${name}". Speak in the first person. Be terse:`,
                `at most ~150 words. Do not produce a neutral summary.`,
              ].join('\n');

          const start = Date.now();
          const result = (await a.generate(debateContext, opts)) as Record<string, unknown>;
          const durationMs = Date.now() - start;

          const resultText = (result.text as string) ?? '';
          const resultUsage = (result.usage as ResultUsageSnapshot) ?? {};
          const resultToolCalls = (result.toolCalls as Array<{ name: string; args: unknown; result?: unknown; error?: string }>) ?? [];

          // Label each argument with the agent name and round for traceability
          // in the synthesis prompt.
          collectedArguments.push(`[${name}, round ${round + 1}]: ${resultText}`);

          agentCalls.push({
            agent: name,
            input: debateContext,
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
        }
      }

      // Synthesize all arguments into a JUDGE'S VERDICT, not a balanced
      // essay. The synthesis is framed as adjudication: render a verdict,
      // explain which side carried the debate, and quote the decisive
      // arguments. Caller-supplied `instructions` are appended verbatim so
      // they can override or extend the verdict format.
      const synthInstructions = agencyConfig.instructions
        ? `\n\nAdditional instructions from the operator:\n${agencyConfig.instructions}`
        : '';

      const synthPrompt = [
        `You are the JUDGE of the following debate.`,
        ``,
        `Motion:`,
        prompt,
        ``,
        `Full transcript of the debate (each entry is one turn by one agent):`,
        collectedArguments.join('\n---\n'),
        ``,
        `Render a verdict using exactly this structure:`,
        ``,
        `**Verdict:** <one sentence: which side prevailed, or "split" if neither did>`,
        `**Why:** <2–4 sentences explaining which arguments were decisive and why>`,
        `**Strongest point for each side:**`,
        `- <agent name>: "<short quote or paraphrase of their best argument>"`,
        `- <agent name>: "<short quote or paraphrase of their best argument>"`,
        `**What was conceded or left unanswered:** <1–2 sentences>`,
        ``,
        `Do NOT produce a balanced essay or "on the other hand" summary.`,
        `Do NOT introduce new arguments the agents did not make.`,
        `Be direct. Pick a winner unless the transcript is genuinely tied.${synthInstructions}`,
      ].join('\n');

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
