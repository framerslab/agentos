/**
 * @file StructuredOutputManager.ts
 * @description Implementation of the Structured Output Manager for AgentOS.
 *
 * Provides robust JSON Schema validation, structured generation strategies,
 * and parallel function calling capabilities. Handles the complexity of
 * different LLM provider APIs and output formats.
 *
 * @module AgentOS/Structured
 * @version 1.0.0
 */

import type { ILogger } from '../../../core/logging/ILogger';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import type { ChatMessage } from '../../../core/llm/providers/IProvider';
import {
  IStructuredOutputManager,
  JSONSchema,
  StructuredGenerationOptions,
  StructuredGenerationResult,
  ParallelFunctionCallOptions,
  ParallelFunctionCallResult,
  FunctionCallResult,
  EntityExtractionOptions,
  EntityExtractionResult,
  ValidationIssue,
  StructuredOutputStats,
  StructuredOutputStrategy,
  StructuredOutputError,
} from './IStructuredOutputManager';

/** Standard JSON Schema type values */
type JSONSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/** Token usage type for structured output results */
type TokenUsage = { promptTokens: number; completionTokens: number; totalTokens: number };

/** Convert ModelUsage to TokenUsage */
function convertUsage(usage?: { promptTokens?: number; completionTokens?: number; totalTokens: number }): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.promptTokens ?? 0,
    completionTokens: usage.completionTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  };
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration options for the Structured Output Manager.
 */
export interface StructuredOutputManagerConfig {
  /** LLM provider manager for making requests */
  llmProviderManager: AIModelProviderManager;

  /** Default provider ID */
  defaultProviderId?: string;

  /** Default model ID */
  defaultModelId?: string;

  /** Default max retries */
  defaultMaxRetries?: number;

  /** Default timeout in milliseconds */
  defaultTimeoutMs?: number;

  /** Logger instance */
  logger?: ILogger;
}

/**
 * Provider capabilities for strategy selection.
 */
interface ProviderCapabilities {
  supportsJsonMode: boolean;
  supportsFunctionCalling: boolean;
  supportsParallelCalls: boolean;
  supportsStrictMode: boolean;
  maxFunctionsPerCall: number;
}

/**
 * Known provider capabilities.
 */
const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  openai: {
    supportsJsonMode: true,
    supportsFunctionCalling: true,
    supportsParallelCalls: true,
    supportsStrictMode: true,
    maxFunctionsPerCall: 128,
  },
  anthropic: {
    supportsJsonMode: false,
    supportsFunctionCalling: true,
    supportsParallelCalls: true,
    supportsStrictMode: false,
    maxFunctionsPerCall: 64,
  },
  openrouter: {
    supportsJsonMode: true,
    supportsFunctionCalling: true,
    supportsParallelCalls: true,
    supportsStrictMode: false,
    maxFunctionsPerCall: 64,
  },
  ollama: {
    supportsJsonMode: true,
    supportsFunctionCalling: false,
    supportsParallelCalls: false,
    supportsStrictMode: false,
    maxFunctionsPerCall: 0,
  },
  default: {
    supportsJsonMode: false,
    supportsFunctionCalling: false,
    supportsParallelCalls: false,
    supportsStrictMode: false,
    maxFunctionsPerCall: 0,
  },
};

// ============================================================================
// Implementation
// ============================================================================

/**
 * Structured Output Manager implementation.
 *
 * Provides comprehensive structured output capabilities including:
 * - JSON Schema validation with detailed error reporting
 * - Multiple generation strategies (JSON mode, function calling, prompt engineering)
 * - Automatic retry with feedback on validation failures
 * - Parallel function calling with argument validation
 * - Entity extraction from unstructured text
 * - Robust JSON parsing with error recovery
 *
 * @implements {IStructuredOutputManager}
 */
