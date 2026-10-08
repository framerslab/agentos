/**
 * @file full-pipeline-e2e.test.ts
 * Full end-to-end integration test for the AgentOS high-level API surface.
 *
 * This test suite is **gated behind the `FULL_E2E=true` environment flag** and
 * requires a valid `OPENAI_API_KEY`.  Every test makes REAL API calls to
 * OpenAI — they are not mocked — so they incur actual token usage and may
 * take 10-60 seconds depending on model and network latency.
 *
 * Coverage:
 * 1. {@link generateText} — single-turn stateless text generation
 * 2. {@link generateObject} — Zod-validated structured output extraction
 * 3. {@link streamText} — streaming token delivery
 * 4. {@link embedText} — batch embedding vector generation
 * 5. {@link agent} with tools — multi-step tool-calling agent loop
 * 6. {@link agent} session — conversational memory across turns
 * 7. {@link agency} sequential strategy — multi-agent pipeline
 * 8. {@link generateImage} — image generation via DALL-E
 * 9. Agent config export / import round-trip validation
 * 10. /v1/responses: a streamed GPT-6 tool loop and a Responses-only model
 *
 * Run with:
 * ```sh
 * FULL_E2E=true OPENAI_API_KEY=sk-... npx vitest run src/api/__tests__/full-pipeline-e2e.test.ts
 * ```
 *
 * @see {@link generateText} for the stateless text generation primitive.
 * @see {@link generateObject} for structured output extraction.
 * @see {@link streamText} for streaming text generation.
 * @see {@link embedText} for embedding vector generation.
 * @see {@link agent} for the stateful agent factory.
 * @see {@link agency} for the multi-agent agency factory.
 * @see {@link generateImage} for image generation.
 * @see {@link validateAgentExport} for config export validation.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { generateText } from '../generateText.js';
import { generateObject } from '../generateObject.js';
import { streamText } from '../streamText.js';
import { embedText } from '../embedText.js';
import { agent } from '../agent.js';
import { agency } from '../../agency.js';
import { generateImage } from '../generateImage.js';
import { validateAgentExport } from '../agentExport.js';

/**
 * Gate flag: only run the suite when both `FULL_E2E=true` and a valid
 * `OPENAI_API_KEY` are present in the environment.
 */
const hasE2E = process.env.FULL_E2E === 'true' && !!process.env.OPENAI_API_KEY;

