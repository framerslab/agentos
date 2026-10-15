import { InMemoryRunStore } from '../stores/memory.js';
import { InMemoryCompoundCreditStore } from '../../../../safety/runtime/CompoundCreditStore.js';
import { meetingFundingContract } from './meeting-funding.contract.js';

meetingFundingContract('memory composite funding', async () => {
  const runs = new InMemoryRunStore(); const credit = new InMemoryCompoundCreditStore();
  return { runs, peerRuns: runs, credit, peerCredit: credit, close: async () => undefined };
});
