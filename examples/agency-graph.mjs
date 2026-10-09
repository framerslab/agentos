#!/usr/bin/env node
// Example: agency() with graph strategy — explicit agent dependencies
//
// The graph strategy topologically sorts agents into tiers based on their
// `dependsOn` declarations. generate() runs the agents of a tier concurrently;
// stream() runs them one after another so the streamed text stays in order.
// An agent with dependencies receives the original prompt plus the plain-text
// outputs of those dependencies.
//
// DAG for this example:
//
//   researcher (tier 0)
//       |
//   +---+---+
//   |       |
//  writer  illustrator  (tier 1 — concurrent)
//   |       |
//   +---+---+
//       |
//    reviewer (tier 2)
//
// Usage:
//   export OPENAI_API_KEY="sk-..."
//   node examples/agency-graph.mjs

import { agency } from '../dist/index.js';

const provider = process.env.AGENTOS_PROVIDER || 'openai';

async function main() {
  const team = agency({
    provider,
    agents: {
      // Tier 0 — no dependencies, runs first
      researcher: {
        instructions:
          'You are a meticulous researcher. Given a topic, gather key facts, ' +
          'statistics, and credible sources. Output a structured research brief.',
      },

      // Tier 1 — both depend on researcher, run concurrently
      writer: {
        instructions:
          'You are a skilled technical writer. Using the research brief provided, ' +
          'write a clear, engaging article of roughly 300 words.',
        dependsOn: ['researcher'],
      },
      illustrator: {
        instructions:
          'You are a visual designer. Using the research brief provided, describe ' +
          '3 illustrations that would complement the article. For each, give a ' +
          'title and a one-sentence description.',
        dependsOn: ['researcher'],
      },

      // Tier 2 — depends on both writer and illustrator, runs last
      reviewer: {
        instructions:
          'You are a senior editor. Review the article and the illustration ' +
          'descriptions for factual accuracy, consistency, and completeness. ' +
          'Output a final verdict with any suggested corrections.',
        dependsOn: ['writer', 'illustrator'],
      },
    },
    strategy: 'graph', // optional — auto-detected when any agent has dependsOn
  });

  // --- Non-streaming run ------------------------------------------------
  console.log('=== agency() graph strategy — generate() ===\n');

  const result = await team.generate(
    'Explain the significance of the James Webb Space Telescope.',
  );

  console.log(result.text);
  console.log('\n--- Agent calls ---');
  for (const call of result.agentCalls) {
    console.log(`  ${call.agent} — ${call.durationMs}ms`);
  }
  console.log(`\nTotal tokens: ${result.usage.totalTokens}`);

  // --- Streaming run ----------------------------------------------------
  console.log('\n=== agency() graph strategy — stream() ===\n');

  const stream = team.stream(
    'Summarise recent breakthroughs in quantum computing.',
  );

  for await (const chunk of stream.textStream) {
    process.stdout.write(chunk);
  }
  process.stdout.write('\n');

  await team.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
