# AgentOS Evaluation Framework

## Overview

The evaluation framework runs test cases through an agent function and scores the answers:

- **Test cases** with expected outputs and weighted criteria
- **Runs** in batches of a configurable size, with a per-attempt timeout and retries
- **Scorers**, built in or registered, and an LLM judge
- **Run comparison** over four aggregate metrics
- **Reports** in JSON, Markdown or HTML

Runs live in the `Evaluator` instance's memory.

## Quick Start

```typescript
import { Evaluator } from '@framers/agentos';
import type { EvalTestCase } from '@framers/agentos';

const evaluator = new Evaluator();

// Define test cases
const testCases: EvalTestCase[] = [
  {
    id: 'math-1',
    name: 'Basic Addition',
    input: 'What is 2 + 2?',
    expectedOutput: '4',
    criteria: [
      { name: 'correctness', description: 'Contains correct answer', weight: 1, scorer: 'contains' }
    ]
  },
  {
    id: 'greeting-1',
    name: 'Greeting Response',
    input: 'Hello!',
    expectedOutput: 'Hello! How can I help you today?',
    criteria: [
      { name: 'politeness', description: 'Polite response', weight: 1, scorer: 'contains' },
      { name: 'similarity', description: 'Similar to expected', weight: 2, scorer: 'levenshtein' }
    ]
  }
];

// Define your agent function
async function myAgent(input: string): Promise<string> {
  // Your GMI or agent logic here
  return `Response to: ${input}`;
}

// Run evaluation
const run = await evaluator.runEvaluation(
  'My Agent Evaluation v1.0',
  testCases,
  myAgent,
  { concurrency: 5, timeoutMs: 30000 }
);

// Generate report
const report = await evaluator.generateReport(run.runId, 'markdown');
console.log(report);
```

## Built-in Scorers

The framework includes several built-in scorers:

| Scorer | Description | Best For |
|--------|-------------|----------|
| `exact_match` | Returns 1 if the strings are equal after trimming, ignoring case | Precise answers |
| `contains` | Returns 1 if actual contains expected, ignoring case | Checking for key terms |
| `levenshtein` | 1 minus the normalized character edit distance (0-1), ignoring case | Typo tolerance |
| `semantic_similarity` | Word overlap (0-1): shared words longer than 2 characters over the larger set; no embeddings | Shared vocabulary |
| `bleu` | Unigram precision with a brevity penalty (0-1) | Translation quality |
| `rouge` | ROUGE-L F1 score | Summarization quality |
| `word_error_rate` | 1 less the word error rate, never below 0 | Speech-to-text transcripts |

### Using Scorers Directly

```typescript
// Score individual outputs
const score = await evaluator.score('levenshtein', 'actual output', 'expected output');
console.log(`Similarity: ${(score * 100).toFixed(1)}%`);
```

### Word Error Rate

`word_error_rate` scores a transcript against a reference transcript by its word error rate. `wordErrorRate()` returns the counts behind the score and `normalizeTranscript()` the words it compares; both are exported beside `Evaluator`, from `@framers/agentos` and from `@framers/agentos/safety/evaluation`.

Both texts go through one normalisation before they are counted, so that measurements of different speech-to-text systems agree:

