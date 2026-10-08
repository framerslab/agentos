/**
 * @fileoverview Central default-judge selection (spec batch-1 C3).
 *
 * Code default is the pin; env vars are EMERGENCY VALVES only (standing
 * no-env-gated-features rule). Consumed by `api/hitl.ts` (llmJudge), the
 * safety `LLMJudge`, and the orchestration `NodeExecutor` judge — the three
 * sites that previously hardcoded (and co-drifted on) `'gpt-4o-mini'`.
 */
import { isEffortLevel, type EffortLevel } from './model-effort.js';

export interface JudgeSelection {
  /**
   * Provider id — a plain string, not a literal: a non-OpenAI env selection
   * must be representable for `AGENTOS_JUDGE_PROVIDER` to mean anything.
   */
  provider: string;
  model: string;
  effort: EffortLevel;
}

const DEFAULT: JudgeSelection = { provider: 'openai', model: 'gpt-5.6', effort: 'max' };

/**
 * Resolve the default judge selection.
 *
 * Precedence (caller config is applied field-wise at the call sites and
 * always wins over this resolver): env valves > code default. Env rules:
 * `AGENTOS_JUDGE_PROVIDER` without `AGENTOS_JUDGE_MODEL` is ignored entirely
 * (a provider swap with the default model would be meaningless or
 * misrouted); `AGENTOS_JUDGE_MODEL` applies to the effective provider (the
 * env provider when both are set, else the default `openai`) — it is never
 * combined with a provider it was not set alongside. `AGENTOS_JUDGE_EFFORT`
 * must pass {@link isEffortLevel}; invalid values warn and keep the default.
 */
/** Provider ids the env valve accepts; anything else warns and disables BOTH valves. */
const KNOWN_JUDGE_PROVIDERS: readonly string[] = [
  'openai', 'anthropic', 'openrouter', 'google', 'gemini', 'groq', 'together', 'ollama',
];

export function resolveDefaultJudgeModel(): JudgeSelection {
  let envProvider = process.env.AGENTOS_JUDGE_PROVIDER?.trim().toLowerCase() || undefined;
  let envModel = process.env.AGENTOS_JUDGE_MODEL?.trim() || undefined;
  const envEffort = process.env.AGENTOS_JUDGE_EFFORT?.trim().toLowerCase();

  // Unrecognized env provider disables BOTH valves — the model valve was set
  // alongside a provider that cannot be honored, so it must not be misrouted
  // onto the default provider (spec batch-1 review fold).
  if (envProvider && !KNOWN_JUDGE_PROVIDERS.includes(envProvider)) {
    console.warn(
      `[agentos] AGENTOS_JUDGE_PROVIDER '${envProvider}' unrecognized; ignoring the provider AND model valves`,
    );
    envProvider = undefined;
    envModel = undefined;
  }

  const effort: EffortLevel = isEffortLevel(envEffort) ? envEffort : DEFAULT.effort;
  if (envEffort && !isEffortLevel(envEffort)) {
    console.warn(`[agentos] AGENTOS_JUDGE_EFFORT '${envEffort}' invalid; using '${DEFAULT.effort}'`);
  }

  if (envModel) {
    return { provider: envProvider ?? DEFAULT.provider, model: envModel, effort };
  }
  if (envProvider && envProvider !== DEFAULT.provider) {
    console.warn(`[agentos] AGENTOS_JUDGE_PROVIDER '${envProvider}' ignored: no AGENTOS_JUDGE_MODEL set`);
  }
  return { ...DEFAULT, effort };
}
