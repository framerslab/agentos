/**
 * @fileoverview QueryGenerator — tier-appropriate prompt construction and LLM
 * answer generation for the QueryRouter pipeline.
 *
 * The generator is the final stage of the routing pipeline: it takes the
 * classified {@link QueryTier}, a set of {@link RetrievedChunk}s from the
 * retrieval phase, and an optional research synthesis narrative, then builds
 * a tier-specific system prompt and invokes the LLM via {@link generateText}.
 *
 * **Tier-specific behaviour:**
 *
 * | Tier | Model   | Context | Temperature | Max Tokens | Instruction                                        |
 * |------|---------|---------|-------------|------------|----------------------------------------------------|
 * | T0   | standard| none    | 0.7         | 512        | (base prompt only)                                 |
 * | T1   | standard| chunks  | 0.3         | 512        | "Answer based on the documentation context provided."|
 * | T2   | deep    | chunks  | 0.3         | 1024       | "cross-reference" sources                          |
 * | T3   | deep    | chunks + research | 0.3 | 1024   | "Synthesize information from both internal documentation and external research." |
 *
 * **Context injection:**
 * Each chunk is formatted as `## heading (sourcePath)\ncontent` and appended
 * until the estimated token budget (`maxContextTokens`) is exhausted. Token
 * estimation uses the common heuristic of `Math.ceil(text.length / 4)`.
 *
 * @module @framers/agentos/query-router/QueryGenerator
 */

import { generateText } from '../../../api/generateText.js';
import type { QueryTier, RetrievedChunk } from './types.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for the {@link QueryGenerator}.
 */
export interface QueryGeneratorConfig {
  /**
   * Model identifier for T0 and T1 queries (standard complexity).
   * @example 'openai:gpt-4.1-mini'
   */
  model: string;

  /**
   * Model identifier for T2 and T3 queries (deep reasoning).
   * @example 'openai:gpt-4.1'
   */
  modelDeep: string;

  /**
   * LLM provider name (e.g. 'openai', 'anthropic').
   */
  provider: string;

  /**
   * Optional API key override. When omitted, the provider resolves
   * credentials from environment variables.
   */
  apiKey?: string;

  /**
   * Optional base URL override for local proxies or alternative endpoints.
   */
  baseUrl?: string;

  /**
   * Maximum number of estimated tokens to allocate for documentation
   * context in the system prompt. Chunks are added in order until
   * this budget is exhausted.
   * @default 4000
   */
  maxContextTokens?: number;
}

// ============================================================================
// Result type
// ============================================================================

/**
 * Structured result returned by {@link QueryGenerator.generate}.
 */
export interface GenerateResult {
  /** The generated answer text. */
  answer: string;

  /** The model identifier that was actually used for generation. */
  model: string;

  /** Token usage figures reported by the provider. */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Base system prompt injected into every generation call regardless of tier.
 * Establishes the assistant's persona and ground rules.
 */
const BASE_SYSTEM_PROMPT =
  'You are a knowledgeable AI assistant for an autonomous agent platform. ' +
  'Answer questions accurately and concisely. If you don\'t know something, ' +
  'say so \u2014 do not make things up.';

/** Default maximum context tokens when not specified in config. */
const DEFAULT_MAX_CONTEXT_TOKENS = 4000;

// ============================================================================
// QueryGenerator
// ============================================================================

/**
 * Builds tier-appropriate prompts and generates LLM answers.
 *
 * The generator selects a model (standard vs. deep) based on the query tier,
 * constructs a system prompt with optional documentation context and research
 * synthesis, then delegates to {@link generateText} for the actual LLM call.
 *
 * @example
 * ```typescript
 * const gen = new QueryGenerator({
 *   model: 'openai:gpt-4.1-mini',
 *   modelDeep: 'openai:gpt-4.1',
 *   provider: 'openai',
 * });
 *
 * const result = await gen.generate('How does auth work?', 1, chunks);
 * console.log(result.answer);
 * ```
 */
export class QueryGenerator {
  /** Resolved configuration with defaults applied. */
  private readonly config: Required<Pick<QueryGeneratorConfig, 'model' | 'modelDeep' | 'provider' | 'maxContextTokens'>> &
    Pick<QueryGeneratorConfig, 'apiKey' | 'baseUrl'>;

  /**
   * Create a new QueryGenerator instance.
   *
   * @param config - Generator configuration specifying models, provider,
   *                 and optional credential overrides.
   */
  constructor(config: QueryGeneratorConfig) {
    this.config = {
      model: config.model,
      modelDeep: config.modelDeep,
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      maxContextTokens: config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
    };
  }

