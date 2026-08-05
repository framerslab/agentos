/**
 * @fileoverview Extension registration for the Cognitive Memory System.
 *
 * Registers the CognitiveMemoryManager as a MemoryProviderDescriptor
 * in the AgentOS extension system, making it discoverable and configurable.
 *
 * @module agentos/memory/extension/CognitiveMemoryExtension
 */

import {
  EXTENSION_KIND_MEMORY_PROVIDER,
  type MemoryProviderPayload,
  type MemoryProviderDescriptor,
} from '../../../../extensions/types.js';
import type { CognitiveRetrievalOptions } from '../../core/types.js';
import type { PADState } from '../../core/config.js';
import type { ICognitiveMemoryManager } from '../../CognitiveMemoryManager.js';

type RuntimeCognitiveMemoryManager = Pick<
  ICognitiveMemoryManager,
  'encode' | 'retrieve' | 'shutdown'
> & {
  getStore?: () => {
    softDelete?: (traceId: string) => Promise<void> | void;
  };
};

type CognitiveMemoryStoreInput = {
  input: string;
  mood?: PADState;
  gmiMood?: string;
  options?: Parameters<ICognitiveMemoryManager['encode']>[3];
};

type CognitiveMemoryQueryInput = {
  text?: string;
  query?: string;
  mood?: PADState;
};

const NEUTRAL_PAD: PADState = {
  valence: 0,
  arousal: 0,
  dominance: 0,
};

function isRuntimeManager(value: unknown): value is RuntimeCognitiveMemoryManager {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RuntimeCognitiveMemoryManager).encode === 'function' &&
    typeof (value as RuntimeCognitiveMemoryManager).retrieve === 'function'
  );
}

function parseStoreInput(data: unknown): CognitiveMemoryStoreInput {
  if (typeof data === 'string') {
    return { input: data };
  }
  if (typeof data !== 'object' || data === null) {
    throw new Error(
      'Cognitive memory store() expects a string or { input, mood?, gmiMood?, options? }.'
    );
  }
  const parsed = data as Partial<CognitiveMemoryStoreInput>;
  if (typeof parsed.input !== 'string' || !parsed.input.trim()) {
    throw new Error('Cognitive memory store() requires a non-empty input string.');
  }
  return {
    input: parsed.input,
    mood: parsed.mood,
    gmiMood: parsed.gmiMood,
    options: parsed.options,
  };
}

function parseQueryInput(query: unknown): { text: string; mood: PADState } {
  if (typeof query === 'string') {
    return { text: query, mood: NEUTRAL_PAD };
  }
  if (typeof query !== 'object' || query === null) {
    throw new Error('Cognitive memory query() expects a string or { text|query, mood? }.');
  }
  const parsed = query as CognitiveMemoryQueryInput;
  const text = parsed.text ?? parsed.query;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Cognitive memory query() requires a non-empty query string.');
  }
  return {
    text,
    mood: parsed.mood ?? NEUTRAL_PAD,
  };
}

/**
 * Create a MemoryProviderDescriptor for the cognitive memory system.
 *
 * This is a factory function rather than a static constant because
 * the provider needs runtime dependencies (vector store, embedding
 * manager, etc.) injected at activation time.
 */
export function createCognitiveMemoryDescriptor(
  overrides?: Partial<MemoryProviderPayload>
): MemoryProviderDescriptor {
  let manager: RuntimeCognitiveMemoryManager | null = null;

  const payload: MemoryProviderPayload = {
    name: 'cognitive-memory',
    description:
      'Cognitive science-grounded memory system with personality-affected ' +
      'encoding/retrieval, Ebbinghaus decay, mood-congruent recall, and ' +
      'Baddeley working memory slots.',
    supportedTypes: ['episodic', 'semantic', 'procedural', 'prospective', 'relational'],
    initialize: async (config: Record<string, unknown>) => {
      const candidate = config.manager;
      if (!isRuntimeManager(candidate)) {
        throw new Error(
          'Cognitive memory provider requires initialize({ manager }) with encode()/retrieve() methods.'
        );
      }
      manager = candidate;
    },
    store: async (_collectionId: string, data: unknown) => {
      if (!manager) {
        throw new Error('Cognitive memory provider not initialized.');
      }
      const input = parseStoreInput(data);
      const trace = await manager.encode(
        input.input,
        input.mood ?? NEUTRAL_PAD,
        input.gmiMood ?? '',
        input.options
      );
      return trace.id;
    },
    query: async (_collectionId: string, query: unknown, options?: Record<string, unknown>) => {
      if (!manager) {
        throw new Error('Cognitive memory provider not initialized.');
      }
      const input = parseQueryInput(query);
      const result = await manager.retrieve(
        input.text,
        input.mood,
        (options as CognitiveRetrievalOptions | undefined) ?? {}
      );
      return result.retrieved as unknown[];
    },
    delete: async (_collectionId: string, ids: string[]) => {
      if (!manager) {
        throw new Error('Cognitive memory provider not initialized.');
      }
      const store = manager.getStore?.();
      if (!store?.softDelete) {
        throw new Error('Cognitive memory provider does not expose delete support.');
      }
      await Promise.all(ids.map((id) => Promise.resolve(store.softDelete?.(id))));
    },
    shutdown: async () => {
      if (!manager) return;
      const currentManager = manager;
      try {
        await currentManager.shutdown();
      } finally {
        if (manager === currentManager) manager = null;
      }
    },
    ...overrides,
  };

  return {
    id: 'agentos-cognitive-memory',
    kind: EXTENSION_KIND_MEMORY_PROVIDER,
    priority: 100,
    enableByDefault: true,
    payload,
    metadata: {
      version: '1.0.0',
      cognitiveModels: [
        'atkinson-shiffrin',
        'baddeley-working-memory',
        'ebbinghaus-forgetting',
        'yerkes-dodson',
        'tulving-episodic-semantic',
        'anderson-spreading-activation',
      ],
    },
  };
}
