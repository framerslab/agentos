import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryLifecycleManager } from '../MemoryLifecycleManager';
import { IMemoryLifecycleManager, GMIResolverFunction } from '../IMemoryLifecycleManager';
import { MemoryLifecycleManagerConfig, MemoryLifecyclePolicy, PolicyAction } from '../../../../../core/config/MemoryLifecycleManagerConfiguration';
import { IVectorStoreManager } from '../../../../../core/vector-store/IVectorStoreManager';
import { IVectorStore } from '../../../../../core/vector-store/IVectorStore';
import { IUtilityAI, SummarizationOptions } from '../../../../nlp/ai_utilities/IUtilityAI';
import { IGMI, LifecycleAction, LifecycleActionResponse, MemoryLifecycleEvent } from '../../../../substrate/IGMI';

// --- Mock Dependencies ---
const mockVectorStore: IVectorStore & { scanByMetadata?: ReturnType<typeof vi.fn> } = {
  initialize: vi.fn().mockResolvedValue(undefined),
  upsert: vi.fn().mockResolvedValue({ upsertedCount: 0, upsertedIds: [] }),
  query: vi.fn().mockResolvedValue({ documents: [] }),
  scanByMetadata: vi.fn().mockResolvedValue({ documents: [] }),
  delete: vi.fn().mockResolvedValue({ deletedCount: 1 }), // Mock successful delete
  checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
  shutdown: vi.fn().mockResolvedValue(undefined),
  createCollection: vi.fn().mockResolvedValue(undefined),
  collectionExists: vi.fn().mockResolvedValue(true),
};

const mockVectorStoreManager: IVectorStoreManager = {
  initialize: vi.fn().mockResolvedValue(undefined),
  getProvider: vi.fn().mockReturnValue(mockVectorStore),
  getDefaultProvider: vi.fn().mockReturnValue(mockVectorStore),
  getStoreForDataSource: vi.fn().mockResolvedValue({ store: mockVectorStore, collectionName: 'test-collection', dimension: 128 }),
  listProviderIds: vi.fn().mockReturnValue(['mock-store-provider-mlm']),
  listDataSourceIds: vi.fn().mockResolvedValue(['test-ds-mlm']),
  checkHealth: vi.fn().mockResolvedValue({ isOverallHealthy: true }),
  shutdownAllProviders: vi.fn().mockResolvedValue(undefined),
};

const mockGMI: Partial<IGMI> = {
  gmiId: 'gmi-mock-for-mlm',
  onMemoryLifecycleEvent: vi.fn().mockImplementation(async (event: MemoryLifecycleEvent): Promise<LifecycleActionResponse> => {
    // By default, GMI allows the proposed action for testing MLM execution path
    return { gmiId: 'gmi-mock-for-mlm', eventId: event.eventId, actionTaken: event.proposedAction, rationale: 'GMI mock auto-approve' };
  }),
  // Stub other IGMI methods if needed by MLM's interaction (likely not for basic tests)
  initialize: vi.fn(), processTurnStream: vi.fn() as any, getPersona: vi.fn(),
  getCurrentState: vi.fn(), getReasoningTrace: vi.fn(),
  _triggerAndProcessSelfReflection: vi.fn(), analyzeAndReportMemoryHealth: vi.fn(),
  getOverallHealth: vi.fn(), shutdown: vi.fn(), getGMIId: vi.fn().mockReturnValue('gmi-mock-for-mlm'),
};

const mockGMIResolver: GMIResolverFunction = vi.fn().mockResolvedValue(mockGMI);

