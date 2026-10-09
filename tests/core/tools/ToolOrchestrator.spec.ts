import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolOrchestrator } from '../../../src/core/tools/ToolOrchestrator';
import { ITool, ToolExecutionResult } from '../../../src/core/tools/ITool';
import {
  IToolPermissionManager,
  PermissionCheckResult,
} from '../../../src/core/tools/permissions/IToolPermissionManager';
import { ToolExecutor, ToolExecutionRequestDetails } from '../../../src/core/tools/ToolExecutor';
import { GMIError, GMIErrorCode } from '@framers/agentos/core/utils/errors';
import { UserContext } from '../../../src/cognition/substrate/IGMI.js';

const userContext: UserContext = { userId: 'user-123' };

const buildEchoTool = (overrides?: Partial<ITool>): ITool => ({
  id: 'echo-tool',
  name: 'echo',
  displayName: 'Echo',
  description: 'Echoes the provided text.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  outputSchema: { type: 'object' },
  execute: vi.fn(async (args: Record<string, any>) => ({
    success: true,
    output: { echoed: args?.text ?? null },
  })) as ITool['execute'],
  ...overrides,
});

const createPermissionManager = (
  override?: Partial<IToolPermissionManager>,
): IToolPermissionManager => {
  const base: IToolPermissionManager = {
    initialize: vi.fn(),
    isExecutionAllowed: vi.fn(async () => ({ isAllowed: true })) as unknown as (
      ctx: any,
    ) => Promise<PermissionCheckResult>,
    hasRequiredCapabilities: vi.fn(() => true),
    checkToolSubscriptionAccess: vi.fn(async () => ({ isAllowed: true })),
  };
  return { ...base, ...override } as IToolPermissionManager;
};

const createToolExecutor = () => {
  const registry = new Map<string, ITool>();
  const executor: Partial<ToolExecutor> = {
    registerTool: vi.fn(async (tool: ITool) => {
      registry.set(tool.name, tool);
    }),
    unregisterTool: vi.fn(async (name: string) => registry.delete(name)),
    getTool: vi.fn((name: string) => registry.get(name)),
    listAvailableTools: vi.fn(() =>
      Array.from(registry.values()).map((tool) => ({
        name: tool.name,
        displayName: tool.displayName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        category: tool.category,
        requiredCapabilities: tool.requiredCapabilities,
      })),
    ),
    executeTool: vi.fn(
      async (request: ToolExecutionRequestDetails): Promise<ToolExecutionResult> => {
        const tool = registry.get(request.toolCallRequest.name);
        if (!tool) {
          return { success: false, error: 'not found' };
        }
        return tool.execute(request.toolCallRequest.arguments, {
          gmiId: request.gmiId,
          personaId: request.personaId,
          userContext: request.userContext,
        });
      },
    ),
    shutdownAllTools: vi.fn(async () => {
      registry.clear();
    }),
    checkHealth: vi.fn(async () => ({ isHealthy: true, details: 'ok' })),
  };
  return executor as ToolExecutor;
};

const makeRequest = (
  name = 'echo',
  args: Record<string, any> = { text: 'hello' },
): ToolExecutionRequestDetails => ({
  toolCallRequest: { id: 'call-1', name, arguments: args },
  gmiId: 'gmi-1',
  personaId: 'persona-1',
  personaCapabilities: ['can_echo'],
  userContext,
});

