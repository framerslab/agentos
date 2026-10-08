#!/usr/bin/env node
// Example: agency() with a sequential hand-off.
//
// Three agents in one agency. The orchestration strategy (sequential here)
// decides the order and gives each agent the previous agent's output as its
// input. Nothing else is shared: agency() builds no shared memory store and
// runs no retrieval of its own, so what flows between agents is the text each
// one returns.
//
// What this example shows:
//   1. strategy: 'sequential' runs the roster in order; each agent's output
//      is the next agent's input
//   2. Same .generate() surface as a single agent — drop-in swap
//   3. result.agentCalls lists who ran, in what order, with what input
//   4. The companion file examples/single-agent-briefing.mjs runs a single
//      agent() on a comparable task. Diff the two files to see what the
//      hand-off adds on top of one agent.
//   5. The companion file examples/emergent-hierarchical-spawning.mjs adds
//      runtime synthesis on top: the team can mint a new specialist mid-run
//      when its static roster falls short.
//
// Usage:
//   export OPENAI_API_KEY="sk-..."
//   node examples/agency-sequential-handoff.mjs

import { agency } from '../dist/index.js';

const provider = process.env.AGENTOS_PROVIDER || 'openai';

async function main() {
  const team = agency({
    provider,
    model: 'gpt-4o',
    strategy: 'sequential',
    agents: {
      researcher: {
        instructions: 'List the factual claims that matter for the comparison, one per line.',
      },
      writer: {
        instructions: "Compose a two-paragraph briefing from the researcher's notes you receive.",
      },
      reviewer: {
        instructions: 'Review the briefing you receive: flag any claim that needs a source and any sentence a reader could misread.',
      },
    },
  });

  const result = await team.generate(
    'Compare QUIC and TCP for low-latency game networking.',
  );

  console.log('\n--- final answer ---\n');
  console.log(result.text);

  console.log('\n--- agent calls (who ran, in what order, with what input) ---');
  for (const call of result.agentCalls ?? []) {
    console.log(`  ${call.agent}: ${String(call.input).slice(0, 120)}`);
  }

  if (result.usage) {
    console.log('\n--- usage ---');
    console.log(JSON.stringify(result.usage, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