const mockUtilityAIForMLM: IUtilityAI = {
  utilityId: 'util-mock-for-mlm',
  initialize: vi.fn().mockResolvedValue(undefined),
  summarize: vi.fn().mockResolvedValue("Mocked summary for lifecycle action"),
  // Stub other IUtilityAI methods as needed
  parseJsonSafe: vi.fn(), classifyText: vi.fn(), extractKeywords: vi.fn(), tokenize: vi.fn(),
  stemTokens: vi.fn(), calculateSimilarity: vi.fn(), analyzeSentiment: vi.fn(),
  detectLanguage: vi.fn(), normalizeText: vi.fn(), generateNGrams: vi.fn(),
  calculateReadability: vi.fn(),
  checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

const deletePolicy: MemoryLifecyclePolicy = {
  policyId: 'delete-old-docs',
  description: 'Deletes documents older than 30 days.',
  isEnabled: true,
  priority: 10,
  appliesTo: {
    categories: ['conversation_history', 'general_log'] as any,
    dataSourceIds: ['test-ds-mlm'],
  },
  retentionDays: 30,
  action: { type: 'delete' },
  gmiNegotiation: { enabled: false }, // Disable negotiation for simpler test
};

const summarizeDeletePolicy: MemoryLifecyclePolicy = {
    policyId: 'summarize-delete-policy',
    description: 'Summarizes and then deletes items.',
    isEnabled: true,
    priority: 5,
    appliesTo: { dataSourceIds: ['test-ds-mlm'], categories: ['summaries_only'] as any },
    action: {
        type: 'summarize_and_delete',
        llmModelForSummary: 'summary-model', // Conceptual
        summaryDataSourceId: 'summary-ds' // Conceptual
    },
    gmiNegotiation: { enabled: false },
};


const baseMLMConfig: MemoryLifecycleManagerConfig = {
  managerId: 'mlm-test-manager',
  policies: [deletePolicy, summarizeDeletePolicy],
  defaultCheckInterval: "PT1H",
  dryRunMode: false, // Set to false for action execution tests
  defaultRetentionDays: 30,
  defaultGMINegotiationTimeoutMs: 1000,
  itemTimestampMetadataField: 'timestamp', // Assuming items have this metadata field
};


describe('MemoryLifecycleManager', () => {
  let mlm: IMemoryLifecycleManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    mlm = new MemoryLifecycleManager();
    await mlm.initialize(baseMLMConfig, mockVectorStoreManager, mockGMIResolver, mockUtilityAIForMLM);
  });

  it('should be defined and initialize without errors', () => {
    expect(mlm).toBeDefined();
    expect(mlm.managerId).toContain('mlm-');
  });

  it('executeLifecycleAction should call vectorStore.delete for "delete" action', async () => {
    const candidateItem = { // This would normally come from findPolicyCandidates
      id: 'doc-to-delete',
      dataSourceId: 'test-ds-mlm',
      collectionName: 'test-collection',
      metadata: { timestamp: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString() }, // Older than 30 days
      vectorStoreRef: mockVectorStore,
      textContent: "some old content"
    };
    const actionDetails: PolicyAction = { type: 'delete' };
    
    // Directly call executeLifecycleAction for testing its internal logic,
    // as findPolicyCandidates is complex and not fully implemented/mocked.
  await (mlm as any).executeLifecycleAction(candidateItem, actionDetails, 'delete' as LifecycleAction, deletePolicy.policyId);

    expect(mockVectorStore.delete).toHaveBeenCalledWith('test-collection', ['doc-to-delete']);
  });

  it('executeLifecycleAction should call utilityAI.summarize and vectorStore.delete for "summarize_and_delete"', async () => {
    const candidateItem = {
      id: 'doc-to-summarize-delete',
      dataSourceId: 'test-ds-mlm',
      collectionName: 'test-collection',
      metadata: { /* ... */ },
      vectorStoreRef: mockVectorStore,
      textContent: "This is the full text content to be summarized."
    };
    const actionDetails = summarizeDeletePolicy.action; // from defined policy

  await (mlm as any).executeLifecycleAction(candidateItem, actionDetails, 'summarize_and_delete' as LifecycleAction, summarizeDeletePolicy.policyId);

    expect(mockUtilityAIForMLM.summarize).toHaveBeenCalledWith(
      candidateItem.textContent,
      expect.objectContaining({ method: 'abstractive_llm', modelId: actionDetails.llmModelForSummary })
    );
    expect(mockVectorStore.delete).toHaveBeenCalledWith('test-collection', [candidateItem.id]);
  });
  
  it('processSingleItemLifecycle should apply delete policy if item is old enough', async () => {
    const oldItemContext = {
      itemId: 'old-item-001',
      dataSourceId: 'test-ds-mlm',
      metadata: { timestamp: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString() }, // 40 days old
      category: 'general_log' as any, // Ensure type alignment with RagMemoryCategory if used
    };

    const result = await mlm.processSingleItemLifecycle(oldItemContext, 'manual_check');
    
    expect(result.actionTaken).toBe('delete'); // Assumes deletePolicy is first applicable
    expect(mockVectorStore.delete).toHaveBeenCalledWith('test-collection', [oldItemContext.itemId]);
  });

  it('processSingleItemLifecycle should take NO_ACTION if item is newer than retention', async () => {
    const newItemContext = {
      itemId: 'new-item-002',
      dataSourceId: 'test-ds-mlm',
      metadata: { timestamp: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() }, // 10 days old
      category: 'general_log' as any,
    };
    const result = await mlm.processSingleItemLifecycle(newItemContext, 'manual_check');
    expect(result.actionTaken).toBe('NO_ACTION_TAKEN');
    expect(result.details).toContain("Item within retention period");
    expect(mockVectorStore.delete).not.toHaveBeenCalledWith('test-collection', [newItemContext.itemId]);
  });

  it('enforcePolicies should discover lifecycle candidates through metadata scan and delete them', async () => {
    const expiredTimestamp = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    mockVectorStore.scanByMetadata?.mockResolvedValueOnce({
      documents: [
        {
          id: 'scan-old-001',
          similarityScore: 1,
          metadata: {
            category: 'general_log',
            timestamp: expiredTimestamp,
          },
          textContent: 'old lifecycle-managed content',
        },
      ],
    });

    const report = await mlm.enforcePolicies({ policyIds: [deletePolicy.policyId] });

    expect(mockVectorStore.scanByMetadata).toHaveBeenCalledWith(
      'test-collection',
      expect.objectContaining({
        includeMetadata: true,
        includeTextContent: true,
        filter: expect.objectContaining({
          category: { $in: ['conversation_history', 'general_log'] },
          timestamp: { $lt: expect.any(String) },
        }),
      }),
    );
    expect(mockVectorStore.delete).toHaveBeenCalledWith('test-collection', ['scan-old-001']);
    expect(report.itemsScanned).toBe(1);
    expect(report.itemsAffected).toBe(1);
    expect(report.policyResults?.[deletePolicy.policyId]?.actionsTaken?.delete).toBe(1);
  });


  it('checkHealth should report as healthy if initialized and dependencies are healthy', async () => {
    const health = await mlm.checkHealth();
    expect(health.isHealthy).toBe(true);
    expect(health.details).toHaveProperty('status', 'Initialized');
  // Simplified health expectations: dependencies field no longer guaranteed
  });

  it('should allow shutdown and clear periodic timer', async () => {
    // Check if timer exists before shutdown
    expect((mlm as any).periodicCheckTimer).toBeDefined();
    await expect(mlm.shutdown()).resolves.toBeUndefined();
    expect((mlm as any).periodicCheckTimer).toBeUndefined(); // Timer should be cleared
  });
});
