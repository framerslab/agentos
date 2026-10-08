/**
 * @file IEvaluator.ts
 * @description Interface for agent evaluation and benchmarking.
 *
 * Provides utilities for measuring agent performance across
 * accuracy, latency, cost, safety, and user satisfaction metrics.
 *
 * @module AgentOS/Evaluation
 * @version 1.0.0
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Evaluation metric types.
 */
export type MetricType =
  | 'accuracy'
  | 'latency'
  | 'cost'
  | 'safety'
  | 'relevance'
  | 'coherence'
  | 'helpfulness'
  | 'custom';

/**
 * A single metric measurement.
 */
export interface MetricValue {
  /** Metric name */
  name: string;
  /** Metric type */
  type: MetricType;
  /** Numeric value (0-1 for normalized, raw otherwise) */
  value: number;
  /** Whether value is normalized (0-1) */
  normalized: boolean;
  /** Unit of measurement */
  unit?: string;
  /** Confidence in the measurement (0-1) */
  confidence?: number;
  /** Timestamp */
  timestamp: string;
  /** Additional context */
  metadata?: Record<string, unknown>;
}

/**
 * A test case for evaluation.
 */
export interface EvalTestCase {
  /** Unique test case ID */
  id: string;
  /** Test case name */
  name: string;
  /** Category or tag */
  category?: string;
  /** Input to the agent */
  input: string;
  /** Expected output (for comparison) */
  expectedOutput?: string;
  /** Reference outputs for similarity comparison */
  referenceOutputs?: string[];
  /** Context or system prompt */
  context?: string;
  /** Expected tool calls */
  expectedToolCalls?: Array<{
    toolName: string;
    args?: Record<string, unknown>;
  }>;
  /** Evaluation criteria */
  criteria?: EvalCriteria[];
  /** Metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Evaluation criteria for a test case.
 */
export interface EvalCriteria {
  /** Criteria name */
  name: string;
  /** Description */
  description: string;
  /** Weight in final score (0-1) */
  weight: number;
  /** Scoring function name */
  scorer: string;
  /** Minimum passing score */
  threshold?: number;
}

/**
 * Result of a single test case evaluation.
 */
export interface EvalTestResult {
  /** Test case ID */
  testCaseId: string;
  /** Test case name */
  testCaseName: string;
  /** Whether the test passed */
  passed: boolean;
  /** Overall score (0-1) */
  score: number;
  /** Individual metric scores */
  metrics: MetricValue[];
  /** Actual agent output */
  actualOutput: string;
  /** Expected output */
  expectedOutput?: string;
  /** Latency in ms */
  latencyMs: number;
  /** Token usage */
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Estimated cost */
  costUsd?: number;
  /** Error if any */
  error?: string;
  /** Timestamp */
  timestamp: string;
}

/**
 * A complete evaluation run.
 */
export interface EvalRun {
  /** Run ID */
  runId: string;
  /** Run name/description */
  name: string;
  /** Agent or persona being evaluated */
  agentId?: string;
  personaId?: string;
  /** Model being used */
  modelId?: string;
  /** Timestamp started */
  startedAt: string;
  /** Timestamp completed */
  completedAt?: string;
  /** Status */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** Individual test results */
  results: EvalTestResult[];
  /** Aggregate metrics */
  aggregateMetrics: AggregateMetrics;
  /** Configuration used */
  config?: EvalConfig;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Aggregate metrics across a run.
 */
export interface AggregateMetrics {
  /** Total test cases */
  totalTests: number;
  /** Passed tests */
  passedTests: number;
  /** Failed tests */
  failedTests: number;
  /** Pass rate (0-1) */
  passRate: number;
  /** Average score (0-1) */
  avgScore: number;
  /** Score standard deviation */
  scoreStdDev: number;
  /** Average latency ms */
  avgLatencyMs: number;
  /** P50 latency */
  p50LatencyMs: number;
  /** P95 latency */
  p95LatencyMs: number;
  /** P99 latency */
  p99LatencyMs: number;
  /** Total tokens used */
  totalTokens: number;
  /** Total estimated cost */
  totalCostUsd: number;
  /** Metrics by category */
  byCategory?: Record<string, {
    passRate: number;
    avgScore: number;
    count: number;
  }>;
}

/**
 * Configuration for an evaluation run.
 */
export interface EvalConfig {
  /** Maximum concurrent evaluations */
  concurrency?: number;
  /** Timeout per test case (ms) */
  timeoutMs?: number;
  /** Number of retries on failure */
  retries?: number;
  /** Whether to continue on error */
  continueOnError?: boolean;
  /** Scoring thresholds */
  thresholds?: {
    pass?: number;
    warn?: number;
  };
  /** Custom scorers */
  customScorers?: Record<string, ScorerFunction>;
}

/**
 * Scorer function type.
 */
export type ScorerFunction = (
  actual: string,
  expected: string | undefined,
  references: string[] | undefined,
  metadata?: Record<string, unknown>,
) => Promise<number> | number;

/**
 * Built-in scorer names.
 */
export type BuiltInScorer =
  | 'exact_match'
  | 'contains'
  | 'levenshtein'
  | 'semantic_similarity'
  | 'bleu'
  | 'rouge'
  | 'word_error_rate'
  | 'llm_judge';

// ============================================================================
// Interface
// ============================================================================

/**
 * Interface for the agent evaluator.
 *
 * @example
 * ```typescript
 * const evaluator = new Evaluator();
 *
 * // Create test suite
 * const testCases: EvalTestCase[] = [
 *   {
 *     id: 'greet-1',
 *     name: 'Basic greeting',
 *     input: 'Hello!',
 *     expectedOutput: 'Hello! How can I help you today?',
 *     criteria: [
 *       { name: 'relevance', description: 'Is greeting appropriate', weight: 0.5, scorer: 'llm_judge' },
 *       { name: 'politeness', description: 'Is response polite', weight: 0.5, scorer: 'contains' },
 *     ],
 *   },
 * ];
 *
 * // Run evaluation
 * const run = await evaluator.runEvaluation('greeting-test', testCases, agentFn);
 * console.log(`Pass rate: ${run.aggregateMetrics.passRate * 100}%`);
 * ```
 */
export interface IEvaluator {
  /**
   * Runs an evaluation suite against an agent.
   * @param name - Name for this evaluation run
   * @param testCases - Test cases to evaluate
   * @param agentFn - Function that takes input and returns agent output
   * @param config - Evaluation configuration
   * @returns The completed evaluation run
   */
  runEvaluation(
    name: string,
    testCases: EvalTestCase[],
    agentFn: (input: string, context?: string) => Promise<string>,
    config?: EvalConfig,
  ): Promise<EvalRun>;

