import { vi } from 'vitest';
import { ToolOrchestrator } from '../../../../core/tools/ToolOrchestrator.js';
import { ToolExecutor } from '../../../../core/tools/ToolExecutor.js';
import type { IToolPermissionManager } from '../../../../core/tools/permissions/IToolPermissionManager.js';
import type { ToolOrchestratorConfig } from '../../../../core/config/ToolOrchestratorConfig.js';
import type { IHumanInteractionManager } from '../../../../orchestration/hitl/IHumanInteractionManager.js';
import type { ITool } from '../../../../core/tools/ITool.js';
import type { ToolCallResult, UserContext } from '../../../substrate/IGMI.js';
import type { EmergentCapabilityEngine } from '../../EmergentCapabilityEngine.js';
import type { EmergentConfig } from '../../types.js';
import type { SqliteTestAdapter } from './sqlite-adapter.js';

/** What the test-double judge answers to every forge: approved. */
export const APPROVED_VERDICT = JSON.stringify({
  safety: { passed: true, concerns: [] },
  correctness: { passed: true, failedTests: [] },
  determinism: { likely: true, reasoning: 'Deterministic.' },
  bounded: { likely: true, reasoning: 'Bounded.' },
  confidence: 0.95,
  approved: true,
  reasoning: 'Tool is safe and correct.',
});

export interface ForgeHost {
  orchestrator: ToolOrchestrator;
  executor: ToolExecutor;
  engine: EmergentCapabilityEngine;
  permissionManager: IToolPermissionManager;
}

/**
 * A real ToolOrchestrator and ToolExecutor with forging on, a judge that
 * approves, and a permission manager that allows unless a test overrides it.
 */
export async function makeForgeHost(
  options: {
    db?: SqliteTestAdapter;
    config?: Partial<EmergentConfig>;
    tools?: ITool[];
    hitlManager?: IHumanInteractionManager;
    orchestratorConfig?: Partial<ToolOrchestratorConfig>;
  } = {},
): Promise<ForgeHost> {
  const permissionManager = {
    initialize: vi.fn().mockResolvedValue(undefined),
    isExecutionAllowed: vi.fn().mockResolvedValue({ isAllowed: true }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as IToolPermissionManager;
  const executor = new ToolExecutor();
  const orchestrator = new ToolOrchestrator();
  await orchestrator.initialize(
    options.orchestratorConfig as ToolOrchestratorConfig | undefined,
    permissionManager,
    executor,
    options.tools ?? [],
    options.hitlManager,
    {
      enabled: true,
      config: { allowSandboxTools: true, persistSandboxSource: true, ...(options.config ?? {}) },
      generateText: async () => APPROVED_VERDICT,
      storageAdapter: options.db,
    },
  );
  const engine = orchestrator.getEmergentEngine();
  if (!engine) {
    throw new Error('the emergent engine was not created');
  }
  return { orchestrator, executor, engine, permissionManager };
}

let callCounter = 0;

/** Calls a tool the way a model's tool call reaches it: through processToolCall. */
export function callTool(
  orchestrator: ToolOrchestrator,
  name: string,
  args: Record<string, unknown>,
  caller: { personaCapabilities?: string[]; personaId?: string; gmiId?: string; sessionId?: string } = {},
): Promise<ToolCallResult> {
  callCounter += 1;
  return orchestrator.processToolCall({
    toolCallRequest: { id: `call-${callCounter}`, name, arguments: args },
    gmiId: caller.gmiId ?? 'gmi-test',
    personaId: caller.personaId ?? 'persona-test',
    // forge_tool records the correlation id as the forging session.
    ...(caller.sessionId ? { correlationId: caller.sessionId } : {}),
    personaCapabilities: caller.personaCapabilities ?? [],
    userContext: { userId: 'user-test' } as UserContext,
  });
}

/** A host tool with no side effects that returns its `text` argument. */
export function echoTool(): ITool {
  return {
    id: 'echo-v1',
    name: 'echo',
    displayName: 'Echo',
    description: 'Returns the text it is given.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    hasSideEffects: false,
    execute: async (args: Record<string, unknown>) => ({
      success: true,
      output: { text: String(args.text) },
    }),
  };
}
