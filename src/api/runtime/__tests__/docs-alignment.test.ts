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

/**
 * The options of each `agent({ ... })` call in `text` that set `memory` (to
 * anything but `false`) without `runtime: 'gmi'`. agent() reads `memory` only on
 * the GMI path, so such a call shows an option that does nothing.
 */
function plainAgentCallsWithMemory(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\bagent\(\{/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    let close = open;
    for (; close < text.length; close += 1) {
      if (text[close] === '{') depth += 1;
      else if (text[close] === '}' && --depth === 0) break;
    }
    const options = text.slice(open, close + 1);
    if (/\bmemory\s*:(?!\s*false\b)/.test(options) && !/\bruntime\s*:\s*['"]gmi['"]/.test(options)) {
      found.push(options.replace(/\s+/g, ' ').slice(0, 120));
    }
  }
  return found;
}

// Paths resolve against this file's URL: '../../../../' is the agentos package root,
// '../../../../../' the monorepo's packages/ directory and '../../../../../../' the
// monorepo root. The docs site (apps/agentos-live-docs) and the skills packages
// (packages/agentos-skills, packages/agentos-skills-registry) sit there only in the
// monorepo; standalone agentos CI checks out neither, so the tests that read them skip.
// These two guards each check every file outside the package that their tests read.
const hasLiveDocs = [
  '../../../../../../apps/agentos-live-docs/docs/index.md',
  '../../../../../../apps/agentos-live-docs/src/pages/index.tsx',
].every((file) => exists(file));
const hasSkillsPackages = [
  '../../../../../agentos-skills/package.json',
  '../../../../../agentos-skills-registry/package.json',
].every((file) => exists(file));
const itIfLiveDocs = hasLiveDocs ? it : it.skip;
const itIfSkills = hasSkillsPackages ? it : it.skip;
// Monorepo-root docs (../../../../../../docs) only exist when agentos is a
// submodule of the monorepo; they are absent in standalone agentos CI. This guard
// checks docs/README.md alone; its tests read other files under that docs/ too.
const hasRepoRootDocs = exists('../../../../../../docs/README.md');
const itIfRepoRootDocs = hasRepoRootDocs ? it : it.skip;

// docs.agentos.sh serves the API reference at /api and answers /api/ with a 404. The
// pattern matches https://docs.agentos.sh/api/ itself, not a page under it.
const apiReferenceWithSlash = /https:\/\/docs\.agentos\.sh\/api\/(?![\w-])/;

describe('AgentOS docs alignment', () => {
  it('keeps the package README aligned with the high-level API surface', () => {
    const readme = read('../../../../README.md');
    // generateImage, agent() and agency() are exported helpers users discover
    // from the README, and '## API Surfaces' heads the README section that lists
    // the API surfaces. The test asserts only that each is present.
    expect(readme).toContain('generateImage');
    expect(readme).toContain('agent()');
    expect(readme).toContain('agency()');
    expect(readme).toContain('## API Surfaces');
  });

  it("keeps 'Auto-fallback on 402/429/5xx.' out of the README and finds fallbackProviders, buildFallbackChain or 'automatic fallback' in it", () => {
    const readme = read('../../../../README.md');
    // The old one-line summary 'Auto-fallback on 402/429/5xx.' stays out of the README.
    expect(readme).not.toContain('Auto-fallback on 402/429/5xx.');
    // Fallback is on by default: generateText(), streamText(), generateObject() and
    // agent() build a chain when fallbackProviders is omitted, and
    // fallbackProviders: [] turns it off. The README names that option, the
    // buildFallbackChain() helper or 'automatic fallback'.
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
    const gmiGuide = read('../../../../docs/GMI.md');
    const personality = read('../../../../docs/memory/HEXACO_PERSONALITY.md');

    expect(readme).not.toContain('memory: { enabled: true, cognitive: true }');
    // The guide's cognitive-memory example runs on the GMI path.
    expect(guide).toMatch(/agent\(\{\s*runtime: 'gmi',[^`]*\bmemory: \{ embedding: \{/);
    // The guide distinguishes GMI store settings from the default runtime's callback.
    expect(guide).toContain('Of the `MemoryConfig` fields, this path reads `embedding` and `consolidation`');
    expect(guide).toContain('The default runtime reads only the `memory.working` callback described above.');
    // No example passes memory to an agent() that does not read it.
    const pages = { 'README.md': readme, 'docs/getting-started/HIGH_LEVEL_API.md': guide, 'examples/high-level-api.mjs': example, 'docs/GMI.md': gmiGuide, 'docs/memory/HEXACO_PERSONALITY.md': personality };
    for (const [page, text] of Object.entries(pages)) {
      expect(plainAgentCallsWithMemory(text), page).toEqual([]);
    }
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
    const docsIndex = read('../../../../../../apps/agentos-live-docs/docs/index.md');
    const homepage = read('../../../../../../apps/agentos-live-docs/src/pages/index.tsx');

    expect(example).toContain('generateImage');
    // docs/getting-started/HIGH_LEVEL_API.md is published at /getting-started/high-level-api.
    expect(docsIndex).toContain('/getting-started/high-level-api');
    expect(homepage).toContain('/getting-started/high-level-api');
  });

  itIfLiveDocs('keeps the live docs skills routes aligned with the canonical manifest', () => {
    const docsIndex = read('../../../../../../apps/agentos-live-docs/docs/index.md');
    const homepage = read('../../../../../../apps/agentos-live-docs/src/pages/index.tsx');

    expect(docsIndex).not.toContain('/skills/skills-extension');
    // The site builds with trailingSlash: false. It serves the API reference at /api and
    // answers /api/ with a 404; a Link to '/api/' renders as /api.
    expect(homepage).toMatch(/to="\/api\/?"/);
    // The skills overview (manifest dest skills/index.md) is served at /skills, and
    // /skills/overview redirects there.
    expect(homepage).toContain("'/skills'");
    expect(homepage).not.toContain('72 Curated Skills');
    expect(homepage).not.toContain('107 Extensions');
  });

  it('lists the unified orchestration guides in docs/README.md, the source of the site documentation index', () => {
    const packageDocsIndex = read('../../../../docs/README.md');
    const requireCjs = createRequire(import.meta.url);
    const { publicationManifest } = requireCjs('../../../../docs/publication-manifest.cjs') as {
      publicationManifest: Array<{ sourcePath?: string; dest: string }>;
    };

    expect(
      publicationManifest.find((entry) => entry.dest === 'getting-started/documentation-index.md')?.sourcePath,
    ).toBe('packages/agentos/docs/README.md');
    expect(packageDocsIndex).toContain('Unified Orchestration Layer');
    expect(packageDocsIndex).toContain('AgentGraph');
    expect(packageDocsIndex).toContain('workflow() DSL');
    expect(packageDocsIndex).toContain('mission() API');
    expect(packageDocsIndex).toContain('Checkpointing');
  });

  it('publishes the PII redaction extension page from its live-docs static page, and keeps PII_REDACTION.md links on the guide', () => {
    const requireCjs = createRequire(import.meta.url);
    const { publicationManifest, buildFilenameRewriteMap } = requireCjs('../../../../docs/publication-manifest.cjs') as {
      publicationManifest: Array<Record<string, unknown> & { dest: string }>;
      buildFilenameRewriteMap: () => Record<string, string>;
    };

    // agentos-live-docs holds the page at static-docs/extensions/built-in/pii-redaction.md, so the
    // entry is a static doc that must resolve, not a stub allowed to go missing.
    const piiPage = publicationManifest.find((entry) => entry.dest === 'extensions/built-in/pii-redaction.md');
    expect(piiPage).toMatchObject({
      sourceType: 'static-doc',
      sourcePath: 'apps/agentos-live-docs/static-docs/extensions/built-in/pii-redaction.md',
      title: 'PII Redaction',
      section: 'Extensions',
      group: 'Guardrail Extensions',
    });
    expect(piiPage).not.toHaveProperty('allowMissingSource');

    // The site reads a link's file name case-insensitively, with '-' as '_', so pii-redaction.md
    // and PII_REDACTION.md share one key there. The first entry keeps it: the guide.
    const rewrites = buildFilenameRewriteMap();
    expect(rewrites['PII_REDACTION.md']).toBe('/features/pii-redaction');
    const keys = Object.keys(rewrites).map((fileName) => fileName.toLowerCase().replace(/-/g, '_'));
    expect(new Set(keys).size).toBe(keys.length);
  });

  itIfLiveDocs('links the unified orchestration guide from the docs homepage', () => {
    const homepage = read('../../../../../../apps/agentos-live-docs/src/pages/index.tsx');

    // docs/orchestration/UNIFIED_ORCHESTRATION.md is published at /features/unified-orchestration.
    expect(homepage).toContain("'/features/unified-orchestration'");
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

  it('points the package ecosystem guide at the API reference route the docs site serves', () => {
    const packageEcosystemGuide = read('../../../../docs/architecture/ECOSYSTEM.md');

    expect(packageEcosystemGuide).toContain('(https://docs.agentos.sh/api)');
    expect(packageEcosystemGuide).not.toMatch(apiReferenceWithSlash);
    expect(packageEcosystemGuide).not.toContain('agentos-live-docs branch');
  });

  itIfRepoRootDocs('points ecosystem API links at the published docs site', () => {
    const ecosystemGuide = read('../../../../../../docs/getting-started/ecosystem.md');

    expect(ecosystemGuide).toContain('https://docs.agentos.sh/api');
    expect(ecosystemGuide).not.toMatch(apiReferenceWithSlash);
    expect(ecosystemGuide).not.toContain('agentos-live-docs branch');
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
    const contentPackage = JSON.parse(read('../../../../../agentos-skills/package.json'));
    const catalogSdkPackage = JSON.parse(read('../../../../../agentos-skills-registry/package.json'));
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
  it('keeps every ./ or ../ link from a published guide to a Markdown file under docs/ pointed at a published page', () => {
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
