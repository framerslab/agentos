/**
 * @file StructuredOutputManager.spec.ts
 * @description Unit tests for the Structured Output Manager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  StructuredOutputManager,
  type StructuredOutputManagerConfig,
} from '../../../src/api/structured/output/StructuredOutputManager.js';
import type {
  JSONSchema,
  ValidationIssue,
} from '../../../src/api/structured/output/IStructuredOutputManager.js';
import type { AIModelProviderManager } from '../../../src/core/llm/providers/AIModelProviderManager';

// Mock LLM Provider Manager
const createMockLLMProvider = (response: { content?: string; toolCalls?: any[] }): AIModelProviderManager => {
  const mockProvider = {
    generateCompletion: vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: response.content,
          tool_calls: response.toolCalls?.map((tc, i) => ({
            id: `call-${i}`,
            type: 'function',
            function: tc.function,
          })),
        },
      }],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    }),
  };
  return {
    getProvider: vi.fn().mockReturnValue(mockProvider),
  } as unknown as AIModelProviderManager;
};

describe('StructuredOutputManager', () => {
  it('logs only the length when model JSON cannot be recovered', async () => {
    const sentinel = 'sentinel-words-7731';
    const warn = vi.fn();
    const manager = new StructuredOutputManager({
      llmProviderManager: createMockLLMProvider({ content: sentinel }),
      logger: { warn } as any,
    });
    await expect(manager.generate({
      prompt: 'Return an object', schema: { type: 'object' }, strategy: 'json_mode', maxRetries: 0,
    })).rejects.toThrow('Failed to generate valid structured output');
    expect(warn).toHaveBeenCalledWith('Failed to parse JSON after recovery attempts', { textLength: sentinel.length });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
  });

  describe('JSON Schema Validation', () => {
    let manager: StructuredOutputManager;

    beforeEach(() => {
      manager = new StructuredOutputManager({
        llmProviderManager: createMockLLMProvider({ content: '{}' }),
      });
    });

    describe('type validation', () => {
      it('should validate string type', () => {
        const schema: JSONSchema = { type: 'string' };
        
        expect(manager.validate('hello', schema)).toHaveLength(0);
        expect(manager.validate(123, schema)).toHaveLength(1);
        expect(manager.validate(null, schema)).toHaveLength(1);
      });

      it('should validate number type', () => {
        const schema: JSONSchema = { type: 'number' };
        
        expect(manager.validate(3.14, schema)).toHaveLength(0);
        expect(manager.validate(42, schema)).toHaveLength(0);
        expect(manager.validate('123', schema)).toHaveLength(1);
      });

      it('should validate integer type', () => {
        const schema: JSONSchema = { type: 'integer' };
        
        expect(manager.validate(42, schema)).toHaveLength(0);
        expect(manager.validate(3.14, schema)).toHaveLength(1);
      });

      it('should validate boolean type', () => {
        const schema: JSONSchema = { type: 'boolean' };
        
        expect(manager.validate(true, schema)).toHaveLength(0);
        expect(manager.validate(false, schema)).toHaveLength(0);
        expect(manager.validate('true', schema)).toHaveLength(1);
      });

      it('should validate array type', () => {
        const schema: JSONSchema = { type: 'array' };
        
        expect(manager.validate([], schema)).toHaveLength(0);
        expect(manager.validate([1, 2, 3], schema)).toHaveLength(0);
        expect(manager.validate({}, schema)).toHaveLength(1);
      });

      it('should validate object type', () => {
        const schema: JSONSchema = { type: 'object' };
        
        expect(manager.validate({}, schema)).toHaveLength(0);
        expect(manager.validate({ a: 1 }, schema)).toHaveLength(0);
        expect(manager.validate([], schema)).toHaveLength(1);
      });

      it('should validate null type', () => {
        const schema: JSONSchema = { type: 'null' };
        
        expect(manager.validate(null, schema)).toHaveLength(0);
        expect(manager.validate(undefined, schema)).toHaveLength(1);
      });
    });

    describe('string constraints', () => {
      it('should validate minLength', () => {
        const schema: JSONSchema = { type: 'string', minLength: 3 };
        
        expect(manager.validate('abc', schema)).toHaveLength(0);
        expect(manager.validate('ab', schema)).toHaveLength(1);
      });

      it('should validate maxLength', () => {
        const schema: JSONSchema = { type: 'string', maxLength: 5 };
        
        expect(manager.validate('hello', schema)).toHaveLength(0);
        expect(manager.validate('hello!', schema)).toHaveLength(1);
      });

      it('should validate pattern', () => {
        const schema: JSONSchema = { type: 'string', pattern: '^[A-Z]+$' };
        
        expect(manager.validate('HELLO', schema)).toHaveLength(0);
        expect(manager.validate('Hello', schema)).toHaveLength(1);
      });

      it('should validate email format', () => {
        const schema: JSONSchema = { type: 'string', format: 'email' };
        
        expect(manager.validate('test@example.com', schema)).toHaveLength(0);
        expect(manager.validate('invalid-email', schema)).toHaveLength(1);
      });

      it('should validate uri format', () => {
        const schema: JSONSchema = { type: 'string', format: 'uri' };
        
        expect(manager.validate('https://example.com', schema)).toHaveLength(0);
        expect(manager.validate('not-a-uri', schema)).toHaveLength(1);
      });

      it('should validate uuid format', () => {
        const schema: JSONSchema = { type: 'string', format: 'uuid' };
        
        expect(manager.validate('123e4567-e89b-12d3-a456-426614174000', schema)).toHaveLength(0);
        expect(manager.validate('not-a-uuid', schema)).toHaveLength(1);
      });
    });

    describe('number constraints', () => {
      it('should validate minimum', () => {
        const schema: JSONSchema = { type: 'number', minimum: 0 };
        
        expect(manager.validate(0, schema)).toHaveLength(0);
        expect(manager.validate(10, schema)).toHaveLength(0);
        expect(manager.validate(-1, schema)).toHaveLength(1);
      });

      it('should validate maximum', () => {
        const schema: JSONSchema = { type: 'number', maximum: 100 };
        
        expect(manager.validate(100, schema)).toHaveLength(0);
        expect(manager.validate(50, schema)).toHaveLength(0);
        expect(manager.validate(101, schema)).toHaveLength(1);
      });

      it('should validate exclusiveMinimum', () => {
        const schema: JSONSchema = { type: 'number', exclusiveMinimum: 0 };
        
        expect(manager.validate(1, schema)).toHaveLength(0);
        expect(manager.validate(0, schema)).toHaveLength(1);
      });

      it('should validate exclusiveMaximum', () => {
        const schema: JSONSchema = { type: 'number', exclusiveMaximum: 100 };
        
        expect(manager.validate(99, schema)).toHaveLength(0);
        expect(manager.validate(100, schema)).toHaveLength(1);
      });

      it('should validate multipleOf', () => {
        const schema: JSONSchema = { type: 'number', multipleOf: 5 };
        
        expect(manager.validate(10, schema)).toHaveLength(0);
        expect(manager.validate(15, schema)).toHaveLength(0);
        expect(manager.validate(7, schema)).toHaveLength(1);
      });
    });

    describe('array constraints', () => {
      it('should validate minItems', () => {
        const schema: JSONSchema = { type: 'array', minItems: 2 };
        
        expect(manager.validate([1, 2], schema)).toHaveLength(0);
        expect(manager.validate([1], schema)).toHaveLength(1);
      });

      it('should validate maxItems', () => {
        const schema: JSONSchema = { type: 'array', maxItems: 3 };
        
        expect(manager.validate([1, 2, 3], schema)).toHaveLength(0);
        expect(manager.validate([1, 2, 3, 4], schema)).toHaveLength(1);
      });

      it('should validate uniqueItems', () => {
        const schema: JSONSchema = { type: 'array', uniqueItems: true };
        
        expect(manager.validate([1, 2, 3], schema)).toHaveLength(0);
        expect(manager.validate([1, 2, 1], schema)).toHaveLength(1);
      });

      it('should validate items schema', () => {
        const schema: JSONSchema = {
          type: 'array',
          items: { type: 'number', minimum: 0 },
        };
        
        expect(manager.validate([1, 2, 3], schema)).toHaveLength(0);
        expect(manager.validate([1, -1, 3], schema)).toHaveLength(1);
      });
    });

    describe('object constraints', () => {
      it('should validate required properties', () => {
        const schema: JSONSchema = {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'number' },
          },
          required: ['name'],
        };
        
        expect(manager.validate({ name: 'John' }, schema)).toHaveLength(0);
        expect(manager.validate({ age: 30 }, schema)).toHaveLength(1);
      });

      it('should validate property schemas', () => {
        const schema: JSONSchema = {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            age: { type: 'number', minimum: 0 },
          },
        };
        
        expect(manager.validate({ name: 'John', age: 30 }, schema)).toHaveLength(0);
        expect(manager.validate({ name: '', age: 30 }, schema)).toHaveLength(1);
        expect(manager.validate({ name: 'John', age: -1 }, schema)).toHaveLength(1);
      });

      it('should reject additional properties when strict', () => {
        const schema: JSONSchema = {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          additionalProperties: false,
        };
        
        expect(manager.validate({ name: 'John' }, schema, true)).toHaveLength(0);
        expect(manager.validate({ name: 'John', extra: 'value' }, schema, true)).toHaveLength(1);
      });

      it('should validate minProperties', () => {
        const schema: JSONSchema = { type: 'object', minProperties: 2 };
        
        expect(manager.validate({ a: 1, b: 2 }, schema)).toHaveLength(0);
        expect(manager.validate({ a: 1 }, schema)).toHaveLength(1);
      });

      it('should validate maxProperties', () => {
        const schema: JSONSchema = { type: 'object', maxProperties: 2 };
        
        expect(manager.validate({ a: 1, b: 2 }, schema)).toHaveLength(0);
        expect(manager.validate({ a: 1, b: 2, c: 3 }, schema)).toHaveLength(1);
      });
    });

    describe('enum and const', () => {
      it('should validate enum values', () => {
        const schema: JSONSchema = { enum: ['red', 'green', 'blue'] };
        
        expect(manager.validate('red', schema)).toHaveLength(0);
        expect(manager.validate('yellow', schema)).toHaveLength(1);
      });

      it('should validate const value', () => {
        const schema: JSONSchema = { const: 'fixed' };
        
        expect(manager.validate('fixed', schema)).toHaveLength(0);
        expect(manager.validate('other', schema)).toHaveLength(1);
      });
    });

    describe('composition keywords', () => {
      it('should validate anyOf', () => {
        const schema: JSONSchema = {
          anyOf: [
            { type: 'string' },
            { type: 'number' },
          ],
        };
        
        expect(manager.validate('hello', schema)).toHaveLength(0);
        expect(manager.validate(42, schema)).toHaveLength(0);
        expect(manager.validate(true, schema)).toHaveLength(1);
      });

      it('should validate allOf', () => {
        const schema: JSONSchema = {
          allOf: [
            { type: 'object', properties: { a: { type: 'string' } } },
            { type: 'object', required: ['a'] },
          ],
        };
        
        expect(manager.validate({ a: 'hello' }, schema)).toHaveLength(0);
        expect(manager.validate({}, schema)).toHaveLength(1);
      });
    });
  });

  describe('JSON Parsing', () => {
    let manager: StructuredOutputManager;

    beforeEach(() => {
      manager = new StructuredOutputManager({
        llmProviderManager: createMockLLMProvider({ content: '{}' }),
      });
    });

    it('should parse valid JSON', () => {
      expect(manager.parseJSON('{"name": "John"}')).toEqual({ name: 'John' });
      expect(manager.parseJSON('[1, 2, 3]')).toEqual([1, 2, 3]);
    });

    it('should handle markdown code blocks', () => {
      const input = '```json\n{"name": "John"}\n```';
      expect(manager.parseJSON(input)).toEqual({ name: 'John' });
    });

    it('should extract JSON from surrounding text', () => {
      const input = 'Here is the result: {"name": "John"} and some more text';
      expect(manager.parseJSON(input)).toEqual({ name: 'John' });
    });

    it('should fix trailing commas', () => {
      const input = '{"a": 1, "b": 2,}';
      expect(manager.parseJSON(input)).toEqual({ a: 1, b: 2 });
    });

    it('should return null for invalid JSON', () => {
      expect(manager.parseJSON('not json at all')).toBeNull();
      expect(manager.parseJSON('')).toBeNull();
    });
  });

  describe('Strategy Selection', () => {
    let manager: StructuredOutputManager;

    beforeEach(() => {
      manager = new StructuredOutputManager({
        llmProviderManager: createMockLLMProvider({ content: '{}' }),
      });
    });

    it('should recommend json_mode for OpenAI with simple schemas', () => {
      const simpleSchema: JSONSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      };
      
      expect(manager.recommendStrategy('openai', 'gpt-4o', simpleSchema)).toBe('json_mode');
    });

    it('should recommend function_calling for complex schemas', () => {
      const complexSchema: JSONSchema = {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
              },
            },
          },
        },
      };
      
      expect(manager.recommendStrategy('openai', 'gpt-4o', complexSchema)).toBe('function_calling');
    });

    it('should recommend prompt_engineering for providers without JSON mode', () => {
      const simpleSchema: JSONSchema = { type: 'string' };
      
      expect(manager.recommendStrategy('unknown', 'unknown-model', simpleSchema)).toBe('prompt_engineering');
    });
  });

  describe('Schema Registration', () => {
    let manager: StructuredOutputManager;

    beforeEach(() => {
      manager = new StructuredOutputManager({
        llmProviderManager: createMockLLMProvider({ content: '{}' }),
      });
    });

    it('should register and retrieve schemas', () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      };
      
      manager.registerSchema('Person', schema);
      expect(manager.getSchema('Person')).toEqual(schema);
    });

    it('should return undefined for unregistered schemas', () => {
      expect(manager.getSchema('NonExistent')).toBeUndefined();
    });
  });

  describe('Statistics', () => {
    let manager: StructuredOutputManager;

    beforeEach(() => {
      manager = new StructuredOutputManager({
        llmProviderManager: createMockLLMProvider({ content: '{"name": "John"}' }),
      });
    });

    it('should track generation statistics', async () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: { name: { type: 'string' } },
      };

      await manager.generate({
        prompt: 'Test',
        schema,
        schemaName: 'Test',
      });

      const stats = manager.getStatistics();
      expect(stats.totalGenerations).toBe(1);
      expect(stats.successfulGenerations).toBe(1);
      expect(stats.successRate).toBe(1);
    });

    it('should reset statistics', async () => {
      const schema: JSONSchema = {
        type: 'object',
        properties: { name: { type: 'string' } },
      };

      await manager.generate({
        prompt: 'Test',
        schema,
        schemaName: 'Test',
      });

      manager.resetStatistics();
      const stats = manager.getStatistics();
      expect(stats.totalGenerations).toBe(0);
      expect(stats.successfulGenerations).toBe(0);
    });
  });

  describe('Structured Generation', () => {
    it('should successfully generate structured output', async () => {
      const mockProvider = createMockLLMProvider({
        content: JSON.stringify({ name: 'John', age: 30 }),
      });

      const manager = new StructuredOutputManager({
        llmProviderManager: mockProvider,
      });

      const schema: JSONSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer', minimum: 0 },
        },
        required: ['name', 'age'],
      };

      const result = await manager.generate({
        prompt: 'Generate a person',
        schema,
        schemaName: 'Person',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ name: 'John', age: 30 });
    });

    it('should retry on validation failure', async () => {
      const mockGenerateCompletion = vi.fn()
        .mockResolvedValueOnce({
          choices: [{ message: { content: JSON.stringify({ name: 'John', age: -5 }) } }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        })
        .mockResolvedValueOnce({
          choices: [{ message: { content: JSON.stringify({ name: 'John', age: 30 }) } }],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        });

      const mockProvider = {
        getProvider: vi.fn().mockReturnValue({
          generateCompletion: mockGenerateCompletion,
        }),
      } as unknown as AIModelProviderManager;

      const manager = new StructuredOutputManager({
        llmProviderManager: mockProvider,
        defaultMaxRetries: 3,
      });

      const schema: JSONSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer', minimum: 0 },
        },
        required: ['name', 'age'],
      };

      const result = await manager.generate({
        prompt: 'Generate a person',
        schema,
        schemaName: 'Person',
      });

      expect(result.success).toBe(true);
      expect(result.retryCount).toBe(1);
      expect(mockGenerateCompletion).toHaveBeenCalledTimes(2);
    });

    it('should throw after max retries', async () => {
      const mockProvider = createMockLLMProvider({
        content: JSON.stringify({ name: 'John', age: -5 }),
      });

      const manager = new StructuredOutputManager({
        llmProviderManager: mockProvider,
        defaultMaxRetries: 2,
      });

      const schema: JSONSchema = {
        type: 'object',
        properties: {
          age: { type: 'integer', minimum: 0 },
        },
        required: ['age'],
      };

      await expect(
        manager.generate({
          prompt: 'Generate a person',
          schema,
          schemaName: 'Person',
        }),
      ).rejects.toThrow('Failed to generate valid structured output');
    });
  });

  describe('Function Calling', () => {
    it('should generate parallel function calls', async () => {
      const mockProvider = createMockLLMProvider({
        toolCalls: [
          {
            id: 'call-1',
            function: {
              name: 'get_weather',
              arguments: JSON.stringify({ city: 'New York' }),
            },
          },
          {
            id: 'call-2',
            function: {
              name: 'get_weather',
              arguments: JSON.stringify({ city: 'London' }),
            },
          },
        ],
      });

      const manager = new StructuredOutputManager({
        llmProviderManager: mockProvider,
      });

      const result = await manager.generateFunctionCalls({
        prompt: 'Get weather for New York and London',
        functions: [
          {
            name: 'get_weather',
            description: 'Get weather for a city',
            parameters: {
              type: 'object',
              properties: {
                city: { type: 'string' },
              },
              required: ['city'],
            },
          },
        ],
      });

      expect(result.calls).toHaveLength(2);
      expect(result.calls[0].functionName).toBe('get_weather');
      expect(result.calls[0].arguments).toEqual({ city: 'New York' });
      expect(result.calls[1].arguments).toEqual({ city: 'London' });
    });

    it('should validate function arguments', async () => {
      const mockProvider = createMockLLMProvider({
        toolCalls: [
          {
            id: 'call-1',
            function: {
              name: 'add_numbers',
              arguments: JSON.stringify({ a: 'not a number', b: 5 }),
            },
          },
        ],
      });

      const manager = new StructuredOutputManager({
        llmProviderManager: mockProvider,
      });

      const result = await manager.generateFunctionCalls({
        prompt: 'Add 3 and 5',
        functions: [
          {
            name: 'add_numbers',
            description: 'Add two numbers',
            parameters: {
              type: 'object',
              properties: {
                a: { type: 'number' },
                b: { type: 'number' },
              },
              required: ['a', 'b'],
            },
          },
        ],
      });

      expect(result.calls[0].argumentsValid).toBe(false);
      expect(result.calls[0].validationErrors).toHaveLength(1);
    });

    it('should execute function handlers', async () => {
      const mockProvider = createMockLLMProvider({
        toolCalls: [
          {
            id: 'call-1',
            function: {
              name: 'add_numbers',
              arguments: JSON.stringify({ a: 3, b: 5 }),
            },
          },
        ],
      });

      const manager = new StructuredOutputManager({
        llmProviderManager: mockProvider,
      });

      const addHandler = vi.fn().mockResolvedValue(8);

      const result = await manager.generateFunctionCalls({
        prompt: 'Add 3 and 5',
        functions: [
          {
            name: 'add_numbers',
            description: 'Add two numbers',
            parameters: {
              type: 'object',
              properties: {
                a: { type: 'number' },
                b: { type: 'number' },
              },
              required: ['a', 'b'],
            },
            handler: addHandler,
          },
        ],
      });

      expect(addHandler).toHaveBeenCalledWith({ a: 3, b: 5 });
      expect(result.calls[0].executionResult).toBe(8);
    });
  });

  describe('Entity Extraction', () => {
    it('should extract single entity', async () => {
      const mockProvider = createMockLLMProvider({
        content: JSON.stringify({
          found: true,
          entity: { name: 'John Doe', email: 'john@example.com' },
        }),
      });

      const manager = new StructuredOutputManager({
        llmProviderManager: mockProvider,
      });

      const result = await manager.extractEntities<{ name: string; email: string }>({
        text: 'Contact John Doe at john@example.com',
        entitySchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
          },
          required: ['name', 'email'],
        },
        taskName: 'PersonExtraction',
        extractAll: false,
      });

      expect(result.success).toBe(true);
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).toEqual({ name: 'John Doe', email: 'john@example.com' });
    });

    it('should extract multiple entities', async () => {
      const mockProvider = createMockLLMProvider({
        content: JSON.stringify({
          entities: [
            { name: 'John', email: 'john@example.com' },
            { name: 'Jane', email: 'jane@example.com' },
          ],
        }),
      });

      const manager = new StructuredOutputManager({
        llmProviderManager: mockProvider,
      });

      const result = await manager.extractEntities({
        text: 'John (john@example.com) and Jane (jane@example.com)',
        entitySchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
          },
        },
        taskName: 'PersonExtraction',
        extractAll: true,
      });

      expect(result.success).toBe(true);
      expect(result.entities).toHaveLength(2);
    });
  });
});

