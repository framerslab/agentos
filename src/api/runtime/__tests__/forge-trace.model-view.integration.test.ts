/**
 * @fileoverview What a forge_tool call looks like to the model and to a host's
 * stream through generateText and streamText: the `tool` message each sends
 * with its next model call, and the `tool-result` part streamText yields. The
 * values are pinned as commit fd17f220 wrote them, so a trace on a forge's
 * result changes none of them. The provider is mocked at the model module, as
 * streamText's own tests mock it; forge_tool runs on a real engine over a real
 * tool executor, with a scripted judge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const generateCompletionStream = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion, generateCompletionStream }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return {
    generateCompletion,
    generateCompletionStream,
    getProvider,
    createProviderManager,
  };
});

vi.mock('../../model.js', () => ({
  parseModelString: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4.1-mini' })),
  resolveModelOption: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4.1-mini' })),
  resolveProvider: vi.fn(() => ({
    providerId: 'openai',
    modelId: 'gpt-4.1-mini',
    apiKey: 'test-key',
  })),
  createProviderManager: hoisted.createProviderManager,
}));

import { streamText } from '../streamText.js';
import { generateText } from '../generateText.js';
import {
  PINS,
  PIN_OUTCOMES,
  failNextRegistration,
  pinArgs,
  pinJudgeReply,
  type PinOutcome,
} from '../../../cognition/emergent/__tests__/fixtures/forge-trace-pins.js';
import { directEngine, freezeClock } from '../../../cognition/emergent/__tests__/helpers/forge-trace-harness.js';

/** The names only a trace carries: none may reach what the model reads or what a host streams. */
const TRACE_NAMES = ['traceVersion', 'forgeId', 'provenanceVersion'];

/** A message a model call received, as far as the pins read it. */
type SentMessage = { role: string; content?: unknown };

/** A part of streamText's full stream, as far as the pins read it. */
type Part = { type: string; [key: string]: unknown };

/** The model's call to forge_tool with the outcome's arguments. */
function forgeCall(outcome: PinOutcome): Record<string, unknown> {
  return {
    id: 'call_forge',
    type: 'function',
    function: { name: 'forge_tool', arguments: JSON.stringify(pinArgs(outcome)) },
  };
}

/** generateText's two model calls: the first asks for forge_tool, the second answers in text. */
function scriptCompletions(outcome: PinOutcome): void {
  hoisted.generateCompletion
    .mockResolvedValueOnce({
      modelId: 'gpt-4.1-mini',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      choices: [
        {
          message: { role: 'assistant', content: null, tool_calls: [forgeCall(outcome)] },
          finishReason: 'tool_calls',
        },
      ],
    })
    .mockResolvedValueOnce({
      modelId: 'gpt-4.1-mini',
      usage: { promptTokens: 7, completionTokens: 1, totalTokens: 8 },
      choices: [{ message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop' }],
    });
}

/** streamText's two model calls: the first streams a call to forge_tool, the second streams text. */
function scriptStreams(outcome: PinOutcome): void {
  hoisted.generateCompletionStream
    .mockImplementationOnce(async function* () {
      yield {
        id: 'step-1',
        object: 'chat.completion.chunk',
        created: 1,
        modelId: 'gpt-4.1-mini',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: null, tool_calls: [forgeCall(outcome)] },
            finishReason: 'tool_calls',
          },
        ],
        isFinal: true,
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      };
    })
    .mockImplementationOnce(async function* () {
      yield {
        id: 'step-2',
        object: 'chat.completion.chunk',
        created: 2,
        modelId: 'gpt-4.1-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop' }],
        responseTextDelta: 'Done.',
        isFinal: true,
        usage: { promptTokens: 7, completionTokens: 1, totalTokens: 8 },
      };
    });
}

/** The call's tools: forge_tool over a real engine whose judge answers for the outcome. */
async function forgeTools(outcome: PinOutcome): Promise<Record<string, Awaited<ReturnType<typeof directEngine>>['forgeTool']>> {
  const { forgeTool } = await directEngine({ judgeReplies: [pinJudgeReply(outcome)] });
  if (outcome === 'thrown') {
    failNextRegistration();
  }
  return { forge_tool: forgeTool };
}

/** The one `tool` message among the messages a model call received. */
function toolMessageOf(messages: unknown): SentMessage {
  const toolMessages = (messages as SentMessage[]).filter((message) => message.role === 'tool');
  expect(toolMessages).toHaveLength(1);
  return toolMessages[0];
}

/** A generateText call in which the model calls forge_tool and then answers; the content of its tool turn. */
async function generateTextTurn(outcome: PinOutcome): Promise<unknown> {
  scriptCompletions(outcome);
  const tools = await forgeTools(outcome);

  const result = await generateText({
    model: 'openai:gpt-4.1-mini',
    prompt: 'Forge it.',
    maxSteps: 2,
    fallbackProviders: [],
    tools,
  });

  expect(result.text).toBe('Done.');
  expect(hoisted.generateCompletion).toHaveBeenCalledTimes(2);
  return toolMessageOf(hoisted.generateCompletion.mock.calls[1][1]).content;
}

/** A streamText call in which the model calls forge_tool and then answers; its tool turn and its tool-result part. */
async function streamTextTurn(outcome: PinOutcome): Promise<{ toolMessage: unknown; resultPart: Part }> {
  scriptStreams(outcome);
  const tools = await forgeTools(outcome);

  const result = streamText({
    model: 'openai:gpt-4.1-mini',
    prompt: 'Forge it.',
    maxSteps: 2,
    fallbackProviders: [],
    tools,
  });
  const parts: Part[] = [];
  for await (const part of result.fullStream) {
    parts.push(part as unknown as Part);
  }

  expect(hoisted.generateCompletionStream).toHaveBeenCalledTimes(2);
  const resultParts = parts.filter((part) => part.type === 'tool-result');
  expect(resultParts).toHaveLength(1);
  return {
    toolMessage: toolMessageOf(hoisted.generateCompletionStream.mock.calls[1][1]).content,
    resultPart: resultParts[0],
  };
}

describe('forge trace: what generateText and streamText send and stream for forge_tool is unchanged', () => {
  let releaseClock: () => void = () => undefined;

  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
    hoisted.generateCompletionStream.mockReset();
    releaseClock = freezeClock();
  });

  afterEach(() => {
    releaseClock();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(PIN_OUTCOMES)("pin 1: generateText's tool turn is unchanged (%s)", async (outcome) => {
    const content = await generateTextTurn(outcome);

    expect(content).toBe(PINS.generateTextTurn[outcome]);
    for (const name of TRACE_NAMES) {
      expect(content as string).not.toContain(name);
    }
  });

  it.each(PIN_OUTCOMES)("pin 1: streamText's tool turn is unchanged (%s)", async (outcome) => {
    const { toolMessage } = await streamTextTurn(outcome);

    expect(toolMessage).toBe(PINS.streamTextTurn[outcome]);
    for (const name of TRACE_NAMES) {
      expect(toolMessage as string).not.toContain(name);
    }
  });

  it.each(PIN_OUTCOMES)("pin 2: streamText's tool-result part is unchanged (%s)", async (outcome) => {
    const { resultPart } = await streamTextTurn(outcome);

    expect(resultPart.toolName).toBe('forge_tool');
    expect(resultPart.result).toEqual(PINS.streamTextPart[outcome]);
    const json = JSON.stringify(resultPart.result);
    for (const name of TRACE_NAMES) {
      expect(json).not.toContain(name);
    }
  });
});