  /**
   * Generate an answer for the given query at the specified complexity tier.
   *
   * @param query - The user's original question.
   * @param tier - The classified complexity tier (0–3).
   * @param chunks - Retrieved documentation chunks, sorted by relevance.
   * @param researchSynthesis - Optional research narrative (T3 only).
   * @returns A promise resolving to the generated answer, model used, and token usage.
   */
  async generate(
    query: string,
    tier: QueryTier,
    chunks: RetrievedChunk[],
    researchSynthesis?: string,
  ): Promise<GenerateResult> {
    const model = this.selectModel(tier);
    const temperature = this.selectTemperature(tier);
    const maxTokens = this.selectMaxTokens(tier);
    const systemPrompt = this.buildSystemPrompt(tier, chunks, researchSynthesis);

    const result = await generateText({
      model,
      provider: this.config.provider,
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      system: systemPrompt,
      prompt: query,
      temperature,
      maxTokens,
      // The answer gets all of the 512 or 1024 tokens only when none of them go
      // to thinking: Claude Haiku 5.5 and Claude Sonnet 5.5, the Anthropic
      // models of both tiers, think unless told not to, and their thinking
      // counts against maxTokens. Each model turns it off in its own shape
      // (model-thinking.ts); models that do not think by default, and other
      // providers, ignore the switch.
      thinking: false,
    });

    return {
      answer: result.text,
      model,
      usage: {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Private — Model / parameter selection
  // --------------------------------------------------------------------------

  /**
   * Select the appropriate model based on query tier.
   * T0–T1 use the standard model; T2–T3 use the deep model.
   *
   * @param tier - The classified query tier.
   * @returns The model identifier string.
   */
  private selectModel(tier: QueryTier): string {
    return tier >= 2 ? this.config.modelDeep : this.config.model;
  }

  /**
   * Select the sampling temperature for the given tier.
   * T0 uses a higher temperature (0.7) for more creative general answers;
   * all other tiers use 0.3 for focused, grounded responses.
   *
   * @param tier - The classified query tier.
   * @returns The temperature value.
   */
  private selectTemperature(tier: QueryTier): number {
    return tier === 0 ? 0.7 : 0.3;
  }

  /**
   * Select the maximum output tokens for the given tier.
   * T0–T1 cap at 512 tokens; T2–T3 allow 1024 for more detailed answers.
   *
   * @param tier - The classified query tier.
   * @returns The maxTokens value.
   */
  private selectMaxTokens(tier: QueryTier): number {
    return tier >= 2 ? 1024 : 512;
  }

  // --------------------------------------------------------------------------
  // Private — System prompt construction
  // --------------------------------------------------------------------------

  /**
   * Build the full system prompt by composing the base prompt with optional
   * tier-specific context blocks and instructions.
   *
   * @param tier - The classified query tier.
   * @param chunks - Retrieved documentation chunks.
   * @param researchSynthesis - Optional research narrative for T3.
   * @returns The assembled system prompt string.
   */
  private buildSystemPrompt(
    tier: QueryTier,
    chunks: RetrievedChunk[],
    researchSynthesis?: string,
  ): string {
    const parts: string[] = [BASE_SYSTEM_PROMPT];

    // Inject documentation context for T1+
    if (tier >= 1 && chunks.length > 0) {
      const contextBlock = this.formatChunksAsContext(chunks);
      if (contextBlock) {
        parts.push(`\nDocumentation context:\n${contextBlock}`);
      }
    }

    // Inject research synthesis for T3
    if (tier === 3 && researchSynthesis) {
      parts.push(`\nExternal research findings:\n${researchSynthesis}`);
    }

    // Append tier-specific instruction
    const instruction = this.getTierInstruction(tier);
    if (instruction) {
      parts.push(`\n${instruction}`);
    }

    return parts.join('\n');
  }

  /**
   * Format retrieved chunks into a documentation context block, respecting
   * the configured token budget.
   *
   * Each chunk is formatted as:
   * ```
   * ## heading (sourcePath)
   * content
   * ```
   *
   * Chunks are added in the order provided (typically by relevance) until the
   * estimated token count would exceed `maxContextTokens`.
   *
   * @param chunks - The retrieved chunks to format.
   * @returns The formatted context string, or an empty string if no chunks fit.
   */
  private formatChunksAsContext(chunks: RetrievedChunk[]): string {
    const entries: string[] = [];
    let tokenCount = 0;

    for (const chunk of chunks) {
      const entry = `## ${chunk.heading} (${chunk.sourcePath})\n${chunk.content}`;
      const entryTokens = this.estimateTokens(entry);

      if (tokenCount + entryTokens > this.config.maxContextTokens) {
        break;
      }

      entries.push(entry);
      tokenCount += entryTokens;
    }

    return entries.join('\n\n');
  }

  /**
   * Return the tier-specific instruction appended to the system prompt.
   *
   * @param tier - The classified query tier.
   * @returns The instruction string, or `undefined` for T0 (no extra instruction).
   */
  private getTierInstruction(tier: QueryTier): string | undefined {
    switch (tier) {
      case 0:
        return undefined;
      case 1:
        return 'Answer based on the documentation context provided.';
      case 2:
        return 'Answer based on the documentation context provided. ' +
          'Where possible, cross-reference multiple sources to provide a comprehensive answer.';
      case 3:
        return 'Synthesize information from both internal documentation and external research. ' +
          'Where possible, cross-reference multiple sources to provide a comprehensive answer.';
      default:
        return undefined;
    }
  }

  /**
   * Estimate the token count for a string using the common heuristic of
   * approximately 4 characters per token.
   *
   * @param text - The text to estimate.
   * @returns Estimated token count (ceiling).
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
