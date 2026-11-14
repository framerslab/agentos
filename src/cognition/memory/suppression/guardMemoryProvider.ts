/**
 * @module memory/suppression/guardMemoryProvider
 *
 * A host's own memory provider, checked against the forgotten-user ledger before each write and each recall.
 */
import type { AgentMemoryProvider } from '../../../api/agent.js';
import { memoryLog } from '../log.js';
import type { ForgottenLedger } from './ForgottenLedger.js';

/**
 * A memory provider whose `observe` and `getContext` ask the ledger first: for a forgotten subject `observe` files
 * nothing (one `memory.write_refused` line) and `getContext` answers null. The provider's own store is its own: a
 * deletion names it as not reached.
 *
 * A call with no hook context names no subject and goes to the provider as it is.
 *
 * @param provider - The host's provider.
 * @param ledger - The ledger of the store the host's deletions write to.
 * @returns A provider with the same hooks the given one has.
 */
export function guardMemoryProvider(
  provider: AgentMemoryProvider,
  ledger: Pick<ForgottenLedger, 'isForgotten'>,
): AgentMemoryProvider {
  const guarded: AgentMemoryProvider = {};
  const observe = provider.observe?.bind(provider);
  if (observe) {
    guarded.observe = async (role, text, context) => {
      if (context && (await ledger.isForgotten(context.subject))) {
        memoryLog.warn('memory.write_refused', { reason: 'forgotten' });
        return;
      }
      await observe(role, text, context);
    };
  }
  const getContext = provider.getContext?.bind(provider);
  if (getContext) {
    guarded.getContext = async (text, options) => {
      const context = options?.context;
      if (context && (await ledger.isForgotten(context.subject))) return null;
      return getContext(text, options);
    };
  }
  return guarded;
}
