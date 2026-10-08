import { vi } from 'vitest';
import { ToolOrchestrator } from '../../../../core/tools/ToolOrchestrator.js';
import { ToolExecutor } from '../../../../core/tools/ToolExecutor.js';
import type { IToolPermissionManager } from '../../../../core/tools/permissions/IToolPermissionManager.js';
import type { ToolOrchestratorConfig } from '../../../../core/config/ToolOrchestratorConfig.js';
import type { IHumanInteractionManager, PendingAction } from '../../../../orchestration/hitl/IHumanInteractionManager.js';
import type { ITool } from '../../../../core/tools/ITool.js';
import type { ILogger } from '../../../../core/logging/ILogger.js';
import type { ExtensionRegistry } from '../../../../extensions/index.js';
import { SelfImprovementSessionManager } from '../../../../api/runtime/SelfImprovementSessionManager.js';
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

export interface ForgeHostOptions {
  db?: SqliteTestAdapter;
  config?: Partial<EmergentConfig>;
  tools?: ITool[];
  hitlManager?: IHumanInteractionManager;
  orchestratorConfig?: Partial<ToolOrchestratorConfig>;
  /** A registry the executor shares, so a test can register a tool the way an extension pack does. */
  registry?: ExtensionRegistry<ITool>;
  /** Wire the self-improvement tools through the real session manager. */
  selfImprovement?: boolean;
}

export interface ForgeHost {
  orchestrator: ToolOrchestrator;
  executor: ToolExecutor;
  engine: EmergentCapabilityEngine;
  permissionManager: IToolPermissionManager & { isExecutionAllowed: ReturnType<typeof vi.fn> };
  /** The judge's model call: `(model, prompt)`; the prompt holds the test results. */
  judge: ReturnType<typeof vi.fn>;
}

/**
 * A real ToolOrchestrator and ToolExecutor with forging on, a judge that
 * approves, and a permission manager that allows unless a test overrides it.
 */
export async function makeForgeHost(options: ForgeHostOptions = {}): Promise<ForgeHost> {
  const permissionManager = {
    initialize: vi.fn().mockResolvedValue(undefined),
    isExecutionAllowed: vi.fn().mockResolvedValue({ isAllowed: true }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as ForgeHost['permissionManager'];
  const judge = vi.fn(async (_model: string, _prompt: string) => APPROVED_VERDICT);
  const executor = new ToolExecutor(undefined, undefined, options.registry);
  const orchestrator = new ToolOrchestrator();

  const silentLogger: ILogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const selfImprovementDeps = options.selfImprovement
    ? new SelfImprovementSessionManager(silentLogger).buildToolDeps(undefined, {
        getGMIForContext: () => undefined,
        getToolOrchestrator: () => orchestrator,
      })
    : undefined;

  await orchestrator.initialize(
    options.orchestratorConfig as ToolOrchestratorConfig | undefined,
    permissionManager,
    executor,
    options.tools ?? [],
    options.hitlManager,
    {
      enabled: true,
      config: {
        allowSandboxTools: true,
        persistSandboxSource: true,
        ...(options.selfImprovement
          ? { selfImprovement: { enabled: true } as unknown as EmergentConfig['selfImprovement'] }
          : {}),
        ...(options.config ?? {}),
      },
      generateText: judge,
      storageAdapter: options.db,
      selfImprovementDeps,
    },
  );
  const engine = orchestrator.getEmergentEngine();
  if (!engine) {
    throw new Error('the emergent engine was not created');
  }
  return { orchestrator, executor, engine, permissionManager, judge };
}

let callCounter = 0;

/** Calls a tool the way a model's tool call reaches it: through processToolCall. */
export function callTool(
  orchestrator: ToolOrchestrator,
  name: string,
  args: Record<string, unknown>,
  caller: {
    personaCapabilities?: string[];
    personaId?: string;
    gmiId?: string;
    /** forge_tool records the correlation id as the forging session. */
    sessionId?: string;
    correlationId?: string;
  } = {},
): Promise<ToolCallResult> {
  callCounter += 1;
  const correlationId = caller.correlationId ?? caller.sessionId;
  return orchestrator.processToolCall({
    toolCallRequest: { id: `call-${callCounter}`, name, arguments: args },
    gmiId: caller.gmiId ?? 'gmi-test',
    personaId: caller.personaId ?? 'persona-test',
    ...(correlationId ? { correlationId } : {}),
    personaCapabilities: caller.personaCapabilities ?? [],
    userContext: { userId: 'user-test' } as UserContext,
  });
}

/** A host tool with no side effects that returns its `text` argument. */
export function echoTool(name = 'echo'): ITool {
  return {
    id: `${name}-v1`,
    name,
    displayName: name,
    description: 'Returns the text it is given.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    hasSideEffects: false,
    execute: async (args: Record<string, unknown>) => ({
      success: true,
      output: { text: String(args.text) },
    }),
  };
}

/**
 * A host tool with side effects that needs the `messaging` capability and
 * records every call. `flag` sets `hasSideEffects`; `'unset'` leaves it out.
 * (A sentinel, not `undefined`: an `undefined` argument takes the default.)
 */
export function sendMessageTool(
  calls: Array<Record<string, unknown>>,
  flag: boolean | 'unset' = true,
): ITool {
  return {
    id: 'send-message-v1',
    name: 'send_message',
    displayName: 'Send message',
    description: 'Sends a message.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    requiredCapabilities: ['messaging'],
    ...(flag === 'unset' ? {} : { hasSideEffects: flag }),
    execute: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { success: true, output: { text: `sent: ${String(args.text)}` } };
    },
  };
}

/** An approval manager that approves everything and records what it was asked. */
export function approvingHitl(): {
  manager: IHumanInteractionManager;
  requestApproval: ReturnType<typeof vi.fn>;
} {
  const requestApproval = vi.fn(async (action: PendingAction) => ({
    actionId: action.actionId,
    approved: true,
    decidedBy: 'test',
    decidedAt: new Date(),
  }));
  return { manager: { requestApproval } as unknown as IHumanInteractionManager, requestApproval };
}
