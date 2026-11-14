import { describe, it, expect } from 'vitest';
import type { AssembledMemoryContext, MemoryBudgetAllocation } from '../types';

describe('MemoryBudgetAllocation', () => {
  it('a seven-field allocation and a custom manager that returns one still type-check', () => {
    const allocation: MemoryBudgetAllocation = {
      workingMemory: 0.15,
      semanticRecall: 0.4,
      recentEpisodic: 0.25,
      prospectiveAlerts: 0.05,
      graphAssociations: 0.05,
      observationNotes: 0.05,
      persistentMemory: 0.05,
    };
    const context: AssembledMemoryContext = { contextText: '', tokensUsed: 0, allocation, includedMemoryIds: [] };
    expect(Object.keys(context.allocation)).toHaveLength(7);
  });
});
