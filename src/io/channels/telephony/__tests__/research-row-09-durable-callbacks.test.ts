import { InMemoryTelephonyCallStore } from '../TelephonyCallStore.js';
import { carrierStoreContract } from './carrier-store.contract.js';
carrierStoreContract('memory carrier transactions', async () => {
  const store = new InMemoryTelephonyCallStore(); return { first: store, second: store, close: async () => undefined };
});
