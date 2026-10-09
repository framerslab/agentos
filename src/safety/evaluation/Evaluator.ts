/**
 * @file Evaluator.ts
 * @description Implementation of the agent evaluation framework.
 * @module AgentOS/Evaluation
 * @version 1.0.0
 */

import { v4 as uuidv4 } from 'uuid';
import {
  IEvaluator,
  EvalTestCase,
  EvalTestResult,
  EvalRun,
  EvalConfig,
  EvalComparison,
  AggregateMetrics,
  MetricValue,
  ScorerFunction,
  BuiltInScorer,
} from './IEvaluator';
import { wordErrorRate } from './wordErrorRate';

// ============================================================================
// Built-in Scorers
// ============================================================================

/**
 * Exact match scorer - 1 if exactly equal, 0 otherwise.
 */
const exactMatchScorer: ScorerFunction = (actual, expected) => {
  if (!expected) return 0;
  return actual.trim().toLowerCase() === expected.trim().toLowerCase() ? 1 : 0;
};

/**
 * Contains scorer - 1 if actual contains expected, 0 otherwise.
 */
const containsScorer: ScorerFunction = (actual, expected) => {
  if (!expected) return 0;
  return actual.toLowerCase().includes(expected.toLowerCase()) ? 1 : 0;
};

/**
 * Levenshtein distance scorer - normalized similarity.
 */
const levenshteinScorer: ScorerFunction = (actual, expected) => {
  if (!expected) return 0;

  const a = actual.toLowerCase();
  const b = expected.toLowerCase();

  if (a === b) return 1;
  if (a.length === 0) return 0;
  if (b.length === 0) return 0;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }

  const distance = matrix[b.length][a.length];
  const maxLen = Math.max(a.length, b.length);
  return 1 - distance / maxLen;
};

/**
 * Simple word overlap scorer (approximation of semantic similarity).
 */
const wordOverlapScorer: ScorerFunction = (actual, expected, references) => {
  const normalize = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2);

  const actualWords = new Set(normalize(actual));

  const compareWith = expected || (references && references[0]) || '';
  const expectedWords = new Set(normalize(compareWith));

  if (expectedWords.size === 0) return 0;

  let overlap = 0;
  for (const word of actualWords) {
    if (expectedWords.has(word)) {
      overlap++;
    }
  }

  return overlap / Math.max(actualWords.size, expectedWords.size);
};

/**
 * BLEU score approximation (unigram).
 */
const bleuScorer: ScorerFunction = (actual, expected, references) => {
  if (!expected && (!references || references.length === 0)) return 0;

  const actualTokens = actual.toLowerCase().split(/\s+/);
  const refTexts = expected ? [expected] : references || [];

  let maxPrecision = 0;

  for (const ref of refTexts) {
    const refTokens = ref.toLowerCase().split(/\s+/);
    const refCounts = new Map<string, number>();

    for (const token of refTokens) {
      refCounts.set(token, (refCounts.get(token) || 0) + 1);
    }

    let matches = 0;
    const actualCounts = new Map<string, number>();

    for (const token of actualTokens) {
      actualCounts.set(token, (actualCounts.get(token) || 0) + 1);
    }

    for (const [token, count] of actualCounts) {
      matches += Math.min(count, refCounts.get(token) || 0);
    }

    const precision = actualTokens.length > 0 ? matches / actualTokens.length : 0;
    maxPrecision = Math.max(maxPrecision, precision);
  }

  // Apply brevity penalty
  const refLen = (expected || references?.[0] || '').split(/\s+/).length;
  const brevityPenalty =
    actualTokens.length >= refLen ? 1 : Math.exp(1 - refLen / actualTokens.length);

  return maxPrecision * brevityPenalty;
};

/**
 * ROUGE-L score approximation.
 */
const rougeScorer: ScorerFunction = (actual, expected) => {
  if (!expected) return 0;

  const a = actual.toLowerCase().split(/\s+/);
  const b = expected.toLowerCase().split(/\s+/);

  // Find longest common subsequence
  const lcs: number[][] = Array(a.length + 1)
    .fill(null)
    .map(() => Array(b.length + 1).fill(0));

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      }
    }
  }

  const lcsLen = lcs[a.length][b.length];
  const precision = a.length > 0 ? lcsLen / a.length : 0;
  const recall = b.length > 0 ? lcsLen / b.length : 0;

  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
};

