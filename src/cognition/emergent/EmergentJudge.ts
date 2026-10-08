/**
 * @fileoverview EmergentJudge — LLM-as-judge evaluator for forged tools.
 * @module @framers/agentos/emergent/EmergentJudge
 *
 * Evaluates runtime-created tools across three distinct evaluation modes, each
 * scaled to the risk level of the operation:
 *
 * - **Creation review** (`reviewCreation`): Full code audit + test output
 *   validation. Invokes a single LLM call against the judge model to score
 *   safety, correctness, determinism, and boundedness. The tool is only
 *   approved if both safety and correctness pass.
 *
 * - **Reuse validation** (`validateReuse`): Pure programmatic schema conformance
 *   check run on every invocation. Zero LLM calls — must be fast. Validates
 *   that the tool's output matches its declared JSON Schema type constraints.
 *
 * - **Promotion panel** (`reviewPromotion`): Two independent LLM calls using
 *   the promotion model — one safety auditor and one correctness reviewer.
 *   Both must approve for the promotion verdict to pass. This dual-judge
 *   gate prevents single-point-of-failure in the promotion decision.
 *
 * All LLM interaction is abstracted behind a `generateText` callback so the
 * judge is model-agnostic and trivially testable with mock implementations.
 */

import type {
  CreationVerdict,
  ReuseVerdict,
  PromotionVerdict,
  EmergentTool,
} from './types.js';
import type { JSONSchemaObject } from '../../core/tools/ITool.js';

// ============================================================================
// TOOL CANDIDATE
// ============================================================================

/**
 * A candidate tool submitted for creation review by the {@link EmergentJudge}.
 *
 * Contains all the information the judge needs to evaluate safety, correctness,
 * determinism, and bounded execution: the tool's identity and schemas, its
 * source code or composition spec, the sandbox API allowlist, and the results
 * of any test runs.
 */
export interface ToolCandidate {
  /** Machine-readable name for the proposed tool. */
  name: string;

  /** Natural language description of the tool's purpose and behaviour. */
  description: string;

  /** JSON Schema defining the tool's input arguments. */
  inputSchema: JSONSchemaObject;

  /** JSON Schema defining the tool's expected output shape (optional). */
  outputSchema?: JSONSchemaObject;

  /**
   * The tool's source code (for sandbox mode) or serialized composition spec
   * (for compose mode). Included in the LLM prompt for security auditing.
   */
  source: string;

  /**
   * Whether the tool was built by composing existing tools (`'compose'`) or
   * by running arbitrary code in a sandbox (`'sandbox'`).
   */
  implementationMode: 'compose' | 'sandbox';

  /**
   * Sandbox API allowlist — the set of APIs the tool's code is permitted to
   * invoke. Only relevant for `'sandbox'` mode tools. Used by the safety
   * auditor to verify that the code does not exceed its declared API surface.
   */
  allowlist?: string[];

  /**
   * Results of test runs executed against the candidate tool before review.
   * Each entry contains the input, output, success flag, and optional error.
   * The judge uses these to assess correctness and determinism.
   */
  testResults: Array<{
    input: unknown;
    output: unknown;
    success: boolean;
    error?: string;
    /** The test run's effects: a composition's steps that were not executed while forging, or a code tool's capability calls under a ceiling. */
    effects?: unknown[];
  }>;
}

// ============================================================================
// JUDGE CONFIGURATION
// ============================================================================

/**
 * Configuration for the {@link EmergentJudge}.
 *
 * All LLM interaction is abstracted behind the `generateText` callback,
 * making the judge model-agnostic and easily testable with mocks.
 */
export interface EmergentJudgeConfig {
  /**
   * Model ID used for the single-pass creation review.
   * Should be a fast, cost-efficient model since correctness is primarily
   * validated through test cases.
   * @example "gpt-4o-mini"
   */
  judgeModel: string;

  /**
   * Model ID used by both reviewers in the promotion panel.
   * Should be a more capable model than `judgeModel` since promotion
   * decisions are higher-stakes.
   * @example "gpt-4o"
   */
  promotionModel: string;

