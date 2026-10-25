# Structured Output API — generateObject, streamObject & embedText

Three functions exported from `@framers/agentos` turn a model call into data:

| Function | Returns |
|-----|---------|
| [`generateObject()`](https://github.com/framerslab/agentos/blob/master/src/api/generateObject.ts) | An object validated against a Zod schema, retrying with the validation errors when a reply does not fit |
| [`streamObject()`](https://github.com/framerslab/agentos/blob/master/src/api/streamObject.ts) | Partial objects, and each completed element of one array field, while the reply streams, and the validated object when it ends |
| [`embedText()`](https://github.com/framerslab/agentos/blob/master/src/api/embedText.ts) | One embedding vector per input text |

[`StructuredOutputManager`](./STRUCTURED_OUTPUT.md) is the lower-level class that works with JSON Schema, and a [structured reply](../features/STRUCTURED_REPLY.md) asks for a schema answer inside an agent session.

---

## generateObject()

```typescript
import { generateObject } from '@framers/agentos';
import { z } from 'zod';

const ReviewSchema = z.object({
  summary: z.string().max(200),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  score: z.number().int().min(1).max(5),
  keywords: z.array(z.string()).min(1).max(10),
  recommendation: z.boolean(),
});

const result = await generateObject({
  provider: 'openai',
  schema: ReviewSchema,
  schemaName: 'Review',
  prompt: 'Analyze this review: "Great product! Fast shipping, exactly as described. Would buy again."',
});

result.object;       // typed as z.infer<typeof ReviewSchema>
result.text;         // the raw reply that validated
result.usage;        // { promptTokens, completionTokens, totalTokens, costUSD?, cacheReadTokens?, cacheCreationTokens? }, summed over every attempt
result.provider;     // 'openai'
result.model;        // 'gpt-4o', the provider's default text model
result.finishReason; // of the attempt that validated
result.fallback;     // { fired, finalProvider, finalModel, hops }
```

### What a call does

1. The Zod schema is converted to JSON Schema ([`lowerZodToJsonSchema`](https://github.com/framerslab/agentos/blob/master/src/orchestration/compiler/SchemaLowering.ts)), which handles strings, numbers, booleans, null, objects, arrays, enums, literals, records, tuples, unions and discriminated unions, and the optional, default and nullable wrappers. Any other Zod type, `z.lazy()` included, becomes `{}`, an untyped field. The text of `.describe()` is not carried over.
2. The JSON Schema goes into the system prompt after `system`, with an instruction to answer with JSON only, the `schemaName` and the `schemaDescription`. The prompt's copy keeps the size checks (`.min()`, `.max()`, `.length()`), which the provider payload leaves out.
3. The provider gets its own structured-output format: strict `json_schema` on OpenAI and OpenRouter when the schema fits OpenAI's strict rules (JSON-object mode otherwise); `responseSchema` on Gemini; nothing on the other providers ([Tool Calling Support](../features/LLM_PROVIDERS.md#tool-calling-support)); and on Anthropic one of three routes, picked for the model and the schema: the native JSON output format (`output_config.format`) on a model that has it when the schema fits the format's limits; a forced tool call whose input is the schema, without `strict`, for a schema the format cannot carry (a `z.record()`, more than 16 union-typed properties) on a model that accepts a forced tool choice, Claude Sonnet 4.6 among them, and for every schema on Claude Opus 4 and Sonnet 4; and the schema in the system prompt alone on a model that refuses a forced tool choice (Claude Opus 5.5, Sonnet 5.5, Fable, Mythos 5.1) when the format cannot carry the schema, and wherever a `thinking` budget would clamp the forced tool to `auto` or a passthrough `customModelParams.tool_choice` of `auto`, `none` or another tool's name lets the model skip the schema tool (`any` keeps the forced tool). On the forced route the call's input is the reply's text, and the call is never run as a tool. A fallback provider gets the format for its own provider.
4. A top-level `z.array()` schema is sent as an object with the array under `items` (named `<schemaName>Envelope`), since OpenAI's JSON modes take only objects, and the array is returned unwrapped.
5. Without `maxTokens`, the output budget is estimated from the schema's size.
6. The reply is parsed as JSON: the whole text, then a fenced code block, then the text from the first `{` to the last `}`. When validation finds an array or object that came back as a quoted JSON string, that string is parsed in place once, and the value is validated against the Zod schema.

When the reply does not parse or does not validate, the reply (shortened) and a correction are added to the conversation and the call runs again, up to `maxRetries` more times (default 2, so three attempts in all). A reply that is not JSON gets the parse error; a reply that does not validate gets the Zod issues (the first ones, with the count of the rest), and a field where an array or object was expected is named with a note to write it as inline JSON; a reply cut off at the token limit (`finishReason: 'length'`; on Anthropic's forced route the cut call's raw input is the reply's text, empty when none of it arrived) is told so and the next attempt gets a budget 1.5 times larger, up to 64,000 tokens. A reply cut off at the limit that parses and validates is returned, its `finishReason` saying `length`. When the last attempt fails, `generateObject()` throws [`ObjectGenerationError`](#errors).

### Options

| Option | Description |
|---|---|
| `schema` | The Zod schema (required) |
| `prompt`, `messages` | The user prompt, and earlier turns to send before it |
| `provider`, `model` | As on `generateText()`; with neither, the global default or the environment picks them |
| `system` | A string, or `SystemContentBlock[]` whose `cacheBreakpoint` flags are kept; the schema instructions come after it |
| `schemaName`, `schemaDescription` | Written into the system prompt |
| `temperature`, `maxTokens` | Passed to the model call; `maxTokens` replaces the estimate |
| `maxRetries` | Retries after a reply that does not parse or validate (default 2) |
| `apiKey`, `baseUrl` | Override the key and the endpoint |
| `fallbackProviders`, `onFallback` | The provider fallback chain, as on `generateText()` ([Fallback Behavior](../features/LLM_PROVIDERS.md#fallback-behavior)); `[]` turns it off |
| `policyTier` | `'safe'`, `'standard'`, `'mature'` or `'private-adult'`; mature tiers fall back to the tier's uncensored models on a refusal ([Uncensored Content](../features/UNCENSORED_CONTENT.md)) |
| `requestTimeout` | Per-call request timeout in milliseconds |
| `maxAttempts`, `onAttempt` | The most requests each generation's call sends, a first and its retries together (the provider's configured count when left out), and a callback that reports each request sent with its number, its HTTP status or `null` when none came, and whether it succeeded ([Attempts](../getting-started/HIGH_LEVEL_API.md#attempts)) |
| `abortSignal` | Ends the call when it aborts: the request in flight is cancelled, no further attempt or fallback hop starts, and the call rejects with the signal's reason ([Cancellation](../getting-started/HIGH_LEVEL_API.md#cancellation)) |
| `effort`, `thinking` | Reasoning depth and the thinking switch, passed to the provider; thinking tokens count toward `maxTokens` |
| `cache`, `schemaCacheTtl` | Prompt caching: `cache: false` marks nothing, and `schemaCacheTtl: '1h'` gives the schema block a one-hour cache marker ([Prompt Caching](../features/PROMPT_CACHING.md)) |
| `sessionId` | Sent to OpenRouter as `session_id` for sticky routing; other providers ignore it |
| `source` | A label passed to the usage observer |

---

## streamObject()

`streamObject()` returns at once with two async iterables, of partial objects and of the completed elements of one array field ([Elements of an array field](#elements-of-an-array-field)), and five promises:

```typescript
import { streamObject } from '@framers/agentos';
import { z } from 'zod';

const ArticleSchema = z.object({
  title: z.string(),
  sections: z.array(z.object({ heading: z.string(), body: z.string() })),
  tags: z.array(z.string()),
});

const { partialObjectStream, object, text, usage } = streamObject({
  provider: 'openai',
  schema: ArticleSchema,
  prompt: 'Write a short article about TypeScript generics',
});

for await (const partial of partialObjectStream) {
  // DeepPartial<z.infer<typeof ArticleSchema>>: any field may be missing
  console.log(partial.title ?? '(generating...)', partial.sections?.length ?? 0);
}

const article = await object; // validated against ArticleSchema
console.log(await usage);
```

- The model call starts when `partialObjectStream` or `elementStream` is first read, and `object`, `text`, `usage`, `reportedUsage` and `skipped` settle after the stream ends. A caller that reads neither waits on them forever. The two iterables can be read together, and the stream moves as fast as its readers read it. When every iterable that was read stops before the end (a `break` out of its loop), the request is closed: `object` rejects with `ObjectGenerationError` (`Stream interrupted: ...`), `text` resolves to the text that arrived, and `reportedUsage` to `undefined`. When `abortSignal` aborted before the stop, `object` rejects with the signal's reason instead.
- After each text chunk, the text so far is parsed with the open strings, arrays and objects closed, and an object is yielded when it differs from the last one yielded. The partial values are not validated: a field can hold a string that is still being written. A reader of `partialObjectStream` that starts after `elementStream` began the stream receives the latest partial object first.
- When the stream ends, the whole text is parsed (as in `generateObject()`: whole text, fenced block, first `{` to last `}`) and validated. `object` rejects with `ObjectGenerationError` when the text does not parse or does not validate; there is no retry, and `maxRetries` is accepted and not read. A rejection of `object` that nothing awaits is not reported as an unhandled rejection.
- `streamObject()` reads the `fullStream` of `streamText()`, so a failed stream ends at its `error` part: `partialObjectStream` ends without throwing, `elementStream` throws the stream's error, and `object` rejects with `ObjectGenerationError` (`Stream interrupted: <message>`, the provider's message). When `abortSignal` aborts, the provider's stream stops, both iterations end, and `object` rejects with the signal's reason.
- `usage` resolves to the token usage `streamText()` summed, in which usage the provider never reported counts as zero. `reportedUsage` resolves to that usage when the stream ended on its own and the provider reported usage, a report of zero tokens included, and to `undefined` when the stream failed, was aborted or was not read to its end, or no usage was reported, so a cut stream never reads as costing nothing.
- The schema reaches the model only in the system prompt: `streamObject()` sends no provider-side format. Its options are `schema`, `schemaName` and `schemaDescription` (written into the system prompt), `elements` (below), `maxRetries` (not read), and `provider`, `model`, `prompt`, `messages`, `system` (a string), `temperature`, `maxTokens`, `effort`, `thinking`, `apiKey`, `baseUrl`, `abortSignal`, `requestTimeout` (the per-call request timeout in milliseconds), `maxAttempts` and `onAttempt`, which go to `streamText()` ([Attempts](../getting-started/HIGH_LEVEL_API.md#attempts)). It takes no fallback, policy-tier or cache option, so `streamText()` runs its default fallback chain (built from the keys in the environment) when the first provider fails with a retryable error before any text arrives.

### Elements of an array field

With `elements` naming one array field of the schema, `elementStream` yields each element of that array as soon as it is complete, so a caller can use the first item of an answer while the rest is still streaming:

```typescript
import { streamObject } from '@framers/agentos';
import { z } from 'zod';

const AnswerSchema = z.object({
  sentences: z.array(z.object({ text: z.string().min(1), passage: z.number().int().min(1) })),
});

const { elementStream, skipped, reportedUsage } = streamObject({
  provider: 'openai',
  schema: AnswerSchema,
  elements: 'sentences',
  prompt: 'Answer from the passages, one sentence per claim, citing the passage number.',
});

for await (const sentence of elementStream) {
  // { text: string; passage: number }, validated against the element schema
  console.log(sentence.passage, sentence.text);
}

console.log(await skipped, await reportedUsage);
```

- An element is complete once the next element begins, and the last one once the array's closing bracket arrives, while any field the schema puts after the array is still streaming, or at the latest when the stream ends with text that parses. A reply cut off at the token limit never yields its unfinished last element.
- When the stream ends with text that does not parse, such as a reply cut off at the token limit, `elementStream` throws the `ObjectGenerationError` that `object` rejects with (`Failed to parse streamed JSON: ...`) after the elements completed before the end, so a cut answer never reads as a finished one. An empty reply ends the iteration with nothing yielded, and `object` rejects.
- Each element is parsed by the array's element schema and yielded as the value the schema parses it to. An element that fails the schema is skipped, and `skipped` resolves to the number skipped when the stream ends.
- `elements` names a top-level field of the schema that holds an array; an optional, nullable or default array counts, and one behind a transform, a pipe or `z.lazy()` does not. Any other name throws a `TypeError` at the call, before a request is sent.
- When the stream fails, `elementStream` throws the stream's error after the elements completed before it, so a failed answer never reads as a finished one. A reader of `elementStream` that starts after every iterable that was read stopped before the end throws `ObjectGenerationError` (`Stream interrupted: ...`) after the elements completed before the stop. When `abortSignal` aborts, the iteration ends.
- Without `elements`, `elementStream` yields nothing and `skipped` resolves to 0.

---

## embedText()

```typescript
import { embedText } from '@framers/agentos';

const { embeddings, model, provider, usage } = await embedText({
  provider: 'openai',
  input: ['First document text', 'Second document text'],
});

embeddings.length;    // 2: one number[] per input, in input order
embeddings[0].length; // 1536 for text-embedding-3-small
usage;                // { promptTokens, totalTokens, costUSD? }
```

`input` takes one string or an array, and `embeddings` holds one vector per string either way. The options are `provider`, `model`, `input`, `dimensions`, `maxInputsPerRequest`, `apiKey`, `baseUrl`, `usageLedger`, `budget`, `abortSignal`, `maxAttempts` and `onAttempt`. `onAttempt` reports each request sent to an OpenAI-compatible endpoint, one a batch, as attempt 1 with its HTTP status (`null` when no answer came); a batch is sent once, so `maxAttempts` only refuses a count below 1 ([Attempts](../getting-started/HIGH_LEVEL_API.md#attempts)). When `abortSignal` aborts, the request in flight is cancelled, no later request starts (Gemini sends 100 inputs a request), and the call rejects with the signal's reason; a call whose signal has already aborted sends nothing.

OpenAI-compatible calls send inputs in order in requests of at most 2,048 inputs and 300,000 UTF-8 bytes. Set `maxInputsPerRequest` to an integer from 1 to 2,048 for a smaller batch size. The byte bound conservatively limits total tokens; each input must still fit the model's per-input token limit. An input above the byte bound is rejected. Returned usage sums all requests, and usage from completed requests is recorded even if a later request fails or the call aborts. Native Gemini and Ollama ignore `maxInputsPerRequest`.

| Provider | Default model | Endpoint |
|---|---|---|
| `openai` | `text-embedding-3-small` | `/embeddings` at `https://api.openai.com/v1` or `OPENAI_BASE_URL` |
| `gemini` | `gemini-embedding-2` | Gemini's own embedding API through `GeminiProvider`; a `baseUrl` other than Google's native endpoint uses `/embeddings` |
| `ollama` | `nomic-embed-text` | `/api/embed` at `OLLAMA_BASE_URL` (or `baseUrl`); usage is reported as 0 |
| `openrouter` | None: pass `model` | `/embeddings` at `https://openrouter.ai/api/v1` |
| Any other provider | None: pass `model` | `/embeddings` at `baseUrl`, or at `https://api.openai.com/v1` when no `baseUrl` is passed |

- With neither `provider` nor `model`, the global default provider (`setDefaultProvider()`) is used when one is set, with the default's model when that is not a chat model and the provider's default embedding model otherwise; a provider without one throws. Without a global default, the first of OpenAI (`OPENAI_API_KEY`) and Ollama (`OLLAMA_BASE_URL`) found in the environment is used.
- A vendor with its own OpenAI-compatible embeddings endpoint, such as Mistral, needs `baseUrl` (for example `https://api.mistral.ai/v1`) as well as `model`; without it the request goes to OpenAI's URL with the vendor's key.
- `dimensions` is sent as the `dimensions` field on `/embeddings` and to Gemini as `outputDimensionality`; Ollama does not receive it. Vectors are returned as the provider sends them, with no normalisation.

### Storing the vectors

```typescript
import { embedText } from '@framers/agentos';
import { InMemoryVectorStore } from '@framers/agentos/cognition/rag';

const docs = ['Document 1 text...', 'Document 2 text...', 'Document 3 text...'];
const { embeddings } = await embedText({ provider: 'openai', input: docs });

const store = new InMemoryVectorStore();
await store.initialize({ id: 'docs-store', type: 'in_memory' });
await store.createCollection('docs', embeddings[0].length);
await store.upsert('docs', docs.map((text, i) => ({
  id: `doc-${i}`,
  embedding: embeddings[i],
  textContent: text,
})));

const { embeddings: [queryVector] } = await embedText({ provider: 'openai', input: 'What is the main topic?' });
const { documents } = await store.query('docs', queryVector, { topK: 3, includeTextContent: true });
// [{ id, similarityScore, textContent }, ...], highest cosine similarity first
```

---

## Schemas

Unions, discriminated unions, nested objects and arrays convert to JSON Schema the model can read:

```typescript
const EventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('meeting'), attendees: z.array(z.string()), duration: z.number() }),
  z.object({ type: z.literal('deadline'), project: z.string(), dueDate: z.string() }),
  z.object({ type: z.literal('reminder'), message: z.string(), priority: z.enum(['low', 'medium', 'high']) }),
]);
```

A union becomes `anyOf` with one entry per variant. A recursive schema built with `z.lazy()` converts to `{}`, so the model sees no structure for it; the reply is still validated against the Zod schema. Field descriptions written with `.describe()` do not reach the model: put guidance for a field in `schemaDescription`, `system` or the prompt.

---

## Errors

```typescript
import { generateObject, ObjectGenerationError } from '@framers/agentos';

try {
  await generateObject({ schema: ReviewSchema, prompt: '...', maxRetries: 3 });
} catch (error) {
  if (error instanceof ObjectGenerationError) {
    console.log(error.message);          // names the number of attempts
    console.log(error.rawText);          // the last reply
    console.log(error.validationErrors); // the ZodError of the last attempt, when it parsed but did not validate
  }
}
```

`ObjectGenerationError` is also what `streamObject()`'s `object` rejects with. Provider errors (a missing key, an HTTP failure after the fallback chain) are thrown as they are.

---

## Compared with StructuredOutputManager

| | `generateObject()` / `streamObject()` | [`StructuredOutputManager`](./STRUCTURED_OUTPUT.md) |
|---|---|---|
| **Schema** | Zod | JSON Schema |
| **Result type** | Inferred from the schema | The type argument you pass |
| **Streaming** | `streamObject()` | None |
| **Calls** | Functions; provider and model per call | A class built with an `AIModelProviderManager` |
| **Function calls** | None (use `generateText()` with tools) | `generateFunctionCalls()`, handlers run one after another |
| **Entity extraction** | `generateObject()` with an array schema | `extractEntities()` |

---

## Related Documentation

- [Structured Output Manager](./STRUCTURED_OUTPUT.md): JSON Schema generation, function calls and entity extraction
- [Structured Reply](../features/STRUCTURED_REPLY.md): schema answers in `agent()` sessions and GMI turns
- [LLM Providers](../features/LLM_PROVIDERS.md): provider configuration, fallback and structured-output support
- [High-Level API](../getting-started/HIGH_LEVEL_API.md): every high-level function
