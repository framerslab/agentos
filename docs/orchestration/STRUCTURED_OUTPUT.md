# Structured Output Manager

## Overview

The Structured Output Manager ensures LLM outputs conform to predefined JSON Schemas, enabling reliable parsing, validation, and type-safe consumption of agent responses.

## Key Features

- **JSON Schema Validation**: Full JSON Schema draft 2020-12 support
- **Multiple Strategies**: JSON mode, function calling, prompt engineering
- **Parallel Function Calls**: Execute multiple tools in a single response
- **Entity Extraction**: Pull structured data from unstructured text
- **Automatic Retry**: Retry with feedback on validation failures
- **Robust Parsing**: Handle malformed JSON from LLMs

## Quick Start

### Basic Structured Generation

```typescript
import { StructuredOutputManager, JSONSchema } from '@framers/agentos/structured/output';

const manager = new StructuredOutputManager({
  llmProviderManager,
  defaultProviderId: 'openai',
  defaultModelId: 'gpt-4o',
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

if (result.success) {
  console.log(result.data);
  // { name: 'John Doe', age: 30, email: 'john@example.com', interests: ['hiking', 'photography'] }
}
```

### Parallel Function Calling

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
  maxParallelCalls: 10,
});

// Both functions called in parallel
result.calls.forEach(call => {
  console.log(`${call.functionName}:`, call.executionResult);
});
```

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
  taskName: 'MeetingAttendeeExtraction',
  extractAll: true,
});

console.log(result.entities);
// [
//   { name: 'John Smith', email: 'john@company.com', role: 'Engineering Lead' },
//   { name: 'Sarah Johnson', email: 'sarah@company.com', role: 'Product Manager' },
//   { name: 'Mike Wilson', email: 'mike@company.com', role: 'Designer' },
// ]
```

## Generation Strategies

### JSON Mode (`json_mode`)

Uses the provider's native JSON mode (OpenAI, OpenRouter, Ollama). Best for simple schemas.

```typescript
const result = await manager.generate({
  prompt: 'List 3 colors',
  schema: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
  schemaName: 'Colors',
  strategy: 'json_mode',
});
```

### Function Calling (`function_calling`)

Uses tool/function calling API. Best for complex nested schemas.

```typescript
const result = await manager.generate({
  prompt: 'Generate a complex report',
  schema: complexReportSchema,
  schemaName: 'Report',
  strategy: 'function_calling',
});
```

### Prompt Engineering (`prompt_engineering`)

Instructs in the prompt and parses output. Fallback for providers without native support.

```typescript
const result = await manager.generate({
  prompt: 'Generate data',
  schema: mySchema,
  schemaName: 'Data',
  strategy: 'prompt_engineering',
});
```

### Auto Selection (`auto`)

Automatically selects the best strategy based on provider capabilities and schema complexity.

```typescript
const result = await manager.generate({
  prompt: 'Generate data',
  schema: mySchema,
  schemaName: 'Data',
  strategy: 'auto', // Default
});
```

## JSON Schema Support

### Supported Keywords

| Category | Keywords |
|----------|----------|
| **Type** | `type`, `enum`, `const` |
| **String** | `minLength`, `maxLength`, `pattern`, `format` |
| **Number** | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` |
| **Array** | `items`, `minItems`, `maxItems`, `uniqueItems` |
| **Object** | `properties`, `required`, `additionalProperties`, `minProperties`, `maxProperties` |
| **Composition** | `allOf`, `anyOf`, `oneOf`, `not` |
| **References** | `$ref`, `$defs` |

### Format Validators

| Format | Description |
|--------|-------------|
| `email` | Email address |
| `uri` | Full URI |
| `uri-reference` | URI or relative reference |
| [`uuid`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/util/crossPlatformCrypto.ts) | UUID v4 |
| `date-time` | ISO 8601 datetime |
| `date` | ISO 8601 date |
| `time` | ISO 8601 time |
| `hostname` | DNS hostname |
| `ipv4` | IPv4 address |
| `ipv6` | IPv6 address |
| `regex` | Valid regex pattern |

## Validation

### Manual Validation

```typescript
const issues = manager.validate(
  { name: 'John', age: -5 },
  personSchema,
  true // strict mode
);

