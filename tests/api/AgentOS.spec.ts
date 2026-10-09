import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GMIErrorCode } from '../../src/core/utils/errors';
import type { IGuardrailService } from '../../src/safety/guardrails/IGuardrailService';

import { AgentOS, type AgentOSConfig } from '../../src/api/AgentOS';
import { AgentOSOrchestrator } from '../../src/api/AgentOSOrchestrator';
import { createTestAgentOSConfig } from '../../src/core/config/AgentOSConfig';
import {
  AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY,
  type AgentOSPendingExternalToolRequest,
} from '../../src/api/types/AgentOSExternalToolRequest';
import {
  AgentOSResponseChunkType,
  type AgentOSResponse,
} from '../../src/api/types/AgentOSResponse';
import { GMIManager } from '../../src/cognition/substrate/GMIManager.js';
import { PromptEngine } from '../../src/core/llm/PromptEngine';
import { Memory } from '../../src/cognition/memory/io/facade/Memory.js';
import { WorkflowFacade } from '../../src/api/runtime/WorkflowFacade';
import { RagMemoryInitializer } from '../../src/api/runtime/RagMemoryInitializer';

function createConfig(overrides: Partial<AgentOSConfig> = {}): AgentOSConfig {
  return {
    gmiManagerConfig: {
      personaLoaderConfig: {
        personaSource: './personas',
        loaderType: 'file_system',
        options: {},
      },
    },
    orchestratorConfig: {},
    promptEngineConfig: {},
    toolOrchestratorConfig: {},
    toolPermissionManagerConfig: {},
    conversationManagerConfig: {
      persistenceEnabled: false,
    },
    streamingManagerConfig: {},
    modelProviderManagerConfig: {
      providers: [],
    },
    defaultPersonaId: 'test-persona',
    prisma: {} as any,
    utilityAIService: {
      summarizeConversationHistory: async () => ({
        summaryMessages: [],
        originalTokenCount: 0,
        finalTokenCount: 0,
        messagesSummarized: 0,
      }),
      summarizeRAGContext: async () => ({
        summary: '',
        originalTokenCount: 0,
        finalTokenCount: 0,
        preservedSources: [],
      }),
    } as any,
    ...overrides,
  };
}

