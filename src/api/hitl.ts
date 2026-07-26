/**
 * @file hitl.ts
 * Human-in-the-loop (HITL) approval handler factories for the AgentOS API.
 *
 * The `hitl` object provides a set of composable handler factories that conform
 * to the `HitlHandler` function signature expected by `HitlConfig.handler`.
 * Handlers are async functions that receive an {@link ApprovalRequest} and must
 * resolve to an {@link ApprovalDecision}.
 *
 * @example
 * ```ts
 * import { agency, hitl } from '@framers/agentos';
 *
 * // Auto-approve everything (useful in tests and CI environments)
 * const testAgency = agency({
 *   agents: { worker: { provider: 'openai', model: 'gpt-5.5' } },
 *   hitl: {
 *     approvals: { beforeTool: ['delete-file'] },
 *     handler: hitl.autoApprove(),
 *   },
 * });
 *
 * // Interactive CLI approval for local development
 * const devAgency = agency({
 *   agents: { worker: { provider: 'openai', model: 'gpt-4o' } },
 *   hitl: {
 *     approvals: { beforeTool: ['delete-file'], beforeReturn: true },
 *     handler: hitl.cli(),
 *   },
 * });
 * ```
 */

import type { ApprovalRequest, ApprovalDecision } from './types.js';
import type { GenerateTextResult } from './generateText.js';
import { resolveJudgeLlm } from '../core/llm/providers/judge-config.js';
import type { EffortLevel } from '../core/llm/providers/model-effort.js';

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

/**
 * An async function that receives an {@link ApprovalRequest} and resolves to
 * an {@link ApprovalDecision}.  Assign to `HitlConfig.handler`.
 */
export type HitlHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

// ---------------------------------------------------------------------------
// Handler factory namespace
// ---------------------------------------------------------------------------

/**
 * A collection of factory functions that produce {@link HitlHandler} instances
 * for common approval patterns.
 *
 * All handlers are composable: you can wrap any factory result in your own
 * function to add logging, fallback logic, or conditional routing.
 */
