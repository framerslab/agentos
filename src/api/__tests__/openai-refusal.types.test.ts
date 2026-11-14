/**
 * @file openai-refusal.types.test.ts
 * The model's refusal is carried in optional fields beside the result types
 * callers already read: code written before the fields existed compiles
 * unchanged, a switch over every finish reason included. The typecheck job
 * runs these assertions; the test runner only loads the file.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
// Types only: the assertions read the package entry's declarations without loading it.
import type * as Entry from '../../index.js';
import type { GenerateTextResult, LlmUsageEvent, StreamFinishReason, StreamTextResult } from '../../index.js';
import type { ModelCompletionChoice, ModelCompletionResponse } from '../../core/llm/providers/IProvider.js';

declare const generateText: typeof Entry.generateText;
declare const streamText: typeof Entry.streamText;
declare const normalizeStreamFinishReason: typeof Entry.normalizeStreamFinishReason;

/** Every finish reason a caller could list before the refusal fields existed. */
type Reason = 'stop' | 'length' | 'tool-calls' | 'error';

/** A caller's switch over every finish reason: its default compiles only while there is no other reason. */
function label(reason: Reason): string {
  switch (reason) {
    case 'stop':
      return 'done';
    case 'length':
      return 'cut';
    case 'tool-calls':
      return 'tools';
    case 'error':
      return 'failed';
    default: {
      const unlisted: never = reason;
      return unlisted;
    }
  }
}

// Never called: the assertions below are type assertions the typecheck job runs.
const _types = async () => {
  const result = await generateText({ prompt: 'x' });
  // A union of the caller's own takes the result's finish reason, and the caller's switch reads it.
  const reason: Reason = result.finishReason;
  void reason;
  label(result.finishReason);
  switch (result.finishReason) {
    case 'stop':
    case 'length':
    case 'tool-calls':
    case 'error':
      break;
    default: {
      const unlisted: never = result.finishReason;
      void unlisted;
    }
  }
  expectTypeOf<GenerateTextResult['finishReason']>().toEqualTypeOf<Reason>();

  const stream = streamText({ prompt: 'x' });
  const streamed: Reason = await stream.finishReason;
  void streamed;
  label(await stream.finishReason);
  expectTypeOf<StreamFinishReason>().toEqualTypeOf<Reason>();
  expectTypeOf(stream.finishReason).resolves.toEqualTypeOf<Reason>();
  expectTypeOf(normalizeStreamFinishReason).returns.toEqualTypeOf<Reason>();

  // The provider's choice reports its finish reason as the plain string it always was.
  expectTypeOf<ModelCompletionChoice['finishReason']>().toEqualTypeOf<string | null>();

  // The refusal travels in optional fields.
  expectTypeOf<GenerateTextResult['refusal']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<StreamTextResult['refusal']>().toEqualTypeOf<Promise<string | undefined> | undefined>();
  expectTypeOf<ModelCompletionChoice['refusal']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ModelCompletionResponse['refusalDelta']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<LlmUsageEvent['refused']>().toEqualTypeOf<true | undefined>();

  // An object built without the new fields is still the result type: a required field would not compile here.
  const choice: ModelCompletionChoice = { index: 0, message: { role: 'assistant', content: 'x' }, finishReason: 'stop' };
  void choice;
  const resultWithout: Omit<GenerateTextResult, 'refusal'> = result;
  const asResult: GenerateTextResult = resultWithout;
  void asResult;
  const streamWithout: Omit<StreamTextResult, 'refusal'> = stream;
  const asStream: StreamTextResult = streamWithout;
  void asStream;
  const event: LlmUsageEvent = { provider: 'openai', model: 'gpt-4.1', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, surface: 'generateText' };
  void event;
};

describe('the refusal fields on the result types', () => {
  it('compile', () => {
    expect(typeof _types).toBe('function');
  });
});