  /**
   * Callback that invokes an LLM to generate text from a prompt.
   * The judge calls this for creation reviews and promotion panels.
   *
   * @param model - The model ID to use for generation.
   * @param prompt - The full prompt string to send to the LLM.
   * @returns The raw text response from the LLM.
   */
  generateText: (model: string, prompt: string) => Promise<string>;

  /**
   * Optional structured callback that receives a stable `system` prefix and
   * a candidate-specific `user` payload separately. When supplied, the
   * judge prefers this path over {@link generateText} so hosts can attach
   * provider-level prompt caching (e.g. Anthropic `cache_control: ephemeral`
   * or OpenAI automatic prefix cache) to the shared rubric. A 10-20 call
   * run on Anthropic sees ~25% judge cost reduction once the ~500-token
   * rubric hits the cache on call 2+.
   *
   * Hosts that do not care about caching may omit this field; the judge
   * falls back to concatenating `system + '\n\n' + user` and calling the
   * legacy {@link generateText} path, which preserves behavior exactly.
   *
   * @param model - Model ID to use for generation.
   * @param system - Stable rubric text. Safe to mark cacheable.
   * @param user - Candidate-specific payload that varies per call.
   * @returns The raw text response from the LLM.
   */
  generateTextWithSystem?: (model: string, system: string, user: string) => Promise<string>;
}

// ============================================================================
// INTERNAL: LLM RESPONSE SHAPES
// ============================================================================

/**
 * Shape of the JSON response expected from the creation review LLM call.
 * Parsed from the raw LLM output and mapped to a {@link CreationVerdict}.
 */
interface CreationLLMResponse {
  safety: { passed: boolean; concerns: string[] };
  correctness: { passed: boolean; failedTests: number[] };
  determinism: { likely: boolean; reasoning: string };
  bounded: { likely: boolean; reasoning: string };
  confidence: number;
  approved: boolean;
  reasoning: string;
}

/**
 * Shape of the JSON response expected from each promotion reviewer LLM call.
 */
interface PromotionReviewerResponse {
  approved: boolean;
  confidence: number;
  reasoning: string;
}

// ============================================================================
// EMERGENT JUDGE
// ============================================================================

/**
 * Evaluates forged tools for safety, correctness, and quality using LLM-as-judge.
 *
 * Three evaluation modes, each scaled to the risk level of the operation:
 *
 * | Mode | LLM calls | When used |
 * |---|---|---|
 * | `reviewCreation` | 1 | Newly forged tool — full code audit + test validation |
 * | `validateReuse` | 0 | Every invocation — pure programmatic schema check |
 * | `reviewPromotion` | 2 | Tier promotion — dual-judge safety + correctness panel |
 *
 * @example
 * ```ts
 * const judge = new EmergentJudge({
 *   judgeModel: 'gpt-4o-mini',
 *   promotionModel: 'gpt-4o',
 *   generateText: async (model, prompt) => callLlm(model, prompt),
 * });
 *
 * // Creation review
 * const verdict = await judge.reviewCreation(candidate);
 * if (verdict.approved) { registry.register(tool, 'session'); }
 *
 * // Reuse validation (no LLM call)
 * const reuse = judge.validateReuse('tool-1', output, outputSchema);
 * if (!reuse.valid) { throw new Error(reuse.schemaErrors.join(', ')); }
 *
 * // Promotion panel
 * const promotion = await judge.reviewPromotion(tool);
 * if (promotion.approved) { registry.promote(tool.id, 'agent'); }
 * ```
 */
export class EmergentJudge {
  /** Resolved configuration containing model IDs and the generateText callback. */
  private readonly config: EmergentJudgeConfig;

  /**
   * Create a new EmergentJudge instance.
   *
   * @param config - Judge configuration specifying models and the LLM callback.
   *   The `generateText` function is called for creation reviews and promotion
   *   panels but never for reuse validation (which is purely programmatic).
   */
  constructor(config: EmergentJudgeConfig) {
    this.config = config;
  }

  // --------------------------------------------------------------------------
  // PUBLIC: reviewCreation
  // --------------------------------------------------------------------------