describe('ToolOrchestrator', () => {
  let orchestrator: ToolOrchestrator;
  let permissionManager: IToolPermissionManager;
  let executor: ToolExecutor;

  beforeEach(async () => {
    orchestrator = new ToolOrchestrator();
    permissionManager = createPermissionManager();
    executor = createToolExecutor();
    await orchestrator.initialize(undefined, permissionManager, executor);
  });

  it('throws when used before initialization', async () => {
    const uninitialized = new ToolOrchestrator();
    await expect(uninitialized.registerTool(buildEchoTool())).rejects.toBeInstanceOf(GMIError);
  });

  it('registers and executes a tool end-to-end', async () => {
    const tool = buildEchoTool();
    await orchestrator.registerTool(tool);

    const result = await orchestrator.processToolCall(makeRequest('echo', { text: 'hi' }));

    expect(result.isError).toBe(false);
    expect(result.output).toEqual({ echoed: 'hi' });
    expect((executor as any).executeTool).toHaveBeenCalledTimes(1);
    expect(permissionManager.isExecutionAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ tool }),
    );
  });

  it('blocks dynamic registration when disabled', async () => {
    const disallowing = new ToolOrchestrator();
    await disallowing.initialize(
      { toolRegistrySettings: { allowDynamicRegistration: false } },
      createPermissionManager(),
      createToolExecutor(),
    );

    await expect(disallowing.registerTool(buildEchoTool())).rejects.toMatchObject({
      code: GMIErrorCode.PERMISSION_DENIED,
    });
  });

  it('returns not found when tool is missing', async () => {
    const result = await orchestrator.processToolCall(makeRequest('missing-tool'));
    expect(result.isError).toBe(true);
    expect(result.errorDetails?.code).toBe(GMIErrorCode.TOOL_NOT_FOUND);
  });

  it('denies execution for globally disabled tools', async () => {
    const tool = buildEchoTool();
    const disabledOrchestrator = new ToolOrchestrator();
    await disabledOrchestrator.initialize(
      { globalDisabledTools: ['echo'] },
      permissionManager,
      executor,
      [tool],
    );

    const result = await disabledOrchestrator.processToolCall(makeRequest('echo'));
    expect(result.isError).toBe(true);
    expect(result.errorDetails?.code).toBe(GMIErrorCode.PERMISSION_DENIED);
  });

  it('denies when permission manager rejects the call', async () => {
    const tool = buildEchoTool();
    permissionManager.isExecutionAllowed = vi.fn(async () => ({
      isAllowed: false,
      reason: 'blocked',
    }));
    await orchestrator.registerTool(tool);

    const result = await orchestrator.processToolCall(makeRequest('echo'));

    expect(result.isError).toBe(true);
    expect(
      String(result.errorDetails?.message || result.errorDetails?.reason || result.errorDetails),
    ).toContain('blocked');
  });

  it('wraps permission manager errors', async () => {
    const tool = buildEchoTool();
    permissionManager.isExecutionAllowed = vi.fn(async () => {
      throw new Error('permission blew up');
    });
    await orchestrator.registerTool(tool);

    const result = await orchestrator.processToolCall(makeRequest('echo'));

    expect(result.isError).toBe(true);
    expect(result.errorDetails?.code).toBe(GMIErrorCode.PERMISSION_DENIED);
  });

  it('returns executor failures as tool errors', async () => {
    const failingTool = buildEchoTool({
      execute: vi.fn(async () => ({ success: false, error: 'boom', details: { reason: 'fail' } })),
    });
    await orchestrator.registerTool(failingTool);

    const result = await orchestrator.processToolCall(makeRequest('echo'));

    expect(result.isError).toBe(true);
    expect(result.errorDetails?.details?.reason).toBe('fail');
  });

  it('aggregates dependency health', async () => {
    const unhealthyExecutor = createToolExecutor();
    (unhealthyExecutor as any).checkHealth = vi.fn(async () => ({
      isHealthy: false,
      details: 'offline',
    }));
    const healthyPM = createPermissionManager({
      checkHealth: vi.fn(async () => ({ isHealthy: true })),
    });

    const orch = new ToolOrchestrator();
    await orch.initialize({}, healthyPM, unhealthyExecutor);

    const health = await orch.checkHealth();
    expect(health.isHealthy).toBe(false);
    expect(health.details?.toolExecutorStatus?.isHealthy).toBe(false);
    expect(health.details?.permissionManagerStatus?.isHealthy).toBe(true);
  });

  it('requires HITL approval for side-effect tools when enabled', async () => {
    const sideEffectTool = buildEchoTool({ hasSideEffects: true });

    const hitlManager = {
      requestApproval: vi.fn(async () => ({
        actionId: 'approval-1',
        approved: false,
        rejectionReason: 'no',
        decidedBy: 'user',
        decidedAt: new Date(),
      })),
    } as any;

    const orch = new ToolOrchestrator();
    const toolExecutor = createToolExecutor();
    await orch.initialize(
      { hitl: { enabled: true } },
      createPermissionManager(),
      toolExecutor,
      [sideEffectTool],
      hitlManager,
    );

    const result = await orch.processToolCall(makeRequest('echo'));
    expect(result.isError).toBe(true);
    expect(String(result.errorDetails?.reason || result.errorDetails?.message || '')).toContain('HITL');
    expect(hitlManager.requestApproval).toHaveBeenCalledTimes(1);
    expect((toolExecutor as any).executeTool).toHaveBeenCalledTimes(0);
  });

  it('hands its logToolCalls setting to the executor it is initialized with', async () => {
    const executor = new ToolExecutor();
    const handed = vi.spyOn(executor, 'setLogToolCalls');
    const quiet = new ToolOrchestrator();
    await quiet.initialize({ logToolCalls: false }, createPermissionManager(), executor);
    expect(handed).toHaveBeenLastCalledWith(false);
    const loud = new ToolOrchestrator();
    await loud.initialize({ logToolCalls: true }, createPermissionManager(), executor);
    expect(handed).toHaveBeenLastCalledWith(true);
  });
});