describe('AgentOS memory tool auto-registration', () => {
  const originalEnv = { ...process.env };
  const createdPrismaClients: Array<{ $disconnect?: () => Promise<unknown> }> = [];
  const tempDirs: string[] = [];
  let agentOSOrchestratorInitializeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(WorkflowFacade.prototype, 'initialize').mockResolvedValue(undefined);
    vi.spyOn(RagMemoryInitializer.prototype, 'initializeRag').mockResolvedValue(undefined);
    vi.spyOn(PromptEngine.prototype, 'initialize').mockResolvedValue(undefined);
    vi.spyOn(PromptEngine.prototype, 'clearCache').mockResolvedValue(undefined);
    vi.spyOn(GMIManager.prototype, 'initialize').mockResolvedValue(undefined);
    vi.spyOn(GMIManager.prototype, 'shutdown').mockResolvedValue(undefined);
    agentOSOrchestratorInitializeSpy = vi
      .spyOn(AgentOSOrchestrator.prototype, 'initialize')
      .mockResolvedValue(undefined);
    vi.spyOn(AgentOSOrchestrator.prototype, 'shutdown').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    await Promise.allSettled(
      createdPrismaClients.splice(0).map(async (prisma) => {
        await prisma.$disconnect?.();
      })
    );
  });

  async function createTempMemory(selfImprove = true): Promise<Memory> {
    const dir = mkdtempSync(join(tmpdir(), 'agentos-memory-tools-'));
    tempDirs.push(dir);
    return await Memory.createSqlite({
      path: join(dir, 'brain.sqlite'),
      selfImprove,
    });
  }

  it('loads standalone memory tools from AgentOS config during initialize()', async () => {
    const agentos = new AgentOS();
    const memory = await createTempMemory(true);

    await agentos.initialize(
      createConfig({
        memoryTools: {
          memory,
        },
      })
    );

    const toolOrchestrator = agentos.getToolOrchestrator();
    expect(await toolOrchestrator.getTool('memory_add')).toBeDefined();
    expect(await toolOrchestrator.getTool('memory_search')).toBeDefined();
    expect(await toolOrchestrator.getTool('memory_reflect')).toBeDefined();

    const loadedPack = agentos
      .getExtensionManager()
      .listLoadedPacks()
      .find((pack) => pack.identifier === 'config-memory-tools');
    expect(loadedPack?.name).toBe('agentos-memory-tools');

    await agentos.shutdown();
    await memory.close();
  });

  it('respects includeReflect=false in AgentOS memoryTools config', async () => {
    const agentos = new AgentOS();
    const memory = await createTempMemory(true);

    await agentos.initialize(
      createConfig({
        memoryTools: {
          memory,
          includeReflect: false,
          identifier: 'custom-memory-tools',
        },
      })
    );

    const toolOrchestrator = agentos.getToolOrchestrator();
    expect(await toolOrchestrator.getTool('memory_add')).toBeDefined();
    expect(await toolOrchestrator.getTool('memory_reflect')).toBeUndefined();

    const loadedPack = agentos
      .getExtensionManager()
      .listLoadedPacks()
      .find((pack) => pack.identifier === 'custom-memory-tools');
    expect(loadedPack?.name).toBe('agentos-memory-tools');

    await agentos.shutdown();
    await memory.close();
  });

  it('can manage the standalone memory lifecycle during AgentOS shutdown', async () => {
    const agentos = new AgentOS();
    const memory = await createTempMemory(true);
    const closeSpy = vi.spyOn(memory, 'close');

    await agentos.initialize(
      createConfig({
        memoryTools: {
          memory,
          manageLifecycle: true,
        },
      })
    );

    await agentos.shutdown();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('derives tools, long-term retrieval, and rolling-summary persistence from standaloneMemory config', async () => {
    const agentos = new AgentOS();
    const memory = await createTempMemory(true);
    const closeSpy = vi.spyOn(memory, 'close');

    await agentos.initialize(
      createConfig({
        standaloneMemory: {
          memory,
          manageLifecycle: true,
          tools: { includeReflect: false },
          longTermRetriever: true,
          rollingSummarySink: true,
        },
      })
    );

    expect(await agentos.getToolOrchestrator().getTool('memory_add')).toBeDefined();
    expect(await agentos.getToolOrchestrator().getTool('memory_reflect')).toBeUndefined();

    const orchestratorDeps = agentOSOrchestratorInitializeSpy.mock.calls[0]?.[1] as any;
    expect(orchestratorDeps?.longTermMemoryRetriever).toBeDefined();
    expect(orchestratorDeps?.rollingSummaryMemorySink).toBeDefined();

    await agentos.shutdown();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('registers AgentOSConfig.tools into the shared tool registry and capability index', async () => {
    const agentos = new AgentOS();
    const execute = vi.fn(async (args: Record<string, any>) => ({
      success: true,
      output: { profile: { id: args.profileId, preferredTheme: 'solarized' } },
    }));

    await agentos.initialize(
      createConfig({
        tools: new Map([
          [
            'open_profile',
            {
              description: 'Load a saved profile record by ID.',
              inputSchema: {
                type: 'object',
                properties: {
                  profileId: { type: 'string' },
                },
                required: ['profileId'],
              },
              execute,
            },
          ],
        ]),
      })
    );

    const tool = await agentos.getToolOrchestrator().getTool('open_profile');
    expect(tool).toBeDefined();
    await expect(tool?.execute({ profileId: 'profile-1' }, {} as any)).resolves.toMatchObject({
      success: true,
      output: { profile: { id: 'profile-1', preferredTheme: 'solarized' } },
    });

    await expect(agentos.getToolOrchestrator().listAvailableTools()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'open_profile',
          description: 'Load a saved profile record by ID.',
        }),
      ])
    );

    const discoveryInit = (agentos as any).discoveryInitializer;
    const capabilitySources = discoveryInit?.buildCapabilityIndexSources?.() ?? { tools: [] };
    expect(capabilitySources.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'open_profile',
          description: 'Load a saved profile record by ID.',
        }),
      ])
    );

    await agentos.shutdown();
  });

  it('supports the documented createTestAgentOSConfig({ tools }) runtime path', async () => {
    const agentos = new AgentOS();
    delete process.env.DATABASE_URL;

    const config = await createTestAgentOSConfig({
      tools: {
        open_profile: {
          description: 'Load a saved profile record by ID.',
          inputSchema: {
            type: 'object',
            properties: {
              profileId: { type: 'string' },
            },
            required: ['profileId'],
          },
          execute: async ({ profileId }: { profileId: string }) => ({
            success: true,
            output: {
              profile: {
                id: profileId,
                preferredTheme: 'solarized',
              },
            },
          }),
        },
      },
    });
    createdPrismaClients.push(config.prisma as any);

    expect(process.env.DATABASE_URL).toBe('file:./test.db');

    await agentos.initialize(config);

    const tool = await agentos.getToolOrchestrator().getTool('open_profile');
    expect(tool).toBeDefined();
    await expect(tool?.execute({ profileId: 'profile-1' }, {} as any)).resolves.toMatchObject({
      success: true,
      output: {
        profile: {
          id: 'profile-1',
          preferredTheme: 'solarized',
        },
      },
    });

    await agentos.shutdown();
  });

  it('registers prompt-only AgentOSConfig.tools as explicit runtime failures', async () => {
    const agentos = new AgentOS();

    await agentos.initialize(
      createConfig({
        tools: [
          {
            name: 'open_profile',
            description: 'Load a saved profile record by ID.',
            inputSchema: {
              type: 'object',
              properties: {
                profileId: { type: 'string' },
              },
              required: ['profileId'],
            },
          },
        ],
      })
    );

    const tool = await agentos.getToolOrchestrator().getTool('open_profile');
    await expect(tool?.execute({ profileId: 'profile-1' }, {} as any)).resolves.toMatchObject({
      success: false,
      error: 'No executor configured for prompt-only tool "open_profile".',
    });

    await agentos.shutdown();
  });

  it('exposes a configured host external tool registry through AgentOS', async () => {
    const agentos = new AgentOS();

    await agentos.initialize(
      createConfig({
        externalTools: {
          open_profile: {
            description: 'Load a saved profile record by ID.',
            inputSchema: {
              type: 'object',
              properties: {
                profileId: { type: 'string' },
              },
              required: ['profileId'],
            },
            execute: vi.fn(async () => ({
              success: true,
              output: { profile: { id: 'profile-1' } },
            })),
          },
          refresh_cache: async () => ({
            success: true,
            output: { refreshed: true },
          }),
        },
      })
    );

    const registry = agentos.getExternalToolRegistry();
    expect(registry).toBeInstanceOf(Map);
    expect((registry as ReadonlyMap<string, unknown>)?.get('open_profile')).toBeDefined();
    expect(agentos.listExternalToolsForLLM()).toEqual([
      {
        name: 'open_profile',
        description: 'Load a saved profile record by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            profileId: { type: 'string' },
          },
          required: ['profileId'],
        },
        outputSchema: undefined,
      },
    ]);

    await agentos.shutdown();
  });

  it('rejects memoryTools config without a createTools() backend', async () => {
    const agentos = new AgentOS();

    await expect(
      agentos.initialize(
        createConfig({
          memoryTools: {
            memory: {} as any,
          } as any,
        })
      )
    ).rejects.toThrow(/memoryTools\.memory\.createTools/);
  });

  it('rejects standaloneMemory long-term retrieval config without a recall() backend', async () => {
    const agentos = new AgentOS();

    await expect(
      agentos.initialize(
        createConfig({
          standaloneMemory: {
            memory: {
              remember: async () => ({ id: 'x' }),
              forget: async () => undefined,
            },
            longTermRetriever: true,
          } as any,
        })
      )
    ).rejects.toThrow(/standaloneMemory\.memory\.recall/);
  });

  it('rejects manageLifecycle=true when the memory backend cannot close()', async () => {
    const agentos = new AgentOS();

    await expect(
      agentos.initialize(
        createConfig({
          memoryTools: {
            memory: {
              createTools: () => [],
            },
            manageLifecycle: true,
          } as any,
        })
      )
    ).rejects.toThrow(/memoryTools\.memory\.close/);
  });

  it('rejects standaloneMemory manageLifecycle=true when the memory backend cannot close()', async () => {
    const agentos = new AgentOS();

    await expect(
      agentos.initialize(
        createConfig({
          standaloneMemory: {
            memory: {
              remember: async () => ({ id: 'x' }),
              recall: async () => [],
              forget: async () => undefined,
            },
            manageLifecycle: true,
          } as any,
        })
      )
    ).rejects.toThrow(/standaloneMemory\.memory\.close/);
  });

  it('refuses to start when a required guardrail is missing, lacks a required stage, or was disabled by an override', async () => {
    const outputGuard: IGuardrailService = { id: 'safety-gate', evaluateOutput: async () => null };
    const inputOnly: IGuardrailService = { id: 'safety-gate', evaluateInput: async () => null };
    const required = [{ id: 'safety-gate', stages: ['output' as const], timeoutMs: 1_000 }];
    const missing = new AgentOS();
    await expect(missing.initialize(createConfig({ requiredGuardrails: required }))).rejects.toMatchObject({
      code: GMIErrorCode.CONFIGURATION_ERROR,
      details: { missing: ['safety-gate'], missingStage: [] },
    });
    const wrongStage = new AgentOS();
    await expect(wrongStage.initialize(createConfig({ requiredGuardrails: required, guardrailService: inputOnly }))).rejects.toMatchObject({
      code: GMIErrorCode.CONFIGURATION_ERROR,
      details: { missing: [], missingStage: [{ id: 'safety-gate', stage: 'output' }] },
    });
    const disabled = new AgentOS();
    await expect(
      disabled.initialize(createConfig({ requiredGuardrails: required, guardrailService: outputGuard, extensionOverrides: { guardrails: { 'config-guardrail-service': { enabled: false } } } })),
    ).rejects.toMatchObject({ code: GMIErrorCode.CONFIGURATION_ERROR, details: { missing: ['safety-gate'] } });
    const present = new AgentOS();
    await expect(present.initialize(createConfig({ requiredGuardrails: required, guardrailService: outputGuard }))).resolves.toBeUndefined();
    await present.shutdown();
  });

  it('returns persisted pending external tool requests from conversation metadata', async () => {
    const agentos = new AgentOS();
    const pendingRequest: AgentOSPendingExternalToolRequest = {
      streamId: 'stream-pending',
      sessionId: 'session-pending',
      conversationId: 'conv-pending',
      userId: 'user-1',
      personaId: 'test-persona',
      gmiInstanceId: 'gmi-pending',
      toolCalls: [{ id: 'tool-1', name: 'memory_search', arguments: { query: 'prefs' } }],
      requestedAt: new Date().toISOString(),
    };

    await agentos.initialize(createConfig());

    vi.spyOn(agentos.getConversationManager(), 'getConversation').mockResolvedValue({
      getMetadata: (key: string) =>
        key === 'userId'
          ? 'user-1'
          : key === AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY
            ? pendingRequest
            : undefined,
    } as any);

    await expect(agentos.getPendingExternalToolRequest('conv-pending', 'user-1')).resolves.toEqual(
      pendingRequest
    );

    await agentos.shutdown();
  });

  it('bridges resumeExternalToolRequest through a fresh response stream', async () => {
    const agentos = new AgentOS();
    const pendingRequest: AgentOSPendingExternalToolRequest = {
      streamId: 'stream-old',
      sessionId: 'session-resume',
      conversationId: 'conv-resume',
      userId: 'user-1',
      personaId: 'test-persona',
      gmiInstanceId: 'gmi-resume',
      toolCalls: [{ id: 'tool-1', name: 'memory_search', arguments: { query: 'prefs' } }],
      requestedAt: new Date().toISOString(),
    };

    await agentos.initialize(createConfig());

    const streamingManager = (agentos as any).streamingManager;
    const orchestrateResumeSpy = vi
      .spyOn((agentos as any).agentOSOrchestrator, 'orchestrateResumedToolResults')
      .mockImplementation(async () => {
        const streamId = 'stream-resume';
        await streamingManager.createStream(streamId);
        setTimeout(async () => {
          await streamingManager.pushChunk(streamId, {
            type: AgentOSResponseChunkType.TEXT_DELTA,
            streamId,
            gmiInstanceId: 'gmi-resume',
            personaId: 'test-persona',
            isFinal: false,
            timestamp: new Date().toISOString(),
            textDelta: 'Resumed.',
          } satisfies AgentOSResponse);
          await streamingManager.pushChunk(streamId, {
            type: AgentOSResponseChunkType.FINAL_RESPONSE,
            streamId,
            gmiInstanceId: 'gmi-resume',
            personaId: 'test-persona',
            isFinal: true,
            timestamp: new Date().toISOString(),
            finalResponseText: 'Resumed.',
          } satisfies AgentOSResponse);
          await streamingManager.closeStream(streamId, 'done');
        }, 0);
        return streamId;
      });

    const chunks: AgentOSResponse[] = [];
    for await (const chunk of agentos.resumeExternalToolRequest(
      pendingRequest,
      [
        {
          toolCallId: 'tool-1',
          toolName: 'memory_search',
          toolOutput: { results: [] },
          isSuccess: true,
        },
      ],
      {
        organizationId: 'org-resume',
      }
    )) {
      chunks.push(chunk);
    }

    expect(orchestrateResumeSpy).toHaveBeenCalledWith(
      pendingRequest,
      [
        {
          toolCallId: 'tool-1',
          toolName: 'memory_search',
          toolOutput: { results: [] },
          isSuccess: true,
        },
      ],
      {
        organizationId: 'org-resume',
      }
    );
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      AgentOSResponseChunkType.TEXT_DELTA,
      AgentOSResponseChunkType.FINAL_RESPONSE,
    ]);

    await agentos.shutdown();
  });
});