  /**
   * Full code + test review for a newly forged tool.
   *
   * Builds a structured prompt from the candidate's details (name, description,
   * schemas, source code, sandbox allowlist, test results) and asks the LLM to
   * evaluate four dimensions: SAFETY, CORRECTNESS, DETERMINISM, BOUNDED.
   *
   * The tool is approved only if both `safety.passed` AND `correctness.passed`
   * are `true` in the LLM response.
   *
   * If the LLM returns malformed JSON that cannot be parsed, a rejected verdict
   * is returned with confidence 0 and a reasoning string explaining the parse
   * failure. This prevents bad LLM output from accidentally approving a tool.
   *
   * @param candidate - The tool candidate to evaluate. Must include source code
   *   and at least one test result.
   * @returns A {@link CreationVerdict} indicating approval or rejection with
   *   per-dimension scores and reasoning.
   */
  async reviewCreation(candidate: ToolCandidate): Promise<CreationVerdict> {
    const { system, user } = this.buildCreationPromptParts(candidate);

    let rawResponse: string;
    try {
      rawResponse = await this.invokeLlm(this.config.judgeModel, system, user);
    } catch {
      return this.rejectedVerdict('LLM call failed during creation review.');
    }

    // Parse the JSON response from the LLM.
    let parsed: CreationLLMResponse;
    try {
      parsed = JSON.parse(this.extractJson(rawResponse));
    } catch {
      return this.rejectedVerdict(
        'Failed to parse LLM response as JSON during creation review.',
      );
    }

    // Map LLM response to CreationVerdict.
    // Approved only if both safety and correctness passed.
    const safetyPassed = parsed.safety?.passed === true;
    const correctnessPassed = parsed.correctness?.passed === true;
    const approved = safetyPassed && correctnessPassed;

    return {
      approved,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      // Preserve the LLM's granular score when available instead of collapsing
      // to binary 0/1. This retains partial-confidence signals (e.g. 0.3 safety)
      // that inform downstream promotion decisions.
      safety: typeof (parsed.safety as Record<string, unknown>)?.score === 'number'
        ? (parsed.safety as Record<string, unknown>).score as number
        : (safetyPassed ? 1.0 : 0.0),
      correctness: typeof (parsed.correctness as Record<string, unknown>)?.score === 'number'
        ? (parsed.correctness as Record<string, unknown>).score as number
        : (correctnessPassed ? 1.0 : 0.0),
      determinism: parsed.determinism?.likely ? 1.0 : 0.5,
      bounded: parsed.bounded?.likely ? 1.0 : 0.5,
      reasoning: parsed.reasoning ?? '',
    };
  }

  // --------------------------------------------------------------------------
  // PUBLIC: validateReuse
  // --------------------------------------------------------------------------

  /**
   * Pure schema validation on each reuse — no LLM call.
   *
   * Validates that `output` conforms to the declared `schema` using basic type
   * checking. This runs on every tool invocation so it must be fast — no LLM
   * calls, no network I/O, no async operations.
   *
   * Checks performed:
   * - If schema declares `type: 'object'`, verify output is a non-null object.
   * - If schema declares `properties`, verify each declared property key exists
   *   on the output object.
   * - If schema declares `required`, verify each required property key exists.
   * - If schema declares `type: 'string'`, verify output is a string.
   * - If schema declares `type: 'number'` or `type: 'integer'`, verify output
   *   is a number.
   * - If schema declares `type: 'boolean'`, verify output is a boolean.
   * - If schema declares `type: 'array'`, verify output is an array.
   *
   * @param _toolId - The ID of the tool being reused (reserved for future
   *   anomaly detection; currently unused).
   * @param output - The actual output value produced by the tool invocation.
   * @param schema - The tool's declared output JSON Schema.
   * @returns A {@link ReuseVerdict} with `valid: true` if the output conforms,
   *   or `valid: false` with a `schemaErrors` array describing each mismatch.
   */
  validateReuse(_toolId: string, output: unknown, schema: JSONSchemaObject): ReuseVerdict {
    // Use the full recursive validator instead of type-only checking.
    // This catches constraint violations (minLength, maximum, pattern, etc.)
    // that the old type-only check silently ignored.
    const result = this.validateAgainstSchema(output, schema as Record<string, unknown>);

    return {
      valid: result.valid,
      schemaErrors: result.errors,
      anomaly: false,
    };
  }

