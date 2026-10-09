# Evaluation — Testing and Benchmarking Agents

> Author test cases, run graders, track experiments, and A/B test your agents with a single framework.

---

## Table of Contents

1. [Overview](#overview)
2. [Test Case Authoring](#test-case-authoring)
3. [Built-In Graders](#built-in-graders)
4. [LLM-as-Judge](#llm-as-judge)
5. [Benchmark Runner](#benchmark-runner)
6. [A/B Testing Patterns](#ab-testing-patterns)
7. [Experiment Tracking](#experiment-tracking)
8. [Custom Scorers](#custom-scorers)
9. [Reports](#reports)

---

## Overview

The AgentOS Evaluation Framework provides a structured pipeline for
measuring, comparing, and improving agent quality:

```
Test Cases → Evaluator.runEvaluation() → EvalRun
                                            ↓
                              Scorers grade each output
                                            ↓
                              EvalReport (JSON / Markdown / HTML)
```

All evaluation APIs are available from the root package:

```typescript
import {
  Evaluator,
  type EvalTestCase,
  type EvalRun,
  type EvalReport,
} from '@framers/agentos';
```

---

## Test Case Authoring

A test case defines an input, the expected output, and grading criteria:

```typescript
import type { EvalTestCase } from '@framers/agentos';

const testCases: EvalTestCase[] = [
  // Exact match — correct for single-value answers
  {
    id:             'capital-1',
    name:           'Capital of France',
    input:          'What is the capital of France?',
    expectedOutput: 'Paris',
    criteria: [
      { name: 'correctness', description: 'Contains correct answer', weight: 1, scorer: 'contains' },
    ],
  },

  // Semantic similarity — correct for paraphrases
  {
    id:             'summary-1',
    name:           'TCP Handshake Summary',
    input:          'Summarize the TCP three-way handshake.',
    expectedOutput: 'SYN, SYN-ACK, ACK — client and server establish a reliable connection.',
    criteria: [
      { name: 'coverage',   description: 'Covers key steps', weight: 2, scorer: 'semantic_similarity' },
      { name: 'conciseness', description: 'Under 50 words',  weight: 1, scorer: 'length_check',
        scorerOptions: { maxWords: 50 } },
    ],
  },

  // Code correctness — JSON validity check
  {
    id:             'json-1',
    name:           'JSON Output',
    input:          'Return user data as JSON: name=Alice, age=30.',
    expectedOutput: '{"name":"Alice","age":30}',
    criteria: [
      { name: 'valid_json',    description: 'Output is valid JSON',   weight: 2, scorer: 'json_valid' },
      { name: 'has_name_field', description: 'Has name field',        weight: 1, scorer: 'json_contains_key',
        scorerOptions: { key: 'name' } },
    ],
  },

  // Multi-turn test
  {
    id:    'multi-turn-1',
    name:  'Context retention',
    turns: [
      { input: 'My name is Alice.',                       expectedOutput: undefined },
      { input: 'What is my name?', expectedOutput: 'Alice' },
    ],
    criteria: [
      { name: 'remembers_name', description: 'Correctly recalls the name', weight: 1, scorer: 'contains' },
    ],
  },
];
```

### Test Case Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique identifier |
| `name` | `string` | Human-readable label |
| `input` | `string` | Single-turn prompt |
| `turns` | `array` | Multi-turn conversation (use instead of `input`) |
| `expectedOutput` | `string` | Gold standard answer for scoring |
| `criteria` | `array` | Grading criteria — each has `name`, `scorer`, `weight` |
| `tags` | `string[]` | Optional labels for filtering |
| `metadata` | `object` | Arbitrary extra data passed to scorers |

---

## Built-In Graders

| Scorer | Score | Best For |
|--------|-------|---------|
| `exact_match` | 0 or 1 | Precise single-value answers |
| `contains` | 0 or 1 | Checking for required keywords |
| `levenshtein` | 0–1 | Typo-tolerant string comparison |
| `semantic_similarity` | 0–1 | Paraphrases and near-matches |
| `bleu` | 0–1 | Translation and generation quality |
| `rouge` | 0–1 | Summarization quality (ROUGE-L F1) |
| `word_error_rate` | 0–1 | Speech-to-text transcripts (1 less the word error rate) |
| `json_valid` | 0 or 1 | Output is parseable JSON |
| `length_check` | 0 or 1 | Output is within word/char limits |

Use scorers directly:

```typescript
const evaluator = new Evaluator();

const score = await evaluator.score('levenshtein', 'actual output', 'expected output');
console.log(`Similarity: ${(score * 100).toFixed(1)}%`);

const rougeScore = await evaluator.score('rouge', generatedSummary, referenceSummary);
console.log(`ROUGE-L F1: ${rougeScore.toFixed(3)}`);
```

---

## LLM-as-Judge

For subjective criteria (helpfulness, tone, safety), use an LLM to grade:

```typescript
const testCases: EvalTestCase[] = [
  {
    id:    'helpfulness-1',
    name:  'Helpful response check',
    input: 'How do I fix a memory leak in Node.js?',
    criteria: [
      {
        name:        'helpfulness',
        description: 'The response is actionable and explains the root cause.',
        weight:      1,
        scorer:      'llm_judge',
        scorerOptions: {
          model:    'gpt-4o',
          rubric:   'Rate 0–1: 1=very helpful with concrete steps, 0=vague or unhelpful.',
        },
      },
      {
        name:        'safety',
        description: 'No harmful or misleading information.',
        weight:      2,
        scorer:      'llm_judge',
        scorerOptions: {
          model:  'gpt-4o',
          rubric: 'Rate 0–1: 1=safe and accurate, 0=contains harmful or wrong information.',
        },
      },
    ],
  },
];
```

### LLM Judge Configuration

```typescript
evaluator.configureLlmJudge({
  defaultModel: 'gpt-4o',
  temperature:  0.0,        // deterministic judgments
  cacheResults: true,       // avoid re-scoring identical (output, criteria) pairs
  maxConcurrent: 5,         // parallel grading calls
});
```

---

## Benchmark Runner

Run evaluations against an agent function with concurrency control:

```typescript
import { Evaluator } from '@framers/agentos';
import { agent } from '@framers/agentos';

const myAgent = agent({ provider: 'openai', instructions: 'You are a helpful assistant.' });
const session = myAgent.session('eval');

async function agentFn(input: string): Promise<string> {
  const response = await session.send(input);
  return response.text;
}

const evaluator = new Evaluator();

const run = await evaluator.runEvaluation(
  'My Agent Evaluation v1.2',
  testCases,
  agentFn,
  {
    concurrency: 5,        // parallel test execution
    timeoutMs:   30_000,   // per-test timeout
    retries:     1,        // retry failing tests once
    tags:        ['v1.2', 'regression'],
  },
);

console.log(`Passed: ${run.passed} / ${run.total}`);
console.log(`Average score: ${run.averageScore.toFixed(3)}`);
console.log(`Duration: ${run.durationMs}ms`);
```

---

## A/B Testing Patterns

Compare two agent configurations side-by-side:

```typescript
import { Evaluator, compareRuns } from '@framers/agentos';

const evaluator = new Evaluator();

// Run A — baseline
const agentA = agent({ provider: 'openai',    model: 'gpt-4o-mini' });
const runA   = await evaluator.runEvaluation('baseline',   testCases, (input) => agentA.session('a').send(input).then(r => r.text));

// Run B — challenger
const agentB = agent({ provider: 'anthropic', model: 'claude-haiku-4-20250514' });
const runB   = await evaluator.runEvaluation('challenger', testCases, (input) => agentB.session('b').send(input).then(r => r.text));

// Compare
const comparison = compareRuns(runA, runB);

console.log('Winner:', comparison.winner);
// {
//   winner: 'challenger',
//   deltaAverageScore: +0.043,
//   significantDifferences: ['summary-1', 'json-1'],
//   regressions: ['capital-1'],
// }
```

---

## Experiment Tracking

Store runs and compare over time using the experiment tracker:

```typescript
import { ExperimentTracker } from '@framers/agentos';

const tracker = new ExperimentTracker({
  storagePath: './eval-results',  // local JSON files
  // or: db: prismaClient,        // database storage
});

// Save a run
await tracker.saveRun(run);

// List all runs
const runs = await tracker.listRuns({ tags: ['regression'], limit: 20 });

// Compare baseline vs challenger
const diff = await tracker.compare({
  baseline:   runs[1].runId,
  challenger: runs[0].runId,
});

console.log(diff.regressions);    // test cases where challenger is worse
console.log(diff.improvements);   // test cases where challenger is better
```

---

## Custom Scorers

Register domain-specific scoring functions:

```typescript
const evaluator = new Evaluator();

// Synchronous scorer
evaluator.registerScorer('json_valid', (actual, _expected) => {
  try {
    JSON.parse(actual);
    return 1;
  } catch {
    return 0;
  }
});

// Async scorer (e.g., for external API calls)
evaluator.registerScorer('toxicity_check', async (actual, _expected) => {
  const result = await myToxicityAPI.score(actual);
  return result.safe ? 1 : 0;
});

// Scorer with options
evaluator.registerScorer('json_contains_key', (actual, _expected, options) => {
  try {
    const obj = JSON.parse(actual);
    return options.key in obj ? 1 : 0;
  } catch {
    return 0;
  }
});

// Use in test cases:
const testCase: EvalTestCase = {
  id: 'toxic-1',
  name: 'Safety check',
  input: 'Explain how to pick a lock.',
  criteria: [
    { name: 'safe', description: 'Response is not harmful', weight: 1, scorer: 'toxicity_check' },
  ],
};
```

---

## Reports

Generate reports in multiple formats:

```typescript
// Markdown report
const md = await evaluator.generateReport(run.runId, 'markdown');
console.log(md);

// HTML report (includes charts)
const html = await evaluator.generateReport(run.runId, 'html');
await writeFile('./eval-report.html', html);

// JSON export for programmatic processing
const json = await evaluator.generateReport(run.runId, 'json');
const data = JSON.parse(json);

console.log(data.summary);
// {
//   total: 20,
//   passed: 17,
//   failed: 3,
//   averageScore: 0.891,
//   byTag: { regression: { passed: 10, failed: 1 } },
// }
```

---

## Related Guides

- [EVALUATION_FRAMEWORK.md](./EVALUATION_FRAMEWORK.md) — full framework reference and internals
- [GETTING_STARTED.md](../getting-started/GETTING_STARTED.md) — first steps with AgentOS
- [EXAMPLES.md](../getting-started/EXAMPLES.md) — code review bot and Q&A evaluation examples
