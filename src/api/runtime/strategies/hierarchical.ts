/**
 * @file hierarchical.ts
 * Hierarchical strategy compiler for the Agency API.
 *
 * ## Execution model
 *
 * A manager agent (instantiated from the agency-level config) delegates
 * subtasks to sub-agents via tool calls. Each sub-agent is exposed as a
 * `delegate_to_<name>` tool that the manager can invoke to assign work.
 * The manager synthesizes sub-agent outputs into a final answer.
 *
 * ## Emergent wiring
 *
 * The manager does not follow a fixed execution order. It decides which
 * agents to call, in what order, and with what subtasks -- based on the
 * user prompt and its system instructions. This makes hierarchical the
 * most flexible strategy, but also the most dependent on the manager
 * model's ability to plan and delegate effectively.
 *
 * ## Tool-based delegation
 *
 * Each sub-agent becomes a tool with a JSON Schema parameter (`task: string`).
 * The tool's `execute` function invokes the sub-agent's `generate()` and
 * returns the result text. This leverages the LLM's native tool-calling
 * capability for delegation, avoiding custom routing logic.
 *
 * @see {@link compileStrategy} -- the dispatcher that selects this compiler.
 * @see {@link compileAdaptiveWrapper} -- wraps other strategies with a hierarchical manager.
 */
