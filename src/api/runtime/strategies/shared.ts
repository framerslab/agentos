/**
 * @file shared.ts
 * Shared utilities for strategy compilers.
 *
 * Centralises `isAgent()`, `mergeDefaults()`, `resolveAgent()`, and
 * `checkBeforeAgent()` so every strategy compiler uses a single implementation.
 * This avoids subtle divergence in how configs are merged or how HITL gates
 * are evaluated across sequential, parallel, debate, review-loop, and
 * hierarchical strategies.
 *
 * @see {@link compileStrategy} -- the dispatcher that selects and invokes strategy compilers.
 */
import { agent as createAgent } from '../agent.js';
import { mergeAdaptableTools } from '../toolAdapter.js';
import type {
  AgencyOptions,
  AgencyQuorumConfig,
  Agent,
  BaseAgentConfig,
  AgentCallRecord,
  ApprovalRequest,
  ApprovalDecision,
} from '../types.js';
import { AgencyQuorumError } from '../types.js';

/**
 * Type guard that checks whether a value is a pre-built {@link Agent} instance
 * (has a `generate` method) vs a raw `BaseAgentConfig` object.
 *
 * Uses duck-typing on the `generate` method rather than `instanceof` because
 * Agent instances may come from different module copies (e.g. nested agencies
 * created in separate compilation contexts). Duck-typing is more resilient
 * to this scenario.
 *
 * @param value - Either a config object or a running agent.
 * @returns `true` when the value is a pre-built `Agent` with a callable `generate`.
 *
 * @example
 * ```ts
 * const agentOrConfig: BaseAgentConfig | Agent = getFromRoster('worker');
 * if (isAgent(agentOrConfig)) {
 *   // agentOrConfig.generate() is callable
 * } else {
 *   // agentOrConfig is a raw config, needs agent() factory
 * }
 * ```
 */
export function isAgent(value: BaseAgentConfig | Agent): value is Agent {
  return typeof (value as Agent).generate === 'function';
}

/**
 * Enforce a post-fan-out panel quorum (parallel strategy).
 *
 * Checked against the agents that actually SUCCEEDED: `minAgents` is a
 * simple count; `minProviders` counts distinct resolved `provider` values on
 * the results — a multi-model panel that quietly collapsed to a single
 * vendor must not synthesize a false consensus.
 *
 * @param quorum - The agency's quorum config; `undefined` is a no-op.
 * @param settled - Successful fan-out results (name + generate result).
 * @param rosterSize - Total agents attempted, for the error message.
 * @throws {AgencyQuorumError} On shortfall when `onShortfall` is `'error'`
 *   (the default).
 */
export function enforceQuorum(
  quorum: AgencyQuorumConfig | undefined,
  settled: Array<{ name: string; result: Record<string, unknown> }>,
  rosterSize: number,
): void {
  if (!quorum) return;
  const minAgents = quorum.minAgents ?? 0;
  const minProviders = quorum.minProviders ?? 0;
  const providers = new Set(
    settled
      .map((s) => String((s.result as { provider?: unknown }).provider ?? ''))
      .filter((p) => p !== ''),
  );
  if (settled.length >= minAgents && providers.size >= minProviders) return;
  const detail =
    `panel quorum shortfall: ${settled.length}/${rosterSize} agents succeeded ` +
    `(need ${minAgents}), ${providers.size} distinct providers (need ${minProviders})`;
  if ((quorum.onShortfall ?? 'error') === 'proceed') {
    console.warn(`[AgentOS][Parallel] ${detail} — proceeding (onShortfall=proceed)`);
    return;
  }
  throw new AgencyQuorumError(detail);
}

/**
 * Accumulate the optional usage fields (cost + Anthropic prompt-cache
 * tokens) from a per-call usage snapshot onto a running strategy-level
 * totalUsage. Fills in the fields the existing accumulators
 * (promptTokens / completionTokens / totalTokens) already handle — keeping
 * cost and cache metrics undefined on the accumulator until at least one
 * call reports a value, so callers can distinguish "provider does not
 * report cost/cache" (undefined) from "zero" (0).
 *
 * Safe to call against any usage shape: missing fields are skipped
 * without throwing, and numeric zero values are still counted.
 *
 * @param totalUsage - The strategy's running usage accumulator. Mutated
 *   in place to add costUSD / cacheReadTokens / cacheCreationTokens when
 *   the per-call snapshot reports them.
 * @param call - The per-call usage snapshot (typically from an Agent
 *   result or generateText-style TokenUsage). May be undefined.
 */
export function accumulateExtraUsage(
  totalUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUSD?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  },
  call:
    | {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        costUSD?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
      }
    | undefined,
): void {
  if (!call) return;
  if (typeof call.costUSD === 'number') {
    totalUsage.costUSD = (totalUsage.costUSD ?? 0) + call.costUSD;
  }
  if (typeof call.cacheReadTokens === 'number') {
    totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + call.cacheReadTokens;
  }
  if (typeof call.cacheCreationTokens === 'number') {
    totalUsage.cacheCreationTokens = (totalUsage.cacheCreationTokens ?? 0) + call.cacheCreationTokens;
  }
}

