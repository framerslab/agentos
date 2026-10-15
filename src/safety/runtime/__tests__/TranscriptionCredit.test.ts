import { InMemoryCompoundCreditStore } from '../CompoundCreditStore.js';
import { runTranscriptionCreditContract } from './transcriptionCredit.contract.js';

runTranscriptionCreditContract('memory supplier credit', async () => new InMemoryCompoundCreditStore());
