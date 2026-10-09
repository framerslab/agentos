#!/usr/bin/env node
/**
 * Dependency ordering for a multi-agent task list, in plain JavaScript.
 *
 * Defines four tasks with `dependsOn` lists, checks the list for cycles and
 * missing references, prints the rounds in which the tasks become ready
 * (tasks in one round do not depend on each other), and then makes one direct
 * OpenAI chat completion call as a connectivity check.
 *
 * It does not run AgentOS's workflow engine and calls no AgentOS API. For
 * workflows that execute, see examples/workflow-dsl.mjs (workflow() on
 * GraphRuntime) and examples/agency-graph.mjs (agency() with dependsOn).
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node examples/multi-agent-workflow.mjs
 *
 * Or with .env:
 *   node --env-file=.env examples/multi-agent-workflow.mjs
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env manually if OPENAI_API_KEY not set
const __dirname = dirname(fileURLToPath(import.meta.url));
if (!process.env.OPENAI_API_KEY) {
  try {
    const envFile = readFileSync(resolve(__dirname, '../.env'), 'utf-8');
    for (const line of envFile.split('\n')) {
      const match = line.match(/^(\w+)=(.+)$/);
      if (match) process.env[match[1]] = match[2];
    }
  } catch { /* no .env file */ }
}

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY not set. Pass via env or .env file.');
  process.exit(1);
}

console.log('🧪 Multi-Agent Task Ordering');
console.log('=' .repeat(60));

// ─── Step 1: Check the dependency graph (no LLM needed) ───

console.log('\n📋 Step 1: Checking the task dependency graph...\n');

// Define the task list
const workflowDefinition = {
  id: 'test-market-analysis',
  name: 'Market Analysis Pipeline',
  version: '1.0.0',
  tasks: [
    // PARALLEL: no dependencies
    {
      id: 'research',
      name: 'Competitor Research',
      description: 'Research top 3 competitors in the AI agent framework space',
      dependsOn: [],
      executor: { type: 'gmi', roleId: 'researcher', instructions: 'Research competitor pricing, features, and market positioning for AI agent frameworks like LangChain, CrewAI, and AutoGen.' },
    },
    {
      id: 'data-collection',
      name: 'Market Data Collection',
      description: 'Collect market size and growth data for the AI agent market',
      dependsOn: [],
      executor: { type: 'gmi', roleId: 'analyst', instructions: 'Analyze the current AI agent market size, growth trends, and key segments.' },
    },

    // SEQUENTIAL: depends on both parallel tasks
    {
      id: 'synthesis',
      name: 'Strategy Synthesis',
      description: 'Synthesize research and data into a pricing strategy',
      dependsOn: ['research', 'data-collection'],
      executor: { type: 'gmi', roleId: 'strategist', instructions: 'Using the competitor research and market data, create a pricing strategy recommendation.' },
    },

    // SEQUENTIAL: depends on synthesis
    {
      id: 'report',
      name: 'Final Report',
      description: 'Write the final market analysis report',
      dependsOn: ['synthesis'],
      executor: { type: 'gmi', roleId: 'writer', instructions: 'Write a concise executive summary report based on the strategy synthesis.' },
    },
  ],
};

// Validate DAG structure
console.log('\n  Task dependency graph:');
for (const task of workflowDefinition.tasks) {
  const deps = task.dependsOn.length > 0 ? task.dependsOn.join(', ') : '(none — runs immediately)';
  console.log(`    ${task.id} → depends on: ${deps}`);
}

// Check parallel detection
const parallelTasks = workflowDefinition.tasks.filter(t => t.dependsOn.length === 0);
const sequentialTasks = workflowDefinition.tasks.filter(t => t.dependsOn.length > 0);
console.log(`\n  ✓ ${parallelTasks.length} tasks run in PARALLEL: ${parallelTasks.map(t => t.id).join(', ')}`);
console.log(`  ✓ ${sequentialTasks.length} tasks run SEQUENTIALLY:`);
for (const t of sequentialTasks) {
  console.log(`    ${t.id} waits for: ${t.dependsOn.join(' + ')}`);
}

