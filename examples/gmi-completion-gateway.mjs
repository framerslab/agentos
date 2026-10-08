#!/usr/bin/env node
// Example: a GMI whose model calls run through a completion gateway, and the
// step, tool and usage chunks of one turn.
//
// The persona's model is the primary hop. The gateway defaults give the
// primary a base URL with no server behind it, so its attempt fails before
// any output with a network error. That error is retryable: the gateway
// resolves the next hop of the fallback chain, and the GMI rebuilds the prompt
// for that hop's model. When the model calls get_weather, the fallback hop
// serves two model steps with a tool round between them; a turn stays on the
// hop that served its last step.
//
// What this example prints:
//   1. USAGE_UPDATE for every provider chunk that carries usage
//   2. STEP_FINISHED for each model step that completes: its index, the hop
//      that served it (0 is the primary), the model and the finish reason
//   3. TOOL_RESULT for each tool result the GMI records
//   4. the turn's usage total, from the GMIOutput the turn returns
//   5. the reasoning trace's WARNING entries for the failed hop and the fallback
//
// It exits with status 1 when the turn fails.
//
// Usage (the example imports the built package from ../dist):
//   pnpm run build
//   export OPENAI_API_KEY="sk-..."
//   node examples/gmi-completion-gateway.mjs
//
// AGENTOS_FALLBACK_PROVIDER and AGENTOS_FALLBACK_MODEL set another fallback
// hop (set both); its key must be in the environment.

import {
  createCompletionGateway,
  GatewayProviderManager,
  GMIInteractionType,
  GMIOutputChunkType,
  ReasoningEntryType,
} from '../dist/index.js';
import { GMI } from '../dist/cognition/substrate/index.js';
import { InMemoryWorkingMemory } from '../dist/cognition/substrate/memory/InMemoryWorkingMemory.js';
import { PromptEngine } from '../dist/core/llm/PromptEngine.js';

const fallbackProvider = process.env.AGENTOS_FALLBACK_PROVIDER || 'openai';
const fallbackModel = process.env.AGENTOS_FALLBACK_MODEL || 'gpt-4o-mini';

// The persona names the primary hop. Its completion options reach every
// model call of the turn.
const persona = {
  id: 'weather_assistant',
  name: 'Weather Assistant',
  version: '1.0.0',
  baseSystemPrompt: 'You answer weather questions. Call get_weather for current conditions.',
  defaultProviderId: 'anthropic',
  defaultModelId: 'claude-haiku-4-5-20251001',
  defaultModelCompletionOptions: { temperature: 0.2, maxTokens: 512 },
  metaPrompts: [],
};

const toolOrchestrator = {
  async listAvailableTools() {
    return [
      {
        name: 'get_weather',
        description: 'Current weather for a city.',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ];
  },
  async processToolCall({ toolCallRequest }) {
    return {
      toolCallId: toolCallRequest.id,
      toolName: toolCallRequest.name,
      output: { city: toolCallRequest.arguments.city, conditions: 'light rain', temperatureC: 14 },
    };
  },
};

async function main() {
  const promptEngine = new PromptEngine();
  await promptEngine.initialize({
    defaultTemplateName: 'openai_chat',
    availableTemplates: {},
    tokenCounting: { strategy: 'estimated' },
    historyManagement: {
      defaultMaxMessages: 20,
      maxTokensForHistory: 4000,
      summarizationTriggerRatio: 0.8,
      preserveImportantMessages: true,
    },
    contextManagement: {
      maxRAGContextTokens: 1500,
      summarizationQualityTier: 'balanced',
      preserveSourceAttributionInSummary: true,
    },
    contextualElementSelection: {
      maxElementsPerType: {},
      defaultMaxElementsPerType: 3,
      priorityResolutionStrategy: 'highest_first',
      conflictResolutionStrategy: 'skip_conflicting',
    },
    performance: { enableCaching: false, cacheTimeoutSeconds: 60 },
  });

  const gmi = new GMI('gateway-example');
  await gmi.initialize(persona, {
    workingMemory: new InMemoryWorkingMemory(),
    promptEngine,
    toolOrchestrator,
    // The GMI calls the utility AI for sentiment tracking, metaprompts and
    // RAG summaries; this persona turns none of them on.
    utilityAI: {},
    completionGateway: createCompletionGateway({
      // Credentials for the primary hop only. Nothing listens on this address.
      apiKey: 'unused',
      baseUrl: 'http://127.0.0.1:9',
      // Fallback hops read their keys from the environment.
      fallbackProviders: [{ provider: fallbackProvider, model: fallbackModel }],
    }),
    llmProviderManager: new GatewayProviderManager().asProviderManager(),
  });

  const turn = gmi.processTurnStream({
    interactionId: 'turn-1',
    userId: 'user-1',
    sessionId: 'session-1',
    type: GMIInteractionType.TEXT,
    content: 'What is the weather in Lisbon right now?',
  });

  // Read the chunks with next() so the turn's GMIOutput, the generator's
  // return value, is kept.
  let next = await turn.next();
  while (!next.done) {
    const chunk = next.value;
    switch (chunk.type) {
      case GMIOutputChunkType.TEXT_DELTA:
        process.stdout.write(chunk.content);
        break;
      case GMIOutputChunkType.TOOL_CALL_REQUEST:
        for (const call of chunk.content) {
          console.log(`\n[tool call] ${call.name} ${JSON.stringify(call.arguments)}`);
        }
        break;
      case GMIOutputChunkType.USAGE_UPDATE: {
        const usage = chunk.content;
        const failed = chunk.metadata?.attemptFailed ? ` (billed failed attempt, hop ${chunk.metadata.hop})` : '';
        console.log(`\n[usage] prompt=${usage.promptTokens ?? 0} completion=${usage.completionTokens ?? 0}${failed}`);
        break;
      }
      case GMIOutputChunkType.STEP_FINISHED: {
        const step = chunk.content;
        console.log(
          `\n[step ${step.stepIndex}] hop=${step.hop} model=${step.providerId}/${step.modelId} ` +
            `finish=${step.finishReason} text=${step.text.length} chars`,
        );
        break;
      }
      case GMIOutputChunkType.TOOL_RESULT: {
        const result = chunk.content;
        console.log(`[tool result] ${result.name} isError=${result.isError} ${JSON.stringify(result.result)}`);
        break;
      }
      case GMIOutputChunkType.ERROR:
        console.error(`\n[error] ${chunk.content}`);
        break;
      default:
        break;
    }
    next = await turn.next();
  }

  const output = next.value;
  console.log('\n--- turn usage (GMIOutput.usage) ---');
  console.log(JSON.stringify(output.usage));

  console.log('\n--- reasoning trace warnings ---');
  for (const entry of gmi.getReasoningTrace().entries) {
    if (entry.type === ReasoningEntryType.WARNING) console.log(`- ${entry.message}`);
  }

  await gmi.shutdown();
  // A failed turn still returns its GMIOutput, with `error` set: for example
  // when the fallback hop's key is missing or its call fails too.
  if (output.error) {
    console.error(`\nThe turn failed: ${output.error.code}: ${output.error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