/**
 * Word error rate scorer - 1 less the word error rate of the actual transcript against the expected one
 * (see {@link wordErrorRate}), never below 0, and 0 with no expected output.
 */
const wordErrorRateScorer: ScorerFunction = (actual, expected) => (expected === undefined ? 0 : Math.max(0, 1 - wordErrorRate(actual, expected).rate));

// ============================================================================
// Evaluator Implementation
// ============================================================================

/**
 * Default evaluation configuration.
 */
const DEFAULT_CONFIG: EvalConfig = {
  concurrency: 3,
  timeoutMs: 60000,
  retries: 1,
  continueOnError: true,
  thresholds: {
    pass: 0.7,
    warn: 0.5,
  },
};

/**
 * Agent evaluation framework implementation.
 */
export class Evaluator implements IEvaluator {
  private readonly runs = new Map<string, EvalRun>();
  private readonly scorers = new Map<string, ScorerFunction>();

  constructor() {
    // Register built-in scorers
    this.scorers.set('exact_match', exactMatchScorer);
    this.scorers.set('contains', containsScorer);
    this.scorers.set('levenshtein', levenshteinScorer);
    this.scorers.set('semantic_similarity', wordOverlapScorer);
    this.scorers.set('bleu', bleuScorer);
    this.scorers.set('rouge', rougeScorer);
    this.scorers.set('word_error_rate', wordErrorRateScorer);
  }

  async runEvaluation(
    name: string,
    testCases: EvalTestCase[],
    agentFn: (input: string, context?: string) => Promise<string>,
    config?: EvalConfig,
  ): Promise<EvalRun> {
    const runId = uuidv4();
    const cfg = { ...DEFAULT_CONFIG, ...config };

    const run: EvalRun = {
      runId,
      name,
      startedAt: new Date().toISOString(),
      status: 'running',
      results: [],
      aggregateMetrics: this.createEmptyAggregateMetrics(),
      config: cfg,
    };

    this.runs.set(runId, run);

    try {
      // Process test cases with concurrency control
      const results: EvalTestResult[] = [];
      const queue = [...testCases];

      const runWithRetry = async (testCase: EvalTestCase): Promise<EvalTestResult> => {
        let lastError: Error | undefined;

        for (let attempt = 0; attempt <= (cfg.retries || 0); attempt++) {
          try {
            const startTime = Date.now();
            const actualOutput = await Promise.race([
              agentFn(testCase.input, testCase.context),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), cfg.timeoutMs),
              ),
            ]);
            const latencyMs = Date.now() - startTime;

            const result = await this.evaluateTestCase(testCase, actualOutput, cfg);
            result.latencyMs = latencyMs;
            return result;
          } catch (error) {
            lastError = error as Error;
          }
        }

