# Structured reply

A turn on the full runtime whose reply must match a schema. The request names the schema; the runtime instructs the model, parses and checks the reply, asks again inside the turn when it does not match, and hands the caller the parsed value on the final chunk.

```typescript
import { AgentOS } from '@framers/agentos';
import { z } from 'zod';

const week = z.object({ items: z.array(z.object({ date: z.string(), title: z.string(), heavy: z.boolean() })) });

// A runtime whose persona list holds a 'planner' persona.
const agentos = await AgentOS.create();

for await (const chunk of agentos.processRequest({
  userId: 'user-1', sessionId: 'session-1', selectedPersonaId: 'planner',
  textInput: 'Draft my week from the path.',
  options: { structuredReply: { schema: week, name: 'week', maxRetries: 2 } },
})) {
  if (chunk.type === 'final_response' && chunk.structured?.meta.valid) {
    const plan = chunk.structured.value as z.infer<typeof week>;
  }
}
```

## The spec

`ProcessingOptions.structuredReply`:

| Field | Default | Meaning |
|---|---|---|
| `schema` | | A Zod schema or a JSON Schema object. |
| `schemaRef` | | A key in `AgentOSConfig.structuredSchemas` (a `Map` or anything with `get(ref)`), resolved before the turn. One of `schema` and `schemaRef` is required; a request that names neither, or a ref the registry lacks, is refused with `SYS_VALIDATION_ERROR` and no model call. |
| `name` | `reply` | Named in the instruction and in `structured.meta.schemaName`. |
| `description` | | Added to the instruction. |
| `maxRetries` | `2` | Repair rounds after a reply that does not match, clamped to 0 to 5. |
| `onExhausted` | `error` | `error`: the turn ends with `GMI_STRUCTURED_OUTPUT_INVALID` (422). `return_invalid`: the last reply is returned with `meta.valid: false` and its issues. |
| `streamDeltas` | `false` | Stream the model's text while it writes. Off, nothing reaches the caller before the check. |

## What the turn does

1. The schema's instruction (the JSON Schema, in words the model follows) is the last block of the system prompt, after every other instruction the turn adds. A Zod schema also travels to the completion gateway where a GMI has one, which lowers it per provider.
2. The model's text is parsed (plain JSON, a code fence, or the first to the last brace), then checked: Zod's `safeParse`, with one repair of a container the model string-encoded; or Ajv for a JSON Schema. Ajv reads a JSON Schema as draft-07, reports every error, checks the standard formats (`date-time`, `email`, `uri` and the others of `ajv-formats`), and passes over a keyword it does not know, as JSON Schema says to, and a format it does not know, which it names in the log when it compiles the schema. A host may send its JSON Schema anew with each request, under one `$id` too.
3. A reply that does not match is answered inside the turn with the issues named and the bad reply quoted, and the model is asked again, up to `maxRetries` times. The invalid reply and the repair request join the turn's prompt and never the durable history; the turn's text starts over with each attempt. A reply that answers with tool calls runs its tools first; the check waits for a step that answers with text.
4. The final chunk carries `structured: { value, meta }`. `meta.attempts` counts the model calls; `meta.enforcement` is `forced_tool` when the gateway lifted a forced schema tool call into the value, `provider_schema` when the provider payload of the hop that answered carried the schema (a strict `json_schema`, Gemini's `responseSchema`, Anthropic's JSON output format, whose JSON text the gateway lifts), `prompt_only` when the schema reached the model in the system prompt alone (a hop with no schema payload, such as a record schema on a Claude model that refuses a forced tool choice, or a JSON mode without a schema). The label follows the request the provider sent, as its chunks report it (`schemaRoute`, `schemaInPayload: false`): an Anthropic request that enables citations answers through the forced tool in place of the format on a model that accepts a forced tool choice (from the prompt on one that refuses it), and one with a thinking budget, or with a passthrough `tool_choice` that does not force the schema tool, answers from the prompt in place of the forced tool. An answer the output limit stopped is never lifted into the value: the check reads its text, and the step keeps its `length` finish. `meta.stage` is `model`.
5. After the output guardrails, a final response a sanitizer rewrote is checked again as it stands. The chunk's `structured` then reads `stage: 'post_guardrail'`; a text that no longer matches ends the request with `GMI_STRUCTURED_OUTPUT_INVALID` under `onExhausted: 'error'`, or arrives with `meta.valid: false` under `return_invalid`.

## Errors

| Code | Status | When |
|---|---|---|
| `SYS_VALIDATION_ERROR` | 400 | The spec names no schema the runtime can reach, or a JSON Schema that does not compile, such as one whose `type` is no JSON Schema type, whose `$schema` names a draft other than draft-07, that takes the draft-07 meta-schema's own `$id` or that is marked `$async` (its check would answer a promise). |
| `GMI_STRUCTURED_OUTPUT_INVALID` | 422 | Every attempt failed under `onExhausted: 'error'`, or an output guardrail broke the shape. Details: `schemaName`, `attempts` or `stage`, `issues`. |

`generateObject` shares the parsers (`extractJson`, `repairStringEncodedContainers`, the issue summaries) with the structured turn; they live in `src/api/runtime/structuredReply.ts`.