describe.skipIf(!hasE2E)('Full AgentOS Pipeline E2E', () => {
  // -------------------------------------------------------------------------
  // 1. generateText — stateless single-turn completion
  // -------------------------------------------------------------------------

  it('generateText produces a response', async () => {
    const result = await generateText({
      model: 'openai:gpt-4o-mini',
      prompt: 'Say "hello" and nothing else.',
      maxTokens: 10,
    });

    expect(result.text.toLowerCase()).toContain('hello');
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 2. generateObject — Zod-validated structured extraction
  // -------------------------------------------------------------------------

  it('generateObject extracts structured data', async () => {
    /** Schema describing a person extracted from unstructured text. */
    const PersonSchema = z.object({
      /** Full name of the person. */
      name: z.string(),
      /** Age in years. */
      age: z.number(),
      /** Job title or profession. */
      occupation: z.string(),
    });

    const result = await generateObject({
      model: 'openai:gpt-4o-mini',
      schema: PersonSchema,
      prompt: 'Extract: "John Smith is a 35 year old software engineer"',
    });

    expect(result.object.name).toContain('John');
    expect(result.object.age).toBe(35);
    expect(typeof result.object.occupation).toBe('string');
  });

  // -------------------------------------------------------------------------
  // 3. streamText — streaming token delivery
  // -------------------------------------------------------------------------

  it('streamText streams tokens', async () => {
    const result = streamText({
      model: 'openai:gpt-4o-mini',
      prompt: 'Count from 1 to 5.',
      maxTokens: 50,
    });

    let tokenCount = 0;
    for await (const _token of result.textStream) {
      tokenCount++;
    }

    expect(tokenCount).toBeGreaterThan(3);

    const text = await result.text;
    expect(text).toContain('3');
  });

  // -------------------------------------------------------------------------
  // 4. embedText — batch embedding vector generation
  // -------------------------------------------------------------------------

  it('embedText generates embeddings', async () => {
    const result = await embedText({
      model: 'openai:text-embedding-3-small',
      input: ['Hello world', 'Goodbye world'],
    });

    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0].length).toBeGreaterThan(100);

    // Cosine similarity sanity check: semantically similar phrases should
    // have a positive dot product (high similarity).
    const dot = result.embeddings[0].reduce(
      (sum, v, i) => sum + v * result.embeddings[1][i],
      0,
    );
    expect(dot).toBeGreaterThan(0.5);
  });

  // -------------------------------------------------------------------------
  // 5. agent with tools — multi-step tool-calling loop
  // -------------------------------------------------------------------------

  it('agent with tools executes multi-step', async () => {
    /**
     * Simple addition tool for verifying the agent can invoke tools
     * and incorporate their results into the final response.
     */
    const myAgent = agent({
      model: 'openai:gpt-4o-mini',
      instructions: 'You are helpful. Use the add tool when asked to add numbers.',
      tools: {
        add: {
          description: 'Add two numbers',
          parameters: z.object({
            /** First operand. */
            a: z.number(),
            /** Second operand. */
            b: z.number(),
          }),
          execute: async ({ a, b }: { a: number; b: number }) => ({ result: a + b }),
        },
      },
      maxSteps: 3,
    });

    const result = await myAgent.generate('What is 17 + 25?');
    expect(result.text).toContain('42');
    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.toolCalls[0].name).toBe('add');

    await myAgent.close();
  }, 30_000);

  // -------------------------------------------------------------------------
  // 6. agent session — conversational memory across turns
  // -------------------------------------------------------------------------

  it('agent session maintains conversation history', async () => {
    const myAgent = agent({
      model: 'openai:gpt-4o-mini',
      instructions: 'Remember everything the user tells you.',
    });

    const session = myAgent.session('test');
    await session.send('My favorite color is blue.');
    const result = await session.send('What is my favorite color?');

    expect(result.text.toLowerCase()).toContain('blue');

    await myAgent.close();
  }, 30_000);

  // -------------------------------------------------------------------------
  // 7. agency sequential strategy — multi-agent pipeline
  // -------------------------------------------------------------------------

  it('agency sequential strategy chains agents', async () => {
    const team = agency({
      model: 'openai:gpt-4o-mini',
      agents: {
        researcher: { instructions: 'List 3 facts about cats. Be brief.' },
        writer: { instructions: 'Write a one-sentence summary of the facts you received.' },
      },
      strategy: 'sequential',
    });

    const result = await team.generate('Tell me about cats') as {
      text: string;
      agentCalls?: { agent: string }[];
    };

    expect(result.text.length).toBeGreaterThan(20);
    expect(result.agentCalls?.length).toBe(2);

    await team.close();
  }, 60_000);

  // -------------------------------------------------------------------------
  // 8. generateImage — DALL-E image generation
  // -------------------------------------------------------------------------

  it('generateImage creates an image', async () => {
    const result = await generateImage({
      model: 'openai:dall-e-3',
      prompt: 'A simple red circle on a white background',
      size: '1024x1024',
      n: 1,
    });

    expect(result.images.length).toBe(1);
    expect(
      result.images[0].base64 || result.images[0].url,
    ).toBeTruthy();
  }, 60_000);

  // -------------------------------------------------------------------------
  // 9. Agent config export / import round-trip
  // -------------------------------------------------------------------------

  it('agent config export and import round-trips', async () => {
    const original = agent({
      model: 'openai:gpt-4o-mini',
      instructions: 'You are a test agent.',
      tools: {
        ping: {
          description: 'Ping',
          parameters: z.object({}),
          execute: async () => ({ pong: true }),
        },
      },
    });

    // Verify .export() produces a valid export config
    const exported = original.export?.();
    expect(exported).toBeDefined();
    expect(exported!.config.instructions).toContain('test agent');

    // Verify .exportJSON() produces valid JSON
    const json = original.exportJSON?.();
    expect(json).toBeDefined();

    // Validate the exported JSON passes structural validation.
    // Note: import recreates agent but tools need to be re-attached
    // since function references cannot be serialized.
    const validated = validateAgentExport(JSON.parse(json!));
    expect(validated.valid).toBe(true);

    await original.close();
  });

  // -------------------------------------------------------------------------
  // 10. /v1/responses: a streamed GPT-6 tool loop and a Responses-only model
  // -------------------------------------------------------------------------

  it('streamText runs a gpt-6-sol tool loop', async () => {
    const result = streamText({
      model: 'openai:gpt-6-sol',
      prompt: 'Call the add tool with a=17 and b=25, then state the sum.',
      tools: {
        add: {
          description: 'Add two numbers',
          parameters: z.object({ a: z.number(), b: z.number() }),
          execute: async ({ a, b }: { a: number; b: number }) => ({ result: a + b }),
        },
      },
      maxSteps: 3,
      fallbackProviders: [],
    });

    for await (const _token of result.textStream) {
      // drain
    }

    expect((await result.toolCalls).map((c) => c.name)).toContain('add');
    expect(await result.text).toContain('42');
  }, 60_000);

  it('generateText answers from gpt-5.3-codex', async () => {
    const result = await generateText({
      model: 'openai:gpt-5.3-codex',
      prompt: 'Say "hello" and nothing else.',
      fallbackProviders: [],
    });

    expect(result.text.toLowerCase()).toContain('hello');
  }, 60_000);
});