export class StructuredOutputManager implements IStructuredOutputManager {
  private readonly llmProviderManager: AIModelProviderManager;
  private readonly defaultProviderId: string;
  private readonly defaultModelId: string;
  private readonly defaultMaxRetries: number;
  private readonly defaultTimeoutMs: number;
  private logger?: ILogger;

  /** Registered schemas for reuse */
  private readonly schemas = new Map<string, JSONSchema>();

  /** Statistics tracking */
  private stats: StructuredOutputStats = {
    totalGenerations: 0,
    successfulGenerations: 0,
    successRate: 0,
    avgRetries: 0,
    avgLatencyMs: 0,
    byStrategy: {
      json_mode: 0,
      function_calling: 0,
      grammar: 0,
      prompt_engineering: 0,
      auto: 0,
    },
    topValidationErrors: [],
    totalTokensUsed: 0,
  };

  private totalRetries = 0;
  private totalLatencyMs = 0;
  private validationErrorCounts = new Map<string, number>();

  /**
   * Creates a new StructuredOutputManager instance.
   *
   * @param config - Configuration options
   */
  constructor(config: StructuredOutputManagerConfig) {
    this.llmProviderManager = config.llmProviderManager;
    this.defaultProviderId = config.defaultProviderId || 'openai';
    this.defaultModelId = config.defaultModelId || 'gpt-4o';
    this.defaultMaxRetries = config.defaultMaxRetries ?? 3;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 30000;
    this.logger = config.logger;
  }

  /**
   * Initializes the manager.
   */
  public async initialize(logger?: ILogger): Promise<void> {
    this.logger = logger || this.logger;
    this.logger?.info?.('StructuredOutputManager initialized');
  }