// Validate no cycles
function hasCycles(tasks) {
  const graph = new Map(tasks.map(t => [t.id, t.dependsOn || []]));
  const visited = new Set();
  const inStack = new Set();

  function dfs(nodeId) {
    if (inStack.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);
    inStack.add(nodeId);
    for (const dep of graph.get(nodeId) || []) {
      if (dfs(dep)) return true;
    }
    inStack.delete(nodeId);
    return false;
  }

  for (const [id] of graph) {
    if (dfs(id)) return true;
  }
  return false;
}

const cycleResult = hasCycles(workflowDefinition.tasks);
console.log(`\n  ${cycleResult ? '❌' : '✓'} Cycle detection: ${cycleResult ? 'CYCLES FOUND' : 'No cycles (valid DAG)'}`);

// Validate all dependencies reference existing tasks
const taskIds = new Set(workflowDefinition.tasks.map(t => t.id));
let allDepsValid = true;
for (const task of workflowDefinition.tasks) {
  for (const dep of task.dependsOn) {
    if (!taskIds.has(dep)) {
      console.log(`  ❌ Task "${task.id}" depends on "${dep}" which doesn't exist`);
      allDepsValid = false;
    }
  }
}
if (allDepsValid) console.log('  ✓ All dependency references valid');

// ─── Step 2: Simulate execution ordering ───

console.log('\n📋 Step 2: Simulating execution order...\n');

const completed = new Set();
const timeline = [];
let round = 0;

while (completed.size < workflowDefinition.tasks.length) {
  round++;
  const ready = workflowDefinition.tasks.filter(t =>
    !completed.has(t.id) &&
    t.dependsOn.every(dep => completed.has(dep))
  );

  if (ready.length === 0) {
    console.log('  ❌ Deadlock detected — no tasks ready but not all complete');
    break;
  }

  const readyIds = ready.map(t => t.id);
  const isParallel = ready.length > 1;
  timeline.push({ round, tasks: readyIds, parallel: isParallel });

  console.log(`  Round ${round}: ${isParallel ? '⚡ PARALLEL' : '➡️  SEQUENTIAL'} → [${readyIds.join(', ')}]`);

  for (const t of ready) {
    completed.add(t.id);
  }
}

console.log(`\n  ✓ All ${workflowDefinition.tasks.length} tasks scheduled in ${round} rounds`);
console.log('  ✓ Execution order is valid');

// ─── Step 3: One direct OpenAI API call ───

console.log('\n📋 Step 3: Calling the OpenAI API directly...\n');

let apiCallSucceeded = false;
try {
  // A direct HTTP call, not an AgentOS call
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a market research analyst. Be concise (2-3 sentences max).' },
        { role: 'user', content: 'What are the top 3 AI agent frameworks in 2026 and their key differentiators?' },
      ],
      max_tokens: 200,
    }),
  });

  const data = await response.json();

  if (data.choices?.[0]?.message?.content) {
    apiCallSucceeded = true;
    console.log('  ✓ OpenAI API call successful');
    console.log(`  ✓ Model: ${data.model}`);
    console.log(`  ✓ Tokens: ${data.usage?.total_tokens}`);
    console.log(`\n  Response: "${data.choices[0].message.content.slice(0, 200)}..."`);
  } else {
    console.log('  ❌ Unexpected response:', JSON.stringify(data).slice(0, 200));
  }
} catch (e) {
  console.log('  ❌ API call failed:', e.message);
}

// ─── Summary ───

const graphValid = !cycleResult && allDepsValid;

console.log('\n' + '=' .repeat(60));
console.log(graphValid && apiCallSucceeded ? '✅ Complete' : '❌ Complete with failures');
console.log('');
console.log(`  DAG validation:     ${graphValid ? '✓ No cycles, all deps valid' : '❌ see above'}`);
console.log(`  Parallel tasks:     ${parallelTasks.length} (${parallelTasks.map(t => t.id).join(', ')})`);
console.log(`  Sequential tasks:   ${sequentialTasks.length} (${sequentialTasks.map(t => t.id).join(', ')})`);
console.log(`  Execution rounds:   ${round}`);
console.log(`  OpenAI API call:    ${apiCallSucceeded ? '✓ succeeded' : '❌ failed'}`);
console.log('');

if (!graphValid || !apiCallSucceeded) process.exitCode = 1;