  // --------------------------------------------------------------------------
  // PUBLIC: reviewPromotion
  // --------------------------------------------------------------------------

  /**
   * Two-judge panel for tier promotion. Both must approve.
   *
   * Sends two independent LLM calls in parallel using the promotion model:
   * 1. **Safety auditor**: Reviews the tool's source code and usage history for
   *    security concerns (data exfiltration, resource exhaustion, API abuse).
   * 2. **Correctness reviewer**: Reviews the tool's source code and all historical
   *    outputs for correctness issues (schema violations, edge case failures).
   *
   * Both reviewers must return `approved: true` for the promotion to pass. If
   * either reviewer's response fails to parse as JSON, the promotion is rejected.
   *
   * @param tool - The emergent tool to evaluate for promotion. Must have usage
   *   stats and judge verdicts from prior reviews.
   * @returns A {@link PromotionVerdict} containing both sub-verdicts and the
   *   combined approval decision.
   */
  async reviewPromotion(tool: EmergentTool): Promise<PromotionVerdict> {
    const safetyParts = this.buildSafetyAuditorPromptParts(tool);
    const correctnessParts = this.buildCorrectnessReviewerPromptParts(tool);

    // Run both reviewer calls in parallel.
    const [safetyRaw, correctnessRaw] = await Promise.all([
      this.invokeLlm(this.config.promotionModel, safetyParts.system, safetyParts.user).catch(() => ''),
      this.invokeLlm(this.config.promotionModel, correctnessParts.system, correctnessParts.user).catch(() => ''),
    ]);

    // Parse safety auditor response.
    let safetyResult: PromotionReviewerResponse;
    try {
      safetyResult = JSON.parse(this.extractJson(safetyRaw));
    } catch {
      safetyResult = { approved: false, confidence: 0, reasoning: 'Failed to parse safety auditor response.' };
    }

    // Parse correctness reviewer response.
    let correctnessResult: PromotionReviewerResponse;
    try {
      correctnessResult = JSON.parse(this.extractJson(correctnessRaw));
    } catch {
      correctnessResult = { approved: false, confidence: 0, reasoning: 'Failed to parse correctness reviewer response.' };
    }

    // Both must approve.
    const approved =
      safetyResult.approved === true && correctnessResult.approved === true;

    // Combined confidence is the minimum of both sub-scores.
    const safetyConfidence = typeof safetyResult.confidence === 'number' ? safetyResult.confidence : 0;
    const correctnessConfidence = typeof correctnessResult.confidence === 'number' ? correctnessResult.confidence : 0;

    return {
      approved,
      safetyAuditor: {
        approved: safetyResult.approved === true,
        confidence: safetyConfidence,
        reasoning: safetyResult.reasoning ?? '',
      },
      correctnessReviewer: {
        approved: correctnessResult.approved === true,
        confidence: correctnessConfidence,
        reasoning: correctnessResult.reasoning ?? '',
      },
      confidence: Math.min(safetyConfidence, correctnessConfidence),
    };
  }

  // --------------------------------------------------------------------------
  // PRIVATE: Prompt builders
  // --------------------------------------------------------------------------

  /**
   * Build the creation review prompt from a tool candidate.
   *
   * The prompt asks the LLM to act as a security auditor and evaluate the
   * candidate across four dimensions: SAFETY, CORRECTNESS, DETERMINISM, BOUNDED.
   *
   * @param candidate - The tool candidate to build the prompt for.
   * @returns The fully-formed prompt string.
   */
  /**
   * Invoke the configured LLM with a cached system rubric when the host
   * supplied {@link EmergentJudgeConfig.generateTextWithSystem}; otherwise
   * fall back to the legacy concatenated-prompt path via
   * {@link EmergentJudgeConfig.generateText}. Preserves exact behavior for
   * callers that do not wire the caching callback.
   */
  private invokeLlm(model: string, system: string, user: string): Promise<string> {
    if (this.config.generateTextWithSystem) {
      return this.config.generateTextWithSystem(model, system, user);
    }
    return this.config.generateText(model, `${system}\n\n${user}`);
  }

