# Evaluation — Testing and Benchmarking Agents

> Write test cases, score an agent's answers with built-in or custom scorers, grade with an LLM judge, compare runs and print reports.

---

## Table of Contents

1. [Overview](#overview)
2. [Test Case Authoring](#test-case-authoring)
3. [Built-In Scorers](#built-in-scorers)
4. [Custom Scorers](#custom-scorers)
5. [LLM-as-Judge](#llm-as-judge)
6. [Running an Evaluation](#running-an-evaluation)
7. [Comparing Two Agents](#comparing-two-agents)
8. [Keeping Runs](#keeping-runs)
9. [Reports](#reports)

---

## Overview

```
test cases → evaluator.runEvaluation(name, cases, agentFn) → EvalRun
                                                                ↓
                                        each case: scorers → weighted score → passed?
                                                                ↓
                                    evaluator.generateReport(runId, 'json' | 'markdown' | 'html')
```

The evaluation exports come from the root package:

```typescript
import {
  Evaluator,
  LLMJudge,
  CRITERIA_PRESETS,
  type EvalTestCase,
  type EvalRun,
} from '@framers/agentos';
```

---

## Test Case Authoring

A test case is one input with what to compare the answer against and how to score it:

```typescript
import type { EvalTestCase } from '@framers/agentos';

const testCases: EvalTestCase[] = [
  {
    id: 'capital-1',
    name: 'Capital of France',
    input: 'What is the capital of France?',
    expectedOutput: 'Paris',
    criteria: [
      { name: 'correctness', description: 'Contains the answer', weight: 1, scorer: 'contains' },
    ],
  },
  {
    id: 'summary-1',
    name: 'TCP handshake summary',
    category: 'summaries',
    input: 'Summarize the TCP three-way handshake.',
    expectedOutput: 'SYN, SYN-ACK, ACK: client and server establish a reliable connection.',
    criteria: [
      { name: 'coverage', description: 'Shares the key words', weight: 2, scorer: 'semantic_similarity' },
      { name: 'wording', description: 'Close to the reference', weight: 1, scorer: 'rouge' },
    ],
  },
];
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique identifier |
| `name` | `string` | Label used in reports |
| `input` | `string` | The prompt passed to the agent function |
| `expectedOutput` | `string` | The reference answer the scorers compare against |
| `referenceOutputs` | `string[]` | Extra references; `bleu` and `semantic_similarity` use them when `expectedOutput` is missing |
| `context` | `string` | Passed to the agent function as its second argument |
| `criteria` | `EvalCriteria[]` | `{ name, description, weight, scorer }`; without criteria the case is scored by `levenshtein` alone |
| `category` | `string` | A label; the aggregates do not group by it |
| `metadata` | `object` | Passed to every scorer as its fourth argument |

A test case is one input; there is no multi-turn form. To test a conversation, have the agent function keep a session and send earlier turns before the input.

The case's score is the weighted mean of its criteria scores, and it passes when the score is at least `thresholds.pass` (default 0.7). A criterion naming an unknown scorer is skipped with a console warning.

---

## Built-In Scorers

| Scorer | Score | What it computes |
|--------|-------|------------------|
| `exact_match` | 0 or 1 | Equal after trimming and lower-casing |
| `contains` | 0 or 1 | The answer contains the expected text, ignoring case |
| `levenshtein` | 0–1 | 1 minus the character edit distance over the longer length, ignoring case |
| `semantic_similarity` | 0–1 | Word overlap: shared words longer than 2 characters over the larger word set. It uses no embeddings |
| `bleu` | 0–1 | Unigram precision against the best reference, with a brevity penalty |
| `rouge` | 0–1 | ROUGE-L F1 over whitespace-separated words |
| `word_error_rate` | 0–1 | 1 minus the word error rate, never below 0 (see [Evaluation Framework](./EVALUATION_FRAMEWORK.md#word-error-rate)) |

Every built-in scorer returns 0 when there is nothing to compare against. `llm_judge` appears in the `BuiltInScorer` type but is not registered: register a judge scorer under that name (see [LLM-as-Judge](#llm-as-judge)).

```typescript
const evaluator = new Evaluator();

const similarity = await evaluator.score('levenshtein', 'actual output', 'expected output');
const rougeL = await evaluator.score('rouge', generatedSummary, referenceSummary);
```

---

## Custom Scorers

A scorer is `(actual, expected, references, metadata) => number | Promise<number>`, registered by name:

```typescript
const evaluator = new Evaluator();

evaluator.registerScorer('json_valid', (actual) => {
  try {
    JSON.parse(actual);
    return 1;
  } catch {
    return 0;
  }
});

// Options travel in the test case's metadata
evaluator.registerScorer('json_has_key', (actual, _expected, _refs, metadata) => {
  try {
    return String(metadata?.key) in JSON.parse(actual) ? 1 : 0;
  } catch {
    return 0;
  }
});

const testCase: EvalTestCase = {
  id: 'json-1',
  name: 'JSON output',
  input: 'Return user data as JSON: name=Alice, age=30.',
  metadata: { key: 'name' },
  criteria: [
    { name: 'valid_json', description: 'Parses as JSON', weight: 2, scorer: 'json_valid' },
    { name: 'has_name', description: 'Has a name field', weight: 1, scorer: 'json_has_key' },
  ],
};
```

---

## LLM-as-Judge

`LLMJudge` grades an answer with a model through an `AIModelProviderManager`:

```typescript
import { LLMJudge, CRITERIA_PRESETS } from '@framers/agentos';

const judge = new LLMJudge({
  llmProvider: providerManager, // an initialized AIModelProviderManager
  modelId: 'gpt-4o',            // default: the judge resolver's model (openai gpt-5.6)
});

const result = await judge.judge(
  'How do I fix a memory leak in Node.js?',  // input
  answer,                                    // actual output
  undefined,                                 // expected output (optional)
  [
    { name: 'helpfulness', description: 'Actionable steps and the root cause', weight: 0.6 },
    { name: 'safety', description: 'No harmful or wrong advice', weight: 0.4 },
  ],
);
console.log(result.score, result.criteriaScores, result.reasoning, result.feedback);
```

- Without criteria, the judge uses its default set; `CRITERIA_PRESETS` has `codeGeneration`, `summarization`, `questionAnswering`, `creativeWriting` and `safety`.
- `temperature` defaults to 0.1, and the judge asks for a JSON answer. A provider error or an answer that is not JSON scores `errorScore` (default 0); JSON without `overallScore` scores 0.5.
- `AGENTOS_JUDGE_PROVIDER`, `AGENTOS_JUDGE_MODEL` and `AGENTOS_JUDGE_EFFORT` change the default judge model when the config pins none.

To use the judge inside an evaluation, register its scorer. The scorer reads the input from the test case's `metadata.input`:

```typescript
evaluator.registerScorer('llm_judge', judge.createScorer(CRITERIA_PRESETS.questionAnswering));

const judged: EvalTestCase = {
  id: 'qa-1',
  name: 'Photosynthesis',
  input: 'What is photosynthesis?',
  metadata: { input: 'What is photosynthesis?' },
  criteria: [{ name: 'quality', description: 'Judge score', weight: 1, scorer: 'llm_judge' }],
};
```

---

## Running an Evaluation

```typescript
import { Evaluator, agent } from '@framers/agentos';

const assistant = agent({ provider: 'openai', instructions: 'You are a helpful assistant.' });

let caseNumber = 0;
async function agentFn(input: string): Promise<string> {
  // A session per case keeps one case's history out of the next.
  const reply = await assistant.session(`eval-${++caseNumber}`).send(input);
  return reply.text;
}

const evaluator = new Evaluator();
const run = await evaluator.runEvaluation('assistant v1.2', testCases, agentFn, {
  concurrency: 5,    // cases per batch (default 3)
  timeoutMs: 30_000, // per attempt (default 60000)
  retries: 1,        // extra attempts after an error or a timeout (default 1)
  thresholds: { pass: 0.8 },
});

const m = run.aggregateMetrics;
console.log(`${m.passedTests}/${m.totalTests} passed, average ${m.avgScore.toFixed(3)}, p95 ${m.p95LatencyMs} ms`);
```

- Cases run in batches of `concurrency`; a batch waits for its slowest case.
- A timeout rejects the attempt; it does not cancel the agent call.
- A case whose attempts all fail gets score 0 with `error` set, and the run goes on.
- `totalTokens` and `totalCostUsd` stay 0: the agent function returns text only. `byCategory` is not filled.
- `EvalConfig.continueOnError`, `thresholds.warn`, `customScorers` and a criterion's `threshold` are declared and not read.

---

## Comparing Two Agents

```typescript
const fast = agent({ provider: 'openai', model: 'gpt-4o-mini' });
const strong = agent({ provider: 'openai', model: 'gpt-4o' });

let n = 0;
const runA = await evaluator.runEvaluation('baseline', testCases, (input) =>
  fast.session(`a-${++n}`).send(input).then((r) => r.text));
const runB = await evaluator.runEvaluation('challenger', testCases, (input) =>
  strong.session(`b-${++n}`).send(input).then((r) => r.text));

const comparison = await evaluator.compareRuns(runA.runId, runB.runId);
for (const metric of comparison.metrics) {
  console.log(metric.name, metric.run1Value, metric.run2Value, metric.delta);
}
console.log(comparison.summary); // { improved, regressed, unchanged }
```

`compareRuns()` compares four aggregates: `passRate`, `avgScore`, `avgLatencyMs` and `p95LatencyMs`. It marks a metric `improved` when the second run's value is higher, latency included, so read a latency `delta` above 0 as slower. It does not compare test cases one by one; for that, match `runA.results` and `runB.results` by `testCaseId`.

`judge.compare(input, outputA, outputB, criteria)` judges two answers to one input and names the winner (`'A'`, `'B'`, or `'tie'` when the scores differ by less than 0.05).

---

## Keeping Runs

The evaluator keeps runs in memory: `getRun(runId)`, `listRuns(limit)` (newest first, default 50), `compareRuns()` and `generateReport()` see the runs of that instance only. To keep runs across processes, store `generateReport(runId, 'json')`, which serializes the whole `EvalRun`.

---

## Reports

```typescript
import { writeFile } from 'node:fs/promises';

const md = await evaluator.generateReport(run.runId, 'markdown');   // summary, latency, one line per case
const html = await evaluator.generateReport(run.runId, 'html');     // the same as HTML tables
await writeFile('./eval-report.html', html);

const run2 = JSON.parse(await evaluator.generateReport(run.runId, 'json')); // the EvalRun
console.log(run2.aggregateMetrics.passRate);
```

---

## Related Guides

- [EVALUATION_FRAMEWORK.md](./EVALUATION_FRAMEWORK.md) — types, scorers and the word error rate in detail
- [GETTING_STARTED.md](../getting-started/GETTING_STARTED.md) — first steps with AgentOS
- [EXAMPLES.md](../getting-started/EXAMPLES.md) — runnable recipes
