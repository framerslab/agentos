import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function read(relativeToThisFile: string): string {
  return readFileSync(new URL(relativeToThisFile, import.meta.url), 'utf8');
}

function exists(relativeToThisFile: string): boolean {
  try {
    return existsSync(fileURLToPath(new URL(relativeToThisFile, import.meta.url)));
  } catch { return false; }
}

/** Skip tests that reference files outside the agentos package (e.g. in CI where submodules aren't checked out). */
const hasLiveDocs = exists('../../../../../apps/agentos-live-docs/docs/index.md');
const hasSkillsPackages = exists('../../../../agentos-skills/package.json');
const itIfLiveDocs = hasLiveDocs ? it : it.skip;
const itIfSkills = hasSkillsPackages ? it : it.skip;
// Monorepo-root docs (../../../../../../docs) only exist when agentos is a
// submodule of the monorepo; they are absent in standalone agentos CI.
const hasRepoRootDocs = exists('../../../../../../docs/README.md');
const itIfRepoRootDocs = hasRepoRootDocs ? it : it.skip;

describe('AgentOS docs alignment', () => {
  it('keeps the package README aligned with the high-level API surface', () => {
    const readme = read('../../../../README.md');
    // Each of these names is a real exported helper users discover from
    // the README — assert presence, not specific heading text. README
    // structure is allowed to evolve without breaking this test.
    expect(readme).toContain('generateImage');
    expect(readme).toContain('agent()');
    expect(readme).toContain('agency()');
    expect(readme).toContain('## API Surfaces');
  });

  it('describes provider fallback as an explicit opt-in helper contract', () => {
    const readme = read('../../../../README.md');
    // Reject the old auto-fallback-on-error wording that implied the
    // runtime silently routes around failures without consent.
    expect(readme).not.toContain('Auto-fallback on 402/429/5xx.');
    // The README must point at the public fallback API somewhere — either
    // the agency-level config field or the helper that builds chains.
    // Both names are stable parts of the public surface.
    const mentionsFallback =
      readme.includes('fallbackProviders') ||
      readme.includes('buildFallbackChain') ||
      readme.includes('automatic fallback');
    expect(mentionsFallback).toBe(true);
  });

  it('documents the distinction between lightweight agent() and the full runtime', () => {
    const readme = read('../../../../README.md');
    // The README must distinguish the lightweight `agent()` factory from
    // the heavier `agency()` / full `AgentOS` runtime. Allow either the
    // verbose prose or a structural acknowledgment in API Surfaces.
    expect(readme).toContain('agent()');
    const hasLightweightVsFullDistinction =
      readme.includes('lightweight') &&
      (readme.includes('AgentOS') || readme.includes('agency()'));
    expect(hasLightweightVsFullDistinction).toBe(true);
  });

  it('keeps the README and high-level example aligned with the real memory config shape', () => {
    const readme = read('../../../../README.md');
    const guide = read('../../../../docs/getting-started/HIGH_LEVEL_API.md');
    const example = read('../../../../examples/high-level-api.mjs');

    expect(readme).not.toContain('memory: { enabled: true, cognitive: true }');
    expect(guide).toContain("types: ['episodic', 'semantic']");
    expect(example).toContain("working: { enabled: true }");
  });

  it('keeps the high-level API guide aligned with provider-agnostic image generation', () => {
    const guide = read('../../../../docs/getting-started/HIGH_LEVEL_API.md');
    expect(guide).toContain('registerImageProviderFactory');
    expect(guide).toContain('openrouter');
    expect(guide).toContain('replicate');
    expect(guide).toContain('Keep `generateImage()` provider-agnostic at the API boundary');
  });

  itIfLiveDocs('keeps the runnable example and docs homepage aligned with the streamlined APIs', () => {
    const example = read('../../../../examples/high-level-api.mjs');
    const docsIndex = read('../../../../../apps/agentos-live-docs/docs/index.md');
    const homepage = read('../../../../../apps/agentos-live-docs/src/pages/index.tsx');

    expect(example).toContain('generateImage');
    expect(docsIndex).toContain('High-Level API');
    expect(homepage).toContain('High-Level API');
    expect(homepage).toContain('/getting-started/high-level-api');
  });

  itIfLiveDocs('keeps the live docs skills routes aligned with the canonical manifest', () => {
    const docsIndex = read('../../../../../apps/agentos-live-docs/docs/index.md');
    const homepage = read('../../../../../apps/agentos-live-docs/src/pages/index.tsx');

    expect(docsIndex).toContain('/skills/agentos-skills');
    expect(docsIndex).not.toContain('/skills/skills-extension');
    expect(homepage).toContain('/api/');
    expect(homepage).toContain('/skills/overview');
    expect(homepage).not.toContain('72 Curated Skills');
    expect(homepage).not.toContain('107 Extensions');
  });

  itIfLiveDocs('surfaces the unified orchestration guides in the package docs and live docs indexes', () => {
    const packageDocsIndex = read('../../../../docs/README.md');
    const liveDocsIndex = read('../../../../../apps/agentos-live-docs/docs/index.md');
    const documentationIndex = read('../../../../../apps/agentos-live-docs/docs/getting-started/documentation-index.md');

    expect(packageDocsIndex).toContain('Unified Orchestration Layer');
    expect(packageDocsIndex).toContain('AgentGraph');
    expect(packageDocsIndex).toContain('workflow() DSL');
    expect(packageDocsIndex).toContain('mission() API');
    expect(liveDocsIndex).toContain('/features/unified-orchestration');
    expect(documentationIndex).toContain('Checkpointing');
  });

  it('keeps the package documentation index pointed at real source files', () => {
    const packageDocsIndex = read('../../../../docs/README.md');

    expect(packageDocsIndex).toContain('./getting-started/GETTING_STARTED.md');
    expect(packageDocsIndex).toContain('./architecture/ARCHITECTURE.md');
    expect(packageDocsIndex).toContain('./extensions/SKILLS.md');
    expect(packageDocsIndex).not.toContain('](./GETTING_STARTED.md)');
    expect(packageDocsIndex).not.toContain('](./ARCHITECTURE.md)');
    expect(packageDocsIndex).not.toContain('](./SKILLS.md)');
  });

  it('keeps emergent docs centered on the full runtime entry point', () => {
    const emergentGuide = read('../../../../docs/architecture/EMERGENT_CAPABILITIES.md');
    expect(emergentGuide).toContain('new AgentOS()');
    expect(emergentGuide).toContain('full runtime');
  });

  it('keeps docs package scripts and typedoc links pointed at real routes', () => {
    const packageJson = JSON.parse(read('../../../../package.json'));
    const typedocConfig = JSON.parse(read('../../../../typedoc.json'));

    expect(packageJson.scripts['docs:site-api']).not.toContain('generate-api-docs.js');
    expect(typedocConfig.sidebarLinks.Documentation).toBe('https://docs.agentos.sh/documentation');
  });

  itIfRepoRootDocs('documents the contributor docs workflow in the canonical repo docs', () => {
    const docsIndex = read('../../../../../../docs/README.md');
    const contributing = read('../../../../../../docs/getting-started/CONTRIBUTING.md');

    expect(docsIndex).toContain('docs:verify');
    expect(docsIndex).toContain('build:guides');
    expect(contributing).toContain('docs:verify');
    expect(contributing).toContain('build:guides');
    expect(contributing).toContain('verify:publication');
  });

  itIfRepoRootDocs('points ecosystem API links at the published docs site', () => {
    const ecosystemGuide = read('../../../../../../docs/getting-started/ecosystem.md');
    const packageEcosystemGuide = read('../../../../docs/architecture/ECOSYSTEM.md');

    expect(ecosystemGuide).toContain('https://docs.agentos.sh/api/');
    expect(packageEcosystemGuide).toContain('https://docs.agentos.sh/api/');
    expect(ecosystemGuide).not.toContain('agentos-live-docs branch');
    expect(packageEcosystemGuide).not.toContain('agentos-live-docs branch');
  });

  itIfRepoRootDocs('keeps runtime-status guidance centralized across orchestration and backend docs', () => {
    const runtimeStatusGuide = read('../../../../../../docs/architecture/runtime-status-matrix.md');
    const missionGuide = read('../../../../../../docs/orchestration/mission-api.md');
    const orchestrationOverview = read('../../../../../../docs/orchestration/overview.md');
    const autoLoadingGuide = read('../../../../../../docs/extensions/auto-loading.md');
    const backendApiGuide = read('../../../../../../docs/architecture/BACKEND_API.md');

    expect(runtimeStatusGuide).toContain('Shipped');
    expect(runtimeStatusGuide).toContain('Partial / Experimental');
    expect(runtimeStatusGuide).toContain('Planned');
    expect(runtimeStatusGuide).toContain('UnifiedRetriever');
    expect(missionGuide).toContain('../architecture/runtime-status-matrix.md');
    expect(orchestrationOverview).toContain('../architecture/runtime-status-matrix.md');
    expect(autoLoadingGuide).toContain('../architecture/runtime-status-matrix.md');
    expect(backendApiGuide).toContain('./runtime-status-matrix.md');
  });

  itIfRepoRootDocs('labels placeholder backend endpoints as experimental placeholder surfaces', () => {
    const backendApiGuide = read('../../../../../../docs/architecture/BACKEND_API.md');

    expect(backendApiGuide).toContain('/agentos/extensions/install');
    expect(backendApiGuide).toContain('/agentos/tools/execute');
    expect(backendApiGuide).toContain('placeholder');
    expect(backendApiGuide).toContain('experimental');
  });

  itIfSkills('references the 3-tier skills architecture (engine + content + catalog SDK)', () => {
    const contentPackage = JSON.parse(read('../../../../agentos-skills/package.json'));
    const catalogSdkPackage = JSON.parse(read('../../../../agentos-skills-registry/package.json'));
    const packageSkillsGuide = read('../../../../docs/extensions/SKILLS.md');

    // @framers/agentos-skills is now the CONTENT package (SKILL.md files + registry.json)
    expect(contentPackage.name).toBe('@framers/agentos-skills');
    expect(contentPackage.description).toContain('SKILL.md');

    // @framers/agentos-skills-registry is the CATALOG SDK (query helpers, factories)
    expect(catalogSdkPackage.name).toBe('@framers/agentos-skills-registry');
    expect(catalogSdkPackage.description).toContain('Catalog SDK');

    // The skills guide references all three tiers
    expect(packageSkillsGuide).toContain('@framers/agentos/cognition/skills');
    expect(packageSkillsGuide).toContain('@framers/agentos-skills');
    expect(packageSkillsGuide).toContain('@framers/agentos-skills-registry');
  });
  it('keeps every relative docs link from a published guide pointed at a published page', () => {
    // docs.agentos.sh builds its guide pages from the publication manifest and
    // rewrites a relative link by the target's file name. A link from a published
    // guide to a docs file the manifest does not publish stays as written, and the
    // site's build fails on it (docs/GMI.md linked features/STRUCTURED_REPLY.md
    // before the manifest listed that page).
    const requireCjs = createRequire(import.meta.url);
    const { publicationManifest } = requireCjs('../../../../docs/publication-manifest.cjs') as {
      publicationManifest: Array<{ sourcePath?: string }>;
    };
    const docsRoot = fileURLToPath(new URL('../../../../docs/', import.meta.url));
    const searchSubdirs = [
      'getting-started',
      'architecture',
      'features',
      'memory',
      'safety',
      'observability',
      'extensions',
      'orchestration',
    ];
    // The site matches file names case-insensitively, with '-' read as '_'.
    const publishedKey = (fileName: string) => fileName.toLowerCase().replace(/-/g, '_');
    const published = new Set<string>();
    const publishedGuides: string[] = [];
    for (const entry of publicationManifest) {
      const sourcePath = entry.sourcePath ?? '';
      if (!sourcePath.endsWith('.md')) continue;
      published.add(publishedKey(basename(sourcePath)));
      if (!sourcePath.startsWith('packages/agentos/docs/')) continue;
      const relativeSource = sourcePath.slice('packages/agentos/docs/'.length);
      const candidates = [
        join(docsRoot, relativeSource),
        ...searchSubdirs.map((subdir) => join(docsRoot, subdir, basename(relativeSource))),
      ];
      const found = candidates.find((candidate) => existsSync(candidate));
      if (found) publishedGuides.push(found);
    }
    expect(publishedGuides.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const guide of publishedGuides) {
      const content = readFileSync(guide, 'utf8');
      for (const match of content.matchAll(/\]\(((?:\.\.?\/)[^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
        const target = resolve(dirname(guide), match[1]);
        if (!target.startsWith(docsRoot) || !existsSync(target)) continue;
        if (!published.has(publishedKey(basename(target)))) {
          offenders.push(`${relative(docsRoot, guide)} -> ${match[1]}`);
        }
      }
    }
    expect(offenders, 'published guides that link to a docs file the manifest does not publish').toEqual([]);
  });
});