export const hitl = {
  // ---------------------------------------------------------------------------
  // autoApprove
  // ---------------------------------------------------------------------------

  /**
   * Returns a handler that approves every request immediately without any
   * human interaction.
   *
   * Intended for use in automated tests and CI pipelines where human review
   * is not required.
   *
   * @returns A {@link HitlHandler} that always resolves `{ approved: true }`.
   *
   * @example
   * ```ts
   * handler: hitl.autoApprove()
   * ```
   */
  autoApprove(): HitlHandler {
    return async (): Promise<ApprovalDecision> => ({ approved: true });
  },

  // ---------------------------------------------------------------------------
  // autoReject
  // ---------------------------------------------------------------------------

  /**
   * Returns a handler that rejects every request immediately without any
   * human interaction.
   *
   * Useful for dry-run or read-only execution modes where you want to confirm
   * which actions would have been triggered without actually permitting any.
   *
   * @param reason - Optional human-readable rejection reason appended to the
   *   decision.  Defaults to `"Auto-rejected"`.
   * @returns A {@link HitlHandler} that always resolves `{ approved: false, reason }`.
   *
   * @example
   * ```ts
   * handler: hitl.autoReject('dry-run mode — no side effects permitted')
   * ```
   */
  autoReject(reason?: string): HitlHandler {
    return async (): Promise<ApprovalDecision> => ({
      approved: false,
      reason: reason ?? 'Auto-rejected',
    });
  },

  // ---------------------------------------------------------------------------
  // cli
  // ---------------------------------------------------------------------------

  /**
   * Returns a handler that pauses execution and prompts the user interactively
   * via `stdin`/`stdout`.
   *
   * Displays the approval request summary (description, agent, action, type)
   * and waits for the user to type `y` (approve) or `n` (reject).
   *
   * **Important**: This handler reads from `process.stdin`, so it must only be
   * used in interactive terminal environments (not in CI/CD pipelines or
   * serverless functions).
   *
   * @returns A {@link HitlHandler} that waits for interactive CLI input.
   *
   * @example
   * ```ts
   * handler: hitl.cli()
   * ```
   */
  cli(): HitlHandler {
    return async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      const readline = await import('node:readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      return new Promise<ApprovalDecision>((resolve) => {
        console.log(`\n[APPROVAL NEEDED] ${request.description}`);
        console.log(`Agent: ${request.agent} | Action: ${request.action}`);
        console.log(`Type: ${request.type}`);
        rl.question('Approve? (y/n): ', (answer) => {
          rl.close();
          resolve({ approved: answer.toLowerCase().startsWith('y') });
        });
      });
    };
  },

  // ---------------------------------------------------------------------------
  // webhook
  // ---------------------------------------------------------------------------

  /**
   * Returns a handler that POSTs the {@link ApprovalRequest} as JSON to the
   * provided URL and expects the server to respond with an {@link ApprovalDecision}.
   *
   * The server must respond with `Content-Type: application/json` containing an
   * object with at least an `approved: boolean` field.  Non-2xx responses are
   * treated as a rejection with the HTTP status code as the reason.
   *
   * @param url - The full URL to POST approval requests to.
   * @returns A {@link HitlHandler} that delegates decisions to an HTTP endpoint.
   *
   * @example
   * ```ts
   * handler: hitl.webhook('https://my-approval-service.example.com/approve')
   * ```
   */
  webhook(url: string): HitlHandler {
    return async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      if (!resp.ok) {
        return { approved: false, reason: `Webhook returned ${resp.status}` };
      }

      return (await resp.json()) as ApprovalDecision;
    };
  },

  // ---------------------------------------------------------------------------
  // slack
  // ---------------------------------------------------------------------------

  /**
   * Returns a handler that posts a notification to a Slack channel when an
   * approval is requested.
   *
   * **v1 behaviour**: The message is sent to the configured Slack channel, then
   * the handler immediately auto-approves.  A future version will poll for
   * emoji reactions (`:white_check_mark:` / `:x:`) on the posted message before
   * resolving.
   *
   * @param opts.channel - Slack channel ID or name (e.g. `"#approvals"` or
   *   `"C0123456789"`).
   * @param opts.token - Slack Bot OAuth token with `chat:write` scope.
   * @returns A {@link HitlHandler} that posts to Slack and auto-approves for v1.
   *
   * @example
   * ```ts
   * handler: hitl.slack({ channel: '#approvals', token: process.env.SLACK_BOT_TOKEN! })
   * ```
   */
  slack(opts: { channel: string; token: string }): HitlHandler {
    return async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      // Post the approval request to the configured Slack channel.
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: opts.channel,
          text: [
            '[APPROVAL NEEDED]',
            request.description,
            `Agent: ${request.agent}`,
            `Action: ${request.action}`,
            `Type: ${request.type}`,
            'React with :white_check_mark: to approve or :x: to reject.',
          ].join('\n'),
        }),
      });

      // v1: auto-approve after notifying; real reaction polling is a future enhancement.
      return {
        approved: true,
        reason: 'Slack notification sent — auto-approved for v1',
      };
    };
  },

  // ---------------------------------------------------------------------------
  // llmJudge
  // ---------------------------------------------------------------------------

  /**
   * Creates an HITL handler that delegates approval decisions to an LLM judge.
   *
   * The LLM evaluates the approval request against configurable criteria and
   * returns a structured approve/reject decision with reasoning. When the LLM's
   * self-reported confidence falls below `confidenceThreshold`, the decision is
   * delegated to a fallback handler (default: {@link hitl.autoReject}).
   *
   * @param config - LLM judge configuration including optional `model`,
   *   `provider`, `criteria`, `confidenceThreshold`, `fallback`, and `apiKey`
   *   overrides.
   * @returns A {@link HitlHandler} that auto-decides via LLM.
   *
   * @example
   * ```ts
   * import { agency, hitl } from '@framers/agentos';
   *
   * const guarded = agency({
   *   agents: { worker: { instructions: 'Execute tasks.' } },
   *   hitl: {
   *     approvals: { beforeTool: ['delete-file'] },
   *     handler: hitl.llmJudge({
   *       model: 'gpt-5.6',
   *       criteria: 'Is this action safe and non-destructive?',
   *       confidenceThreshold: 0.8,
   *       fallback: hitl.cli(), // escalate uncertain decisions to human
   *     }),
   *   },
   * });
   * ```
   */
  llmJudge(config: {
    /** LLM model to use. @default the central judge resolver (`resolveDefaultJudgeModel()` — gpt-5.6) */
    model?: string;
    /** LLM provider. @default 'openai'; pinning a non-openai provider requires an explicit `model` */
    provider?: string;
    /**
     * Reasoning effort. When omitted, the resolver's default (`max`) applies
     * only when the resolver's model was also selected — a caller-pinned
     * model gets no injected effort.
     */
    effort?: EffortLevel;
    /** Custom evaluation criteria/rubric. @default 'Evaluate whether this action is safe, relevant, and appropriate.' */
    criteria?: string;
    /** Confidence threshold — below this, escalate to fallback handler. @default 0.7 */
    confidenceThreshold?: number;
    /** Fallback handler when confidence is below threshold. @default hitl.autoReject('LLM judge confidence too low') */
    fallback?: HitlHandler;
    /** API key override. */
    apiKey?: string;
  } = {}): HitlHandler {
    const judgeSel = resolveJudgeLlm({ model: config.model, provider: config.provider, effort: config.effort });
    const model = judgeSel.model;
    const provider = judgeSel.provider;
    const criteria = config.criteria ?? 'Evaluate whether this action is safe, relevant, and appropriate.';
    const threshold = config.confidenceThreshold ?? 0.7;
    const fallback = config.fallback ?? hitl.autoReject('LLM judge confidence too low');

    return async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      try {
        // Lazy import to avoid circular dependency and keep the module tree light
        // when llmJudge is never used.
        const { generateText } = await import('./generateText.js');

        const systemPrompt = [
          'You are an approval judge. Evaluate this action request against the criteria below.',
          '',
          `## Criteria`,
          criteria,
          '',
          '## Instructions',
          '1. Examine the action details carefully.',
          '2. Decide whether the action should be approved or rejected.',
          '3. Assign a confidence score between 0 and 1 reflecting how certain you are.',
          '4. Provide a brief reasoning string explaining your decision.',
          '5. Respond with ONLY a JSON object matching this schema:',
          '   { "approved": boolean, "confidence": number, "reasoning": string }',
          '6. Do not include any other text, markdown fences, or commentary.',
        ].join('\n');

        const userPrompt = [
          `Action type: ${request.type}`,
          `Agent: ${request.agent}`,
          `Action: ${request.action}`,
          `Description: ${request.description}`,
          `Details: ${JSON.stringify(request.details, null, 2)}`,
        ].join('\n');

        const result: GenerateTextResult = await generateText({
          model,
          provider,
          system: systemPrompt,
          prompt: userPrompt,
          temperature: 0.1,
          ...(judgeSel.effort !== undefined ? { effort: judgeSel.effort } : {}),
          apiKey: config.apiKey,
        });

        // Parse the JSON from the LLM response, tolerating surrounding text.
        const jsonMatch = result.text.match(/\{[\s\S]*\}/);
        const decision = JSON.parse(jsonMatch?.[0] ?? '{}');

        if (
          typeof decision.approved === 'boolean' &&
          typeof decision.confidence === 'number' &&
          decision.confidence >= threshold
        ) {
          return {
            approved: decision.approved,
            reason: decision.reasoning ?? (decision.approved ? 'Approved by LLM judge' : 'Rejected by LLM judge'),
          };
        }

        // Confidence below threshold — delegate to fallback handler.
        return fallback(request);
      } catch {
        // LLM call failed — delegate to fallback handler for graceful degradation.
        return fallback(request);
      }
    };
  },
};