  /** Stable rubric + variable payload split so hosts can cache the rubric. */
  private buildCreationPromptParts(candidate: ToolCandidate): { system: string; user: string } {
    const testResultsFormatted = candidate.testResults
      .map(
        (r, i) =>
          `Test ${i + 1}: input=${JSON.stringify(r.input)} output=${JSON.stringify(r.output)} success=${r.success}` +
          `${r.error ? ` error=${r.error}` : ''}` +
          `${r.effects && r.effects.length > 0 ? ` effects=${JSON.stringify(r.effects)}` : ''}`,
      )
      .join('\n');

    const system = `You are a security auditor reviewing a tool an AI agent created at runtime.

Evaluate the tool against four concrete criteria. Each criterion is binary: pass or fail with a specific cause. Do not hedge.

1. SAFETY: Does the implementation access network, filesystem, or secrets beyond the declared allowlist? Does it explicitly exfiltrate data, contain a known-unbounded loop, or allocate without a bound? PASS unless you can name the offending construct.
2. CORRECTNESS: Did each provided testCase actually run (success: true)? Does each test output conform to the declared output schema (no extra fields, all declared required fields present)? PASS when those two conditions hold for every test that ran. Disagreement between testCase expectedOutput and observed output is the AUTHOR'S problem, not yours — if the code computes something different from expectedOutput, that means the AUTHOR'S expectedOutput was a guess; the code is the source of truth as long as it conforms to the schema and is deterministic.
3. DETERMINISM: Does the code use Math.random, Date.now, time-of-day, or other non-determinism for its return value? PASS unless you can point at the specific source of non-determinism.
4. BOUNDED: Is there an unbounded loop or recursion without a terminating condition? PASS unless you can name the unbounded construct.

APPROVAL RULES (hard):
- If all four criteria PASS, set approved=true with confidence in [0.7, 1.0].
- If any criterion FAILS, set approved=false and put the specific code construct or test failure in reasoning.
- Do NOT reject because you "cannot confidently verify" something. Cannot-verify is not a violation. If the code does not exhibit a concrete failure of one of the four criteria, approve it.
- Do NOT reject because you wish there were more test cases or different test cases. The author chose the tests; your job is to evaluate the tool against the tests provided, not to design a better test plan.
- Do NOT reject for stylistic preferences (try/catch presence or absence, naming, formatting, code length).
- A discrepancy between an author-supplied expectedOutput and the code's actual output is NOT a correctness failure on the code — it is the author setting an inaccurate expectation. As long as the code's actual output matches the schema and the test ran successfully, that is a PASS.

Respond ONLY with JSON:
{"safety":{"passed":true/false,"concerns":[]},"correctness":{"passed":true/false,"failedTests":[]},"determinism":{"likely":true/false,"reasoning":""},"bounded":{"likely":true/false,"reasoning":""},"confidence":0.0-1.0,"approved":true/false,"reasoning":""}`;

    const user = `Tool name: ${candidate.name}
Description: ${candidate.description}
Input schema: ${JSON.stringify(candidate.inputSchema)}
Output schema: ${JSON.stringify(candidate.outputSchema)}
Implementation mode: ${candidate.implementationMode}
Source code:
${candidate.source}
Requested sandbox APIs: ${JSON.stringify(candidate.allowlist ?? [])}
Test cases and results:
${testResultsFormatted}`;

    return { system, user };
  }

  /** Stable safety-auditor rubric + per-tool payload. */
  private buildSafetyAuditorPromptParts(tool: EmergentTool): { system: string; user: string } {
    const system = `You are a security auditor evaluating whether an AI-created tool should be promoted to a higher trust tier.

Focus on SAFETY:
- Does the implementation access network, filesystem, or secrets beyond what is necessary?
- Could it exfiltrate data or be used as an attack vector?
- Are there any resource exhaustion concerns (infinite loops, unbounded memory)?
- Has the tool's usage history shown any anomalous patterns?

Respond ONLY with JSON:
{"approved":true/false,"confidence":0.0-1.0,"reasoning":""}`;

    const user = `Tool name: ${tool.name}
Description: ${tool.description}
Current tier: ${tool.tier}
Implementation mode: ${tool.implementation.mode}
Implementation: ${JSON.stringify(tool.implementation)}
Usage stats: ${JSON.stringify(tool.usageStats)}
Previous verdicts: ${JSON.stringify(tool.judgeVerdicts)}`;

    return { system, user };
  }

