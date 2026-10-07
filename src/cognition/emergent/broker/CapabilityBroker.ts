/**
 * @fileoverview The host-side broker for code-forged tools under a ceiling.
 * It hands each call the functions the call's grant names, scoped by the
 * ceiling, and checks before every capability call, in this order: the call
 * is live, the capability is in the grant, the target fits the scope. On
 * `node:vm` these checks are a guardrail for code that acts through these
 * functions; Node's documentation says `node:vm` is not a security mechanism.
 * @module @framers/agentos/emergent/broker/CapabilityBroker
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { ResolvedCeiling } from '../ceiling.js';
import type { CallHandle, CapabilityName } from '../types.js';
import { prepareFetch, sendFetch } from './fetch.js';
import { prepareRead, readPrepared, ReadRoots } from './fs-read.js';
import { CapabilityRefusal } from './refusal.js';

export class CapabilityBroker {
  private readonly readRoots: ReadRoots | undefined;

  constructor(readonly ceiling: ResolvedCeiling) {
    this.readRoots = ceiling['fs.read'] ? new ReadRoots(ceiling['fs.read'].roots) : undefined;
  }

  /**
   * The globals injected into one call's sandbox: a function for each
   * capability that both the grant and the ceiling hold, and nothing else.
   */
  functionsFor(grant: readonly CapabilityName[], call: CallHandle): Record<string, unknown> {
    const functions: Record<string, unknown> = {};
    const admit = (capability: CapabilityName): void => {
      if (call.signal.aborted) {
        throw new CapabilityRefusal('call_ended', capability);
      }
      if (!grant.includes(capability) || this.ceiling[capability] === undefined) {
        throw new CapabilityRefusal('capability_not_granted', capability);
      }
    };

    const fetchScope = this.ceiling.fetch;
    if (grant.includes('fetch') && fetchScope) {
      functions.fetch = async (input: unknown, init?: unknown): Promise<Response> => {
        admit('fetch');
        const prepared = prepareFetch(input, init, fetchScope);
        return (await sendFetch(prepared, fetchScope, call.signal)).response;
      };
    }

    const readScope = this.ceiling['fs.read'];
    const roots = this.readRoots;
    if (grant.includes('fs.read') && readScope && roots) {
      functions.fs = {
        readFile: async (filePath: unknown): Promise<string> => {
          admit('fs.read');
          const resolved = prepareRead(filePath, roots);
          return (await readPrepared(resolved, roots, readScope, call.signal)).text;
        },
      };
    }

    if (grant.includes('crypto') && this.ceiling.crypto) {
      functions.crypto = {
        randomUUID: () => {
          admit('crypto');
          return randomUUID();
        },
        createHash: (algorithm: string) => {
          admit('crypto');
          return createHash(algorithm);
        },
        createHmac: (algorithm: string, key: string) => {
          admit('crypto');
          return createHmac(algorithm, key);
        },
      };
    }
    return functions;
  }
}
