# Structured Output API — generateObject, streamObject & embedText

> Type-safe structured generation with Zod schemas, partial streaming, and automatic retry logic.

---

## Table of Contents

1. [Overview](#overview)
2. [generateObject() API](#generateobject-api)
3. [streamObject() API](#streamobject-api)
4. [embedText() API](#embedtext-api)
5. [Zod Schema Examples](#zod-schema-examples)
6. [Retry Logic](#retry-logic)
7. [Partial Object Streaming](#partial-object-streaming)
8. [Error Handling](#error-handling)
9. [Provider Compatibility](#provider-compatibility)
10. [Comparison with StructuredOutputManager](#comparison-with-structuredoutputmanager)
11. [Related Documentation](#related-documentation)

---

## Overview

AgentOS provides three high-level APIs for working with structured LLM output.
These complement the lower-level [StructuredOutputManager](./STRUCTURED_OUTPUT.md)
with a simpler, type-safe interface:

| API | Purpose |
|-----|---------|
| `generateObject<T>()` | Generate a complete typed object from a prompt + Zod schema |
| `streamObject<T>()` | Stream a typed object incrementally as the LLM generates it |
| `embedText()` | Generate embedding vectors for text (semantic search, RAG) |

All three are top-level exports from `@framers/agentos` and work with any
configured [LLM Provider](../features/LLM_PROVIDERS.md).

---

## generateObject() API

Generate a fully validated, typed object from a prompt and a Zod schema:

```typescript
import { generateObject } from '@framers/agentos';
import { z } from 'zod';

// Define the output shape with Zod
const ReviewSchema = z.object({
  summary: z.string().max(200).describe('One-sentence summary of the review'),
  sentiment: z.enum(['positive', 'neutral', 'negative']).describe('Overall sentiment'),
  score: z.number().int().min(1).max(5).describe('Rating from 1 to 5'),
  keywords: z.array(z.string()).min(1).max(10).describe('Key topics mentioned'),
  recommendation: z.boolean().describe('Whether the reviewer recommends the product'),
});

// Generate a structured object
const result = await generateObject({
  prompt: 'Analyze this review: "Great product! Fast shipping, exactly as described. Would buy again."',
  schema: ReviewSchema,
});

// result.data is fully typed as z.infer<typeof ReviewSchema>
console.log(result.data.summary);         // "Positive review praising fast shipping and accuracy"
console.log(result.data.sentiment);       // "positive"
console.log(result.data.score);           // 5
console.log(result.data.keywords);        // ["shipping", "accuracy", "recommendation"]
console.log(result.data.recommendation);  // true

// Metadata
console.log(result.usage);               // { promptTokens, completionTokens, totalTokens, totalCostUSD }
console.log(result.retryCount);           // 0 (succeeded on first attempt)
console.log(result.provider);            // "openai"
console.log(result.model);              // "gpt-4o"
```

### Full Options

```typescript
const result = await generateObject({
  // Required
  prompt: 'Your prompt text',
  schema: YourZodSchema,

  // Optional
  provider: 'anthropic',             // Override default provider
  model: 'claude-sonnet-4-5-20250929',           // Override default model
  systemPrompt: 'You are an expert analyst', // System message
  temperature: 0.3,                   // Lower = more deterministic
  maxRetries: 5,                      // Validation retry limit (default: 3)
  timeout: 30000,                     // Request timeout in ms
  maxTokens: 4096,                    // Max output tokens
});
```

---

## streamObject() API

Stream a typed object as the LLM generates it. The partial object updates
incrementally, enabling real-time UIs:

```typescript
import { streamObject } from '@framers/agentos';
import { z } from 'zod';

const ArticleSchema = z.object({
  title: z.string().describe('Article title'),
  sections: z.array(z.object({
    heading: z.string(),
    body: z.string(),
  })).describe('Article sections'),
  tags: z.array(z.string()).describe('Tags for the article'),
});

const stream = await streamObject({
  prompt: 'Write a short article about TypeScript generics',
  schema: ArticleSchema,
});

// Consume partial updates as they arrive
for await (const partial of stream) {
  // partial.data is Partial<z.infer<typeof ArticleSchema>>
  console.clear();
  console.log('Title:', partial.data.title ?? '(generating...)');
  console.log('Sections:', partial.data.sections?.length ?? 0);

  // partial.done is true on the final emission
  if (partial.done) {
    console.log('Complete!', partial.data);
  }
}

// After the loop, get the final validated result
const final = stream.result;
console.log(final.data);    // Fully validated ArticleSchema
console.log(final.usage);   // Token usage
```

### Streaming in React

```tsx
import { streamObject } from '@framers/agentos';
import { z } from 'zod';
import { useState, useEffect } from 'react';

const DataSchema = z.object({
  items: z.array(z.object({ name: z.string(), value: z.number() })),
  total: z.number(),
});

function LiveDataView({ prompt }: { prompt: string }) {
  const [data, setData] = useState<Partial<z.infer<typeof DataSchema>>>({});
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const stream = await streamObject({ prompt, schema: DataSchema });
      for await (const partial of stream) {
        if (cancelled) break;
        setData(partial.data);
        if (partial.done) setDone(true);
      }
    })();

    return () => { cancelled = true; };
  }, [prompt]);

  return (
    <div>
      <h2>Items: {data.items?.length ?? '...'}</h2>
      {data.items?.map((item, i) => <p key={i}>{item.name}: {item.value}</p>)}
      {done && <p>Total: {data.total}</p>}
    </div>
  );
}
```

---

## embedText() API

Generate embedding vectors for semantic search, RAG, and similarity
computation:

```typescript
import { embedText } from '@framers/agentos';

// Single text
const result = await embedText('The quick brown fox jumps over the lazy dog');
console.log(result.embedding);   // Float32Array(1536) for OpenAI, 768 for others
console.log(result.dimensions);  // 1536
console.log(result.provider);    // "openai"
console.log(result.model);      // "text-embedding-3-small"

// Batch embedding
const batch = await embedText([
  'First document text',
  'Second document text',
  'Third document text',
]);
console.log(batch.embeddings.length);  // 3
console.log(batch.usage);              // Aggregate token usage
```

### Options

```typescript
const result = await embedText('Your text', {
  provider: 'openai',                          // Override provider
  model: 'text-embedding-3-large',             // Override model
  dimensions: 256,                             // Truncate dimensions (OpenAI only)
  normalize: true,                             // L2-normalize the vector (default: true)
});
```

### Using with Vector Stores

```typescript
import { embedText, createVectorStore } from '@framers/agentos';

const store = await createVectorStore({ type: 'hnsw' });

// Index documents
const docs = ['Document 1 text...', 'Document 2 text...', 'Document 3 text...'];
for (let i = 0; i < docs.length; i++) {
  const { embedding } = await embedText(docs[i]);
  await store.upsert({ id: `doc-${i}`, vector: embedding, metadata: { text: docs[i] } });
}

// Query
const { embedding: query } = await embedText('What is the main topic?');
const results = await store.query(query, { topK: 3 });
```

---

## Zod Schema Examples

### Nested Objects

```typescript
const CompanySchema = z.object({
  name: z.string(),
  founded: z.number().int().min(1800).max(2030),
  ceo: z.object({
    name: z.string(),
    age: z.number().int().optional(),
  }),
  products: z.array(z.object({
    name: z.string(),
    category: z.enum(['software', 'hardware', 'service']),
    revenue: z.number().optional(),
  })),
});
```

### Discriminated Unions

```typescript
const EventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('meeting'),
    attendees: z.array(z.string()),
    duration: z.number(),
  }),
  z.object({
    type: z.literal('deadline'),
    project: z.string(),
    dueDate: z.string(),
  }),
  z.object({
    type: z.literal('reminder'),
    message: z.string(),
    priority: z.enum(['low', 'medium', 'high']),
  }),
]);
```

### Recursive Schemas

```typescript
const TreeNodeSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    label: z.string(),
    children: z.array(TreeNodeSchema).default([]),
  })
);
```

### Schema Descriptions

Zod `.describe()` calls are passed to the LLM as field descriptions,
significantly improving output quality:

```typescript
const schema = z.object({
  // Description helps the LLM understand what each field means
  sentiment: z.enum(['positive', 'neutral', 'negative'])
    .describe('The overall emotional tone of the text'),
  confidence: z.number().min(0).max(1)
    .describe('How confident the model is in its sentiment assessment (0.0 to 1.0)'),
  evidence: z.array(z.string())
    .describe('Direct quotes from the text that support the sentiment classification'),
});
```

---

## Retry Logic

Both `generateObject()` and `streamObject()` automatically retry when the LLM
output fails schema validation:

```
Attempt 1: Generate → Validate → FAIL (missing required field)
Attempt 2: Generate (with validation feedback) → Validate → FAIL (wrong type)
Attempt 3: Generate (with validation feedback) → Validate → PASS ✓
```

### How Retries Work

1. The LLM generates output.
2. The output is parsed as JSON and validated against the Zod schema.
3. If validation fails, the error messages are appended to the next prompt
   as feedback (e.g., "Field 'score' must be an integer between 1 and 5").
4. Steps 1-3 repeat up to `maxRetries` times.

### Retry Configuration

```typescript
const result = await generateObject({
  prompt: '...',
  schema: StrictSchema,
  maxRetries: 5,        // Default: 3
  retryDelay: 500,      // ms between retries (default: 0, but increases with backoff)
});

// Check retry count
if (result.retryCount > 0) {
  console.warn(`Needed ${result.retryCount} retries to produce valid output`);
}
```

---

## Partial Object Streaming

When using `streamObject()`, partial objects are emitted as JSON tokens arrive.
The partial object is always type-safe (fields are `undefined` until populated):

```typescript
const stream = await streamObject({
  prompt: 'List 5 programming languages with their creators',
  schema: z.object({
    languages: z.array(z.object({
      name: z.string(),
      creator: z.string(),
      year: z.number(),
    })),
  }),
});

for await (const partial of stream) {
  // As the LLM streams, you might see:
  // { languages: [{ name: "TypeScript" }] }                          — first field
  // { languages: [{ name: "TypeScript", creator: "Anders Hejlsberg" }] }  — second field
  // { languages: [{ name: "TypeScript", creator: "Anders Hejlsberg", year: 2012 }, { name: "Rust" }] }
  console.log(JSON.stringify(partial.data, null, 2));
}
```

### Deep Partial Type

The streamed type is `DeepPartial<T>` — every field at every nesting level is
optional. Access fields with optional chaining:

```typescript
for await (const { data } of stream) {
  const firstName = data.languages?.[0]?.name;  // string | undefined
}
```

---

## Error Handling

```typescript
import { generateObject, StructuredOutputError } from '@framers/agentos';

try {
  const result = await generateObject({
    prompt: '...',
    schema: StrictSchema,
    maxRetries: 3,
  });
} catch (error) {
  if (error instanceof StructuredOutputError) {
    console.log('Validation failed after all retries');
    console.log('Last attempt:', error.rawOutput);
    console.log('Validation errors:', error.validationErrors);
    console.log('Retry count:', error.retryCount);
    console.log('Provider:', error.provider);
  }
}
```

---

## Provider Compatibility

| Feature | OpenAI | Anthropic | Gemini | Groq | Together | Mistral | Ollama |
|---------|--------|-----------|--------|------|----------|---------|--------|
| `generateObject()` | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| `streamObject()` | Yes | Yes | Yes | Yes | Yes | Yes | Partial |
| `embedText()` | Yes | No | Yes | No | Yes | Yes | Yes |
| **Strategy** | JSON mode | Function calling | JSON mode | JSON mode | Prompt eng. | JSON mode | Prompt eng. |
| **Strict mode** | Yes | No | No | No | No | No | No |

The APIs automatically select the best strategy for each provider. OpenAI uses
native JSON mode with strict schema enforcement; providers without JSON mode
fall back to function calling or prompt engineering.

---

## Comparison with StructuredOutputManager

AgentOS provides two ways to work with structured output:

| | `generateObject()` / `streamObject()` | [`StructuredOutputManager`](https://github.com/framerslab/agentos/blob/master/src/api/structured/output/StructuredOutputManager.ts) |
|---|---|---|
| **Schema format** | Zod | JSON Schema |
| **Type safety** | Full TypeScript inference | Manual typing |
| **Streaming** | Built-in `streamObject()` | Not supported |
| **API surface** | 3 functions | Class with multiple methods |
| **Best for** | Application code, typed APIs | Low-level control, custom strategies |
| **Parallel tools** | No | Yes (`generateFunctionCalls()`) |
| **Entity extraction** | Use `generateObject()` with an array schema | Dedicated `extractEntities()` method |

Use `generateObject()` / `streamObject()` for most application code. Use
[`StructuredOutputManager`](https://github.com/framerslab/agentos/blob/master/src/api/structured/output/StructuredOutputManager.ts) when you need fine-grained control over generation
strategies or parallel function calling.

---

## Related Documentation

- [Structured Output Manager](./STRUCTURED_OUTPUT.md) — JSON Schema-based structured output
- [LLM Providers](../features/LLM_PROVIDERS.md) — Provider configuration and capabilities
- [Cost Optimization](../safety/COST_OPTIMIZATION.md) — Budget management for structured generation
- [High-Level API](../getting-started/HIGH_LEVEL_API.md) — Full API reference
