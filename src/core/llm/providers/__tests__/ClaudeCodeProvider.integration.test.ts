/**
 * @fileoverview Integration tests for ClaudeCodeProvider.
 * These tests require Claude Code CLI to be installed and authenticated.
 * They are skipped in CI via the SKIP_CLI_INTEGRATION env var.
 *
 * Run manually: npx vitest run src/core/llm/providers/tests/ClaudeCodeProvider.integration.spec.ts
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { ClaudeCodeProvider } from '../implementations/ClaudeCodeProvider';
import { ClaudeCodeCLIBridge } from '../implementations/ClaudeCodeCLIBridge';

const SKIP = process.env.SKIP_CLI_INTEGRATION === '1' || process.env.CI === 'true';

describe.skipIf(SKIP)('ClaudeCodeProvider integration', () => {
  let provider: ClaudeCodeProvider | undefined;

  beforeAll(async () => {
    /* Pre-flight: ensure CLI is available */
    const bridge = new ClaudeCodeCLIBridge();
    const check = await bridge.checkBinaryInstalled();
    if (!check.installed) {
      console.warn('Skipping integration tests: Claude Code CLI not installed');
      return;
    }
    const authenticated = await bridge.checkAuthenticated();
    if (!authenticated) {
      console.warn('Skipping integration tests: Claude Code CLI is not authenticated');
      return;
    }

    provider = new ClaudeCodeProvider();
    await provider.initialize({ defaultModelId: 'claude-haiku-4-5-20251001' });
  });

  it('generates a text completion', async () => {
    if (!provider) return;
    const response = await provider.generateCompletion(
      'claude-haiku-4-5-20251001',
      [{ role: 'user', content: 'Reply with exactly: hello' }],
      {},
    );

    expect(response.choices).toHaveLength(1);
    expect(response.choices[0].message.role).toBe('assistant');
    expect((response.choices[0].message.content as string)?.toLowerCase()).toContain('hello');
    expect(response.choices[0].finishReason).toBe('stop');
    expect(response.usage?.costUSD).toBe(0);
  }, 30_000);

  it('streams a text completion', async () => {
    if (!provider) return;
    const chunks: any[] = [];
    for await (const chunk of provider.generateCompletionStream(
      'claude-haiku-4-5-20251001',
      [{ role: 'user', content: 'Count from 1 to 3, one number per line.' }],
      {},
    )) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    const finalChunk = chunks[chunks.length - 1];
    expect(finalChunk.isFinal).toBe(true);
    expect(finalChunk.choices[0].message.content).toMatch(/1.*2.*3/s);
  }, 30_000);

  it('handles tool calling via --json-schema', async () => {
    if (!provider) return;
    const tools = [{
      type: 'function' as const,
      function: {
        name: 'get_weather',
        description: 'Get the current weather for a location',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string', description: 'City name' } },
          required: ['location'],
        },
      },
    }];

    const response = await provider.generateCompletion(
      'claude-haiku-4-5-20251001',
      [{ role: 'user', content: 'What is the weather in Tokyo?' }],
      { tools, toolChoice: 'required' },
    );

    expect(response.choices[0].finishReason).toBe('tool_calls');
    expect(response.choices[0].message.tool_calls).toBeDefined();
    expect(response.choices[0].message.tool_calls!.length).toBeGreaterThan(0);
    expect(response.choices[0].message.tool_calls![0].function.name).toBe('get_weather');

    const args = JSON.parse(response.choices[0].message.tool_calls![0].function.arguments);
    expect(args.location.toLowerCase()).toContain('tokyo');
  }, 30_000);

  it('checkHealth() returns healthy with details', async () => {
    if (!provider) return;
    const health = await provider.checkHealth();
    expect(health.isHealthy).toBe(true);
    expect((health.details as any).cliInstalled).toBe(true);
    expect((health.details as any).authenticated).toBe(true);
    expect((health.details as any).cliVersion).toBeDefined();
  });

  it('listAvailableModels() returns 4 Claude models', async () => {
    if (!provider) return;
    const models = await provider.listAvailableModels();
    expect(models).toHaveLength(4);
    expect(models.every(m => m.pricePer1MTokensInput === 0)).toBe(true);
  });
});