/**
 * Back-compat alias for {@link accumulateExtraUsage}.
 *
 * @deprecated Use {@link accumulateExtraUsage}, which also forwards the
 *   per-call `costUSD` field.
 */
export const accumulateCacheTokens = accumulateExtraUsage;

/**
 * Build the per-call usage record stored on `AgentCallRecord.usage`,
 * forwarding the optional `costUSD` and prompt-cache token fields when
 * the per-call usage reports them. Mirrors how providers expose extra
 * usage metadata so multi-agent runs preserve cost + cache visibility
 * down to the individual agent invocation.
 *
 * @param resultUsage - Per-call usage snapshot from an Agent result.
 *   May be undefined.
 * @returns A normalised usage record suitable for {@link AgentCallRecord}.
 */
export function buildAgentCallUsage(
  resultUsage:
    | {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        costUSD?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
      }
    | undefined,
): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUSD?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
} {
  const usage = resultUsage ?? {};
  const out: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUSD?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  } = {
    promptTokens: usage.promptTokens ?? 0,
    completionTokens: usage.completionTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  };
  if (typeof usage.costUSD === 'number') out.costUSD = usage.costUSD;
  if (typeof usage.cacheReadTokens === 'number') out.cacheReadTokens = usage.cacheReadTokens;
  if (typeof usage.cacheCreationTokens === 'number') {
    out.cacheCreationTokens = usage.cacheCreationTokens;
  }
  return out;
}

/**
 * Merge agency-level defaults into an agent config.
 *
 * Agent-level values take precedence over agency-level defaults. Tools are
 * merged additively: agency tools serve as a base layer and agent tools
 * override on name collision. This lets an agency provide a shared tool
 * set while individual agents can override or extend it.
 *
 * @param agentConfig - Per-agent configuration (takes precedence).
 * @param agencyConfig - Agency-level fallback values (base layer).
 * @returns A merged config suitable for passing to `agent()`.
 *
 * @example
 * ```ts
 * const merged = mergeDefaults(
 *   { instructions: 'Write code.' },
 *   { model: 'openai:gpt-4o', tools: { search: searchTool } },
 * );
 * // merged.model === 'openai:gpt-4o' (agency default)
 * // merged.instructions === 'Write code.' (agent override)
 * // merged.tools contains `search` from agency
 * ```
 *
 * @see {@link resolveAgent} -- calls this internally before creating an agent.
 */
export function mergeDefaults(
  agentConfig: BaseAgentConfig,
  agencyConfig: AgencyOptions
): BaseAgentConfig {
  return {
    // Agency-level model/provider/apiKey/baseUrl serve as defaults.
    // They are placed BEFORE the spread of agentConfig so that agent-level
    // values override them when present.
    model: agentConfig.model ?? agencyConfig.model,
    provider: agentConfig.provider ?? agencyConfig.provider,
    apiKey: agentConfig.apiKey ?? agencyConfig.apiKey,
    baseUrl: agentConfig.baseUrl ?? agencyConfig.baseUrl,
    ...agentConfig,
    // Tools are merged separately because we want additive merging
    // (agency tools + agent tools) rather than wholesale replacement.
    tools: mergeAdaptableTools(agencyConfig.tools, agentConfig.tools),
  };
}

/**
 * Resolves an agent-or-config value into a usable {@link Agent} instance.
 *
 * If the value is already a pre-built Agent, it is returned as-is.
 * If it is a raw BaseAgentConfig, agency defaults are merged and a new
 * Agent is created via the `agent()` factory.
 *
 * @param agentOrConfig - Either a pre-built Agent or a raw BaseAgentConfig.
 * @param agencyConfig - Agency-level fallback values for config merging.
 * @returns A ready-to-call Agent instance.
 *
 * @example
 * ```ts
 * const agent = resolveAgent(roster['worker'], agencyConfig);
 * const result = await agent.generate('Do the task.');
 * ```
 *
 * @see {@link isAgent} -- determines whether the value needs factory creation.
 * @see {@link mergeDefaults} -- applies agency-level fallback values.
 */
export function resolveAgent(
  agentOrConfig: BaseAgentConfig | Agent,
  agencyConfig: AgencyOptions
): Agent {
  return isAgent(agentOrConfig)
    ? agentOrConfig
    : createAgent({ ...mergeDefaults(agentOrConfig, agencyConfig) });
}

