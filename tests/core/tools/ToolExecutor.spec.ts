import { describe, it, expect, vi } from 'vitest';
import { ToolExecutor } from '../../../src/core/tools/ToolExecutor';
import { ITool, ToolExecutionContext, ToolExecutionResult } from '../../../src/core/tools/ITool';
import { ToolCallRequest, UserContext } from '../../../src/cognition/substrate/IGMI.js';

const userContext: UserContext = { userId: 'u-1' };

const makeTool = (overrides?: Partial<ITool>): ITool => ({
  id: 'echo-tool',
  name: 'echo',
  displayName: 'Echo',
  description: 'Echoes text',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  execute: async (args: any): Promise<ToolExecutionResult> => ({
    success: true,
    output: { text: args.text },
  }),
  ...overrides,
});

const makeRequest = (name: string, args: Record<string, any> = { text: 'hi' }): ToolCallRequest => ({
  id: 'call-1',
  name,
  arguments: args,
});

describe('ToolExecutor', () => {
  it('registers and executes a tool successfully', async () => {
    const executor = new ToolExecutor();
    const tool = makeTool();
    await executor.registerTool(tool);

    const result = await executor.executeTool({
      toolCallRequest: makeRequest('echo', { text: 'hello' }),
      gmiId: 'gmi-1',
      personaId: 'persona-1',
      personaCapabilities: [],
      userContext,
    });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ text: 'hello' });
  });

  it('fails when tool not found', async () => {
    const executor = new ToolExecutor();
    const result = await executor.executeTool({
      toolCallRequest: makeRequest('missing'),
      gmiId: 'gmi-1',
      personaId: 'persona-1',
      personaCapabilities: [],
      userContext,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('rejects missing required capabilities', async () => {
    const executor = new ToolExecutor();
    const guardedTool = makeTool({ requiredCapabilities: ['can-run'] });
    await executor.registerTool(guardedTool);

    const result = await executor.executeTool({
      toolCallRequest: makeRequest('echo', { text: 'hi' }),
      gmiId: 'gmi-1',
      personaId: 'persona-1',
      personaCapabilities: ['other-cap'],
      userContext,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('lacks capabilities');
  });

  it('returns error when arguments fail JSON parsing', async () => {
    const executor = new ToolExecutor();
    await executor.registerTool(makeTool());

    const result = await executor.executeTool({
      toolCallRequest: { ...makeRequest('echo'), arguments: 'not-json' },
      gmiId: 'gmi-1',
      personaId: 'persona-1',
      personaCapabilities: [],
      userContext,
    });

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('Failed to parse arguments');
  });

  it('returns validation errors when required args missing', async () => {
    const executor = new ToolExecutor();
    await executor.registerTool(makeTool());

    const result = await executor.executeTool({
      toolCallRequest: makeRequest('echo', {}),
      gmiId: 'gmi-1',
      personaId: 'persona-1',
      personaCapabilities: [],
      userContext,
    });

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('Invalid arguments');
  });

  it('forwards sessionData into the tool execution context', async () => {
    let observedContext: ToolExecutionContext | undefined;
    const executor = new ToolExecutor();
    await executor.registerTool(
      makeTool({
        execute: async (_args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> => {
          observedContext = context;
          return { success: true, output: { ok: true } };
        },
      }),
    );

    const result = await executor.executeTool({
      toolCallRequest: makeRequest('echo', { text: 'hello' }),
      gmiId: 'gmi-1',
      personaId: 'persona-1',
      personaCapabilities: [],
      userContext,
      sessionData: {
        sessionId: 'session-1',
        conversationId: 'conv-1',
        organizationId: 'org-1',
      },
    });

    expect(result.success).toBe(true);
    expect(observedContext?.sessionData).toEqual({
      sessionId: 'session-1',
      conversationId: 'conv-1',
      organizationId: 'org-1',
    });
  });

  describe('the console lines', () => {
    const words = 'the words of the person';
    const request = (args: unknown = { text: words }) => ({
      toolCallRequest: makeRequest('echo', args as Record<string, any>),
      gmiId: 'gmi-1',
      personaId: 'persona-1',
      personaCapabilities: [] as string[],
      userContext,
    });
    const spies = () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const printed = () =>
        [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
          .map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
          .join('\n');
      const clear = () => { log.mockClear(); warn.mockClear(); error.mockClear(); };
      const restore = () => { log.mockRestore(); warn.mockRestore(); error.mockRestore(); };
      return { printed, clear, restore };
    };

    it("keeps a tool's arguments and output out of the console unless tool-call logging is on", async () => {
      const { printed, clear, restore } = spies();
      try {
        const quiet = new ToolExecutor();
        await quiet.registerTool(makeTool());
        expect((await quiet.executeTool(request())).success).toBe(true);
        expect(printed()).toContain('Tool execution successful');
        expect(printed()).not.toContain(words);

        clear();
        const loud = new ToolExecutor(undefined, undefined, undefined, { logToolCalls: true });
        await loud.registerTool(makeTool());
        await loud.executeTool(request());
        expect(printed()).toContain('Output preview');
        expect(printed()).toContain(words);

        clear();
        quiet.setLogToolCalls(true);
        await quiet.executeTool(request());
        expect(printed()).toContain(words);
        quiet.setLogToolCalls(false);
        clear();
        await quiet.executeTool(request());
        expect(printed()).not.toContain(words);

        // a call's own setting wins over the executor's
        clear();
        await quiet.executeTool({ ...request(), logToolCalls: true });
        expect(printed()).toContain(words);
        clear();
        await loud.executeTool({ ...request(), logToolCalls: false });
        expect(printed()).not.toContain(words);
      } finally {
        restore();
      }
    });

    it("keeps a failure's details and unparsable arguments out of the console when logging is off", async () => {
      const { printed, clear, restore } = spies();
      try {
        const quiet = new ToolExecutor();
        await quiet.registerTool(
          makeTool({
            execute: async (): Promise<ToolExecutionResult> => ({ success: false, error: 'refused', details: { text: words } }),
          }),
        );
        const failed = await quiet.executeTool(request());
        expect(failed.success).toBe(false);
        expect(printed()).toContain('refused');
        expect(printed()).not.toContain(words);

        clear();
        const unparsable = await quiet.executeTool(request(`not json: ${words}`));
        expect(unparsable.success).toBe(false);
        expect(printed()).toContain('Argument parsing failed');
        expect(printed()).not.toContain(words);

        // an unexpected property's name comes from the input: it stays out of the validation errors when logging is off
        clear();
        const strict = new ToolExecutor();
        await strict.registerTool(
          makeTool({ name: 'strict', id: 'strict', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false } }),
        );
        const extra = await strict.executeTool({ ...request({ text: 'hi', the_persons_own_key: 1 }), toolCallRequest: makeRequest('strict', { text: 'hi', the_persons_own_key: 1 }) });
        expect(extra.success).toBe(false);
        expect(printed()).toContain('Argument schema validation failed');
        expect(printed()).not.toContain('the_persons_own_key');
      } finally {
        restore();
      }
    });
  });
});