        // All retries failed
        return {
          testCaseId: testCase.id,
          testCaseName: testCase.name,
          passed: false,
          score: 0,
          metrics: [],
          actualOutput: '',
          latencyMs: 0,
          error: lastError?.message || 'Unknown error',
          timestamp: new Date().toISOString(),
        };
      };

      // Process in batches
      const batchSize = cfg.concurrency || 3;
      for (let i = 0; i < queue.length; i += batchSize) {
        const batch = queue.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(runWithRetry));
        results.push(...batchResults);

        // Update run with progress
        run.results = results;
        run.aggregateMetrics = this.calculateAggregateMetrics(results);
      }

      run.status = 'completed';
      run.completedAt = new Date().toISOString();
      run.aggregateMetrics = this.calculateAggregateMetrics(results);

      return run;
    } catch (error) {
      run.status = 'failed';
      run.completedAt = new Date().toISOString();
      throw error;
    }
  }

  async evaluateTestCase(
    testCase: EvalTestCase,
    actualOutput: string,
    config?: EvalConfig,
  ): Promise<EvalTestResult> {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const metrics: MetricValue[] = [];
    let totalScore = 0;
    let totalWeight = 0;

    // Default criteria if none specified
    const criteria = testCase.criteria || [
      { name: 'similarity', description: 'Output similarity', weight: 1, scorer: 'levenshtein' },
    ];

    for (const criterion of criteria) {
      const scorer = this.scorers.get(criterion.scorer);
      if (!scorer) {
        console.warn(`Unknown scorer: ${criterion.scorer}`);
        continue;
      }

      const score = await scorer(
        actualOutput,
        testCase.expectedOutput,
        testCase.referenceOutputs,
        testCase.metadata,
      );

      metrics.push({
        name: criterion.name,
        type: 'custom',
        value: score,
        normalized: true,
        confidence: 1,
        timestamp: new Date().toISOString(),
        metadata: { scorer: criterion.scorer },
      });

      totalScore += score * criterion.weight;
      totalWeight += criterion.weight;
    }

    const finalScore = totalWeight > 0 ? totalScore / totalWeight : 0;
    const passed = finalScore >= (cfg.thresholds?.pass || 0.7);

    return {
      testCaseId: testCase.id,
      testCaseName: testCase.name,
      passed,
      score: finalScore,
      metrics,
      actualOutput,
      expectedOutput: testCase.expectedOutput,
      latencyMs: 0, // Set by caller
      timestamp: new Date().toISOString(),
    };
  }

  async score(
    scorer: BuiltInScorer | string,
    actual: string,
    expected?: string,
    references?: string[],
  ): Promise<number> {
    const fn = this.scorers.get(scorer);
    if (!fn) {
      throw new Error(`Unknown scorer: ${scorer}`);
    }
    return fn(actual, expected, references);
  }

  registerScorer(name: string, fn: ScorerFunction): void {
    this.scorers.set(name, fn);
  }

  async getRun(runId: string): Promise<EvalRun | undefined> {
    return this.runs.get(runId);
  }

  async listRuns(limit = 50): Promise<EvalRun[]> {
    return Array.from(this.runs.values())
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, limit);
  }

  async compareRuns(runId1: string, runId2: string): Promise<EvalComparison> {
    const run1 = this.runs.get(runId1);
    const run2 = this.runs.get(runId2);

    if (!run1 || !run2) {
      throw new Error('Run not found');
    }

    const metrics: EvalComparison['metrics'] = [];

    // Compare aggregate metrics
    const compareMetric = (name: string, v1: number, v2: number) => {
      const delta = v2 - v1;
      const percentChange = v1 !== 0 ? (delta / v1) * 100 : 0;
      metrics.push({
        name,
        run1Value: v1,
        run2Value: v2,
        delta,
        percentChange,
        improved: delta > 0,
      });
    };

    compareMetric('passRate', run1.aggregateMetrics.passRate, run2.aggregateMetrics.passRate);
    compareMetric('avgScore', run1.aggregateMetrics.avgScore, run2.aggregateMetrics.avgScore);
    compareMetric('avgLatencyMs', run1.aggregateMetrics.avgLatencyMs, run2.aggregateMetrics.avgLatencyMs);
    compareMetric('p95LatencyMs', run1.aggregateMetrics.p95LatencyMs, run2.aggregateMetrics.p95LatencyMs);

    return {
      run1Id: runId1,
      run2Id: runId2,
      metrics,
      summary: {
        improved: metrics.filter(m => m.improved && m.delta !== 0).length,
        regressed: metrics.filter(m => !m.improved && m.delta !== 0).length,
        unchanged: metrics.filter(m => m.delta === 0).length,
      },
    };
  }

  async generateReport(runId: string, format: 'json' | 'markdown' | 'html'): Promise<string> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error('Run not found');
    }

    switch (format) {
      case 'json':
        return JSON.stringify(run, null, 2);

      case 'markdown':
        return this.generateMarkdownReport(run);

      case 'html':
        return this.generateHtmlReport(run);

      default:
        throw new Error(`Unknown format: ${format}`);
    }
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private createEmptyAggregateMetrics(): AggregateMetrics {
    return {
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      passRate: 0,
      avgScore: 0,
      scoreStdDev: 0,
      avgLatencyMs: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      p99LatencyMs: 0,
      totalTokens: 0,
      totalCostUsd: 0,
    };
  }

  private calculateAggregateMetrics(results: EvalTestResult[]): AggregateMetrics {
    if (results.length === 0) {
      return this.createEmptyAggregateMetrics();
    }

    const scores = results.map(r => r.score);
    const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
    const passedCount = results.filter(r => r.passed).length;

    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, s) => a + Math.pow(s - avgScore, 2), 0) / scores.length;

    const percentile = (arr: number[], p: number) => {
      const idx = Math.ceil((p / 100) * arr.length) - 1;
      return arr[Math.max(0, idx)];
    };

    return {
      totalTests: results.length,
      passedTests: passedCount,
      failedTests: results.length - passedCount,
      passRate: passedCount / results.length,
      avgScore,
      scoreStdDev: Math.sqrt(variance),
      avgLatencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      p99LatencyMs: percentile(latencies, 99),
      totalTokens: results.reduce((a, r) => a + (r.tokenUsage?.totalTokens || 0), 0),
      totalCostUsd: results.reduce((a, r) => a + (r.costUsd || 0), 0),
    };
  }

  private generateMarkdownReport(run: EvalRun): string {
    const m = run.aggregateMetrics;
    return `# Evaluation Report: ${run.name}

## Summary

| Metric | Value |
|--------|-------|
| Run ID | \`${run.runId}\` |
| Status | ${run.status} |
| Started | ${run.startedAt} |
| Completed | ${run.completedAt || 'N/A'} |

## Results

| Metric | Value |
|--------|-------|
| Total Tests | ${m.totalTests} |
| Passed | ${m.passedTests} (${(m.passRate * 100).toFixed(1)}%) |
| Failed | ${m.failedTests} |
| Average Score | ${(m.avgScore * 100).toFixed(1)}% |
| Score Std Dev | ${(m.scoreStdDev * 100).toFixed(1)}% |

## Latency

| Percentile | Value |
|------------|-------|
| Average | ${m.avgLatencyMs.toFixed(0)}ms |
| P50 | ${m.p50LatencyMs.toFixed(0)}ms |
| P95 | ${m.p95LatencyMs.toFixed(0)}ms |
| P99 | ${m.p99LatencyMs.toFixed(0)}ms |

## Test Cases

${run.results
  .map(r => `- ${r.passed ? '✅' : '❌'} **${r.testCaseName}** - Score: ${(r.score * 100).toFixed(0)}%, Latency: ${r.latencyMs}ms${r.error ? ` (Error: ${r.error})` : ''}`)
  .join('\n')}
`;
  }

  private generateHtmlReport(run: EvalRun): string {
    const m = run.aggregateMetrics;
    return `<!DOCTYPE html>
<html>
<head>
  <title>Evaluation Report: ${run.name}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { color: #333; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f5f5f5; }
    .pass { color: #22c55e; }
    .fail { color: #ef4444; }
    .metric { font-weight: bold; }
  </style>
</head>
<body>
  <h1>Evaluation Report: ${run.name}</h1>
  <p><strong>Run ID:</strong> ${run.runId}</p>
  <p><strong>Status:</strong> ${run.status}</p>

  <h2>Results</h2>
  <table>
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Total Tests</td><td>${m.totalTests}</td></tr>
    <tr><td>Passed</td><td class="pass">${m.passedTests} (${(m.passRate * 100).toFixed(1)}%)</td></tr>
    <tr><td>Failed</td><td class="fail">${m.failedTests}</td></tr>
    <tr><td>Average Score</td><td>${(m.avgScore * 100).toFixed(1)}%</td></tr>
    <tr><td>Average Latency</td><td>${m.avgLatencyMs.toFixed(0)}ms</td></tr>
    <tr><td>P95 Latency</td><td>${m.p95LatencyMs.toFixed(0)}ms</td></tr>
  </table>

  <h2>Test Cases</h2>
  <table>
    <tr><th>Test</th><th>Status</th><th>Score</th><th>Latency</th></tr>
    ${run.results
      .map(
        r => `<tr>
      <td>${r.testCaseName}</td>
      <td class="${r.passed ? 'pass' : 'fail'}">${r.passed ? '✅ Pass' : '❌ Fail'}</td>
      <td>${(r.score * 100).toFixed(0)}%</td>
      <td>${r.latencyMs}ms</td>
    </tr>`,
      )
      .join('\n')}
  </table>
</body>
</html>`;
  }
}



