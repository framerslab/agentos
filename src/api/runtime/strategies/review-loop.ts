/**
 * @file review-loop.ts
 * Review-loop strategy compiler for the Agency API.
 *
 * ## Execution model
 *
 * The first agent (producer) creates or revises work, the second agent
 * (reviewer) evaluates it. The loop continues until the reviewer approves
 * or `maxRounds` is exhausted. Additional agents beyond the first two are
 * reserved for future specialist injection.
 *
 * ## Reviewer response format
 *
 * The reviewer is instructed to respond with JSON:
 * ```json
 * { "approved": true, "feedback": "Looks great!" }
 * ```
 * When the response is not valid JSON or lacks an `approved` boolean, the
 * entire text is treated as rejection feedback and the producer is asked
 * to revise. This graceful fallback ensures the loop always makes progress
 * even when the reviewer doesn't follow the format precisely.
 *
 * ## HITL integration
 *
 * The producer and the reviewer are each gated by {@link checkBeforeAgentInput}
 * over the input they receive: the producer's carries its previous draft and
 * the reviewer's feedback, the reviewer's carries the draft. The post-approval
 * check also reads the task, the draft and the feedback each on its own. Each
 * agent is sent the input the check read. A refused producer ends the loop
 * with the draft it already has; a refused reviewer leaves the current draft
 * as the result.
 *
 * @see {@link compileStrategy} -- the dispatcher that selects this compiler.
 * @see {@link compileDebate} -- an alternative iterative strategy for adversarial discourse.
 */
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
  checkBeforeAgentInput,
  accumulateExtraUsage,
  buildAgentCallUsage,
  callRecordExtras,
  nestedRunUnanswered,
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
 * Attempts to parse a reviewer response as JSON with an `approved` field.
 *
 * The reviewer is instructed to respond with `{ "approved": true/false, "feedback": "..." }`.
 * When the response is not valid JSON, or lacks an `approved` boolean, the entire
 * text is treated as feedback and the draft is considered not approved.
 *
 * ## Why parse gracefully?
 *
 * LLMs frequently wrap JSON in markdown code fences or add prose around it.
 * By falling back to "not approved with full text as feedback", we ensure the
 * loop always makes progress instead of crashing on malformed JSON.
 *
 * @param text - Raw reviewer output text.
 * @returns Parsed review with approval status and feedback string.
 */
function parseReview(text: string): { approved: boolean; feedback: string } {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.approved === 'boolean') {
      return {
        approved: parsed.approved,
        feedback: (parsed.feedback as string) ?? text,
      };
    }
  } catch {
    // Not valid JSON -- fall through to treat entire text as feedback.
  }
  return { approved: false, feedback: text };
}

/**
 * Compiles a review-loop execution strategy.
 *
 * The first declared agent acts as the producer, the second as the reviewer.
 * The producer generates or revises a draft, then the reviewer evaluates it.
 * If the reviewer approves (responds with `{ "approved": true }`), the loop
 * terminates early. Otherwise the reviewer's feedback is fed back into the
 * producer for revision, up to `maxRounds` iterations.
 *
 * @param agents - Named roster of agent configs or pre-built `Agent` instances.
 *   At least two agents are required (producer + reviewer). The first entry
 *   is the producer, the second is the reviewer.
 * @param agencyConfig - Agency-level configuration providing fallback model/provider/tools.
 * @returns A {@link CompiledStrategy} with `execute` and `stream` methods.
 * @throws {AgencyConfigError} When fewer than two agents are provided.
 *
 * @example
 * ```ts
 * const strategy = compileReviewLoop(
 *   {
 *     writer: { instructions: 'Write a blog post.' },
 *     editor: { instructions: 'Review for clarity and accuracy.' },
 *   },
 *   { maxRounds: 3, agents: { ... } },
 * );
 * const result = await strategy.execute('Write about TypeScript generics.');
 * // result.text is the final approved draft.
 * ```
 */