if (issues.length > 0) {
  issues.forEach(issue => {
    console.log(`${issue.path}: ${issue.message}`);
    // "age: Value must be >= 0"
  });
}
```

### Custom Validators

```typescript
const result = await manager.generate({
  prompt: 'Generate user data',
  schema: userSchema,
  schemaName: 'User',
  customValidator: (data) => {
    const issues = [];
    
    // Business logic validation
    if (data.endDate < data.startDate) {
      issues.push({
        path: 'endDate',
        message: 'End date must be after start date',
        keyword: 'custom',
        severity: 'error',
      });
    }
    
    return issues;
  },
});
```

## Retry Logic

The manager automatically retries on validation failure:

```typescript
const result = await manager.generate({
  prompt: 'Generate data',
  schema: strictSchema,
  schemaName: 'Data',
  maxRetries: 5, // Default: 3
});

console.log(`Succeeded after ${result.retryCount} retries`);
```

## Schema Registration

Register schemas for reuse:

```typescript
// Register common schemas
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

// Use in other schemas via $ref
const orderSchema = {
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    shippingAddress: { $ref: '#/$defs/Address' },
    billingAddress: { $ref: '#/$defs/Address' },
  },
  required: ['orderId', 'shippingAddress'],
  $defs: {
    Address: manager.getSchema('Address'),
  },
};
```

## Statistics

Track structured output performance:

```typescript
const stats = manager.getStatistics();

console.log(`Success rate: ${(stats.successRate * 100).toFixed(1)}%`);
console.log(`Average retries: ${stats.avgRetries.toFixed(2)}`);
console.log(`Average latency: ${stats.avgLatencyMs.toFixed(0)}ms`);
console.log(`Total tokens: ${stats.totalTokensUsed}`);
console.log('Top validation errors:', stats.topValidationErrors);

// Reset if needed
manager.resetStatistics();
```

## Error Handling

```typescript
import { StructuredOutputError } from '@framers/agentos/structured/output';

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

## Provider Capabilities

| Provider | JSON Mode | Function Calling | Parallel Calls | Strict Mode |
|----------|-----------|------------------|----------------|-------------|
| OpenAI | ✅ | ✅ | ✅ | ✅ |
| Anthropic | ❌ | ✅ | ✅ | ❌ |
| OpenRouter | ✅ | ✅ | ✅ | ❌ |
| Ollama | ✅ | ❌ | ❌ | ❌ |

## Best Practices

### 1. Use Descriptive Schemas

```typescript
// ✅ Good: Rich descriptions help the LLM
const schema = {
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

// ❌ Bad: Minimal schema
const schema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    sentiment: { type: 'string' },
    score: { type: 'number' },
  },
};
```

### 2. Start Simple

```typescript
// Start with simple schemas, add constraints as needed
const v1Schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number' },
  },
};

// Later, add constraints based on real-world issues
const v2Schema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    age: { type: 'integer', minimum: 0, maximum: 150 },
  },
  required: ['name'],
};
```

### 3. Use Appropriate Retries

```typescript
// Simple extraction: fewer retries needed
const result1 = await manager.generate({
  schema: simpleSchema,
  maxRetries: 2,
});

// Complex generation: may need more retries
const result2 = await manager.generate({
  schema: complexSchema,
  maxRetries: 5,
});
```

## Related Documentation

- [Architecture](../architecture/ARCHITECTURE.md) - Full system overview
- [Planning Engine](./PLANNING_ENGINE.md) - Multi-step execution
- [Human-in-the-Loop](../safety/HUMAN_IN_THE_LOOP.md) - Human oversight



