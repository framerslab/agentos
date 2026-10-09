#!/usr/bin/env node
// Example: agent() — one agent handles the whole task.
//
// The baseline before agency(). One agent reasons through the brief on
// its own. No team, no shared state, no inter-agent flow. Its instructions
// and model live inside this single agent(), which calls the model directly
// (agent({ runtime: 'gmi' }) would serve it with a GMI instead).
//
// What this example shows:
//   1. agent() with provider + model + instructions only
//   2. .generate(prompt) returns the final text plus token usage
//   3. The same task in the companion file
//      examples/emergent-hierarchical-spawning.mjs runs through a
//      hierarchical agency() that spawns a security auditor at runtime
//      when its static roster falls short. Diff the two files to see
//      what an agency adds on top of a single brain.
//
// Usage:
//   export OPENAI_API_KEY="sk-..."
//   node examples/single-agent-briefing.mjs

import { agent } from '../dist/index.js';

const provider = process.env.AGENTOS_PROVIDER || 'openai';

async function main() {
  const researcher = agent({
    provider,
    model: 'gpt-4o',
    instructions:
      'You are a research analyst. Find authoritative sources and ' +
      'write concise prose.',
  });

  const result = await researcher.generate(
    'Write a 2-paragraph briefing on agentic-AI sandbox security risks. ' +
    'Include a security-audit perspective on node:vm vs container isolation.',
  );

  console.log('\n--- final answer ---\n');
  console.log(result.text);

  if (result.usage) {
    console.log('\n--- usage ---');
    console.log(JSON.stringify(result.usage, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
