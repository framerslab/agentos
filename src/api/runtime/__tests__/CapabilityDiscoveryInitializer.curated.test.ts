/**
 * @fileoverview The discovery index's sources as the runtime builds them: the host's own tools, then the tool
 * descriptors the curated registry reads from each installed pack's manifest.json. A tool the host has loaded keeps its
 * own descriptor (available, with its input schema), and a pack the catalog lists under several entries is indexed
 * once per tool.
 */

import { describe, expect, it, vi } from 'vitest';

import { CapabilityDiscoveryEngine } from '../../../cognition/discovery/CapabilityDiscoveryEngine.js';
import type { CapabilityDescriptor, CapabilityIndexSources } from '../../../cognition/discovery/types.js';
import { InMemoryVectorStore } from '../../../cognition/rag/vector_stores/InMemoryVectorStore.js';
import { EXTENSION_KIND_TOOL } from '../../../extensions/types.js';
import {
  CapabilityDiscoveryInitializer,
  curatedDescriptorsBeside,
  type CapabilityDiscoveryInitializerDependencies,
} from '../CapabilityDiscoveryInitializer.js';

const SEARCH_SCHEMA = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };

/** A tool the host has loaded from a pack, as the extension manager's tool registry holds it. */
const liveSearch = {
  name: 'github_search',
  displayName: 'GitHub Search',
  description: 'Searches GitHub repositories, code, issues, or users.',
  category: 'developer',
  inputSchema: SEARCH_SCHEMA,
  hasSideEffects: false,
  execute: vi.fn(),
};

/**
 * A tool descriptor as the runtime builds it from a curated pack's manifest.json for one catalog entry: the catalog's
 * availability (the GitHub entries say false) and no input schema.
 */
function curated(name: string): CapabilityDescriptor {
  return {
    id: `tool:${name}`,
    kind: 'tool',
    name,
    displayName: name,
    description: 'GitHub API, from the curated registry',
    category: 'developer',
    tags: [],
    requiredSecrets: ['github.token'],
    requiredTools: [],
    available: false,
    sourceRef: { type: 'extension', packageName: 'github', extensionId: 'github' },
  };
}

/** An initializer whose extension manager has loaded the GitHub pack and its search tool. */
function initializer(): CapabilityDiscoveryInitializer {
  const extensionManager = {
    getRegistry: (kind: string) => ({ listActive: () => (kind === EXTENSION_KIND_TOOL ? [{ payload: liveSearch }] : []) }),
    listLoadedPacks: () => [{ key: 'github', name: '@framers/agentos-ext-github', version: '0.3.1' }],
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return new CapabilityDiscoveryInitializer({ extensionManager, logger } as unknown as CapabilityDiscoveryInitializerDependencies);
}

/** A discovery engine over an in-memory store whose embeddings need no provider: every text embeds the same. */
async function engineOver(sources: CapabilityIndexSources): Promise<CapabilityDiscoveryEngine> {
  const embeddingManager = {
    generateEmbeddings: vi.fn(async ({ texts }: { texts: string | string[] }) => {
      const values = Array.isArray(texts) ? texts : [texts];
      return { embeddings: values.map(() => [1, 1]), modelId: 'test-embedding-model', providerId: 'test-provider', usage: { totalTokens: values.length } };
    }),
  };
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({ id: 'curated-beside-host', type: 'in_memory', similarityMetric: 'cosine' } as never);
  const engine = new CapabilityDiscoveryEngine(embeddingManager as never, vectorStore, { collectionName: 'curated-beside-host' });
  await engine.initialize(sources);
  return engine;
}

describe('the curated registry beside the host', () => {
  it("keeps a loaded tool's own descriptor in the index and indexes each curated tool once", async () => {
    // The catalog lists one pack under several entries, so its manifest's tools arrive once per entry.
    const fromCatalog = [curated('github_search'), curated('github_issue_list'), curated('github_search'), curated('github_issue_list')];
    const sources = initializer().indexSourcesWithCurated(undefined, fromCatalog);

    expect(sources.tools?.map((tool) => tool.name)).toEqual(['github_search']);
    expect(sources.manifests?.map((descriptor) => descriptor.id)).toEqual(['tool:github_issue_list']);

    const engine = await engineOver(sources);
    const search = engine.getCapabilityDetail('tool:github_search');
    expect(search?.available).toBe(true);
    expect(search?.fullSchema).toEqual(SEARCH_SCHEMA);
    expect(engine.getCapabilityDetail('tool:github_issue_list')?.available).toBe(false);
    // The turn planner asks for available capabilities alone by default; the loaded tool must stay among them.
    const found = await engine.discover('search github', { onlyAvailable: true });
    expect(found.tier1.map((item) => item.capability.name)).toContain('github_search');
  });

  it("leaves out a curated descriptor whose id the host's own manifests hold, and repeats of one id", () => {
    const own: CapabilityDescriptor = { ...curated('github_search'), description: "the host's own", available: true };
    const kept = curatedDescriptorsBeside([curated('github_search'), curated('github_pr_list'), curated('github_pr_list')], { manifests: [own] });

    expect(kept.map((descriptor) => descriptor.id)).toEqual(['tool:github_pr_list']);
    expect(curatedDescriptorsBeside([curated('github_pr_list')], {})).toHaveLength(1);
  });
});
