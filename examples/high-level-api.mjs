#!/usr/bin/env node

import { agent, generateImage, generateText, streamText } from '../dist/index.js';

// Set a provider and AgentOS picks the best default model. Pin a specific
// model whenever you need it. Requires the matching env var to be set
// (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.).

const provider = process.env.AGENTOS_PROVIDER || 'openai';
const model = process.env.AGENTOS_MODEL; // optional override

async function main() {
  console.log(`Using provider: ${provider}${model ? ` model: ${model}` : ' (default model)'}`);

  console.log('\n=== generateText() — provider, default model ===');
  const quick = await generateText({
    provider,
    prompt: 'Explain what QUIC is in 3 concise bullet points.',
  });
  console.log(quick.text);

  console.log('\n=== generateText() — provider + pinned model ===');
  const pinned = await generateText({
    provider: 'openai',
    model: 'gpt-4o',
    prompt: 'What is TCP in one sentence?',
  });
  console.log(pinned.text);

  console.log('\n=== streamText() — provider-first ===');
  const live = streamText({
    provider,
    prompt: 'Stream a short explanation of how QUIC differs from TCP.',
  });
  for await (const delta of live.textStream) {
    process.stdout.write(delta);
  }
  process.stdout.write('\n');

  console.log('\n=== generateImage() — provider-first ===');
  const image = await generateImage({
    provider: 'openai',
    prompt: 'A clean technical illustration of packets moving through a network switch.',
  });
  console.log(`provider=${image.provider} images=${image.images.length}`);

  console.log('\n=== agent() — provider-first ===');
  // Each session keeps its message history. Cognitive memory needs
  // runtime: 'gmi' and an embedding model (memory.embedding); agent() does not
  // read the other MemoryConfig fields, such as types or working: { enabled: true }.
  const assistant = agent({
    provider,
    instructions: 'You are a concise networking tutor.',
    maxSteps: 3,
  });

  const session = assistant.session('high-level-api-demo');
  const first = await session.send('What problem was QUIC designed to solve?');
  console.log(first.text);

  const second = await session.send('Now compare QUIC and TCP in one short paragraph.');
  console.log(second.text);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
