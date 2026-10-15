import { describe, expect, it, vi } from 'vitest';
import { AgencyMemoryManager } from '../AgencyMemoryManager.js';
import type { IVectorStoreManager } from '../../../core/vector-store/IVectorStoreManager.js';

describe('AgencyMemoryManager', () => {
  it('logs query length and result count without query text', async () => {
    const sentinel = 'sentinel-words-7731';
    const provider = { query: vi.fn().mockResolvedValue({ documents: [] }) };
    const debug = vi.fn();
    const manager = new AgencyMemoryManager({
      getDefaultProvider: () => provider,
    } as unknown as IVectorStoreManager, { debug } as any);
    const result = await manager.querySharedMemory('agency-1', {
      query: sentinel, requestingGmiId: 'gmi-1', requestingRoleId: 'role-1',
    }, { enabled: true });
    expect(result.success).toBe(true);
    expect(debug).toHaveBeenCalledWith('Queried agency shared memory', {
      agencyId: 'agency-1', queryLength: sentinel.length, resultsReturned: 0,
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain(sentinel);
  });

  it('aggregates stats using contributorRoleId metadata', async () => {
    const provider = {
      getStats: vi.fn().mockResolvedValue({ documentCount: 3, vectorCount: 7 }),
      listDocuments: vi.fn().mockResolvedValue({
        documents: [
          { metadata: { contributorRoleId: 'researcher', category: 'finding' } },
          { metadata: { contributorRoleId: 'researcher', category: 'summary' } },
          { metadata: { contributorRoleId: 'lead', category: 'decision' } },
        ],
      }),
    };

    const vectorStoreManager = {
      getDefaultProvider: vi.fn().mockReturnValue(provider),
    } as unknown as IVectorStoreManager;

    const manager = new AgencyMemoryManager(vectorStoreManager);
    const stats = await manager.getStats('agency-1');

    expect(stats).toEqual({
      totalDocuments: 3,
      totalChunks: 7,
      documentsByRole: {
        researcher: 2,
        lead: 1,
      },
      documentsByCategory: {
        finding: 1,
        summary: 1,
        decision: 1,
      },
    });
  });
});