  /**
   * Generates structured output conforming to the given schema.
   */
  public async generate<T = unknown>(
    options: StructuredGenerationOptions,
  ): Promise<StructuredGenerationResult<T>> {
    const startTime = Date.now();
    this.stats.totalGenerations++;

    const providerId = options.providerId || this.defaultProviderId;
    const modelId = options.modelId || this.defaultModelId;
    const maxRetries = options.maxRetries ?? this.defaultMaxRetries;
    const strategy = options.strategy === 'auto' || !options.strategy
      ? this.recommendStrategy(providerId, modelId, options.schema)
      : options.strategy;

    this.stats.byStrategy[strategy]++;

    this.logger?.debug?.('Starting structured generation', {
      schemaName: options.schemaName,
      strategy,
      providerId,
      modelId,
    });

    let lastResult: StructuredGenerationResult<T> | undefined;
    let retryCount = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.executeGeneration<T>(options, strategy, providerId, modelId, attempt);

        if (result.success) {
          this.stats.successfulGenerations++;
          this.totalRetries += retryCount;
          this.totalLatencyMs += Date.now() - startTime;
          this.updateStats();

          return {
            ...result,
            retryCount,
            latencyMs: Date.now() - startTime,
          };
        }

        lastResult = result;
        retryCount++;

        // Track validation errors
        result.validationErrors?.forEach(err => {
          const count = this.validationErrorCounts.get(err.keyword) || 0;
          this.validationErrorCounts.set(err.keyword, count + 1);
        });

        this.logger?.warn?.('Structured generation validation failed, retrying', {
          attempt,
          errors: result.validationErrors?.map(e => e.message),
        });
      } catch (error) {
        this.logger?.error?.('Structured generation error', {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });

        if (attempt === maxRetries) {
          throw error;
        }
      }
    }

    // All retries exhausted
    this.totalRetries += retryCount;
    this.totalLatencyMs += Date.now() - startTime;
    this.updateStats();

    const finalResult: StructuredGenerationResult<T> = lastResult || {
      success: false,
      rawOutput: '',
      strategyUsed: strategy,
      retryCount,
      latencyMs: Date.now() - startTime,
      modelId,
      providerId,
    };

    throw new StructuredOutputError(
      `Failed to generate valid structured output after ${maxRetries} retries`,
      finalResult.validationErrors || [],
      finalResult.rawOutput,
      retryCount,
      strategy,
    );
  }

  /**
   * Executes a single generation attempt.
   */
  private async executeGeneration<T>(
    options: StructuredGenerationOptions,
    strategy: StructuredOutputStrategy,
    providerId: string,
    modelId: string,
    attempt: number,
  ): Promise<StructuredGenerationResult<T>> {
    const messages = this.buildMessages(options, strategy, attempt);

    // Build LLM request options based on strategy
    const llmOptions: Record<string, unknown> = {
      temperature: options.temperature ?? 0.1,
      maxTokens: options.maxTokens,
    };

    if (strategy === 'json_mode') {
      llmOptions.responseFormat = { type: 'json_object' };
    } else if (strategy === 'function_calling') {
      llmOptions.tools = [
        {
          type: 'function',
          function: {
            name: options.schemaName,
            description: options.schemaDescription || `Generate ${options.schemaName}`,
            parameters: options.schema,
            strict: options.strict,
          },
        },
      ];
      llmOptions.toolChoice = { type: 'function', function: { name: options.schemaName } };
    }

    // Make LLM call
    const provider = this.llmProviderManager.getProvider(providerId);
    if (!provider) {
      throw new StructuredOutputError(`Provider "${providerId}" not found`, [], '', 0, strategy);
    }
    const completion = await provider.generateCompletion(modelId, messages, llmOptions);
    const firstChoice = completion.choices?.[0];

    // Extract output based on strategy
    let rawOutput: string;
    let reasoning: string | undefined;

    if (strategy === 'function_calling' && firstChoice?.message?.tool_calls?.length) {
      rawOutput = firstChoice.message.tool_calls[0].function.arguments;
    } else {
      const content = firstChoice?.message?.content;
      rawOutput = typeof content === 'string' ? content : '';

      // Extract reasoning if present
      if (options.includeReasoning) {
        const reasoningMatch = rawOutput.match(/<reasoning>([\s\S]*?)<\/reasoning>/);
        if (reasoningMatch) {
          reasoning = reasoningMatch[1].trim();
          rawOutput = rawOutput.replace(/<reasoning>[\s\S]*?<\/reasoning>/, '').trim();
        }
      }
    }

    // Parse JSON
    const parsed = this.parseJSON(rawOutput);

    if (parsed === null) {
      return {
        success: false,
        rawOutput,
        validationErrors: [
          {
            path: '',
            message: 'Failed to parse JSON from output',
            keyword: 'parse',
            severity: 'error',
          },
        ],
        strategyUsed: strategy,
        retryCount: attempt,
        latencyMs: 0,
        reasoning,
        modelId,
        providerId,
        tokenUsage: convertUsage(completion.usage),
      };
    }

    // Validate against schema
    const validationErrors = this.validate(parsed, options.schema, options.strict);

    // Run custom validator if provided
    if (options.customValidator && validationErrors.length === 0) {
      const customErrors = options.customValidator(parsed);
      validationErrors.push(...customErrors);
    }

    if (validationErrors.length > 0) {
      return {
        success: false,
        rawOutput,
        validationErrors,
        strategyUsed: strategy,
        retryCount: attempt,
        latencyMs: 0,
        reasoning,
        modelId,
        providerId,
        tokenUsage: convertUsage(completion.usage),
      };
    }

    // Track tokens
    if (completion.usage) {
      this.stats.totalTokensUsed += completion.usage.totalTokens || 0;
    }

    return {
      success: true,
      data: parsed as T,
      rawOutput,
      strategyUsed: strategy,
      retryCount: attempt,
      latencyMs: 0,
      reasoning,
      modelId,
      providerId,
      tokenUsage: convertUsage(completion.usage),
    };
  }

  /**
   * Builds messages for the LLM request.
   */
  private buildMessages(
    options: StructuredGenerationOptions,
    strategy: StructuredOutputStrategy,
    attempt: number,
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // System prompt
    let systemPrompt = options.systemPrompt || '';

    if (strategy === 'json_mode' || strategy === 'prompt_engineering') {
      systemPrompt += `\n\nYou must respond with valid JSON that conforms to this schema:\n${JSON.stringify(options.schema, null, 2)}`;

      if (options.includeReasoning) {
        systemPrompt += '\n\nBefore the JSON, you may include your reasoning wrapped in <reasoning></reasoning> tags.';
      }

      systemPrompt += '\n\nRespond ONLY with the JSON (and optional reasoning). No other text.';
    }

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt.trim() });
    }

    // User prompt
    if (typeof options.prompt === 'string') {
      messages.push({ role: 'user', content: options.prompt });
    } else {
      messages.push(...options.prompt.map(m => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      })));
    }

    // Add retry feedback if this is a retry
    if (attempt > 0) {
      messages.push({
        role: 'user',
        content: `Your previous response did not conform to the required schema. Please try again, ensuring the output is valid JSON matching the schema exactly.`,
      });
    }

    return messages;
  }

  /**
   * Generates parallel function/tool calls.
   */
  public async generateFunctionCalls(
    options: ParallelFunctionCallOptions,
  ): Promise<ParallelFunctionCallResult> {
    const startTime = Date.now();
    const providerId = options.providerId || this.defaultProviderId;
    const modelId = options.modelId || this.defaultModelId;

    const capabilities = PROVIDER_CAPABILITIES[providerId] || PROVIDER_CAPABILITIES.default;

    if (!capabilities.supportsFunctionCalling) {
      throw new Error(`Provider ${providerId} does not support function calling`);
    }

    // Build messages
    const messages: ChatMessage[] = typeof options.prompt === 'string'
      ? [{ role: 'user', content: options.prompt }]
      : options.prompt.map(m => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content }));

    // Build tools
    const tools = options.functions.map(fn => ({
      type: 'function' as const,
      function: {
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
      },
    }));

    // Make LLM call
    const provider = this.llmProviderManager.getProvider(providerId);
    if (!provider) {
      throw new StructuredOutputError(`Provider "${providerId}" not found`, [], '', 0, 'function_calling');
    }
    const completion = await provider.generateCompletion(modelId, messages, {
      tools,
      toolChoice: options.toolChoice || 'auto',
      temperature: 0.1,
    });
    const toolCalls = completion.choices?.[0]?.message?.tool_calls;

    // Process tool calls
    const calls: FunctionCallResult[] = [];

    if (toolCalls) {
      for (const toolCall of toolCalls) {
        const fn = options.functions.find(f => f.name === toolCall.function.name);
        const args = this.parseJSON(toolCall.function.arguments) as Record<string, unknown> || {};

        // Validate arguments
        let validationErrors: ValidationIssue[] = [];
        if (fn) {
          // Use non-strict validation for function arguments by default
          // to allow providers to add extra metadata
          validationErrors = this.validate(args, fn.parameters, false);
        }

        const callResult: FunctionCallResult = {
          functionName: toolCall.function.name,
          arguments: args,
          argumentsValid: validationErrors.length === 0,
          validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
          callId: toolCall.id || `call-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        };

        // Execute handler if provided and arguments are valid
        if (fn?.handler && callResult.argumentsValid) {
          try {
            callResult.executionResult = await fn.handler(args);
          } catch (error) {
            callResult.executionError = error instanceof Error ? error.message : String(error);
          }
        }

        calls.push(callResult);
      }
    }

    const textContent = completion.choices?.[0]?.message?.content;
    return {
      success: calls.every(c => c.argumentsValid && !c.executionError),
      calls,
      textContent: typeof textContent === 'string' ? textContent : undefined,
      tokenUsage: convertUsage(completion.usage),
      latencyMs: Date.now() - startTime,
      modelId,
      providerId,
    };
  }

  /**
   * Extracts structured entities from unstructured text.
   */
  public async extractEntities<T = unknown>(
    options: EntityExtractionOptions,
  ): Promise<EntityExtractionResult<T>> {
    const providerId = options.providerId || this.defaultProviderId;
    const modelId = options.modelId || this.defaultModelId;

    // Build extraction schema
    const extractionSchema: JSONSchema = options.extractAll
      ? {
          type: 'object',
          properties: {
            entities: {
              type: 'array',
              items: options.entitySchema,
              description: 'List of extracted entities',
            },
          },
          required: ['entities'],
        }
      : {
          type: 'object',
          properties: {
            entity: options.entitySchema,
            found: { type: 'boolean', description: 'Whether an entity was found' },
          },
          required: ['found'],
        };

    // Build prompt
    let prompt = `Extract ${options.taskName} from the following text:\n\n"${options.text}"`;

    if (options.instructions) {
      prompt += `\n\nInstructions: ${options.instructions}`;
    }

    if (options.examples && options.examples.length > 0) {
      prompt += '\n\nExamples:\n';
      options.examples.forEach((ex, i) => {
        prompt += `\nExample ${i + 1}:\nInput: "${ex.input}"\nOutput: ${JSON.stringify(ex.output)}\n`;
      });
    }

    try {
      const result = await this.generate<Record<string, unknown>>({
        prompt,
        schema: extractionSchema,
        schemaName: `${options.taskName}Extraction`,
        providerId,
        modelId,
        temperature: 0.1,
      });

      if (!result.success) {
        return {
          success: false,
          entities: [],
          issues: result.validationErrors?.map(e => e.message),
          tokenUsage: result.tokenUsage,
        };
      }

      const entities = options.extractAll
        ? (result.data?.entities as T[]) || []
        : result.data?.found
        ? [result.data.entity as T]
        : [];

      return {
        success: true,
        entities,
        tokenUsage: result.tokenUsage,
      };
    } catch (error) {
      return {
        success: false,
        entities: [],
        issues: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  /**
   * Validates data against a JSON Schema.
   */
  public validate(data: unknown, schema: JSONSchema, strict?: boolean): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    this.validateValue(data, schema, '', issues, strict || false);
    return issues;
  }

  /**
   * Recursively validates a value against a schema.
   */
  private validateValue(
    value: unknown,
    schema: JSONSchema,
    path: string,
    issues: ValidationIssue[],
    strict: boolean,
  ): void {
    // Handle $ref
    if (schema.$ref) {
      const refName = schema.$ref.replace('#/$defs/', '');
      const refSchema = schema.$defs?.[refName] || this.schemas.get(refName);
      if (refSchema) {
        this.validateValue(value, refSchema, path, issues, strict);
        return;
      }
    }

    // Handle composition keywords
    if (schema.allOf) {
      schema.allOf.forEach((subSchema, i) => {
        this.validateValue(value, subSchema, `${path}/allOf[${i}]`, issues, strict);
      });
    }

    if (schema.anyOf) {
      const anyValid = schema.anyOf.some(subSchema => {
        const subIssues: ValidationIssue[] = [];
        this.validateValue(value, subSchema, path, subIssues, strict);
        return subIssues.length === 0;
      });

      if (!anyValid) {
        issues.push({
          path,
          message: 'Value does not match any of the allowed schemas',
          keyword: 'anyOf',
          severity: 'error',
        });
      }
    }

    if (schema.oneOf) {
      const validCount = schema.oneOf.filter(subSchema => {
        const subIssues: ValidationIssue[] = [];
        this.validateValue(value, subSchema, path, subIssues, strict);
        return subIssues.length === 0;
      }).length;

      if (validCount !== 1) {
        issues.push({
          path,
          message: `Value must match exactly one schema, but matched ${validCount}`,
          keyword: 'oneOf',
          severity: 'error',
        });
      }
    }

    // Type validation
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];

      if (!this.matchesType(value, types)) {
        const actualType = this.getJSONType(value);
        issues.push({
          path,
          message: `Expected type ${types.join(' or ')}, got ${actualType}`,
          keyword: 'type',
          expected: types,
          actual: actualType,
          severity: 'error',
        });
        return; // Don't continue validation if type is wrong
      }
    }

    // Enum validation
    if (schema.enum !== undefined) {
      if (!schema.enum.includes(value)) {
        issues.push({
          path,
          message: `Value must be one of: ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`,
          keyword: 'enum',
          expected: schema.enum,
          actual: value,
          severity: 'error',
        });
      }
    }

    // Const validation
    if (schema.const !== undefined) {
      if (value !== schema.const) {
        issues.push({
          path,
          message: `Value must be exactly ${JSON.stringify(schema.const)}`,
          keyword: 'const',
          expected: schema.const,
          actual: value,
          severity: 'error',
        });
      }
    }

    // String validations
    if (typeof value === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        issues.push({
          path,
          message: `String must be at least ${schema.minLength} characters`,
          keyword: 'minLength',
          expected: schema.minLength,
          actual: value.length,
          severity: 'error',
        });
      }

      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        issues.push({
          path,
          message: `String must be at most ${schema.maxLength} characters`,
          keyword: 'maxLength',
          expected: schema.maxLength,
          actual: value.length,
          severity: 'error',
        });
      }

      if (schema.pattern) {
        const regex = new RegExp(schema.pattern);
        if (!regex.test(value)) {
          issues.push({
            path,
            message: `String must match pattern: ${schema.pattern}`,
            keyword: 'pattern',
            expected: schema.pattern,
            actual: value,
            severity: 'error',
          });
        }
      }

      if (schema.format) {
        const formatValid = this.validateFormat(value, schema.format);
        if (!formatValid) {
          issues.push({
            path,
            message: `String must be a valid ${schema.format}`,
            keyword: 'format',
            expected: schema.format,
            actual: value,
            severity: 'error',
          });
        }
      }
    }

    // Number validations
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) {
        issues.push({
          path,
          message: `Value must be >= ${schema.minimum}`,
          keyword: 'minimum',
          expected: schema.minimum,
          actual: value,
          severity: 'error',
        });
      }

      if (schema.maximum !== undefined && value > schema.maximum) {
        issues.push({
          path,
          message: `Value must be <= ${schema.maximum}`,
          keyword: 'maximum',
          expected: schema.maximum,
          actual: value,
          severity: 'error',
        });
      }

      if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
        issues.push({
          path,
          message: `Value must be > ${schema.exclusiveMinimum}`,
          keyword: 'exclusiveMinimum',
          expected: schema.exclusiveMinimum,
          actual: value,
          severity: 'error',
        });
      }

      if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
        issues.push({
          path,
          message: `Value must be < ${schema.exclusiveMaximum}`,
          keyword: 'exclusiveMaximum',
          expected: schema.exclusiveMaximum,
          actual: value,
          severity: 'error',
        });
      }

      if (schema.multipleOf !== undefined && value % schema.multipleOf !== 0) {
        issues.push({
          path,
          message: `Value must be a multiple of ${schema.multipleOf}`,
          keyword: 'multipleOf',
          expected: schema.multipleOf,
          actual: value,
          severity: 'error',
        });
      }
    }

    // Array validations
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        issues.push({
          path,
          message: `Array must have at least ${schema.minItems} items`,
          keyword: 'minItems',
          expected: schema.minItems,
          actual: value.length,
          severity: 'error',
        });
      }

      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        issues.push({
          path,
          message: `Array must have at most ${schema.maxItems} items`,
          keyword: 'maxItems',
          expected: schema.maxItems,
          actual: value.length,
          severity: 'error',
        });
      }

      if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) {
        issues.push({
          path,
          message: 'Array items must be unique',
          keyword: 'uniqueItems',
          severity: 'error',
        });
      }

      // Validate items
      if (schema.items && !Array.isArray(schema.items)) {
        value.forEach((item, index) => {
          this.validateValue(item, schema.items as JSONSchema, `${path}[${index}]`, issues, strict);
        });
      }
    }

    // Object validations
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj);

      // Required properties
      if (schema.required) {
        schema.required.forEach(prop => {
          if (!(prop in obj)) {
            issues.push({
              path: path ? `${path}.${prop}` : prop,
              message: `Missing required property: ${prop}`,
              keyword: 'required',
              expected: prop,
              severity: 'error',
            });
          }
        });
      }

      // Property count
      if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
        issues.push({
          path,
          message: `Object must have at least ${schema.minProperties} properties`,
          keyword: 'minProperties',
          expected: schema.minProperties,
          actual: keys.length,
          severity: 'error',
        });
      }

      if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
        issues.push({
          path,
          message: `Object must have at most ${schema.maxProperties} properties`,
          keyword: 'maxProperties',
          expected: schema.maxProperties,
          actual: keys.length,
          severity: 'error',
        });
      }

      // Validate each property
      keys.forEach(key => {
        const propPath = path ? `${path}.${key}` : key;

        if (schema.properties?.[key]) {
          this.validateValue(obj[key], schema.properties[key], propPath, issues, strict);
        } else if (schema.patternProperties) {
          const matchingPattern = Object.keys(schema.patternProperties).find(pattern =>
            new RegExp(pattern).test(key),
          );
          if (matchingPattern) {
            this.validateValue(
              obj[key],
              schema.patternProperties[matchingPattern],
              propPath,
              issues,
              strict,
            );
          } else if (strict && schema.additionalProperties === false) {
            issues.push({
              path: propPath,
              message: `Additional property not allowed: ${key}`,
              keyword: 'additionalProperties',
              actual: key,
              severity: 'error',
            });
          }
        } else if (strict && schema.additionalProperties === false) {
          issues.push({
            path: propPath,
            message: `Additional property not allowed: ${key}`,
            keyword: 'additionalProperties',
            actual: key,
            severity: 'error',
          });
        } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          this.validateValue(obj[key], schema.additionalProperties, propPath, issues, strict);
        }
      });
    }
  }

  /**
   * Gets the JSON type of a value.
   * Note: In JSON Schema, 'integer' is a subset of 'number', so integers
   * should match both 'integer' and 'number' types.
   */
  private getJSONType(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number') {
      // Return 'integer' only if checking against integer type specifically
      // For general type checking, numbers (including integers) are 'number'
      return 'number';
    }
    return typeof value;
  }

  /**
   * Checks if a value matches the expected type(s).
   */
  private matchesType(value: unknown, expectedTypes: JSONSchemaType | JSONSchemaType[]): boolean {
    const types = Array.isArray(expectedTypes) ? expectedTypes : [expectedTypes];
    const actualType = typeof value;

    for (const type of types) {
      if (type === 'null' && value === null) return true;
      if (type === 'array' && Array.isArray(value)) return true;
      if (type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) return true;
      if (type === 'string' && actualType === 'string') return true;
      if (type === 'boolean' && actualType === 'boolean') return true;
      if (type === 'number' && actualType === 'number') return true;
      if (type === 'integer' && actualType === 'number' && Number.isInteger(value)) return true;
    }

    return false;
  }

  /**
   * Validates a string format.
   */
  private validateFormat(value: string, format: string): boolean {
    const formatValidators: Record<string, RegExp | ((v: string) => boolean)> = {
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      uri: /^https?:\/\/.+/,
      'uri-reference': /^(https?:\/\/|\/|\.\/|\.\.\/).*/,
      uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      'date-time': (v) => !isNaN(Date.parse(v)),
      date: /^\d{4}-\d{2}-\d{2}$/,
      time: /^\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/,
      hostname: /^[a-zA-Z0-9][a-zA-Z0-9-]*(\.[a-zA-Z0-9][a-zA-Z0-9-]*)*$/,
      ipv4: /^(\d{1,3}\.){3}\d{1,3}$/,
      ipv6: /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/,
      regex: (v) => {
        try {
          new RegExp(v);
          return true;
        } catch {
          return false;
        }
      },
    };

    const validator = formatValidators[format];
    if (!validator) return true; // Unknown format, pass

    if (typeof validator === 'function') {
      return validator(value);
    }
    return validator.test(value);
  }

  /**
   * Parses JSON string with error recovery.
   */
  public parseJSON(jsonString: string): unknown | null {
    if (!jsonString) return null;

    // Try direct parse first
    try {
      return JSON.parse(jsonString);
    } catch {
      // Continue to recovery methods
    }

    // Remove markdown code blocks
    let cleaned = jsonString
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    // Try parsing cleaned version
    try {
      return JSON.parse(cleaned);
    } catch {
      // Continue
    }

    // Extract JSON from surrounding text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    }

    // Fix common issues
    cleaned = cleaned
      // Remove trailing commas
      .replace(/,\s*([}\]])/g, '$1')
      // Fix single quotes to double quotes (careful with nested quotes)
      .replace(/'/g, '"')
      // Fix unquoted keys
      .replace(/(\{|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

    try {
      return JSON.parse(cleaned);
    } catch {
      this.logger?.warn?.('Failed to parse JSON after recovery attempts', {
        textLength: jsonString.length,
      });
      return null;
    }
  }

  /**
   * Recommends a strategy for the given provider/model.
   */
  public recommendStrategy(
    providerId: string,
    modelId: string,
    schema: JSONSchema,
  ): StructuredOutputStrategy {
    const capabilities = PROVIDER_CAPABILITIES[providerId] || PROVIDER_CAPABILITIES.default;

    // Complex schemas with nested objects work better with function calling
    const isComplex =
      schema.properties &&
      Object.values(schema.properties).some(
        (prop) => prop.type === 'object' || prop.type === 'array',
      );

    // Prefer function calling for complex schemas if supported
    if (isComplex && capabilities.supportsFunctionCalling) {
      return 'function_calling';
    }

    // Use JSON mode if available
    if (capabilities.supportsJsonMode) {
      return 'json_mode';
    }

    // Fall back to prompt engineering
    return 'prompt_engineering';
  }

  /**
   * Registers a schema for reuse.
   */
  public registerSchema(name: string, schema: JSONSchema): void {
    this.schemas.set(name, schema);
    this.logger?.debug?.(`Registered schema: ${name}`);
  }

  /**
   * Gets a registered schema.
   */
  public getSchema(name: string): JSONSchema | undefined {
    return this.schemas.get(name);
  }

  /**
   * Gets statistics about structured output operations.
   */
  public getStatistics(): StructuredOutputStats {
    return { ...this.stats };
  }

  /**
   * Resets statistics.
   */
  public resetStatistics(): void {
    this.stats = {
      totalGenerations: 0,
      successfulGenerations: 0,
      successRate: 0,
      avgRetries: 0,
      avgLatencyMs: 0,
      byStrategy: {
        json_mode: 0,
        function_calling: 0,
        grammar: 0,
        prompt_engineering: 0,
        auto: 0,
      },
      topValidationErrors: [],
      totalTokensUsed: 0,
    };
    this.totalRetries = 0;
    this.totalLatencyMs = 0;
    this.validationErrorCounts.clear();
  }

  /**
   * Updates derived statistics.
   */
  private updateStats(): void {
    this.stats.successRate =
      this.stats.totalGenerations > 0
        ? this.stats.successfulGenerations / this.stats.totalGenerations
        : 0;

    this.stats.avgRetries =
      this.stats.totalGenerations > 0
        ? this.totalRetries / this.stats.totalGenerations
        : 0;

    this.stats.avgLatencyMs =
      this.stats.totalGenerations > 0
        ? this.totalLatencyMs / this.stats.totalGenerations
        : 0;

    // Update top validation errors
    this.stats.topValidationErrors = Array.from(this.validationErrorCounts.entries())
      .map(([keyword, count]) => ({ keyword, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }
}