/**
 * Checks the HITL `beforeAgent` gate for a named agent.
 *
 * When the agency-level `hitl.approvals.beforeAgent` list includes the agent
 * name, this function invokes the HITL handler and returns the decision.
 * If the agent name is not in the approval list, or no handler is configured,
 * returns `null` (meaning "no gate -- proceed normally").
 *
 * ## Why return `null` instead of `{ approved: true }`?
 *
 * Returning `null` lets callers distinguish between "no gate configured"
 * (null -- proceed without any HITL overhead) and "gate evaluated, approved"
 * (`{ approved: true }` -- proceed but may carry instruction modifications
 * from the approver).
 *
 * @param name - The agent's declared name in the roster.
 * @param context - The input/context string the agent would receive.
 * @param agentCalls - Agent call records accumulated so far in this run.
 *                     Included in the approval request for context.
 * @param agencyConfig - The full agency configuration containing HITL settings.
 * @returns The approval decision, or `null` when no gate applies.
 *
 * @example
 * ```ts
 * const decision = await checkBeforeAgent('researcher', prompt, calls, config);
 * if (decision && !decision.approved) {
 *   // Agent was rejected by HITL -- skip or abort.
 *   return;
 * }
 * // Proceed with agent invocation.
 * ```
 *
 * @see {@link HitlConfig} -- defines the approval triggers and handler.
 * @see {@link ApprovalRequest} -- the shape passed to the handler.
 */
export async function checkBeforeAgent(
  name: string,
  context: string,
  agentCalls: AgentCallRecord[],
  agencyConfig: AgencyOptions
): Promise<ApprovalDecision | null> {
  const beforeAgent = agencyConfig.hitl?.approvals?.beforeAgent;
  const handler = agencyConfig.hitl?.handler;

  // Short-circuit: no gate configured or agent not in the approval list.
  if (!beforeAgent?.includes(name) || !handler) {
    return null;
  }

  // Build the approval request with full run context so the human reviewer
  // can make an informed decision.
  const request: ApprovalRequest = {
    id: crypto.randomUUID(),
    type: 'agent',
    agent: name,
    action: 'execute',
    description: `Agent "${name}" is about to execute`,
    details: { input: context },
    context: {
      agentCalls,
      totalTokens: 0,
      totalCostUSD: 0,
      elapsedMs: 0,
    },
  };

  // Fire the approvalRequested callback so event consumers (UI, logs)
  // can display the pending approval.
  agencyConfig.on?.approvalRequested?.(request);
  const decision = await handler(request);
  // Fire the approvalDecided callback so event consumers know the outcome.
  agencyConfig.on?.approvalDecided?.(decision);

  // --- Post-approval guardrail override ---
  // Even after HITL approves, run guardrails as a final safety net.
  if (decision.approved && agencyConfig.hitl?.guardrailOverride !== false) {
    const { runPostApprovalGuardrails } = await import('../../agency.js');
    const postGuardrails = agencyConfig.hitl?.postApprovalGuardrails ?? ['pii-redaction', 'code-safety'];
    const overrideResult = await runPostApprovalGuardrails(
      `agent:${name}`,
      { input: context },
      postGuardrails,
      agencyConfig.on,
    );
    if (!overrideResult.passed) {
      agencyConfig.on?.guardrailHitlOverride?.({
        guardrailId: overrideResult.guardrailId!,
        reason: overrideResult.reason!,
        toolName: `agent:${name}`,
        timestamp: Date.now(),
      });
      return {
        approved: false,
        reason: `Guardrail overrode HITL approval — ${overrideResult.guardrailId}: ${overrideResult.reason}`,
      };
    }
  }

  return decision;
}

/**
 * HITL approval gate for the hierarchical strategy's `spawn_specialist` tool.
 *
 * Mirrors `checkBeforeAgent` but uses `ApprovalRequest.type === 'emergent'`
 * and is keyed off `hitl.approvals.beforeEmergent` (a boolean, not a list,
 * since the manager picks the role at runtime).
 *
 * Returns:
 * - `null` when no gate is configured (no handler / `beforeEmergent !== true`)
 * - The approval `decision` from the handler otherwise
 *
 * Callers should treat `decision.approved === false` as a structured
 * rejection (no roster mutation, no event emission).
 *
 * @see {@link checkBeforeAgent} -- the parallel gate for `delegate_to_<name>` calls.
 */
export async function checkBeforeEmergentSpawn(
  role: string,
  instructions: string,
  justification: string | undefined,
  agentCalls: AgentCallRecord[],
  agencyConfig: AgencyOptions,
): Promise<ApprovalDecision | null> {
  const beforeEmergent = agencyConfig.hitl?.approvals?.beforeEmergent;
  const handler = agencyConfig.hitl?.handler;

  if (beforeEmergent !== true || !handler) {
    return null;
  }

  const request: ApprovalRequest = {
    id: crypto.randomUUID(),
    type: 'emergent',
    agent: 'manager',
    action: `spawn_specialist:${role}`,
    description: `Manager wants to spawn a new specialist agent "${role}"`,
    details: {
      role,
      instructions,
      justification: justification ?? null,
    },
    context: {
      agentCalls,
      totalTokens: 0,
      totalCostUSD: 0,
      elapsedMs: 0,
    },
  };

  agencyConfig.on?.approvalRequested?.(request);
  const decision = await handler(request);
  agencyConfig.on?.approvalDecided?.(decision);

  return decision;
}