- Unicode's composed form (NFC), so `é` written as one character and `e` followed by a combining accent are the same letter.
- Lower case.
- Letters, digits and a word's inner apostrophe are kept (`cat's`, `don't`), with the combining marks on them, such as an accent or a vowel sign, so `कि` and `क` are different words. The typographic apostrophes `’` (U+2019), `‘` (U+2018) and `ʼ` (U+02BC) count as `'`, so `don’t` and `don't` are the same word.
- Other punctuation and symbols are dropped, with any combining mark on them (an emoji's variation selector, for one), and so are bracketed marks such as `[laughter]` and the filler words `um`, `uh`, `er`, `ah`, `hmm` and `mm`.
- Numbers are left as written, so `3` and `three` are different words.

The counts are the substitutions, deletions and insertions of a word-level edit distance from the reference to the transcript: a deletion is a reference word the transcript lacks, an insertion a transcript word the reference lacks. The rate is their sum over the reference's word count, taken as 1 when the reference is empty, so insertions can take it above 1. The scorer gives `1 - rate`, never below 0, and 0 when a test case has no expected output.

```typescript
import { Evaluator, normalizeTranscript, wordErrorRate } from '@framers/agentos';

normalizeTranscript("Um, so the [laughter] meeting's at 3.");
// ['so', 'the', "meeting's", 'at', '3']

wordErrorRate('so the meeting is at three', "Um, so the [laughter] meeting's at 3.");
// { substitutions: 2, deletions: 0, insertions: 1, referenceWords: 5, rate: 0.6 }

const evaluator = new Evaluator();
await evaluator.score('word_error_rate', 'so the meeting is at three', "so the meeting's at 3");
// 0.4
```

## Custom Scorers

Register custom scorers for domain-specific evaluation:

```typescript
// A scorer is (actual, expected, references, metadata) => number | Promise<number>
evaluator.registerScorer('json_valid', (actual) => {
  try {
    JSON.parse(actual);
    return 1;
  } catch {
    return 0;
  }
});

// Use in test cases
const testCase: EvalTestCase = {
  id: 'json-1',
  name: 'JSON Output',
  input: 'Generate JSON for user profile',
  expectedOutput: '{"name": "John", "age": 30}',
  criteria: [
    { name: 'valid_json', description: 'Output is valid JSON', weight: 1, scorer: 'json_valid' },
    { name: 'similar', description: 'Similar structure', weight: 2, scorer: 'levenshtein' }
  ]
};
```

## Configuration Options

```typescript
interface EvalConfig {
  concurrency?: number;      // Cases per batch (default: 3); a batch waits for its slowest case
  timeoutMs?: number;        // Per attempt (default: 60000); the agent call is not cancelled
  retries?: number;          // Extra attempts after an error or a timeout (default: 1)
  continueOnError?: boolean; // Declared, not read: a failed case scores 0 and the run goes on
  thresholds?: {
    pass?: number;           // Minimum weighted score to pass (default: 0.7)
    warn?: number;           // Declared, not read (default: 0.5)
  };
  customScorers?: Record<string, ScorerFunction>; // Declared, not read: use registerScorer()
}
```

## Test Case Structure

```typescript
interface EvalTestCase {
  id: string;                    // Unique identifier
  name: string;                  // Human-readable name
  category?: string;             // A label (the aggregates do not group by it)
  input: string;                 // Input to the agent function
  expectedOutput?: string;       // Reference answer
  referenceOutputs?: string[];   // Extra references (bleu, semantic_similarity)
  context?: string;              // Second argument of the agent function
  expectedToolCalls?: Array<{ toolName: string; args?: Record<string, unknown> }>; // Declared, not scored
  criteria?: EvalCriteria[];     // { name, description, weight, scorer, threshold? }; default: levenshtein
  metadata?: Record<string, unknown>; // Fourth argument of every scorer
}
```

A case's score is the weighted mean of its criteria; a criterion's `threshold` is not read, and a criterion naming an unknown scorer is skipped.

## Comparing Runs

Track improvements across versions:

```typescript
const runV1 = await evaluator.runEvaluation('v1.0', testCases, agentV1);
const runV2 = await evaluator.runEvaluation('v2.0', testCases, agentV2);

const comparison = await evaluator.compareRuns(runV1.runId, runV2.runId);

console.log('Improvements:', comparison.summary.improved);
console.log('Regressions:', comparison.summary.regressed);

for (const metric of comparison.metrics) {
  console.log(`${metric.name}: ${metric.delta.toFixed(2)} (${metric.percentChange.toFixed(1)}%)`);
}
```

The comparison covers `passRate`, `avgScore`, `avgLatencyMs` and `p95LatencyMs`. A metric counts as `improved` when the second run's value is higher, for the latencies too, so a slower second run reports its latencies as improvements. Both runs must belong to the same `Evaluator` instance.

## Aggregate Metrics

Each evaluation run includes aggregate metrics:

```typescript
interface AggregateMetrics {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  passRate: number;        // 0-1
  avgScore: number;        // 0-1
  scoreStdDev: number;     // Standard deviation
  avgLatencyMs: number;
  p50LatencyMs: number;    // Median
  p95LatencyMs: number;    // 95th percentile
  p99LatencyMs: number;    // 99th percentile
  totalTokens: number;     // 0: runEvaluation() records no token usage
  totalCostUsd: number;    // 0: runEvaluation() records no cost
  byCategory?: Record<string, { passRate: number; avgScore: number; count: number }>; // Not filled
}
```

## Integration with GMI

Evaluate GMI responses through the runtime. Each test case runs on a session of its own, so one case's history does not reach the next:

```typescript
import { AgentOS, AgentOSResponseChunkType, BUILT_IN_PERSONAS } from '@framers/agentos';

const agentos = await AgentOS.create({ personas: BUILT_IN_PERSONAS });
let caseNumber = 0;

// Create wrapper function for evaluation
async function gmiAgent(input: string): Promise<string> {
  let response = '';
  for await (const chunk of agentos.processRequest({
    userId: 'eval-user',
    sessionId: `eval-case-${++caseNumber}`,
    selectedPersonaId: 'v_researcher',
    textInput: input,
  })) {
    if (chunk.type === AgentOSResponseChunkType.TEXT_DELTA) {
      response += chunk.textDelta;
    }
  }
  return response;
}

const run = await evaluator.runEvaluation('GMI Evaluation', testCases, gmiAgent);
```

## Best Practices

1. **Start with representative test cases** - Cover common user queries and edge cases
2. **Use multiple criteria** - Combine exactness and semantic measures
3. **Weight criteria appropriately** - Prioritize what matters most
4. **Track baselines** - Store run IDs to compare against
5. **Automate in CI/CD** - Run evaluations on each deployment
6. **Review failures** - Read the failing cases' `actualOutput` and `error`

## Report Formats

```typescript
import { writeFileSync } from 'node:fs';

// JSON: the whole EvalRun
const data = JSON.parse(await evaluator.generateReport(run.runId, 'json'));

// Markdown: summary, latency percentiles, one line per case
const markdown = await evaluator.generateReport(run.runId, 'markdown');

// HTML: the same content as tables
writeFileSync('report.html', await evaluator.generateReport(run.runId, 'html'));
```

## LLM-as-Judge

`LLMJudge` grades with a model through an `AIModelProviderManager`. Without `modelId`, it uses the judge resolver's model (OpenAI `gpt-5.6`, or `AGENTOS_JUDGE_PROVIDER` / `AGENTOS_JUDGE_MODEL` / `AGENTOS_JUDGE_EFFORT`):

```typescript
import { LLMJudge, CRITERIA_PRESETS } from '@framers/agentos';

const judge = new LLMJudge({
  llmProvider: aiModelProviderManager,
  modelId: 'gpt-4-turbo',
  temperature: 0.1,
});

// Single judgment
const result = await judge.judge(
  'What is photosynthesis?',
  'Photosynthesis is how plants make food from sunlight.',
  'Photosynthesis is the process by which plants convert light energy into chemical energy.'
);

console.log(`Score: ${result.score}`);
console.log(`Reasoning: ${result.reasoning}`);
console.log(`Feedback: ${result.feedback.join(', ')}`);

// Use preset criteria
const codeResult = await judge.judge(
  'Write a function to reverse a string',
  actualCode,
  expectedCode,
  CRITERIA_PRESETS.codeGeneration
);

// Compare two outputs
const comparison = await judge.compare(
  'Summarize this article',
  summaryA,
  summaryB,
  CRITERIA_PRESETS.summarization
);
console.log(`Winner: ${comparison.winner}`);

// Register as a scorer; it reads the input from the test case's metadata.input
evaluator.registerScorer('llm_judge', judge.createScorer());
```

- `judge()` asks for a JSON answer at `temperature` 0.1. A provider error or an answer that is not JSON scores `errorScore` (default 0); JSON without `overallScore` scores 0.5.
- `compare()` judges the two outputs separately and calls a tie when their scores differ by less than 0.05.
- `batchJudge(items, criteria, concurrency = 3)` returns the judgments in the order they finish, not in the order of `items`.

### Available Criteria Presets

| Preset | Use Case |
|--------|----------|
| `codeGeneration` | Evaluate generated code |
| `summarization` | Evaluate summaries |
| `questionAnswering` | Evaluate Q&A responses |
| `creativeWriting` | Evaluate creative content |
| `safety` | Evaluate for harmlessness |

---

## References

### LLM-as-judge methodology

- Zheng, L., Chiang, W.-L., Sheng, Y., Zhuang, S., Wu, Z., Zhuang, Y., Lin, Z., Li, Z., Li, D., Xing, E. P., Zhang, H., Gonzalez, J. E., & Stoica, I. (2023). [*Judging LLM-as-a-judge with MT-Bench and chatbot arena.*](https://arxiv.org/abs/2306.05685) NeurIPS 2023. — LLM-as-judge reliability, position bias and self-enhancement bias. `LLMJudge.compare()` judges each output on its own, so it shows no answer to the judge in a second position.
- Liu, Y., Iter, D., Xu, Y., Wang, S., Xu, R., & Zhu, C. (2023). [*G-Eval: NLG evaluation using GPT-4 with better human alignment.*](https://arxiv.org/abs/2303.16634) EMNLP 2023. — Criteria-based scoring with an LLM, the form `LLMJudge` uses (per-criterion scores and an overall score).
- Chen, Y., Wang, R., Jiang, H., Shi, S., & Xu, R.-M. (2023). [*Exploring the use of large language models for reference-free text quality evaluation: An empirical study.*](https://arxiv.org/abs/2304.00723) AACL 2023. — Reference-free evaluation; `judge()` takes the expected output as optional.

### Human-LLM agreement + evaluator calibration

- Wang, Y., Yu, Z., Zeng, Z., Yang, L., Wang, C., Chen, H., Jiang, C., Xie, R., Wang, J., Xie, X., Ye, W., Zhang, S., & Zhang, Y. (2023). [*PandaLM: An automatic evaluation benchmark for LLM instruction tuning optimization.*](https://arxiv.org/abs/2306.05087) arXiv:2306.05087. — Evaluator-versus-human agreement.
- Bai, Y., Ying, J., Cao, Y., Lv, X., He, Y., Wang, X., Yu, J., Zeng, K., Xiao, Y., Lyu, H., Zhang, J., Li, J., & Hou, L. (2024). [*Benchmarking foundation models with language-model-as-an-examiner.*](https://arxiv.org/abs/2306.04181) NeurIPS 2024. — LLM-judge evaluation across many tasks.

### Bias + reliability concerns

- Wang, P., Li, L., Chen, L., Cai, Z., Zhu, D., Lin, B., Cao, Y., Liu, Q., Liu, T., & Sui, Z. (2023). [*Large language models are not fair evaluators.*](https://arxiv.org/abs/2305.17926) arXiv:2305.17926. — Position bias in pairwise LLM judges.

### Implementation references

- [`src/safety/evaluation/Evaluator.ts`](https://github.com/framerslab/agentos/blob/master/src/safety/evaluation/Evaluator.ts) — the evaluation harness
- [`src/safety/evaluation/LLMJudge.ts`](https://github.com/framerslab/agentos/blob/master/src/safety/evaluation/LLMJudge.ts) — the LLM judge and `CRITERIA_PRESETS`
- [`src/safety/evaluation/wordErrorRate.ts`](https://github.com/framerslab/agentos/blob/master/src/safety/evaluation/wordErrorRate.ts) — `wordErrorRate()` and `normalizeTranscript()`