import { agent as createAgent } from '../agent.js';
import { mergeAdaptableTools } from '../toolAdapter.js';
import type {
  AgencyOptions,
  CompiledStrategy,
  Agent,
  BaseAgentConfig,
  AgentCallRecord,
} from '../types.js';
import type { ToolDefinitionMap } from '../toolAdapter.js';
import { AgencyConfigError } from '../types.js';
import {
  isAgent,
  resolveAgent,
  checkBeforeAgent,
  checkBeforeEmergentSpawn,
  accumulateExtraUsage,
  buildAgentCallUsage,
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
 * Extracts a human-readable description from an agent config or instance.
 *
 * Used to build the team roster in the manager's system prompt so the manager
 * knows what each sub-agent specialises in.
 *
 * @param agentOrConfig - Either a pre-built Agent or a raw BaseAgentConfig.
 * @returns The instructions string if available, otherwise a generic label.
 */
function getAgentDescription(agentOrConfig: BaseAgentConfig | Agent): string {
  if (!isAgent(agentOrConfig) && (agentOrConfig as BaseAgentConfig).instructions) {
    return (agentOrConfig as BaseAgentConfig).instructions!;
  }
  return 'General purpose';
}

/**
 * Smart default for the EmergentAgentJudge model based on the agency
 * provider. Picks a small/cheap model when one exists for that provider
 * so emergent.judge=true does not silently route every spawn through the
 * full agency model. Returns undefined when no good small-model default
 * is known — the caller falls back to the agency-level model.
 */
function defaultJudgeModelFor(provider: string | undefined): string | undefined {
  switch (provider) {
    case 'openai':
      return 'gpt-4o-mini';
    case 'anthropic':
      return 'claude-haiku-4-5-20251001';
    case 'gemini':
      return 'gemini-2.5-flash';
    case 'groq':
      return 'llama-3.3-70b-versatile';
    default:
      return undefined;
  }
}

/**
 * Provider lookup from a judge model identifier. Handles the small-model
 * defaults above so the generateText call routes to the right provider
 * even when the agency provider does not match (e.g. a Claude-based agency
 * routing the judge call to OpenAI's gpt-4o-mini would need provider
 * 'openai', not 'anthropic').
 *
 * Returns undefined when the model is not one of the small-model defaults,
 * so the caller falls back to the agency provider.
 */
function judgeProviderFor(judgeModel: string | undefined): string | undefined {
  if (!judgeModel) return undefined;
  if (judgeModel === 'gpt-4o-mini') return 'openai';
  if (judgeModel === 'claude-haiku-4-5-20251001') return 'anthropic';
  if (judgeModel === 'gemini-2.5-flash') return 'gemini';
  if (judgeModel === 'llama-3.3-70b-versatile') return 'groq';
  return undefined;
}

/**
 * Mutable state shared across one hierarchical strategy execution.
 * Returned by {@link buildHierarchicalTools} so callers (production:
 * `compileHierarchical().execute()`; tests: direct invocation) can
 * inspect the live tool table, agent-call records, accumulated usage,
 * mutable roster, and spawned-counter without poking the
 * `CompiledStrategy` interface.
 */
export interface HierarchicalToolBundle {
  /** Tool table the manager sees — grows when spawn_specialist is invoked. */
  tools: ToolDefinitionMap;
  /** Per-sub-agent call records for the result envelope. */
  agentCalls: AgentCallRecord[];
  /** Accumulated usage across every sub-agent (manager usage merged later). */
  subAgentUsage: StrategyTotalUsage;
  /** Live roster — initial agents plus any spawned specialists. */
  roster: Record<string, BaseAgentConfig | Agent>;
  /** Single-field object (counter ref) so spawn_specialist can mutate it. */
  spawnedCount: { value: number };
}

/**
 * A tool refusal both tool-result consumers can read: the native tool loops
 * read `output` (then `error`), the prompt-tool shim reads `error`.
 */
function refusal(reason: string): { success: false; output: string; error: string } {
  return { success: false, output: reason, error: reason };
}

/**
 * Build the delegation tool table for a hierarchical strategy run.
 *
 * Every static agent in `initialRoster` becomes a `delegate_to_<name>`
 * tool. When `agencyConfig.emergent?.enabled === true`, an additional
 * `spawn_specialist` tool is injected that lets the manager synthesise
 * new sub-agents at runtime via {@link EmergentAgentForge}. Spawned
 * agents are added to the live roster and exposed as new
 * `delegate_to_<spawned-role>` tools on the manager's next turn.
 *
 * The returned bundle is shared mutable state for the duration of one
 * `compileHierarchical().execute()` invocation; it is NOT thread-safe
 * across concurrent strategy executions.
 *
 * Tools return the `ToolExecutionResult` shape (`success`, `output`,
 * `error`): both tool-result consumers read `output`, so the manager receives
 * the delegate's text, a spawn's outcome and a refusal's reason.
 *
 * @internal Exported so tests can drive the spawn_specialist tool directly
 *   without spinning up a manager LLM.
 */
export function buildHierarchicalTools(
  initialRoster: Record<string, BaseAgentConfig | Agent>,
  agencyConfig: AgencyOptions,
  opts: Record<string, unknown> | undefined = {},
): HierarchicalToolBundle {
  const roster: Record<string, BaseAgentConfig | Agent> = { ...initialRoster };
  const tools: ToolDefinitionMap = {};
  const agentCalls: AgentCallRecord[] = [];
  const subAgentUsage: StrategyTotalUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  const spawnedCount = { value: 0 };

  // Builds a delegate_to_<name> tool whose closure captures the current
  // agentCalls/subAgentUsage so mutations from any sub-agent flow back
  // into the bundle. Used both for static-roster wiring (below) and for
  // spawn_specialist's mid-run roster growth.
  function buildDelegateTool(name: string, agentOrConfig: BaseAgentConfig | Agent) {
    const description = getAgentDescription(agentOrConfig);
    return {
      description: `Delegate a subtask to the ${name} agent. ${description}`,
      parameters: {
        type: 'object' as const,
        properties: {
          task: { type: 'string', description: 'The subtask to delegate' },
        },
        required: ['task' as const],
      },
      execute: async (args: { task: string }) => {
        const decision = await checkBeforeAgent(name, args.task, agentCalls, agencyConfig);
        if (decision && !decision.approved) {
          return refusal(`Agent "${name}" execution was rejected by HITL.`);
        }

        const a = resolveAgent(agentOrConfig, agencyConfig);

        const effectiveTask = decision?.modifications?.instructions
          ? `${args.task}\n\n[Additional instructions]: ${decision.modifications.instructions}`
          : args.task;

        const start = Date.now();
        const result = (await a.generate(effectiveTask, opts)) as Record<string, unknown>;
        const durationMs = Date.now() - start;

        const resultText = (result.text as string) ?? '';
        const resultUsage = (result.usage as ResultUsageSnapshot) ?? {};
        const resultToolCalls =
          (result.toolCalls as Array<{
            name: string;
            args: unknown;
            result?: unknown;
            error?: string;
          }>) ?? [];

        agentCalls.push({
          agent: name,
          input: args.task,
          output: resultText,
          toolCalls: resultToolCalls,
          usage: buildAgentCallUsage(resultUsage),
          durationMs,
        });

        subAgentUsage.promptTokens += resultUsage.promptTokens ?? 0;
        subAgentUsage.completionTokens += resultUsage.completionTokens ?? 0;
        subAgentUsage.totalTokens += resultUsage.totalTokens ?? 0;
        accumulateExtraUsage(subAgentUsage, resultUsage);

        return { success: true, output: resultText };
      },
    };
  }

  // Seed the static roster as delegate_to_<name> tools.
  for (const [name, agentOrConfig] of Object.entries(roster)) {
    tools[`delegate_to_${name}`] = buildDelegateTool(name, agentOrConfig);
  }

  // Conditionally inject spawn_specialist when emergent agent synthesis
  // is enabled. This is the new emergent-hierarchical execution path —
  // the manager gets a way to grow its team mid-run.
  if (agencyConfig.emergent?.enabled === true) {
    const planner = agencyConfig.emergent?.planner ?? {};
    const maxSpecialists = planner.maxSpecialists ?? 5;
    const requireJustification = planner.requireJustification === true;
    const judgeEnabled = agencyConfig.emergent?.judge === true;
    const maxJudgeCalls = planner.maxJudgeCalls ?? maxSpecialists * 2;
    const judgeModel = planner.judgeModel ?? defaultJudgeModelFor(agencyConfig.provider) ?? agencyConfig.model ?? 'gpt-4o-mini';
    let judgeCallsUsed = 0;

    tools.spawn_specialist = {
      description:
        'Synthesise a new specialist sub-agent at runtime when no existing roster agent ' +
        'covers the required capability. After spawning, a new delegate_to_<role> tool ' +
        'becomes available on the next turn. Use sparingly — every spawn adds a new agent ' +
        'to the roster for the rest of the run.',
      parameters: {
        type: 'object' as const,
        properties: {
          role: {
            type: 'string',
            description: 'Identifier for the new agent (must match /^[a-zA-Z][a-zA-Z0-9_-]*$/)',
          },
          instructions: {
            type: 'string',
            description: 'System instructions for the new agent',
          },
          justification: {
            type: 'string',
            description: requireJustification
              ? 'REQUIRED: Why no existing roster agent can handle this task.'
              : 'Optional: Why this specialist is needed.',
          },
        },
        required: requireJustification
          ? (['role', 'instructions', 'justification'] as const)
          : (['role', 'instructions'] as const),
      },
      execute: async (args: { role: string; instructions: string; justification?: string }) => {
        if (spawnedCount.value >= maxSpecialists) {
          return refusal(`Cannot spawn: maxSpecialists cap (${maxSpecialists}) reached for this run.`);
        }

        if (requireJustification && (!args.justification || args.justification.trim().length === 0)) {
          return refusal('spawn_specialist requires a non-empty justification when requireJustification is enabled.');
        }

        if (roster[args.role]) {
          return refusal(`Cannot spawn: role "${args.role}" already exists in roster — call delegate_to_${args.role} instead.`);
        }

        // HITL gate (when hitl.approvals.beforeEmergent is true) — fires
        // BEFORE the forge runs so a rejected spawn doesn't waste any
        // validation work. Mirrors the checkBeforeAgent pattern used by
        // delegate_to_<name>.
        const hitlDecision = await checkBeforeEmergentSpawn(
          args.role,
          args.instructions,
          args.justification,
          agentCalls,
          agencyConfig,
        );
        if (hitlDecision && !hitlDecision.approved) {
          return refusal(`HITL rejected spawn of "${args.role}"${hitlDecision.reason ? `: ${hitlDecision.reason}` : ''}`);
        }

        // Lazy import to avoid pulling EmergentAgentForge into hot path
        // when emergent is disabled.
        const { EmergentAgentForge } = await import('../../../cognition/emergent/EmergentAgentForge.js');
        const forge = new EmergentAgentForge({
          defaultModel: agencyConfig.model ?? 'gpt-4o',
          defaultProvider: agencyConfig.provider ?? 'openai',
        });

        const result = await forge.forge(
          {
            role: args.role,
            instructions: args.instructions,
            justification: args.justification,
          },
          {
            // Inherit agency-level memory and guardrails so synthesised
            // agents operate under the same constraints as static roster
            // agents.
            memory: agencyConfig.memory,
            guardrails: agencyConfig.guardrails,
            security: agencyConfig.security,
          },
        );

        if (!result.ok) {
          return refusal(`Forge rejected: ${result.reason}`);
        }

        // Judge gating: when emergent.judge is true, run the synthesised
        // spec through EmergentAgentJudge before activation. Rejection
        // short-circuits and the roster is not mutated.
        if (judgeEnabled) {
          if (judgeCallsUsed >= maxJudgeCalls) {
            return refusal(`Cannot spawn: maxJudgeCalls cap (${maxJudgeCalls}) reached for this run.`);
          }

          const { EmergentAgentJudge } = await import('../../../cognition/emergent/EmergentAgentJudge.js');
          const { generateText } = await import('../../generateText.js');
          const judge = new EmergentAgentJudge({
            judgeModel,
            generateText: async (model, prompt) => {
              const r = await generateText({
                model,
                provider: judgeProviderFor(judgeModel) ?? agencyConfig.provider,
                prompt,
              });
              return r.text ?? '';
            },
          });

          judgeCallsUsed += 1;

          const verdict = await judge.reviewAgent({
            role: args.role,
            instructions: args.instructions,
            justification: args.justification,
          });

          if (!verdict.approved) {
            return refusal(`Judge rejected synthesised agent "${args.role}": ${verdict.reason}`);
          }
        }

        roster[args.role] = result.config;
        tools[`delegate_to_${args.role}`] = buildDelegateTool(args.role, result.config);
        spawnedCount.value += 1;

        // Surface a ForgeEvent so observability/audit can capture every
        // synthesis. Reuses the existing emergentForge callback shape on
        // AgencyCallbacks — no new event type.
        agencyConfig.on?.emergentForge?.({
          agentName: args.role,
          instructions: result.config.instructions ?? '',
          approved: true,
          timestamp: Date.now(),
        });

        return {
          success: true,
          output: `Spawned ${args.role}. Call delegate_to_${args.role}({ task: '...' }) on the next turn to invoke them.`,
        };
      },
    };
  }

  return { tools, agentCalls, subAgentUsage, roster, spawnedCount };
}

/**
 * Compiles a hierarchical execution strategy.
 *
 * A manager agent is instantiated from the agency-level model/provider/instructions.
 * Each sub-agent in the roster is exposed as a `delegate_to_<name>` tool that the
 * manager can invoke. When the manager calls a delegation tool, the corresponding
 * sub-agent runs the subtask and its output is returned as the tool result.
 *
 * All sub-agent call records are collected and returned alongside the manager's
 * final synthesized answer.
 *
 * @param agents - Named roster of agent configs or pre-built `Agent` instances.
 * @param agencyConfig - Agency-level configuration; must include `model` or `provider`
 *   for the manager agent.
 * @returns A {@link CompiledStrategy} with `execute` and `stream` methods.
 * @throws {AgencyConfigError} When no agency-level model/provider is available
 *   for the manager agent.
 *
 * @example
 * ```ts
 * const strategy = compileHierarchical(
 *   {
 *     researcher: { instructions: 'Find academic sources.' },
 *     writer: { instructions: 'Write clear prose.' },
 *   },
 *   { model: 'openai:gpt-4o', agents: { ... } },
 * );
 * const result = await strategy.execute('Write a literature review on LLMs.');
 * // The manager decided which agents to call and in what order.
 * ```
 */
export function compileHierarchical(
  agents: Record<string, BaseAgentConfig | Agent>,
  agencyConfig: AgencyOptions
): CompiledStrategy {
  if (!agencyConfig.model && !agencyConfig.provider) {
    throw new AgencyConfigError(
      'Hierarchical strategy requires an agency-level model or provider for the manager agent.'
    );
  }

  return {
    async execute(prompt, opts) {
      // Build the delegation tool table (and sub-agent call accumulators)
      // through the shared helper so the spawn_specialist path — which
      // mutates the same tool table at runtime — sees the same state.
      const { tools: agentTools, agentCalls, subAgentUsage } =
        buildHierarchicalTools(agents, agencyConfig, opts);

      // Build the team roster description for the manager's system prompt.
      // This tells the manager who is on the team and what each member does.
      const teamRoster = Object.entries(agents)
        .map(([name, c]) => `- ${name}: ${getAgentDescription(c)}`)
        .join('\n');

      const managerInstructions =
        `You are a manager agent. Your task is to accomplish the user's goal by delegating subtasks to your team members.\n\n` +
        `Available team members:\n${teamRoster}\n\n` +
        `Use the delegate_to_<name> tools to assign work. Synthesize their outputs into a final answer.` +
        (agencyConfig.instructions ? `\n\n${agencyConfig.instructions}` : '');

      // Merge agency-level tools with the delegation tools. Agency tools
      // (e.g. shared search, calculator) are available alongside delegation.
      const mergedTools = mergeAdaptableTools(agencyConfig.tools, agentTools);

      const manager = createAgent({
        model: agencyConfig.model,
        provider: agencyConfig.provider,
        apiKey: agencyConfig.apiKey,
        baseUrl: agencyConfig.baseUrl,
        instructions: managerInstructions,
        tools: mergedTools,
        // Higher maxSteps than default because the manager needs room to
        // call multiple delegation tools before synthesizing.
        maxSteps: agencyConfig.maxSteps ?? 10,
      });

      const result = (await manager.generate(prompt, opts)) as unknown as Record<string, unknown>;

      // Merge manager usage with the accumulated sub-agent usage so the
      // returned `usage` reflects the entire run (manager + delegates).
      const managerUsage = (result.usage as ResultUsageSnapshot) ?? {};
      const totalUsage: StrategyTotalUsage = {
        promptTokens: (managerUsage.promptTokens ?? 0) + subAgentUsage.promptTokens,
        completionTokens: (managerUsage.completionTokens ?? 0) + subAgentUsage.completionTokens,
        totalTokens: (managerUsage.totalTokens ?? 0) + subAgentUsage.totalTokens,
      };
      accumulateExtraUsage(totalUsage, managerUsage);
      accumulateExtraUsage(totalUsage, subAgentUsage);

      return { ...result, agentCalls, usage: totalUsage };
    },

    stream(prompt, opts) {
      /**
       * For v1: streaming delegates to execute() and wraps the resolved text
       * as a single-chunk async iterable. A future version will stream the
       * manager's output in real-time.
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
