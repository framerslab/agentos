import type { ZodType } from 'zod';
import { ObjectGenerationError } from '../generateObject.js';
import type { GenerateTextResult } from '../generateText.js';
import { dropNullsForOptionalFields, extractJson, parseJsonWithDistinctKeys } from './structuredReply.js';

/** Validate a generated reply with the same extraction, normalization and errors on both runtimes. */
export function validateAgentReply(
  reply: Pick<GenerateTextResult, 'text' | 'refusal'>,
  schema: ZodType,
  extract: boolean,
): { ok: true; value: unknown } | { ok: false; error: ObjectGenerationError } {
  if (reply.refusal !== undefined) {
    return {
      ok: false,
      error: new ObjectGenerationError('The model refused the request instead of writing the reply', reply.text, undefined, reply.refusal),
    };
  }
  try {
    const parsed = extract ? extractJson(reply.text) : parseJsonWithDistinctKeys(reply.text);
    // A strict json_schema payload makes every optional property nullable: a null there means absent.
    const safe = schema.safeParse(dropNullsForOptionalFields(parsed, schema));
    return safe.success
      ? { ok: true, value: safe.data }
      : { ok: false, error: new ObjectGenerationError('Response failed Zod validation', reply.text, safe.error) };
  } catch (err) {
    return {
      ok: false,
      error: new ObjectGenerationError(
        `Response is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
        reply.text,
      ),
    };
  }
}

/** The user message that asks the model to repair its preceding reply. */
export function validationRepairPrompt(failure: ObjectGenerationError): string {
  const feedback = failure.validationErrors?.message ?? failure.message;
  return `Your reply did not match the schema: ${feedback}. Reply again with JSON that matches it.`;
}