export function compileReviewLoop(
  agents: Record<string, BaseAgentConfig | Agent>,
  agencyConfig: AgencyOptions,
): CompiledStrategy {
  const entries = Object.entries(agents);
  if (entries.length < 2) {
    throw new AgencyConfigError(
      'Review-loop strategy requires at least two agents (producer + reviewer).',
    );
  }

  // Default to 3 rounds when not specified -- enough for meaningful revision
  // without excessive back-and-forth.
  const maxRounds = agencyConfig.maxRounds ?? 3;
  const [producerName, producerConfig] = entries[0];
  const [reviewerName, reviewerConfig] = entries[1];

  return {
    async execute(prompt, opts) {
      const agentCalls: AgentCallRecord[] = [];
      const totalUsage: StrategyTotalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      const producer = resolveAgent(producerConfig, agencyConfig);
      const reviewer = resolveAgent(reviewerConfig, agencyConfig);

      let draft = '';
      let feedback = '';

      for (let round = 0; round < maxRounds; round++) {
        // ---- Producer creates or revises ----
        // On the first round, the producer sees the original task.
        // On subsequent rounds, it sees the task + its prior draft + reviewer feedback.
        const prodPrompt =
          round === 0
            ? prompt
            : `${prompt}\n\nYour previous draft:\n${draft}\n\nReviewer feedback:\n${feedback}\n\nRevise your work.`;

        // ---- HITL: check beforeAgent gate for the producer ----
        // The gate reads the producer's input, the reviewer's feedback
        // included, and the task, the draft and the feedback each on its
        // own, since the input puts more text after each of them. The
        // producer is sent the input the check read.
        const prodGate = await checkBeforeAgentInput(producerName, prodPrompt, agentCalls, agencyConfig, [
          prompt,
          draft,
          feedback,
        ]);
        if (prodGate.decision && !prodGate.decision.approved) {
          // Producer rejected -- terminate the loop early.
          // The current draft (empty or from a prior round) becomes the final output.
          break;
        }

        const prodStart = Date.now();
        const prodResult = (await producer.generate(prodGate.input, opts)) as Record<string, unknown>;
        const prodDuration = Date.now() - prodStart;
        // A nested agency that no seat of its own answered wrote no draft, as
        // a rejected producer writes none: the loop ends on the current draft,
        // and no reviewer is sent an empty one.
        if (nestedRunUnanswered(prodResult)) break;

        const prodText = (prodResult.text as string) ?? '';
        const prodUsage = (prodResult.usage as ResultUsageSnapshot) ?? {};
        const prodToolCalls = (prodResult.toolCalls as Array<{ name: string; args: unknown; result?: unknown; error?: string }>) ?? [];

        draft = prodText;

        // Each record holds the input its agent was sent, the approver's instructions included.
        agentCalls.push({
          agent: producerName,
          input: prodGate.input,
          output: prodText,
          toolCalls: prodToolCalls,
          usage: buildAgentCallUsage(prodUsage),
          durationMs: prodDuration,
          ...callRecordExtras(prodResult),
        });

        totalUsage.promptTokens += prodUsage.promptTokens ?? 0;
        totalUsage.completionTokens += prodUsage.completionTokens ?? 0;
        totalUsage.totalTokens += prodUsage.totalTokens ?? 0;
        accumulateExtraUsage(totalUsage, prodUsage);

        // ---- Reviewer evaluates ----
        const revPrompt =
          `Review this work for the task: "${prompt}"\n\n` +
          `Draft:\n${draft}\n\n` +
          `Respond with JSON: { "approved": true/false, "feedback": "..." }`;

        // ---- HITL: check beforeAgent gate for the reviewer ----
        // The gate reads the reviewer's input, the draft included, and the
        // task and the draft each on its own. The reviewer is sent the input
        // the check read.
        const revGate = await checkBeforeAgentInput(reviewerName, revPrompt, agentCalls, agencyConfig, [
          prompt,
          draft,
        ]);
        if (revGate.decision && !revGate.decision.approved) {
          // Reviewer rejected -- accept the current draft and break.
          break;
        }

        const revStart = Date.now();
        const revResult = (await reviewer.generate(revGate.input, opts)) as Record<string, unknown>;
        const revDuration = Date.now() - revStart;
        // A nested agency that no seat of its own answered gave no review, as a
        // rejected reviewer gives none: the current draft stands.
        if (nestedRunUnanswered(revResult)) break;

        const revText = (revResult.text as string) ?? '';
        const revUsage = (revResult.usage as ResultUsageSnapshot) ?? {};
        const revToolCalls = (revResult.toolCalls as Array<{ name: string; args: unknown; result?: unknown; error?: string }>) ?? [];

        agentCalls.push({
          agent: reviewerName,
          input: revGate.input,
          output: revText,
          toolCalls: revToolCalls,
          usage: buildAgentCallUsage(revUsage),
          durationMs: revDuration,
          ...callRecordExtras(revResult),
        });

        totalUsage.promptTokens += revUsage.promptTokens ?? 0;
        totalUsage.completionTokens += revUsage.completionTokens ?? 0;
        totalUsage.totalTokens += revUsage.totalTokens ?? 0;
        accumulateExtraUsage(totalUsage, revUsage);

        // Parse the review decision. If approved, exit the loop early.
        // If not, capture feedback for the next producer revision.
        const review = parseReview(revText);
        if (review.approved) break;
        feedback = review.feedback;
      }

      return { text: draft, agentCalls, usage: totalUsage };
    },

    stream(prompt, opts) {
      /**
       * For v1: streaming delegates to execute() and wraps the resolved text
       * as a single-chunk async iterable. A future version will stream the
       * producer's output in real-time during the final round.
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
