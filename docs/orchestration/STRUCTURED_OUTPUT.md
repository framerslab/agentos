# Structured Output Manager

## Overview

[`StructuredOutputManager`](https://github.com/framerslab/agentos/blob/master/src/api/structured/output/StructuredOutputManager.ts) asks a model for JSON, parses it, checks it against a JSON Schema and asks again when the check fails. It also turns a prompt into validated function calls and extracts entities from text. A host creates and calls it; nothing else in AgentOS does. For schema-typed results from the high-level API, use [`generateObject()` / `streamObject()`](./STRUCTURED_OUTPUT_API.md) or a [structured reply](../features/STRUCTURED_REPLY.md).

- **Validation**: a subset of JSON Schema, checked by the manager's own validator ([JSON Schema Support](#json-schema-support)).
- **Strategies**: JSON mode, forced function calling, or the schema in the system prompt.
- **Function calls**: the tool calls a model returns in one response, with their arguments validated and their handlers run.
- **Entity extraction**: one or all entities of a schema from a text.
- **Retries**: another attempt after a reply that does not parse or validate.
- **Parsing**: markdown fences, surrounding text, trailing commas, single quotes and unquoted keys are repaired before giving up.

## Quick Start

### Basic Structured Generation

```typescript
import { StructuredOutputManager, type JSONSchema } from '@framers/agentos';

const manager = new StructuredOutputManager({
  llmProviderManager,          // an initialised AIModelProviderManager
  defaultProviderId: 'openai', // default 'openai'
  defaultModelId: 'gpt-4o',    // default 'gpt-4o'
});

// Define your schema
const personSchema: JSONSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    email: { type: 'string', format: 'email' },
    interests: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
    },
  },
  required: ['name', 'email'],
};

// Generate structured output
const result = await manager.generate({
  prompt: 'Extract person info from: John Doe, 30 years old, john@example.com, likes hiking and photography',
  schema: personSchema,
  schemaName: 'Person',
});

console.log(result.data);
// { name: 'John Doe', age: 30, email: 'john@example.com', interests: ['hiking', 'photography'] }
```

`generate()` resolves only with a valid result (`success: true`); when every attempt fails it throws a [`StructuredOutputError`](#error-handling).

### Function Calls

```typescript
const result = await manager.generateFunctionCalls({
  prompt: 'Get weather for New York and current stock price of AAPL',
  functions: [
    {
      name: 'get_weather',
      description: 'Get current weather for a city',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' },
          units: { type: 'string', enum: ['celsius', 'fahrenheit'] },
        },
        required: ['city'],
      },
      handler: async (args) => await weatherAPI.get(args.city, args.units),
    },
    {
      name: 'get_stock_price',
      description: 'Get current stock price',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', pattern: '^[A-Z]{1,5}$' },
        },
        required: ['symbol'],
      },
      handler: async (args) => await stockAPI.getPrice(args.symbol),
    },
  ],
});

result.calls.forEach((call) => {
  if (!call.argumentsValid) console.log(`${call.functionName}: invalid arguments`, call.validationErrors);
  else if (call.executionError) console.log(`${call.functionName}: handler failed`, call.executionError);
  else console.log(`${call.functionName}:`, call.executionResult);
});
```

The manager makes one model call with the functions as tools (`toolChoice` defaults to `'auto'`) and takes every tool call in the reply. It validates each call's arguments against the function's `parameters` and runs the handler of each call whose arguments are valid, one call after another. A handler that throws leaves `argumentsValid` `true` and sets `executionError` to its message. `result.success` is `true` when every call has valid arguments and no handler threw. `maxParallelCalls` is not read. The provider must be `openai`, `anthropic` or `openrouter`; any other provider id throws `Provider <id> does not support function calling`.

### Entity Extraction

```typescript
const result = await manager.extractEntities({
  text: `
    Meeting attendees:
    - John Smith (john@company.com) - Engineering Lead
    - Sarah Johnson (sarah@company.com) - Product Manager
    - Mike Wilson (mike@company.com) - Designer
  `,
  entitySchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      email: { type: 'string', format: 'email' },
      role: { type: 'string' },
    },
    required: ['name', 'email'],
  },
  taskName: 'MeetingAttendee',
  extractAll: true,
});

console.log(result.entities);
// [
//   { name: 'John Smith', email: 'john@company.com', role: 'Engineering Lead' },
//   { name: 'Sarah Johnson', email: 'sarah@company.com', role: 'Product Manager' },
//   { name: 'Mike Wilson', email: 'mike@company.com', role: 'Designer' },
// ]
```

`extractEntities()` runs `generate()` with a wrapper schema: `{ entities: [<entitySchema>] }` when `extractAll` is set, otherwise `{ entity, found }`. The prompt is `Extract <taskName> from the following text`, followed by `instructions` and `examples` when given. A failed generation does not throw here: the result has `success: false`, no entities and the error message in `issues`.

## Generation Strategies

| Strategy | Request | Schema in the prompt |
|---|---|---|
| `json_mode` | `responseFormat: { type: 'json_object' }` | Yes, in the system prompt |
| `function_calling` | One tool named `schemaName` with the schema as its parameters, and `toolChoice` forcing it; the result is the tool call's arguments | No |
| `prompt_engineering` | No format option | Yes, in the system prompt |
| `grammar` | No format option | No |
| `auto` (default) | `recommendStrategy()` picks one of the first three | |

```typescript
const result = await manager.generate({
  prompt: 'List 3 colors',
  schema: {
    type: 'object',
    properties: { colors: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 } },
    required: ['colors'],
  },
  schemaName: 'Colors',
  strategy: 'json_mode',
});
```

`recommendStrategy(providerId, modelId, schema)` reads the provider's row in the manager's capability table below. It returns `function_calling` when a top-level property of the schema is an object or an array and the provider supports function calling, else `json_mode` when the provider supports JSON mode, else `prompt_engineering`. A provider id missing from the table gets the `default` row, which supports neither, so `auto` sends it `prompt_engineering`.

With `includeReasoning: true`, the system prompt of `json_mode` and `prompt_engineering` allows a `<reasoning>...</reasoning>` block before the JSON; the manager returns it as `result.reasoning` and parses the rest. Each call sends `temperature` (default 0.1) and `maxTokens` when set; `timeoutMs` and the manager's `defaultTimeoutMs` are not read.

## JSON Schema Support

### Checked Keywords

| Category | Keywords |
|----------|----------|
| **Type** | `type` (one or a list), `enum`, `const` |
| **String** | `minLength`, `maxLength`, `pattern`, `format` |
| **Number** | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum` (as numbers), `multipleOf` |
| **Array** | `items` (one schema for every item), `minItems`, `maxItems`, `uniqueItems` |
| **Object** | `properties`, `required`, `patternProperties`, `additionalProperties` (a schema, or `false` in strict mode), `minProperties`, `maxProperties` |
| **Composition** | `allOf`, `anyOf`, `oneOf` |
| **References** | `$ref` of the form `#/$defs/<Name>` |

`JSONSchema` also declares `not`, `if`/`then`/`else`, `prefixItems`, `contains`, `propertyNames`, `dependentRequired`, `dependentSchemas` and `additionalItems`; the validator does not check them. `additionalProperties: false` is enforced only with `strict: true`. A `$ref` resolves against the `$defs` of the schema node that holds it, then against the schemas registered with `registerSchema()`; a `$ref` that resolves to neither is skipped and the node's other keywords are checked.

### Format Validators

Formats are checked with simple patterns; an unknown format passes.

| Format | Check |
|--------|-------|
| `email` | `text@text.text`, no spaces |
| `uri` | Starts with `http://` or `https://` |
| `uri-reference` | Starts with `http://`, `https://`, `/`, `./` or `../` |
| `uuid` | 8-4-4-4-12 hexadecimal digits (any version) |
| `date-time` | `Date.parse()` accepts it |
| `date` | `YYYY-MM-DD` |
| `time` | `HH:MM`, optional seconds, fraction and zone |
| `hostname` | Dot-separated labels of letters, digits and hyphens |
| `ipv4` | Four dot-separated groups of 1-3 digits |
| `ipv6` | Eight colon-separated groups (no `::` shorthand) |
| `regex` | `new RegExp()` accepts it |

## Validation

### Manual Validation

```typescript
const issues = manager.validate(
  { name: 'John', age: -5 },
  personSchema,
  true // strict mode
);

issues.forEach((issue) => {
  console.log(`${issue.path}: ${issue.message}`);
  // "age: Value must be >= 0"
  // "email: Missing required property: email"
});
```

### Custom Validators

```typescript
const result = await manager.generate({
  prompt: 'Generate a booking',
  schema: bookingSchema,
  schemaName: 'Booking',
  customValidator: (data) => {
    const booking = data as { startDate: string; endDate: string };
    if (booking.endDate < booking.startDate) {
      return [{
        path: 'endDate',
        message: 'End date must be after start date',
        keyword: 'custom',
        severity: 'error',
      }];
    }
    return [];
  },
});
```

`customValidator` runs only when the schema check passed, and the issues it returns count as a failed attempt.

## Retry Logic

```typescript
const result = await manager.generate({
  prompt: 'Generate data',
  schema: strictSchema,
  schemaName: 'Data',
  maxRetries: 5, // default: the manager's defaultMaxRetries, 3
});

console.log(`Succeeded after ${result.retryCount} retries`);
```

`generate()` makes up to `maxRetries + 1` attempts. After a reply that does not parse or validate, the next attempt sends the same messages plus a user message saying the previous response did not conform to the schema; the validation errors and the previous reply are not included. A provider error is retried the same way, and on the last attempt it is thrown as it is.

## Schema Registration

```typescript
manager.registerSchema('Address', {
  type: 'object',
  properties: {
    street: { type: 'string' },
    city: { type: 'string' },
    country: { type: 'string' },
    postalCode: { type: 'string' },
  },
  required: ['street', 'city', 'country'],
});

// The validator resolves '#/$defs/Address' through the registry.
// The model sees the schema as sent, so include the definition for it too.
const orderSchema: JSONSchema = {
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    shippingAddress: { $ref: '#/$defs/Address' },
    billingAddress: { $ref: '#/$defs/Address' },
  },
  required: ['orderId', 'shippingAddress'],
  $defs: {
    Address: manager.getSchema('Address')!,
  },
};
```

## Statistics

```typescript
const stats = manager.getStatistics();

console.log(`Success rate: ${(stats.successRate * 100).toFixed(1)}%`);
console.log(`Average retries: ${stats.avgRetries.toFixed(2)}`);
console.log(`Average latency: ${stats.avgLatencyMs.toFixed(0)}ms`);
console.log(`Total tokens: ${stats.totalTokensUsed}`);
console.log('Top validation errors:', stats.topValidationErrors); // [{ keyword, count }], up to 10

manager.resetStatistics();
```

The statistics cover `generate()` calls (and the `extractEntities()` calls made through it), counted per call to `generate()`. `totalTokensUsed` adds the usage of successful attempts only, and `byStrategy` counts the strategy each call used.

## Error Handling

```typescript
import { StructuredOutputError } from '@framers/agentos';

try {
  const result = await manager.generate({
    prompt: 'Generate data',
    schema: strictSchema,
    schemaName: 'Data',
    maxRetries: 3,
  });
} catch (error) {
  if (error instanceof StructuredOutputError) {
    console.log('Validation failed after retries:', error.validationErrors);
    console.log('Raw output was:', error.rawOutput);
    console.log('Strategy used:', error.strategy);
    console.log('Retry count:', error.retryCount);
  }
}
```

`generate()` throws `StructuredOutputError` when every attempt fails validation or parsing, and when the provider id is not registered. A provider error on the last attempt is thrown unwrapped.

## Provider Capabilities

The manager's own table, used by `recommendStrategy()` and by `generateFunctionCalls()`:

| Provider id | JSON Mode | Function Calling | Parallel Calls | Strict Mode |
|----------|-----------|------------------|----------------|-------------|
| `openai` | ✅ | ✅ | ✅ | ✅ |
| `anthropic` | ❌ | ✅ | ✅ | ❌ |
| `openrouter` | ✅ | ✅ | ✅ | ❌ |
| `ollama` | ✅ | ❌ | ❌ | ❌ |
| any other id | ❌ | ❌ | ❌ | ❌ |

The parallel-calls and strict-mode columns are recorded and not read. `strict: true` on a `generate()` call turns on strict validation and is sent as the tool's `strict` flag under `function_calling`, whatever the provider.

## Best Practices

### 1. Use Descriptive Schemas

```typescript
// Descriptions reach the model with the schema
const schema: JSONSchema = {
  type: 'object',
  description: 'A product review with sentiment analysis',
  properties: {
    summary: {
      type: 'string',
      description: 'One sentence summary of the review',
      maxLength: 200,
    },
    sentiment: {
      type: 'string',
      enum: ['positive', 'neutral', 'negative'],
      description: 'Overall sentiment of the review',
    },
    score: {
      type: 'integer',
      minimum: 1,
      maximum: 5,
      description: 'Rating from 1 (worst) to 5 (best)',
    },
  },
};
```

### 2. Start Simple

```typescript
// Start with simple schemas, add constraints as needed
const v1Schema: JSONSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number' },
  },
};

// Later, add constraints based on real-world issues
const v2Schema: JSONSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    age: { type: 'integer', minimum: 0, maximum: 150 },
  },
  required: ['name'],
};
```

### 3. Choose the Retry Budget

Every retry is another full model call, so a simple extraction rarely needs more than the default 3, while a long schema with tight constraints may need more.

## Related Documentation

- [Structured Output API](./STRUCTURED_OUTPUT_API.md) - `generateObject()` and `streamObject()`
- [Architecture](../architecture/ARCHITECTURE.md) - Full system overview
- [Planning Engine](./PLANNING_ENGINE.md) - LLM-generated step plans
- [Human-in-the-Loop](../safety/HUMAN_IN_THE_LOOP.md) - Human oversight