  /** Stable correctness-reviewer rubric + per-tool payload. */
  private buildCorrectnessReviewerPromptParts(tool: EmergentTool): { system: string; user: string } {
    const system = `You are a correctness reviewer evaluating whether an AI-created tool should be promoted to a higher trust tier.

Focus on CORRECTNESS:
- Does the implementation correctly handle all declared input schema variations?
- Are edge cases properly handled (empty inputs, null values, large inputs)?
- Does the success rate indicate reliability?
- Are there any patterns in the failure history that suggest systematic issues?

Respond ONLY with JSON:
{"approved":true/false,"confidence":0.0-1.0,"reasoning":""}`;

    const user = `Tool name: ${tool.name}
Description: ${tool.description}
Current tier: ${tool.tier}
Implementation mode: ${tool.implementation.mode}
Implementation: ${JSON.stringify(tool.implementation)}
Usage stats: ${JSON.stringify(tool.usageStats)}
Previous verdicts: ${JSON.stringify(tool.judgeVerdicts)}
Success rate: ${tool.usageStats.successCount}/${tool.usageStats.totalUses}`;

    return { system, user };
  }

  // --------------------------------------------------------------------------
  // PRIVATE: Schema validation helpers
  // --------------------------------------------------------------------------

  /**
   * Recursively validate a value against a JSON Schema definition.
   *
   * Implements a focused subset of JSON Schema validation without external
   * dependencies (no ajv). Supports:
   * - Type checking: object, string, number, integer, boolean, array
   * - String constraints: minLength, maxLength, pattern, enum
   * - Number constraints: minimum, maximum
   * - Object constraints: required fields, recursive property validation
   * - Array constraints: recursive items validation
   *
   * This runs on every tool invocation so it must be fast — no LLM calls,
   * no network I/O, no async operations.
   *
   * @param value - The value to validate.
   * @param schema - The JSON Schema to validate against.
   * @returns An object with `valid: true` if the value conforms, or
   *   `valid: false` with an `errors` array describing each mismatch.
   */
  private validateAgainstSchema(
    value: unknown,
    schema: Record<string, unknown>,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // --- Type check ---
    // Validates the fundamental JS type matches the schema's declared type.
    if (schema.type) {
      const typeErrors = this.validateType(value, schema as JSONSchemaObject);
      errors.push(...typeErrors);

      // If the basic type is wrong, skip constraint checks — they only make
      // sense when the value is already the correct type.
      if (typeErrors.length > 0) {
        return { valid: false, errors };
      }
    }

    // --- String constraints ---
    // Only checked when the schema declares string type AND the value is a string.
    if (schema.type === 'string' && typeof value === 'string') {
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
        errors.push(`String length ${value.length} is below minLength ${schema.minLength}.`);
      }
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
        errors.push(`String length ${value.length} exceeds maxLength ${schema.maxLength}.`);
      }
      if (typeof schema.pattern === 'string') {
        // Pattern matching per JSON Schema spec: the pattern tests the entire string.
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push(`String does not match pattern "${schema.pattern}".`);
        }
      }
      if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        errors.push(`Value "${value}" is not in enum [${schema.enum.map(String).join(', ')}].`);
      }
    }

    // --- Number constraints ---
    // Only checked when the schema declares number/integer AND the value is a number.
    if (
      (schema.type === 'number' || schema.type === 'integer') &&
      typeof value === 'number'
    ) {
      if (typeof schema.minimum === 'number' && value < schema.minimum) {
        errors.push(`Value ${value} is below minimum ${schema.minimum}.`);
      }
      if (typeof schema.maximum === 'number' && value > schema.maximum) {
        errors.push(`Value ${value} exceeds maximum ${schema.maximum}.`);
      }
    }

    // --- Object: required fields + recursive property validation ---
    // Validates nested structure when schema declares object type.
    if (schema.type === 'object' && typeof value === 'object' && value !== null) {
      const obj = value as Record<string, unknown>;
      const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
      const required = schema.required as string[] | undefined;

      // Check required fields exist on the object.
      if (required) {
        for (const key of required) {
          if (!(key in obj)) {
            errors.push(`Missing required property "${key}".`);
          }
        }
      }

      // Recursively validate each declared property that exists on the object.
      if (props) {
        for (const [key, propSchema] of Object.entries(props)) {
          if (key in obj) {
            const nested = this.validateAgainstSchema(obj[key], propSchema);
            // Prefix nested errors with the property path for clear diagnostics.
            errors.push(...nested.errors.map((e) => `${key}.${e}`));
          } else if (!required?.includes(key)) {
            // Property is declared but not required AND not present — that's still
            // reported as missing (existing behaviour) to ensure schema conformance.
            errors.push(`Missing property "${key}" declared in schema.`);
          }
        }
      }
    }

    // --- Array: items validation ---
    // Recursively validates each array element against the items schema.
    if (schema.type === 'array' && Array.isArray(value)) {
      const items = schema.items as Record<string, unknown> | undefined;
      if (items) {
        value.forEach((item, i) => {
          const nested = this.validateAgainstSchema(item, items);
          // Prefix nested errors with the array index for clear diagnostics.
          errors.push(...nested.errors.map((e) => `[${i}].${e}`));
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validate a value against a JSON Schema `type` declaration.
   *
   * Performs basic type checking without a full JSON Schema validator library.
   * Supports object (with optional properties/required checks), string, number,
   * integer, boolean, and array types.
   *
   * @param value - The value to validate.
   * @param schema - The JSON Schema to validate against.
   * @returns An array of error strings (empty if valid).
   */
  private validateType(value: unknown, schema: JSONSchemaObject): string[] {
    const errors: string[] = [];
    const schemaType = schema.type;

    switch (schemaType) {
      case 'object': {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          errors.push(`Expected type "object" but got "${this.describeType(value)}".`);
        }
        break;
      }

      case 'string': {
        if (typeof value !== 'string') {
          errors.push(`Expected type "string" but got "${this.describeType(value)}".`);
        }
        break;
      }

      case 'number': {
        if (typeof value !== 'number') {
          errors.push(`Expected type "number" but got "${this.describeType(value)}".`);
        }
        break;
      }

      case 'integer': {
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          errors.push(`Expected type "integer" but got "${this.describeType(value)}".`);
        }
        break;
      }

      case 'boolean': {
        if (typeof value !== 'boolean') {
          errors.push(`Expected type "boolean" but got "${this.describeType(value)}".`);
        }
        break;
      }

      case 'array': {
        if (!Array.isArray(value)) {
          errors.push(`Expected type "array" but got "${this.describeType(value)}".`);
        }
        break;
      }

      default:
        // Unknown or unhandled schema type — skip validation.
        break;
    }

    return errors;
  }

  /**
   * Produce a human-readable type description for an arbitrary value.
   *
   * @param value - The value to describe.
   * @returns A string like `"null"`, `"array"`, `"object"`, `"string"`, etc.
   */
  private describeType(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  // --------------------------------------------------------------------------
  // PRIVATE: JSON extraction & verdict helpers
  // --------------------------------------------------------------------------

  /**
   * Extract a JSON object from a potentially wrapped LLM response.
   *
   * LLMs sometimes wrap JSON in markdown code fences or prepend/append prose.
   * This method attempts to find the first `{` and last `}` and extract the
   * substring between them.
   *
   * @param raw - The raw LLM response string.
   * @returns The extracted JSON substring, or the original string if no
   *   braces are found.
   */
  private extractJson(raw: string): string {
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return raw.substring(firstBrace, lastBrace + 1);
    }

    return raw;
  }

  /**
   * Build a rejected {@link CreationVerdict} with confidence 0.
   *
   * Used when the LLM call fails or returns unparseable output. By defaulting
   * to rejection, we ensure that system-level failures never accidentally
   * approve a tool.
   *
   * @param reasoning - Explanation of why the verdict defaulted to rejection.
   * @returns A rejected CreationVerdict.
   */
  private rejectedVerdict(reasoning: string): CreationVerdict {
    return {
      approved: false,
      confidence: 0,
      safety: 0,
      correctness: 0,
      determinism: 0,
      bounded: 0,
      reasoning,
    };
  }
}