  /**
   * Evaluates a single test case.
   * @param testCase - The test case
   * @param actualOutput - The agent's actual output
   * @param config - Evaluation configuration
   * @returns Test result
   */
  evaluateTestCase(
    testCase: EvalTestCase,
    actualOutput: string,
    config?: EvalConfig,
  ): Promise<EvalTestResult>;

  /**
   * Scores output using a specific scorer.
   * @param scorer - Scorer name
   * @param actual - Actual output
   * @param expected - Expected output
   * @param references - Reference outputs
   * @returns Score (0-1)
   */
  score(
    scorer: BuiltInScorer | string,
    actual: string,
    expected?: string,
    references?: string[],
  ): Promise<number>;

  /**
   * Registers a custom scorer.
   * @param name - Scorer name
   * @param fn - Scoring function
   */
  registerScorer(name: string, fn: ScorerFunction): void;

  /**
   * Gets an evaluation run by ID.
   * @param runId - Run ID
   * @returns The evaluation run or undefined
   */
  getRun(runId: string): Promise<EvalRun | undefined>;

  /**
   * Lists recent evaluation runs.
   * @param limit - Maximum runs to return
   * @returns Array of runs
   */
  listRuns(limit?: number): Promise<EvalRun[]>;

  /**
   * Compares two evaluation runs.
   * @param runId1 - First run ID
   * @param runId2 - Second run ID
   * @returns Comparison results
   */
  compareRuns(runId1: string, runId2: string): Promise<EvalComparison>;

  /**
   * Generates a report for a run.
   * @param runId - Run ID
   * @param format - Report format
   * @returns Report content
   */
  generateReport(runId: string, format: 'json' | 'markdown' | 'html'): Promise<string>;
}

/**
 * Comparison between two evaluation runs.
 */
export interface EvalComparison {
  run1Id: string;
  run2Id: string;
  metrics: Array<{
    name: string;
    run1Value: number;
    run2Value: number;
    delta: number;
    percentChange: number;
    improved: boolean;
  }>;
  summary: {
    improved: number;
    regressed: number;
    unchanged: number;
  };
}



